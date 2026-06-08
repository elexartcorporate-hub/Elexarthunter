"""
Hunter service: deep crawl (Playwright) + Hunter.io (mock) + merge + scoring.
"""
import re
import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import urljoin, urlparse
from typing import List, Dict, Optional
import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

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
    d = domain.strip().lower()
    d = d.replace("https://", "").replace("http://", "").rstrip("/")
    if d.startswith("www."):
        d = d[4:]
    return d


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


async def _fetch_with_playwright(url: str, timeout: int = 15000) -> Optional[str]:
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
            context = await browser.new_context(user_agent="Mozilla/5.0 (LeadHunterBot)")
            page = await context.new_page()
            await page.goto(url, timeout=timeout, wait_until="domcontentloaded")
            try:
                await page.wait_for_load_state("networkidle", timeout=5000)
            except Exception:
                pass
            html = await page.content()
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
    emails = [e.lower() for e in raw_emails if domain in e.lower().split("@")[-1]]
    # Also include emails matching exact root domain
    emails = list(set(emails))

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
        "phones": phones,
        "whatsapps": whatsapps,
        "socials": socials,
    }


async def playwright_deep_crawl(domain: str, logs: list) -> Dict:
    """Crawl multiple pages and aggregate."""
    domain = _normalize_domain(domain)
    base = f"https://{domain}"
    aggregated = {
        "company_name": None,
        "emails": set(),
        "phones": set(),
        "whatsapps": set(),
        "socials": {},
    }
    pages_scanned = 0
    pages_to_try = [base + p for p in PAGES_TO_CRAWL]

    for url in pages_to_try:
        logs.append(f"  > GET {url}")
        # Prefer Playwright for the homepage (JS-rendered), httpx for the rest (faster)
        html = None
        if url == base or url == base + "/":
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
        aggregated["phones"].update(data["phones"])
        aggregated["whatsapps"].update(data["whatsapps"])
        for k, v in data["socials"].items():
            aggregated["socials"].setdefault(k, v)
        logs.append(f"  > {url} [OK] emails={len(data['emails'])}")

    logs.append(f"  > Crawl complete. Scanned {pages_scanned} pages.")

    return {
        "company_name": aggregated["company_name"] or domain.split(".")[0].capitalize(),
        "emails": sorted(aggregated["emails"]),
        "phones": sorted(aggregated["phones"]),
        "whatsapps": sorted(aggregated["whatsapps"]),
        "socials": aggregated["socials"],
        "pages_scanned": pages_scanned,
    }


# ────────────────────────────────────────────────────────────
#  Hunter.io MOCK
#  Swap this with real API call when you have a key.
# ────────────────────────────────────────────────────────────
def hunter_io_mock(domain: str, logs: list) -> Dict:
    """Realistic mock of Hunter.io /v2/domain-search response."""
    domain = _normalize_domain(domain)
    org = domain.split(".")[0]
    seed_names = [
        ("John", "Smith", "CEO", "executive"),
        ("Sarah", "Johnson", "Head of Marketing", "marketing"),
        ("Michael", "Chen", "VP Engineering", "it"),
        ("Emma", "Williams", "Sales Director", "sales"),
        ("David", "Brown", "HR Manager", "hr"),
        ("Lisa", "Garcia", "Customer Success", "support"),
    ]
    confidences = [95, 88, 82, 76, 71, 65]
    emails = []
    for (fn, ln, pos, dept), conf in zip(seed_names, confidences):
        emails.append({
            "value": f"{fn.lower()}.{ln.lower()}@{domain}",
            "first_name": fn,
            "last_name": ln,
            "position": pos,
            "department": dept,
            "confidence": conf,
            "type": "personal",
            "sources": [
                {"uri": f"https://{domain}/team", "domain": domain, "extracted_on": "2024-11-12"}
            ],
        })
    # generic department emails
    for prefix, conf in [("info", 92), ("contact", 90), ("sales", 85)]:
        emails.append({
            "value": f"{prefix}@{domain}",
            "first_name": None, "last_name": None,
            "position": None, "department": prefix,
            "confidence": conf, "type": "generic",
            "sources": [{"uri": f"https://{domain}/contact", "domain": domain, "extracted_on": "2024-11-12"}],
        })
    logs.append(f"  > Hunter.io [MOCK] returned {len(emails)} emails")
    return {
        "domain": domain,
        "organization": org.capitalize(),
        "country": "US",
        "industry": "Technology",
        "emails": emails,
    }


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


def merge_and_score(crawl_result: Dict, hunter_result: Dict, logs: list) -> Dict:
    """Merge website & hunter results, dedupe by email, compute confidence."""
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
                "confidence_score": _confidence_score("website"),
                "status": "unverified",
            }

    # From hunter
    for em in hunter_result.get("emails", []):
        key = em["value"].lower()
        full_name = " ".join(x for x in [em.get("first_name"), em.get("last_name")] if x) or None
        if key in contacts_map:
            # update with richer info if from hunter
            existing = contacts_map[key]
            if not existing["name"] and full_name:
                existing["name"] = full_name
            if not existing["job_title"] and em.get("position"):
                existing["job_title"] = em["position"]
            # source becomes website (more authoritative) - keep score
        else:
            contacts_map[key] = {
                "email": key,
                "name": full_name,
                "job_title": em.get("position"),
                "department": em.get("department"),
                "source": "hunter",
                "confidence_score": _confidence_score("hunter", em.get("confidence")),
                "status": "unverified",
            }

    contacts = list(contacts_map.values())

    logs.append(f"  > Merged {len(contacts)} unique contacts (dedupe done)")
    logs.append(f"  > Confidence scoring applied")

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


async def run_hunter_workflow(domain: str) -> Dict:
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
        crawl_result = await playwright_deep_crawl(domain, logs)
        steps.append({"name": "Playwright Deep Crawl", "status": "ok"})
    except Exception as e:
        logs.append(f"  > ERROR: {e}")
        crawl_result = {"company_name": None, "emails": [], "phones": [], "whatsapps": [], "socials": {}, "pages_scanned": 0}
        steps.append({"name": "Playwright Deep Crawl", "status": "error"})

    # Step 3: Hunter.io
    logs.append(f"> [STEP 3] Hunter.io domain search (MOCK)")
    hunter_result = hunter_io_mock(domain, logs)
    steps.append({"name": "Hunter.io Domain Search [MOCK]", "status": "ok"})

    # Step 4 + 5: Merge + scoring
    logs.append(f"> [STEP 4] Merging & deduplicating results")
    merged = merge_and_score(crawl_result, hunter_result, logs)
    steps.append({"name": "Data Merge", "status": "ok"})
    steps.append({"name": "Confidence Scoring", "status": "ok"})

    logs.append(f"> [DONE] {len(merged['contacts'])} contacts ready to save")
    return {
        "logs": logs,
        "steps": steps,
        "company": merged["company"],
        "contacts": merged["contacts"],
    }
