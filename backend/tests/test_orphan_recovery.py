"""
Backend tests for POST /api/tasks/recover-orphans/{date}

Covers:
- Happy path: orphan prospects on date X => new task created (status=draft,
  name='Recovered <date>', recovered_from_orphans=true, prospect_ids = orphan ids).
- Idempotency: second call returns 404 (orphans already attached).
- No orphans => 404.
- Invalid date format => 400.
- Auth required => 401/403 without token.
- RBAC isolation: Staff's orphans are NOT visible/recoverable by Owner; each user
  recovers only their own orphan prospects.
- Regression: /api/tasks?date=X and /api/prospects/calendar/day/X still work.
"""
import os
import datetime as _dt
import requests
import pytest

BASE = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
API = f"{BASE}/api"

OWNER_EMAIL = "demo@test.com"
OWNER_PW = "demo1234"
STAFF_EMAIL = "milla.staff@test.com"
STAFF_PW = "staff1234"

TODAY = _dt.date.today().isoformat()


# ───────── helpers ─────────
def _login(email, pw):
    r = requests.post(f"{API}/auth/login", json={"email": email, "password": pw}, timeout=15)
    assert r.status_code == 200, f"Login failed for {email}: {r.status_code} {r.text}"
    body = r.json()
    return body["token"], body.get("user") or {}


def _session(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


def _create_prospect(sess, company_name, user_id=None):
    """Create a prospect attached to user_id (defaults to current authed user)."""
    # Email local-part allows letters/digits/dots; build a safe slug for domain
    safe = "".join(ch for ch in company_name.lower() if ch.isalnum())
    payload = {
        "company_name": company_name,
        "website": f"https://{safe}.test",
        "emails": [{"email": f"contact@{safe}.example.com", "is_primary": True}],
    }
    if user_id:
        payload["assigned_user_id"] = user_id
    r = sess.post(f"{API}/prospects", json=payload, timeout=15)
    assert r.status_code in (200, 201), f"create prospect failed: {r.status_code} {r.text}"
    return r.json()


def _delete_prospect(sess, pid):
    try:
        sess.delete(f"{API}/prospects/{pid}", timeout=10)
    except Exception:
        pass


def _delete_task(sess, tid):
    try:
        sess.delete(f"{API}/tasks/{tid}", timeout=10)
    except Exception:
        pass


# ───────── fixtures ─────────
@pytest.fixture(scope="module")
def owner_ctx():
    token, user = _login(OWNER_EMAIL, OWNER_PW)
    sess = _session(token)
    # auth/me to find user id reliably
    if not user.get("id"):
        r = sess.get(f"{API}/auth/me", timeout=10)
        user = (r.json().get("user") if isinstance(r.json(), dict) and "user" in r.json() else r.json()) or {}
    return {"token": token, "user": user, "sess": sess}


@pytest.fixture(scope="module")
def staff_ctx():
    try:
        token, user = _login(STAFF_EMAIL, STAFF_PW)
    except AssertionError as e:
        pytest.skip(f"staff login unavailable: {e}")
    sess = _session(token)
    if not user.get("id"):
        r = sess.get(f"{API}/auth/me", timeout=10)
        body = r.json()
        user = body.get("user") if isinstance(body, dict) and "user" in body else body
    return {"token": token, "user": user, "sess": sess}


# Track resources to clean up at module teardown
_TO_CLEAN_PROSPECTS = []  # [(sess, pid)]
_TO_CLEAN_TASKS = []      # [(sess, tid)]


@pytest.fixture(scope="module", autouse=True)
def _cleanup(owner_ctx, staff_ctx):
    yield
    for sess, pid in _TO_CLEAN_PROSPECTS:
        _delete_prospect(sess, pid)
    for sess, tid in _TO_CLEAN_TASKS:
        _delete_task(sess, tid)


# ───────── tests ─────────
class TestAuthRequired:
    def test_unauthenticated_returns_401_or_403(self):
        r = requests.post(f"{API}/tasks/recover-orphans/{TODAY}", timeout=10)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text}"


class TestInvalidDate:
    def test_invalid_date_format_returns_400(self, owner_ctx):
        r = owner_ctx["sess"].post(f"{API}/tasks/recover-orphans/not-a-date", timeout=10)
        assert r.status_code == 400, f"expected 400, got {r.status_code}: {r.text}"


class TestNoOrphans:
    def test_no_orphans_on_far_past_date_returns_404(self, owner_ctx):
        # Use a date in the past where nothing was created
        far_past = "1999-01-15"
        r = owner_ctx["sess"].post(f"{API}/tasks/recover-orphans/{far_past}", timeout=10)
        assert r.status_code == 404, f"expected 404, got {r.status_code}: {r.text}"


class TestHappyPathAndIdempotency:
    def test_recover_orphans_happy_path_and_second_call_404(self, owner_ctx):
        sess = owner_ctx["sess"]
        # Step 1: create 3 orphan prospects (NO task wraps them)
        created_pids = []
        for i in range(3):
            p = _create_prospect(sess, f"TEST_OrphanCo_{_dt.datetime.utcnow().timestamp()}_{i}")
            created_pids.append(p["id"])
            _TO_CLEAN_PROSPECTS.append((sess, p["id"]))
        assert len(created_pids) == 3

        # Step 2: call recover-orphans for today
        r = sess.post(f"{API}/tasks/recover-orphans/{TODAY}", timeout=15)
        assert r.status_code == 200, f"recover failed: {r.status_code} {r.text}"
        body = r.json()

        # Data assertions
        assert body.get("status") == "draft"
        assert body.get("name") == f"Recovered {TODAY}"
        assert body.get("recovered_from_orphans") is True
        assert body.get("date") == TODAY
        assert isinstance(body.get("prospect_ids"), list)
        assert body.get("prospect_count") == len(body["prospect_ids"])
        # All our orphan ids should be inside (server may include other user's
        # earlier orphans from previous tests on same day, so check superset).
        for pid in created_pids:
            assert pid in body["prospect_ids"], f"prospect {pid} not attached"
        tid = body.get("id")
        assert tid
        _TO_CLEAN_TASKS.append((sess, tid))

        # Step 3: idempotency — second call should return 404 (no more orphans)
        r2 = sess.post(f"{API}/tasks/recover-orphans/{TODAY}", timeout=15)
        assert r2.status_code == 404, f"expected 404 on 2nd call, got {r2.status_code}: {r2.text}"

        # Step 4: verify GET /api/tasks?date=TODAY still returns and includes new task
        rg = sess.get(f"{API}/tasks", params={"date": TODAY}, timeout=10)
        assert rg.status_code == 200, rg.text
        tasks = rg.json()
        ids = [t.get("id") for t in tasks]
        assert tid in ids, f"new recovered task not visible in /api/tasks?date={TODAY}"

        # Step 5: verify /api/prospects/calendar/day/{date} regression
        rcal = sess.get(f"{API}/prospects/calendar/day/{TODAY}", timeout=10)
        assert rcal.status_code == 200, rcal.text
        # response shape may vary; just sanity check 200 & dict
        assert isinstance(rcal.json(), dict)


class TestRBACIsolation:
    """Owner cannot accidentally recover Staff's orphans, and vice versa."""

    def test_staff_orphans_not_recovered_by_owner(self, owner_ctx, staff_ctx):
        owner_sess = owner_ctx["sess"]
        staff_sess = staff_ctx["sess"]
        staff_user_id = staff_ctx["user"].get("id")
        owner_user_id = owner_ctx["user"].get("id")
        assert staff_user_id and owner_user_id and staff_user_id != owner_user_id, (
            f"need distinct user ids: owner={owner_user_id} staff={staff_user_id}"
        )

        # Step 1: staff creates 2 orphan prospects
        staff_pids = []
        for i in range(2):
            p = _create_prospect(staff_sess, f"TEST_StaffOrphan_{_dt.datetime.utcnow().timestamp()}_{i}")
            assert p.get("assigned_user_id") == staff_user_id, (
                f"prospect should be assigned to staff: {p.get('assigned_user_id')} vs {staff_user_id}"
            )
            staff_pids.append(p["id"])
            _TO_CLEAN_PROSPECTS.append((staff_sess, p["id"]))

        # Step 2: Owner calls recover-orphans. Owner has no orphans (cleared by
        # prior test) so should get 404 — staff's orphans MUST NOT be picked up.
        r = owner_sess.post(f"{API}/tasks/recover-orphans/{TODAY}", timeout=15)
        if r.status_code == 200:
            body = r.json()
            # If owner happened to have own orphans, ensure none of staff_pids leaked in
            attached = set(body.get("prospect_ids") or [])
            leaked = [pid for pid in staff_pids if pid in attached]
            assert not leaked, f"RBAC VIOLATION: owner recovered staff prospects: {leaked}"
            tid = body.get("id")
            if tid:
                _TO_CLEAN_TASKS.append((owner_sess, tid))
        else:
            assert r.status_code == 404, f"expected 404 or 200(no-leak), got {r.status_code}: {r.text}"

        # Step 3: Staff calls recover-orphans — must succeed and contain THEIR orphans
        rs = staff_sess.post(f"{API}/tasks/recover-orphans/{TODAY}", timeout=15)
        assert rs.status_code == 200, f"staff recover failed: {rs.status_code} {rs.text}"
        body = rs.json()
        attached = set(body.get("prospect_ids") or [])
        for pid in staff_pids:
            assert pid in attached, f"staff prospect {pid} not attached to staff's recovered task"
        # Task must belong to staff
        assert body.get("status") == "draft"
        assert body.get("name") == f"Recovered {TODAY}"
        tid = body.get("id")
        _TO_CLEAN_TASKS.append((staff_sess, tid))

        # Step 4: Owner cannot view staff's task via /api/tasks?date=TODAY
        ro = owner_sess.get(f"{API}/tasks", params={"date": TODAY}, timeout=10)
        assert ro.status_code == 200
        owner_task_ids = [t.get("id") for t in ro.json()]
        assert tid not in owner_task_ids, (
            f"RBAC LEAK: staff's task {tid} visible in owner's task list"
        )
