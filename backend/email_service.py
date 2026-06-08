"""
Email service: SMTP send + open/click tracking helpers.
Anti-spam best practices: List-Unsubscribe, Message-ID, Date, MIME-Version,
X-Mailer, proper Content-Transfer-Encoding, plain-text fallback.
"""
import re
import logging
import smtplib
import base64
import socket
import uuid
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email.utils import make_msgid, formatdate, formataddr
from email import encoders
from typing import Dict, List, Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)

TRACK_PIXEL_TMPL = '<img src="{base}/api/track/open/{recipient_id}" width="1" height="1" alt="" style="display:none" />'
LINK_RE = re.compile(r'(<a\s+[^>]*href=")(https?://[^"]+)(")', re.IGNORECASE)


def inject_tracking(html_body: str, recipient_id: str, public_base_url: str) -> str:
    """Wrap every <a href> with our click-tracking redirect and append a 1×1 open pixel."""
    def repl(m):
        prefix, original_url, suffix = m.group(1), m.group(2), m.group(3)
        tracked = f"{public_base_url}/api/track/click/{recipient_id}?u={quote(original_url, safe='')}"
        return f"{prefix}{tracked}{suffix}"
    body = LINK_RE.sub(repl, html_body)
    body += TRACK_PIXEL_TMPL.format(base=public_base_url, recipient_id=recipient_id)
    return body


def _build_msgid(from_email: str) -> str:
    domain = from_email.split("@")[-1] if "@" in from_email else "localhost"
    return make_msgid(domain=domain)


def _html_to_text(html: str) -> str:
    """Crude HTML→text fallback (kept simple, but good enough to satisfy spam filters
    that require a real text/plain alternative)."""
    text = re.sub(r"<br\s*/?>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"</p\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</li\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    # Collapse whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _wrap_html(body_html: str, plain_fallback: str) -> str:
    """Ensure HTML has proper structure (doctype/html/head/body) to reduce spam score."""
    bl = body_html.lower()
    if "<html" in bl and "<body" in bl:
        return body_html
    return (
        "<!DOCTYPE html>\n<html lang=\"en\"><head>"
        "<meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>Message</title>"
        "</head><body>" + body_html + "</body></html>"
    )


def send_smtp_email(
    smtp_host: str,
    smtp_port: int,
    smtp_user: str,
    smtp_password: str,
    smtp_use_tls: bool,
    from_email: str,
    from_name: Optional[str],
    to_email: str,
    subject: str,
    html_body: str,
    body_type: str = "html",  # "html" | "plain"
    attachments: Optional[List[Dict]] = None,  # [{filename, content_type, data_b64}]
    list_unsubscribe_url: Optional[str] = None,
    reply_to: Optional[str] = None,
) -> Dict:
    """Synchronous SMTP send with attachments + anti-spam headers. Returns {ok, error}."""
    try:
        # Top-level multipart/mixed when attachments present, else multipart/alternative.
        has_attachments = bool(attachments)
        alt = MIMEMultipart("alternative")
        if body_type == "plain":
            plain = html_body
            alt.attach(MIMEText(plain, "plain", "utf-8"))
        else:
            plain = _html_to_text(html_body)
            wrapped = _wrap_html(html_body, plain)
            alt.attach(MIMEText(plain or " ", "plain", "utf-8"))
            alt.attach(MIMEText(wrapped, "html", "utf-8"))

        if has_attachments:
            msg = MIMEMultipart("mixed")
            msg.attach(alt)
            for a in attachments:
                try:
                    part = MIMEBase(*(a.get("content_type") or "application/octet-stream").split("/", 1)) \
                        if "/" in (a.get("content_type") or "") else MIMEBase("application", "octet-stream")
                    part.set_payload(base64.b64decode(a["data_b64"]))
                    encoders.encode_base64(part)
                    part.add_header(
                        "Content-Disposition",
                        f'attachment; filename="{a.get("filename", "file.bin")}"',
                    )
                    msg.attach(part)
                except Exception as e:
                    logger.warning("Failed to attach %s: %s", a.get("filename"), e)
        else:
            msg = alt

        # Headers that improve deliverability / lower spam score
        msg["Subject"] = subject
        msg["From"] = formataddr((from_name or "", from_email))
        msg["To"] = to_email
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = _build_msgid(from_email)
        msg["MIME-Version"] = "1.0"
        msg["X-Mailer"] = "LeadHunter CRM"
        if reply_to:
            msg["Reply-To"] = reply_to
        if list_unsubscribe_url:
            msg["List-Unsubscribe"] = f"<{list_unsubscribe_url}>"
            msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
        msg["Auto-Submitted"] = "auto-generated"
        # Precedence helps mark transactional/marketing email properly
        # (avoid 'bulk' which some filters dislike; use 'list' if marketing)
        # We leave it absent to default to normal precedence.

        socket.setdefaulttimeout(25)
        if smtp_use_tls and smtp_port == 465:
            server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=25)
        else:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=25)
            if smtp_use_tls:
                server.ehlo(); server.starttls(); server.ehlo()

        if smtp_user:
            server.login(smtp_user, smtp_password)
        server.sendmail(from_email, [to_email], msg.as_string())
        server.quit()
        return {"ok": True, "error": None}
    except Exception as e:
        logger.exception("SMTP send failed")
        return {"ok": False, "error": str(e)}


# 1×1 transparent GIF for open-tracking pixel
PIXEL_GIF = bytes.fromhex(
    "47494638396101000100800000ffffff00000021f90401000000002c00000000010001000002024401003b"
)
