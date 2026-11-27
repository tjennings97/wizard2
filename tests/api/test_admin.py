"""API tests for the admin routes (/api/v1/admin, docs/api/openapi-spec.md "Admin Endpoints"):
invites (auth-follow-ups §4c), roles, and the admin credential reset (§4b "Done when").

See conftest.py for required environment and server settings.
"""
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from conftest import Api, registration_body, sha256_hex
from test_auth import active_sessions, assert_error, login
from test_users import BLOCKED_ROUTE, NEW_PASSPHRASE, NEW_PASSWORD, user_row

CODE_PATTERN = re.compile(r"^([a-z2-7]{4}-){6}[a-z2-7]{2}$")
UNKNOWN_ID = "00000000-0000-4000-8000-000000000000"


def normalized(code: str) -> str:
    return code.replace("-", "").lower()


@pytest.fixture
def admin(new_api, register, db):
    """A logged-in admin: registered through the API, then promoted in the database."""
    client = new_api()
    user = register(client)["user"]
    db.execute("UPDATE users SET role = 'admin' WHERE id = %s", (user["id"],))
    user["role"] = "admin"
    client.user = user  # type: ignore[attr-defined]
    return client


@pytest.fixture
def player(new_api, register):
    client = new_api()
    reg = register(client)
    client.user = reg["user"]  # type: ignore[attr-defined]
    client.username = reg["body"]["username"]  # type: ignore[attr-defined]
    return client


def create_invite(admin_client, **body):
    r = admin_client.post("/admin/invites", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def register_with(code, cleanup, **overrides):
    """Registers a new user on a fresh client with the given invite code. Returns (response, client)."""
    client = Api()
    r = client.post("/auth/register", json=registration_body(code, **overrides))
    if r.status_code == 201:
        cleanup.user_ids.append(r.json()["id"])
    return r, client


ROUTES = [
    ("get", "/admin/invites", None),
    ("post", "/admin/invites", {}),
    ("delete", "/admin/invites/" + UNKNOWN_ID, None),
    ("get", "/admin/users", None),
    ("patch", "/admin/users/" + UNKNOWN_ID + "/role", {"role": "admin"}),
    ("post", "/admin/users/" + UNKNOWN_ID + "/reset-credentials", None),
]


class TestAccess:
    @pytest.mark.parametrize("method,path,body", ROUTES)
    def test_unauthenticated_is_401(self, api, method, path, body):
        assert_error(api.request(method, path, json=body), 401, "UNAUTHORIZED")

    @pytest.mark.parametrize("method,path,body", ROUTES)
    def test_non_admin_is_403(self, player, method, path, body):
        assert_error(player.request(method, path, json=body), 403, "FORBIDDEN")

    def test_non_admin_cannot_create_an_invite(self, player, db):
        before = db.execute("SELECT count(*) FROM invites WHERE created_by = %s", (player.user["id"],)).fetchone()[0]
        assert_error(player.post("/admin/invites", json={"label": "sneaky"}), 403, "FORBIDDEN")
        after = db.execute("SELECT count(*) FROM invites WHERE created_by = %s", (player.user["id"],)).fetchone()[0]
        assert before == after == 0

    @pytest.mark.parametrize("client", ["anonymous", "player", "admin"])
    def test_unknown_admin_path_is_a_plain_404(self, api, player, admin, client):
        c = {"anonymous": api, "player": player, "admin": admin}[client]
        assert c.get("/admin/does-not-exist").status_code == 404

    def test_role_is_read_from_the_database_on_every_request(self, admin, db):
        assert admin.get("/admin/users").status_code == 200
        db.execute("UPDATE users SET role = 'player' WHERE id = %s", (admin.user["id"],))
        assert_error(admin.get("/admin/users"), 403, "FORBIDDEN")


class TestInvites:
    def test_create_returns_the_code_once_and_stores_only_its_hash(self, admin, db):
        r = admin.post("/admin/invites", json={"label": "  For Sam  "})
        assert r.status_code == 201, r.text
        assert "no-store" in r.headers.get("Cache-Control", "")
        body = r.json()
        code, invite = body["code"], body["invite"]
        assert CODE_PATTERN.match(code), code
        assert invite["label"] == "For Sam"
        assert invite["status"] == "pending"
        assert invite["redeemedAt"] is None and invite["redeemedBy"] is None
        assert "code" not in invite

        row = db.execute(
            "SELECT code_hash, label, created_by, expires_at - created_at FROM invites WHERE id = %s", (invite["id"],)
        ).fetchone()
        assert row[0] == sha256_hex(normalized(code))
        assert code not in row and normalized(code) not in row
        assert str(row[2]) == admin.user["id"]
        assert row[3] == timedelta(days=7)

        created = datetime.fromisoformat(invite["createdAt"].replace("Z", "+00:00"))
        expires = datetime.fromisoformat(invite["expiresAt"].replace("Z", "+00:00"))
        assert expires - created == timedelta(days=7)

    def test_codes_are_unique(self, admin):
        codes = {create_invite(admin)["code"] for _ in range(5)}
        assert len(codes) == 5

    def test_create_without_a_body_or_with_a_blank_label(self, admin):
        r = admin.post("/admin/invites")
        assert r.status_code == 201, r.text
        assert r.json()["invite"]["label"] is None
        assert create_invite(admin, label="   ")["invite"]["label"] is None
        assert create_invite(admin, label=None)["invite"]["label"] is None

    @pytest.mark.parametrize("label", ["x" * 129, 5, ["a"]])
    def test_invalid_label_is_400(self, admin, label):
        assert_error(admin.post("/admin/invites", json={"label": label}), 400, "VALIDATION_ERROR")

    def test_list_shows_status_and_never_the_code(self, admin):
        created = create_invite(admin, label="listed")
        r = admin.get("/admin/invites")
        assert r.status_code == 200, r.text
        listed = {i["id"]: i for i in r.json()}
        assert listed[created["invite"]["id"]] == created["invite"]
        assert created["code"] not in r.text and normalized(created["code"]) not in r.text

    def test_list_filters_by_status(self, admin):
        pending = create_invite(admin)["invite"]["id"]
        revoked = create_invite(admin)["invite"]["id"]
        assert admin.delete("/admin/invites/" + revoked).status_code == 204

        ids = {i["id"] for i in admin.get("/admin/invites", params={"status": "revoked"}).json()}
        assert revoked in ids and pending not in ids
        listed = admin.get("/admin/invites", params={"status": "pending"}).json()
        assert all(i["status"] == "pending" for i in listed)
        assert pending in {i["id"] for i in listed}

    def test_invalid_status_filter_is_400(self, admin):
        assert_error(admin.get("/admin/invites", params={"status": "nope"}), 400, "VALIDATION_ERROR")

    def test_unredeemed_invites_past_expiry_are_marked_expired(self, admin, db):
        invite_id = create_invite(admin)["invite"]["id"]
        db.execute("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = %s", (invite_id,))
        listed = {i["id"]: i for i in admin.get("/admin/invites").json()}
        assert listed[invite_id]["status"] == "expired"
        assert db.execute("SELECT status FROM invites WHERE id = %s", (invite_id,)).fetchone()[0] == "expired"
        assert invite_id in {i["id"] for i in admin.get("/admin/invites", params={"status": "expired"}).json()}

    def test_revoke(self, admin, db, cleanup):
        created = create_invite(admin)
        invite_id = created["invite"]["id"]
        r = admin.delete("/admin/invites/" + invite_id)
        assert r.status_code == 204, r.text
        assert db.execute("SELECT status FROM invites WHERE id = %s", (invite_id,)).fetchone()[0] == "revoked"
        # A revoked code cannot be used to register.
        r, _ = register_with(created["code"], cleanup)
        assert_error(r, 422, "INVITE_INVALID")
        # Only pending invites can be revoked.
        assert_error(admin.delete("/admin/invites/" + invite_id), 400, "INVITE_NOT_REVOCABLE")

    def test_cannot_revoke_an_accepted_invite(self, admin, cleanup):
        created = create_invite(admin)
        r, _ = register_with(created["code"], cleanup)
        assert r.status_code == 201, r.text
        assert_error(admin.delete("/admin/invites/" + created["invite"]["id"]), 400, "INVITE_NOT_REVOCABLE")

    def test_cannot_revoke_an_expired_invite(self, admin, db):
        invite_id = create_invite(admin)["invite"]["id"]
        db.execute("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = %s", (invite_id,))
        assert_error(admin.delete("/admin/invites/" + invite_id), 400, "INVITE_NOT_REVOCABLE")
        assert db.execute("SELECT status FROM invites WHERE id = %s", (invite_id,)).fetchone()[0] == "expired"

    @pytest.mark.parametrize("invite_id", [UNKNOWN_ID, "not-a-uuid"])
    def test_revoke_unknown_invite_is_404(self, admin, invite_id):
        assert_error(admin.delete("/admin/invites/" + invite_id), 404, "NOT_FOUND")


class TestInviteToRegisterFlow:
    def test_admin_creates_an_invite_and_a_new_user_registers_with_it(self, admin, cleanup):
        created = create_invite(admin, label="New friend")
        r, newcomer = register_with(created["code"], cleanup)
        assert r.status_code == 201, r.text
        user = r.json()
        assert user["role"] == "player"
        # The new user is signed in.
        assert newcomer.get("/users/me").json()["id"] == user["id"]

        listed = {i["id"]: i for i in admin.get("/admin/invites").json()}
        invite = listed[created["invite"]["id"]]
        assert invite["status"] == "accepted"
        assert invite["redeemedBy"] == user["id"]
        assert invite["redeemedByUsername"] == user["username"]
        assert invite["redeemedAt"] is not None

        # The code is single-use.
        r, _ = register_with(created["code"], cleanup)
        assert_error(r, 422, "INVITE_INVALID")

    def test_invite_seeded_before_normalization_still_works(self, db, admin_id, cleanup):
        """Invites hashed exactly as written (before codes were normalized) still match."""
        code = "Legacy-INVITE-" + os.urandom(16).hex()
        row = db.execute(
            "INSERT INTO invites (code_hash, created_by, expires_at) VALUES (%s, %s, %s) RETURNING id",
            (sha256_hex(code), admin_id, datetime.now(timezone.utc) + timedelta(days=1)),
        ).fetchone()
        cleanup.invite_ids.append(str(row[0]))
        r, _ = register_with(code, cleanup)
        assert r.status_code == 201, r.text

    @pytest.mark.parametrize(
        "transform",
        [lambda c: c.upper(), lambda c: normalized(c), lambda c: " " + c.replace("-", " ") + " "],
        ids=["uppercase", "no-dashes", "spaces"],
    )
    def test_code_is_accepted_however_it_was_copied(self, admin, cleanup, transform):
        code = create_invite(admin)["code"]
        r, _ = register_with(transform(code), cleanup)
        assert r.status_code == 201, r.text


class TestUsers:
    def test_list_is_paginated(self, admin, player):
        r = admin.get("/admin/users", params={"limit": 200})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["page"] == 1 and body["limit"] == 200
        assert body["total"] >= 2
        assert len(body["data"]) == min(body["total"], 200)

        r = admin.get("/admin/users", params={"limit": 1, "page": 2}).json()
        assert r["page"] == 2 and r["limit"] == 1 and len(r["data"]) == 1

    def test_list_returns_public_user_fields_without_avatar_svg(self, admin, player):
        users = admin.get("/admin/users", params={"limit": 200}).json()["data"]
        fields = {"id", "username", "displayName", "role", "avatarConfig", "createdAt", "requiresCredentialChange"}
        assert all(set(u) == fields for u in users)

    def test_role_filter(self, admin, player):
        admins = admin.get("/admin/users", params={"role": "admin", "limit": 200}).json()["data"]
        assert all(u["role"] == "admin" for u in admins)
        assert admin.user["id"] in {u["id"] for u in admins}
        assert player.user["id"] not in {u["id"] for u in admins}

    @pytest.mark.parametrize(
        "params", [{"role": "host"}, {"limit": 201}, {"limit": 0}, {"page": 0}, {"page": "x"}, {"limit": "1.5"}]
    )
    def test_invalid_query_is_400(self, admin, params):
        assert_error(admin.get("/admin/users", params=params), 400, "VALIDATION_ERROR")


class TestRoles:
    def test_promote_a_player_to_admin(self, admin, player):
        r = admin.patch("/admin/users/{}/role".format(player.user["id"]), json={"role": "admin"})
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "admin"
        assert r.json()["id"] == player.user["id"]
        # Takes effect on the promoted user's next request, without logging in again.
        assert player.get("/admin/users").status_code == 200
        assert player.get("/users/me").json()["role"] == "admin"

    def test_admin_cannot_remove_their_own_admin_role(self, admin):
        r = admin.patch("/admin/users/{}/role".format(admin.user["id"]), json={"role": "player"})
        assert_error(r, 400, "SELF_DEMOTION_FORBIDDEN")
        assert admin.get("/users/me").json()["role"] == "admin"

    def test_setting_own_role_to_admin_is_a_no_op(self, admin):
        r = admin.patch("/admin/users/{}/role".format(admin.user["id"].upper()), json={"role": "admin"})
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "admin"

    def test_another_admin_can_demote_an_admin(self, admin, player):
        path = "/admin/users/{}/role".format(player.user["id"])
        assert admin.patch(path, json={"role": "admin"}).status_code == 200
        r = admin.patch(path, json={"role": "player"})
        assert r.status_code == 200, r.text
        assert r.json()["role"] == "player"
        assert_error(player.get("/admin/users"), 403, "FORBIDDEN")

    def test_demoted_admin_cannot_demote_back(self, admin, player):
        """The second of two admins demoting each other is no longer an admin, so it fails."""
        assert admin.patch("/admin/users/{}/role".format(player.user["id"]), json={"role": "admin"}).status_code == 200
        assert player.patch("/admin/users/{}/role".format(admin.user["id"]), json={"role": "player"}).status_code == 200
        r = admin.patch("/admin/users/{}/role".format(player.user["id"]), json={"role": "player"})
        assert_error(r, 403, "FORBIDDEN")

    @pytest.mark.parametrize("body", [{"role": "host"}, {}, {"role": None}])
    def test_invalid_role_is_400(self, admin, player, body):
        r = admin.patch("/admin/users/{}/role".format(player.user["id"]), json=body)
        assert_error(r, 400, "VALIDATION_ERROR")

    @pytest.mark.parametrize("user_id", [UNKNOWN_ID, "not-a-uuid"])
    def test_unknown_user_is_404(self, admin, user_id):
        assert_error(admin.patch("/admin/users/{}/role".format(user_id), json={"role": "admin"}), 404, "NOT_FOUND")


class TestCredentialReset:
    def reset(self, admin, user_id):
        r = admin.post("/admin/users/{}/reset-credentials".format(user_id))
        assert r.status_code == 200, r.text
        assert "no-store" in r.headers.get("Cache-Control", "")
        return r.json()

    def test_full_flow(self, admin, player, new_api, db):
        """auth-follow-ups §4b "Done when", through the real endpoint."""
        user_id, username = player.user["id"], player.username
        creds = self.reset(admin, user_id)
        temp_password, temp_passphrase = creds["temporaryPassword"], creds["temporaryPassphrase"]
        assert temp_password != temp_passphrase
        assert isinstance(creds["note"], str) and creds["note"]

        # Stored hashed only; flag set; both change timestamps cleared.
        hashes = db.execute("SELECT password_hash, recovery_hash FROM users WHERE id = %s", (user_id,)).fetchone()
        assert all(h.startswith("$2b$12$") for h in hashes)
        assert temp_password not in hashes and temp_passphrase not in hashes
        assert user_row(db, user_id)[1:] == (True, None, None)

        # Every session ended (invalidateUserSessions); the old device is told why.
        assert active_sessions(db, user_id) == []
        r = player.get("/users/me")
        assert_error(r, 401, "SESSION_INVALIDATED")
        assert r.json()["details"]["reason"] == "admin_reset"

        # The old password no longer works; the temporary one does, and is flagged.
        assert_error(login(new_api(), username), 401, "INVALID_CREDENTIALS")
        client = new_api()
        r = login(client, username, temp_password)
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is True
        assert_error(client.get(BLOCKED_ROUTE), 403, "CREDENTIAL_CHANGE_REQUIRED")

        # Password only: still flagged.
        r = client.patch("/users/me", json={"currentPassword": temp_password, "password": NEW_PASSWORD})
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is True
        assert_error(client.get(BLOCKED_ROUTE), 403, "CREDENTIAL_CHANGE_REQUIRED")

        # Then the passphrase: flag cleared and the blocked route works.
        r = client.patch("/users/me", json={"currentPassword": NEW_PASSWORD, "recoveryPassphrase": NEW_PASSPHRASE})
        assert r.status_code == 200, r.text
        assert r.json()["requiresCredentialChange"] is False
        assert user_row(db, user_id)[1] is False
        assert client.get(BLOCKED_ROUTE).status_code == 200

    def test_temporary_passphrase_cannot_be_kept(self, admin, player, new_api):
        creds = self.reset(admin, player.user["id"])
        client = new_api()
        assert login(client, player.username, creds["temporaryPassword"]).status_code == 200
        r = client.patch(
            "/users/me",
            json={"currentPassword": creds["temporaryPassword"], "recoveryPassphrase": creds["temporaryPassphrase"]},
        )
        assert_error(r, 400, "VALIDATION_ERROR")

    def test_each_reset_issues_new_credentials(self, admin, player):
        first = self.reset(admin, player.user["id"])
        second = self.reset(admin, player.user["id"])
        assert first["temporaryPassword"] != second["temporaryPassword"]
        assert login(Api(), player.username, first["temporaryPassword"]).status_code == 401
        assert login(Api(), player.username, second["temporaryPassword"]).status_code == 200

    def test_admin_keeps_their_session(self, admin, player):
        self.reset(admin, player.user["id"])
        assert admin.get("/admin/users").status_code == 200

    @pytest.mark.parametrize("user_id", [UNKNOWN_ID, "not-a-uuid"])
    def test_unknown_user_is_404(self, admin, user_id):
        assert_error(admin.post("/admin/users/{}/reset-credentials".format(user_id)), 404, "NOT_FOUND")

    def test_self_reset_is_refused(self, admin, db):
        r = admin.post("/admin/users/{}/reset-credentials".format(admin.user["id"].upper()))
        assert_error(r, 400, "SELF_RESET_FORBIDDEN")
        assert user_row(db, admin.user["id"])[1] is False
        assert admin.get("/admin/users").status_code == 200

    def test_admin_demoted_mid_request_cannot_reset(self, admin, player, db):
        """The actor is re-checked under a row lock, after the bcrypt work.

        A second connection holds a lock on the admin's row, so the reset blocks inside its
        transaction; the admin is demoted and the lock released; the reset must then fail.
        """
        path = "/admin/users/{}/reset-credentials".format(player.user["id"])
        with psycopg.connect(os.environ["DATABASE_URL"]) as locker:
            locker.execute("SELECT 1 FROM users WHERE id = %s FOR UPDATE", (admin.user["id"],))
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(admin.post, path)
                wait_for_lock_waiter(db, pending)
                locker.execute("UPDATE users SET role = 'player' WHERE id = %s", (admin.user["id"],))
                locker.commit()
                r = pending.result(timeout=15)
        assert_error(r, 403, "FORBIDDEN")
        # Nothing about the target changed and they are still signed in.
        assert user_row(db, player.user["id"])[1] is False
        assert player.get("/users/me").status_code == 200


def wait_for_lock_waiter(db, pending, timeout=10.0):
    """Waits until some backend is blocked on a row lock in a FOR UPDATE (the request under test)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        assert not pending.done(), "request finished without waiting on the lock: " + pending.result().text
        waiting = db.execute(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE wait_event_type = 'Lock' AND query ILIKE '%%for update%%' AND datname = current_database()"
        ).fetchone()[0]
        if waiting:
            return
        time.sleep(0.05)
    raise AssertionError("the request never waited on the row lock")
