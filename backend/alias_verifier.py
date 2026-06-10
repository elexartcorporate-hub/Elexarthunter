"""
Alias-Based Email Verification Engine
─────────────────────────────────────
Custom verifier built to replace Hunter.io for ALIAS-generated emails (sales@, gm@, etc.).
Website-discovered emails are inherently trusted ("verified") since they were published on
the official site — they bypass this engine.

Pipeline per candidate:
    1. Syntax  — RFC email format
    2. Domain  — DNS A/AAAA resolves
    3. MX      — MX records exist, provider detected (Google/M365/Zoho/cPanel/Custom)
    4. SMTP    — HELO + MAIL FROM + RCPT TO live conversation
    5. Catch-All — Random@domain RCPT to detect accept-all servers

Confidence score (0-100):
    + 50  public email found on website (set by caller, not by this engine)
    + 30  SMTP responded 250 (deliverable)
    + 10  Email follows a configured alias pattern (set by caller)
    + 10  MX records found
    - 20  Domain is catch-all

Final status:
    VALID         — public-found AND SMTP accepted
    LIKELY_VALID  — alias-generated AND SMTP accepted (not catch-all)
    ACCEPT_ALL    — domain accepts everything (low confidence)
    INVALID       — SMTP rejected (550 etc.)
    UNKNOWN       — no SMTP response (port blocked / greylist / timeout)
"""

from __future__ import annotations
import asyncio
import logging
import os
import random
import re
import socket
import string
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional, Tuple

import dns.asyncresolver
import dns.resolver
import dns.exception

logger = logging.getLogger("alias_verifier")

# RFC-ish — same regex python's email-validator uses, simplified.
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")

# SMTP defaults
HELO_HOST = os.environ.get("VERIFIER_HELO_HOST", "verifier.leadhunter.app")
MAIL_FROM = os.environ.get("VERIFIER_MAIL_FROM", "verify@leadhunter.app")
SMTP_TIMEOUT = float(os.environ.get("VERIFIER_SMTP_TIMEOUT", "8"))

# Provider fingerprints on MX hostname
PROVIDER_HINTS = [
    (re.compile(r"google|googlemail|gmail", re.I), "Google Workspace"),
    (re.compile(r"outlook|protection\.outlook|microsoft", re.I), "Microsoft 365"),
    (re.compile(r"zoho", re.I), "Zoho Mail"),
    (re.compile(r"mxroute|secureserver|hostgator|bluehost|cpanel", re.I), "cPanel / Shared host"),
    (re.compile(r"yandex", re.I), "Yandex Mail"),
    (re.compile(r"amazonses", re.I), "Amazon SES"),
    (re.compile(r"mimecast", re.I), "Mimecast"),
    (re.compile(r"proofpoint|pphosted", re.I), "Proofpoint"),
    (re.compile(r"barracuda", re.I), "Barracuda"),
]


@dataclass
class VerifierResult:
    email: str
    status: str = "UNKNOWN"              # VALID / LIKELY_VALID / ACCEPT_ALL / INVALID / UNKNOWN
    score: int = 0
    syntax_ok: bool = False
    domain_resolves: bool = False
    mx_found: bool = False
    mx_records: List[str] = field(default_factory=list)
    provider: Optional[str] = None
    smtp_code: Optional[int] = None
    smtp_message: Optional[str] = None
    catch_all: bool = False
    public_on_website: bool = False
    alias_match: bool = False
    reasons: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        # Mirror the legacy Hunter.io shape so existing UI fields still light up
        d["result"] = {
            "VALID": "deliverable",
            "LIKELY_VALID": "deliverable",
            "ACCEPT_ALL": "risky",
            "INVALID": "undeliverable",
            "UNKNOWN": "unknown",
        }.get(self.status, "unknown")
        d["accept_all"] = self.catch_all
        d["smtp_check"] = self.smtp_code == 250 if self.smtp_code else None
        return d


def _detect_provider(mx_hosts: List[str]) -> Optional[str]:
    for host in mx_hosts:
        for rx, name in PROVIDER_HINTS:
            if rx.search(host):
                return name
    return mx_hosts[0] if mx_hosts else None


async def _resolve_mx(domain: str) -> Tuple[bool, List[str]]:
    """Return (domain_resolves, mx_hosts_sorted_by_pref)."""
    resolver = dns.asyncresolver.Resolver()
    resolver.lifetime = 5.0
    resolver.timeout = 3.0
    try:
        ans = await resolver.resolve(domain, "MX")
        # Sort by preference ascending — lowest pref = primary
        records = sorted(ans, key=lambda r: r.preference)
        hosts = [str(r.exchange).rstrip(".") for r in records]
        return True, hosts
    except (dns.resolver.NoAnswer, dns.resolver.NXDOMAIN):
        # No MX → fall back to checking domain A record so we know it exists at all
        try:
            await resolver.resolve(domain, "A")
            return True, []
        except Exception:
            return False, []
    except dns.exception.DNSException as e:
        logger.debug(f"MX resolve failed for {domain}: {e}")
        return False, []


async def _smtp_probe(mx_host: str, helo: str, mail_from: str, rcpt_to: str) -> Tuple[Optional[int], Optional[str]]:
    """Open raw SMTP, do HELO/MAIL FROM/RCPT TO, return (code, message).
    Returns (None, None) when port blocked / timeout — caller treats as UNKNOWN.
    Many cloud containers (including this one) block outbound port 25, so failures here are expected."""
    loop = asyncio.get_running_loop()
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(mx_host, 25), timeout=SMTP_TIMEOUT,
        )
    except (asyncio.TimeoutError, ConnectionRefusedError, OSError) as e:
        logger.debug(f"SMTP connect to {mx_host}:25 failed: {e}")
        return None, None

    async def _read() -> str:
        # SMTP responses can span multiple lines (continuation lines start with "<code>-")
        lines = []
        try:
            while True:
                raw = await asyncio.wait_for(reader.readline(), timeout=SMTP_TIMEOUT)
                if not raw:
                    break
                line = raw.decode("utf-8", errors="ignore").strip()
                lines.append(line)
                if len(line) < 4 or line[3] == " ":
                    break
        except asyncio.TimeoutError:
            pass
        return "\n".join(lines)

    async def _cmd(cmd: str) -> Tuple[Optional[int], str]:
        try:
            writer.write((cmd + "\r\n").encode())
            await writer.drain()
            resp = await _read()
        except Exception:
            return None, ""
        code = None
        if resp and len(resp) >= 3 and resp[:3].isdigit():
            code = int(resp[:3])
        return code, resp

    try:
        # Banner
        await _read()
        code, _ = await _cmd(f"EHLO {helo}")
        if not code or code >= 500:
            await _cmd("HELO " + helo)
        await _cmd(f"MAIL FROM:<{mail_from}>")
        code, msg = await _cmd(f"RCPT TO:<{rcpt_to}>")
        await _cmd("QUIT")
        return code, msg
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


def _random_local() -> str:
    n = 16
    return "z" + "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


async def verify_email(
    email: str,
    *,
    public_on_website: bool = False,
    alias_match: bool = False,
    catch_all_cache: Optional[Dict[str, bool]] = None,
) -> VerifierResult:
    """Run the full alias-verification pipeline on a single email.

    `catch_all_cache` is an optional dict keyed by domain to memoize catch-all detection
    across a batch — saves SMTP round-trips when checking many emails on the same domain.
    """
    res = VerifierResult(email=email, public_on_website=public_on_website, alias_match=alias_match)

    # 1) Syntax
    if not EMAIL_RE.match(email):
        res.reasons.append("invalid_syntax")
        res.status = "INVALID"
        return res
    res.syntax_ok = True

    domain = email.split("@", 1)[1].lower()

    # 2/3) Domain + MX
    domain_ok, mx_hosts = await _resolve_mx(domain)
    res.domain_resolves = domain_ok
    res.mx_found = bool(mx_hosts)
    res.mx_records = mx_hosts
    res.provider = _detect_provider(mx_hosts)
    if not domain_ok:
        res.reasons.append("domain_does_not_resolve")
        res.status = "INVALID"
        return res
    if not mx_hosts:
        # Domain resolves but no MX — cannot receive mail
        res.reasons.append("no_mx_records")
        res.status = "INVALID"
        return res

    # 4) SMTP probe — only first MX to keep latency sane
    target_mx = mx_hosts[0]
    code, msg = await _smtp_probe(target_mx, HELO_HOST, MAIL_FROM, email)
    res.smtp_code = code
    res.smtp_message = (msg or "").strip()[:200]

    # 5) Catch-all probe — only if SMTP responded 250 (otherwise we already know)
    if code == 250:
        cached = (catch_all_cache or {}).get(domain)
        if cached is None:
            ca_code, _ = await _smtp_probe(
                target_mx, HELO_HOST, MAIL_FROM,
                f"{_random_local()}@{domain}",
            )
            is_ca = ca_code == 250
            if catch_all_cache is not None:
                catch_all_cache[domain] = is_ca
            res.catch_all = is_ca
        else:
            res.catch_all = cached

    # ─── Score & status ───
    # Re-tuned weights so a clean LIKELY_VALID alias lands around 85–95 (per spec example),
    # ACCEPT_ALL alias around 55–65, INVALID 0–10, UNKNOWN 20.
    score = 0
    if public_on_website:
        score += 50
    if code == 250:
        score += 50          # SMTP accepted = strongest deliverability signal
    if alias_match:
        score += 30          # alias pattern bonus (sales/gm/event configured)
    if res.mx_found:
        score += 15          # MX exists
    if res.catch_all:
        score -= 30          # catch-all = unreliable, penalize harder
    res.score = max(0, min(100, score))

    if code is None:
        res.status = "UNKNOWN"
        res.reasons.append("smtp_no_response_or_port_blocked")
    elif code == 250:
        if res.catch_all:
            res.status = "ACCEPT_ALL"
        elif public_on_website:
            res.status = "VALID"
        else:
            res.status = "LIKELY_VALID"
    elif code in (450, 421, 451):
        res.status = "UNKNOWN"
        res.reasons.append(f"smtp_temp_{code}")
    elif code >= 500:
        res.status = "INVALID"
        res.reasons.append(f"smtp_reject_{code}")
        res.score = min(res.score, 10)   # INVALID → score capped near zero regardless of bonuses
    else:
        res.status = "UNKNOWN"
        res.reasons.append(f"smtp_other_{code}")

    return res


async def verify_emails_bulk(
    emails: List[Tuple[str, dict]],
    *,
    max_concurrency: int = 5,
) -> Dict[str, dict]:
    """Verify a batch of emails. Each item is `(email, meta)` where meta carries:
        - public_on_website: bool
        - alias_match: bool

    Returns `{email: result_dict}` sorted internally by score desc — caller can use
    `sorted(out.values(), key=lambda r: r['score'], reverse=True)` to rank.
    """
    sem = asyncio.Semaphore(max_concurrency)
    catch_all_cache: Dict[str, bool] = {}

    async def _one(item):
        email, meta = item
        async with sem:
            return await verify_email(
                email,
                public_on_website=bool(meta.get("public_on_website")),
                alias_match=bool(meta.get("alias_match")),
                catch_all_cache=catch_all_cache,
            )

    results = await asyncio.gather(*[_one(it) for it in emails], return_exceptions=True)
    out: Dict[str, dict] = {}
    for r in results:
        if isinstance(r, Exception):
            logger.warning(f"verify_emails_bulk: {r}")
            continue
        out[r.email] = r.to_dict()
    return out
