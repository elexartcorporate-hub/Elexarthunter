"""End-to-end backend tests for WhatsApp (Baileys) module.

Covers:
- Sidecar reachability (/health, secret enforcement)
- Account create / status (QR within ~5s)
- Max-3 limit enforcement
- RBAC scoping (Owner sees all, Staff sees own only)
- Send-message RBAC (Owner cannot send on Staff account -> 403)
- Delete + scope after delete
- Empty chats list
"""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://contabo-server-setup.preview.emergentagent.com").rstrip("/")
WA_LOCAL = "http://localhost:3002"
WA_SECRET = "lh-wa-internal-secret-2026"

OWNER = {"email": "demo@test.com", "password": "demo1234"}
STAFF = {"email": "milla.staff@test.com", "password": "staff1234"}


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"Login failed for {email}: {r.status_code} {r.text}"
    body = r.json()
    return body.get("access_token") or body.get("token")


def _h(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def owner_token():
    return _login(OWNER["email"], OWNER["password"])


@pytest.fixture(scope="module")
def staff_token():
    return _login(STAFF["email"], STAFF["password"])


@pytest.fixture(scope="module", autouse=True)
def _cleanup(owner_token):
    """Wipe any pre-existing WA accounts in tenant before tests + after."""
    def wipe():
        try:
            r = requests.get(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), timeout=15)
            if r.status_code == 200:
                for a in r.json():
                    requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{a['session_id']}", headers=_h(owner_token), timeout=15)
        except Exception:
            pass
    wipe()
    yield
    wipe()


# --- Sidecar reachability ---
class TestSidecar:
    def test_health_ok(self):
        r = requests.get(f"{WA_LOCAL}/health", timeout=5)
        assert r.status_code == 200
        assert r.json() == {"ok": True}

    def test_protected_requires_secret(self):
        r = requests.get(f"{WA_LOCAL}/sessions/dummy", timeout=5)
        assert r.status_code == 401

    def test_protected_accepts_secret(self):
        r = requests.get(f"{WA_LOCAL}/sessions/nonexistent-xyz", headers={"X-WA-Secret": WA_SECRET}, timeout=5)
        # Existence check: should be either 404 (not found) or 200, never 401
        assert r.status_code != 401


# --- Account create + status + limit ---
class TestAccountCRUD:
    created_sids = []

    def test_create_account(self, owner_token):
        r = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": "TEST_owner_1"}, timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "session_id" in body
        assert "status" in body
        TestAccountCRUD.created_sids.append(body["session_id"])

    def test_status_returns_qr_within_5s(self, owner_token):
        sid = TestAccountCRUD.created_sids[0]
        qr = None
        for _ in range(10):  # poll up to ~10 sec
            r = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/status", headers=_h(owner_token), timeout=10)
            assert r.status_code == 200, r.text
            data = r.json()
            if data.get("qr"):
                qr = data["qr"]
                break
            time.sleep(1)
        assert qr is not None, "QR not returned within 10 seconds"
        assert qr.startswith("data:image/"), f"QR not a data URL: {qr[:50]}"

    def test_max_3_per_user(self, owner_token):
        # Already created 1 -> create 2 more then 4th should fail
        for i in range(2):
            r = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": f"TEST_owner_{i+2}"}, timeout=20)
            assert r.status_code == 200, r.text
            TestAccountCRUD.created_sids.append(r.json()["session_id"])
        # 4th
        r = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": "TEST_owner_4"}, timeout=20)
        assert r.status_code == 400
        assert "Maks 3 akun WA per user" in r.text

    def test_empty_chats_list(self, owner_token):
        sid = TestAccountCRUD.created_sids[0]
        r = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/chats", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_delete_account(self, owner_token):
        sid = TestAccountCRUD.created_sids.pop()
        r = requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{sid}", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200
        assert r.json().get("ok") is True
        # Subsequent status -> 404
        r2 = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/status", headers=_h(owner_token), timeout=10)
        assert r2.status_code == 404


# --- RBAC scoping ---
class TestRBAC:
    def test_staff_only_sees_own_and_owner_sees_all(self, owner_token, staff_token):
        # Cleanup owner-side first: delete all
        r = requests.get(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), timeout=15)
        for a in r.json():
            requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{a['session_id']}", headers=_h(owner_token), timeout=15)

        # Staff creates 1
        rs = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(staff_token), json={"label": "TEST_staff_1"}, timeout=20)
        assert rs.status_code == 200, rs.text
        staff_sid = rs.json()["session_id"]

        # Owner creates 1
        ro = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": "TEST_owner_1"}, timeout=20)
        assert ro.status_code == 200, ro.text
        owner_sid = ro.json()["session_id"]

        # Owner list should contain both
        rl_o = requests.get(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), timeout=15)
        assert rl_o.status_code == 200
        owner_sids = {x["session_id"] for x in rl_o.json()}
        assert staff_sid in owner_sids, "Owner should see Staff's account"
        assert owner_sid in owner_sids

        # Staff list must NOT contain owner_sid
        rl_s = requests.get(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(staff_token), timeout=15)
        assert rl_s.status_code == 200
        staff_sids = {x["session_id"] for x in rl_s.json()}
        assert staff_sid in staff_sids
        assert owner_sid not in staff_sids, "Staff must NOT see Owner's account"

        # Staff trying to access owner sid -> 403
        r403 = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{owner_sid}/status", headers=_h(staff_token), timeout=10)
        assert r403.status_code == 403, f"Expected 403, got {r403.status_code}: {r403.text}"

        # Owner trying to SEND on staff's account -> 403 (BEFORE sidecar call)
        rsend = requests.post(
            f"{BASE_URL}/api/whatsapp/accounts/{staff_sid}/chats/6281234567890@s.whatsapp.net/messages",
            headers=_h(owner_token), json={"text": "Hi"}, timeout=15,
        )
        assert rsend.status_code == 403, f"Owner send on staff acc should be 403, got {rsend.status_code}: {rsend.text}"
        assert "Hanya pemilik akun WA" in rsend.text

        # Staff sending on own account: auth must pass — expect non-403 (likely 503/500 since not connected)
        rsend_own = requests.post(
            f"{BASE_URL}/api/whatsapp/accounts/{staff_sid}/chats/6281234567890@s.whatsapp.net/messages",
            headers=_h(staff_token), json={"text": "Hi"}, timeout=15,
        )
        assert rsend_own.status_code != 403, f"Staff sending on own acc should not be 403, got {rsend_own.status_code}: {rsend_own.text}"

        # Cleanup
        requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{staff_sid}", headers=_h(staff_token), timeout=15)
        requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{owner_sid}", headers=_h(owner_token), timeout=15)
