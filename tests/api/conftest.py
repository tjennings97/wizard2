"""Shared fixtures for the REST API tests (pytest + requests).

The tests talk to a running server over HTTP and seed or inspect rows directly in the same
Postgres database the server uses (seeding is faster than the admin API, and some cases need
expired or invalidated rows).

Required environment:
  DATABASE_URL       the database the server under test is connected to
  API_BASE_URL       optional, defaults to http://127.0.0.1:3000/api/v1

The server under test must be started with TRUST_PROXY_HOPS=1. Every test sends its own random
X-Forwarded-For address so that each test gets a fresh per-IP rate-limit bucket, which lets the
suite exercise the real production limits (5 registrations per hour per IP, etc.).

Python 3.8 compatible.
"""
import hashlib
import os
import random
import uuid
from datetime import datetime, timedelta, timezone
from typing import Callable, Dict, Iterator, List, Optional
from urllib.parse import unquote

import psycopg
import pytest
import requests

BASE_URL = os.environ.get("API_BASE_URL", "http://127.0.0.1:3000/api/v1").rstrip("/")
SESSION_COOKIE = "wizard_session"
DEFAULT_PASSWORD = "correct horse battery"
DEFAULT_PASSPHRASE = "purple monkey dishwasher"
AVATAR = {"head": "round", "skin": "medium", "face": "smile-01", "hair": "curly-short-brown"}


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def raw_session_token(api: requests.Session) -> str:
    """The raw token inside the signed cookie (`s:<token>.<signature>`, URL-encoded)."""
    value = unquote(api.cookies.get(SESSION_COOKIE))
    assert value.startswith("s:"), "session cookie should be signed"
    return value[2:].rsplit(".", 1)[0]


def unique_username(prefix: str = "t") -> str:
    return "{}_{}".format(prefix, uuid.uuid4().hex[:12])


def random_ip() -> str:
    # 198.18.0.0/15 is reserved for benchmarking, so it never collides with a real client.
    return "198.{}.{}.{}".format(random.randint(18, 19), random.randint(0, 255), random.randint(1, 254))


class Api(requests.Session):
    """requests.Session bound to BASE_URL with a fixed client IP."""

    def __init__(self, ip: Optional[str] = None) -> None:
        super().__init__()
        self.headers["X-Forwarded-For"] = ip or random_ip()

    def request(self, method, url, *args, **kwargs):  # type: ignore[override]
        if url.startswith("/"):
            url = BASE_URL + url
        kwargs.setdefault("timeout", 15)
        return super().request(method, url, *args, **kwargs)


@pytest.fixture(scope="session")
def db() -> Iterator[psycopg.Connection]:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.exit("DATABASE_URL must be set to the database used by the server under test", 2)
    with psycopg.connect(url, autocommit=True) as conn:
        yield conn


@pytest.fixture(scope="session", autouse=True)
def server_up() -> None:
    try:
        requests.get(BASE_URL + "/health", timeout=5).raise_for_status()
    except requests.RequestException as exc:
        pytest.exit("API server not reachable at {}: {}".format(BASE_URL, exc), 2)


class Cleanup:
    """Records rows created by tests and deletes them (in FK order) when the session ends."""

    def __init__(self) -> None:
        self.user_ids: List[str] = []
        self.invite_ids: List[str] = []
        self.room_ids: List[str] = []
        self.game_ids: List[str] = []


@pytest.fixture(scope="session")
def cleanup(db: psycopg.Connection) -> Iterator[Cleanup]:
    c = Cleanup()
    yield c
    users = c.user_ids
    # Games started through the API belong to a recorded room; their event log goes first.
    # (game_events is append-only for the app; test cleanup is the exception.)
    games = "SELECT id FROM games WHERE id = ANY(%s::uuid[]) OR room_id = ANY(%s::uuid[])"
    db.execute("DELETE FROM game_events WHERE game_id IN ({})".format(games), (c.game_ids, c.room_ids))
    # A game that ended (or was dropped) has results and scored rounds.
    db.execute("DELETE FROM game_results WHERE game_id IN ({})".format(games), (c.game_ids, c.room_ids))
    db.execute(
        "DELETE FROM round_players WHERE round_id IN (SELECT id FROM rounds WHERE game_id IN ({}))".format(games),
        (c.game_ids, c.room_ids),
    )
    db.execute("DELETE FROM rounds WHERE game_id IN ({})".format(games), (c.game_ids, c.room_ids))
    db.execute("DELETE FROM games WHERE id = ANY(%s::uuid[]) OR room_id = ANY(%s::uuid[])", (c.game_ids, c.room_ids))
    db.execute("DELETE FROM room_members WHERE room_id = ANY(%s::uuid[])", (c.room_ids,))
    db.execute("DELETE FROM rooms WHERE id = ANY(%s::uuid[])", (c.room_ids,))
    db.execute("DELETE FROM invites WHERE id = ANY(%s::uuid[])", (c.invite_ids,))
    db.execute(
        "DELETE FROM invites WHERE created_by = ANY(%s::uuid[]) OR redeemed_by = ANY(%s::uuid[])",
        (users, users),
    )
    db.execute("DELETE FROM sessions WHERE user_id = ANY(%s::uuid[])", (users,))
    db.execute("DELETE FROM users WHERE id = ANY(%s::uuid[])", (users,))


@pytest.fixture(scope="session")
def admin_id(db: psycopg.Connection, cleanup: Cleanup) -> str:
    """An admin user to own seeded invites. Cannot log in (its hash matches nothing)."""
    row = db.execute(
        "INSERT INTO users (username, display_name, password_hash, recovery_hash, role) "
        "VALUES (%s, 'Test Admin', '!', '!', 'admin') RETURNING id",
        (unique_username("admin"),),
    ).fetchone()
    cleanup.user_ids.append(str(row[0]))
    return str(row[0])


@pytest.fixture
def make_invite(db: psycopg.Connection, admin_id: str, cleanup: Cleanup) -> Callable[..., str]:
    """Insert an invite and return its raw code. Only the SHA-256 digest is stored."""

    def _make(expires_in: timedelta = timedelta(days=7), status: str = "pending", redeemed: bool = False) -> str:
        code = uuid.uuid4().hex + uuid.uuid4().hex  # 256 bits
        row = db.execute(
            "INSERT INTO invites (code_hash, created_by, expires_at, status, redeemed_at) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (
                sha256_hex(code),
                admin_id,
                datetime.now(timezone.utc) + expires_in,
                status,
                datetime.now(timezone.utc) if redeemed else None,
            ),
        ).fetchone()
        cleanup.invite_ids.append(str(row[0]))
        return code

    return _make


@pytest.fixture
def put_in_game(db: psycopg.Connection, cleanup: Cleanup) -> Callable[..., str]:
    """Seat a user in a room with a game. Returns the game id."""

    def _put(user_id: str, role: str = "player", status: str = "in_progress", left: bool = False) -> str:
        room_id = db.execute(
            "INSERT INTO rooms (state, host_user_id) VALUES ('in_progress', %s) RETURNING id", (user_id,)
        ).fetchone()[0]
        cleanup.room_ids.append(str(room_id))
        db.execute(
            "INSERT INTO room_members (room_id, user_id, role, join_order, left_at) "
            "VALUES (%s, %s, %s, 1, CASE WHEN %s THEN now() END)",
            (room_id, user_id, role, left),
        )
        game_id = db.execute(
            "INSERT INTO games (room_id, status) VALUES (%s, %s) RETURNING id", (room_id, status)
        ).fetchone()[0]
        cleanup.game_ids.append(str(game_id))
        return str(game_id)

    return _put


@pytest.fixture
def api() -> Api:
    """A fresh client with its own IP (and so its own rate-limit buckets)."""
    return Api()


@pytest.fixture
def new_api() -> Callable[[], Api]:
    """Factory for extra clients, e.g. a second device for the same user."""
    return Api


def registration_body(invite_code: str, **overrides) -> Dict:
    body = {
        "inviteCode": invite_code,
        "username": unique_username(),
        "displayName": "Test Player",
        "password": DEFAULT_PASSWORD,
        "recoveryPassphrase": DEFAULT_PASSPHRASE,
        "avatarConfig": dict(AVATAR),
        "avatarSvg": "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    }
    body.update(overrides)
    return body


@pytest.fixture
def register(make_invite, cleanup: Cleanup) -> Callable[..., Dict]:
    """Register a user through the API on the given client. Returns the request body + response user."""

    def _register(client: Api, **overrides) -> Dict:
        body = registration_body(make_invite(), **overrides)
        r = client.post("/auth/register", json=body)
        assert r.status_code == 201, r.text
        user = r.json()
        cleanup.user_ids.append(user["id"])
        return {"body": body, "user": user}

    return _register
