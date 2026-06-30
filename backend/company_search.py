"""Company search aggregator — DuckDuckGo HTML scraping. No API key needed.
Used by LinkedIn module to discover companies by keyword (e.g. 'Hotel Bali').
"""
from __future__ import annotations

import re
from typing import List, Optional
from urllib.parse import urlparse, parse_qs, unquote

import httpx
from bs4 import BeautifulSoup

DDG_URL = "https://html.duckduckgo.com/html/"
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Domains to skip — directories, social platforms, generic news sites
SKIP_DOMAINS = {
    "wikipedia.org", "facebook.com", "twitter.com", "x.com", "instagram.com",
    "youtube.com", "tiktok.com", "linkedin.com", "tripadvisor.com",
    "booking.com", "agoda.com", "expedia.com", "trivago.com", "kayak.com",
    "yelp.com", "yellowpages.com", "reddit.com", "quora.com",
}


def _domain(url: str) -> str:
    try:
        p = urlparse(url)
        return (p.netloc or "").lower().lstrip("www.")
    except Exception:
        return ""


def _is_company_site(url: str, domain: str) -> bool:
    if not domain or "." not in domain:
        return False
    for skip in SKIP_DOMAINS:
        if domain == skip or domain.endswith("." + skip):
            return False
    return True


def _clean_ddg_redirect(href: str) -> str:
    """DDG wraps results in /l/?uddg=<encoded-url>. Extract real URL."""
    if not href:
        return ""
    if href.startswith("//duckduckgo.com/l/?"):
        href = "https:" + href
    try:
        if "duckduckgo.com/l/" in href:
            qs = parse_qs(urlparse(href).query)
            if "uddg" in qs:
                return unquote(qs["uddg"][0])
    except Exception:
        pass
    return href


async def search_companies(
    keyword: str,
    *,
    country: Optional[str] = None,
    limit: int = 20,
    linkedin_only: bool = False,
    li_session: Optional[dict] = None,
) -> List[dict]:
    """Search companies. If linkedin_only=True with valid li_session, uses LinkedIn
    Voyager API directly (returns real LinkedIn company pages). Otherwise web search."""
    if not keyword or not keyword.strip():
        return []
    query = keyword.strip()
    if country and country.lower() not in query.lower():
        query = f"{query} {country}"

    # LinkedIn Native Mode — Voyager API requires cookie
    if linkedin_only and li_session and li_session.get("li_at"):
        try:
            rows = await _search_linkedin_voyager(query, limit, li_session)
            if rows:
                return [{**r, "country": country or None} for r in rows]
        except Exception:
            pass  # Fall through to web search

    rows: List[dict] = []
    # Yahoo first (most reliable from VPS/cloud IPs)
    try:
        rows = await _search_yahoo(query, limit, linkedin_only=linkedin_only)
    except Exception:
        rows = []
    # Fallback to DuckDuckGo
    if not rows:
        try:
            rows = await _search_ddg(query, limit)
            if linkedin_only:
                rows = [r for r in rows if "linkedin.com/company" in r.get("website", "")]
        except Exception:
            pass
    # Final fallback: Bing
    if not rows:
        try:
            rows = await _search_bing(query, limit)
            if linkedin_only:
                rows = [r for r in rows if "linkedin.com/company" in r.get("website", "")]
        except Exception as e:
            if not rows:
                raise RuntimeError(f"All search engines failed: {e}")

    rows = [{**r, "country": country or None} for r in rows]
    return rows


async def _search_linkedin_voyager(query: str, limit: int, li_session: dict) -> List[dict]:
    """LinkedIn Voyager API native company typeahead search. Returns real LinkedIn
    company pages with proper names, industry, location. REQUIRES valid li_at + JSESSIONID."""
    li_at = (li_session.get("li_at") or "").strip()
    jsess_raw = (li_session.get("jsessionid") or "").strip().strip('"')
    if not li_at or not jsess_raw:
        raise RuntimeError("li_at + JSESSIONID required for LinkedIn Native mode")
    csrf = jsess_raw  # csrf-token MUST equal JSESSIONID value (without quotes)
    cookies = {"li_at": li_at, "JSESSIONID": f'"{jsess_raw}"'}
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "application/vnd.linkedin.normalized+json+2.1",
        "Accept-Language": "en-US,en;q=0.9",
        "csrf-token": csrf,
        "x-li-lang": "en_US",
        "x-restli-protocol-version": "2.0.0",
        "Referer": "https://www.linkedin.com/search/results/companies/",
    }
    url = "https://www.linkedin.com/voyager/api/typeahead/hitsV2"
    params = {"keywords": query, "q": "type", "type": "COMPANY", "count": str(min(limit, 20))}
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=False, cookies=cookies, headers=headers) as cx:
        r = await cx.get(url, params=params)
    if r.status_code in (401, 403):
        raise RuntimeError(f"LinkedIn session expired or invalid (HTTP {r.status_code})")
    if r.status_code != 200:
        raise RuntimeError(f"LinkedIn voyager returned {r.status_code}")
    import json as _json
    try:
        data = _json.loads(r.text)
    except Exception:
        raise RuntimeError("LinkedIn returned non-JSON response")
    results = []
    elements = data.get("elements") or (data.get("data") or {}).get("elements") or []
    for el in elements[:limit]:
        title = ((el.get("title") or {}).get("text") or "").strip()
        subtitle = ((el.get("subtitle") or {}).get("text") or "").strip()
        nav = el.get("navigationUrl") or ""
        urn = el.get("trackingUrn") or el.get("targetUrn") or ""
        # Build LinkedIn URL from urn if navigationUrl missing
        if not nav and "urn:li:company:" in urn:
            company_id = urn.split(":")[-1]
            nav = f"https://www.linkedin.com/company/{company_id}/"
        if not title or "linkedin.com" not in nav:
            continue
        # Subtitle usually contains "Industry • Location"
        industry = subtitle.split("•")[0].strip() if "•" in subtitle else ""
        location = subtitle.split("•", 1)[1].strip() if "•" in subtitle else ""
        slug_m = re.search(r"linkedin\.com/company/([^/?#]+)", nav)
        slug = slug_m.group(1) if slug_m else title.lower().replace(" ", "-")
        results.append({
            "company_name": title[:80],
            "website": nav,
            "domain": f"linkedin.com/company/{slug}",
            "snippet": subtitle[:300],
            "industry": industry[:80] if industry else None,
            "city": location[:80] if location else None,
            "linkedin_native": True,
        })
    return results


async def _search_yahoo(query: str, limit: int, *, linkedin_only: bool = False) -> List[dict]:
    """Yahoo Search HTML scraping — most reliable from cloud IPs."""
    url = "https://search.yahoo.com/search"
    params = {"p": query, "n": str(limit * 3)}
    # Rotate UA to reduce rate-limiting
    import random
    uas = [
        "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36",
        "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
    ]
    headers = {
        "User-Agent": random.choice(uas),
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as cx:
        r = await cx.get(url, params=params, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"Yahoo returned {r.status_code}")
    soup = BeautifulSoup(r.text, "lxml")
    results = []
    seen_domains = set()
    for div in soup.select("div.algo")[: limit * 3]:
        a = div.find("a", href=True)
        if not a:
            continue
        raw_href = a.get("href", "")
        # Yahoo wraps real URL in /RU=<encoded-url>/RK=…
        m = re.search(r"/RU=([^/]+)", raw_href)
        href = unquote(m.group(1)) if m else raw_href
        if not href.startswith("http"):
            continue
        # Yahoo title format examples (messy):
        #   "domain.comhttps://en.wikipedia.org › wiki › X<ACTUAL TITLE>"
        #   "Ballco Manufacturing Co Inc."
        title_raw = (a.get_text() or "").strip()
        # Strip "<domain.tld>https://<url>"  prefix
        title = re.sub(r"^\s*[\w\.-]+\.[a-z]{2,}\s*https?://\S+\s*", "", title_raw)
        # Strip breadcrumb arrows " › path › path"
        title = re.sub(r"\s*›[^›]*?(?=\s[A-Z])", "", title)
        title = re.sub(r"\s*›\s*\S+\s*", " ", title).strip()
        # Strip leading punctuation/dashes
        title = re.sub(r"^[\-\|–—:\s]+", "", title).strip()
        sn = div.select_one("p, .compText, span.fc-9th")
        snippet = ((sn.get_text() if sn else "") or "").strip()[:300]
        domain = _domain(href)
        # When linkedin_only mode, keep LinkedIn URLs (default SKIP_DOMAINS excludes it)
        if linkedin_only:
            if "linkedin.com/company" not in href:
                continue
            slug_m = re.search(r"linkedin\.com/company/([^/?#]+)", href)
            dedup_key = slug_m.group(1).lower() if slug_m else href
            if dedup_key in seen_domains:
                continue
            seen_domains.add(dedup_key)
        else:
            if not _is_company_site(href, domain) or domain in seen_domains:
                continue
            seen_domains.add(domain)
        # Final company name cleanup: prefer text before pipe/dash separator
        company_name = re.sub(r"\s*[\|\-–—]\s*.*$", "", title).strip()
        # Fallback: capitalize domain
        if not company_name or len(company_name) < 3:
            company_name = domain.split(".")[0].title()
        if len(company_name) > 80:
            company_name = company_name[:80].rstrip()
        results.append({"company_name": company_name, "website": href, "domain": domain, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


async def _search_ddg(query: str, limit: int) -> List[dict]:
    params = {"q": query, "kl": "wt-wt"}
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml"}
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as cx:
        r = await cx.post(DDG_URL, data=params, headers=headers)
    if r.status_code != 200 or "<!DOCTYPE html>" not in r.text[:100] or "duckduckgo" not in r.text[:5000].lower():
        return []  # Likely blocked / cloudflare
    soup = BeautifulSoup(r.text, "lxml")
    return _parse_ddg(soup, limit)


def _parse_ddg(soup: BeautifulSoup, limit: int) -> List[dict]:
    results = []
    seen_domains = set()
    for res in soup.select(".result")[: limit * 3]:
        a = res.select_one(".result__a")
        sn = res.select_one(".result__snippet")
        if not a:
            continue
        href = _clean_ddg_redirect(a.get("href", ""))
        title = (a.get_text() or "").strip()
        snippet = (sn.get_text() if sn else "").strip()[:300]
        domain = _domain(href)
        if not _is_company_site(href, domain) or domain in seen_domains:
            continue
        seen_domains.add(domain)
        company_name = re.sub(r"\s*[\|\-–—]\s*.*$", "", title).strip() or title or domain
        if len(company_name) > 80:
            company_name = company_name[:80].rstrip()
        results.append({"company_name": company_name, "website": href, "domain": domain, "snippet": snippet})
        if len(results) >= limit:
            break
    return results


async def _search_bing(query: str, limit: int) -> List[dict]:
    """Bing HTML scraping as fallback."""
    url = "https://www.bing.com/search"
    params = {"q": query, "count": str(limit * 3)}
    headers = {"User-Agent": UA, "Accept": "text/html,application/xhtml+xml",
               "Accept-Language": "en-US,en;q=0.9"}
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as cx:
        r = await cx.get(url, params=params, headers=headers)
    if r.status_code != 200:
        raise RuntimeError(f"Bing returned {r.status_code}")
    soup = BeautifulSoup(r.text, "lxml")
    results = []
    seen_domains = set()
    for li in soup.select("li.b_algo")[: limit * 3]:
        a = li.select_one("h2 a")
        if not a:
            continue
        href = a.get("href", "")
        title = (a.get_text() or "").strip()
        sn = li.select_one("p, .b_caption p")
        snippet = (sn.get_text() if sn else "").strip()[:300]
        domain = _domain(href)
        if not _is_company_site(href, domain) or domain in seen_domains:
            continue
        seen_domains.add(domain)
        company_name = re.sub(r"\s*[\|\-–—]\s*.*$", "", title).strip() or title or domain
        if len(company_name) > 80:
            company_name = company_name[:80].rstrip()
        results.append({"company_name": company_name, "website": href, "domain": domain, "snippet": snippet})
        if len(results) >= limit:
            break
    return results
