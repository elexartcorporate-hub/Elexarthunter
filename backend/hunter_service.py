"""
Hunter service: deep crawl (Playwright) + Hunter.io REAL API + verifier + merge + scoring.
"""
import os
import re
import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse
from typing import List, Dict, Optional
import httpx
from bs4 import BeautifulSoup

from alias_verifier import verify_emails_bulk as alias_verify_bulk

logger = logging.getLogger(__name__)

HUNTER_API_KEY = os.environ.get("HUNTER_API_KEY", "")
HUNTER_BASE = "https://api.hunter.io/v2"

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"(?:\+?\d{1,3}[\s\-]?)?(?:\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{3,4}")
WHATSAPP_RE = re.compile(r"(?:wa\.me|whatsapp\.com)/(\+?\d+)")
SOCIAL_DOMAINS = {
    "linkedin": "linkedin.com",
    "facebook": "facebook.com",
    "instagram": "instagram.com",
    "twitter": "twitter.com",
    "youtube": "youtube.com",
}
GENERIC_EMAIL_PREFIXES = {"info", "contact", "hello", "support", "sales", "admin", "office", "team", "marketing", "hr", "career", "careers", "jobs"}
PAGES_TO_CRAWL = ["/", "/contact", "/contact-us", "/about", "/about-us", "/team", "/careers", "/career", "/jobs"]


def _normalize_domain(domain: str) -> str:
    """Strip protocol, www, path, and trailing slash. Keeps subdomain (e.g. id.villabalimanagement.com)."""
    d = domain.strip().lower()
    d = d.replace("https://", "").replace("http://", "")
    # Strip path/query if user pasted a full URL
    d = d.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    if d.startswith("www."):
        d = d[4:]
    return d.rstrip("/")


def _extract_extra_path(raw: str) -> Optional[str]:
    """If the user pasted a URL with a path (e.g. https://example.com/contact-us), return
    that path so the crawler can hit it directly — often the page they want to see is
    the one they pasted. Returns None for bare domains."""
    s = raw.strip().lower()
    s = s.replace("https://", "").replace("http://", "")
    if "/" not in s:
        return None
    path = "/" + s.split("/", 1)[1]
    path = path.split("?", 1)[0].split("#", 1)[0].rstrip("/")
    return path if path and path != "/" else None


async def _fetch_with_httpx(url: str, timeout: int = 10) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True,
                                    headers={"User-Agent": "Mozilla/5.0 (LeadHunterBot)"}) as client:
            r = await client.get(url)
            if r.status_code == 200 and "text/html" in r.headers.get("content-type", ""):
                return r.text
    except Exception as e:
        logger.debug(f"httpx fetch failed {url}: {e}")
    return None


async def _fetch_with_playwright(url: str, timeout: int = 20000) -> Optional[str]:
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
            context = await browser.new_context(user_agent="Mozilla/5.0 (LeadHunterBot)")
            page = await context.new_page()
            await page.goto(url, timeout=timeout, wait_until="domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
            # Scroll to bottom in smaller steps so lazy-loaded sections (Wix footer
            # contact widgets etc.) get a chance to hydrate. Run 2 passes to be sure.
            try:
                for _ in range(2):
                    await page.evaluate(
                        "async () => { "
                        "let last = 0; "
                        "while (last < document.body.scrollHeight) { "
                        "  last = document.body.scrollHeight; "
                        "  window.scrollTo(0, document.body.scrollHeight); "
                        "  await new Promise(r => setTimeout(r, 600)); "
                        "} }"
                    )
                    await page.wait_for_timeout(1200)
            except Exception:
                pass
            # Collect HTML from main frame + all iframes (Wix often wraps contact widgets
            # inside cross-origin iframes that aren't reflected in page.content()).
            html = await page.content()
            for frame in page.frames:
                try:
                    if frame == page.main_frame:
                        continue
                    fhtml = await frame.content()
                    if fhtml:
                        html += "\n<!-- iframe -->\n" + fhtml
                except Exception:
                    pass
            await browser.close()
            return html
    except Exception as e:
        logger.warning(f"playwright fetch failed {url}: {e}")
        return None


def _extract_from_html(html: str, domain: str) -> Dict:
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(" ", strip=True)

    # Emails (filter to ones matching the domain to avoid noise)
    raw_emails = set(EMAIL_RE.findall(text))
    # Also pull mailto: links
    for a in soup.select('a[href^="mailto:"]'):
        href = a.get("href", "").replace("mailto:", "").split("?")[0].strip()
        if href:
            raw_emails.add(href)

    # Categorise emails: domain-match (primary) vs external (still found on the site
    # but using a sibling/sub-brand domain — e.g. pactoltd.com publishes info@pactodmc.com).
    # External emails are kept and exposed separately so we don't silently discard real
    # contacts just because the brand uses multiple domains.
    primary_emails: List[str] = []
    external_emails: List[str] = []
    NOISE_DOMAIN_SUFFIXES = (
        ".wixpress.com", ".sentry.io", ".sentry-next.wixpress.com",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    )
    VERSION_RE = re.compile(r"^\d+(\.\d+){1,3}$")  # 1.2.3 or 1.2.3.4
    for e in raw_emails:
        e_lower = e.lower()
        if "@" not in e_lower:
            continue
        local, _, email_domain = e_lower.partition("@")
        if not email_domain or not local:
            continue
        # Filter noise — JS bundles, sentry IDs, npm versions (e.g. react@18.3.1)
        if VERSION_RE.match(email_domain):
            continue
        if any(email_domain.endswith(suf) for suf in NOISE_DOMAIN_SUFFIXES):
            continue
        # Hex-blob local-part 24+ chars without dot/dash → probably an asset hash
        if len(local) >= 24 and re.fullmatch(r"[a-f0-9]+", local):
            continue
        if domain in email_domain:
            primary_emails.append(e_lower)
        else:
            external_emails.append(e_lower)
    emails = list(set(primary_emails))
    externals = list(set(external_emails))

    # Phones - very loose
    phones = list({p.strip() for p in PHONE_RE.findall(text) if len(re.sub(r"\D", "", p)) >= 8})[:5]

    # WhatsApp links
    whatsapps = list({m.group(1) for m in WHATSAPP_RE.finditer(html)})

    # Social links
    socials = {}
    for a in soup.select("a[href]"):
        href = a.get("href", "")
        for name, sd in SOCIAL_DOMAINS.items():
            if sd in href and name not in socials:
                socials[name] = href

    # Company name guess: <title>, meta og:site_name, h1
    company_name = None
    if soup.title and soup.title.string:
        company_name = soup.title.string.strip().split("|")[0].split("-")[0].strip()
    og = soup.find("meta", property="og:site_name")
    if og and og.get("content"):
        company_name = og["content"].strip()

    return {
        "company_name": company_name,
        "emails": emails,
        "external_emails": externals,
        "phones": phones,
        "whatsapps": whatsapps,
        "socials": socials,
    }


async def playwright_deep_crawl(domain: str, logs: list, extra_path: Optional[str] = None) -> Dict:
    """Crawl multiple pages and aggregate. If user pasted a URL with a specific path
    (e.g. /contact-us), we crawl THAT path first — it's usually the most contact-rich page."""
    domain = _normalize_domain(domain)
    base = f"https://{domain}"
    aggregated = {
        "company_name": None,
        "emails": set(),
        "external_emails": set(),
        "phones": set(),
        "whatsapps": set(),
        "socials": {},
    }
    pages_scanned = 0
    # Start with the user-specified path (if any) so it's never skipped, then default pages
    pages_to_try = []
    if extra_path:
        pages_to_try.append(base + extra_path)
    pages_to_try += [base + p for p in PAGES_TO_CRAWL if (base + p) not in pages_to_try]

    for url in pages_to_try:
        logs.append(f"  > GET {url}")
        # Try Playwright (JS-rendered) FIRST so we capture emails injected dynamically by
        # Wix/Squarespace/React/etc. Fallback to httpx (plain HTTP, ~5× faster) when
        # Playwright misses. This is critical for modern sites where footer/contact emails
        # only appear after JS hydration.
        html = await _fetch_with_playwright(url)
        if not html:
            html = await _fetch_with_httpx(url)
        if not html:
            logs.append(f"  > {url} [SKIP]")
            continue
        pages_scanned += 1
        data = _extract_from_html(html, domain)
        if data["company_name"] and not aggregated["company_name"]:
            aggregated["company_name"] = data["company_name"]
        aggregated["emails"].update(data["emails"])
        aggregated["external_emails"].update(data.get("external_emails") or [])
        aggregated["phones"].update(data["phones"])
        aggregated["whatsapps"].update(data["whatsapps"])
        for k, v in data["socials"].items():
            aggregated["socials"].setdefault(k, v)
        logs.append(f"  > {url} [OK] emails={len(data['emails'])} external={len(data.get('external_emails') or [])}")

    logs.append(f"  > Crawl complete. Scanned {pages_scanned} pages.")

    return {
        "company_name": aggregated["company_name"] or domain.split(".")[0].capitalize(),
        "emails": sorted(aggregated["emails"]),
        "external_emails": sorted(aggregated["external_emails"]),
        "phones": sorted(aggregated["phones"]),
        "whatsapps": sorted(aggregated["whatsapps"]),
        "socials": aggregated["socials"],
        "pages_scanned": pages_scanned,
    }


# ────────────────────────────────────────────────────────────
#  Hunter.io REAL API
# ────────────────────────────────────────────────────────────
async def hunter_io_search(domain: str, logs: list) -> Dict:
    """Real Hunter.io domain-search call. Falls back to empty result if API key missing or call fails."""
    if not HUNTER_API_KEY:
        logs.append("  > Hunter.io API key missing in env, skipping")
        return {"domain": domain, "organization": None, "country": None, "industry": None, "emails": []}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                f"{HUNTER_BASE}/domain-search",
                params={"domain": domain, "api_key": HUNTER_API_KEY, "limit": 25},
            )
            if r.status_code == 429:
                logs.append("  > Hunter.io rate-limited (429) — proceeding without Hunter data")
                return {"domain": domain, "organization": None, "country": None, "industry": None, "emails": []}
            r.raise_for_status()
            payload = r.json().get("data", {}) or {}
    except httpx.HTTPStatusError as e:
        code = e.response.status_code if e.response else "?"
        body = (e.response.text if e.response is not None else "")[:200]
        logs.append(f"  > Hunter.io HTTP {code}: {body}")
        return {"domain": domain, "organization": None, "country": None, "industry": None, "emails": []}
    except Exception as e:
        logs.append(f"  > Hunter.io error: {e} — proceeding without Hunter data")
        return {"domain": domain, "organization": None, "country": None, "industry": None, "emails": []}

    raw_emails = payload.get("emails") or []
    emails = []
    for em in raw_emails:
        emails.append({
            "value": (em.get("value") or "").lower(),
            "first_name": em.get("first_name"),
            "last_name": em.get("last_name"),
            "position": em.get("position"),
            "department": em.get("department"),
            "confidence": em.get("confidence"),
            "type": em.get("type"),
            "sources": em.get("sources") or [],
            "linkedin": em.get("linkedin"),
            "phone_number": em.get("phone_number"),
        })
    logs.append(f"  > Hunter.io returned {len(emails)} emails (organization='{payload.get('organization')}')")
    return {
        "domain": domain,
        "organization": payload.get("organization"),
        "country": payload.get("country"),
        "industry": payload.get("industry"),
        "emails": emails,
    }


async def hunter_io_verify(email: str, max_polls: int = 3, poll_delay: float = 2.0) -> Dict:
    """Hunter.io email-verifier — best-effort. Hunter sometimes returns HTTP 202 ("still pending")
    when the SMTP check is async; we poll up to `max_polls` times with `poll_delay`s between."""
    if not HUNTER_API_KEY or not email:
        return {}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(40.0, connect=10.0)) as client:
            data = None
            for attempt in range(max_polls):
                r = await client.get(
                    f"{HUNTER_BASE}/email-verifier",
                    params={"email": email, "api_key": HUNTER_API_KEY},
                )
                if r.status_code == 200:
                    data = (r.json().get("data") or {})
                    break
                if r.status_code == 202:
                    # Pending — wait and retry
                    if attempt < max_polls - 1:
                        await asyncio.sleep(poll_delay)
                        continue
                    logger.warning(f"verifier still pending for {email} after {max_polls} polls")
                    return {}
                logger.warning(f"verifier non-200 for {email}: {r.status_code} {r.text[:120]}")
                return {}
        if not data:
            return {}
        return {
            "status": data.get("status"),
            "result": data.get("result"),
            "score": data.get("score"),
            "disposable": data.get("disposable"),
            "webmail": data.get("webmail"),
            "smtp_check": data.get("smtp_check"),
            "accept_all": data.get("accept_all"),
            "block": data.get("block"),
        }
    except Exception as e:
        logger.warning(f"verifier failed for {email}: {e}")
        return {}


async def verify_emails_bulk(emails: List[str], logs: list, max_concurrency: int = 5) -> Dict[str, Dict]:
    if not emails or not HUNTER_API_KEY:
        return {}
    sem = asyncio.Semaphore(max_concurrency)

    async def _one(e):
        async with sem:
            return e, await hunter_io_verify(e)

    out = {}
    results = await asyncio.gather(*[_one(e) for e in emails], return_exceptions=True)
    for r in results:
        if isinstance(r, Exception):
            continue
        e, v = r
        if v:
            out[e] = v
    logs.append(f"  > Verifier ran on {len(emails)}, got results for {len(out)}")
    return out


def _confidence_score(source: str, hunter_confidence: Optional[int] = None) -> int:
    if source == "website":
        return 100
    if hunter_confidence is None:
        return 70
    if hunter_confidence >= 90:
        return 95
    if hunter_confidence >= 80:
        return 85
    return 70


def merge_and_score(crawl_result: Dict, hunter_result: Dict, logs: list, aliases: Optional[List[str]] = None) -> Dict:
    """Merge website & hunter results, dedupe by email, compute confidence.
    Tags each contact with `_sources` (set of sources) so the caller knows which emails
    are cross-validated (found in both) and can skip the verifier on those.
    Also injects 3 mandatory generic aliases (sales/gm/event) for the domain, unless they
    already appear in the merged set."""
    domain = hunter_result["domain"]
    company_name = crawl_result.get("company_name") or hunter_result.get("organization") or domain

    contacts_map = {}  # email -> contact dict (lowercased key)

    # From website crawl
    for em in crawl_result.get("emails", []):
        key = em.lower()
        if key not in contacts_map:
            local = key.split("@")[0]
            is_generic = local in GENERIC_EMAIL_PREFIXES
            contacts_map[key] = {
                "email": key,
                "name": None,
                "job_title": None,
                "department": local if is_generic else None,
                "source": "website",
                "_sources": {"website"},
                "confidence_score": _confidence_score("website"),
                "status": "unverified",
            }

    # From website crawl — EXTERNAL emails (different domain, but published on this site)
    # e.g. pactoltd.com lists info@pactodmc.com on its contact page — clearly a real contact
    # belonging to a sibling brand. Treat as "website_external" with strong confidence.
    for em in crawl_result.get("external_emails", []):
        key = em.lower()
        if key in contacts_map:
            continue
        local = key.split("@")[0]
        is_generic = local in GENERIC_EMAIL_PREFIXES
        contacts_map[key] = {
            "email": key,
            "name": None,
            "job_title": None,
            "department": local if is_generic else None,
            "source": "website_external",   # found on site, but uses sibling/sub-brand domain
            "_sources": {"website_external"},
            "confidence_score": 90,         # high — explicitly published on the official site
            "status": "verified",
        }

    # From hunter
    for em in hunter_result.get("emails", []):
        key = em["value"].lower()
        full_name = " ".join(x for x in [em.get("first_name"), em.get("last_name")] if x) or None
        if key in contacts_map:
            existing = contacts_map[key]
            if not existing["name"] and full_name:
                existing["name"] = full_name
            if not existing["job_title"] and em.get("position"):
                existing["job_title"] = em["position"]
            existing["_sources"].add("hunter")
            # Cross-validated: bump score to max
            existing["confidence_score"] = 100
        else:
            contacts_map[key] = {
                "email": key,
                "name": full_name,
                "job_title": em.get("position"),
                "department": em.get("department"),
                "source": "hunter",
                "_sources": {"hunter"},
                "confidence_score": _confidence_score("hunter", em.get("confidence")),
                "status": "unverified",
            }

    # Inject mandatory dummy aliases for this category — only if not already present
    alias_list = aliases if aliases is not None else ["sales", "gm", "event"]
    for alias in alias_list:
        key = f"{alias}@{domain}"
        if key not in contacts_map:
            contacts_map[key] = {
                "email": key,
                "name": None,
                "job_title": None,
                "department": alias,
                "source": "alias",
                "_sources": {"alias"},
                "confidence_score": 50,
                "status": "unverified",
            }

    contacts = list(contacts_map.values())

    cross = sum(1 for c in contacts if len(c["_sources"]) > 1)
    logs.append(f"  > Merged {len(contacts)} unique contacts ({cross} cross-validated, skip verifier)")

    company = {
        "company_name": company_name,
        "domain": domain,
        "industry": hunter_result.get("industry"),
        "country": hunter_result.get("country"),
        "phones": crawl_result.get("phones", []),
        "whatsapps": crawl_result.get("whatsapps", []),
        "socials": crawl_result.get("socials", {}),
    }
    return {"company": company, "contacts": contacts}


async def run_hunter_workflow(domain: str, aliases: Optional[List[str]] = None, extra_path: Optional[str] = None) -> Dict:
    """
    Full pipeline. Returns:
      {
        "logs": ["...", ...],
        "steps": [{"name": "...", "status": "ok|skip|error"}, ...],
        "company": {...},
        "contacts": [...]
      }
    """
    domain = _normalize_domain(domain)
    logs: List[str] = []
    steps: List[Dict] = []

    # Step 2: Playwright crawl
    logs.append(f"> [STEP 2] Playwright deep crawl: {domain}")
    try:
        crawl_result = await playwright_deep_crawl(domain, logs, extra_path=extra_path)
        steps.append({"name": "Playwright Deep Crawl", "status": "ok"})
    except Exception as e:
        logs.append(f"  > ERROR: {e}")
        crawl_result = {"company_name": None, "emails": [], "phones": [], "whatsapps": [], "socials": {}, "pages_scanned": 0}
        steps.append({"name": "Playwright Deep Crawl", "status": "error"})

    # Step 3: Hunter.io (REAL)
    logs.append(f"> [STEP 3] Hunter.io domain search (REAL API)")
    hunter_result = await hunter_io_search(domain, logs)
    steps.append({"name": "Hunter.io Domain Search", "status": "ok" if HUNTER_API_KEY else "skip"})

    # Step 4: Merge & dedupe (with category-aware aliases)
    logs.append(f"> [STEP 4] Merging & deduplicating results (aliases: {aliases or 'default'})")
    merged = merge_and_score(crawl_result, hunter_result, logs, aliases=aliases)
    steps.append({"name": "Data Merge", "status": "ok"})
    steps.append({"name": "Confidence Scoring", "status": "ok"})

    # Step 5: Alias-Based Email Verifier — own engine (no Hunter.io for this step).
    # Pipeline per email: syntax → DNS → MX → SMTP HELO/MAIL/RCPT → catch-all probe.
    # Score: +50 website, +30 SMTP-250, +10 alias-match, +10 MX, -20 catch-all (0..100).
    # Cross-validated contacts already trusted → skip to save SMTP round-trips.
    to_verify_items = []
    for c in merged["contacts"]:
        sources = c.get("_sources") or set()
        if len(sources) > 1:
            continue  # cross-validated, no need
        meta = {
            "public_on_website": c.get("source") == "website",
            "alias_match": c.get("source") == "alias",
        }
        to_verify_items.append((c["email"], meta))

    skipped = len(merged["contacts"]) - len(to_verify_items)
    logs.append(f"> [STEP 5] Alias Verifier on {len(to_verify_items)} email(s) ({skipped} skipped — cross-validated)")
    verify_map = await alias_verify_bulk(to_verify_items, max_concurrency=5)

    for c in merged["contacts"]:
        sources = c.get("_sources") or set()
        # Cross-validated (website + hunter) → highest trust
        if len(sources) > 1:
            c["status"] = "verified"
        # Website-only emails are inherently verified (published on official site = real)
        elif c.get("source") in ("website", "website_external"):
            c["status"] = "verified"

        v = verify_map.get(c["email"])
        if v:
            # Map new engine status → legacy UI status.
            # ACCEPT_ALL is the tricky one: SMTP accepted but server is catch-all so we
            # can't prove a specific user exists. We differentiate by SOURCE:
            #   - source=website  → alias was actually printed on the company site → verified
            #   - source=hunter   → Hunter.io domain-search returned it → verified
            #   - source=alias    → only auto-injected pattern, never seen elsewhere
            #                       → "unverified" (sendable but no per-user proof)
            engine_status = v.get("status")
            source = c.get("source")
            if engine_status == "VALID":
                new_status = "verified"
            elif engine_status == "LIKELY_VALID":
                new_status = "verified"
            elif engine_status == "ACCEPT_ALL":
                new_status = "verified" if source in ("website", "website_external", "hunter") else "unverified"
            elif engine_status == "INVALID":
                new_status = "invalid"
            else:  # UNKNOWN or missing
                new_status = "unverified"
            # Website source NEVER downgrades — site publication is the strongest signal
            if c.get("source") == "website":
                if new_status in ("verified",):
                    c["status"] = "verified"
                # else keep "verified" from earlier block
            else:
                c["status"] = new_status

            # Score: INVALID forces low score (override), otherwise take the higher
            engine_score = v.get("score") or 0
            engine_status = v.get("status") or ""
            if engine_status == "INVALID":
                c["confidence_score"] = int(engine_score)
            elif isinstance(engine_score, (int, float)) and engine_score:
                c["confidence_score"] = max(c.get("confidence_score") or 0, int(engine_score))
            c["verifier"] = v

    # Convert _sources set → list so the contact serializes to JSON / MongoDB cleanly
    for c in merged["contacts"]:
        c["sources_list"] = sorted(list(c.pop("_sources", set())))

    # Sort contacts by confidence_score desc so the BEST email is always first
    merged["contacts"].sort(key=lambda c: (c.get("confidence_score") or 0), reverse=True)

    steps.append({"name": "Alias Verifier", "status": "ok"})

    logs.append(f"> [DONE] {len(merged['contacts'])} contacts ready to save")
    return {
        "logs": logs,
        "steps": steps,
        "company": merged["company"],
        "contacts": merged["contacts"],
    }
