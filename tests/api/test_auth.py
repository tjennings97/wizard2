"""API tests for /api/v1/auth/* and the session middleware.

See conftest.py for required environment and server settings.
"""
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import pytest

from conftest import (
    DEFAULT_PASSPHRASE,
    DEFAULT_PASSWORD,
    SESSION_COOKIE,
    Api,
    random_ip,
    raw_session_token,
    registration_body,
    sha256_hex,
)

INVITE_INVALID_MESSAGE = "Invite code is invalid, expired, or has already been used."


def assert_error(r, status, code):
    assert r.status_code == status, r.text
    body = r.json()
    assert body["code"] == code
    assert isinstance(body["message"], str) and body["message"]


def session_cookie_header(r) -> str:
    header = r.headers.get("Set-Cookie", "")
    assert header.startswith(SESSION_COOKIE + "="), header
    return header


def active_sessions(db, user_id):
    return db.execute(
        "SELECT id FROM sessions WHERE user_id = %s AND invalidated_at IS NULL AND expires_at > now()",
        (user_id,),
    ).fetchall()


def login(client, username, password=DEFAULT_PASSWORD):
    return client.post("/auth/login", json={"username": username, "password": password})


# ---------------------------------------------------------------------------
# Session middleware (exercised through POST /auth/logout, the protected auth route)
# ---------------------------------------------------------------------------


class TestSessionMiddleware:
    def test_missing_cookie_is_401(self, api):
        assert_error(api.post("/auth/logout"), 401, "UNAUTHORIZED")

    def test_unsigned_or_tampered_cookie_is_401(self, api, register):
        register(api)
        token = raw_session_token(api)
        forged = Api()
        forged.cookies.set(SESSION_COOKIE, "s:{}.not-the-signature".format(token))
        assert_error(forged.post("/auth/logout"), 401, "UNAUTHORIZED")
        bare = Api()
        bare.cookies.set(SESSION_COOKIE, token)
        assert_error(bare.post("/auth/logout"), 401, "UNAUTHORIZED")

    def test_expired_session_is_401(self, api, register, db):
        user = register(api)["user"]
        db.execute(
            "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = %s",
            (user["id"],),
        )
        assert_error(api.post("/auth/logout"), 401, "UNAUTHORIZED")

    def test_invalidated_session_is_401(self, api, register, db):
        user = register(api)["user"]
        db.execute("UPDATE sessions SET invalidated_at = now() WHERE user_id = %s", (user["id"],))
        assert_error(api.post("/auth/logout"), 401, "SESSION_INVALIDATED")

    def test_token_is_stored_only_as_sha256(self, api, register, db):
        user = register(api)["user"]
        token = raw_session_token(api)
        rows = db.execute("SELECT token_hash FROM sessions WHERE user_id = %s", (user["id"],)).fetchall()
        assert [r[0] for r in rows] == [sha256_hex(token)]
        assert token not in rows[0][0]


# ---------------------------------------------------------------------------
# Sliding expiry: 24h idle timeout, 30-day hard cap. Logout is the only protected auth
# route, and the middleware slides expiry before the handler runs, so expires_at is read
# back after a logout.
# ---------------------------------------------------------------------------


def session_times(db, user_id):
    """(expires_at - now, expires_at - created_at) for the user's only session."""
    return db.execute(
        "SELECT expires_at - now(), expires_at - created_at FROM sessions WHERE user_id = %s",
        (user_id,),
    ).fetchone()


class TestSlidingExpiry:
    def test_new_session_expires_after_24h_idle(self, api, register, db):
        user = register(api)["user"]
        remaining, _ = session_times(db, user["id"])
        assert timedelta(hours=23, minutes=59) < remaining <= timedelta(hours=24)

    def test_cookie_lives_for_the_30_day_cap(self, api, make_invite, cleanup):
        r = api.post("/auth/register", json=registration_body(make_invite()))
        assert r.status_code == 201, r.text
        cleanup.user_ids.append(r.json()["id"])
        expires = parsedate_to_datetime(session_cookie_header(r).split("Expires=")[1].split(";")[0])
        lifetime = expires - datetime.now(timezone.utc)
        assert timedelta(days=29, hours=23) < lifetime <= timedelta(days=30)

    def test_activity_slides_expiry_forward(self, api, register, db):
        user = register(api)["user"]
        db.execute("UPDATE sessions SET expires_at = now() + interval '1 hour' WHERE user_id = %s", (user["id"],))
        assert api.post("/auth/logout").status_code == 204
        remaining, _ = session_times(db, user["id"])
        assert remaining > timedelta(hours=23)

    def test_expiry_never_passes_30_day_cap(self, api, register, db):
        user = register(api)["user"]
        db.execute(
            "UPDATE sessions SET created_at = now() - interval '720 hours' + interval '2 hours', "
            "expires_at = now() + interval '1 minute' WHERE user_id = %s",
            (user["id"],),
        )
        assert api.post("/auth/logout").status_code == 204
        remaining, lifetime = session_times(db, user["id"])
        assert remaining > timedelta(hours=1)  # it did slide, up to the cap...
        assert lifetime <= timedelta(days=30)  # ...but not past it


# ---------------------------------------------------------------------------
# Re-auth window: in the last 24h before the 30-day cap, a returning user must log in again
# unless they are an active player in a game in progress.
# ---------------------------------------------------------------------------


def enter_reauth_window(db, user_id, hours_left=12):
    db.execute(
        "UPDATE sessions SET created_at = now() - interval '720 hours' + make_interval(hours => %s), "
        "expires_at = now() + make_interval(hours => %s) WHERE user_id = %s AND invalidated_at IS NULL",
        (hours_left, hours_left, user_id),
    )


class TestReauthWindow:
    def test_users_me_returns_current_user(self, api, register):
        user = register(api)["user"]
        r = api.get("/users/me")
        assert r.status_code == 200, r.text
        assert r.json() == user

    def test_outside_window_is_allowed(self, api, register, db):
        user = register(api)["user"]
        enter_reauth_window(db, user["id"], hours_left=25)
        assert api.get("/users/me").status_code == 200

    def test_returning_user_in_window_must_log_in_again(self, api, register, db):
        reg = register(api)
        enter_reauth_window(db, reg["user"]["id"])
        r = api.get("/users/me")
        assert_error(r, 401, "REAUTH_REQUIRED")
        # Not a logout: the session stays valid and the cookie is left alone.
        assert "Set-Cookie" not in r.headers
        assert len(active_sessions(db, reg["user"]["id"])) == 1

        # Logging in again (on the same device) issues a fresh 30-day session.
        assert login(api, reg["body"]["username"]).status_code == 200
        assert api.get("/users/me").status_code == 200

    def test_blocked_request_does_not_slide_expiry(self, api, register, db):
        user = register(api)["user"]
        # In the window (12h left before the cap), with an idle expiry that could slide by 11h.
        db.execute(
            "UPDATE sessions SET created_at = now() - interval '708 hours', "
            "expires_at = now() + interval '1 hour' WHERE user_id = %s",
            (user["id"],),
        )
        assert_error(api.get("/users/me"), 401, "REAUTH_REQUIRED")
        remaining, _ = session_times(db, user["id"])
        assert remaining <= timedelta(hours=1)

    def test_active_player_in_game_may_continue(self, api, register, db, put_in_game):
        user = register(api)["user"]
        put_in_game(user["id"])
        enter_reauth_window(db, user["id"])
        assert api.get("/users/me").status_code == 200

    @pytest.mark.parametrize(
        "seat",
        [
            {"role": "spectator"},
            {"left": True},
            {"status": "complete"},
            {"status": "incomplete"},
        ],
        ids=["spectator", "left_the_game", "game_complete", "game_abandoned"],
    )
    def test_not_an_active_player_must_log_in_again(self, api, register, db, put_in_game, seat):
        user = register(api)["user"]
        put_in_game(user["id"], **seat)
        enter_reauth_window(db, user["id"])
        assert_error(api.get("/users/me"), 401, "REAUTH_REQUIRED")

    def test_logout_still_works_in_window(self, api, register, db):
        user = register(api)["user"]
        enter_reauth_window(db, user["id"])
        assert api.post("/auth/logout").status_code == 204
        assert active_sessions(db, user["id"]) == []


# ---------------------------------------------------------------------------
# Forced credential change: while requires_credential_change is set, only GET /users/me,
# PATCH /users/me and POST /auth/logout are allowed (403 CREDENTIAL_CHANGE_REQUIRED
# elsewhere; that path is covered by the Jest middleware tests until other routes exist).
# ---------------------------------------------------------------------------


class TestForcedCredentialChange:
    def test_flagged_user_can_read_profile_and_log_out(self, api, new_api, register, db):
        reg = register(api)
        db.execute("UPDATE users SET requires_credential_change = true WHERE id = %s", (reg["user"]["id"],))
        client = new_api()
        assert login(client, reg["body"]["username"]).json()["requiresCredentialChange"] is True

        me = client.get("/users/me")
        assert me.status_code == 200, me.text
        assert me.json()["requiresCredentialChange"] is True
        assert client.post("/auth/logout").status_code == 204


# ---------------------------------------------------------------------------
# Session row pruning: a login deletes the user's sessions that ended over 24h ago.
# ---------------------------------------------------------------------------


class TestSessionPruning:
    def test_login_deletes_sessions_ended_over_a_day_ago(self, api, new_api, register, db):
        reg = register(api)
        user_id = reg["user"]["id"]
        # Three historical rows: invalidated 2 days ago, expired 2 days ago, invalidated 1 hour ago.
        for invalidated, expires in [("now() - interval '48 hours'", "now()"),
                                     ("NULL", "now() - interval '48 hours'"),
                                     ("now() - interval '1 hour'", "now() + interval '1 hour'")]:
            db.execute(
                "INSERT INTO sessions (user_id, token_hash, created_at, expires_at, invalidated_at) "
                "VALUES (%s, md5(random()::text), now() - interval '72 hours', {}, {})".format(expires, invalidated),
                (user_id,),
            )
        assert db.execute("SELECT count(*) FROM sessions WHERE user_id = %s", (user_id,)).fetchone()[0] == 4

        displaced_hash = sha256_hex(raw_session_token(api))
        assert login(new_api(), reg["body"]["username"]).status_code == 200

        rows = db.execute(
            "SELECT token_hash, invalidated_at IS NULL FROM sessions WHERE user_id = %s", (user_id,)
        ).fetchall()
        # Left: the session this login displaced, the one invalidated an hour ago, and the new one.
        assert len(rows) == 3
        assert sum(1 for _, active in rows if active) == 1
        assert displaced_hash in [h for h, _ in rows]
        # So the displaced device still learns why it was signed out.
        assert_error(api.post("/auth/logout"), 401, "SESSION_INVALIDATED")


# ---------------------------------------------------------------------------
# POST /auth/register
# ---------------------------------------------------------------------------


class TestRegister:
    def test_happy_path(self, api, make_invite, db, cleanup):
        code = make_invite()
        body = registration_body(code)
        r = api.post("/auth/register", json=body)
        assert r.status_code == 201, r.text
        user = r.json()
        cleanup.user_ids.append(user["id"])

        assert user["username"] == body["username"]
        assert user["displayName"] == body["displayName"]
        assert user["role"] == "player"
        assert user["avatarConfig"] == body["avatarConfig"]
        assert user["avatarSvg"] == body["avatarSvg"]
        assert user["requiresCredentialChange"] is False
        assert "password_hash" not in user and "passwordHash" not in user
        assert "recovery_hash" not in user and "recoveryHash" not in user

        cookie = session_cookie_header(r)
        assert "HttpOnly" in cookie
        assert "SameSite=Strict" in cookie

        # Credentials are bcrypt-hashed with work factor 12.
        pw_hash, rec_hash = db.execute(
            "SELECT password_hash, recovery_hash FROM users WHERE id = %s", (user["id"],)
        ).fetchone()
        assert pw_hash.startswith("$2b$12$")
        assert rec_hash.startswith("$2b$12$")

        # Invite is consumed by this user.
        status, redeemed_by, redeemed_at = db.execute(
            "SELECT status, redeemed_by, redeemed_at FROM invites WHERE code_hash = %s",
            (sha256_hex(code),),
        ).fetchone()
        assert status == "accepted"
        assert str(redeemed_by) == user["id"]
        assert redeemed_at is not None

        # The issued cookie is a working session.
        assert len(active_sessions(db, user["id"])) == 1
        assert api.post("/auth/logout").status_code == 204

    def test_avatar_svg_may_be_null(self, api, register):
        user = register(api, avatarSvg=None)["user"]
        assert user["avatarSvg"] is None

    @pytest.mark.parametrize(
        "invite_kwargs",
        [
            {"expires_in": timedelta(seconds=-1)},
            {"status": "accepted", "redeemed": True},
            {"status": "revoked"},
        ],
        ids=["expired", "already_redeemed", "revoked"],
    )
    def test_unusable_invite_is_422(self, api, make_invite, db, invite_kwargs):
        body = registration_body(make_invite(**invite_kwargs))
        r = api.post("/auth/register", json=body)
        assert_error(r, 422, "INVITE_INVALID")
        assert r.json()["message"] == INVITE_INVALID_MESSAGE
        assert db.execute("SELECT 1 FROM users WHERE username = %s", (body["username"],)).fetchone() is None

    def test_unknown_invite_is_422_with_same_message(self, api):
        r = api.post("/auth/register", json=registration_body("not-a-real-code"))
        assert_error(r, 422, "INVITE_INVALID")
        assert r.json()["message"] == INVITE_INVALID_MESSAGE

    def test_invite_is_single_use(self, new_api, make_invite, cleanup):
        code = make_invite()
        first = new_api().post("/auth/register", json=registration_body(code))
        assert first.status_code == 201, first.text
        cleanup.user_ids.append(first.json()["id"])
        second = new_api().post("/auth/register", json=registration_body(code))
        assert_error(second, 422, "INVITE_INVALID")

    def test_username_taken_is_409_and_invite_not_consumed(self, api, new_api, register, make_invite, db):
        existing = register(api)["body"]["username"]
        code = make_invite()
        r = new_api().post("/auth/register", json=registration_body(code, username=existing))
        assert_error(r, 409, "USERNAME_TAKEN")
        status, redeemed_at = db.execute(
            "SELECT status, redeemed_at FROM invites WHERE code_hash = %s", (sha256_hex(code),)
        ).fetchone()
        assert status == "pending"
        assert redeemed_at is None

    @pytest.mark.parametrize(
        "overrides, field",
        [
            ({"username": "ab"}, "username"),
            ({"username": "Has-Caps"}, "username"),
            ({"password": "short"}, "password"),
            ({"recoveryPassphrase": "short"}, "recoveryPassphrase"),
            ({"displayName": "   "}, "displayName"),
            ({"avatarConfig": {"head": "round"}}, "avatarConfig"),
        ],
        ids=["username_short", "username_format", "password_short", "passphrase_short", "display_blank", "avatar_partial"],
    )
    def test_validation_errors_are_400(self, api, make_invite, overrides, field):
        r = api.post("/auth/register", json=registration_body(make_invite(), **overrides))
        assert_error(r, 400, "VALIDATION_ERROR")
        assert field in r.json()["details"]["fields"]

    def test_missing_fields_are_400(self, api):
        r = api.post("/auth/register", json={})
        assert_error(r, 400, "VALIDATION_ERROR")
        fields = r.json()["details"]["fields"]
        for f in ["inviteCode", "username", "displayName", "password", "recoveryPassphrase", "avatarConfig", "avatarSvg"]:
            assert f in fields

    def test_rate_limited_after_5_per_hour(self, api):
        for _ in range(5):
            assert api.post("/auth/register", json=registration_body("bogus")).status_code == 422
        r = api.post("/auth/register", json=registration_body("bogus"))
        assert_error(r, 429, "RATE_LIMITED")
        assert "Retry-After" in r.headers


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------


class TestLogin:
    def test_happy_path(self, api, new_api, register):
        reg = register(api)
        client = new_api()
        r = login(client, reg["body"]["username"])
        assert r.status_code == 200, r.text
        user = r.json()
        assert user["id"] == reg["user"]["id"]
        assert user["requiresCredentialChange"] is False
        cookie = session_cookie_header(r)
        assert "HttpOnly" in cookie
        assert client.post("/auth/logout").status_code == 204

    def test_requires_credential_change_flag_is_returned(self, api, new_api, register, db):
        reg = register(api)
        db.execute("UPDATE users SET requires_credential_change = true WHERE id = %s", (reg["user"]["id"],))
        r = login(new_api(), reg["body"]["username"])
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is True

    def test_wrong_password_is_401(self, api, new_api, register):
        reg = register(api)
        client = new_api()
        r = login(client, reg["body"]["username"], "wrong password!")
        assert_error(r, 401, "INVALID_CREDENTIALS")
        assert SESSION_COOKIE not in client.cookies

    def test_unknown_user_is_401_with_same_code(self, api):
        assert_error(login(api, "no_such_user_zz"), 401, "INVALID_CREDENTIALS")

    def test_missing_fields_are_400(self, api):
        assert_error(api.post("/auth/login", json={"username": "someone"}), 400, "VALIDATION_ERROR")

    def test_username_is_case_insensitive_and_trimmed(self, api, new_api, register):
        reg = register(api)
        typed = "  " + reg["body"]["username"].capitalize() + " "
        r = login(new_api(), typed)
        assert r.status_code == 200, r.text
        assert r.json()["id"] == reg["user"]["id"]

    def test_new_login_invalidates_previous_session(self, api, new_api, register, db):
        reg = register(api)
        user_id = reg["user"]["id"]
        old_hash = sha256_hex(raw_session_token(api))

        second = new_api()
        assert login(second, reg["body"]["username"]).status_code == 200

        invalidated_at = db.execute(
            "SELECT invalidated_at FROM sessions WHERE token_hash = %s", (old_hash,)
        ).fetchone()[0]
        assert invalidated_at is not None
        assert len(active_sessions(db, user_id)) == 1

        # The displaced client is told why; the new one still works.
        assert_error(api.post("/auth/logout"), 401, "SESSION_INVALIDATED")
        assert second.post("/auth/logout").status_code == 204

    def test_rate_limited_after_10_per_15_minutes(self, api):
        for _ in range(10):
            assert login(api, "no_such_user_zz").status_code == 401
        r = login(api, "no_such_user_zz")
        assert_error(r, 429, "RATE_LIMITED")
        assert "Retry-After" in r.headers

    def test_rate_limit_is_per_ip(self, api):
        for _ in range(10):
            login(api, "no_such_user_zz")
        assert login(api, "no_such_user_zz").status_code == 429
        assert login(Api(random_ip()), "no_such_user_zz").status_code == 401


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


class TestLogout:
    def test_happy_path(self, api, register, db):
        user = register(api)["user"]
        token_hash = sha256_hex(raw_session_token(api))

        r = api.post("/auth/logout")
        assert r.status_code == 204
        assert r.content == b""
        # Cookie is cleared.
        cleared = r.headers.get("Set-Cookie", "")
        assert cleared.startswith(SESSION_COOKIE + "=;")
        assert "Expires=Thu, 01 Jan 1970" in cleared
        assert SESSION_COOKIE not in api.cookies

        invalidated_at = db.execute(
            "SELECT invalidated_at FROM sessions WHERE token_hash = %s", (token_hash,)
        ).fetchone()[0]
        assert invalidated_at is not None
        assert active_sessions(db, user["id"]) == []

    def test_reusing_logged_out_token_is_401(self, api, register):
        register(api)
        token_cookie = api.cookies.get(SESSION_COOKIE)
        assert api.post("/auth/logout").status_code == 204
        replay = Api()
        replay.cookies.set(SESSION_COOKIE, token_cookie)
        assert replay.post("/auth/logout").status_code == 401

    def test_without_session_is_401(self, api):
        assert_error(api.post("/auth/logout"), 401, "UNAUTHORIZED")


# ---------------------------------------------------------------------------
# POST /auth/reset-password
# ---------------------------------------------------------------------------


class TestResetPassword:
    NEW_PASSWORD = "a brand new password"

    def reset(self, client, username, passphrase=DEFAULT_PASSPHRASE, new_password=NEW_PASSWORD):
        return client.post(
            "/auth/reset-password",
            json={"username": username, "recoveryPassphrase": passphrase, "newPassword": new_password},
        )

    def test_happy_path(self, api, new_api, register, db):
        reg = register(api)
        username = reg["body"]["username"]

        r = self.reset(new_api(), username)
        assert r.status_code == 204, r.text

        # New password works, old one does not.
        assert_error(login(new_api(), username, DEFAULT_PASSWORD), 401, "INVALID_CREDENTIALS")
        assert login(new_api(), username, self.NEW_PASSWORD).status_code == 200

        pw_hash = db.execute("SELECT password_hash FROM users WHERE id = %s", (reg["user"]["id"],)).fetchone()[0]
        assert pw_hash.startswith("$2b$12$")

    def test_reset_invalidates_existing_sessions(self, api, new_api, register, db):
        reg = register(api)
        assert self.reset(new_api(), reg["body"]["username"]).status_code == 204
        assert active_sessions(db, reg["user"]["id"]) == []
        assert api.post("/auth/logout").status_code == 401

    def test_wrong_passphrase_is_401_and_password_unchanged(self, api, new_api, register):
        reg = register(api)
        username = reg["body"]["username"]
        assert_error(self.reset(new_api(), username, passphrase="not the passphrase"), 401, "INVALID_RECOVERY")
        assert login(new_api(), username, DEFAULT_PASSWORD).status_code == 200

    def test_unknown_user_is_401_same_as_wrong_passphrase(self, api, new_api, register):
        unknown = self.reset(api, "no_such_user_zz")
        assert_error(unknown, 401, "INVALID_RECOVERY")
        reg = register(new_api())
        wrong = self.reset(new_api(), reg["body"]["username"], passphrase="not the passphrase")
        assert unknown.json() == wrong.json()

    def test_username_is_case_insensitive(self, api, new_api, register):
        reg = register(api)
        username = reg["body"]["username"]
        assert self.reset(new_api(), username.upper()).status_code == 204
        assert login(new_api(), username, self.NEW_PASSWORD).status_code == 200

    def test_short_new_password_is_400(self, api, new_api, register):
        reg = register(api)
        r = self.reset(new_api(), reg["body"]["username"], new_password="short")
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "newPassword" in r.json()["details"]["fields"]

    def test_rate_limited_after_5_per_hour(self, api):
        for _ in range(5):
            assert self.reset(api, "no_such_user_zz").status_code == 401
        r = self.reset(api, "no_such_user_zz")
        assert_error(r, 429, "RATE_LIMITED")
        assert "Retry-After" in r.headers


# ---------------------------------------------------------------------------
# CORS (server under test runs with NODE_ENV=development or test)
# ---------------------------------------------------------------------------


class TestCors:
    def test_dev_origin_allowed_with_credentials(self, api):
        r = api.options(
            "/auth/login",
            headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST"},
        )
        assert r.headers.get("Access-Control-Allow-Origin") == "http://localhost:5173"
        assert r.headers.get("Access-Control-Allow-Credentials") == "true"

    def test_other_origin_not_allowed(self, api):
        r = api.options(
            "/auth/login",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
        assert r.headers.get("Access-Control-Allow-Origin") != "https://evil.example"


# ---------------------------------------------------------------------------
# Request body errors from express.json() are client errors, not 500s
# ---------------------------------------------------------------------------


class TestRequestBodyErrors:
    def test_oversized_body_is_413(self, api):
        r = api.post(
            "/auth/login",
            data='{"username": "' + "a" * 200_000 + '"}',
            headers={"Content-Type": "application/json"},
        )
        assert_error(r, 413, "PAYLOAD_TOO_LARGE")

    def test_unsupported_charset_is_415(self, api):
        r = api.post(
            "/auth/login",
            data='{"username": "someone"}',
            headers={"Content-Type": "application/json; charset=klingon"},
        )
        assert_error(r, 415, "UNSUPPORTED_MEDIA_TYPE")

    def test_malformed_json_is_400(self, api):
        r = api.post("/auth/login", data="{not json", headers={"Content-Type": "application/json"})
        assert_error(r, 400, "VALIDATION_ERROR")
