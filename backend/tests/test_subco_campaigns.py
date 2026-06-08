"""
Tests for newly added features:
- Sub-companies CRUD (with SMTP per sub-company)
- Campaigns with new fields: sub_company_id, recipient_source, manual_emails, my_lead_ids
- /campaigns/{id}/send SMTP resolution (sub-company > tenant) + 400 when no SMTP
- Backward compatibility with legacy contact_ids
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://contabo-server-setup.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

S = requests.Session()
S.headers.update({"Content-Type": "application/json"})
STATE = {}


def _email():
    return f"TEST_subco_{uuid.uuid4().hex[:8]}@example.com"


def _h(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


# Demo user smoke
class TestDemoLogin:
    def test_01_demo_login(self):
        r = S.post(f"{API}/auth/login", json={"email": "demo@test.com", "password": "demo1234"}, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["user"]["role"] == "Owner"
        STATE["demo_token"] = d["token"]


# Fresh tenant for clean tests
class TestFreshOwner:
    def test_02_register_owner(self):
        em = _email()
        r = S.post(f"{API}/auth/register", json={
            "name": "SubCo Owner", "email": em, "password": "secret123",
            "company_name": "SubCo Test Tenant",
        }, timeout=20)
        assert r.status_code == 200
        STATE["token"] = r.json()["token"]
        STATE["tenant_id"] = r.json()["user"]["tenant_id"]


# Sub-companies CRUD
class TestSubCompanies:
    def test_03_list_initially_empty(self):
        r = S.get(f"{API}/sub-companies", headers=_h(STATE["token"]), timeout=10)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_04_create_subcompany_with_smtp(self):
        r = S.post(f"{API}/sub-companies", headers=_h(STATE["token"]), json={
            "name": "QA Test Co",
            "legal_name": "QA Legal Ltd",
            "phone": "+62 21 0000",
            "smtp_host": "smtp.test.com",
            "smtp_port": 587,
            "smtp_user": "qa@test.com",
            "smtp_password": "secret",
            "smtp_use_tls": True,
            "smtp_from_email": "sender@test.com",
            "smtp_from_name": "QA Sender",
        }, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["name"] == "QA Test Co"
        assert d["smtp_host"] == "smtp.test.com"
        assert d["smtp_port"] == 587
        assert d["smtp_from_email"] == "sender@test.com"
        assert "id" in d
        assert "_id" not in d
        STATE["subco_id"] = d["id"]

    def test_05_subco_appears_in_list(self):
        r = S.get(f"{API}/sub-companies", headers=_h(STATE["token"]), timeout=10)
        assert r.status_code == 200
        rows = r.json()
        match = next((x for x in rows if x["id"] == STATE["subco_id"]), None)
        assert match is not None
        assert match["smtp_host"] == "smtp.test.com"
        assert "user_count" in match

    def test_06_patch_subco(self):
        r = S.patch(f"{API}/sub-companies/{STATE['subco_id']}", headers=_h(STATE["token"]),
                    json={"smtp_port": 2525}, timeout=10)
        assert r.status_code == 200
        assert r.json()["smtp_port"] == 2525


# Campaign new model
class TestCampaignsNewModel:
    def test_07_create_campaign_manual_source(self):
        r = S.post(f"{API}/campaigns", headers=_h(STATE["token"]), json={
            "name": "QA Smoke",
            "subject": "Hi",
            "body_html": "<p>Hello manual</p>",
            "sub_company_id": STATE["subco_id"],
            "recipient_source": "manual",
            "manual_emails": ["alice@example.com", "bob@example.com"],
        }, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "draft"
        assert d["recipient_source"] == "manual"
        assert d["manual_emails"] == ["alice@example.com", "bob@example.com"]
        assert d["sub_company_id"] == STATE["subco_id"]
        STATE["manual_camp_id"] = d["id"]

    def test_08_create_campaign_my_leads_empty_allowed(self):
        # validation only at send time -- empty my_lead_ids should still create draft
        r = S.post(f"{API}/campaigns", headers=_h(STATE["token"]), json={
            "name": "QA Leads Draft",
            "subject": "Hello",
            "body_html": "<p>x</p>",
            "recipient_source": "my_leads",
            "my_lead_ids": [],
        }, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["recipient_source"] == "my_leads"
        assert d["my_lead_ids"] == []

    def test_09_create_campaign_legacy_contact_ids(self):
        # Backward compat: legacy payload without recipient_source defaults to "contacts"
        r = S.post(f"{API}/campaigns", headers=_h(STATE["token"]), json={
            "name": "Legacy",
            "subject": "L",
            "body_html": "<p>l</p>",
            "contact_ids": [],
        }, timeout=10)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["recipient_source"] == "contacts"

    def test_10_list_campaigns_have_metrics(self):
        r = S.get(f"{API}/campaigns", headers=_h(STATE["token"]), timeout=10)
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) >= 3
        for c in rows:
            assert "metrics" in c
            for k in ["total", "delivered", "opened", "clicked", "bounced"]:
                assert k in c["metrics"]

    def test_11_send_manual_campaign_uses_subco_smtp(self):
        # subco SMTP is fake (smtp.test.com) → will resolve OK to that source,
        # background sender will fail per-recipient but endpoint should return 200
        # because SMTP resolution finds sub-company SMTP and recipients>0
        sr = S.post(f"{API}/campaigns/{STATE['manual_camp_id']}/send",
                    headers=_h(STATE["token"]), json={"send_now": True}, timeout=15)
        assert sr.status_code == 200, sr.text
        d = sr.json()
        assert d["recipients_count"] == 2
        assert d["status"] == "queued"

    def test_12_send_my_leads_empty_returns_400(self):
        # create a my_leads campaign with empty lead_ids and try to send
        cr = S.post(f"{API}/campaigns", headers=_h(STATE["token"]), json={
            "name": "Leads Send Test", "subject": "S", "body_html": "<p>x</p>",
            "sub_company_id": STATE["subco_id"],
            "recipient_source": "my_leads",
            "my_lead_ids": [],
        }, timeout=10)
        cid = cr.json()["id"]
        sr = S.post(f"{API}/campaigns/{cid}/send", headers=_h(STATE["token"]),
                    json={"send_now": True}, timeout=10)
        assert sr.status_code == 400
        assert "lead" in sr.text.lower()

    def test_13_send_without_smtp_400(self):
        # Create a fresh tenant without SMTP, no sub-company, manual recipients -> 400
        em = _email()
        rr = S.post(f"{API}/auth/register", json={
            "name": "NoSMTP", "email": em, "password": "secret123",
            "company_name": "NoSMTP Tenant",
        }, timeout=15)
        assert rr.status_code == 200
        tok = rr.json()["token"]
        cr = S.post(f"{API}/campaigns", headers=_h(tok), json={
            "name": "NoSMTP", "subject": "S", "body_html": "<p>x</p>",
            "recipient_source": "manual",
            "manual_emails": ["x@y.com"],
        }, timeout=10)
        assert cr.status_code == 200
        cid = cr.json()["id"]
        sr = S.post(f"{API}/campaigns/{cid}/send", headers=_h(tok),
                    json={"send_now": True}, timeout=10)
        assert sr.status_code == 400
        assert "SMTP" in sr.text


# Sub-company delete + persistence
class TestSubCoCleanup:
    def test_14_get_campaign_persists_new_fields(self):
        r = S.get(f"{API}/campaigns/{STATE['manual_camp_id']}", headers=_h(STATE["token"]), timeout=10)
        assert r.status_code == 200
        c = r.json()["campaign"]
        assert c["sub_company_id"] == STATE["subco_id"]
        assert c["recipient_source"] == "manual"
        assert c["manual_emails"] == ["alice@example.com", "bob@example.com"]

    def test_15_delete_subco(self):
        r = S.delete(f"{API}/sub-companies/{STATE['subco_id']}", headers=_h(STATE["token"]), timeout=10)
        assert r.status_code == 200
        assert r.json()["deleted"] == 1


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
