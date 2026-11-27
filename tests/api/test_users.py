"""API tests for PATCH /api/v1/users/me (auth-follow-ups §4a) and the forced credential change
that it completes (§4b "Done when").

The forced-change cases here simulate an admin reset in the database (requires_credential_change =
true, both *_changed_at columns NULL) so the user keeps a known password and each PATCH rule can be
tested on its own. The same flow through the real endpoint (POST /admin/users/{userId}/
reset-credentials, with its temporary credentials) is in test_admin.py.

See conftest.py for required environment and server settings.
"""
import pytest

from conftest import DEFAULT_PASSPHRASE, DEFAULT_PASSWORD, SESSION_COOKIE, raw_session_token, sha256_hex
from test_auth import active_sessions, assert_error, enter_reauth_window, login

NEW_PASSWORD = "brand new password 1"
NEW_PASSPHRASE = "a fresh recovery phrase"
BLOCKED_ROUTE = "/lobby/rooms"  # any route without allowDuringCredentialChange


def user_row(db, user_id):
    return db.execute(
        "SELECT display_name, requires_credential_change, password_changed_at, recovery_changed_at "
        "FROM users WHERE id = %s",
        (user_id,),
    ).fetchone()


def simulate_admin_reset(db, user_id):
    """What the admin reset does, minus the temporary credentials (the user keeps theirs)."""
    db.execute(
        "UPDATE users SET requires_credential_change = true, password_changed_at = NULL, "
        "recovery_changed_at = NULL WHERE id = %s",
        (user_id,),
    )
    db.execute("UPDATE sessions SET invalidated_at = now() WHERE user_id = %s AND invalidated_at IS NULL", (user_id,))


class TestDisplayName:
    def test_updates_display_name_without_rotating_session(self, api, register, db):
        reg = register(api)
        token = raw_session_token(api)
        r = api.patch("/users/me", json={"displayName": "  New Name  "})
        assert r.status_code == 200, r.text
        assert r.json()["displayName"] == "New Name"
        assert "Set-Cookie" not in r.headers
        assert raw_session_token(api) == token
        assert user_row(db, reg["user"]["id"])[0] == "New Name"

    @pytest.mark.parametrize("value", ["", "   ", "x" * 65, 5, None])
    def test_invalid_display_name_is_400(self, api, register, value):
        register(api)
        assert_error(api.patch("/users/me", json={"displayName": value}), 400, "VALIDATION_ERROR")

    def test_empty_body_is_400(self, api, register):
        register(api)
        assert_error(api.patch("/users/me", json={}), 400, "VALIDATION_ERROR")

    def test_username_is_not_patchable(self, api, register):
        reg = register(api)
        # Unknown fields alone mean there is nothing to update.
        assert_error(api.patch("/users/me", json={"username": "someone_else"}), 400, "VALIDATION_ERROR")
        assert api.get("/users/me").json()["username"] == reg["body"]["username"]

    def test_requires_auth(self, api):
        assert_error(api.patch("/users/me", json={"displayName": "A"}), 401, "UNAUTHORIZED")

    def test_reauth_window_is_401(self, api, register, db):
        reg = register(api)
        enter_reauth_window(db, reg["user"]["id"])
        assert_error(api.patch("/users/me", json={"displayName": "A"}), 401, "REAUTH_REQUIRED")


class TestSecretChange:
    def test_password_change_rotates_session(self, api, new_api, register, db):
        reg = register(api)
        username, user_id = reg["body"]["username"], reg["user"]["id"]
        other = new_api()
        assert login(other, username).status_code == 200
        api_login = login(api, username)  # this device holds the newest session
        assert api_login.status_code == 200
        old_token = raw_session_token(api)

        r = api.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD})
        assert r.status_code == 200, r.text
        new_token = raw_session_token(api)
        assert new_token != old_token
        # This device stays signed in on the new session; the old one ended.
        assert api.get("/users/me").status_code == 200
        sessions = active_sessions(db, user_id)
        assert len(sessions) == 1
        token_hash = db.execute("SELECT token_hash FROM sessions WHERE id = %s", (sessions[0][0],)).fetchone()[0]
        assert token_hash == sha256_hex(new_token)
        assert_error(other.get("/users/me"), 401, "SESSION_INVALIDATED")

        assert login(new_api(), username).status_code == 401
        assert login(new_api(), username, NEW_PASSWORD).status_code == 200
        assert user_row(db, user_id)[2] is not None

    def test_passphrase_change_requires_current_password(self, api, new_api, register, db):
        reg = register(api)
        r = api.patch("/users/me", json={"recoveryPassphrase": NEW_PASSPHRASE})
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "currentPassword" in r.json()["details"]["fields"]

        r = api.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "recoveryPassphrase": NEW_PASSPHRASE})
        assert r.status_code == 200, r.text
        assert user_row(db, reg["user"]["id"])[3] is not None
        # The new passphrase resets the password; the old one no longer does.
        reset = {"username": reg["body"]["username"], "newPassword": NEW_PASSWORD}
        assert new_api().post("/auth/reset-password", json={**reset, "recoveryPassphrase": DEFAULT_PASSPHRASE}).status_code == 401
        assert new_api().post("/auth/reset-password", json={**reset, "recoveryPassphrase": NEW_PASSPHRASE}).status_code == 204

    def test_password_without_current_password_is_400(self, api, register):
        register(api)
        r = api.patch("/users/me", json={"password": NEW_PASSWORD})
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "currentPassword" in r.json()["details"]["fields"]

    def test_wrong_current_password_is_401_and_session_kept(self, api, register, db):
        reg = register(api)
        token = raw_session_token(api)
        r = api.patch("/users/me", json={"currentPassword": "not my password", "password": NEW_PASSWORD})
        assert_error(r, 401, "INVALID_CURRENT_PASSWORD")
        # Not a session failure: the cookie is untouched and the session still works.
        assert raw_session_token(api) == token
        assert api.get("/users/me").status_code == 200
        assert user_row(db, reg["user"]["id"])[2] is None

    def test_wrong_current_password_changes_nothing_else(self, api, register, db):
        reg = register(api)
        r = api.patch(
            "/users/me",
            json={"displayName": "Changed", "currentPassword": "not my password", "password": NEW_PASSWORD},
        )
        assert_error(r, 401, "INVALID_CURRENT_PASSWORD")
        assert user_row(db, reg["user"]["id"])[0] == reg["body"]["displayName"]

    @pytest.mark.parametrize("field", ["password", "recoveryPassphrase"])
    def test_short_new_secret_is_400(self, api, register, field):
        register(api)
        r = api.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, field: "short"})
        assert_error(r, 400, "VALIDATION_ERROR")
        assert field in r.json()["details"]["fields"]

    def test_new_secrets_must_differ_from_current(self, api, register):
        register(api)
        r = api.patch(
            "/users/me",
            json={"currentPassword": DEFAULT_PASSWORD, "password": DEFAULT_PASSWORD, "recoveryPassphrase": DEFAULT_PASSPHRASE},
        )
        assert_error(r, 400, "VALIDATION_ERROR")
        assert set(r.json()["details"]["fields"]) == {"password", "recoveryPassphrase"}

    def test_passphrase_must_differ_from_password(self, api, register):
        register(api)
        # Equal to the current password...
        r = api.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "recoveryPassphrase": DEFAULT_PASSWORD})
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "recoveryPassphrase" in r.json()["details"]["fields"]
        # ...or to the new one set in the same request.
        r = api.patch(
            "/users/me",
            json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD, "recoveryPassphrase": NEW_PASSWORD},
        )
        assert_error(r, 400, "VALIDATION_ERROR")
        assert set(r.json()["details"]["fields"]) == {"recoveryPassphrase"}

    def test_old_session_gets_the_reason_and_keeps_its_cookie(self, api, new_api, register):
        register(api)
        # A request still carrying the pre-change cookie (another device, or a stale request
        # from another tab of this browser).
        stale = new_api()
        stale.cookies.set(SESSION_COOKIE, api.cookies.get(SESSION_COOKIE))
        r = api.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD})
        assert r.status_code == 200, r.text

        r = stale.get("/users/me")
        assert_error(r, 401, "SESSION_INVALIDATED")
        assert r.json()["details"] == {"reason": "credential_change"}
        # Not cleared: a stale request must not wipe a cookie the browser has just replaced.
        assert "Set-Cookie" not in r.headers

    def test_validation_errors_do_not_use_up_the_rate_limit(self, api, register):
        register(api)
        bad = {"currentPassword": DEFAULT_PASSWORD, "password": "short"}
        for _ in range(11):
            assert_error(api.patch("/users/me", json=bad), 400, "VALIDATION_ERROR")
        r = api.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD})
        assert r.status_code == 200, r.text

    def test_wrong_current_password_is_rate_limited(self, api, register):
        register(api)
        bad = {"currentPassword": "not my password", "password": NEW_PASSWORD}
        for _ in range(10):
            assert_error(api.patch("/users/me", json=bad), 401, "INVALID_CURRENT_PASSWORD")
        assert_error(api.patch("/users/me", json=bad), 429, "RATE_LIMITED")
        # Requests without currentPassword are not limited.
        assert api.patch("/users/me", json={"displayName": "Still fine"}).status_code == 200


class TestForcedCredentialChange:
    def test_full_flow(self, api, new_api, register, db):
        reg = register(api)
        username, user_id = reg["body"]["username"], reg["user"]["id"]
        simulate_admin_reset(db, user_id)

        client = new_api()
        r = login(client, username)
        assert r.status_code == 200
        assert r.json()["requiresCredentialChange"] is True
        assert_error(client.get(BLOCKED_ROUTE), 403, "CREDENTIAL_CHANGE_REQUIRED")

        # Display name alone does not clear the flag.
        r = client.patch("/users/me", json={"displayName": "Renamed"})
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is True

        # Password only: still flagged.
        r = client.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD})
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is True
        assert_error(client.get(BLOCKED_ROUTE), 403, "CREDENTIAL_CHANGE_REQUIRED")

        # Then the passphrase: flag cleared.
        r = client.patch("/users/me", json={"currentPassword": NEW_PASSWORD, "recoveryPassphrase": NEW_PASSPHRASE})
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is False
        assert user_row(db, user_id)[1] is False
        assert client.get(BLOCKED_ROUTE).status_code == 200
        assert client.get("/users/me").json()["requiresCredentialChange"] is False

    def test_both_secrets_in_one_request_clear_the_flag(self, api, new_api, register, db):
        reg = register(api)
        simulate_admin_reset(db, reg["user"]["id"])
        client = new_api()
        assert login(client, reg["body"]["username"]).status_code == 200

        r = client.patch(
            "/users/me",
            json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD, "recoveryPassphrase": NEW_PASSPHRASE},
        )
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is False
        assert client.get(BLOCKED_ROUTE).status_code == 200

    def test_passphrase_first_then_password(self, api, new_api, register, db):
        reg = register(api)
        simulate_admin_reset(db, reg["user"]["id"])
        client = new_api()
        assert login(client, reg["body"]["username"]).status_code == 200

        r = client.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "recoveryPassphrase": NEW_PASSPHRASE})
        assert r.json()["requiresCredentialChange"] is True
        r = client.patch("/users/me", json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD})
        assert r.json()["requiresCredentialChange"] is False

    def test_changes_made_before_the_reset_do_not_count(self, api, new_api, register, db):
        reg = register(api)
        user_id = reg["user"]["id"]
        # Both secrets changed once, before the reset.
        r = api.patch(
            "/users/me",
            json={"currentPassword": DEFAULT_PASSWORD, "password": NEW_PASSWORD, "recoveryPassphrase": NEW_PASSPHRASE},
        )
        assert r.status_code == 200, r.text
        simulate_admin_reset(db, user_id)

        client = new_api()
        assert login(client, reg["body"]["username"], NEW_PASSWORD).status_code == 200
        r = client.patch("/users/me", json={"currentPassword": NEW_PASSWORD, "password": "third password here"})
        assert r.json()["requiresCredentialChange"] is True
