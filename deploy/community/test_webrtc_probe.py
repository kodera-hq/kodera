"""Real-socket RFC 5389 STUN and RFC 5766 TURN UDP unit suite for webrtc_probe.py."""

from __future__ import annotations

import io
import json
import secrets
import socket
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import webrtc_probe as wp


def _ipv6_loopback_available() -> bool:
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as s:
            s.bind(("::1", 0))
            return True
    except OSError:
        return False


class StunTurnWireCodecTests(unittest.TestCase):
    def test_bare_binding_request_is_exact_20_byte_rfc5389_header(self) -> None:
        txid = bytes.fromhex("0102030405060708090a0b0c")
        pkt, returned_txid = wp.build_stun_message(wp.MSG_BINDING_REQUEST, txid=txid)
        self.assertEqual(returned_txid, txid)
        self.assertEqual(len(pkt), 20)
        msg_type, msg_len, cookie, unpacked_tx = struct.unpack(">HHI12s", pkt)
        self.assertEqual(msg_type, 0x0001)
        self.assertEqual(msg_len, 0)
        self.assertEqual(cookie, 0x2112A442)
        self.assertEqual(unpacked_tx, txid)

        parsed = wp.parse_stun_message(pkt, expected_txid=txid)
        self.assertEqual(parsed.msg_type, wp.MSG_BINDING_REQUEST)
        self.assertEqual(parsed.attributes, ())

    def test_xor_mapped_address_ipv4_and_ipv6_vectors(self) -> None:
        txid = bytes.fromhex("a1b2c3d4e5f60718293a4b5c")
        raw_v4 = wp.encode_xor_address("198.51.100.25", 50199, txid)
        self.assertEqual(len(raw_v4), 8)
        dec_v4 = wp.decode_xor_address(raw_v4, txid)
        self.assertEqual(dec_v4, wp.TransportAddress("198.51.100.25", 50199, "IPv4"))

        raw_v6 = wp.encode_xor_address("2001:db8:85a3::8a2e:370:7334", 50042, txid)
        self.assertEqual(len(raw_v6), 20)
        dec_v6 = wp.decode_xor_address(raw_v6, txid)
        self.assertEqual(
            dec_v6,
            wp.TransportAddress("2001:db8:85a3::8a2e:370:7334", 50042, "IPv6"),
        )

    def test_message_integrity_and_fingerprint_coexist_and_fail_closed_on_tamper(self) -> None:
        key = wp.derive_long_term_key("operator", "kodera.test", "cred-" + secrets.token_hex(6))
        pkt, txid = wp.build_stun_message(
            wp.MSG_ALLOCATE_REQUEST,
            attributes=(
                (wp.ATTR_USERNAME, b"operator"),
                (wp.ATTR_REALM, b"kodera.test"),
                (wp.ATTR_NONCE, b"nonce-123"),
            ),
            integrity_key=key,
            fingerprint=True,
        )
        parsed = wp.parse_stun_message(
            pkt, expected_txid=txid, integrity_key=key, require_fingerprint=True
        )
        self.assertEqual(parsed.first_attr(wp.ATTR_USERNAME), b"operator")

        idx = pkt.index(b"operator")
        corrupted_user = pkt[:idx] + b"X" + pkt[idx + 1 :]
        with self.assertRaises(wp.StunProtocolError):
            wp.parse_stun_message(corrupted_user, integrity_key=key, require_fingerprint=True)

        corrupted_fp = pkt[:-1] + bytes([pkt[-1] ^ 0x01])
        with self.assertRaises(wp.StunProtocolError):
            wp.parse_stun_message(corrupted_fp, integrity_key=key, require_fingerprint=True)

        with self.assertRaises(wp.TransactionMismatchError):
            wp.parse_stun_message(pkt, expected_txid=b"\x00" * 12)

        bad_cookie = pkt[:4] + b"\x00\x00\x00\x00" + pkt[8:]
        with self.assertRaises(wp.StunProtocolError):
            wp.parse_stun_message(bad_cookie)
        with self.assertRaises(wp.StunProtocolError):
            wp.parse_stun_message(pkt[:19])

    def test_post_message_integrity_attributes_ignored_except_fingerprint(self) -> None:
        txid = bytes.fromhex("11223344556677889900aabb")
        key = wp.derive_short_term_key("ice-" + secrets.token_hex(6))
        base_pkt, _ = wp.build_stun_message(
            wp.MSG_BINDING_SUCCESS,
            txid=txid,
            attributes=((wp.ATTR_USERNAME, b"srv:cli"),),
            integrity_key=key,
            fingerprint=False,
        )
        forged_attr = wp.encode_attr(
            wp.ATTR_XOR_MAPPED_ADDRESS, wp.encode_xor_address("203.0.113.99", 60000, txid)
        )
        body_with_forged = base_pkt[20:] + forged_attr
        fp_hdr = wp.STUN_HEADER_STRUCT.pack(
            wp.MSG_BINDING_SUCCESS, len(body_with_forged) + 8, wp.STUN_MAGIC_COOKIE, txid
        )
        crc = (wp.zlib.crc32(fp_hdr + body_with_forged) & 0xFFFFFFFF) ^ wp.STUN_FINGERPRINT_XOR
        full_body = body_with_forged + wp.encode_attr(wp.ATTR_FINGERPRINT, struct.pack(">I", crc))
        full_pkt = (
            wp.STUN_HEADER_STRUCT.pack(
                wp.MSG_BINDING_SUCCESS, len(full_body), wp.STUN_MAGIC_COOKIE, txid
            )
            + full_body
        )

        parsed = wp.parse_stun_message(
            full_pkt, expected_txid=txid, integrity_key=key, require_fingerprint=True
        )
        self.assertEqual(parsed.first_attr(wp.ATTR_USERNAME), b"srv:cli")
        self.assertIsNone(parsed.first_attr(wp.ATTR_XOR_MAPPED_ADDRESS))
        self.assertIsNotNone(parsed.first_attr(wp.ATTR_FINGERPRINT))

    def test_saslprep_unicode_3_2_normalization_and_prohibited_characters(self) -> None:
        # RFC 4013 mandates Unicode 3.2 NFKC: U+2F868 normalizes to U+2136A (not modern U+36FC).
        self.assertEqual(wp.saslprep("\U0002f868"), "\U0002136a")
        self.assertNotEqual(wp.saslprep("\U0002f868"), "\u36fc")

        self.assertEqual(wp.saslprep("user\u00ad\u00a0\u2163"), "user IV")
        self.assertEqual(
            wp.derive_long_term_key("al\u00adice", "kodera.test", "pa\u00a0ss"),
            wp.derive_long_term_key("alice", "kodera.test", "pa ss"),
        )
        bad_ctrl = "CANARY_CTRL_\x07_" + secrets.token_hex(6)
        with self.assertRaises(wp.StunProtocolError) as cm:
            wp.derive_short_term_key(bad_ctrl)
        self.assertNotIn("CANARY_CTRL", str(cm.exception))

        with self.assertRaises(wp.StunProtocolError):
            wp.saslprep("\u0627latin\u0628")

    def test_default_port_is_3478_and_ports_spec_parser(self) -> None:
        parser = wp.build_parser()
        ns = parser.parse_args([])
        self.assertIsNone(ns.stun_port)
        self.assertEqual(wp.DEFAULT_STUN_PORT, 3478)
        self.assertEqual(
            wp.parse_ports_spec("3478, 5349, 50000-50002"), [3478, 5349, 50000, 50001, 50002]
        )


class RealSocketProbeTests(unittest.TestCase):
    def test_stun_binding_rto_retransmission_and_port_fallback(self) -> None:
        with (
            wp.EphemeralStunTurnServer(drop_all=True) as dead_srv,
            wp.EphemeralStunTurnServer(drop_first_packets=1) as flaky_srv,
        ):
            res = wp.probe_stun_binding(
                "127.0.0.1",
                [dead_srv.port, flaky_srv.port],
                deadline=time.monotonic() + 0.8,
                step_timeout=0.10,
            )
            self.assertTrue(res["succeeded"])
            self.assertEqual(res["port"], flaky_srv.port)
            self.assertEqual(res["reflexive_address"].ip, "127.0.0.1")

    def test_authenticated_ice_lite_stun_binding_round_trip(self) -> None:
        ice_pwd = "ice-" + secrets.token_hex(8)
        with wp.EphemeralStunTurnServer(short_term_password=ice_pwd) as srv:
            unauth = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=srv.port,
                timeout_budget=0.3,
                step_timeout=0.05,
            )
            self.assertEqual(unauth["status"], "udp_unreachable_or_filtered")

            auth_ok = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=srv.port,
                stun_username="serverUfrag:clientUfrag",
                stun_password=ice_pwd,
                fingerprint=True,
                timeout_budget=0.8,
            )
            self.assertEqual(auth_ok["status"], "ok")
            self.assertNotIn(ice_pwd, json.dumps(auth_ok))

    @unittest.skipUnless(_ipv6_loopback_available(), "IPv6 loopback ::1 unavailable on host")
    def test_ipv6_udp_stun_binding_and_turn_loopback(self) -> None:
        v6_pw = "v6-" + secrets.token_hex(6)
        with wp.EphemeralStunTurnServer(bind_ip="::1", users={"v6user": v6_pw}) as srv:
            res = wp.run_probe(
                stun_host="::1",
                stun_port=srv.port,
                turn_url=f"turn:[::1]:{srv.port}?transport=udp",
                turn_username="v6user",
                turn_password=v6_pw,
                timeout_budget=1.0,
            )
            self.assertEqual(res["status"], "turn_relay_verified")
            self.assertEqual(res["reflexive_address"]["family"], "IPv6")
            self.assertEqual(res["relayed_address"]["family"], "IPv6")
            self.assertEqual(srv.active_allocations, 0)

    def test_turn_allocate_permission_send_data_loopback_and_refresh_zero(self) -> None:
        canary_pw = "canary-" + secrets.token_hex(12)
        with wp.EphemeralStunTurnServer(users={"turn-op": canary_pw}) as srv:
            report = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=srv.port,
                turn_url=f"turn:127.0.0.1:{srv.port}?transport=udp",
                turn_username="turn-op",
                turn_password=canary_pw,
                timeout_budget=1.2,
            )
            self.assertEqual(report["status"], "turn_relay_verified")
            self.assertTrue(report["healthy"])
            turn = report["turn"]
            self.assertTrue(turn["allocated"])
            self.assertTrue(turn["permission_installed"])
            self.assertTrue(turn["loopback_verified"])
            self.assertTrue(turn["deallocated"])
            self.assertEqual(srv.total_allocations, 1)
            self.assertEqual(srv.permissions_installed, 1)
            self.assertEqual(srv.relayed_packets, 1)
            self.assertEqual(srv.deallocations, 1)
            self.assertEqual(srv.active_allocations, 0)
            self.assertNotIn(canary_pw, json.dumps(report))

    def test_turn_refresh_rto_drop_recovery_authenticated_437_and_forged_437_rejection(self) -> None:
        pw = "turn-" + secrets.token_hex(8)

        # 1. Dropped first Refresh(0) packet + 438 Stale Nonce both recover via RTO + retry!
        with wp.EphemeralStunTurnServer(
            users={"u": pw},
            drop_first_refresh_packets=1,
            stale_nonce_once_on_refresh=True,
        ) as rto_srv:
            res_rto = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=rto_srv.port,
                turn_url=f"turn:127.0.0.1:{rto_srv.port}",
                turn_username="u",
                turn_password=pw,
                timeout_budget=0.9,
                step_timeout=0.08,
            )
            self.assertEqual(res_rto["status"], "turn_relay_verified")
            self.assertTrue(res_rto["turn"]["deallocated"])
            self.assertEqual(rto_srv.active_allocations, 0)

        # 2. Properly authenticated 437 Allocation Mismatch on Refresh(0) is accepted as deallocated.
        with wp.EphemeralStunTurnServer(
            users={"u": pw}, mismatch_437_on_refresh=True
        ) as auth_437_srv:
            res_437 = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=auth_437_srv.port,
                turn_url=f"turn:127.0.0.1:{auth_437_srv.port}",
                turn_username="u",
                turn_password=pw,
                timeout_budget=0.7,
                step_timeout=0.06,
            )
            self.assertEqual(res_437["status"], "turn_relay_verified")
            self.assertTrue(res_437["turn"]["deallocated"])

        # 3. Forged / wrong-key 437 on Refresh(0) MUST be discarded per RFC 5389 §10.2.3 (deallocated=False)!
        with wp.EphemeralStunTurnServer(
            users={"u": pw}, forged_437_on_refresh=True
        ) as forged_437_srv:
            res_forged = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=forged_437_srv.port,
                turn_url=f"turn:127.0.0.1:{forged_437_srv.port}",
                turn_username="u",
                turn_password=pw,
                timeout_budget=0.25,
                step_timeout=0.04,
            )
            self.assertFalse(res_forged["turn"]["deallocated"])
            self.assertFalse(res_forged["healthy"])

        # 4. Allocate 200 omitting XOR-RELAYED-ADDRESS still sends Refresh(0) to release server state.
        with wp.EphemeralStunTurnServer(
            users={"u": pw}, omit_relayed_attr_on_allocate=True
        ) as malformed_srv:
            res_mal = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=malformed_srv.port,
                turn_url=f"turn:127.0.0.1:{malformed_srv.port}",
                turn_username="u",
                turn_password=pw,
                timeout_budget=0.5,
                step_timeout=0.05,
            )
            self.assertTrue(res_mal["turn"]["allocated"])
            self.assertTrue(res_mal["turn"]["deallocated"])
            self.assertEqual(malformed_srv.active_allocations, 0)

    def test_turn_send_without_create_permission_is_dropped_per_rfc5766(self) -> None:
        pw = "perm-" + secrets.token_hex(6)
        with wp.EphemeralStunTurnServer(users={"u": pw}) as srv, socket.socket(
            socket.AF_INET, socket.SOCK_DGRAM
        ) as sock:
            sock.bind(("127.0.0.1", 0))
            dest = ("127.0.0.1", srv.port)
            transport = (wp.ATTR_REQUESTED_TRANSPORT, struct.pack(">BBBB", wp.TRANSPORT_UDP, 0, 0, 0))
            req1, tx1 = wp.build_stun_message(wp.MSG_ALLOCATE_REQUEST, attributes=(transport,), fingerprint=True)
            resp1, _ = wp._send_and_await(sock, dest, req1, expected_txid=tx1, deadline=time.monotonic() + 0.5)
            realm = resp1.first_attr(wp.ATTR_REALM).decode("utf-8")
            nonce = resp1.first_attr(wp.ATTR_NONCE)
            key = wp.derive_long_term_key("u", realm, pw)
            auth = ((wp.ATTR_USERNAME, b"u"), (wp.ATTR_REALM, realm.encode()), (wp.ATTR_NONCE, nonce))
            req2, tx2 = wp.build_stun_message(
                wp.MSG_ALLOCATE_REQUEST, attributes=(transport, *auth), integrity_key=key, fingerprint=True
            )
            resp2, _ = wp._send_and_await(
                sock, dest, req2, expected_txid=tx2, deadline=time.monotonic() + 0.5, integrity_key=key
            )
            relayed = wp.decode_xor_address(resp2.first_attr(wp.ATTR_XOR_RELAYED_ADDRESS), tx2)

            send_tx = b"\x22" * 12
            send_pkt, _ = wp.build_stun_message(
                wp.MSG_SEND_INDICATION,
                txid=send_tx,
                attributes=(
                    (wp.ATTR_XOR_PEER_ADDRESS, wp.encode_xor_address(relayed.ip, relayed.port, send_tx)),
                    (wp.ATTR_DATA, b"0123456789abcdef"),
                ),
                fingerprint=True,
            )
            sock.sendto(send_pkt, dest)
            with self.assertRaises(TimeoutError):
                wp._await_indication(sock, wp.MSG_DATA_INDICATION, deadline=time.monotonic() + 0.04, step_timeout=0.04)
            self.assertEqual(srv.relayed_packets, 0)

            ref_pkt, ref_tx = wp.build_stun_message(
                wp.MSG_REFRESH_REQUEST,
                attributes=((wp.ATTR_LIFETIME, struct.pack(">I", 0)), *auth),
                integrity_key=key,
                fingerprint=True,
            )
            wp._send_and_await(sock, dest, ref_pkt, expected_txid=ref_tx, deadline=time.monotonic() + 0.5, integrity_key=key)
            self.assertEqual(srv.active_allocations, 0)

    def test_direct_public_stun_success_forces_relay_loopback_blocked_over_hairpin(self) -> None:
        pw = "drop-" + secrets.token_hex(6)

        # 1. Direct external/public STUN SUCCEEDED (even with reflexive_ip in domain_ips!) while
        # TURN Send->Data relay loopback failed -> MUST classify as `relay_loopback_blocked`, NOT hairpin!
        with wp.EphemeralStunTurnServer(
            users={"turn-op": pw},
            override_mapped_ip="203.0.113.88",
            drop_send_indications=True,
        ) as srv_direct_ok:
            rep_direct_ok = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=srv_direct_ok.port,
                hairpin_host="127.0.0.1",
                hairpin_port=srv_direct_ok.port,
                turn_url=f"turn:127.0.0.1:{srv_direct_ok.port}",
                turn_username="turn-op",
                turn_password=pw,
                domain="chat.example.org",
                public_ips=["203.0.113.88"],
                timeout_budget=0.40,
                step_timeout=0.04,
            )
            self.assertEqual(
                rep_direct_ok["status"],
                "relay_loopback_blocked",
                "successful direct public STUN proves hairpin works; TURN failure is relay_loopback_blocked",
            )

        # 2. Direct public STUN TIMED OUT (`public_blackhole`) while local/control listener answered
        # with verified shared public IP (`203.0.113.88` in `domain_ips`) -> `hairpin_nat_blocked`!
        with (
            wp.EphemeralStunTurnServer(drop_all=True) as public_blackhole,
            wp.EphemeralStunTurnServer(override_mapped_ip="203.0.113.88") as local_ref,
        ):
            rep_hp = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=public_blackhole.port,
                domain="chat.example.org",
                public_ips=["203.0.113.88"],
                local_probe_host="127.0.0.1",
                local_probe_port=local_ref.port,
                timeout_budget=0.35,
                step_timeout=0.04,
            )
            self.assertEqual(rep_hp["status"], "hairpin_nat_blocked")

        # 3. Direct public STUN TIMED OUT while unrelated local listener returned 127.0.0.1
        # (not in domain_ips) -> `udp_unreachable_or_filtered`!
        with (
            wp.EphemeralStunTurnServer(drop_all=True) as remote_blackhole,
            wp.EphemeralStunTurnServer() as unrelated_local,
        ):
            rep_unrel = wp.run_probe(
                stun_host="127.0.0.1",
                stun_port=remote_blackhole.port,
                domain="chat.example.org",
                public_ips=["203.0.113.55"],
                local_probe_host="127.0.0.1",
                local_probe_port=unrelated_local.port,
                timeout_budget=0.35,
                step_timeout=0.04,
            )
            self.assertEqual(rep_unrel["status"], "udp_unreachable_or_filtered")

    def test_non_finite_timeout_and_hung_dns_obey_wall_clock_budget(self) -> None:
        for bad in (float("nan"), float("inf"), -1.0, 0.0):
            with self.assertRaises(ValueError):
                wp.run_probe(timeout_budget=bad)

        def slow_getaddrinfo(*_args: object, **_kwargs: object) -> list[object]:
            time.sleep(5.0)
            return []

        t0 = time.monotonic()
        with mock.patch("socket.getaddrinfo", side_effect=slow_getaddrinfo):
            rep = wp.run_probe(
                stun_host="hung-dns.example.org",
                stun_port=3478,
                public_ips=["203.0.113.10"],
                timeout_budget=0.12,
                step_timeout=0.05,
            )
        elapsed = time.monotonic() - t0
        self.assertEqual(rep["status"], "udp_unreachable_or_filtered")
        self.assertLess(elapsed, 0.35)

    def test_cli_json_env_file_and_grandparent_symlink_refusal(self) -> None:
        canary_env_secret = "canary-env-" + secrets.token_hex(12)
        with (
            tempfile.TemporaryDirectory(prefix="webrtc-probe-test-") as tmp,
            wp.EphemeralStunTurnServer(users={"cli-user": canary_env_secret}) as srv,
        ):
            base = Path(tmp).resolve()
            real_dir = base / "real_root" / "nested"
            real_dir.mkdir(parents=True)
            env_path = real_dir / "operator.conf"
            env_path.write_text(
                f"KODERA_DOMAIN=chat.example.org\n"
                f"TURN_DOMAIN=127.0.0.1\n"
                f"TURN_UDP_PORT={srv.port}\n"
                f"TURN_USERNAME=cli-user\n"
                f"TURN_PASSWORD={canary_env_secret}\n",
                encoding="utf-8",
            )
            env_path.chmod(0o600)

            out_buf = io.StringIO()
            with mock.patch("sys.stdout", out_buf):
                rc = wp.main(
                    [
                        "--env-file",
                        str(env_path),
                        "--public-ip",
                        "127.0.0.1",
                        "--json",
                    ]
                )
            self.assertEqual(rc, 0)
            payload = json.loads(out_buf.getvalue())
            self.assertEqual(payload["status"], "turn_relay_verified")
            self.assertNotIn(canary_env_secret, out_buf.getvalue())

            sym_grandparent = base / "linked_grandparent"
            sym_grandparent.symlink_to(base / "real_root")
            through_grandparent = sym_grandparent / "nested" / "operator.conf"
            err_buf = io.StringIO()
            with mock.patch("sys.stdout", err_buf):
                rc_sym = wp.main(["--env-file", str(through_grandparent), "--json"])
            self.assertEqual(rc_sym, 1)
            err_json = json.loads(err_buf.getvalue())
            self.assertEqual(err_json["status"], "error")
            self.assertIn("symbolic link", err_json["diagnosis"])
            self.assertNotIn(canary_env_secret, err_buf.getvalue())

            nan_buf = io.StringIO()
            with mock.patch("sys.stdout", nan_buf):
                rc_nan = wp.main(["--timeout", "nan", "--json"])
            self.assertEqual(rc_nan, 1)


if __name__ == "__main__":
    unittest.main()
