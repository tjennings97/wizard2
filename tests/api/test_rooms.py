"""API tests for the session runway guard on the room routes (auth-follow-ups §3).

POST /rooms, POST /rooms/{roomId}/join and POST /rooms/{roomId}/start require more than 24 hours
left on the session (requireAuth + requireSessionRunway), even for a player in a game in progress,
so that no game can start that the session would not outlast.

The rest of the room behaviour is covered by the Jest integration tests
(server/src/routes/rooms.int.test.ts, server/src/socket/socket.int.test.ts).

See conftest.py for required environment and server settings.
"""
import pytest

from test_auth import assert_error, enter_reauth_window


@pytest.fixture
def open_room(cleanup):
    """Open a room through the API as the client's user. Returns the room id."""

    def _open(client) -> str:
        r = client.post("/rooms", json={})
        assert r.status_code == 201, r.text
        room_id = r.json()["id"]
        cleanup.room_ids.append(room_id)
        return room_id

    return _open


@pytest.fixture
def host_with_players(new_api, register, open_room):
    """A host and two more players in an open room: three players, enough to start."""

    def _make():
        host = new_api()
        host_user = register(host)["user"]
        room_id = open_room(host)
        for _ in range(2):
            p = new_api()
            register(p)
            assert p.post("/rooms/{}/join".format(room_id), json={"role": "player"}).status_code == 200
        return host, host_user, room_id

    return _make


class TestCreateRoomRunway:
    def test_fresh_session_can_create(self, api, register, cleanup):
        register(api)
        r = api.post("/rooms", json={})
        assert r.status_code == 201, r.text
        cleanup.room_ids.append(r.json()["id"])

    def test_session_in_window_gets_reauth_required(self, api, register, db):
        user = register(api)["user"]
        enter_reauth_window(db, user["id"])
        assert_error(api.post("/rooms", json={}), 401, "REAUTH_REQUIRED")
        assert db.execute("SELECT count(*) FROM rooms WHERE host_user_id = %s", (user["id"],)).fetchone()[0] == 0

    def test_applies_even_to_an_active_player(self, api, register, db, put_in_game):
        user = register(api)["user"]
        put_in_game(user["id"])
        enter_reauth_window(db, user["id"])
        # The session still works elsewhere (mid-game exemption) ...
        assert api.get("/users/me").status_code == 200
        # ... but not for entering a new room.
        assert_error(api.post("/rooms", json={}), 401, "REAUTH_REQUIRED")


class TestJoinRoomRunway:
    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_fresh_session_can_join(self, new_api, register, open_room, role):
        host = new_api()
        register(host)
        room_id = open_room(host)
        joiner = new_api()
        register(joiner)
        r = joiner.post("/rooms/{}/join".format(room_id), json={"role": role})
        assert r.status_code == 200, r.text

    @pytest.mark.parametrize("role", ["player", "spectator"])
    def test_session_in_window_gets_reauth_required(self, new_api, register, open_room, db, role):
        host = new_api()
        register(host)
        room_id = open_room(host)
        joiner = new_api()
        user = register(joiner)["user"]
        enter_reauth_window(db, user["id"])
        assert_error(joiner.post("/rooms/{}/join".format(room_id), json={"role": role}), 401, "REAUTH_REQUIRED")
        members = db.execute(
            "SELECT count(*) FROM room_members WHERE room_id = %s AND user_id = %s", (room_id, user["id"])
        ).fetchone()[0]
        assert members == 0


class TestStartGameRunway:
    def test_fresh_session_passes_the_guard(self, host_with_players):
        host, _, room_id = host_with_players()
        r = host.post("/rooms/{}/start".format(room_id))
        # Past the runway guard. Starting itself is not wired to the game engine yet (501).
        assert r.status_code != 401, r.text
        assert_error(r, 501, "NOT_IMPLEMENTED")

    def test_session_in_window_gets_reauth_required(self, host_with_players, db):
        host, host_user, room_id = host_with_players()
        enter_reauth_window(db, host_user["id"])
        assert_error(host.post("/rooms/{}/start".format(room_id)), 401, "REAUTH_REQUIRED")
        assert db.execute("SELECT state FROM rooms WHERE id = %s", (room_id,)).fetchone()[0] == "open"

    def test_not_enough_players(self, api, register, open_room):
        register(api)
        room_id = open_room(api)
        assert_error(api.post("/rooms/{}/start".format(room_id)), 400, "NOT_ENOUGH_PLAYERS")
