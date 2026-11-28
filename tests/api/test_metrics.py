"""API tests for GET /api/v1/metrics (the Prometheus endpoint).

See conftest.py for required environment and server settings. The 200 case needs the server's
bearer token: PROMETHEUS_TOKEN from the environment, else from the repo-root .env, which is
where the server under test reads it in local development.
"""
import os
import re
from pathlib import Path
from typing import Optional

import pytest

from conftest import Api, unique_username


def prometheus_token() -> Optional[str]:
    token = os.environ.get("PROMETHEUS_TOKEN")
    if token:
        return token
    env_file = Path(__file__).resolve().parents[2] / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            m = re.match(r"\s*PROMETHEUS_TOKEN\s*=\s*(.*?)\s*$", line)
            if m:
                return m.group(1).strip("'\"")
    return None


def test_metrics_requires_the_bearer_token(api: Api):
    r = api.get("/metrics")
    assert r.status_code == 401, r.text
    assert r.json()["code"] == "UNAUTHORIZED"
    assert r.headers.get("WWW-Authenticate") == "Bearer"

    r = api.get("/metrics", headers={"Authorization": "Bearer not-the-token"})
    assert r.status_code == 401, r.text


def test_metrics_returns_prometheus_text_with_the_token(api: Api):
    token = prometheus_token()
    if not token:
        pytest.skip("PROMETHEUS_TOKEN is not set and no .env was found")
    # Something for the counters to have seen: a failed login.
    api.post("/auth/login", json={"username": unique_username(), "password": "not-it-at-all"})

    r = api.get("/metrics", headers={"Authorization": "Bearer " + token})
    assert r.status_code == 200, r.text
    assert r.headers["Content-Type"].startswith("text/plain")
    body = r.text
    for name in ("http_requests_total", "http_request_duration_seconds", "games_active", "db_queries_total"):
        assert "# TYPE {} ".format(name) in body
    assert re.search(r'^auth_login_failures_total\{reason="unknown_user",env="[a-z]+",version="[^"]+"\} [1-9]', body, re.M)
    assert re.search(r'^http_requests_total\{method="POST",route="/api/v1/auth/login",status_code="401"', body, re.M)
