"""API tests for POST /bug-reports (docs/api/openapi-spec.md, "Bug Report Endpoint").

A report needs a session. The server stores it with the user's id and their session's trace_id
(the key for finding the matching server logs), the user agent and, for a player in a live game,
their own game.toPlayerView snapshot: never another player's hand.

See conftest.py for required environment and server settings.
"""
from datetime import datetime, timezone

import pytest

from test_auth import assert_error
from test_rooms import host_with_players, open_room  # noqa: F401  (fixtures)

UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) pytest"


def context(**overrides):
    body = {
        "url": "http://localhost:5173/",
        "page": "lobby",
        "clientTimestamp": datetime.now(timezone.utc).isoformat(),
    }
    body.update(overrides)
    return body


def report_body(**overrides):
    body = {"description": "The Start button did nothing.", "severity": "medium", "context": context()}
    body.update(overrides)
    return body


def stored(db, report_id):
    row = db.execute(
        "SELECT user_id, room_id, game_id, trace_id, description, severity, context, created_at "
        "FROM bug_reports WHERE id = %s",
        (report_id,),
    ).fetchone()
    assert row is not None
    keys = ["user_id", "room_id", "game_id", "trace_id", "description", "severity", "context", "created_at"]
    return dict(zip(keys, row))


def session_trace_id(db, user_id):
    return db.execute(
        "SELECT trace_id FROM sessions WHERE user_id = %s AND invalidated_at IS NULL", (user_id,)
    ).fetchone()[0]


class TestCreateReport:
    def test_creates_a_report_linked_to_the_user_and_session(self, api, register, db):
        user = register(api)["user"]
        r = api.post("/bug-reports", json=report_body(), headers={"User-Agent": UA})
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["message"]
        row = stored(db, body["reportId"])
        assert str(row["user_id"]) == user["id"]
        assert row["trace_id"] == session_trace_id(db, user["id"])
        assert row["description"] == "The Start button did nothing."
        assert row["severity"] == "medium"
        assert row["room_id"] is None and row["game_id"] is None
        assert row["created_at"] is not None
        ctx = row["context"]
        assert ctx["url"] == "http://localhost:5173/"
        assert ctx["page"] == "lobby"
        assert ctx["user_agent"] == UA
        assert ctx["client_timestamp"]
        assert ctx["game_state_summary"] is None

    def test_severity_is_optional(self, api, register, db):
        register(api)
        body = report_body()
        del body["severity"]
        r = api.post("/bug-reports", json=body)
        assert r.status_code == 201, r.text
        assert stored(db, r.json()["reportId"])["severity"] is None

    def test_description_is_trimmed(self, api, register, db):
        register(api)
        r = api.post("/bug-reports", json=report_body(description="  Cards overlap  \n"))
        assert r.status_code == 201, r.text
        assert stored(db, r.json()["reportId"])["description"] == "Cards overlap"


class TestRequiredFields:
    @pytest.mark.parametrize(
        "body, field",
        [
            ({"context": context()}, "description"),
            ({"description": "   ", "context": context()}, "description"),
            ({"description": "x" * 2001, "context": context()}, "description"),
            ({"description": "Broken"}, "context"),
            ({"description": "Broken", "context": context(url=None)}, "context.url"),
            ({"description": "Broken", "context": context(url="javascript:alert(1)")}, "context.url"),
            ({"description": "Broken", "context": context(clientTimestamp=None)}, "context.clientTimestamp"),
            ({"description": "Broken", "context": context(clientTimestamp="yesterday")}, "context.clientTimestamp"),
            ({"description": "Broken", "severity": "critical", "context": context()}, "severity"),
            ({"description": "Broken", "context": context(roomId="not-a-uuid")}, "context.roomId"),
            ({"description": "Broken", "context": context(roundNumber=-1)}, "context.roundNumber"),
        ],
    )
    def test_invalid_body_is_rejected(self, api, register, db, body, field):
        user = register(api)["user"]
        r = api.post("/bug-reports", json=body)
        assert_error(r, 400, "VALIDATION_ERROR")
        assert field in r.json()["details"]["fields"]
        assert db.execute("SELECT count(*) FROM bug_reports WHERE user_id = %s", (user["id"],)).fetchone()[0] == 0

    def test_description_of_2000_characters_is_accepted(self, api, register):
        register(api)
        assert api.post("/bug-reports", json=report_body(description="x" * 2000)).status_code == 201


class TestAuthRequired:
    def test_no_session_is_rejected(self, api, db):
        before = db.execute("SELECT count(*) FROM bug_reports").fetchone()[0]
        assert_error(api.post("/bug-reports", json=report_body()), 401, "UNAUTHORIZED")
        assert db.execute("SELECT count(*) FROM bug_reports").fetchone()[0] == before

    def test_logged_out_session_is_rejected(self, api, register):
        register(api)
        cookie = api.cookies.get("wizard_session")
        assert api.post("/auth/logout").status_code == 204
        api.cookies.set("wizard_session", cookie)
        r = api.post("/bug-reports", json=report_body())
        assert r.status_code == 401, r.text

    def test_rate_limited_per_user(self, api, register):
        register(api)
        for _ in range(10):
            assert api.post("/bug-reports", json=report_body()).status_code == 201
        assert_error(api.post("/bug-reports", json=report_body()), 429, "RATE_LIMITED")


class TestContextCaptured:
    def test_player_in_a_live_game_gets_their_own_view_only(self, host_with_players, db):  # noqa: F811
        host, host_user, room_id = host_with_players()
        assert host.post("/rooms/{}/start".format(room_id)).status_code == 200
        game_id = str(db.execute("SELECT id FROM games WHERE room_id = %s", (room_id,)).fetchone()[0])

        r = host.post(
            "/bug-reports",
            json=report_body(
                context=context(
                    url="http://localhost:5173/game/{}".format(game_id),
                    page="game",
                    # The server, not the client, decides where the reporter is and what they hold.
                    roomId=None,
                    gameId=None,
                    gameStateSummary={"players": [{"userId": "someone", "hand": ["planted"]}]},
                )
            ),
        )
        assert r.status_code == 201, r.text
        row = stored(db, r.json()["reportId"])
        assert str(row["room_id"]) == room_id
        assert str(row["game_id"]) == game_id
        ctx = row["context"]
        assert ctx["page"] == "game"
        assert ctx["round_number"] == 1
        view = ctx["game_state_summary"]
        assert view["gameId"] == game_id
        assert view["viewerUserId"] == host_user["id"]
        assert len(view["players"]) == 3
        for p in view["players"]:
            if p["userId"] == host_user["id"]:
                assert isinstance(p["hand"], list) and len(p["hand"]) == 1
            else:
                assert p["hand"] is None
            assert p["handCount"] == 1
        assert "planted" not in str(ctx)

    def test_room_member_outside_a_game_gets_the_room_id(self, new_api, register, open_room, db):  # noqa: F811
        host = new_api()
        register(host)
        room_id = open_room(host)
        r = host.post("/bug-reports", json=report_body(context=context(page="room")))
        assert r.status_code == 201, r.text
        row = stored(db, r.json()["reportId"])
        assert str(row["room_id"]) == room_id
        assert row["game_id"] is None
        assert row["context"]["game_state_summary"] is None

    def test_client_ids_are_kept_only_if_they_exist(self, api, register, db, put_in_game):
        user = register(api)["user"]
        # A finished game the user has left: not their current location, but a real row.
        game_id = put_in_game(user["id"], status="complete", left=True)
        room_id = str(db.execute("SELECT room_id FROM games WHERE id = %s", (game_id,)).fetchone()[0])
        r = api.post("/bug-reports", json=report_body(context=context(roomId=room_id, gameId=game_id, roundNumber=4)))
        assert r.status_code == 201, r.text
        row = stored(db, r.json()["reportId"])
        assert (str(row["room_id"]), str(row["game_id"])) == (room_id, game_id)
        assert row["context"]["round_number"] == 4

        missing = "00000000-0000-4000-8000-000000000000"
        r = api.post("/bug-reports", json=report_body(context=context(roomId=missing, gameId=missing)))
        assert r.status_code == 201, r.text
        row = stored(db, r.json()["reportId"])
        assert row["room_id"] is None and row["game_id"] is None
