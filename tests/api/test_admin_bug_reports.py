"""API tests for GET /admin/bug-reports (docs/api/openapi-spec.md "Admin Endpoints"): admins read
the reports users sent, newest first, filtered by severity and paginated.

Reports are seeded directly in Postgres with timestamps a day ahead, so they sort above any other
report in the shared test database. See conftest.py for required environment and server settings.
"""
from psycopg.types.json import Jsonb
import pytest

from test_admin import admin, player  # noqa: F401  (fixtures)
from test_auth import assert_error


@pytest.fixture
def seed_report(db):
    """Insert a bug report for `user_id`, `offset` seconds after now + 1 day. Returns its id.
    The cleanup fixture deletes it with the user."""

    def _seed(user_id, offset=0, severity="medium", description="Cards overlap", context=None):
        row = db.execute(
            "INSERT INTO bug_reports (user_id, trace_id, description, severity, context, created_at) "
            "VALUES (%s, gen_random_uuid(), %s, %s, %s, now() + interval '1 day' + make_interval(secs => %s)) "
            "RETURNING id",
            (user_id, description, severity, Jsonb(context or {"url": "http://localhost/", "page": "lobby"}), offset),
        ).fetchone()
        return str(row[0])

    return _seed


class TestListBugReports:
    def test_lists_newest_first_with_reporter_and_context(self, admin, player, seed_report, db):  # noqa: F811
        ctx = {"url": "http://localhost/game/x", "page": "game", "round_number": 3, "game_state_summary": {"currentRound": 3}}
        older = seed_report(player.user["id"], offset=1, description="first")
        newer = seed_report(player.user["id"], offset=2, severity="high", description="second", context=ctx)
        r = admin.get("/admin/bug-reports?limit=2")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["page"] == 1 and body["limit"] == 2 and body["total"] >= 2
        assert [d["id"] for d in body["data"]] == [newer, older]
        top = body["data"][0]
        assert top["description"] == "second"
        assert top["severity"] == "high"
        assert top["reporter"] == {
            "id": player.user["id"],
            "username": player.user["username"],
            "displayName": player.user["displayName"],
        }
        assert top["context"] == ctx
        trace = db.execute("SELECT trace_id FROM bug_reports WHERE id = %s", (newer,)).fetchone()[0]
        assert top["traceId"] == str(trace)
        assert top["createdAt"].endswith("Z")
        assert top["roomId"] is None and top["gameId"] is None

    def test_paginates(self, admin, player, seed_report):  # noqa: F811
        ids = [seed_report(player.user["id"], offset=10 + i) for i in range(3)]
        first = admin.get("/admin/bug-reports?page=1&limit=2").json()
        second = admin.get("/admin/bug-reports?page=2&limit=2").json()
        assert [d["id"] for d in first["data"]] == [ids[2], ids[1]]
        assert second["data"][0]["id"] == ids[0]
        assert second["page"] == 2

    def test_filters_by_severity(self, admin, player, seed_report):  # noqa: F811
        high = seed_report(player.user["id"], offset=20, severity="high")
        low = seed_report(player.user["id"], offset=21, severity="low")
        data = admin.get("/admin/bug-reports?severity=high&limit=100").json()["data"]
        ids = [d["id"] for d in data]
        assert high in ids and low not in ids
        assert all(d["severity"] == "high" for d in data)

    @pytest.mark.parametrize(
        "query, field",
        [("severity=critical", "severity"), ("page=0", "page"), ("limit=101", "limit"), ("limit=abc", "limit")],
    )
    def test_invalid_query(self, admin, query, field):  # noqa: F811
        r = admin.get("/admin/bug-reports?" + query)
        assert_error(r, 400, "VALIDATION_ERROR")
        assert field in r.json()["details"]["fields"]


class TestBugReportsAccess:
    def test_players_are_refused(self, player):  # noqa: F811
        assert_error(player.get("/admin/bug-reports"), 403, "FORBIDDEN")

    def test_requires_a_session(self, api):
        assert_error(api.get("/admin/bug-reports"), 401, "UNAUTHORIZED")
