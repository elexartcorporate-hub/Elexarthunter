"""
Email service: SMTP send + open/click tracking helpers.
"""
import re
import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
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
) -> Dict:
    """Synchronous SMTP send. Returns {ok, error}."""
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f'"{from_name}" <{from_email}>' if from_name else from_email
        msg["To"] = to_email
        # Plain-text fallback (strip HTML tags crudely)
        plain = re.sub(r"<[^>]+>", " ", html_body)
        msg.attach(MIMEText(plain, "plain", "utf-8"))
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        if smtp_use_tls:
            if smtp_port == 465:
                server = smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=20)
            else:
                server = smtplib.SMTP(smtp_host, smtp_port, timeout=20)
                server.ehlo()
                server.starttls()
                server.ehlo()
        else:
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=20)

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
