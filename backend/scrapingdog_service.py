"""Scrapingdog integration: search LinkedIn companies via Google SERP + enrich via
LinkedIn Scraper API. Documented at https://docs.scrapingdog.com"""
from __future__ import annotations
import re
from typing import List, Optional, Dict, Any
import httpx

GOOGLE_SERP = "https://api.scrapingdog.com/google"
LINKEDIN_SCRAPER = "https://api.scrapingdog.com/linkedin"


async def search_linkedin_companies(
    *, api_key: str, keyword: str, country: Optional[str] = None, limit: int = 10
) -> Dict[str, Any]:
    """Step 1: Use Google SERP with site:linkedin.com/company operator to discover
    LinkedIn company URLs by keyword. Returns list of candidates without enrichment.
    Cost: ~1 credit per call."""
    if not api_key:
        raise ValueError("Scrapingdog API key not configured")
    query = f"site:linkedin.com/company {keyword.strip()}"
    if country:
        query += f" {country}"
    params = {
        "api_key": api_key,
        "query": query,
        "results": str(min(max(limit, 5), 30)),
    }
    if country:
        params["country"] = _country_code(country)
    async with httpx.AsyncClient(timeout=30.0) as cx:
        r = await cx.get(GOOGLE_SERP, params=params)
    if r.status_code == 401:
        raise RuntimeError("Scrapingdog API key invalid")
    if r.status_code == 429:
        raise RuntimeError("Scrapingdog quota exhausted — top up credits")
    if r.status_code != 200:
        raise RuntimeError(f"Scrapingdog returned {r.status_code}: {r.text[:200]}")
    data = r.json()
    results = []
    seen = set()
    for item in (data.get("organic_results") or [])[:limit]:
        link = item.get("link") or ""
        if "linkedin.com/company/" not in link:
            continue
        slug_m = re.search(r"linkedin\.com/company/([^/?#]+)", link)
        slug = slug_m.group(1).rstrip("/") if slug_m else ""
        if not slug or slug in seen:
            continue
        seen.add(slug)
        title = (item.get("title") or "").strip()
        # Remove " | LinkedIn" / "- LinkedIn" suffix
        title = re.sub(r"\s*[\|\-]\s*LinkedIn\s*$", "", title, flags=re.IGNORECASE).strip()
        results.append({
            "company_name": title or slug.replace("-", " ").title(),
            "website": link,
            "domain": f"linkedin.com/company/{slug}",
            "company_linkedin_url": link,
            "linkedin_slug": slug,
            "snippet": (item.get("snippet") or "")[:300],
            "scrapingdog_serp": True,
        })
    return {"results": results, "credits_used": 1, "raw_query": query}


async def enrich_linkedin_company(
    *, api_key: str, slug_or_url: str
) -> Dict[str, Any]:
    """Step 2: Hit LinkedIn Scraper API with a company slug → return full firmographics
    (industry, HQ, size, description). Cost: ~10 credits per call."""
    if not api_key:
        raise ValueError("Scrapingdog API key not configured")
    # Accept either full URL or just slug
    slug = slug_or_url
    m = re.search(r"linkedin\.com/company/([^/?#]+)", slug_or_url)
    if m:
        slug = m.group(1).rstrip("/")
    params = {
        "api_key": api_key,
        "type": "company",
        "linkId": slug,
        "private": "false",
    }
    async with httpx.AsyncClient(timeout=45.0) as cx:
        r = await cx.get(LINKEDIN_SCRAPER, params=params)
    if r.status_code == 401:
        raise RuntimeError("Scrapingdog API key invalid")
    if r.status_code == 429:
        raise RuntimeError("Scrapingdog quota exhausted")
    if r.status_code == 404:
        return {"ok": False, "reason": "Company not found"}
    if r.status_code != 200:
        raise RuntimeError(f"Scrapingdog returned {r.status_code}")
    data = r.json()
    # Scrapingdog returns an array with single object, normalize
    if isinstance(data, list):
        data = data[0] if data else {}
    # `employee_count` field from API is actually a LIST of employee profiles (bonus!)
    employees_raw = data.get("employee_count") or data.get("employees_list") or []
    employees = []
    if isinstance(employees_raw, list):
        for emp in employees_raw[:15]:  # cap at 15 to limit response size
            employees.append({
                "name": (emp.get("employee_name") or "").strip(),
                "title": (emp.get("employee_position") or "").strip(),
                "linkedin_url": emp.get("employee_profile_url"),
                "photo_url": emp.get("employee_photo"),
            })
    # Try multiple field names for actual count
    size_str = data.get("company_size") or data.get("size") or data.get("employee_count_str") or ""
    return {
        "ok": True,
        "company_name": data.get("company_name") or data.get("name"),
        "company_url": data.get("company_url") or data.get("link"),
        "tagline": data.get("tagline"),
        "industry": data.get("industry"),
        "company_size": size_str if isinstance(size_str, str) else None,
        "headquarters": data.get("headquarters") or data.get("hq"),
        "type": data.get("type") or data.get("company_type"),
        "founded": data.get("founded"),
        "specialties": data.get("specialties"),
        "website": data.get("website") or data.get("external_url"),
        "description": (data.get("description") or data.get("about") or "")[:1500],
        "employees": employees,
        "credits_used": 10,
    }


async def validate_api_key(api_key: str) -> Dict[str, Any]:
    """Cheap validation — 1 credit Google search. Returns {ok, credits_used, sample}."""
    if not api_key:
        return {"ok": False, "reason": "empty key"}
    params = {"api_key": api_key, "query": "linkedin", "results": "1"}
    try:
        async with httpx.AsyncClient(timeout=15.0) as cx:
            r = await cx.get(GOOGLE_SERP, params=params)
        if r.status_code == 200:
            return {"ok": True, "status_code": 200}
        if r.status_code == 401:
            return {"ok": False, "reason": "Invalid API key"}
        if r.status_code == 429:
            return {"ok": False, "reason": "Quota exhausted"}
        return {"ok": False, "reason": f"HTTP {r.status_code}: {r.text[:120]}"}
    except Exception as e:
        return {"ok": False, "reason": str(e)[:200]}


def _country_code(country: str) -> str:
    """Map country name → 2-letter code for Scrapingdog Google geo param."""
    if not country:
        return "us"
    cmap = {
        "indonesia": "id", "singapore": "sg", "malaysia": "my", "thailand": "th",
        "vietnam": "vn", "philippines": "ph", "australia": "au", "japan": "jp",
        "united states": "us", "united kingdom": "gb", "india": "in", "china": "cn",
        "germany": "de", "france": "fr", "spain": "es", "italy": "it",
        "canada": "ca", "mexico": "mx", "brazil": "br", "south korea": "kr",
        "hong kong": "hk", "taiwan": "tw", "new zealand": "nz",
        "united arab emirates": "ae", "saudi arabia": "sa",
    }
    return cmap.get(country.lower(), "us")
