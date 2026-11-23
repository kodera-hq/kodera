"""Direct-client admission never trusts stale membership after guest or partner revocation."""

import asyncio
from types import SimpleNamespace

import pytest

from kodera_synapse_policy import KoderaPolicy
from kodera_synapse_policy.authority import Authority, guest_request, valid_origin
from conftest import Codes


class Api:
    def register_spam_checker_callbacks(self, **kwargs):
        pass

    def register_third_party_rules_callbacks(self, **kwargs):
        pass


class Live:
    def __init__(self, role='single_channel_guest'):
        self.role, self.active, self.calls = role, True, []

    async def decide(self, user, room, action):
        self.calls.append((user, room, action))
        return {'allowed': self.active and room == '!allowed:example.org' and action in {'join', 'event'}, 'role': self.role}


@pytest.mark.parametrize('user', ['@guest:example.org', '@guest:remote.example.org'])
def test_direct_client_cross_room_dm_invite_and_revoked_event(user):
    policy = KoderaPolicy({'agent_user_id': '@agent:example.org'}, Api())
    live = policy._authority = Live()
    assert asyncio.run(policy.user_may_create_room(user, {'is_direct': True})) == Codes.FORBIDDEN
    assert asyncio.run(policy.user_may_join_room(user, '!other:example.org', True)) == Codes.FORBIDDEN
    assert asyncio.run(policy.user_may_join_room(user, '!other:remote.example.org', True)) == Codes.FORBIDDEN
    assert asyncio.run(policy.user_may_invite(user, '@member:example.org', '!allowed:example.org')) == Codes.FORBIDDEN
    event = SimpleNamespace(sender=user, room_id='!allowed:example.org', type='m.room.message', content={}, is_state=lambda: False)
    assert asyncio.run(policy._live_event(event)) is True
    live.active = False
    assert asyncio.run(policy._live_event(event)) is False
    assert asyncio.run(policy.check_event_allowed(event, {})) == (False, None)
    assert asyncio.run(policy.check_event_for_spam(event)) == Codes.FORBIDDEN


def test_guest_cannot_bypass_invite_hook_with_raw_state_event():
    policy = KoderaPolicy({'agent_user_id': '@agent:example.org'}, Api())
    policy._authority = Live()
    event = SimpleNamespace(sender='@guest:example.org', room_id='!allowed:example.org', type='m.room.member', state_key='@other:example.org', content={'membership': 'invite'}, is_state=lambda: True)
    assert asyncio.run(policy._live_event(event)) is False


@pytest.mark.parametrize('path,method', [
    ('/_matrix/client/v3/user_directory/search', 'POST'),
    ('/_matrix/client/v3/publicRooms', 'GET'),
    ('/_matrix/client/v3/directory/room/%23secret%3Aexample.org', 'GET'),
    ('/_matrix/client/v3/createRoom', 'POST'),
    ('/_matrix/client/v3/rooms/!allowed:example.org/invite', 'POST'),
    ('/_matrix/client/v3/rooms/!allowed:example.org/state/m.room.power_levels/', 'PUT'),
    ('/_matrix/client/v3/rooms/%2521other/messages', 'GET'),
])
def test_guest_request_gate_denies_directory_alias_dm_invite_and_state(path, method):
    assert guest_request(path, method) is None


def test_scope_uses_live_exact_room_and_no_positive_cache():
    policy = KoderaPolicy({'agent_user_id': '@agent:example.org'}, Api())
    live = policy._authority = Live()
    path = '/_matrix/client/v3/rooms/!allowed:example.org/messages'
    assert asyncio.run(policy.request_allowed('@guest:example.org', path, 'GET'))
    assert not asyncio.run(policy.request_allowed('@guest:example.org', path.replace('allowed', 'other'), 'GET'))
    live.active = False
    assert not asyncio.run(policy.request_allowed('@guest:example.org', path, 'GET'))


def test_authority_errors_and_malformed_answers_fail_closed():
    class Http:
        async def get_json(self, *args, **kwargs):
            raise OSError('unavailable')
    api = SimpleNamespace(http_client=Http())
    assert not asyncio.run(Authority(api, 'https://core.example.org', 'synthetic').decide('@g:example.org', '!r:example.org', 'join'))['allowed']
    async def malformed(*args, **kwargs):
        return {'allowed': 'true'}
    api.http_client.get_json = malformed
    assert not asyncio.run(Authority(api, 'https://core.example.org', 'synthetic').decide('@g:example.org', '!r:example.org', 'join'))['allowed']


@pytest.mark.parametrize('origin', ['http://example.org', 'https://u:p@example.org', 'https://example.org/path', 'https://example.org?x=1', None])
def test_authority_origin_refuses_credentials_and_paths(origin):
    assert not valid_origin(origin)


def test_two_policy_homeservers_admit_only_live_bilateral_shared_room():
    from test_federation import PARTNER, partner_state
    from test_policy import AGENT, ALICE, FakeApi, SERVER, run, event, ALLOWED

    PARTNER = PARTNER.partition(':')[2]
    room = '!shared:' + SERVER
    state = partner_state()
    state[('io.kodera.room.policy', '')].content['local_members'] = [ALICE]
    class PeerApi(FakeApi):
        def is_mine(self, user):
            return user.endswith(':' + PARTNER)
    peer_user = '@peer:' + PARTNER
    state[('m.room.member', peer_user)] = SimpleNamespace(content={'membership': 'join'})
    peer = KoderaPolicy({'agent_user_id': '@kodera-agent:' + PARTNER, 'federation_domain_allowlist': [SERVER]}, PeerApi({room: state}))
    class Agreement:
        active = True
        async def decide(self, user, requested, action):
            return {'allowed': self.active and requested == room, 'role': 'local' if user.endswith(':' + PARTNER) else 'partner'}
    live = peer._authority = Agreement()
    assert run(peer.user_may_join_room(peer_user, room, True)) == ALLOWED
    message = event('m.room.message', ALICE, state=False)
    message.room_id = room
    assert run(peer.check_event_allowed(message, state))[0] is True
    assert run(peer.check_event_for_spam(message)) == ALLOWED
    publication = event('m.room.topic', AGENT, state=True, topic='Shared')
    publication.room_id = room
    assert run(peer.check_event_allowed(publication, state))[0] is True
    live.active = False
    assert run(peer.check_event_allowed(message, state))[0] is False
    assert run(peer.user_may_join_room(peer_user, room, True)) == Codes.FORBIDDEN
    # The host's administrative publisher is trusted only while Core recognizes this room.
    publication = event('m.room.topic', AGENT, state=True, topic='Shared')
    publication.room_id = room
    assert run(peer.check_event_allowed(publication, state))[0] is False


@pytest.mark.parametrize('guest_home', ['acme-sa.kodera.io', 'partner.example.org'])
@pytest.mark.parametrize('invalidation', ['suspended', 'revoked', 'proposed', 'guest-revoked', 'guest-expired'])
def test_guest_on_either_homeserver_needs_live_grant_and_bilateral_agreement(guest_home, invalidation):
    from test_federation import partner_state
    from test_policy import ALLOWED, FakeApi, SERVER, event, run

    partner = 'partner.example.org'
    room, guest = '!shared:' + SERVER, '@guest:' + guest_home
    state = partner_state()
    content = state[('io.kodera.room.policy', '')].content
    content.update(members=[], local_members=[])
    state[('m.room.member', guest)] = SimpleNamespace(content={'membership': 'join'})

    class Core:
        agreement = 'active'
        grant = 'active'

        def __init__(self):
            self.calls = []

        async def get_json(self, url, args, headers):
            credential = headers['Authorization'][0]
            assert credential in {'Bearer host-agent', 'Bearer peer-agent'}
            self.calls.append((credential, args['user_id'], args['room_id'], args['action']))
            is_guest = args['user_id'] == guest
            allowed = self.agreement == 'active' and (
                self.grant == 'active' if is_guest else True
            ) and (
                args['room_id'] == room and args['action'] in {'join', 'event', 'call'}
                or is_guest and args['room_id'] == '' and args['action'] == 'session'
            )
            return {'allowed': allowed, 'role': 'single_channel_guest' if is_guest else 'local', 'revision': 2}

    core, policies = Core(), []
    for server, other, token in [(SERVER, partner, 'host-agent'), (partner, SERVER, 'peer-agent')]:
        class LocalApi(FakeApi):
            def __init__(self, local):
                super().__init__({room: state})
                self.local = local
                self.http_client = core

            def is_mine(self, user):
                return user.endswith(':' + self.local)

        api = LocalApi(server)
        policy = KoderaPolicy({
            'agent_user_id': '@kodera-agent:' + server,
            'federation_domain_allowlist': [other],
            'core_authority_origin': 'https://core.example.org',
            'core_authority_token': token,
        }, api)
        policies.append(policy)

    message = event('m.room.message', guest, state=False)
    message.room_id = room
    join = event('m.room.member', guest, membership='join')
    join.room_id, join.state_key = room, guest
    for policy in policies:
        assert run(policy.user_may_join_room(guest, room, True)) == ALLOWED
        assert run(policy.check_event_allowed(join, state))[0]
        assert run(policy.check_event_allowed(message, state))[0]
        assert run(policy.check_event_for_spam(message)) == ALLOWED
        assert run(policy.request_allowed(guest, '/_matrix/client/v3/rooms/' + room + '/messages', 'GET'))
        assert run(policy.request_allowed(guest, '/_matrix/client/v3/account/whoami', 'GET'))
        assert not run(policy.request_allowed(guest, '/_matrix/client/v3/user_directory/search', 'POST'))
        assert run(policy.user_may_join_room(guest, '!other:' + SERVER, True)) == Codes.FORBIDDEN
        assert run(policy.user_may_create_room(guest, {'is_direct': True})) == Codes.FORBIDDEN
        assert run(policy._authority.decide(guest, room, 'call'))['allowed']
    if invalidation.startswith('guest-'):
        core.grant = invalidation.removeprefix('guest-')
    else:
        core.agreement = invalidation
    for policy in policies:
        assert run(policy.user_may_join_room(guest, room, True)) == Codes.FORBIDDEN
        assert not run(policy.check_event_allowed(join, state))[0]
        assert not run(policy.check_event_allowed(message, state))[0]
        assert run(policy.check_event_for_spam(message)) == Codes.FORBIDDEN
        assert not run(policy.request_allowed(guest, '/_matrix/client/v3/rooms/' + room + '/messages', 'GET'))
        assert not run(policy.request_allowed(guest, '/_matrix/client/v3/account/whoami', 'GET'))
        assert not run(policy._authority.decide(guest, room, 'call'))['allowed']
    assert {call[0] for call in core.calls} == {'Bearer host-agent', 'Bearer peer-agent'}
    assert content['members'] == content['local_members'] == []
    assert state[('m.room.member', guest)].content['membership'] == 'join'


@pytest.mark.parametrize('configuration', [
    {'channel_governance_enabled': True},
    {'federation_mode': 'partner', 'federation_domain_allowlist': ['peer.example.org']},
    {'federation_domain_allowlist': ['peer.example.org']},
])
@pytest.mark.parametrize('wiring', [{}, {'core_authority_origin': 'https://core.example.org'}, {'core_authority_token': 'synthetic'}])
def test_governed_startup_requires_complete_authority(configuration, wiring):
    from conftest import ConfigError

    with pytest.raises(ConfigError):
        KoderaPolicy.parse_config({'agent_user_id': '@agent:example.org', **configuration, **wiring})
    parsed = KoderaPolicy.parse_config({
        'agent_user_id': '@agent:example.org', **configuration,
        'core_authority_origin': 'https://core.example.org', 'core_authority_token': 'synthetic',
    })
    assert parsed['core_authority_origin'] == 'https://core.example.org'


@pytest.mark.parametrize('path,method', [
    ('/_matrix/client/v3/user_directory/search', 'POST'),
    ('/_matrix/client/v3/profile/@owner:other.example.org', 'GET'),
    ('/_matrix/client/v3/profile/@owner:other.example.org/avatar_url', 'GET'),
    ('/_matrix/client/v3/publicRooms', 'GET'),
    ('/_matrix/client/v3/publicRooms', 'POST'),
    ('/_matrix/client/v3/directory/room/%23private%3Aexample.org', 'GET'),
    ('/_matrix/client/v1/media/download/example.org/media', 'GET'),
])
def test_edge_scope_resource_refuses_guest_enumeration_profile_and_media(monkeypatch, path, method):
    import sys
    from kodera_synapse_policy import _make_scope_resource
    from conftest import SynapseError

    monkeypatch.setitem(sys.modules, 'synapse.http.server', SimpleNamespace(DirectServeJsonResource=object))
    api = Api()
    async def requester(request):
        return SimpleNamespace(user=SimpleNamespace(to_string=lambda: '@guest:example.org'))
    api.get_user_by_req = requester
    policy = KoderaPolicy({'agent_user_id': '@agent:example.org'}, api)
    policy._authority = Live()
    request = SimpleNamespace(getHeader=lambda key: {'X-Original-URI': path, 'X-Original-Method': method}.get(key))
    with pytest.raises(SynapseError) as failure:
        asyncio.run(_make_scope_resource(policy)._async_render_GET(request))
    assert failure.value.code == 403


def test_guest_room_request_cannot_use_unmanaged_foreign_decision():
    policy = KoderaPolicy({'agent_user_id': '@agent:example.org'}, Api())
    class Scoped:
        async def decide(self, user, room, action):
            return {'allowed': bool(room), 'role': 'unmanaged' if room else 'single_channel_guest'}
    policy._authority = Scoped()
    assert not asyncio.run(policy.request_allowed('@guest:example.org', '/_matrix/client/v3/rooms/!unbridged:example.org/messages', 'GET'))
