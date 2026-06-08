"""Backend tests for Inbox Module Phase 2 (IMAP/SMTP integration).

Covers:
- GET /api/inbox/companies (filtering by imap_host presence)
- GET /api/inbox/{sc_id} (folder validation, default limit=20, 400/403/404)
- GET /api/inbox/{sc_id}/message/{uid} (folder validation, 400/404)
- POST /api/inbox/{sc_id}/mark (folder validation, 400/403)
- POST /api/inbox/{sc_id}/reply (validation: SMTP/IMAP unconfigured -> 400; Pydantic)
- Permission catalog: 'inbox' present in Owner/Admin/Staff
- Regression: /api/auth/login, /api/sub-companies, /api/sub-companies/{id}/test-imap, /api/prospects
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
API = f"{BASE_URL}/api"

OWNER_EMAIL = "demo@test.com"
OWNER_PW = "demo1234"
STAFF_EMAIL = "milla.staff@test.com"
STAFF_PW = "staff1234"


# ─── Fixtures ───────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def owner_token():
    r = requests.post(f"{API}/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PW}, timeout=30)
    assert r.status_code == 200, f"Owner login failed: {r.status_code} {r.text}"
    return r.json()["token"]


@pytest.fixture(scope="module")
def staff_token():
    r = requests.post(f"{API}/auth/login", json={"email": STAFF_EMAIL, "password": STAFF_PW}, timeout=30)
    if r.status_code != 200:
        pytest.skip(f"Staff login failed ({r.status_code}); skipping staff-scoped tests")
    return r.json()["token"]


@pytest.fixture(scope="module")
def owner_headers(owner_token):
    return {"Authorization": f"Bearer {owner_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def staff_headers(staff_token):
    return {"Authorization": f"Bearer {staff_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def sc_with_imap(owner_headers):
    """Create a sub-company with IMAP creds (dummy host)."""
    name = f"TEST_inbox_imap_{uuid.uuid4().hex[:6]}"
    payload = {
        "name": name,
        "imap_host": "imap.dummy.test",
        "imap_user": "test@dummy.test",
        "imap_password": "x",
        "imap_port": 993,
        "imap_ssl": True,
    }
    r = requests.post(f"{API}/sub-companies", json=payload, headers=owner_headers, timeout=30)
    assert r.status_code in (200, 201), f"Create sc_with_imap failed: {r.status_code} {r.text}"
    sc = r.json()
    yield sc
    # cleanup
    requests.delete(f"{API}/sub-companies/{sc['id']}", headers=owner_headers, timeout=15)


@pytest.fixture(scope="module")
def sc_without_imap(owner_headers):
    name = f"TEST_inbox_noimap_{uuid.uuid4().hex[:6]}"
    r = requests.post(f"{API}/sub-companies", json={"name": name}, headers=owner_headers, timeout=30)
    assert r.status_code in (200, 201), f"Create sc_without_imap failed: {r.status_code} {r.text}"
    sc = r.json()
    yield sc
    requests.delete(f"{API}/sub-companies/{sc['id']}", headers=owner_headers, timeout=15)


# ─── Permission catalog ────────────────────────────────────────────────────
class TestPermissionCatalog:
    def test_roles_include_inbox(self, owner_headers):
        r = requests.get(f"{API}/roles", headers=owner_headers, timeout=15)
        assert r.status_code == 200, r.text
        roles = r.json()
        assert isinstance(roles, list) and len(roles) >= 3
        by_name = {role["name"]: role for role in roles}
        for rolename in ("Owner", "Admin", "Staff"):
            assert rolename in by_name, f"Missing role: {rolename}"
            assert "inbox" in by_name[rolename]["permissions"], f"{rolename} missing inbox perm"

    def test_auth_me_owner_has_inbox(self, owner_headers):
        r = requests.get(f"{API}/auth/me", headers=owner_headers, timeout=15)
        assert r.status_code == 200, r.text
        me = r.json()
        # Owner has all perms
        perms = me.get("permissions") or []
        assert "inbox" in perms


# ─── GET /api/inbox/companies ──────────────────────────────────────────────
class TestInboxCompanies:
    def test_only_imap_configured_companies_returned(self, owner_headers, sc_with_imap, sc_without_imap):
        r = requests.get(f"{API}/inbox/companies", headers=owner_headers, timeout=15)
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        ids = {row["id"] for row in rows}
        assert sc_with_imap["id"] in ids, "sc_with_imap must appear"
        assert sc_without_imap["id"] not in ids, "sc_without_imap must NOT appear"
        # response shape
        for row in rows:
            assert "id" in row and "name" in row and "imap_host" in row

    def test_requires_auth(self):
        r = requests.get(f"{API}/inbox/companies", timeout=15)
        assert r.status_code in (401, 403)


# ─── GET /api/inbox/{sc_id} ────────────────────────────────────────────────
class TestInboxList:
    def test_404_when_sc_missing(self, owner_headers):
        r = requests.get(f"{API}/inbox/does-not-exist", headers=owner_headers, timeout=15)
        assert r.status_code == 404

    def test_400_invalid_folder(self, owner_headers, sc_with_imap):
        r = requests.get(f"{API}/inbox/{sc_with_imap['id']}?folder=Spam", headers=owner_headers, timeout=15)
        assert r.status_code == 400
        assert "folder" in r.text.lower()

    def test_400_when_imap_not_configured(self, owner_headers, sc_without_imap):
        r = requests.get(f"{API}/inbox/{sc_without_imap['id']}?folder=INBOX", headers=owner_headers, timeout=15)
        assert r.status_code == 400
        assert "IMAP" in r.text

    def test_accepts_all_three_folders(self, owner_headers, sc_with_imap):
        # IMAP will fail at network/auth level (dummy host) → expect 400 with "IMAP error:"
        # NOT a 400 for invalid folder. Distinguish by message content.
        for folder in ("INBOX", "Sent", "Trash"):
            r = requests.get(
                f"{API}/inbox/{sc_with_imap['id']}?folder={folder}",
                headers=owner_headers, timeout=40,
            )
            # Either succeeds (unlikely) or fails with IMAP network error (400 "IMAP error: ...")
            assert r.status_code in (200, 400), f"{folder}: {r.status_code} {r.text}"
            if r.status_code == 400:
                body = r.text
                assert "IMAP error" in body or "IMAP" in body
                assert "folder harus" not in body, "Should not be folder-validation error"

    def test_403_when_staff_not_owning_subcompany(self, staff_headers, sc_with_imap):
        # Staff has no assigned sub_company_ids by default → should get 403
        r = requests.get(
            f"{API}/inbox/{sc_with_imap['id']}?folder=INBOX",
            headers=staff_headers, timeout=15,
        )
        # Staff with no assignment → access denied (403)
        # If staff happened to be assigned, would be 400 IMAP error
        assert r.status_code in (403, 400), r.text
        if r.status_code == 403:
            assert "akses" in r.text.lower() or "inbox" in r.text.lower()


# ─── GET /api/inbox/{sc_id}/message/{uid} ──────────────────────────────────
class TestInboxMessageDetail:
    def test_404_when_sc_missing(self, owner_headers):
        r = requests.get(f"{API}/inbox/does-not-exist/message/1?folder=INBOX", headers=owner_headers, timeout=15)
        assert r.status_code == 404

    def test_400_invalid_folder(self, owner_headers, sc_with_imap):
        r = requests.get(
            f"{API}/inbox/{sc_with_imap['id']}/message/1?folder=Drafts",
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 400
        assert "folder" in r.text.lower()

    def test_400_when_imap_not_configured(self, owner_headers, sc_without_imap):
        r = requests.get(
            f"{API}/inbox/{sc_without_imap['id']}/message/1?folder=INBOX",
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 400
        assert "IMAP" in r.text


# ─── POST /api/inbox/{sc_id}/mark ──────────────────────────────────────────
class TestInboxMark:
    def test_400_invalid_folder(self, owner_headers, sc_with_imap):
        r = requests.post(
            f"{API}/inbox/{sc_with_imap['id']}/mark",
            json={"uid": "1", "folder": "Junk", "seen": True},
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 400
        assert "folder" in r.text.lower()

    def test_400_when_imap_not_configured(self, owner_headers, sc_without_imap):
        r = requests.post(
            f"{API}/inbox/{sc_without_imap['id']}/mark",
            json={"uid": "1", "folder": "INBOX", "seen": True},
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 400
        assert "IMAP" in r.text

    def test_403_when_staff_not_owning_subcompany(self, staff_headers, sc_with_imap):
        r = requests.post(
            f"{API}/inbox/{sc_with_imap['id']}/mark",
            json={"uid": "1", "folder": "INBOX", "seen": True},
            headers=staff_headers, timeout=15,
        )
        assert r.status_code in (403, 400)


# ─── POST /api/inbox/{sc_id}/reply ─────────────────────────────────────────
class TestInboxReply:
    def test_pydantic_rejects_missing_required(self, owner_headers, sc_with_imap):
        r = requests.post(
            f"{API}/inbox/{sc_with_imap['id']}/reply",
            json={"uid": "1"},  # missing to, subject, body_html
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 422

    def test_pydantic_rejects_bad_email(self, owner_headers, sc_with_imap):
        r = requests.post(
            f"{API}/inbox/{sc_with_imap['id']}/reply",
            json={"uid": "1", "folder": "INBOX", "to": "not-an-email",
                  "subject": "Re: hi", "body_html": "<p>hi</p>"},
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 422

    def test_400_when_smtp_not_configured(self, owner_headers, sc_with_imap):
        # sc_with_imap has IMAP but no SMTP → reply should fail with 400
        r = requests.post(
            f"{API}/inbox/{sc_with_imap['id']}/reply",
            json={"uid": "1", "folder": "INBOX", "to": "x@y.com",
                  "subject": "Re: hi", "body_html": "<p>hi</p>"},
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 400
        assert "SMTP" in r.text

    def test_400_when_imap_not_configured(self, owner_headers, sc_without_imap):
        # _check_inbox_access runs first → 400 IMAP
        r = requests.post(
            f"{API}/inbox/{sc_without_imap['id']}/reply",
            json={"uid": "1", "folder": "INBOX", "to": "x@y.com",
                  "subject": "Re: hi", "body_html": "<p>hi</p>"},
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 400
        assert "IMAP" in r.text

    def test_404_when_sc_missing(self, owner_headers):
        r = requests.post(
            f"{API}/inbox/does-not-exist/reply",
            json={"uid": "1", "folder": "INBOX", "to": "x@y.com",
                  "subject": "Re: hi", "body_html": "<p>hi</p>"},
            headers=owner_headers, timeout=15,
        )
        assert r.status_code == 404


# ─── Regression: existing endpoints still work ─────────────────────────────
class TestRegression:
    def test_login_owner(self):
        r = requests.post(f"{API}/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PW}, timeout=15)
        assert r.status_code == 200
        assert "token" in r.json()

    def test_get_sub_companies(self, owner_headers):
        r = requests.get(f"{API}/sub-companies", headers=owner_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_test_imap_endpoint_reachable(self, owner_headers, sc_with_imap):
        # dummy host → expect 400 (connection failure), not 404/500
        r = requests.post(
            f"{API}/sub-companies/{sc_with_imap['id']}/test-imap",
            headers=owner_headers, timeout=40,
        )
        assert r.status_code in (200, 400), f"unexpected: {r.status_code} {r.text}"

    def test_prospects_list(self, owner_headers):
        r = requests.get(f"{API}/prospects", headers=owner_headers, timeout=15)
        assert r.status_code == 200
        # Either list or paginated object
        body = r.json()
        assert isinstance(body, (list, dict))
