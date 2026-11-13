import importlib.util
import pathlib
import sqlite3
import tempfile
import unittest

source = pathlib.Path(__file__).parent / "integration" / "federation.py"
spec = importlib.util.spec_from_file_location("federation_fixture", source)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
agent = fixture.AGENT
promote = fixture.promote_fixture_agent


class Bootstrap(unittest.TestCase):
    def database(self, folder, rows):
        p = pathlib.Path(folder) / "homeserver.db"
        with sqlite3.connect(p) as c:
            c.execute(
                "CREATE TABLE users (name TEXT PRIMARY KEY, admin INTEGER, profile TEXT)"
            )
            c.executemany("INSERT INTO users VALUES (?, ?, ?)", rows)
        return p

    def rows(self, p):
        with sqlite3.connect(p) as c:
            return c.execute("SELECT * FROM users ORDER BY name").fetchall()

    def test_exact_one_cell_and_private_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.database(d, [(agent, 0, "same"), ("alice", 0, "same")])
            promote(p)
            self.assertEqual(self.rows(p), [(agent, 1, "same"), ("alice", 0, "same")])
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def test_missing_agent_refuses_without_changes(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.database(d, [("alice", 0, "same")])
            before = self.rows(p)
            with self.assertRaisesRegex(
                RuntimeError, "exactly one ordinary synthetic agent"
            ):
                promote(p)
            self.assertEqual(self.rows(p), before)

    def test_existing_admin_refuses_without_changes(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.database(d, [(agent, 1, "same"), ("alice", 0, "same")])
            before = self.rows(p)
            with self.assertRaisesRegex(
                RuntimeError, "exactly one ordinary synthetic agent"
            ):
                promote(p)
            self.assertEqual(self.rows(p), before)

    def test_trigger_extra_update_refuses_and_rolls_back(self):
        with tempfile.TemporaryDirectory() as d:
            p = self.database(d, [(agent, 0, "same"), ("alice", 0, "same")])
            before = self.rows(p)
            with sqlite3.connect(p) as c:
                c.execute(
                    "CREATE TRIGGER changed AFTER UPDATE ON users BEGIN UPDATE users SET profile='unexpected' WHERE name='alice'; END"
                )
            with self.assertRaisesRegex(
                RuntimeError, "changed unexpected account data"
            ):
                promote(p)
            self.assertEqual(self.rows(p), before)


if __name__ == "__main__":
    unittest.main()
