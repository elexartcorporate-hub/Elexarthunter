"""Regression tests for Mailer-Daemon bounce auto-detection."""
import asyncio
import pytest
from server import (
    _is_bounce_email,
    _parse_bounce_body,
    _mark_bounced_by_email,
    db,
)


def test_is_bounce_email_from_mailer_daemon():
    assert _is_bounce_email("MAILER-DAEMON@mail.example.com", "Some subject")
    assert _is_bounce_email("postmaster@x.com", "")
    assert _is_bounce_email("Mail Delivery System <mailer-daemon@x.com>", "")


def test_is_bounce_email_subject_only():
    assert _is_bounce_email("noreply@x.com", "Undelivered Mail Returned to Sender")
    assert _is_bounce_email("x@x.com", "Delivery Status Notification (Failure)")
    assert _is_bounce_email("x@x.com", "Mail delivery failed: returning message to sender")


def test_is_bounce_email_normal():
    assert not _is_bounce_email("john@example.com", "Hello there")
    assert not _is_bounce_email("sales@vendor.com", "Quote request")


def test_parse_bounce_dsn_hard_bounce():
    sample = b"""From: MAILER-DAEMON@mail.example.com
Subject: Undelivered Mail Returned to Sender
Content-Type: multipart/report; report-type=delivery-status; boundary=BBB

--BBB
Content-Type: text/plain

Your mail to <john@invalid.tld> failed.

--BBB
Content-Type: message/delivery-status

Reporting-MTA: dns; mail.example.com

Final-Recipient: rfc822; john@invalid.tld
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 No such user

--BBB--
"""
    parsed = _parse_bounce_body(sample)
    assert len(parsed) == 1
    email, diag = parsed[0]
    assert email == "john@invalid.tld"
    assert "5.1.1" in diag


def test_parse_bounce_dsn_soft_bounce_skipped():
    sample = b"""Content-Type: multipart/report; boundary=BB

--BB
Content-Type: message/delivery-status

Final-Recipient: rfc822; temp@example.com
Status: 4.4.1

--BB--
"""
    # Soft bounce (4.x.x) should be skipped
    assert _parse_bounce_body(sample) == []


def test_parse_bounce_plain_text_fallback():
    plain = b"""From: postmaster@mail.example.com
Subject: failure notice
Content-Type: text/plain

This is the mail system at example.com.
Your message could not be delivered to <broken@nowhere.tld>.
Remote host said: 550 No such user.
"""
    parsed = _parse_bounce_body(plain)
    assert len(parsed) >= 1
    assert any(e == "broken@nowhere.tld" for e, _ in parsed)


def test_parse_normal_email_returns_empty():
    ok = b"""From: friend@example.com
Subject: Hi
Content-Type: text/plain

Hello!
"""
    assert _parse_bounce_body(ok) == []


@pytest.mark.asyncio
async def test_mark_bounced_by_email_removes_email_and_logs():
    """End-to-end: prospect.emails.email gets pulled, bounced_emails gets upserted.
    Also tests the no-prospect-match case in the same loop to avoid motor's
    cross-test event-loop reuse issue."""
    tenant = await db.tenants.find_one({}, {"_id": 0, "id": 1})
    tid = tenant["id"]
    pid = "TEST-PROSPECT-BOUNCE-REG"
    test_email = "regression-test-bounce@invalid.tld"
    nomatch_email = "no-match-bounce@nowhere.tld"

    # Setup
    await db.prospects.delete_many({"id": pid})
    await db.bounced_emails.delete_many({"email": {"$in": [test_email, nomatch_email]}})
    await db.prospects.insert_one({
        "id": pid, "tenant_id": tid, "company_name": "Reg Co", "domain": "invalid.tld",
        "emails": [
            {"email": test_email, "source": "test"},
            {"email": "keeper@invalid.tld", "source": "test"},
        ],
    })

    try:
        # 1. Matched prospect — removes email + logs bounce
        res = await _mark_bounced_by_email(tid, test_email, "Test 550")
        assert res["matched"] is True
        assert res["prospect_id"] == pid

        p = await db.prospects.find_one({"id": pid}, {"_id": 0, "emails": 1})
        emails_after = [e["email"] for e in p.get("emails", [])]
        assert test_email not in emails_after
        assert "keeper@invalid.tld" in emails_after

        b = await db.bounced_emails.find_one(
            {"tenant_id": tid, "email": test_email}, {"_id": 0}
        )
        assert b is not None
        assert b["error"] == "Test 550"
        assert b["source"] == "mailer-daemon"
        assert b["prospect_id"] == pid

        # 2. No matching prospect — still logged with prospect_id=None
        res2 = await _mark_bounced_by_email(tid, nomatch_email, "550 No user")
        assert res2["matched"] is False
        b2 = await db.bounced_emails.find_one(
            {"tenant_id": tid, "email": nomatch_email}, {"_id": 0}
        )
        assert b2 is not None
        assert b2["prospect_id"] is None
    finally:
        await db.prospects.delete_many({"id": pid})
        await db.bounced_emails.delete_many({"email": {"$in": [test_email, nomatch_email]}})
