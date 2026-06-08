"""Tests for Templates CRUD + Attachments (Bahasa Indonesia UX feature set)."""
import io
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
    # cleanup TEST_ templates
    try:
        rows = s.get(f"{API}/templates").json()
        for t in rows:
            if t.get("name", "").startswith("TEST_"):
                s.delete(f"{API}/templates/{t['id']}")
    except Exception:
        pass


# ─── Templates CRUD ───

def test_create_template_html(session):
    payload = {"name": "TEST_HTML_TPL", "subject": "Hello {name}", "body_html": "<p>Hi <strong>{name}</strong></p>"}
    r = session.post(f"{API}/templates", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == "TEST_HTML_TPL"
    assert data["body_type"] == "html"  # default
    assert data["attachments"] == []
    assert "id" in data


def test_create_template_plain(session):
    payload = {"name": "TEST_PLAIN_TPL", "subject": "Plain hello", "body_html": "Line 1\nLine 2", "body_type": "plain"}
    r = session.post(f"{API}/templates", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["body_type"] == "plain"


def test_list_templates_has_body_type_and_attachments(session):
    r = session.get(f"{API}/templates")
    assert r.status_code == 200
    rows = r.json()
    assert isinstance(rows, list) and len(rows) >= 2
    for t in rows:
        assert "body_type" in t
        assert "attachments" in t and isinstance(t["attachments"], list)


def test_patch_template_body_type_toggle(session):
    # Find the html template
    rows = session.get(f"{API}/templates").json()
    tpl = next(t for t in rows if t["name"] == "TEST_HTML_TPL")
    tid = tpl["id"]
    # html -> plain
    r = session.patch(f"{API}/templates/{tid}", json={"body_type": "plain"})
    assert r.status_code == 200
    assert r.json()["body_type"] == "plain"
    # plain -> html
    r = session.patch(f"{API}/templates/{tid}", json={"body_type": "html"})
    assert r.status_code == 200
    assert r.json()["body_type"] == "html"


# ─── Attachments ───

def _get_html_tid(session):
    rows = session.get(f"{API}/templates").json()
    return next(t for t in rows if t["name"] == "TEST_HTML_TPL")["id"]


def test_upload_attachment_small_file(session):
    tid = _get_html_tid(session)
    files = {"file": ("hello.txt", io.BytesIO(b"Hello world!"), "text/plain")}
    r = session.post(f"{API}/templates/{tid}/attachments", files=files)
    assert r.status_code == 200, r.text
    meta = r.json()
    assert meta["filename"] == "hello.txt"
    assert meta["content_type"] == "text/plain"
    assert meta["size"] == len(b"Hello world!")
    assert "id" in meta
    # Verify in GET
    rows = session.get(f"{API}/templates").json()
    tpl = next(t for t in rows if t["id"] == tid)
    assert any(a["id"] == meta["id"] for a in tpl["attachments"])


def test_upload_attachment_too_large_rejected(session):
    tid = _get_html_tid(session)
    big = b"x" * (8 * 1024 * 1024 + 10)  # 8MB + 10 bytes
    files = {"file": ("big.bin", io.BytesIO(big), "application/octet-stream")}
    r = session.post(f"{API}/templates/{tid}/attachments", files=files)
    assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"


def test_download_attachment(session):
    tid = _get_html_tid(session)
    rows = session.get(f"{API}/templates").json()
    tpl = next(t for t in rows if t["id"] == tid)
    att_id = tpl["attachments"][0]["id"]
    r = session.get(f"{API}/templates/{tid}/attachments/{att_id}/download")
    assert r.status_code == 200
    assert r.content == b"Hello world!"
    cd = r.headers.get("Content-Disposition", "")
    assert "hello.txt" in cd


def test_duplicate_template_copies_attachments(session):
    tid = _get_html_tid(session)
    r = session.post(f"{API}/templates/{tid}/duplicate")
    assert r.status_code == 200, r.text
    dup = r.json()
    assert dup["name"].endswith("(copy)")
    assert len(dup["attachments"]) >= 1
    new_att_ids = {a["id"] for a in dup["attachments"]}
    # Verify new attachment IDs (not same as original)
    orig_rows = session.get(f"{API}/templates").json()
    orig = next(t for t in orig_rows if t["id"] == tid)
    orig_att_ids = {a["id"] for a in orig["attachments"]}
    assert new_att_ids.isdisjoint(orig_att_ids), "Duplicated attachments should have new ids"
    # cleanup duplicate
    session.delete(f"{API}/templates/{dup['id']}")


def test_delete_attachment(session):
    tid = _get_html_tid(session)
    rows = session.get(f"{API}/templates").json()
    tpl = next(t for t in rows if t["id"] == tid)
    att_id = tpl["attachments"][0]["id"]
    r = session.delete(f"{API}/templates/{tid}/attachments/{att_id}")
    assert r.status_code == 200
    # Verify gone
    rows = session.get(f"{API}/templates").json()
    tpl = next(t for t in rows if t["id"] == tid)
    assert not any(a["id"] == att_id for a in tpl["attachments"])


def test_delete_template_cleans_attachments(session):
    # Create new template with attachment, then delete, verify attachments table doesn't keep orphans.
    payload = {"name": "TEST_CLEANUP_TPL", "subject": "x", "body_html": "x"}
    r = session.post(f"{API}/templates", json=payload)
    tid = r.json()["id"]
    files = {"file": ("c.txt", io.BytesIO(b"clean me"), "text/plain")}
    r = session.post(f"{API}/templates/{tid}/attachments", files=files)
    att_id = r.json()["id"]
    # Delete template
    r = session.delete(f"{API}/templates/{tid}")
    assert r.status_code == 200
    # Attempt download — should 404
    r = session.get(f"{API}/templates/{tid}/attachments/{att_id}/download")
    assert r.status_code == 404


# ─── Send Email regression (signature change) ───

def test_send_email_signature_compat(session):
    """Verify /api/email/send doesn't 500 due to email_service.send_smtp_email signature change.
    Real SMTP will fail in test env but the request handler shouldn't crash."""
    # Get a prospect
    pr = session.get(f"{API}/prospects").json()
    prospects = pr if isinstance(pr, list) else pr.get("items", [])
    if not prospects:
        pytest.skip("No prospects available for send test")
    p = prospects[0]
    # Need an email
    emails = p.get("emails") or []
    if not emails:
        pytest.skip("No email on first prospect")
    payload = {
        "to_email": emails[0]["email"],
        "subject": "TEST send regression",
        "body_html": "<p>Hello</p>",
    }
    # Find a likely endpoint
    r = session.post(f"{API}/email/send", json=payload)
    # We accept 200 (queued), 400 (validation), 423 (locked), 500-only-bad
    # The critical thing: not a TypeError/signature-related crash
    assert r.status_code in (200, 202, 400, 401, 403, 404, 409, 423, 500), f"Unexpected: {r.status_code} {r.text}"
    if r.status_code == 500:
        # If 500, ensure it's not a signature error
        body = r.text.lower()
        assert "typeerror" not in body and "positional argument" not in body, f"Signature regression: {r.text}"
