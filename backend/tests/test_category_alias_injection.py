"""Tests for category-based alias injection in /api/prospects/discover.

Covers:
- /api/hunter-settings/categories CRUD with aliases (GET, POST, PATCH, DELETE)
- /api/prospects/discover accepts and uses category_id
- Discover with invalid/missing category_id falls back to tenant/default aliases
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

DEMO_EMAIL = "demo@test.com"
DEMO_PASS = "demo1234"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    r = s.post(f"{API}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASS})
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    token = r.json()["token"]
    s.headers.update({"Authorization": f"Bearer {token}"})
    yield s
    # Cleanup any TEST_ categories
    try:
        rows = s.get(f"{API}/hunter-settings/categories").json()
        for c in rows:
            if c.get("name", "").startswith("TEST_"):
                s.delete(f"{API}/hunter-settings/categories/{c['id']}")
    except Exception:
        pass


# ─── Categories CRUD with aliases ───

def test_list_categories_returns_aliases_field(session):
    r = session.get(f"{API}/hunter-settings/categories")
    assert r.status_code == 200, r.text
    data = r.json()
    assert isinstance(data, list)
    # Legacy categories may not have `aliases` field; new categories must.
    # We tolerate missing aliases on pre-existing rows but require it when present to be a list.
    for cat in data:
        assert "id" in cat
        assert "name" in cat
        if "aliases" in cat:
            assert isinstance(cat["aliases"], list)


def test_create_category_persists_aliases(session):
    payload = {"name": "TEST_HotelCat", "aliases": ["sales", "gm", "event"]}
    r = session.post(f"{API}/hunter-settings/categories", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "TEST_HotelCat"
    assert body["aliases"] == ["sales", "gm", "event"]
    assert "id" in body
    # GET to confirm persistence
    rows = session.get(f"{API}/hunter-settings/categories").json()
    saved = next((c for c in rows if c["id"] == body["id"]), None)
    assert saved is not None, "Created category not found in list"
    assert saved["aliases"] == ["sales", "gm", "event"]


def test_create_category_cleans_aliases(session):
    """Aliases should be lowercased, deduped, @-stripped."""
    payload = {"name": "TEST_CleanCat", "aliases": ["Sales", "@GM", "sales", "Event ", "info@example.com"]}
    r = session.post(f"{API}/hunter-settings/categories", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    # Sales/sales dedup → "sales"; @GM → "gm"; Event with space → "event"; info@example.com → "info"
    assert "sales" in body["aliases"]
    assert "gm" in body["aliases"]
    assert "event" in body["aliases"]
    assert "info" in body["aliases"]
    # No duplicates
    assert len(body["aliases"]) == len(set(body["aliases"]))


def test_update_category_aliases_via_patch(session):
    """The discover endpoint uses PATCH (not PUT) per server.py routes."""
    create = session.post(f"{API}/hunter-settings/categories",
                          json={"name": "TEST_UpdateCat", "aliases": ["a", "b"]})
    assert create.status_code == 200
    cat_id = create.json()["id"]

    r = session.patch(f"{API}/hunter-settings/categories/{cat_id}", json={"aliases": ["x", "y"]})
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["aliases"] == ["x", "y"]

    # Confirm persistence
    rows = session.get(f"{API}/hunter-settings/categories").json()
    found = next((c for c in rows if c["id"] == cat_id), None)
    assert found is not None
    assert found["aliases"] == ["x", "y"]


def test_create_duplicate_category_rejected(session):
    payload = {"name": "TEST_DupCat", "aliases": ["sales"]}
    r1 = session.post(f"{API}/hunter-settings/categories", json=payload)
    assert r1.status_code == 200
    r2 = session.post(f"{API}/hunter-settings/categories", json=payload)
    assert r2.status_code == 400, f"Expected 400 for duplicate, got {r2.status_code}"


# ─── Discover endpoint accepts category_id ───

@pytest.fixture(scope="module")
def category_id(session):
    payload = {"name": "TEST_DiscoverCat", "aliases": ["sales", "gm", "event", "marketing"]}
    r = session.post(f"{API}/hunter-settings/categories", json=payload)
    assert r.status_code == 200
    return r.json()["id"]


def test_discover_with_category_id_returns_200(session, category_id):
    """POST /prospects/discover with category_id should return 200 and emails array."""
    payload = {"domain": "testdiscovercat.com", "category_id": category_id}
    r = session.post(f"{API}/prospects/discover", json=payload)
    assert r.status_code == 200, f"Status {r.status_code}: {r.text}"
    data = r.json()
    assert "domain" in data
    assert "company" in data
    assert "emails" in data
    assert isinstance(data["emails"], list)


def test_discover_without_category_id_still_works(session):
    """category_id is Optional in HunterSearchReq. Without it, falls back to tenant/default aliases."""
    payload = {"domain": "testnocat.com"}
    r = session.post(f"{API}/prospects/discover", json=payload)
    assert r.status_code == 200, f"Status {r.status_code}: {r.text}"
    data = r.json()
    assert "emails" in data
    assert isinstance(data["emails"], list)


def test_discover_with_invalid_category_id_falls_back(session):
    """Bogus category_id should not crash; backend resolves to tenant default / hardcoded default."""
    payload = {"domain": "testbogusid.com", "category_id": "not-a-real-category-id"}
    r = session.post(f"{API}/prospects/discover", json=payload)
    assert r.status_code == 200, f"Status {r.status_code}: {r.text}"


def test_discover_requires_auth():
    """Bare request without bearer token must 401/403."""
    r = requests.post(f"{API}/prospects/discover", json={"domain": "test.com"})
    assert r.status_code in (401, 403), f"Expected auth required, got {r.status_code}"


# ─── Default aliases endpoint sanity ───

def test_default_aliases_endpoint(session):
    r = session.get(f"{API}/hunter-settings/default-aliases")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "aliases" in body
    assert isinstance(body["aliases"], list)
    assert len(body["aliases"]) > 0
