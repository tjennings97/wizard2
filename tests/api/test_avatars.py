"""API tests for avatars (docs/architecture/avatar-system.md; auth-follow-ups §8 "Done when").

avatarConfig is four slugs from the catalog in server/src/shared/avatar.ts. The server never
accepts, stores or returns client SVG: avatarSvg is not part of the API, and the column is gone.

See conftest.py for required environment and server settings.
"""
import pytest

from conftest import AVATAR, registration_body
from test_auth import assert_error

MARKUP = "<svg xmlns='http://www.w3.org/2000/svg'><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>"
OTHER_AVATAR = {"head": "head-04", "skin": "skin-06", "face": "face-06", "hair": "hair-08"}

# Each is a whole avatarConfig the server must reject with 400 VALIDATION_ERROR.
INVALID_CONFIGS = [
    ({**AVATAR, "face": "../x"}, "path"),
    ({**AVATAR, "hair": "<svg>"}, "markup"),
    ({**AVATAR, "head": "Round"}, "old_style_slug"),
    ({**AVATAR, "head": "hair-01"}, "slug_under_wrong_key"),
    ({**AVATAR, "head": "head-05"}, "out_of_range"),
    ({**AVATAR, "skin": 4}, "number"),
    ({"head": "head-01", "skin": "skin-01", "face": "face-01"}, "missing_key"),
    ({**AVATAR, "hat": "hat-01"}, "extra_key"),
    ("head-01", "string"),
    (None, "null"),
]


def stored_config(db, user_id):
    return db.execute("SELECT avatar_config FROM users WHERE id = %s", (user_id,)).fetchone()[0]


class TestSchema:
    def test_avatar_svg_column_is_gone_and_config_is_required(self, db):
        columns = dict(
            db.execute(
                "SELECT column_name, is_nullable FROM information_schema.columns "
                "WHERE table_name = 'users' AND column_name IN ('avatar_svg', 'avatar_config')"
            ).fetchall()
        )
        assert columns == {"avatar_config": "NO"}


class TestRegister:
    def test_stores_and_returns_the_config(self, api, register, db):
        reg = register(api, avatarConfig=dict(OTHER_AVATAR))
        assert reg["user"]["avatarConfig"] == OTHER_AVATAR
        assert stored_config(db, reg["user"]["id"]) == OTHER_AVATAR
        assert api.get("/users/me").json()["avatarConfig"] == OTHER_AVATAR

    def test_markup_in_avatar_svg_is_never_stored_or_returned(self, api, register, db):
        reg = register(api, avatarSvg=MARKUP)
        assert "avatarSvg" not in reg["user"]
        me = api.get("/users/me")
        assert "avatarSvg" not in me.json()
        assert MARKUP not in me.text
        row = db.execute("SELECT to_jsonb(u)::text FROM users u WHERE id = %s", (reg["user"]["id"],)).fetchone()[0]
        assert "foreignObject" not in row

    def test_missing_avatar_config_is_400(self, api, make_invite, db):
        body = registration_body(make_invite())
        del body["avatarConfig"]
        r = api.post("/auth/register", json=body)
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "avatarConfig" in r.json()["details"]["fields"]
        assert db.execute("SELECT 1 FROM users WHERE username = %s", (body["username"],)).fetchone() is None

    @pytest.mark.parametrize("config", [c for c, _ in INVALID_CONFIGS], ids=[i for _, i in INVALID_CONFIGS])
    def test_invalid_config_is_400(self, api, make_invite, db, config):
        body = registration_body(make_invite(), avatarConfig=config)
        r = api.post("/auth/register", json=body)
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "avatarConfig" in r.json()["details"]["fields"]
        assert db.execute("SELECT 1 FROM users WHERE username = %s", (body["username"],)).fetchone() is None


class TestPatchMe:
    def test_round_trips_a_valid_config(self, api, register, db):
        reg = register(api)
        r = api.patch("/users/me", json={"avatarConfig": OTHER_AVATAR})
        assert r.status_code == 200, r.text
        assert r.json()["avatarConfig"] == OTHER_AVATAR
        assert "Set-Cookie" not in r.headers
        assert api.get("/users/me").json()["avatarConfig"] == OTHER_AVATAR
        assert stored_config(db, reg["user"]["id"]) == OTHER_AVATAR

    def test_is_idempotent(self, api, register):
        register(api)
        first = api.patch("/users/me", json={"avatarConfig": OTHER_AVATAR})
        second = api.patch("/users/me", json={"avatarConfig": OTHER_AVATAR})
        assert first.status_code == second.status_code == 200
        assert first.json() == second.json()

    def test_with_display_name_in_one_request(self, api, register):
        register(api)
        r = api.patch("/users/me", json={"displayName": "Both", "avatarConfig": OTHER_AVATAR})
        assert r.status_code == 200, r.text
        assert r.json()["displayName"] == "Both"
        assert r.json()["avatarConfig"] == OTHER_AVATAR

    @pytest.mark.parametrize("config", [c for c, _ in INVALID_CONFIGS], ids=[i for _, i in INVALID_CONFIGS])
    def test_invalid_config_is_400_and_nothing_changes(self, api, register, db, config):
        reg = register(api)
        r = api.patch("/users/me", json={"displayName": "Changed", "avatarConfig": config})
        assert_error(r, 400, "VALIDATION_ERROR")
        assert "avatarConfig" in r.json()["details"]["fields"]
        assert stored_config(db, reg["user"]["id"]) == AVATAR
        assert api.get("/users/me").json()["displayName"] == reg["body"]["displayName"]

    def test_avatar_svg_alone_is_nothing_to_update(self, api, register):
        register(api)
        assert_error(api.patch("/users/me", json={"avatarSvg": MARKUP}), 400, "VALIDATION_ERROR")

    def test_avatar_svg_is_ignored_next_to_a_real_change(self, api, register, db):
        reg = register(api)
        r = api.patch("/users/me", json={"avatarConfig": OTHER_AVATAR, "avatarSvg": MARKUP})
        assert r.status_code == 200, r.text
        assert "avatarSvg" not in r.json()
        assert MARKUP not in api.get("/users/me").text
        row = db.execute("SELECT to_jsonb(u)::text FROM users u WHERE id = %s", (reg["user"]["id"],)).fetchone()[0]
        assert "foreignObject" not in row
