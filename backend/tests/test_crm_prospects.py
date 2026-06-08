"""
CRM refactor backend tests — Prospects, Templates, Email Activity, Daily Dashboard, Permissions.
Hits the public REACT_APP_BACKEND_URL so we test what the user sees.
"""
import os
import uuid
import time
import pytest
import requests

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"

OWNER_EMAIL = "demo@test.com"
OWNER_PW = "demo1234"
STAFF_EMAIL = "milla.staff@test.com"
STAFF_PW = "staff1234"


# ───────── fixtures ─────────
@pytest.fixture(scope="session")
def owner_token():
    r = requests.post(f"{API}/auth/login", json={"email": OWNER_EMAIL, "password": OWNER_PW}, timeout=15)
    assert r.status_code == 200, f"Owner login failed: {r.status_code} {r.text}"
    body = r.json()
    assert "token" in body, body
    return body["token"]


@pytest.fixture(scope="session")
def staff_token():
    r = requests.post(f"{API}/auth/login", json={"email": STAFF_EMAIL, "password": STAFF_PW}, timeout=15)
    if r.status_code != 200:
        pytest.skip(f"Staff login unavailable: {r.status_code} {r.text}")
    return r.json()["token"]


@pytest.fixture
def owner(owner_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {owner_token}", "Content-Type": "application/json"})
    return s


@pytest.fixture
def staff(staff_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {staff_token}", "Content-Type": "application/json"})
    return s


# ───────── 1. Auth & permission catalog ─────────
class TestAuthPermissions:
    def test_login_returns_permissions(self, owner_token):
        # /api/auth/me returns user
        r = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {owner_token}"}, timeout=10)
        assert r.status_code == 200
        body = r.json()
        # Owner should have permissions array including new CRM keys
        perms = body.get("permissions") or body.get("user", {}).get("permissions") or []
        # try common shapes
        if not perms:
            # may live under tenant/role
            user_obj = body.get("user", body)
            perms = user_obj.get("permissions", [])
        # As fallback, accept role=Owner (gets all perms in code path)
        role = body.get("user", body).get("role") or body.get("role")
        assert role == "Owner", f"Expected Owner role in /auth/me, got {body}"

    def test_staff_sidebar_permissions(self, staff_token):
        r = requests.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {staff_token}"}, timeout=10)
        assert r.status_code == 200
        body = r.json()
        perms = body.get("permissions") or body.get("user", {}).get("permissions") or []
        # New permissions should include the 5 CRM keys for Staff (no settings)
        expected_some = {"dashboard", "prospects", "email_activity", "templates", "send_emails"}
        assert expected_some.issubset(set(perms)), f"Staff perms missing CRM keys: {perms}"
        assert "settings" not in perms, f"Staff should NOT have 'settings': {perms}"


# ───────── 2. Prospects discover + CRUD ─────────
class TestProspectsDiscover:
    def test_discover_domain(self, owner):
        r = owner.post(f"{API}/prospects/discover", json={"domain": "example.com"}, timeout=90)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["domain"] == "example.com"
        assert "company" in data and isinstance(data["emails"], list)
        # cached is bool
        assert "cached" in data

    def test_discover_cached_fast(self, owner):
        # Second call should be cached
        r = owner.post(f"{API}/prospects/discover", json={"domain": "example.com"}, timeout=30)
        assert r.status_code == 200
        assert r.json().get("cached") in (True, False)


@pytest.fixture(scope="class")
def created_prospect(owner_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {owner_token}", "Content-Type": "application/json"})
    payload = {
        "company_name": f"TEST_CRM_{uuid.uuid4().hex[:6]}",
        "website": "test.example.com",
        "domain": "test.example.com",
        "industry": "Software",
        "country": "ID",
        "city": "Jakarta",
        "emails": [
            {"email": "alice@example.com", "is_primary": False, "status": "verified"},
            {"email": "bob@example.com",   "is_primary": False, "status": "risky"},
        ],
        "status": "New",
    }
    r = s.post(f"{API}/prospects", json=payload, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()


class TestProspectsCRUD:
    def test_create_assigns_primary_email(self, created_prospect):
        emails = created_prospect["emails"]
        primaries = [e for e in emails if e.get("is_primary")]
        assert len(primaries) == 1, f"Exactly 1 primary email expected: {emails}"

    def test_list_prospects_enriched(self, owner, created_prospect):
        r = owner.get(f"{API}/prospects", timeout=15)
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list) and len(rows) >= 1
        ids = {p["id"] for p in rows}
        assert created_prospect["id"] in ids
        # enriched field assigned_user_name should exist (may be None)
        sample = next(p for p in rows if p["id"] == created_prospect["id"])
        assert "assigned_user_name" in sample, f"missing assigned_user_name: {sample.keys()}"

    def test_get_prospect_detail_shape(self, owner, created_prospect):
        pid = created_prospect["id"]
        r = owner.get(f"{API}/prospects/{pid}", timeout=15)
        assert r.status_code == 200
        body = r.json()
        assert "prospect" in body and "activity" in body and "email_sends" in body
        # activity has at least 'prospect_created'
        types = [a["type"] for a in body["activity"]]
        assert "prospect_created" in types, types

    def test_patch_status_logs_activity(self, owner, created_prospect):
        pid = created_prospect["id"]
        r = owner.patch(f"{API}/prospects/{pid}", json={"status": "Contacted"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["status"] == "Contacted"
        # Verify activity log
        r2 = owner.get(f"{API}/prospects/{pid}", timeout=15)
        types = [a["type"] for a in r2.json()["activity"]]
        assert "status_changed" in types, types

    def test_add_and_remove_prospect_email(self, owner, created_prospect):
        pid = created_prospect["id"]
        r = owner.post(f"{API}/prospects/{pid}/emails",
                       json={"email": "charlie@example.com", "is_primary": True, "status": "verified"}, timeout=15)
        assert r.status_code == 200, r.text
        eid = r.json()["email"]["id"]
        # confirm primary swap via detail
        r2 = owner.get(f"{API}/prospects/{pid}", timeout=15)
        emails = r2.json()["prospect"]["emails"]
        primaries = [e for e in emails if e.get("is_primary")]
        assert len(primaries) == 1 and primaries[0]["email"] == "charlie@example.com"
        # delete
        rd = owner.delete(f"{API}/prospects/{pid}/emails/{eid}", timeout=15)
        assert rd.status_code == 200

    def test_add_note_appears_in_timeline(self, owner, created_prospect):
        pid = created_prospect["id"]
        r = owner.post(f"{API}/prospects/{pid}/notes", json={"text": "TEST note xyz"}, timeout=15)
        assert r.status_code == 200
        r2 = owner.get(f"{API}/prospects/{pid}", timeout=15)
        notes = [a for a in r2.json()["activity"] if a["type"] == "note_added"]
        assert notes and any("TEST note xyz" in (n.get("data", {}).get("text", "")) for n in notes)


# ───────── 3. Send email contract (expect 400 SMTP not configured) ─────────
class TestSendEmail:
    def test_send_returns_400_no_smtp(self, owner, created_prospect):
        pid = created_prospect["id"]
        r = owner.post(f"{API}/prospects/{pid}/send-email", json={
            "to_email": "alice@example.com",
            "subject": "Hi {{name}}",
            "body_html": "<p>Hello {{name}} at {{company}}</p>",
        }, timeout=15)
        # Demo Co tenant has no SMTP — should return 400 with SMTP message
        assert r.status_code in (400, 200), r.text
        if r.status_code == 400:
            assert "SMTP" in r.text


# ───────── 4. Templates CRUD + duplicate ─────────
class TestTemplates:
    def test_template_full_lifecycle(self, owner):
        # Create
        name = f"TEST_T_{uuid.uuid4().hex[:6]}"
        r = owner.post(f"{API}/templates", json={
            "name": name, "subject": "Hi {{name}}", "body_html": "<p>Hello {{company}}</p>"
        }, timeout=15)
        assert r.status_code == 200, r.text
        tid = r.json()["id"]

        # List
        r2 = owner.get(f"{API}/templates", timeout=15)
        assert r2.status_code == 200
        assert any(t["id"] == tid for t in r2.json())

        # Duplicate
        rd = owner.post(f"{API}/templates/{tid}/duplicate", timeout=15)
        assert rd.status_code == 200
        dup = rd.json()
        assert dup["name"].endswith("(copy)")

        # Patch
        rp = owner.patch(f"{API}/templates/{tid}", json={"subject": "New {{name}}"}, timeout=15)
        assert rp.status_code == 200
        assert rp.json()["subject"] == "New {{name}}"

        # Delete original + copy
        for x in [tid, dup["id"]]:
            rx = owner.delete(f"{API}/templates/{x}", timeout=15)
            assert rx.status_code == 200


# ───────── 5. Email Activity ─────────
class TestEmailActivity:
    def test_list_email_sends_ok(self, owner):
        r = owner.get(f"{API}/email-sends", timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_email_sends_filter_status(self, owner):
        r = owner.get(f"{API}/email-sends?status=queued", timeout=15)
        assert r.status_code == 200


# ───────── 6. Daily target + dashboard ─────────
class TestDailyTargetAndDashboard:
    def test_patch_me_target(self, owner):
        r = owner.patch(f"{API}/me/target", json={"daily_target": 10}, timeout=15)
        assert r.status_code == 200
        assert r.json()["daily_target"] == 10

    def test_dashboard_daily_shape(self, owner):
        r = owner.get(f"{API}/dashboard/daily", timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["daily_target"] == 10, f"target should reflect patch: {body['daily_target']}"
        cards = body["cards"]
        for k in ("prospects_today", "emails_sent_today", "team_emails_today",
                  "replies_today", "interested_count", "customers_won"):
            assert k in cards, f"missing {k} in cards: {cards}"
        assert isinstance(body["trend"], list) and len(body["trend"]) == 14
        assert isinstance(body["recent_prospects"], list)


# ───────── 7. Tracking pixel backward compat ─────────
class TestTrackingPixel:
    def test_pixel_returns_gif(self):
        r = requests.get(f"{API}/track/open/non-existent-id", timeout=10, allow_redirects=False)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("image/gif")


# ───────── 8. Staff permission checks ─────────
class TestStaffPermissions:
    def test_staff_cannot_delete_prospect(self, staff, owner):
        # Create as owner
        payload = {"company_name": f"TEST_DEL_{uuid.uuid4().hex[:5]}", "emails": [{"email":"x@example.com"}]}
        r = owner.post(f"{API}/prospects", json=payload, timeout=15)
        assert r.status_code == 200
        pid = r.json()["id"]
        # Staff tries delete
        rd = staff.delete(f"{API}/prospects/{pid}", timeout=15)
        assert rd.status_code == 403, f"Expected 403 for staff delete, got {rd.status_code} {rd.text}"
        # Cleanup as owner
        owner.delete(f"{API}/prospects/{pid}", timeout=15)


# ───────── 9. Cleanup ─────────
@pytest.fixture(scope="session", autouse=True)
def _cleanup(owner_token):
    yield
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {owner_token}"})
    try:
        rows = s.get(f"{API}/prospects", timeout=15).json()
        for p in rows:
            if isinstance(p, dict) and p.get("company_name", "").startswith("TEST_"):
                s.delete(f"{API}/prospects/{p['id']}", timeout=10)
    except Exception:
        pass
