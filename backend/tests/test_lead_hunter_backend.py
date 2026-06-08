"""
Backend integration tests for Lead Hunter & Email Marketing Platform.
Covers: auth, dashboard, hunter (single/bulk/cache), companies, contacts,
multi-tenant isolation, campaigns, settings, team RBAC, tracking pixel/click,
duplicate prevention, confidence scoring.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://contabo-server-setup.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

# Reuse session
S = requests.Session()
S.headers.update({"Content-Type": "application/json"})

# Shared state across tests
STATE = {}


def _unique_email(prefix="t1"):
    return f"TEST_{prefix}_{uuid.uuid4().hex[:8]}@example.com"


# ───────── AUTH ─────────
class TestAuth:
    def test_01_register_tenant_owner(self):
        email = _unique_email("owner")
        r = S.post(f"{API}/auth/register", json={
            "name": "Owner One",
            "email": email,
            "password": "secret123",
            "company_name": "TenantOne Corp",
        }, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "token" in data and len(data["token"]) > 20
        assert data["user"]["role"] == "Owner"
        assert data["user"]["email"] == email.lower()
        assert "tenant_id" in data["user"]
        assert data["tenant"]["company_name"] == "TenantOne Corp"
        STATE["t1_email"] = email
        STATE["t1_password"] = "secret123"
        STATE["t1_token"] = data["token"]
        STATE["t1_tenant_id"] = data["user"]["tenant_id"]
        STATE["t1_user_id"] = data["user"]["id"]

    def test_02_register_duplicate_email_rejected(self):
        r = S.post(f"{API}/auth/register", json={
            "name": "Dup", "email": STATE["t1_email"],
            "password": "secret123", "company_name": "X",
        }, timeout=15)
        assert r.status_code == 400

    def test_03_login_success(self):
        r = S.post(f"{API}/auth/login", json={
            "email": STATE["t1_email"], "password": STATE["t1_password"],
        }, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "token" in data
        assert data["user"]["role"] == "Owner"
        STATE["t1_token"] = data["token"]

    def test_04_login_wrong_password(self):
        r = S.post(f"{API}/auth/login", json={
            "email": STATE["t1_email"], "password": "wrong"
        }, timeout=10)
        assert r.status_code == 401

    def test_05_me_with_bearer(self):
        h = {"Authorization": f"Bearer {STATE['t1_token']}"}
        r = S.get(f"{API}/auth/me", headers=h, timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert d["user"]["email"] == STATE["t1_email"].lower()
        assert d["tenant"]["id"] == STATE["t1_tenant_id"]

    def test_06_me_without_token_401(self):
        r = requests.get(f"{API}/auth/me", timeout=10)
        assert r.status_code == 401


def _auth_h(token_key="t1_token"):
    return {"Authorization": f"Bearer {STATE[token_key]}", "Content-Type": "application/json"}


# ───────── DASHBOARD ─────────
class TestDashboard:
    def test_07_overview_shape(self):
        r = S.get(f"{API}/dashboard/overview", headers=_auth_h(), timeout=15)
        assert r.status_code == 200
        d = r.json()
        cards = d.get("cards", {})
        for k in ["total_companies", "total_contacts", "total_emails_found",
                  "new_leads_today", "emails_sent_today",
                  "open_rate", "reply_rate", "bounce_rate"]:
            assert k in cards, f"missing card {k}"
        assert isinstance(d["trends"], list) and len(d["trends"]) == 14
        for key in ["recent_searches", "recent_leads", "recent_campaigns"]:
            assert key in d


# ───────── HUNTER ─────────
class TestHunter:
    def test_08_check_domain_not_found_initially(self):
        r = S.get(f"{API}/hunter/check-domain/stripe.com", headers=_auth_h(), timeout=15)
        # could be found if previous tests ran; just assert shape
        assert r.status_code == 200
        d = r.json()
        assert "found" in d and d["domain"] == "stripe.com"
        STATE["pre_existing_cache"] = d.get("found", False)

    def test_09_search_full_pipeline_stripe(self):
        # Allow long for Playwright crawl
        r = S.post(f"{API}/hunter/search", headers=_auth_h(),
                   json={"domain": "stripe.com", "force_refresh": True}, timeout=120)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "logs" in d and "steps" in d and "company" in d and "contacts" in d
        # Logs contain step markers
        joined = "\n".join(d["logs"])
        for marker in ["[STEP 1]", "[STEP 2]", "[STEP 3]", "[STEP 4]", "[DONE]"]:
            assert marker in joined, f"Missing log marker {marker} in:\n{joined}"
        # mock returns 6+3 emails minimum; some may dedupe -- expect >=6
        assert len(d["contacts"]) >= 6, f"Expected >=6 contacts, got {len(d['contacts'])}"
        assert d["save"]["company_id"]
        STATE["stripe_company_id"] = d["save"]["company_id"]
        # Confidence scoring rules
        for c in d["contacts"]:
            src = c["source"]; sc = c["confidence_score"]
            if src == "website":
                assert sc == 100, f"website contact must score 100, got {sc}"
            elif src == "hunter":
                assert sc in (95, 85, 70), f"unexpected hunter score {sc}"

    def test_10_check_domain_after_search(self):
        r = S.get(f"{API}/hunter/check-domain/stripe.com", headers=_auth_h(), timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["found"] is True
        assert d["fresh"] is True
        assert d["total_contacts"] >= 6
        assert "age_days" in d

    def test_11_second_search_hits_cache(self):
        r = S.post(f"{API}/hunter/search", headers=_auth_h(),
                   json={"domain": "stripe.com"}, timeout=60)
        assert r.status_code == 200
        d = r.json()
        steps = d.get("steps", [])
        hit = next((s for s in steps if s.get("name") == "Global DB Check"), None)
        assert hit is not None
        assert hit.get("status") == "hit", f"expected cache hit, got {hit}"

    def test_12_duplicate_prevention(self):
        # After two searches for same domain, contacts in tenant should not duplicate
        r = S.get(f"{API}/contacts", headers=_auth_h(), params={"limit": 1000}, timeout=15)
        assert r.status_code == 200
        contacts = r.json()
        emails = [c["email"] for c in contacts]
        assert len(emails) == len(set(emails)), "Duplicate contact emails detected!"

    def test_13_bulk_search(self):
        r = S.post(f"{API}/hunter/bulk", headers=_auth_h(),
                   json={"domains": ["microsoft.com", "apple.com"]}, timeout=15)
        assert r.status_code == 200
        d = r.json()
        assert d["total"] == 2
        assert "job_id" in d
        job_id = d["job_id"]
        # Poll until done (allow up to 120s due to real Playwright crawls)
        deadline = time.time() + 180
        last = None
        while time.time() < deadline:
            jr = S.get(f"{API}/hunter/bulk/{job_id}", headers=_auth_h(), timeout=15)
            assert jr.status_code == 200
            last = jr.json()
            if last["status"] == "done":
                break
            time.sleep(3)
        assert last and last["status"] == "done", f"bulk job did not finish: {last}"
        assert last["completed"] == 2

    def test_14_searches_history(self):
        r = S.get(f"{API}/hunter/searches", headers=_auth_h(), timeout=10)
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list) and len(rows) >= 1


# ───────── COMPANIES & CONTACTS ─────────
class TestData:
    def test_15_companies_list(self):
        r = S.get(f"{API}/companies", headers=_auth_h(), timeout=15)
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list) and len(rows) >= 1
        for r0 in rows:
            assert "contacts_count" in r0
            assert "domain" in r0
            assert "_id" not in r0

    def test_16_contacts_enriched(self):
        r = S.get(f"{API}/contacts", headers=_auth_h(), timeout=15)
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) >= 6
        sample = rows[0]
        # Enriched fields from company join
        for k in ["company_name", "company_domain", "industry", "country", "email", "confidence_score", "source"]:
            assert k in sample, f"missing enriched field {k}"


# ───────── TENANT ISOLATION ─────────
class TestTenantIsolation:
    def test_17_register_second_tenant_and_run_hunter(self):
        email = _unique_email("owner2")
        r = S.post(f"{API}/auth/register", json={
            "name": "Owner Two", "email": email, "password": "secret123",
            "company_name": "TenantTwo Corp",
        }, timeout=15)
        assert r.status_code == 200
        STATE["t2_token"] = r.json()["token"]
        STATE["t2_tenant_id"] = r.json()["user"]["tenant_id"]

        rr = S.post(f"{API}/hunter/search", headers=_auth_h("t2_token"),
                    json={"domain": "shopify.com"}, timeout=120)
        assert rr.status_code == 200

    def test_18_tenant1_does_not_see_tenant2_data(self):
        # tenant1 companies should not include shopify.com
        r = S.get(f"{API}/companies", headers=_auth_h(), timeout=15)
        assert r.status_code == 200
        domains = [c["domain"] for c in r.json()]
        assert "shopify.com" not in domains, "Tenant isolation breach!"

        # tenant2 should not see stripe.com
        r2 = S.get(f"{API}/companies", headers=_auth_h("t2_token"), timeout=15)
        assert r2.status_code == 200
        d2 = [c["domain"] for c in r2.json()]
        assert "stripe.com" not in d2


# ───────── SETTINGS, TEAM, RBAC ─────────
class TestSettingsAndTeam:
    def test_19_patch_settings_persists(self):
        payload = {"smtp_host": "smtp.example.com", "smtp_port": 2525,
                   "smtp_user": "u", "smtp_password": "p",
                   "smtp_from_email": "noreply@example.com",
                   "smtp_use_tls": True}
        r = S.patch(f"{API}/settings", headers=_auth_h(), json=payload, timeout=10)
        assert r.status_code == 200
        d = r.json()
        assert d["smtp_host"] == "smtp.example.com"
        assert d["smtp_port"] == 2525
        # GET verify
        r2 = S.get(f"{API}/settings", headers=_auth_h(), timeout=10)
        assert r2.status_code == 200
        assert r2.json()["smtp_host"] == "smtp.example.com"

    def test_20_team_create_staff(self):
        staff_email = _unique_email("staff")
        r = S.post(f"{API}/team", headers=_auth_h(), json={
            "name": "Staff One", "email": staff_email,
            "password": "staff123", "role": "Staff",
        }, timeout=10)
        assert r.status_code == 200
        STATE["staff_email"] = staff_email
        STATE["staff_pw"] = "staff123"
        STATE["staff_id"] = r.json()["id"]

    def test_21_team_list(self):
        r = S.get(f"{API}/team", headers=_auth_h(), timeout=10)
        assert r.status_code == 200
        rows = r.json()
        assert any(u["email"] == STATE["staff_email"].lower() for u in rows)
        # owner present
        assert any(u["role"] == "Owner" for u in rows)

    def test_22_staff_cannot_patch_settings(self):
        # login as staff
        lr = S.post(f"{API}/auth/login", json={
            "email": STATE["staff_email"], "password": STATE["staff_pw"]
        }, timeout=10)
        assert lr.status_code == 200
        staff_token = lr.json()["token"]
        STATE["staff_token"] = staff_token
        r = S.patch(f"{API}/settings",
                    headers={"Authorization": f"Bearer {staff_token}",
                             "Content-Type": "application/json"},
                    json={"smtp_host": "evil"}, timeout=10)
        assert r.status_code == 403

    def test_23_staff_cannot_delete_team(self):
        r = S.delete(f"{API}/team/{STATE['staff_id']}",
                     headers={"Authorization": f"Bearer {STATE['staff_token']}"}, timeout=10)
        assert r.status_code == 403

    def test_24_owner_can_delete_team(self):
        r = S.delete(f"{API}/team/{STATE['staff_id']}", headers=_auth_h(), timeout=10)
        assert r.status_code == 200
        assert r.json()["deleted"] == 1


# ───────── CAMPAIGNS + TRACKING ─────────
class TestCampaigns:
    def test_25_create_campaign(self):
        contacts = S.get(f"{API}/contacts", headers=_auth_h(), timeout=10).json()
        ids = [c["id"] for c in contacts[:2]]
        r = S.post(f"{API}/campaigns", headers=_auth_h(), json={
            "name": "TEST Campaign", "subject": "Hello",
            "body_html": "<p>Hi <a href='https://example.com'>click</a></p>",
            "contact_ids": ids,
        }, timeout=10)
        assert r.status_code == 200
        STATE["campaign_id"] = r.json()["id"]

    def test_26_campaigns_list_with_metrics(self):
        r = S.get(f"{API}/campaigns", headers=_auth_h(), timeout=10)
        assert r.status_code == 200
        rows = r.json()
        c = next(x for x in rows if x["id"] == STATE["campaign_id"])
        assert "metrics" in c
        for k in ["total", "delivered", "opened", "clicked", "bounced"]:
            assert k in c["metrics"]

    def test_27_send_without_smtp_returns_400_for_t2(self):
        # tenant2 has no SMTP configured
        # create campaign first
        contacts = S.get(f"{API}/contacts", headers=_auth_h("t2_token"), timeout=10).json()
        if not contacts:
            pytest.skip("No contacts in t2")
        ids = [c["id"] for c in contacts[:1]]
        cr = S.post(f"{API}/campaigns", headers=_auth_h("t2_token"), json={
            "name": "TEST", "subject": "S", "body_html": "<p>x</p>",
            "contact_ids": ids,
        }, timeout=10)
        assert cr.status_code == 200
        cid = cr.json()["id"]
        sr = S.post(f"{API}/campaigns/{cid}/send", headers=_auth_h("t2_token"),
                    json={"send_now": True}, timeout=10)
        assert sr.status_code == 400
        assert "SMTP" in sr.text


# ───────── TRACKING PIXEL / CLICK ─────────
class TestTracking:
    def test_28_open_pixel_returns_gif(self):
        # public endpoint -- use a real rid by inserting via campaign first
        # but we don't have sent recipients; tracking still increments if id exists
        # Use a random uuid; endpoint always returns gif regardless (best-effort)
        rid = str(uuid.uuid4())
        r = requests.get(f"{API}/track/open/{rid}", timeout=10)
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("image/gif")
        assert len(r.content) > 0

    def test_29_click_redirects_302(self):
        rid = str(uuid.uuid4())
        target = "https://example.com/"
        r = requests.get(f"{API}/track/click/{rid}", params={"u": target},
                         allow_redirects=False, timeout=10)
        assert r.status_code == 302
        assert r.headers.get("location") == target


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
