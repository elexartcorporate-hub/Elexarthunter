"""Phase 2 backend tests for WhatsApp module.

Covers:
- Delta polling via since_ts on chats and messages endpoints
- Send media RBAC (Owner cannot send media on Staff acct -> 403)
- Send media on own account -> non-403 (sidecar 500/503 expected when not connected)
- Groups endpoint accepts auth and returns array OR graceful 500 'not connected'
- Sidecar resume after `supervisorctl restart wa-service` (account NOT 404 after restart)
"""
import os
import time
import base64
import subprocess
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://contabo-server-setup.preview.emergentagent.com").rstrip("/")
WA_LOCAL = "http://localhost:3002"
WA_SECRET = "lh-wa-internal-secret-2026"

OWNER = {"email": "demo@test.com", "password": "demo1234"}
STAFF = {"email": "milla.staff@test.com", "password": "staff1234"}

# Tiny 1x1 transparent PNG
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


def _login(email, password):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": password}, timeout=15)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
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
def _wipe_all(owner_token, staff_token):
    def wipe():
        for tok in (owner_token, staff_token):
            try:
                r = requests.get(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(tok), timeout=15)
                if r.status_code == 200:
                    for a in r.json():
                        requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{a['session_id']}", headers=_h(tok), timeout=15)
            except Exception:
                pass
    wipe()
    yield
    wipe()


# --- since_ts delta polling ---
class TestDeltaPolling:
    sid = None

    def test_create_account_for_delta(self, owner_token):
        r = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": "TEST_delta"}, timeout=20)
        assert r.status_code == 200, r.text
        TestDeltaPolling.sid = r.json()["session_id"]

    def test_chats_without_since_ts_returns_array(self, owner_token):
        sid = TestDeltaPolling.sid
        r = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/chats", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), list)

    def test_chats_with_future_since_ts_returns_empty(self, owner_token):
        sid = TestDeltaPolling.sid
        r = requests.get(
            f"{BASE_URL}/api/whatsapp/accounts/{sid}/chats",
            headers=_h(owner_token),
            params={"since_ts": "2030-01-01T00:00:00Z"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        assert len(data) == 0, f"Expected empty array for future since_ts, got {len(data)} items"

    def test_messages_with_future_since_ts_returns_empty(self, owner_token):
        sid = TestDeltaPolling.sid
        # arbitrary jid that doesn't exist for this account
        r = requests.get(
            f"{BASE_URL}/api/whatsapp/accounts/{sid}/chats/6281234567890@s.whatsapp.net/messages",
            headers=_h(owner_token),
            params={"since_ts": "2030-01-01T00:00:00Z"},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        assert len(data) == 0

    def test_cleanup_delta_account(self, owner_token):
        sid = TestDeltaPolling.sid
        r = requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{sid}", headers=_h(owner_token), timeout=15)
        assert r.status_code == 200


# --- Send media RBAC ---
class TestSendMediaRBAC:
    def test_owner_cannot_send_media_on_staff_account(self, owner_token, staff_token):
        # Staff creates account
        rs = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(staff_token), json={"label": "TEST_staff_media"}, timeout=20)
        assert rs.status_code == 200, rs.text
        staff_sid = rs.json()["session_id"]
        try:
            # Owner attempts media send -> must be 403 BEFORE sidecar call
            payload = {
                "kind": "image",
                "base64": TINY_PNG_B64,
                "mimetype": "image/png",
                "file_name": "tiny.png",
                "caption": "hi",
            }
            r = requests.post(
                f"{BASE_URL}/api/whatsapp/accounts/{staff_sid}/chats/6281234567890@s.whatsapp.net/media",
                headers=_h(owner_token), json=payload, timeout=15,
            )
            assert r.status_code == 403, f"Expected 403, got {r.status_code}: {r.text}"
            assert "Hanya pemilik akun WA yang bisa mengirim media" in r.text
        finally:
            requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{staff_sid}", headers=_h(staff_token), timeout=15)

    def test_staff_sending_media_on_own_account_passes_auth(self, staff_token):
        rs = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(staff_token), json={"label": "TEST_staff_own_media"}, timeout=20)
        assert rs.status_code == 200, rs.text
        sid = rs.json()["session_id"]
        try:
            payload = {
                "kind": "image",
                "base64": TINY_PNG_B64,
                "mimetype": "image/png",
                "file_name": "tiny.png",
                "caption": "hi",
            }
            r = requests.post(
                f"{BASE_URL}/api/whatsapp/accounts/{sid}/chats/6281234567890@s.whatsapp.net/media",
                headers=_h(staff_token), json=payload, timeout=20,
            )
            # Auth passed → sidecar should reject because not connected → non-403
            assert r.status_code != 403, f"Should pass auth, got 403: {r.text}"
            # Acceptable codes: 200 (unlikely), 500/503 (not connected), 400 invalid
            assert r.status_code in (200, 400, 500, 502, 503), f"Unexpected status {r.status_code}: {r.text}"
        finally:
            requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{sid}", headers=_h(staff_token), timeout=15)


# --- Groups endpoint ---
class TestGroups:
    def test_groups_endpoint_responds(self, owner_token):
        ro = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": "TEST_grp"}, timeout=20)
        assert ro.status_code == 200
        sid = ro.json()["session_id"]
        try:
            r = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/groups", headers=_h(owner_token), timeout=15)
            # Should either return array [] or graceful 500 with 'not connected'
            assert r.status_code in (200, 500, 502, 503), f"Unexpected status {r.status_code}: {r.text}"
            if r.status_code == 200:
                assert isinstance(r.json(), list)
            else:
                # Graceful error message
                txt = r.text.lower()
                assert ("not connected" in txt or "scan" in txt or "session" in txt), f"Error body should mention connection: {r.text}"
        finally:
            requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{sid}", headers=_h(owner_token), timeout=15)


# --- Resume after sidecar restart ---
class TestSidecarResume:
    def test_account_survives_wa_service_restart(self, owner_token):
        # Create account
        r = requests.post(f"{BASE_URL}/api/whatsapp/accounts", headers=_h(owner_token), json={"label": "TEST_resume"}, timeout=20)
        assert r.status_code == 200, r.text
        sid = r.json()["session_id"]
        try:
            # Verify status pre-restart
            r1 = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/status", headers=_h(owner_token), timeout=10)
            assert r1.status_code == 200

            # Restart sidecar
            res = subprocess.run(
                ["sudo", "supervisorctl", "restart", "wa-service"],
                capture_output=True, text=True, timeout=30,
            )
            assert res.returncode == 0, f"Restart failed: {res.stderr}"

            # Wait for sidecar to come back up
            for _ in range(20):
                try:
                    h = requests.get(f"{WA_LOCAL}/health", timeout=2)
                    if h.status_code == 200:
                        break
                except Exception:
                    pass
                time.sleep(1)
            time.sleep(3)  # let resume loop kick in

            # Account status should NOT be 404 (sidecar resumed it from wa_accounts)
            r2 = requests.get(f"{BASE_URL}/api/whatsapp/accounts/{sid}/status", headers=_h(owner_token), timeout=15)
            assert r2.status_code != 404, f"Account lost after restart! got {r2.status_code}: {r2.text}"
            assert r2.status_code == 200, f"Status not 200: {r2.status_code}: {r2.text}"
        finally:
            requests.delete(f"{BASE_URL}/api/whatsapp/accounts/{sid}", headers=_h(owner_token), timeout=15)
