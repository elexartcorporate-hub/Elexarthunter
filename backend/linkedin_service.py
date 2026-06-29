"""
LinkedIn Prospect module — backend logic + AI integrations.

Uses Emergent LLM key:
  - Claude Sonnet 4.5 (claude-sonnet-4-5-20250929)  → company research (deep, structured)
  - Gemini 3 Flash (gemini-3-flash-preview)         → message generation (fast, cheap)

NOTE: This module NEVER logs into LinkedIn, never sends invitations, never sends messages.
It only stores prospects, generates copy for sales to manually paste, and tracks pipeline.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Literal

from emergentintegrations.llm.chat import LlmChat, UserMessage

EMERGENT_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

# ─── Pipeline stages ──────────────────────────────────────────────────────
PIPELINE_STAGES = [
    "added",          # Just created
    "researched",     # AI research done
    "dm_added",       # Decision maker added
    "ready",          # Ready to Connect
    "connect_sent",   # Mark Connect Sent clicked
    "accepted",       # Connection accepted
    "conversation",   # First message sent / reply received
    "follow_up",      # Following up
    "meeting",        # Meeting scheduled/done
    "quotation",      # Quote sent
    "won",
    "lost",
]


def _strip_json(s: str) -> str:
    """Extract first {...} JSON object from LLM output (handles ```json fences)."""
    if not s:
        return "{}"
    m = re.search(r"\{[\s\S]*\}", s)
    return m.group(0) if m else s


async def research_company(*, prospect_id: str, company_name: str, website: Optional[str],
                            industry: Optional[str], country: Optional[str],
                            city: Optional[str]) -> dict:
    """Generate company research JSON via Claude Sonnet 4.5. Synchronous (non-streaming).
    Returns dict with: summary, category, products[], services[], size_estimate,
    opportunity[], lead_score (0-100)."""
    if not EMERGENT_KEY:
        raise RuntimeError("EMERGENT_LLM_KEY missing")
    sys_msg = (
        "You are a B2B sales intelligence analyst. Given a company's basic info, "
        "produce a concise structured research brief for a salesperson to use as conversation context. "
        "Be specific, avoid fluff, and never invent facts you don't know — write 'unknown' instead. "
        "Always reply with a single JSON object only, no prose, no markdown fences."
    )
    user_txt = (
        f"Company: {company_name}\n"
        f"Website: {website or '(unknown)'}\n"
        f"Industry: {industry or '(unknown)'}\n"
        f"Country: {country or '(unknown)'}\n"
        f"City: {city or '(unknown)'}\n\n"
        "Return JSON with exactly these keys:\n"
        "  summary (string, 2-3 sentences),\n"
        "  category (string, business category),\n"
        "  products (array of 3-6 short strings, may be empty),\n"
        "  services (array of 3-6 short strings, may be empty),\n"
        "  size_estimate (string, e.g. 'Small 10-50' or 'Enterprise 500+'),\n"
        "  opportunity (array of 3-6 short strings — concrete sales angles),\n"
        "  lead_score (integer 0-100 based on fit + reachability)."
    )
    chat = LlmChat(
        api_key=EMERGENT_KEY,
        session_id=f"li-research-{prospect_id}",
        system_message=sys_msg,
    ).with_model("anthropic", "claude-sonnet-4-5-20250929")
    out = await chat.send_message(UserMessage(text=user_txt))
    raw = out if isinstance(out, str) else getattr(out, "content", str(out))
    try:
        return json.loads(_strip_json(raw))
    except Exception:
        return {
            "summary": raw[:600],
            "category": industry or "Unknown",
            "products": [],
            "services": [],
            "size_estimate": "Unknown",
            "opportunity": [],
            "lead_score": 50,
            "_parse_failed": True,
        }


async def generate_message(*, prospect_id: str, kind: Literal["connection_note","ice_breaker","first_message","follow_up"],
                            prospect: dict, dm: dict, custom_hint: Optional[str] = None) -> str:
    """Generate one LinkedIn copy via Gemini 3 Flash (fast & cheap).
    kind controls the template. Returns plain text (no JSON).
    """
    if not EMERGENT_KEY:
        raise RuntimeError("EMERGENT_LLM_KEY missing")

    rules = {
        "connection_note": (
            "Write a LinkedIn CONNECTION NOTE in Bahasa Indonesia (or English if recipient is non-Indonesian based on country). "
            "Max 280 characters total. Friendly, professional, ONE specific reason to connect. "
            "Reference the company's industry or product. NO sales pitch. NO emojis. NO 'I hope this finds you well'."
        ),
        "ice_breaker": (
            "Write a SHORT ice-breaker DM (1-3 sentences) to send AFTER a LinkedIn connection is accepted. "
            "Friendly, casual, mention 1 thing specific about their company/role. NO pitch. End with an open question. "
            "Use Bahasa Indonesia if Indonesia, otherwise English."
        ),
        "first_message": (
            "Write a FIRST OUTREACH message (3-5 short paragraphs) to send via LinkedIn DM. "
            "Open with personalization → identify 1 specific business need based on their company info → "
            "soft value-prop tied to that need → end with a low-friction CTA (15-min chat or 'what do you think?'). "
            "No hard sell. Use Bahasa Indonesia if Indonesia, otherwise English."
        ),
        "follow_up": (
            "Write a FOLLOW-UP message (2-3 sentences) for someone who hasn't replied yet. "
            "Tone: light, no pressure, add 1 new angle / value snippet they may have missed. "
            "End with a yes/no friendly question. Bahasa Indonesia if Indonesia, else English."
        ),
    }
    if kind not in rules:
        raise ValueError(f"Invalid kind: {kind}")

    company_info = json.dumps({
        "name": prospect.get("company_name"),
        "website": prospect.get("website"),
        "industry": prospect.get("industry"),
        "country": prospect.get("country"),
        "city": prospect.get("city"),
        "summary": (prospect.get("research") or {}).get("summary"),
        "opportunity": (prospect.get("research") or {}).get("opportunity"),
        "products": (prospect.get("research") or {}).get("products"),
        "services": (prospect.get("research") or {}).get("services"),
    }, ensure_ascii=False)
    dm_info = json.dumps({
        "name": dm.get("full_name"),
        "title": dm.get("job_title"),
        "department": dm.get("department"),
    }, ensure_ascii=False)

    user_txt = (
        f"COMPANY: {company_info}\n\n"
        f"DECISION MAKER: {dm_info}\n\n"
        f"CUSTOM HINT (optional): {custom_hint or '(none)'}\n\n"
        f"TASK: {rules[kind]}\n\n"
        "Return ONLY the message text. No quotes, no preamble, no explanation."
    )
    chat = LlmChat(
        api_key=EMERGENT_KEY,
        session_id=f"li-msg-{prospect_id}-{kind}",
        system_message="You are a senior B2B sales copywriter. Output ONLY the requested message text.",
    ).with_model("gemini", "gemini-3-flash-preview")
    out = await chat.send_message(UserMessage(text=user_txt))
    text = out if isinstance(out, str) else getattr(out, "content", str(out))
    text = (text or "").strip()
    # Strip leading/trailing quotes if model wrapped output
    if text and text[0] in '"\'' and text[-1] in '"\'':
        text = text[1:-1].strip()
    return text
