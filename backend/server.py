"""
Lead Hunter & Email Marketing Platform — FastAPI backend.
Multi-tenant SaaS with JWT auth, Hunter workflow, email campaigns + tracking.
"""
from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent / ".env")

import os
import re
import uuid
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Literal, Dict, Any

import bcrypt
import jwt
from fastapi import FastAPI, APIRouter, HTTPException, Request, Depends, Response, Query, BackgroundTasks
from fastapi.responses import RedirectResponse, Response as FastAPIResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field

from hunter_service import run_hunter_workflow, _normalize_domain
from email_service import send_smtp_email, inject_tracking, PIXEL_GIF


# ────────────────────────────────────────────────────────────
# Config
# ────────────────────────────────────────────────────────────
MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALG = os.environ.get("JWT_ALGORITHM", "HS256")
ACCESS_EXPIRE_MIN = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "1440"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "")
GLOBAL_CACHE_DAYS = 30

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s - %(message)s")
logger = logging.getLogger("leadhunter")

app = FastAPI(title="Lead Hunter API")
api = APIRouter(prefix="/api")


# ────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_pw(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode(), hashed.encode())
    except Exception:
        return False


def create_access_token(user_id: str, tenant_id: str, role: str, email: str) -> str:
    payload = {
        "sub": user_id,
        "tenant_id": tenant_id,
        "role": role,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=ACCESS_EXPIRE_MIN),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def strip_id(doc: dict) -> dict:
    if doc and "_id" in doc:
        doc.pop("_id", None)
    return doc


async def get_current_user(request: Request) -> dict:
    token = None
    # 1. Authorization header
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
    # 2. cookie fallback
    if not token:
        token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(401, "Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
    user = await db.users.find_one({"id": payload["sub"]})
    if not user:
        raise HTTPException(401, "User not found")
    return strip_id(user)


def require_role(*roles: str):
    async def _checker(user: dict = Depends(get_current_user)):
        if user["role"] not in roles:
            raise HTTPException(403, f"Requires role: {', '.join(roles)}")
        return user
    return _checker


# ────────────────────────────────────────────────────────────
# Pydantic models
# ────────────────────────────────────────────────────────────
class RegisterReq(BaseModel):
    name: str
    email: EmailStr
    password: str = Field(min_length=6)
    company_name: str

class LoginReq(BaseModel):
    email: EmailStr
    password: str

class InviteUserReq(BaseModel):
    name: str
    email: EmailStr
    password: str = Field(min_length=6)
    role: str = Field(min_length=1)


class UpdateUserReq(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    role: Optional[str] = None
    sub_company_ids: Optional[List[str]] = None
    daily_target: Optional[int] = Field(default=None, ge=0, le=10000)
    smtp_use_company: Optional[bool] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = None
    smtp_from_email: Optional[EmailStr] = None
    smtp_from_name: Optional[str] = None

class HunterSearchReq(BaseModel):
    domain: str
    force_refresh: bool = False
    category_id: Optional[str] = None


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    permissions: List[str] = []


class RoleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    permissions: Optional[List[str]] = None


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    aliases: Optional[List[str]] = None  # generic email prefixes auto-injected per search in this category


class CategoryUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[List[str]] = None


class LocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class MyLeadAdd(BaseModel):
    company_id: str
    contact_ids: List[str] = Field(min_length=1)
    category_id: Optional[str] = None
    location_id: Optional[str] = None
    notes: Optional[str] = None


class SubCompanyCreate(BaseModel):
    name: str
    legal_name: Optional[str] = None
    phone: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = True
    smtp_from_email: Optional[EmailStr] = None
    smtp_from_name: Optional[str] = None
    email_provider: Optional[Literal["zoho", "gmail", "other"]] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_ssl: Optional[bool] = True
    imap_user: Optional[str] = None
    imap_password: Optional[str] = None


class SubCompanyUpdate(BaseModel):
    name: Optional[str] = None
    legal_name: Optional[str] = None
    phone: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = None
    smtp_from_email: Optional[EmailStr] = None
    smtp_from_name: Optional[str] = None
    email_provider: Optional[Literal["zoho", "gmail", "other"]] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    imap_ssl: Optional[bool] = None
    imap_user: Optional[str] = None
    imap_password: Optional[str] = None


class SmtpTestReq(BaseModel):
    to_email: EmailStr


# ─── CRM Prospect models ───
PROSPECT_STATUSES = ["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"]
EMAIL_STATUSES = ["verified", "risky", "invalid"]


class ProspectEmail(BaseModel):
    email: EmailStr
    is_primary: bool = False
    # Allow "unverified" (catch-all alias or no SMTP response) — sendable with caveat.
    # "invalid" is also allowed at the schema level so we can persist them in My Leads
    # (e.g. for blacklist tracking), but the front-end disables selection by default.
    status: Literal["verified", "risky", "unverified", "invalid"] = "risky"
    confidence: Optional[int] = None
    source: Optional[str] = None  # website / website_external / hunter / alias / manual


class ProspectCreate(BaseModel):
    company_name: str
    website: Optional[str] = None
    domain: Optional[str] = None
    industry: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    phone: Optional[str] = None
    linkedin: Optional[str] = None
    emails: List[ProspectEmail] = []
    notes: Optional[str] = None
    sub_company_id: Optional[str] = None
    assigned_user_id: Optional[str] = None
    category_id: Optional[str] = None
    location_id: Optional[str] = None
    status: Literal["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"] = "New"


class ProspectUpdate(BaseModel):
    company_name: Optional[str] = None
    website: Optional[str] = None
    domain: Optional[str] = None
    industry: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    phone: Optional[str] = None
    linkedin: Optional[str] = None
    notes: Optional[str] = None
    sub_company_id: Optional[str] = None
    assigned_user_id: Optional[str] = None
    category_id: Optional[str] = None
    location_id: Optional[str] = None
    status: Optional[Literal["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"]] = None


class ProspectEmailAdd(BaseModel):
    email: EmailStr
    is_primary: bool = False
    status: Literal["verified", "risky", "unverified", "invalid"] = "risky"


class TemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    subject: str
    body_html: str
    body_type: Literal["html", "plain"] = "html"


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    body_html: Optional[str] = None
    body_type: Optional[Literal["html", "plain"]] = None


class SendEmailReq(BaseModel):
    to_email: EmailStr
    subject: str
    body_html: str
    template_id: Optional[str] = None
    sub_company_id: Optional[str] = None  # overrides default smtp profile
    scheduled_at: Optional[str] = None    # ISO timestamp


class BulkSendEmailReq(BaseModel):
    prospect_ids: List[str] = Field(min_length=1)
    subject: str
    body_html: str
    template_id: Optional[str] = None
    sub_company_id: Optional[str] = None
    scheduled_at: Optional[str] = None


class DailyTargetUpdate(BaseModel):
    daily_target: int = Field(ge=0, le=10000)


class NoteAdd(BaseModel):
    text: str = Field(min_length=1, max_length=5000)


class WorkingConfigUpdate(BaseModel):
    working_days: Optional[List[Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]]] = None
    holidays: Optional[List[str]] = None  # ISO YYYY-MM-DD list


# ─── Outreach Task models ───
class OutreachTaskCreate(BaseModel):
    date: str  # YYYY-MM-DD
    target: Optional[int] = Field(default=None, ge=1, le=200)
    name: Optional[str] = None
    notes: Optional[str] = None


class OutreachTaskUpdate(BaseModel):
    name: Optional[str] = None
    notes: Optional[str] = None
    target: Optional[int] = Field(default=None, ge=1, le=200)


class OutreachTaskSubmit(BaseModel):
    template_id: Optional[str] = None
    subject: str
    body_html: str
    sub_company_id: Optional[str] = None
    send_mode: Literal["now", "scheduled"] = "now"
    scheduled_send_at: Optional[str] = None  # ISO datetime UTC


# ─── Permission catalog (frontend uses these keys to filter menus) ───
ALL_PERMISSIONS = [
    {"key": "dashboard",          "label": "View Dashboard",                    "menu": True},
    {"key": "prospects",          "label": "Prospects (CRM)",                   "menu": True},
    {"key": "email_activity",     "label": "Email Activity tracker",            "menu": True},
    {"key": "templates",          "label": "Email Templates",                   "menu": True},
    {"key": "inbox",              "label": "Inbox (IMAP)",                      "menu": True},
    {"key": "settings",           "label": "Settings page access",              "menu": True},
    {"key": "manage_users",       "label": "Add / edit / delete users",         "menu": False},
    {"key": "manage_roles",       "label": "Create / edit / delete roles",      "menu": False},
    {"key": "manage_company",     "label": "Edit company info & SMTP",          "menu": False},
    {"key": "manage_api_keys",    "label": "Edit Hunter.io API key",            "menu": False},
    {"key": "delete_prospects",   "label": "Delete prospects",                  "menu": False},
    {"key": "send_emails",        "label": "Send emails to prospects",          "menu": False},
    {"key": "set_team_targets",   "label": "Set daily targets for team",        "menu": False},
    {"key": "bypass_daily_lock",  "label": "Bypass daily quota lock",           "menu": False},
]
PERMISSION_KEYS = {p["key"] for p in ALL_PERMISSIONS}

DEFAULT_ROLES = [
    {
        "name": "Owner",
        "is_system": True,
        "permissions": [p["key"] for p in ALL_PERMISSIONS],  # all
    },
    {
        "name": "Admin",
        "is_system": True,
        "permissions": [
            "dashboard", "prospects", "email_activity", "templates", "inbox", "settings",
            "manage_users", "manage_company", "manage_api_keys",
            "delete_prospects", "send_emails", "set_team_targets", "bypass_daily_lock",
        ],
    },
    {
        "name": "Staff",
        "is_system": True,
        "permissions": [
            "dashboard", "prospects", "email_activity", "templates", "inbox", "send_emails",
        ],
    },
]


async def ensure_tenant_roles(tenant_id: str):
    """Seed default roles if not exist, and keep system role permissions in sync with DEFAULT_ROLES."""
    for r in DEFAULT_ROLES:
        existing = await db.roles.find_one({"tenant_id": tenant_id, "name": r["name"]})
        if not existing:
            await db.roles.insert_one({
                "id": str(uuid.uuid4()),
                "tenant_id": tenant_id,
                "name": r["name"],
                "permissions": r["permissions"],
                "is_system": r["is_system"],
                "created_at": now_iso(),
            })
        elif existing.get("is_system"):
            # Keep system role permissions in sync (idempotent migration)
            await db.roles.update_one(
                {"id": existing["id"]},
                {"$set": {"permissions": r["permissions"], "is_system": True}},
            )


async def get_user_permissions(user: dict) -> List[str]:
    """Return list of permission keys for this user (based on their role doc)."""
    await ensure_tenant_roles(user["tenant_id"])
    role = await db.roles.find_one({"tenant_id": user["tenant_id"], "name": user["role"]})
    return list(role.get("permissions", [])) if role else []


def require_permission(*perm_keys: str):
    async def _checker(user: dict = Depends(get_current_user)):
        # Owner shortcut: always allow
        if user.get("role") == "Owner":
            return user
        perms = await get_user_permissions(user)
        for p in perm_keys:
            if p not in perms:
                raise HTTPException(403, f"Missing permission: {p}")
        return user
    return _checker


class BulkSearchReq(BaseModel):
    domains: List[str]

class CompanyUpdate(BaseModel):
    company_name: Optional[str] = None
    industry: Optional[str] = None
    country: Optional[str] = None
    phone: Optional[str] = None
    whatsapp: Optional[str] = None
    linkedin: Optional[str] = None
    facebook: Optional[str] = None
    instagram: Optional[str] = None

class ContactCreate(BaseModel):
    company_id: str
    email: EmailStr
    name: Optional[str] = None
    job_title: Optional[str] = None
    source: Literal["website", "hunter", "manual"] = "manual"
    confidence_score: int = 70
    status: Literal["active", "unverified", "invalid"] = "unverified"

class ContactUpdate(BaseModel):
    name: Optional[str] = None
    job_title: Optional[str] = None
    status: Optional[Literal["active", "unverified", "invalid"]] = None

class CampaignCreate(BaseModel):
    name: str
    subject: str
    body_html: str
    from_name: Optional[str] = None
    from_email: Optional[EmailStr] = None
    schedule_at: Optional[str] = None  # ISO date or None
    sub_company_id: Optional[str] = None      # which SMTP profile to use
    recipient_source: Literal["my_leads", "contacts", "manual"] = "contacts"
    contact_ids: List[str] = []               # used when source=contacts
    my_lead_ids: List[str] = []               # used when source=my_leads
    manual_emails: List[str] = []             # used when source=manual (raw addresses)
    filter_industry: Optional[str] = None
    filter_country: Optional[str] = None
    filter_min_score: Optional[int] = None

class CampaignSendReq(BaseModel):
    send_now: bool = True

class SettingsUpdate(BaseModel):
    company_name: Optional[str] = None
    legal_name: Optional[str] = None
    phone: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = None
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = None
    smtp_from_email: Optional[EmailStr] = None
    smtp_from_name: Optional[str] = None
    hunter_api_key: Optional[str] = None
    scrapingdog_api_key: Optional[str] = None  # LinkedIn search via Google SERP


# ────────────────────────────────────────────────────────────
# Startup: indexes
# ────────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("tenant_id")
    await db.tenants.create_index("id", unique=True)
    await db.companies.create_index([("tenant_id", 1), ("domain", 1)], unique=True)
    await db.contacts.create_index([("tenant_id", 1), ("email", 1)], unique=True)
    await db.contacts.create_index("company_id")
    await db.global_hunter_cache.create_index("domain", unique=True)
    await db.searches.create_index("tenant_id")
    await db.searches.create_index("user_id")
    await db.campaigns.create_index("tenant_id")
    await db.campaign_recipients.create_index("campaign_id")
    await db.categories.create_index([("tenant_id", 1), ("name", 1)], unique=True)
    await db.locations.create_index([("tenant_id", 1), ("name", 1)], unique=True)
    await db.my_leads.create_index([("tenant_id", 1), ("user_id", 1), ("contact_id", 1)], unique=True)
    # ─── CRM collections ───
    await db.prospects.create_index([("tenant_id", 1), ("domain", 1)])
    await db.prospects.create_index([("tenant_id", 1), ("status", 1)])
    await db.prospects.create_index([("tenant_id", 1), ("created_at", -1)])
    await db.prospect_activity.create_index([("prospect_id", 1), ("created_at", -1)])
    await db.email_templates.create_index([("tenant_id", 1), ("name", 1)])
    await db.email_sends.create_index([("tenant_id", 1), ("status", 1)])
    await db.email_sends.create_index([("tenant_id", 1), ("created_at", -1)])
    await db.email_sends.create_index("prospect_id")
    await db.outreach_tasks.create_index([("tenant_id", 1), ("user_id", 1), ("date", -1)])
    await db.outreach_tasks.create_index([("user_id", 1), ("status", 1)])
    logger.info("Indexes ready. DB=%s", DB_NAME)


# ────────────────────────────────────────────────────────────
# AUTH
# ────────────────────────────────────────────────────────────
@api.post("/auth/register")
async def register(payload: RegisterReq, response: Response):
    email = payload.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(400, "Email already registered")
    tenant_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    tenant_doc = {
        "id": tenant_id,
        "company_name": payload.company_name,
        "legal_name": "",
        "phone": "",
        "subscription_plan": "free",
        "status": "active",
        "created_at": now_iso(),
        # default empty settings:
        "smtp_host": None, "smtp_port": 587, "smtp_user": None, "smtp_password": None,
        "smtp_use_tls": True, "smtp_from_email": None, "smtp_from_name": payload.company_name,
        "hunter_api_key": None,
    }
    user_doc = {
        "id": user_id,
        "tenant_id": tenant_id,
        "name": payload.name,
        "email": email,
        "password_hash": hash_pw(payload.password),
        "role": "Owner",
        "smtp_use_company": True,
        "smtp_host": None, "smtp_port": 587, "smtp_user": None, "smtp_password": None,
        "smtp_use_tls": True, "smtp_from_email": None, "smtp_from_name": None,
        "created_at": now_iso(),
    }
    await db.tenants.insert_one(tenant_doc)
    await db.users.insert_one(user_doc)
    await ensure_tenant_roles(tenant_id)
    token = create_access_token(user_id, tenant_id, "Owner", email)
    response.set_cookie("access_token", token, httponly=True, samesite="lax", max_age=ACCESS_EXPIRE_MIN * 60, path="/")
    return {
        "token": token,
        "user": {
            "id": user_id, "name": payload.name, "email": email,
            "role": "Owner", "tenant_id": tenant_id,
            "permissions": [p["key"] for p in ALL_PERMISSIONS],  # Owner = all
        },
        "tenant": {"id": tenant_id, "company_name": payload.company_name},
    }


@api.post("/auth/login")
async def login(payload: LoginReq, response: Response):
    email = payload.email.lower().strip()
    user = await db.users.find_one({"email": email})
    if not user or not verify_pw(payload.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    tenant = await db.tenants.find_one({"id": user["tenant_id"]})
    perms = await get_user_permissions(user)
    token = create_access_token(user["id"], user["tenant_id"], user["role"], email)
    response.set_cookie("access_token", token, httponly=True, samesite="lax", max_age=ACCESS_EXPIRE_MIN * 60, path="/")
    return {
        "token": token,
        "user": {
            "id": user["id"], "name": user["name"], "email": email,
            "role": user["role"], "tenant_id": user["tenant_id"],
            "permissions": perms,
        },
        "tenant": {"id": tenant["id"], "company_name": tenant["company_name"]} if tenant else None,
    }


@api.post("/auth/logout")
async def logout(response: Response):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@api.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    tenant = await db.tenants.find_one({"id": user["tenant_id"]})
    perms = await get_user_permissions(user)
    # Fetch fresh target fields from DB (user dict from auth dep may not have them)
    fresh = await db.users.find_one(
        {"id": user["id"]},
        {"_id": 0, "daily_target": 1, "linkedin_daily_target": 1, "sub_company_ids": 1},
    ) or {}
    return {
        "user": {
            "id": user["id"], "name": user["name"], "email": user["email"],
            "role": user["role"], "tenant_id": user["tenant_id"],
            "permissions": perms,
            "daily_target": fresh.get("daily_target"),
            "linkedin_daily_target": fresh.get("linkedin_daily_target"),
            "sub_company_ids": fresh.get("sub_company_ids"),
        },
        "tenant": strip_id(tenant) if tenant else None,
    }


# ────────────────────────────────────────────────────────────
# ROLES MANAGEMENT
# ────────────────────────────────────────────────────────────
@api.get("/permissions")
async def list_permissions(user: dict = Depends(get_current_user)):
    """Catalog of all available permission keys & their labels."""
    return ALL_PERMISSIONS


@api.get("/roles")
async def list_roles(user: dict = Depends(get_current_user)):
    await ensure_tenant_roles(user["tenant_id"])
    rows = await db.roles.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("created_at", 1).to_list(100)
    # attach user_count for each role
    for r in rows:
        r["user_count"] = await db.users.count_documents({"tenant_id": user["tenant_id"], "role": r["name"]})
    return rows


@api.post("/roles")
async def create_role(payload: RoleCreate, user: dict = Depends(require_permission("manage_roles"))):
    name = payload.name.strip()
    # Validate permissions
    bad = [p for p in payload.permissions if p not in PERMISSION_KEYS]
    if bad:
        raise HTTPException(400, f"Unknown permissions: {bad}")
    existing = await db.roles.find_one({"tenant_id": user["tenant_id"], "name": name})
    if existing:
        raise HTTPException(400, "Role name already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "tenant_id": user["tenant_id"],
        "name": name,
        "permissions": payload.permissions,
        "is_system": False,
        "created_at": now_iso(),
    }
    await db.roles.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.patch("/roles/{role_id}")
async def update_role(role_id: str, payload: RoleUpdate, user: dict = Depends(require_permission("manage_roles"))):
    role = await db.roles.find_one({"id": role_id, "tenant_id": user["tenant_id"]})
    if not role:
        raise HTTPException(404, "Role not found")
    upd: dict = {}
    if payload.permissions is not None:
        bad = [p for p in payload.permissions if p not in PERMISSION_KEYS]
        if bad:
            raise HTTPException(400, f"Unknown permissions: {bad}")
        upd["permissions"] = payload.permissions
    if payload.name is not None and payload.name != role["name"]:
        # System roles cannot be renamed
        if role.get("is_system"):
            raise HTTPException(400, "Cannot rename a system role")
        new_name = payload.name.strip()
        conflict = await db.roles.find_one({"tenant_id": user["tenant_id"], "name": new_name})
        if conflict:
            raise HTTPException(400, "Role name already exists")
        # Cascade rename to all users with this role
        await db.users.update_many(
            {"tenant_id": user["tenant_id"], "role": role["name"]},
            {"$set": {"role": new_name}},
        )
        upd["name"] = new_name
    if upd:
        upd["updated_at"] = now_iso()
        await db.roles.update_one({"id": role_id}, {"$set": upd})
    return await db.roles.find_one({"id": role_id}, {"_id": 0})


@api.delete("/roles/{role_id}")
async def delete_role(role_id: str, user: dict = Depends(require_permission("manage_roles"))):
    role = await db.roles.find_one({"id": role_id, "tenant_id": user["tenant_id"]})
    if not role:
        raise HTTPException(404, "Role not found")
    if role.get("is_system"):
        raise HTTPException(400, "Cannot delete a system role")
    in_use = await db.users.count_documents({"tenant_id": user["tenant_id"], "role": role["name"]})
    if in_use > 0:
        raise HTTPException(400, f"Cannot delete: {in_use} user(s) still assigned to this role")
    await db.roles.delete_one({"id": role_id})
    return {"deleted": 1}


# ────────────────────────────────────────────────────────────
# HUNTER SETTINGS: Categories & Locations (tenant-wide)
# ────────────────────────────────────────────────────────────
# Default fallback aliases used when no category-specific list is configured.
DEFAULT_HUNTER_ALIASES = ["sales", "gm", "event"]


def _clean_aliases(raw) -> List[str]:
    if not raw: return []
    out, seen = [], set()
    for a in raw:
        v = (a or "").strip().lower().lstrip("@").split("@")[0]
        if v and v not in seen and len(v) <= 40:
            seen.add(v); out.append(v)
    return out


async def _resolve_aliases_for_search(tenant_id: str, category_id: Optional[str]) -> List[str]:
    """Pick aliases for this search: category-specific → tenant default → hardcoded default."""
    if category_id:
        cat = await db.categories.find_one({"id": category_id, "tenant_id": tenant_id}, {"_id": 0, "aliases": 1})
        if cat and cat.get("aliases"):
            return _clean_aliases(cat["aliases"])
    tenant = await db.tenants.find_one({"id": tenant_id}, {"_id": 0, "default_aliases": 1})
    if tenant and tenant.get("default_aliases"):
        return _clean_aliases(tenant["default_aliases"])
    return DEFAULT_HUNTER_ALIASES


@api.get("/hunter-settings/categories")
async def list_categories(user: dict = Depends(get_current_user)):
    rows = await db.categories.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("name", 1).to_list(500)
    return rows


@api.post("/hunter-settings/categories")
async def create_category(payload: CategoryCreate, user: dict = Depends(get_current_user)):
    name = payload.name.strip()
    if await db.categories.find_one({"tenant_id": user["tenant_id"], "name": name}):
        raise HTTPException(400, "Category already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "tenant_id": user["tenant_id"],
        "name": name,
        "aliases": _clean_aliases(payload.aliases) if payload.aliases is not None else [],
        "created_by": user["id"],
        "created_at": now_iso(),
    }
    await db.categories.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.patch("/hunter-settings/categories/{cat_id}")
async def update_category(cat_id: str, payload: CategoryUpdate, user: dict = Depends(get_current_user)):
    upd = {}
    if payload.name is not None:
        upd["name"] = payload.name.strip()
    if payload.aliases is not None:
        upd["aliases"] = _clean_aliases(payload.aliases)
    if not upd:
        return {"updated": 0}
    res = await db.categories.update_one({"id": cat_id, "tenant_id": user["tenant_id"]}, {"$set": upd})
    if not res.matched_count:
        raise HTTPException(404, "Category not found")
    return await db.categories.find_one({"id": cat_id}, {"_id": 0})


@api.get("/hunter-settings/default-aliases")
async def get_default_aliases(user: dict = Depends(get_current_user)):
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0, "default_aliases": 1})
    aliases = (tenant or {}).get("default_aliases") or DEFAULT_HUNTER_ALIASES
    return {"aliases": aliases, "is_default": not bool((tenant or {}).get("default_aliases"))}


class DefaultAliasesReq(BaseModel):
    aliases: List[str]


@api.put("/hunter-settings/default-aliases")
async def set_default_aliases(payload: DefaultAliasesReq, user: dict = Depends(get_current_user)):
    if user["role"] not in ("Owner", "Admin"):
        raise HTTPException(403, "Owner/Admin only")
    cleaned = _clean_aliases(payload.aliases)
    await db.tenants.update_one({"id": user["tenant_id"]}, {"$set": {"default_aliases": cleaned}})
    return {"aliases": cleaned}


@api.delete("/hunter-settings/categories/{cat_id}")
async def delete_category(cat_id: str, user: dict = Depends(get_current_user)):
    res = await db.categories.delete_one({"id": cat_id, "tenant_id": user["tenant_id"]})
    await db.my_leads.update_many(
        {"tenant_id": user["tenant_id"], "category_id": cat_id},
        {"$set": {"category_id": None}},
    )
    return {"deleted": res.deleted_count}


@api.get("/hunter-settings/locations")
async def list_locations(user: dict = Depends(get_current_user)):
    rows = await db.locations.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("name", 1).to_list(500)
    return rows


@api.post("/hunter-settings/locations")
async def create_location(payload: LocationCreate, user: dict = Depends(get_current_user)):
    name = payload.name.strip()
    if await db.locations.find_one({"tenant_id": user["tenant_id"], "name": name}):
        raise HTTPException(400, "Location already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "tenant_id": user["tenant_id"],
        "name": name,
        "created_by": user["id"],
        "created_at": now_iso(),
    }
    await db.locations.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.delete("/hunter-settings/locations/{loc_id}")
async def delete_location(loc_id: str, user: dict = Depends(get_current_user)):
    res = await db.locations.delete_one({"id": loc_id, "tenant_id": user["tenant_id"]})
    await db.my_leads.update_many(
        {"tenant_id": user["tenant_id"], "location_id": loc_id},
        {"$set": {"location_id": None}},
    )
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# MY LEADS (private per-user list)
# ────────────────────────────────────────────────────────────
@api.get("/my-leads")
async def list_my_leads(
    user: dict = Depends(get_current_user),
    category_id: Optional[str] = None,
    location_id: Optional[str] = None,
    q: Optional[str] = None,
):
    q_doc: dict = {"tenant_id": user["tenant_id"], "user_id": user["id"]}
    if category_id:
        q_doc["category_id"] = category_id
    if location_id:
        q_doc["location_id"] = location_id
    leads = await db.my_leads.find(q_doc, {"_id": 0}).sort("created_at", -1).to_list(2000)
    # Join with company + contact + category + location names
    comp_ids = list({l["company_id"] for l in leads})
    contact_ids = list({l["contact_id"] for l in leads})
    comps = {c["id"]: c async for c in db.companies.find({"id": {"$in": comp_ids}}, {"_id": 0})}
    cts = {c["id"]: c async for c in db.contacts.find({"id": {"$in": contact_ids}}, {"_id": 0})}
    cats = {c["id"]: c["name"] async for c in db.categories.find({"tenant_id": user["tenant_id"]}, {"_id": 0})}
    locs = {l["id"]: l["name"] async for l in db.locations.find({"tenant_id": user["tenant_id"]}, {"_id": 0})}
    out = []
    for l in leads:
        contact = cts.get(l["contact_id"], {})
        company = comps.get(l["company_id"], {})
        if q:
            blob = f"{contact.get('email','')} {contact.get('name','')} {company.get('company_name','')} {company.get('domain','')}".lower()
            if q.lower() not in blob:
                continue
        out.append({
            **l,
            "email": contact.get("email"),
            "contact_name": contact.get("name"),
            "job_title": contact.get("job_title"),
            "confidence_score": contact.get("confidence_score"),
            "company_name": company.get("company_name"),
            "company_domain": company.get("domain"),
            "category_name": cats.get(l.get("category_id")),
            "location_name": locs.get(l.get("location_id")),
        })
    return out


@api.post("/my-leads")
async def add_my_leads(payload: MyLeadAdd, user: dict = Depends(get_current_user)):
    # Validate company belongs to tenant
    company = await db.companies.find_one({"id": payload.company_id, "tenant_id": user["tenant_id"]})
    if not company:
        raise HTTPException(404, "Company not found")
    # Validate category/location if provided
    if payload.category_id:
        cat = await db.categories.find_one({"id": payload.category_id, "tenant_id": user["tenant_id"]})
        if not cat:
            raise HTTPException(400, "Invalid category")
    if payload.location_id:
        loc = await db.locations.find_one({"id": payload.location_id, "tenant_id": user["tenant_id"]})
        if not loc:
            raise HTTPException(400, "Invalid location")

    added, skipped = 0, 0
    for cid in payload.contact_ids:
        contact = await db.contacts.find_one({"id": cid, "tenant_id": user["tenant_id"]})
        if not contact:
            continue
        try:
            await db.my_leads.insert_one({
                "id": str(uuid.uuid4()),
                "tenant_id": user["tenant_id"],
                "user_id": user["id"],
                "company_id": payload.company_id,
                "contact_id": cid,
                "category_id": payload.category_id,
                "location_id": payload.location_id,
                "notes": payload.notes,
                "created_at": now_iso(),
            })
            added += 1
        except Exception:
            skipped += 1  # duplicate (unique index)
    return {"added": added, "skipped_duplicates": skipped}


@api.delete("/my-leads/{lead_id}")
async def delete_my_lead(lead_id: str, user: dict = Depends(get_current_user)):
    res = await db.my_leads.delete_one({"id": lead_id, "tenant_id": user["tenant_id"], "user_id": user["id"]})
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# SUB-COMPANIES (multi-company under one tenant)
# ────────────────────────────────────────────────────────────
@api.get("/sub-companies")
async def list_sub_companies(user: dict = Depends(get_current_user)):
    # Owner / users with manage_company see all sub-companies in tenant.
    # Other users only see sub-companies they are assigned to (their company's SMTP scope).
    can_manage = (user.get("role") == "Owner") or ("manage_company" in await get_user_permissions(user))
    q: dict = {"tenant_id": user["tenant_id"]}
    if not can_manage:
        my_subs = user.get("sub_company_ids") or []
        if not my_subs:
            return []
        q["id"] = {"$in": my_subs}
    rows = await db.sub_companies.find(q, {"_id": 0}).sort("name", 1).to_list(200)
    for r in rows:
        r["user_count"] = await db.users.count_documents({
            "tenant_id": user["tenant_id"],
            "sub_company_ids": r["id"],
        })
    return rows


@api.post("/sub-companies")
async def create_sub_company(payload: SubCompanyCreate, user: dict = Depends(require_permission("manage_company"))):
    doc = payload.model_dump()
    doc.update({
        "id": str(uuid.uuid4()),
        "tenant_id": user["tenant_id"],
        "created_at": now_iso(),
    })
    await db.sub_companies.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.patch("/sub-companies/{sc_id}")
async def update_sub_company(sc_id: str, payload: SubCompanyUpdate, user: dict = Depends(require_permission("manage_company"))):
    upd = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if upd:
        upd["updated_at"] = now_iso()
        await db.sub_companies.update_one({"id": sc_id, "tenant_id": user["tenant_id"]}, {"$set": upd})
    return await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]}, {"_id": 0})


@api.delete("/sub-companies/{sc_id}")
async def delete_sub_company(sc_id: str, user: dict = Depends(require_permission("manage_company"))):
    in_use = await db.users.count_documents({"tenant_id": user["tenant_id"], "sub_company_ids": sc_id})
    if in_use > 0:
        raise HTTPException(400, f"Cannot delete: {in_use} user(s) assigned to this sub-company")
    res = await db.sub_companies.delete_one({"id": sc_id, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# TEAM
# ────────────────────────────────────────────────────────────
@api.get("/team")
async def list_team(user: dict = Depends(get_current_user)):
    rows = await db.users.find({"tenant_id": user["tenant_id"]}, {"_id": 0, "password_hash": 0}).to_list(200)
    return rows


@api.post("/team")
async def invite_user(payload: InviteUserReq, user: dict = Depends(require_permission("manage_users"))):
    email = payload.email.lower().strip()
    if await db.users.find_one({"email": email}):
        raise HTTPException(400, "Email already used")
    # Validate role exists in this tenant; cannot assign Owner via invite
    await ensure_tenant_roles(user["tenant_id"])
    if payload.role == "Owner":
        raise HTTPException(400, "Owner cannot be assigned via invite — promote an existing user instead")
    role_doc = await db.roles.find_one({"tenant_id": user["tenant_id"], "name": payload.role})
    if not role_doc:
        raise HTTPException(400, f"Role '{payload.role}' does not exist")
    new_user = {
        "id": str(uuid.uuid4()),
        "tenant_id": user["tenant_id"],
        "name": payload.name,
        "email": email,
        "password_hash": hash_pw(payload.password),
        "role": payload.role,
        "smtp_use_company": True,
        "smtp_host": None, "smtp_port": 587, "smtp_user": None, "smtp_password": None,
        "smtp_use_tls": True, "smtp_from_email": None, "smtp_from_name": None,
        "created_at": now_iso(),
    }
    await db.users.insert_one(new_user)
    new_user.pop("password_hash", None)
    new_user.pop("_id", None)
    return new_user


@api.patch("/team/{user_id}")
async def update_user(user_id: str, payload: UpdateUserReq, user: dict = Depends(get_current_user)):
    target = await db.users.find_one({"id": user_id, "tenant_id": user["tenant_id"]})
    if not target:
        raise HTTPException(404, "User not found")
    can_edit = (
        user["role"] == "Owner"
        or user["id"] == user_id
        or (user["role"] == "Admin" and target["role"] == "Staff")
    )
    if not can_edit:
        raise HTTPException(403, "Cannot edit this user")

    upd: dict = {}
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        if k == "password":
            if v:
                upd["password_hash"] = hash_pw(v)
        elif k == "email":
            if v:
                ev = v.lower().strip()
                existing = await db.users.find_one({"email": ev, "id": {"$ne": user_id}})
                if existing:
                    raise HTTPException(400, "Email already used")
                upd["email"] = ev
        elif k == "role":
            # Skip if role unchanged (frontend may always send it)
            if v == target.get("role"):
                continue
            if user["role"] != "Owner":
                raise HTTPException(403, "Only Owner can change role")
            role_doc = await db.roles.find_one({"tenant_id": user["tenant_id"], "name": v})
            if not role_doc:
                raise HTTPException(400, f"Role '{v}' does not exist")
            if target["role"] == "Owner" and v != "Owner":
                owner_count = await db.users.count_documents({"tenant_id": user["tenant_id"], "role": "Owner"})
                if owner_count <= 1:
                    raise HTTPException(400, "Cannot demote the last Owner")
            upd["role"] = v
        elif k == "sub_company_ids":
            if v is None:
                continue
            # Validate each sub_company belongs to this tenant
            valid_ids = []
            for scid in v:
                sc = await db.sub_companies.find_one({"id": scid, "tenant_id": user["tenant_id"]}, {"_id": 0, "id": 1})
                if sc:
                    valid_ids.append(scid)
            upd["sub_company_ids"] = valid_ids
        else:
            upd[k] = v

    if upd:
        upd["updated_at"] = now_iso()
        await db.users.update_one({"id": user_id}, {"$set": upd})
    return await db.users.find_one({"id": user_id}, {"_id": 0, "password_hash": 0})


@api.delete("/team/{user_id}")
async def delete_user(user_id: str, user: dict = Depends(require_role("Owner"))):
    if user_id == user["id"]:
        raise HTTPException(400, "Cannot delete yourself")
    res = await db.users.delete_one({"id": user_id, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# SETTINGS
# ────────────────────────────────────────────────────────────
@api.get("/settings")
async def get_settings(user: dict = Depends(require_role("Owner", "Admin"))):
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0})
    return tenant


@api.patch("/settings")
async def update_settings(payload: SettingsUpdate, user: dict = Depends(require_role("Owner", "Admin"))):
    upd = {k: v for k, v in payload.model_dump().items() if v is not None}
    if upd:
        await db.tenants.update_one({"id": user["tenant_id"]}, {"$set": upd})
    return await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0})


# ────────────────────────────────────────────────────────────
# HUNTER
# ────────────────────────────────────────────────────────────
async def _save_workflow_results(tenant_id: str, result: dict) -> dict:
    """Persist company + contacts from workflow result. Dedupe via unique index."""
    comp = result["company"]
    domain = _normalize_domain(comp["domain"])
    socials = comp.get("socials", {})
    company_doc = {
        "tenant_id": tenant_id,
        "domain": domain,
        "company_name": comp.get("company_name"),
        "industry": comp.get("industry"),
        "country": comp.get("country"),
        "phone": (comp.get("phones") or [None])[0],
        "whatsapp": (comp.get("whatsapps") or [None])[0],
        "linkedin": socials.get("linkedin"),
        "facebook": socials.get("facebook"),
        "instagram": socials.get("instagram"),
        "lead_source": "hunter_workflow",
        "updated_at": now_iso(),
    }
    existing = await db.companies.find_one({"tenant_id": tenant_id, "domain": domain})
    if existing:
        await db.companies.update_one({"id": existing["id"]}, {"$set": company_doc})
        company_id = existing["id"]
    else:
        company_id = str(uuid.uuid4())
        company_doc.update({"id": company_id, "created_at": now_iso()})
        await db.companies.insert_one(company_doc)

    created, updated = 0, 0
    for c in result["contacts"]:
        existing_c = await db.contacts.find_one({"tenant_id": tenant_id, "email": c["email"]})
        if existing_c:
            await db.contacts.update_one(
                {"id": existing_c["id"]},
                {"$set": {
                    "name": c.get("name") or existing_c.get("name"),
                    "job_title": c.get("job_title") or existing_c.get("job_title"),
                    "confidence_score": max(c["confidence_score"], existing_c.get("confidence_score", 0)),
                    "updated_at": now_iso(),
                }},
            )
            updated += 1
        else:
            await db.contacts.insert_one({
                "id": str(uuid.uuid4()),
                "tenant_id": tenant_id,
                "company_id": company_id,
                "email": c["email"],
                "name": c.get("name"),
                "job_title": c.get("job_title"),
                "source": c["source"],
                "confidence_score": c["confidence_score"],
                "status": c["status"],
                "created_at": now_iso(),
                "updated_at": now_iso(),
            })
            created += 1

    return {"company_id": company_id, "contacts_created": created, "contacts_updated": updated}


@api.get("/hunter/check-domain/{domain}")
async def check_global_db(domain: str, user: dict = Depends(get_current_user)):
    domain = _normalize_domain(domain)
    cached = await db.global_hunter_cache.find_one({"domain": domain}, {"_id": 0})
    if cached:
        cached_at = datetime.fromisoformat(cached["cached_at"])
        age_days = (datetime.now(timezone.utc) - cached_at).days
        return {
            "found": True,
            "domain": domain,
            "company_name": cached.get("company_name"),
            "last_updated": cached["cached_at"],
            "total_contacts": len(cached.get("contacts", [])),
            "fresh": age_days < GLOBAL_CACHE_DAYS,
            "age_days": age_days,
        }
    return {"found": False, "domain": domain}


@api.post("/hunter/cache/reset")
async def reset_hunter_cache(
    user: dict = Depends(get_current_user),
    clear_global: bool = True,        # cross-tenant cache (admin power — affects everyone)
    clear_companies: bool = True,     # tenant companies auto-saved
    clear_contacts: bool = True,      # tenant contacts auto-saved
    clear_history: bool = True,       # tenant search history
    clear_prospects: bool = False,    # user-saved prospects (default off — kept by default)
    clear_bulk_jobs: bool = True,
):
    """Owner-only: wipe Hunter cache + auto-saved company/contact data.
    Useful when switching from mock to real Hunter API, or to force fresh re-crawl on every domain.
    `clear_prospects` is OFF by default — those are intentional user saves."""
    if user["role"] != "Owner":
        raise HTTPException(403, "Owner only")
    tid = user["tenant_id"]
    results = {}
    if clear_global:
        r = await db.global_hunter_cache.delete_many({})
        results["global_hunter_cache"] = r.deleted_count
    if clear_companies:
        r = await db.companies.delete_many({"tenant_id": tid})
        results["companies"] = r.deleted_count
    if clear_contacts:
        r = await db.contacts.delete_many({"tenant_id": tid})
        results["contacts"] = r.deleted_count
    if clear_history:
        r = await db.searches.delete_many({"tenant_id": tid})
        results["searches"] = r.deleted_count
    if clear_bulk_jobs:
        r = await db.bulk_jobs.delete_many({"tenant_id": tid})
        results["bulk_jobs"] = r.deleted_count
    if clear_prospects:
        r = await db.prospects.delete_many({"tenant_id": tid})
        results["prospects"] = r.deleted_count
        await db.prospect_activity.delete_many({"tenant_id": tid})
        await db.email_sends.delete_many({"tenant_id": tid})
    return {"ok": True, "cleared": results}


@api.post("/hunter/search")
async def hunter_search(payload: HunterSearchReq, user: dict = Depends(get_current_user)):
    domain = _normalize_domain(payload.domain)
    tenant_id = user["tenant_id"]
    logs: List[str] = [f"> [STEP 1] Check global database for {domain}"]
    steps = []

    cached = await db.global_hunter_cache.find_one({"domain": domain})
    use_cache = False
    if cached and not payload.force_refresh:
        age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(cached["cached_at"])).days
        if age_days < GLOBAL_CACHE_DAYS:
            use_cache = True
            logs.append(f"  > Cache HIT, age={age_days}d, contacts={len(cached.get('contacts', []))}")
            steps.append({"name": "Global DB Check", "status": "hit"})

    if use_cache:
        # rebuild result shape from cache
        result = {
            "logs": logs + ["> Using cached result. Saving to your prospect list..."],
            "steps": steps + [
                {"name": "Playwright Deep Crawl", "status": "skip"},
                {"name": "Hunter.io Domain Search", "status": "skip"},
                {"name": "Data Merge", "status": "skip"},
                {"name": "Confidence Scoring", "status": "skip"},
                {"name": "Email Verifier", "status": "skip"},
            ],
            "company": cached["company"],
            "contacts": cached["contacts"],
        }
    else:
        logs.append("  > Cache MISS or refresh forced. Running full workflow...")
        steps.append({"name": "Global DB Check", "status": "miss"})
        aliases = await _resolve_aliases_for_search(user["tenant_id"], payload.category_id)
        result = await run_hunter_workflow(domain, aliases=aliases)
        result["logs"] = logs + result["logs"]
        result["steps"] = steps + result["steps"]
        # Update global cache
        await db.global_hunter_cache.update_one(
            {"domain": domain},
            {"$set": {
                "domain": domain,
                "company": result["company"],
                "contacts": result["contacts"],
                "company_name": result["company"].get("company_name"),
                "cached_at": now_iso(),
            }},
            upsert=True,
        )

    # Save to tenant DB
    save_res = await _save_workflow_results(tenant_id, result)
    result["save"] = save_res
    result["steps"].append({"name": "Save to Database", "status": "ok"})
    result["logs"].append(f"> [DONE] Saved {save_res['contacts_created']} new, updated {save_res['contacts_updated']} contacts")

    # Record search history
    await db.searches.insert_one({
        "id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "user_id": user["id"],
        "domain": domain,
        "company_name": result["company"].get("company_name"),
        "contacts_found": len(result["contacts"]),
        "from_cache": use_cache,
        "created_at": now_iso(),
    })

    return result


@api.post("/hunter/bulk")
async def hunter_bulk(payload: BulkSearchReq, background: BackgroundTasks, user: dict = Depends(get_current_user)):
    domains = [_normalize_domain(d) for d in payload.domains if d.strip()]
    if not domains:
        raise HTTPException(400, "No domains provided")
    job_id = str(uuid.uuid4())
    await db.bulk_jobs.insert_one({
        "id": job_id,
        "tenant_id": user["tenant_id"],
        "domains": domains,
        "total": len(domains),
        "completed": 0,
        "results": [],
        "status": "running",
        "created_at": now_iso(),
    })

    async def _run():
        for d in domains:
            try:
                res = await hunter_search(HunterSearchReq(domain=d), user)  # reuses logic; uses same user
                await db.bulk_jobs.update_one(
                    {"id": job_id},
                    {"$inc": {"completed": 1},
                     "$push": {"results": {"domain": d, "contacts": len(res["contacts"]), "ok": True}}},
                )
            except Exception as e:
                logger.exception("bulk item failed")
                await db.bulk_jobs.update_one(
                    {"id": job_id},
                    {"$inc": {"completed": 1},
                     "$push": {"results": {"domain": d, "ok": False, "error": str(e)}}},
                )
        await db.bulk_jobs.update_one({"id": job_id}, {"$set": {"status": "done", "finished_at": now_iso()}})

    background.add_task(_run)
    return {"job_id": job_id, "total": len(domains)}


@api.get("/hunter/bulk/{job_id}")
async def hunter_bulk_status(job_id: str, user: dict = Depends(get_current_user)):
    job = await db.bulk_jobs.find_one({"id": job_id, "tenant_id": user["tenant_id"]}, {"_id": 0})
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@api.get("/hunter/searches")
async def list_searches(user: dict = Depends(get_current_user), limit: int = 20):
    q = {"tenant_id": user["tenant_id"]}
    if not _is_super_admin(user):
        q["user_id"] = user["id"]
    rows = await db.searches.find(q, {"_id": 0}).sort("created_at", -1).to_list(limit)
    return rows


# ────────────────────────────────────────────────────────────
# COMPANIES
# ────────────────────────────────────────────────────────────
@api.get("/companies")
async def list_companies(
    user: dict = Depends(get_current_user),
    q: Optional[str] = None,
    industry: Optional[str] = None,
    country: Optional[str] = None,
    limit: int = 200,
):
    query = {"tenant_id": user["tenant_id"]}
    if q:
        query["$or"] = [
            {"company_name": {"$regex": q, "$options": "i"}},
            {"domain": {"$regex": q, "$options": "i"}},
        ]
    if industry:
        query["industry"] = industry
    if country:
        query["country"] = country
    rows = await db.companies.find(query, {"_id": 0}).sort("updated_at", -1).to_list(limit)
    # attach contact counts
    for r in rows:
        r["contacts_count"] = await db.contacts.count_documents({"tenant_id": user["tenant_id"], "company_id": r["id"]})
    return rows


@api.get("/companies/{company_id}")
async def get_company(company_id: str, user: dict = Depends(get_current_user)):
    comp = await db.companies.find_one({"id": company_id, "tenant_id": user["tenant_id"]}, {"_id": 0})
    if not comp:
        raise HTTPException(404, "Not found")
    contacts = await db.contacts.find({"tenant_id": user["tenant_id"], "company_id": company_id}, {"_id": 0}).to_list(500)
    return {"company": comp, "contacts": contacts}


@api.patch("/companies/{company_id}")
async def update_company(company_id: str, payload: CompanyUpdate, user: dict = Depends(get_current_user)):
    upd = {k: v for k, v in payload.model_dump().items() if v is not None}
    if upd:
        upd["updated_at"] = now_iso()
        await db.companies.update_one({"id": company_id, "tenant_id": user["tenant_id"]}, {"$set": upd})
    return await db.companies.find_one({"id": company_id, "tenant_id": user["tenant_id"]}, {"_id": 0})


@api.delete("/companies/{company_id}")
async def delete_company(company_id: str, user: dict = Depends(require_role("Owner", "Admin"))):
    await db.contacts.delete_many({"tenant_id": user["tenant_id"], "company_id": company_id})
    res = await db.companies.delete_one({"id": company_id, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# CONTACTS
# ────────────────────────────────────────────────────────────
@api.get("/contacts")
async def list_contacts(
    user: dict = Depends(get_current_user),
    q: Optional[str] = None,
    company_id: Optional[str] = None,
    source: Optional[str] = None,
    status: Optional[str] = None,
    min_score: Optional[int] = None,
    industry: Optional[str] = None,
    country: Optional[str] = None,
    limit: int = 500,
):
    query: dict = {"tenant_id": user["tenant_id"]}
    if q:
        query["$or"] = [
            {"email": {"$regex": q, "$options": "i"}},
            {"name": {"$regex": q, "$options": "i"}},
        ]
    if company_id:
        query["company_id"] = company_id
    if source:
        query["source"] = source
    if status:
        query["status"] = status
    if min_score is not None:
        query["confidence_score"] = {"$gte": min_score}

    # Industry / country require joining with company
    if industry or country:
        comp_q = {"tenant_id": user["tenant_id"]}
        if industry: comp_q["industry"] = industry
        if country: comp_q["country"] = country
        comp_ids = [c["id"] async for c in db.companies.find(comp_q, {"id": 1, "_id": 0})]
        query["company_id"] = {"$in": comp_ids}

    rows = await db.contacts.find(query, {"_id": 0}).sort("created_at", -1).to_list(limit)
    # attach company name
    comp_ids = list({r["company_id"] for r in rows})
    comps = {c["id"]: c async for c in db.companies.find({"id": {"$in": comp_ids}, "tenant_id": user["tenant_id"]}, {"_id": 0})}
    for r in rows:
        c = comps.get(r["company_id"], {})
        r["company_name"] = c.get("company_name")
        r["company_domain"] = c.get("domain")
        r["industry"] = c.get("industry")
        r["country"] = c.get("country")
    return rows


@api.post("/contacts")
async def create_contact(payload: ContactCreate, user: dict = Depends(get_current_user)):
    comp = await db.companies.find_one({"id": payload.company_id, "tenant_id": user["tenant_id"]})
    if not comp:
        raise HTTPException(404, "Company not found")
    if await db.contacts.find_one({"tenant_id": user["tenant_id"], "email": payload.email.lower()}):
        raise HTTPException(400, "Email already exists in your database")
    doc = payload.model_dump()
    doc.update({
        "id": str(uuid.uuid4()),
        "tenant_id": user["tenant_id"],
        "email": payload.email.lower(),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    })
    await db.contacts.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.patch("/contacts/{contact_id}")
async def update_contact(contact_id: str, payload: ContactUpdate, user: dict = Depends(get_current_user)):
    upd = {k: v for k, v in payload.model_dump().items() if v is not None}
    if upd:
        upd["updated_at"] = now_iso()
        await db.contacts.update_one({"id": contact_id, "tenant_id": user["tenant_id"]}, {"$set": upd})
    return await db.contacts.find_one({"id": contact_id, "tenant_id": user["tenant_id"]}, {"_id": 0})


@api.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: str, user: dict = Depends(get_current_user)):
    res = await db.contacts.delete_one({"id": contact_id, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# CAMPAIGNS
# ────────────────────────────────────────────────────────────
@api.get("/campaigns")
async def list_campaigns(user: dict = Depends(get_current_user)):
    rows = await db.campaigns.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("created_at", -1).to_list(200)
    # attach metrics
    for r in rows:
        agg = await db.campaign_recipients.aggregate([
            {"$match": {"campaign_id": r["id"]}},
            {"$group": {
                "_id": None,
                "total": {"$sum": 1},
                "delivered": {"$sum": {"$cond": ["$delivered", 1, 0]}},
                "opened": {"$sum": {"$cond": [{"$gt": ["$opens", 0]}, 1, 0]}},
                "clicked": {"$sum": {"$cond": [{"$gt": ["$clicks", 0]}, 1, 0]}},
                "bounced": {"$sum": {"$cond": ["$bounced", 1, 0]}},
            }},
        ]).to_list(1)
        r["metrics"] = agg[0] if agg else {"total": 0, "delivered": 0, "opened": 0, "clicked": 0, "bounced": 0}
        if "_id" in r["metrics"]: r["metrics"].pop("_id")
    return rows


@api.post("/campaigns")
async def create_campaign(payload: CampaignCreate, user: dict = Depends(get_current_user)):
    cid = str(uuid.uuid4())
    doc = payload.model_dump()
    doc.update({
        "id": cid,
        "tenant_id": user["tenant_id"],
        "created_by": user["id"],
        "status": "draft",
        "created_at": now_iso(),
    })
    await db.campaigns.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.get("/campaigns/{campaign_id}")
async def get_campaign(campaign_id: str, user: dict = Depends(get_current_user)):
    c = await db.campaigns.find_one({"id": campaign_id, "tenant_id": user["tenant_id"]}, {"_id": 0})
    if not c:
        raise HTTPException(404, "Not found")
    recipients = await db.campaign_recipients.find({"campaign_id": campaign_id}, {"_id": 0}).to_list(2000)
    return {"campaign": c, "recipients": recipients}


def _resolve_recipients(tenant_id: str, payload: dict) -> Any:
    # returns coroutine - kept inline below
    pass


@api.post("/campaigns/{campaign_id}/send")
async def send_campaign(campaign_id: str, req: CampaignSendReq, background: BackgroundTasks, user: dict = Depends(get_current_user)):
    camp = await db.campaigns.find_one({"id": campaign_id, "tenant_id": user["tenant_id"]})
    if not camp:
        raise HTTPException(404, "Not found")
    tenant = await db.tenants.find_one({"id": user["tenant_id"]})

    # Resolve SMTP source: sub_company > tenant
    smtp_src = None
    if camp.get("sub_company_id"):
        sc = await db.sub_companies.find_one({"id": camp["sub_company_id"], "tenant_id": user["tenant_id"]})
        if sc and sc.get("smtp_host"):
            smtp_src = sc
    if smtp_src is None:
        if not tenant.get("smtp_host"):
            raise HTTPException(400, "SMTP not configured. Configure SMTP for the selected sub-company or tenant.")
        smtp_src = tenant

    # Resolve recipient list
    source = camp.get("recipient_source") or "contacts"
    recipients_data: List[dict] = []

    if source == "manual":
        emails = [e.strip() for e in (camp.get("manual_emails") or []) if e and "@" in e]
        seen = set()
        for em in emails:
            key = em.lower()
            if key in seen: continue
            seen.add(key)
            recipients_data.append({"id": None, "email": em, "name": None})

    elif source == "my_leads":
        lead_ids = camp.get("my_lead_ids") or []
        if not lead_ids:
            raise HTTPException(400, "No leads selected")
        leads = await db.my_leads.find({"tenant_id": user["tenant_id"], "id": {"$in": lead_ids}}, {"_id": 0}).to_list(5000)
        cids = list({ld["contact_id"] for ld in leads})
        cts = {c["id"]: c async for c in db.contacts.find({"id": {"$in": cids}, "tenant_id": user["tenant_id"]}, {"_id": 0})}
        for ld in leads:
            c = cts.get(ld["contact_id"])
            if c and c.get("email"):
                recipients_data.append({"id": c["id"], "email": c["email"], "name": c.get("name")})

    else:  # contacts (master DB)
        contact_ids = camp.get("contact_ids") or []
        if not contact_ids:
            q = {"tenant_id": user["tenant_id"], "status": {"$ne": "invalid"}}
            if camp.get("filter_min_score"):
                q["confidence_score"] = {"$gte": camp["filter_min_score"]}
            if camp.get("filter_industry") or camp.get("filter_country"):
                comp_q = {"tenant_id": user["tenant_id"]}
                if camp.get("filter_industry"): comp_q["industry"] = camp["filter_industry"]
                if camp.get("filter_country"): comp_q["country"] = camp["filter_country"]
                comp_ids = [c["id"] async for c in db.companies.find(comp_q, {"id": 1, "_id": 0})]
                q["company_id"] = {"$in": comp_ids}
            contacts = await db.contacts.find(q, {"_id": 0}).to_list(5000)
        else:
            contacts = await db.contacts.find({"tenant_id": user["tenant_id"], "id": {"$in": contact_ids}}, {"_id": 0}).to_list(5000)
        for c in contacts:
            if c.get("email"):
                recipients_data.append({"id": c["id"], "email": c["email"], "name": c.get("name")})

    if not recipients_data:
        raise HTTPException(400, "No recipients matched")

    # Create recipient rows
    recipient_ids = []
    for rd in recipients_data:
        rid = str(uuid.uuid4())
        await db.campaign_recipients.insert_one({
            "id": rid,
            "campaign_id": campaign_id,
            "tenant_id": user["tenant_id"],
            "contact_id": rd["id"],
            "email": rd["email"],
            "name": rd.get("name"),
            "delivered": False,
            "opens": 0,
            "clicks": 0,
            "replied": False,
            "bounced": False,
            "unsubscribed": False,
            "error": None,
            "sent_at": None,
        })
        recipient_ids.append(rid)

    await db.campaigns.update_one({"id": campaign_id}, {"$set": {"status": "sending", "sent_at": now_iso()}})

    async def _runner():
        sent = 0
        failed = 0
        for rid in recipient_ids:
            r = await db.campaign_recipients.find_one({"id": rid})
            body = inject_tracking(camp["body_html"], rid, PUBLIC_BASE_URL or "")
            result = await asyncio.to_thread(
                send_smtp_email,
                smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                smtp_src.get("smtp_user") or "",
                smtp_src.get("smtp_password") or "",
                bool(smtp_src.get("smtp_use_tls", True)),
                camp.get("from_email") or smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com",
                camp.get("from_name") or smtp_src.get("smtp_from_name") or tenant.get("smtp_from_name"),
                r["email"], camp["subject"], body,
            )
            if result["ok"]:
                sent += 1
                await db.campaign_recipients.update_one(
                    {"id": rid}, {"$set": {"delivered": True, "sent_at": now_iso()}}
                )
            else:
                failed += 1
                await db.campaign_recipients.update_one(
                    {"id": rid}, {"$set": {"bounced": True, "error": result["error"]}}
                )
            await asyncio.sleep(180)  # 3-minute throttle to avoid spam filters / rate limits
        await db.campaigns.update_one(
            {"id": campaign_id},
            {"$set": {"status": "sent", "delivered_count": sent, "failed_count": failed, "completed_at": now_iso()}},
        )

    background.add_task(_runner)
    return {"campaign_id": campaign_id, "recipients_count": len(recipient_ids), "status": "queued"}


@api.delete("/campaigns/{campaign_id}")
async def delete_campaign(campaign_id: str, user: dict = Depends(get_current_user)):
    await db.campaign_recipients.delete_many({"campaign_id": campaign_id})
    res = await db.campaigns.delete_one({"id": campaign_id, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


# ────────────────────────────────────────────────────────────
# TRACKING (PUBLIC, NO AUTH)
# ────────────────────────────────────────────────────────────
@api.get("/track/open/{recipient_id}")
async def track_open(recipient_id: str):
    await db.campaign_recipients.update_one(
        {"id": recipient_id},
        {"$inc": {"opens": 1}, "$set": {"last_opened_at": now_iso()}},
    )
    return FastAPIResponse(content=PIXEL_GIF, media_type="image/gif",
                           headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


@api.get("/track/click/{recipient_id}")
async def track_click(recipient_id: str, u: str = Query(...)):
    await db.campaign_recipients.update_one(
        {"id": recipient_id},
        {"$inc": {"clicks": 1}, "$set": {"last_clicked_at": now_iso()}},
    )
    return RedirectResponse(url=u, status_code=302)


# ────────────────────────────────────────────────────────────
# DASHBOARD
# ────────────────────────────────────────────────────────────
@api.get("/dashboard/overview")
async def dashboard_overview(user: dict = Depends(get_current_user)):
    tid = user["tenant_id"]
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
    total_companies = await db.companies.count_documents({"tenant_id": tid})
    total_contacts = await db.contacts.count_documents({"tenant_id": tid})
    total_emails_found = total_contacts
    new_leads_today = await db.contacts.count_documents({"tenant_id": tid, "created_at": {"$gte": today_start}})
    emails_sent_today = await db.campaign_recipients.count_documents({"tenant_id": tid, "delivered": True, "sent_at": {"$gte": today_start}})

    # Aggregate rates across all sent emails
    agg = await db.campaign_recipients.aggregate([
        {"$match": {"tenant_id": tid, "delivered": True}},
        {"$group": {
            "_id": None,
            "total": {"$sum": 1},
            "opened": {"$sum": {"$cond": [{"$gt": ["$opens", 0]}, 1, 0]}},
            "replied": {"$sum": {"$cond": ["$replied", 1, 0]}},
            "bounced": {"$sum": {"$cond": ["$bounced", 1, 0]}},
        }},
    ]).to_list(1)
    a = agg[0] if agg else {"total": 0, "opened": 0, "replied": 0, "bounced": 0}
    total = max(a["total"], 1)
    open_rate = round(100 * a["opened"] / total, 1) if a["total"] else 0
    reply_rate = round(100 * a["replied"] / total, 1) if a["total"] else 0
    bounce_rate = round(100 * a["bounced"] / total, 1) if a["total"] else 0

    # Trends — last 14 days
    days = []
    for i in range(13, -1, -1):
        d = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=i)
        next_d = d + timedelta(days=1)
        leads = await db.contacts.count_documents({
            "tenant_id": tid,
            "created_at": {"$gte": d.isoformat(), "$lt": next_d.isoformat()},
        })
        sent = await db.campaign_recipients.count_documents({
            "tenant_id": tid, "delivered": True,
            "sent_at": {"$gte": d.isoformat(), "$lt": next_d.isoformat()},
        })
        days.append({
            "date": d.strftime("%Y-%m-%d"),
            "label": d.strftime("%b %d"),
            "leads": leads,
            "sent": sent,
        })

    recent_searches = await db.searches.find({"tenant_id": tid}, {"_id": 0}).sort("created_at", -1).to_list(5)
    recent_leads = await db.contacts.find({"tenant_id": tid}, {"_id": 0}).sort("created_at", -1).to_list(5)
    recent_campaigns = await db.campaigns.find({"tenant_id": tid}, {"_id": 0}).sort("created_at", -1).to_list(5)

    return {
        "cards": {
            "total_companies": total_companies,
            "total_contacts": total_contacts,
            "total_emails_found": total_emails_found,
            "new_leads_today": new_leads_today,
            "emails_sent_today": emails_sent_today,
            "open_rate": open_rate,
            "reply_rate": reply_rate,
            "bounce_rate": bounce_rate,
        },
        "trends": days,
        "recent_searches": recent_searches,
        "recent_leads": recent_leads,
        "recent_campaigns": recent_campaigns,
    }


# ────────────────────────────────────────────────────────────
# CRM — PROSPECTS / TEMPLATES / EMAIL ACTIVITY
# ────────────────────────────────────────────────────────────
def _prospect_view(p: dict, users_map: dict = None, sub_map: dict = None) -> dict:
    """Strip _id and attach assigned_user/sub_company display names."""
    p.pop("_id", None)
    if users_map is not None:
        u = users_map.get(p.get("assigned_user_id"))
        p["assigned_user_name"] = u.get("name") if u else None
    if sub_map is not None:
        s = sub_map.get(p.get("sub_company_id"))
        p["sub_company_name"] = s.get("name") if s else None
    return p


async def _log_activity(prospect_id: str, tenant_id: str, type_: str, user_id: str = None, data: dict = None):
    await db.prospect_activity.insert_one({
        "id": str(uuid.uuid4()),
        "prospect_id": prospect_id,
        "tenant_id": tenant_id,
        "type": type_,
        "user_id": user_id,
        "data": data or {},
        "created_at": now_iso(),
    })


# ─── Daily quota state (UTC-based) ───
DEFAULT_WORKING_DAYS = ["mon", "tue", "wed", "thu", "fri"]
_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def _quota_state(user: dict) -> dict:
    """Return {is_working_day, daily_target, prospects_today, locked, remaining, working_days, holidays, today}"""
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}) or {}
    working_days = tenant.get("working_days") or DEFAULT_WORKING_DAYS
    holidays = tenant.get("holidays") or []
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_str = today.strftime("%Y-%m-%d")
    today_dow = _DAY_KEYS[today.weekday()]
    is_holiday = today_str in holidays
    is_working_day = (today_dow in working_days) and not is_holiday

    target = (await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1})).get("daily_target") or 0
    tomorrow = today + timedelta(days=1)

    # Exclude prospects that already belong to a SUBMITTED task today — they were "spent"
    # on a previous outreach cycle and shouldn't count toward the next task's quota.
    # Active tasks (draft/ready) still count so the in-progress task can hit its target.
    submitted_today = await db.outreach_tasks.find({
        "tenant_id": user["tenant_id"], "user_id": user["id"],
        "status": {"$nin": ["draft", "ready"]},
        "date": today_str,
    }, {"_id": 0, "prospect_ids": 1}).to_list(1000)
    spent_pids: List[str] = []
    for t_ in submitted_today:
        spent_pids.extend(t_.get("prospect_ids") or [])

    q_today = {
        "tenant_id": user["tenant_id"], "assigned_user_id": user["id"],
        "created_at": {"$gte": today.isoformat(), "$lt": tomorrow.isoformat()},
    }
    if spent_pids:
        q_today["id"] = {"$nin": spent_pids}
    prospects_today = await db.prospects.count_documents(q_today)
    # Determine lock: only locked when working day + target > 0 AND haven't met target
    locked = bool(is_working_day and target > 0 and prospects_today < target)
    remaining = max(0, target - prospects_today) if is_working_day else 0
    return {
        "today": today_str,
        "is_working_day": is_working_day,
        "is_holiday": is_holiday,
        "working_days": working_days,
        "holidays": holidays,
        "daily_target": target,
        "prospects_today": prospects_today,
        "remaining": remaining,
        "locked": locked,
    }


async def _can_bypass_lock(user: dict) -> bool:
    if user["role"] == "Owner":
        return True
    perms = await get_user_permissions(user)
    return "bypass_daily_lock" in perms


def _is_super_admin(user: dict) -> bool:
    """Owner & Admin see all prospects in the tenant; staff see only theirs."""
    return user.get("role") in ("Owner", "Admin")


def _prospect_scope(user: dict, base: Optional[dict] = None) -> dict:
    """Return a MongoDB filter that enforces per-user prospect isolation.
    Owner/Admin: tenant-wide (see everything).
    Other roles: only prospects they created or are assigned to.
    """
    q: dict = dict(base or {})
    q["tenant_id"] = user["tenant_id"]
    if not _is_super_admin(user):
        q["$or"] = [
            {"created_by": user["id"]},
            {"assigned_user_id": user["id"]},
        ]
    return q


@api.get("/prospects/quota")
async def get_quota(user: dict = Depends(get_current_user)):
    state = await _quota_state(user)
    state["can_bypass"] = await _can_bypass_lock(user)
    return state


@api.get("/prospects/today")
async def list_today_prospects(user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = today + timedelta(days=1)
    today_str = today.strftime("%Y-%m-%d")

    # Exclude prospects already locked into a submitted task today — they were "spent"
    # on a previous outreach cycle.
    submitted = await db.outreach_tasks.find({
        "tenant_id": user["tenant_id"], "user_id": user["id"],
        "status": {"$nin": ["draft", "ready"]},
        "date": today_str,
    }, {"_id": 0, "prospect_ids": 1}).to_list(1000)
    spent_pids: List[str] = []
    for t_ in submitted:
        spent_pids.extend(t_.get("prospect_ids") or [])

    q = {
        "tenant_id": user["tenant_id"],
        "assigned_user_id": user["id"],
        "created_at": {"$gte": today.isoformat(), "$lt": tomorrow.isoformat()},
    }
    if spent_pids:
        q["id"] = {"$nin": spent_pids}
    rows = await db.prospects.find(q, {"_id": 0}).sort("created_at", -1).to_list(500)
    return rows


# Stable color palette for sales user dots on calendar cells
_PIPELINE_COLORS = [
    "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
    "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#a3e635",
    "#f59e0b", "#84cc16",
]
def _color_for(uid: str) -> str:
    """Hash user id to a stable color so each sales user has consistent dot color."""
    h = 0
    for ch in (uid or ""):
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return _PIPELINE_COLORS[h % len(_PIPELINE_COLORS)]


@api.get("/prospects/calendar")
async def prospects_calendar(
    user: dict = Depends(get_current_user),
    year: int = Query(...),
    month: int = Query(..., ge=1, le=12),
):
    """Per-day aggregates for a month: prospects_added, emails_sent, emails_scheduled,
    plus per-user team breakdown (RBAC-scoped) so calendar cells can show coloured dots."""
    import calendar as cal
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}) or {}
    working_days = tenant.get("working_days") or DEFAULT_WORKING_DAYS
    holidays = set(tenant.get("holidays") or [])
    target = (await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1})).get("daily_target") or 0

    first = datetime(year, month, 1, tzinfo=timezone.utc)
    days_in_month = cal.monthrange(year, month)[1]
    last_exc = datetime(year, month, days_in_month, tzinfo=timezone.utc) + timedelta(days=1)

    # Aggregate prospects per day for this user
    p_pipeline = [
        {"$match": {
            "tenant_id": user["tenant_id"], "assigned_user_id": user["id"],
            "created_at": {"$gte": first.isoformat(), "$lt": last_exc.isoformat()},
        }},
        {"$group": {"_id": {"$substr": ["$created_at", 0, 10]}, "n": {"$sum": 1}}},
    ]
    p_counts = {doc["_id"]: doc["n"] async for doc in db.prospects.aggregate(p_pipeline)}

    # Aggregate emails SENT per day (sent_at)
    e_sent_pipe = [
        {"$match": {
            "tenant_id": user["tenant_id"], "sender_user_id": user["id"],
            "delivered": True,
            "sent_at": {"$gte": first.isoformat(), "$lt": last_exc.isoformat()},
        }},
        {"$group": {"_id": {"$substr": ["$sent_at", 0, 10]}, "n": {"$sum": 1}}},
    ]
    e_sent = {doc["_id"]: doc["n"] async for doc in db.email_sends.aggregate(e_sent_pipe)}

    # Aggregate scheduled emails per day (scheduled_at, status queued/scheduled)
    e_sched_pipe = [
        {"$match": {
            "tenant_id": user["tenant_id"], "sender_user_id": user["id"],
            "scheduled_at": {"$gte": first.isoformat(), "$lt": last_exc.isoformat()},
            "status": {"$in": ["queued", "scheduled"]},
        }},
        {"$group": {"_id": {"$substr": ["$scheduled_at", 0, 10]}, "n": {"$sum": 1}}},
    ]
    e_sched = {doc["_id"]: doc["n"] async for doc in db.email_sends.aggregate(e_sched_pipe)}

    # ─── Per-day TEAM breakdown (RBAC-scoped) ──────────────────────────────
    # For each day, return the list of users who collected prospects or sent/scheduled
    # email on that date. Each user gets a stable color derived from their id so calendar
    # cells can show coloured dots.
    role = user.get("role")
    if role in ("Owner", "Admin"):
        team_q = {"tenant_id": user["tenant_id"]}
    elif role == "Manager":
        my_subs = user.get("sub_company_ids") or []
        team_q = {"tenant_id": user["tenant_id"], "sub_company_ids": {"$in": my_subs}} if my_subs else {"id": user["id"]}
    else:
        team_q = {"id": user["id"]}
    team_users = await db.users.find(team_q, {"_id": 0, "id": 1, "name": 1, "email": 1}).to_list(500)
    team_uids = [u["id"] for u in team_users]
    user_meta = {u["id"]: {"id": u["id"], "name": u.get("name") or u.get("email"), "color": _color_for(u["id"])} for u in team_users}

    # Team prospects by (date, user_id)
    tp_pipe = [
        {"$match": {
            "tenant_id": user["tenant_id"], "assigned_user_id": {"$in": team_uids},
            "created_at": {"$gte": first.isoformat(), "$lt": last_exc.isoformat()},
        }},
        {"$group": {"_id": {"d": {"$substr": ["$created_at", 0, 10]}, "u": "$assigned_user_id"}, "n": {"$sum": 1}}},
    ]
    team_day_user: Dict[str, Dict[str, dict]] = {}
    async for doc in db.prospects.aggregate(tp_pipe):
        d, u = doc["_id"]["d"], doc["_id"]["u"]
        team_day_user.setdefault(d, {}).setdefault(u, {"prospects": 0, "sent": 0, "scheduled": 0})
        team_day_user[d][u]["prospects"] = doc["n"]
    # Team email sends by (date, user_id)
    te_pipe = [
        {"$match": {
            "tenant_id": user["tenant_id"], "sender_user_id": {"$in": team_uids},
            "$or": [
                {"sent_at": {"$gte": first.isoformat(), "$lt": last_exc.isoformat()}},
                {"scheduled_at": {"$gte": first.isoformat(), "$lt": last_exc.isoformat()}},
            ],
        }},
        {"$project": {
            "u": "$sender_user_id", "status": 1,
            "d": {"$substr": [{"$ifNull": ["$sent_at", "$scheduled_at"]}, 0, 10]},
        }},
        {"$group": {"_id": {"d": "$d", "u": "$u", "s": "$status"}, "n": {"$sum": 1}}},
    ]
    async for doc in db.email_sends.aggregate(te_pipe):
        d, u, s = doc["_id"]["d"], doc["_id"]["u"], doc["_id"]["s"]
        if not d:
            continue
        team_day_user.setdefault(d, {}).setdefault(u, {"prospects": 0, "sent": 0, "scheduled": 0})
        if s == "scheduled":
            team_day_user[d][u]["scheduled"] += doc["n"]
        elif s in ("queued", "sending", "sent", "delivered", "opened", "clicked", "replied"):
            team_day_user[d][u]["sent"] += doc["n"]

    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    days = []
    for d in range(1, days_in_month + 1):
        dt = datetime(year, month, d, tzinfo=timezone.utc)
        iso = dt.strftime("%Y-%m-%d")
        dow = _DAY_KEYS[dt.weekday()]
        is_holiday = iso in holidays
        is_working = (dow in working_days) and not is_holiday
        added = p_counts.get(iso, 0)
        sent = e_sent.get(iso, 0)
        scheduled = e_sched.get(iso, 0)
        # Build per-user breakdown for this day (sorted by prospects desc)
        day_users = []
        for uid, stats in (team_day_user.get(iso) or {}).items():
            meta = user_meta.get(uid)
            if not meta:
                continue
            day_users.append({**meta, **stats})
        day_users.sort(key=lambda x: (x.get("prospects", 0) + x.get("sent", 0) + x.get("scheduled", 0)), reverse=True)
        if not is_working:
            status = "off"
        elif target > 0 and added >= target:
            status = "hit"
        elif added > 0:
            status = "partial"
        elif iso < today_str:
            status = "missed"
        else:
            status = "open"
        days.append({
            "date": iso, "day": d, "dow": dow,
            "is_working_day": is_working, "is_holiday": is_holiday,
            "is_today": iso == today_str, "is_past": iso < today_str, "is_future": iso > today_str,
            "prospects_added": added, "emails_sent": sent, "emails_scheduled": scheduled,
            "status": status,
            "users": day_users,   # team breakdown for colour-dot rendering on calendar cells
        })
    return {
        "year": year, "month": month, "daily_target": target,
        "working_days": working_days, "holidays": sorted(holidays),
        "days": days,
    }


@api.get("/prospects/calendar/day/{date}")
async def prospects_calendar_day(date: str, user: dict = Depends(get_current_user)):
    """Detail for a single day: prospects added (scoped to tasks on that date), emails sent, emails scheduled.

    Prospect filtering rule:
      - A prospect "belongs to" a date if it is part of a task whose `date == date`.
      - Plus "loose" prospects (not attached to any task) whose `created_at` falls on that date,
        so legacy prospects added without a task still show up where they were created.
    """
    try:
        dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, "Invalid date format, use YYYY-MM-DD")
    nxt = dt + timedelta(days=1)

    # 1) Prospects from tasks scheduled for this date
    tasks_on_day = await db.outreach_tasks.find({
        "tenant_id": user["tenant_id"], "user_id": user["id"], "date": date,
    }, {"_id": 0, "prospect_ids": 1}).to_list(500)
    pids_on_day: List[str] = []
    for t in tasks_on_day:
        pids_on_day.extend(t.get("prospect_ids") or [])

    task_prospects = []
    if pids_on_day:
        task_prospects = await db.prospects.find(
            {"id": {"$in": pids_on_day}, "tenant_id": user["tenant_id"]},
            {"_id": 0},
        ).sort("created_at", -1).to_list(500)

    # 2) Loose prospects created on this day (NOT attached to any task for any date)
    all_attached_pids = set()
    all_tasks = await db.outreach_tasks.find(
        {"tenant_id": user["tenant_id"], "user_id": user["id"]},
        {"_id": 0, "prospect_ids": 1},
    ).to_list(2000)
    for t in all_tasks:
        all_attached_pids.update(t.get("prospect_ids") or [])

    loose_prospects = await db.prospects.find({
        "tenant_id": user["tenant_id"], "assigned_user_id": user["id"],
        "created_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()},
        "id": {"$nin": list(all_attached_pids)},
    }, {"_id": 0}).sort("created_at", -1).to_list(500)

    prospects = task_prospects + loose_prospects

    sent_emails = await db.email_sends.find({
        "tenant_id": user["tenant_id"], "sender_user_id": user["id"],
        "sent_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()},
    }, {"_id": 0}).sort("sent_at", -1).to_list(500)
    scheduled_emails = await db.email_sends.find({
        "tenant_id": user["tenant_id"], "sender_user_id": user["id"],
        "scheduled_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()},
        "status": {"$in": ["queued", "scheduled"]},
    }, {"_id": 0}).sort("scheduled_at", 1).to_list(500)
    # enrich prospect names
    pids = list({s["prospect_id"] for s in (sent_emails + scheduled_emails) if s.get("prospect_id")})
    pmap = {p["id"]: p["company_name"] async for p in db.prospects.find({"id": {"$in": pids}}, {"_id": 0, "id": 1, "company_name": 1})}
    for s in sent_emails + scheduled_emails:
        s["prospect_name"] = pmap.get(s.get("prospect_id"))
    return {
        "date": date,
        "prospects": prospects,
        "sent_emails": sent_emails,
        "scheduled_emails": scheduled_emails,
    }


@api.get("/prospects/calendar/pipeline/{date}")
async def prospects_calendar_pipeline(date: str, user: dict = Depends(get_current_user)):
    """Pipeline for a single day grouped by Sub-Company → Sales user.

    Each company card shows the users assigned to that company who did outreach work on
    `date`, with their stats (prospects collected, emails sent / scheduled / delivered).

    RBAC:
      - Owner / Admin       → see ALL companies + ALL users in the tenant
      - Sub-Company Manager → see ONLY their assigned sub_companies + users in them
      - Staff               → see ONLY themselves
    """
    try:
        dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, "Invalid date format, use YYYY-MM-DD")
    nxt = dt + timedelta(days=1)

    # 1) Resolve which users this caller can see (RBAC)
    role = user.get("role")
    if role in ("Owner", "Admin"):
        users_q = {"tenant_id": user["tenant_id"]}
    elif role == "Manager":
        my_subs = user.get("sub_company_ids") or []
        users_q = {"tenant_id": user["tenant_id"], "sub_company_ids": {"$in": my_subs}} if my_subs else {"id": user["id"]}
    else:  # Staff or anything else
        users_q = {"id": user["id"]}

    visible_users = await db.users.find(users_q, {"_id": 0, "id": 1, "name": 1, "email": 1, "sub_company_ids": 1, "role": 1}).to_list(500)
    user_ids = [u["id"] for u in visible_users]

    # 2) Sub-companies in tenant (always loaded so we can group)
    sub_companies = await db.sub_companies.find(
        {"tenant_id": user["tenant_id"]},
        {"_id": 0, "id": 1, "name": 1, "color": 1},
    ).to_list(500)
    sub_map = {sc["id"]: sc for sc in sub_companies}

    # 3) For each visible user, gather their stats on this date
    # Prospects attached to a task with date == date OR loose prospects created on date
    user_stats: Dict[str, dict] = {uid: {"prospects": 0, "sent": 0, "scheduled": 0, "delivered": 0, "replied": 0, "domains": set()} for uid in user_ids}

    tasks_today = await db.outreach_tasks.find(
        {"tenant_id": user["tenant_id"], "user_id": {"$in": user_ids}, "date": date},
        {"_id": 0, "user_id": 1, "prospect_ids": 1, "status": 1},
    ).to_list(500)
    task_pid_owner: Dict[str, str] = {}  # prospect_id → user_id
    for t in tasks_today:
        for pid in (t.get("prospect_ids") or []):
            task_pid_owner[pid] = t["user_id"]
    if task_pid_owner:
        task_prospects = await db.prospects.find(
            {"id": {"$in": list(task_pid_owner.keys())}},
            {"_id": 0, "id": 1, "domain": 1, "email_count": 1},
        ).to_list(1000)
        for p in task_prospects:
            uid = task_pid_owner[p["id"]]
            if uid in user_stats:
                user_stats[uid]["prospects"] += 1
                if p.get("domain"):
                    user_stats[uid]["domains"].add(p["domain"])

    # Email activity on the date
    sends = await db.email_sends.find({
        "tenant_id": user["tenant_id"],
        "sender_user_id": {"$in": user_ids},
        "$or": [
            {"created_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()}},
            {"scheduled_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()}},
            {"sent_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()}},
        ],
    }, {"_id": 0, "sender_user_id": 1, "status": 1}).to_list(5000)
    for s in sends:
        uid = s.get("sender_user_id")
        if uid not in user_stats:
            continue
        st = s.get("status")
        if st == "scheduled":
            user_stats[uid]["scheduled"] += 1
        elif st in ("queued", "sending", "sent"):
            user_stats[uid]["sent"] += 1
        elif st in ("delivered", "opened", "clicked"):
            user_stats[uid]["delivered"] += 1
        elif st == "replied":
            user_stats[uid]["replied"] += 1

    # 4) Group users by sub-company. A user can belong to multiple sub_companies → appear
    # in each. Users without any sub_company go into "Unassigned".
    by_company: Dict[str, dict] = {}
    for u in visible_users:
        sub_ids = u.get("sub_company_ids") or []
        keys = sub_ids if sub_ids else ["__unassigned__"]
        st = user_stats.get(u["id"], {})
        user_card = {
            "id": u["id"],
            "name": u.get("name") or u.get("email"),
            "email": u.get("email"),
            "role": u.get("role"),
            "prospects": st.get("prospects", 0),
            "domains": sorted(list(st.get("domains", set()))),
            "sent": st.get("sent", 0),
            "scheduled": st.get("scheduled", 0),
            "delivered": st.get("delivered", 0),
            "replied": st.get("replied", 0),
        }
        for key in keys:
            sc = sub_map.get(key)
            grp = by_company.setdefault(key, {
                "id": key,
                "name": sc["name"] if sc else "Unassigned",
                "color": (sc or {}).get("color") or "#64748b",
                "users": [],
                "total_prospects": 0,
                "total_sent": 0,
                "total_scheduled": 0,
            })
            grp["users"].append(user_card)
            grp["total_prospects"] += user_card["prospects"]
            grp["total_sent"] += user_card["sent"]
            grp["total_scheduled"] += user_card["scheduled"]

    # Sort: companies by total_prospects desc, users within by prospects desc
    companies = sorted(by_company.values(), key=lambda c: c["total_prospects"], reverse=True)
    for c in companies:
        c["users"].sort(key=lambda u: u["prospects"], reverse=True)

    return {"date": date, "companies": companies}


@api.post("/scheduled-emails/{send_id}/cancel")
async def cancel_scheduled_email(send_id: str, user: dict = Depends(get_current_user)):
    # Non-Owner hanya boleh cancel email yang dia kirim sendiri
    q = {"id": send_id, "tenant_id": user["tenant_id"], "status": {"$in": ["queued", "scheduled"]}}
    if user.get("role") != "Owner":
        q["sender_user_id"] = user["id"]
    res = await db.email_sends.update_one(
        q,
        {"$set": {"status": "cancelled", "cancelled_at": now_iso()}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Not found, already processed, or you don't own it")
    return {"ok": True}


@api.post("/scheduled-emails/cancel-task/{tid}")
async def cancel_task_scheduled_emails(
    tid: str,
    reset_to_draft: bool = False,
    user: dict = Depends(get_current_user),
):
    """Batalkan SEMUA email scheduled/queued yang masih pending di sebuah task (project).
    Email yang sudah delivered/bounced/cancelled tidak terpengaruh.

    Jika `reset_to_draft=true` dan SEMUA email di task ini sudah tidak ada lagi yang
    pending/delivered (semua jadi cancelled / belum pernah kirim), task akan dikembalikan
    ke status `draft` supaya user bisa edit ulang prospect/templat sebelum kirim ulang.
    """
    cancel_q = {"task_id": tid, "tenant_id": user["tenant_id"], "status": {"$in": ["queued", "scheduled"]}}
    if user.get("role") != "Owner":
        cancel_q["sender_user_id"] = user["id"]
    res = await db.email_sends.update_many(
        cancel_q,
        {"$set": {"status": "cancelled", "cancelled_at": now_iso()}},
    )
    task_reset = False
    if reset_to_draft and res.modified_count > 0:
        # Reset hanya kalau tidak ada email yang ter-deliver berhasil (artinya batch belum benar-benar terkirim).
        delivered_q = {
            "task_id": tid, "tenant_id": user["tenant_id"],
            "status": {"$in": ["delivered", "opened", "clicked", "replied"]},
        }
        if user.get("role") != "Owner":
            delivered_q["sender_user_id"] = user["id"]
        delivered_count = await db.email_sends.count_documents(delivered_q)
        if delivered_count == 0:
            await db.outreach_tasks.update_one(
                {"id": tid, "tenant_id": user["tenant_id"]},
                {"$set": {"status": "draft", "updated_at": now_iso()}},
            )
            task_reset = True
    return {"ok": True, "cancelled": res.modified_count, "task_reset_to_draft": task_reset}


@api.post("/scheduled-emails/cancel-prospect/{pid}")
async def cancel_prospect_scheduled_emails(pid: str, user: dict = Depends(get_current_user)):
    """Batalkan SEMUA email scheduled/queued ke 1 prospect tertentu (RBAC-scoped per sender)."""
    q = {"prospect_id": pid, "tenant_id": user["tenant_id"], "status": {"$in": ["queued", "scheduled"]}}
    if user.get("role") != "Owner":
        q["sender_user_id"] = user["id"]
    res = await db.email_sends.update_many(q, {"$set": {"status": "cancelled", "cancelled_at": now_iso()}})
    return {"ok": True, "cancelled": res.modified_count}


# ─── Outreach Tasks (workflow) ───
async def _task_view(t: dict) -> dict:
    t.pop("_id", None)
    pids = t.get("prospect_ids") or []
    t["prospect_count"] = len(pids)
    return t


async def _mark_bounced(send_id: str, error: str, tenant_id: str, prospect_id: Optional[str], to_email: str, sender_user_id: Optional[str] = None) -> None:
    """Tandai email sebagai bounce + auto-hapus dari prospect.emails + log ke bounced_emails."""
    await db.email_sends.update_one(
        {"id": send_id},
        {"$set": {"status": "bounce", "bounced": True, "error": error, "bounced_at": now_iso()}},
    )
    if not prospect_id or not to_email:
        return
    email_lower = to_email.lower()
    await db.prospects.update_one(
        {"id": prospect_id, "tenant_id": tenant_id},
        {"$pull": {"emails": {"email": email_lower}}},
    )
    pros = await db.prospects.find_one(
        {"id": prospect_id, "tenant_id": tenant_id},
        {"_id": 0, "company_name": 1, "website": 1, "industry": 1, "city": 1, "country": 1, "domain": 1},
    ) or {}
    await db.bounced_emails.update_one(
        {"tenant_id": tenant_id, "email": email_lower, "prospect_id": prospect_id},
        {"$set": {
            "tenant_id": tenant_id,
            "prospect_id": prospect_id,
            "company_name": pros.get("company_name"),
            "website": pros.get("website") or pros.get("domain"),
            "industry": pros.get("industry"),
            "city": pros.get("city"),
            "country": pros.get("country"),
            "email": email_lower,
            "error": error,
            "sender_user_id": sender_user_id,
            "send_id": send_id,
            "bounced_at": now_iso(),
        }},
        upsert=True,
    )


async def _mark_bounced_by_email(tenant_id: str, to_email: str, error: str, source: str = "mailer-daemon") -> dict:
    """Auto-bounce dari Mailer-Daemon: cari prospect by email, mark bounce, hapus email,
    dan log ke bounced_emails. Aman dipanggil walau prospect tidak ada (tetap dicatat)."""
    email_lower = (to_email or "").strip().lower()
    if "@" not in email_lower:
        return {"matched": False}
    pros = await db.prospects.find_one(
        {"tenant_id": tenant_id, "emails.email": email_lower},
        {"_id": 0, "id": 1, "company_name": 1, "website": 1, "industry": 1,
         "city": 1, "country": 1, "domain": 1},
    )
    pid = (pros or {}).get("id")
    # Cari email_send terakhir untuk recipient ini (untuk dapat sender_user_id + send_id)
    send_q = {"tenant_id": tenant_id, "to_email": email_lower}
    if pid:
        send_q["prospect_id"] = pid
    send = await db.email_sends.find_one(
        send_q, sort=[("sent_at", -1)],
        projection={"_id": 0, "id": 1, "sender_user_id": 1},
    )
    send_id = (send or {}).get("id")
    sender_user_id = (send or {}).get("sender_user_id")
    if send_id:
        await db.email_sends.update_one(
            {"id": send_id},
            {"$set": {"status": "bounce", "bounced": True, "error": error,
                      "bounced_at": now_iso()}},
        )
    if pid:
        await db.prospects.update_one(
            {"id": pid, "tenant_id": tenant_id},
            {"$pull": {"emails": {"email": email_lower}}},
        )
    await db.bounced_emails.update_one(
        {"tenant_id": tenant_id, "email": email_lower, "prospect_id": pid},
        {"$set": {
            "tenant_id": tenant_id,
            "prospect_id": pid,
            "company_name": (pros or {}).get("company_name"),
            "website": (pros or {}).get("website") or (pros or {}).get("domain"),
            "industry": (pros or {}).get("industry"),
            "city": (pros or {}).get("city"),
            "country": (pros or {}).get("country"),
            "email": email_lower,
            "error": error,
            "sender_user_id": sender_user_id,
            "send_id": send_id,
            "source": source,
            "bounced_at": now_iso(),
        }},
        upsert=True,
    )
    return {"matched": bool(pid), "prospect_id": pid, "send_id": send_id}


@api.get("/bounced-emails")
async def list_bounced_emails(user: dict = Depends(get_current_user), q: Optional[str] = None):
    """List email bounce. Non-Owner hanya lihat yang mereka kirim sendiri."""
    qry = {"tenant_id": user["tenant_id"]}
    if user.get("role") != "Owner":
        qry["sender_user_id"] = user["id"]
    rows = await db.bounced_emails.find(qry, {"_id": 0}).sort("bounced_at", -1).to_list(2000)
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in (f"{r.get('email','')} {r.get('company_name','')} {r.get('website','')}").lower()]
    return rows


@api.delete("/bounced-emails")
async def delete_bounced_log(email: str, user: dict = Depends(get_current_user)):
    """Hapus 1 entry dari log bounce (tidak mengubah prospect)."""
    qry = {"email": email.lower(), "tenant_id": user["tenant_id"]}
    if user.get("role") != "Owner":
        qry["sender_user_id"] = user["id"]
    res = await db.bounced_emails.delete_many(qry)
    return {"deleted": res.deleted_count}




@api.get("/tasks")
async def list_tasks(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,
    date: Optional[str] = None,
):
    # Self-healing: auto-transition any draft/ready task whose prospects are ALL already
    # in email_sends with processed status (queued/scheduled/sending/sent/delivered/...).
    # This cleans up legacy tasks that were submitted via bulk-send when the status wasn't
    # propagated, so they stop showing up as "Tugas Aktif" forever.
    stale = await db.outreach_tasks.find(
        {"tenant_id": user["tenant_id"], "user_id": user["id"], "status": {"$in": ["draft", "ready"]}},
        {"_id": 0, "id": 1, "prospect_ids": 1},
    ).to_list(500)
    for st in stale:
        pids = st.get("prospect_ids") or []
        if not pids:
            continue
        sends = await db.email_sends.find(
            {"prospect_id": {"$in": pids}, "status": {"$in": ["queued", "scheduled", "sending", "sent", "delivered", "opened", "clicked", "replied", "bounce"]}},
            {"_id": 0, "prospect_id": 1, "status": 1},
        ).to_list(2000)
        covered = {s["prospect_id"] for s in sends}
        if covered and set(pids).issubset(covered):
            new_status = "scheduled" if any(s["status"] == "scheduled" for s in sends) else "sending"
            await db.outreach_tasks.update_one(
                {"id": st["id"]},
                {"$set": {"status": new_status, "auto_healed_at": now_iso(), "updated_at": now_iso()}},
            )

    q = {"tenant_id": user["tenant_id"], "user_id": user["id"]}
    if status: q["status"] = status
    if date: q["date"] = date
    rows = await db.outreach_tasks.find(q, {"_id": 0}).sort("date", -1).to_list(500)
    # Dynamic target: untuk task yang BELUM submitted (draft/ready), selalu pakai
    # daily_target user yang TERBARU. Ini jamin perubahan target di Settings langsung
    # tampil di Prospects tanpa perlu reload/migrasi data lama.
    current_target = (await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1}) or {}).get("daily_target") or 0
    for r in rows:
        r["prospect_count"] = len(r.get("prospect_ids") or [])
        if r.get("status") in ("draft", "ready"):
            r["target"] = current_target
    return rows


@api.post("/tasks/recover-orphans/{date}")
async def recover_orphan_prospects(date: str, user: dict = Depends(get_current_user)):
    """Recover prospects yang ditambahkan pada tanggal X tapi tidak terhubung ke task apapun.
    Auto-create task baru (status=draft) untuk tanggal itu & attach semua orphan prospect ke situ.
    Berguna untuk user yang sempat 'terputus' setelah add prospect tanpa create task dulu."""
    try:
        dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        raise HTTPException(400, "Invalid date format, use YYYY-MM-DD")
    nxt = dt + timedelta(days=1)

    # Find prospects user created on this date
    # Then exclude those already attached to ANY task (any date) of this user
    all_attached: set = set()
    all_user_tasks = await db.outreach_tasks.find(
        {"tenant_id": user["tenant_id"], "user_id": user["id"]},
        {"_id": 0, "prospect_ids": 1},
    ).to_list(2000)
    for t in all_user_tasks:
        all_attached.update(t.get("prospect_ids") or [])

    orphans = await db.prospects.find({
        "tenant_id": user["tenant_id"],
        "assigned_user_id": user["id"],
        "created_at": {"$gte": dt.isoformat(), "$lt": nxt.isoformat()},
        "id": {"$nin": list(all_attached)},
    }, {"_id": 0, "id": 1}).to_list(500)

    if not orphans:
        raise HTTPException(404, "Tidak ada orphan prospect untuk tanggal ini")

    orphan_ids = [p["id"] for p in orphans]

    # Reuse current daily_target from user settings
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1}) or {}
    target = u.get("daily_target") or 0

    tid = str(uuid.uuid4())
    doc = {
        "id": tid,
        "tenant_id": user["tenant_id"],
        "user_id": user["id"],
        "date": date,
        "target": target,
        "name": f"Recovered {date}",
        "notes": "Auto-recovered from orphan prospects",
        "status": "draft",
        "prospect_ids": orphan_ids,
        "submit_at": None,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "recovered_from_orphans": True,
    }
    await db.outreach_tasks.insert_one(doc)
    out = {k: v for k, v in doc.items() if k != "_id"}
    out["prospect_count"] = len(orphan_ids)
    return out


@api.post("/tasks")
async def create_task(payload: OutreachTaskCreate, user: dict = Depends(get_current_user)):
    try:
        datetime.strptime(payload.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Invalid date, use YYYY-MM-DD")
    # Resolve target from user's daily_target if not provided.
    # target = 0 → daily-quest mode OFF (mode bebas) — diizinkan.
    target = payload.target
    if target is None:
        u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1}) or {}
        target = u.get("daily_target") or 0
    if target < 0:
        raise HTTPException(400, "Target tidak boleh negatif")
    tid = str(uuid.uuid4())
    doc = {
        "id": tid,
        "tenant_id": user["tenant_id"],
        "user_id": user["id"],
        "date": payload.date,
        "target": target,
        "name": payload.name or f"Outreach {payload.date}",
        "notes": payload.notes,
        "status": "draft",  # draft → ready → submitted_now / scheduled → completed
        "prospect_ids": [],
        "submit_at": None,
        "scheduled_send_at": None,
        "send_ids": [],
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.outreach_tasks.insert_one(doc)
    doc.pop("_id", None)
    doc["prospect_count"] = 0
    return doc


@api.get("/tasks/{tid}")
async def get_task(tid: str, user: dict = Depends(get_current_user)):
    t = await db.outreach_tasks.find_one({"id": tid, "tenant_id": user["tenant_id"], "user_id": user["id"]}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Task not found")
    pids = t.get("prospect_ids") or []
    prospects = await db.prospects.find({"id": {"$in": pids}, "tenant_id": user["tenant_id"]}, {"_id": 0}).to_list(500)
    t["prospects"] = prospects
    t["prospect_count"] = len(pids)
    # Sync target dynamically for open tasks (see list_tasks comment).
    if t.get("status") in ("draft", "ready"):
        current_target = (await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1}) or {}).get("daily_target") or 0
        t["target"] = current_target
    return t


@api.patch("/tasks/{tid}")
async def update_task(tid: str, payload: OutreachTaskUpdate, user: dict = Depends(get_current_user)):
    upd = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if upd:
        upd["updated_at"] = now_iso()
        res = await db.outreach_tasks.update_one(
            {"id": tid, "tenant_id": user["tenant_id"], "user_id": user["id"]},
            {"$set": upd},
        )
        if not res.matched_count:
            raise HTTPException(404, "Task not found")
    return await db.outreach_tasks.find_one({"id": tid}, {"_id": 0})


@api.delete("/tasks/{tid}")
async def delete_task(tid: str, user: dict = Depends(get_current_user)):
    res = await db.outreach_tasks.delete_one({"id": tid, "tenant_id": user["tenant_id"], "user_id": user["id"]})
    return {"deleted": res.deleted_count}


@api.post("/tasks/{tid}/prospects/{pid}")
async def attach_prospect_to_task(tid: str, pid: str, user: dict = Depends(get_current_user)):
    """Attach a prospect to a task. Auto-update status to 'ready' if target hit."""
    t = await db.outreach_tasks.find_one({"id": tid, "tenant_id": user["tenant_id"], "user_id": user["id"]})
    if not t:
        raise HTTPException(404, "Task not found")
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]}, {"_id": 0, "id": 1})
    if not p:
        raise HTTPException(404, "Prospect not found")
    pids = t.get("prospect_ids") or []
    if pid in pids:
        return {"ok": True, "already": True, "count": len(pids), "target": t["target"]}
    pids.append(pid)
    status = t.get("status") or "draft"
    if status == "draft" and len(pids) >= t["target"]:
        status = "ready"
    await db.outreach_tasks.update_one(
        {"id": tid},
        {"$set": {"prospect_ids": pids, "status": status, "updated_at": now_iso()}},
    )
    return {"ok": True, "count": len(pids), "target": t["target"], "status": status}


@api.delete("/tasks/{tid}/prospects/{pid}")
async def detach_prospect_from_task(tid: str, pid: str, user: dict = Depends(get_current_user)):
    t = await db.outreach_tasks.find_one({"id": tid, "tenant_id": user["tenant_id"], "user_id": user["id"]})
    if not t:
        raise HTTPException(404, "Task not found")
    pids = [x for x in (t.get("prospect_ids") or []) if x != pid]
    status = t.get("status") or "draft"
    if status == "ready" and len(pids) < t["target"]:
        status = "draft"
    await db.outreach_tasks.update_one(
        {"id": tid},
        {"$set": {"prospect_ids": pids, "status": status, "updated_at": now_iso()}},
    )
    return {"ok": True, "count": len(pids), "target": t["target"], "status": status}


@api.post("/tasks/{tid}/submit")
async def submit_task(tid: str, payload: OutreachTaskSubmit, background: BackgroundTasks, user: dict = Depends(get_current_user)):
    """Send or schedule the task's emails."""
    t = await db.outreach_tasks.find_one({"id": tid, "tenant_id": user["tenant_id"], "user_id": user["id"]})
    if not t:
        raise HTTPException(404, "Task not found")
    if t.get("status") not in ("draft", "ready"):
        raise HTTPException(400, f"Task already submitted (status={t.get('status')})")
    pids = t.get("prospect_ids") or []
    if not pids:
        raise HTTPException(400, "Task has no prospects yet")
    if len(pids) < t["target"]:
        raise HTTPException(400, f"Target not yet reached ({len(pids)}/{t['target']})")

    # Quota lock check
    state = await _quota_state(user)
    if state["locked"] and not await _can_bypass_lock(user):
        raise HTTPException(423, f"Daily quota not met — add {state['remaining']} more prospect(s) before sending emails.")

    is_scheduled = False
    sched_iso = None
    if payload.send_mode == "scheduled":
        if not payload.scheduled_send_at:
            raise HTTPException(400, "scheduled_send_at required for scheduled mode")
        try:
            sched_dt = datetime.fromisoformat(payload.scheduled_send_at.replace("Z", "+00:00"))
            if sched_dt.tzinfo is None:
                sched_dt = sched_dt.replace(tzinfo=timezone.utc)
            if sched_dt <= datetime.now(timezone.utc) + timedelta(minutes=1):
                raise HTTPException(400, "Scheduled time must be in the future")
            is_scheduled = True
            sched_iso = sched_dt.isoformat()
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(400, "Invalid scheduled_send_at format")

    smtp_src = await _resolve_smtp(user["tenant_id"], user, payload.sub_company_id)
    if not is_scheduled and not smtp_src:
        raise HTTPException(400, "SMTP not configured.")

    prospects = await db.prospects.find({"tenant_id": user["tenant_id"], "id": {"$in": pids}}, {"_id": 0}).to_list(500)
    new_send_ids = []
    for p in prospects:
        # Send to ALL valid emails of this prospect (not just primary)
        for e in (p.get("emails") or []):
            to_email = e.get("email")
            if not to_email:
                continue
            subject = _apply_template_vars(payload.subject, p, to_email)
            body    = _apply_template_vars(payload.body_html, p, to_email)
            send_id = str(uuid.uuid4())
            await db.email_sends.insert_one({
                "id": send_id, "tenant_id": user["tenant_id"], "prospect_id": p["id"],
                "sender_user_id": user["id"],
                "sub_company_id": payload.sub_company_id or p.get("sub_company_id"),
                "template_id": payload.template_id, "to_email": to_email,
                "subject": subject, "body_html": body,
                "scheduled_at": sched_iso,
                "status": "scheduled" if is_scheduled else "queued",
                "task_id": tid,
                "delivered": False, "opens": 0, "clicks": 0,
                "replied": False, "bounced": False, "error": None, "sent_at": None,
                "created_at": now_iso(),
            })
            new_send_ids.append(send_id)

    new_status = "scheduled" if is_scheduled else "sending"
    await db.outreach_tasks.update_one(
        {"id": tid},
        {"$set": {
            "status": new_status,
            "template_id": payload.template_id,
            "subject": payload.subject,
            "body_html": payload.body_html,
            "sub_company_id": payload.sub_company_id,
            "scheduled_send_at": sched_iso,
            "submit_at": now_iso(),
            "send_ids": new_send_ids,
            "updated_at": now_iso(),
        }},
    )

    if is_scheduled:
        return {"task_id": tid, "queued": len(new_send_ids), "scheduled_at": sched_iso, "status": "scheduled"}

    async def _runner():
        body_type, atts = await _load_template_extras(user["tenant_id"], payload.template_id)

        for sid in new_send_ids:
            s = await db.email_sends.find_one({"id": sid, "status": "queued"})
            if not s: continue
            from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
            from_name  = smtp_src.get("smtp_from_name")
            if body_type == "html":
                tracked = inject_tracking(s["body_html"], s["id"], PUBLIC_BASE_URL or "")
            else:
                tracked = s["body_html"]
            unsubscribe_url = f"{PUBLIC_BASE_URL}/api/track/unsubscribe/{s['id']}" if PUBLIC_BASE_URL else None
            final_body, inline_imgs = await _extract_inline_images_for_send(tracked, user["tenant_id"])
            result = await asyncio.to_thread(
                send_smtp_email,
                smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                bool(smtp_src.get("smtp_use_tls", True)),
                from_email, from_name, s["to_email"], s["subject"], final_body,
                body_type, atts,
                inline_images=inline_imgs,
                list_unsubscribe_url=unsubscribe_url,
                reply_to=from_email,
            )
            if result["ok"]:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                if s.get("prospect_id"):
                    await _log_activity(s["prospect_id"], user["tenant_id"], "email_sent", user["id"], {"to": s["to_email"], "send_id": s["id"], "task_id": tid})
                    await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                                   {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
            else:
                await _mark_bounced(s["id"], result["error"], user["tenant_id"], s.get("prospect_id"), s.get("to_email"), user["id"])
            await asyncio.sleep(180)  # 3-minute throttle between sends
        await db.outreach_tasks.update_one({"id": tid}, {"$set": {"status": "completed", "updated_at": now_iso()}})

    background.add_task(_runner)
    return {"task_id": tid, "queued": len(new_send_ids), "status": "sending"}


@api.post("/sub-companies/{sc_id}/test-smtp")
async def test_sub_smtp(sc_id: str, req: SmtpTestReq, user: dict = Depends(get_current_user)):
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]})
    if not sc:
        raise HTTPException(404, "Sub-company not found")
    if not sc.get("smtp_host"):
        raise HTTPException(400, "SMTP host belum di-set")
    from_email = sc.get("smtp_from_email") or sc.get("smtp_user") or "noreply@example.com"
    body = f"<p>✓ SMTP test from <b>{sc['name']}</b> via {sc['smtp_host']}:{sc.get('smtp_port', 587)}</p><p>If you received this, your SMTP setting is working correctly.</p>"
    result = await asyncio.to_thread(
        send_smtp_email,
        sc["smtp_host"], int(sc.get("smtp_port") or 587),
        sc.get("smtp_user") or "", sc.get("smtp_password") or "",
        bool(sc.get("smtp_use_tls", True)),
        from_email, sc.get("smtp_from_name") or "Test", req.to_email,
        f"SMTP Test from {sc['name']}", body,
    )
    if not result["ok"]:
        raise HTTPException(400, f"SMTP test gagal: {result['error']}")
    return {"ok": True, "message": f"Test email terkirim ke {req.to_email} via {sc['smtp_host']}"}


def _format_imap_error(e: Exception) -> str:
    """Decode imaplib bytes error and add helpful hints for common provider issues."""
    msg = ""
    try:
        if hasattr(e, "args") and e.args:
            arg0 = e.args[0]
            if isinstance(arg0, (bytes, bytearray)):
                msg = arg0.decode("utf-8", errors="replace")
            else:
                msg = str(arg0)
        else:
            msg = str(e)
    except Exception:
        msg = str(e)
    # Strip imaplib's leading "[ALERT] " or trailing " (Failure)"
    msg = msg.strip().strip("'\"").strip()
    if msg.startswith("b'") and msg.endswith("'"):
        msg = msg[2:-1]
    lower = msg.lower()
    # Helpful hints for common providers
    if "yet to enable imap" in lower or "imap is disabled" in lower or "imap access" in lower:
        msg += " — Buka Zoho Mail → Settings → Mail Accounts → IMAP, aktifkan 'IMAP Access' lalu coba lagi."
    elif "authenticationfailed" in lower or "invalid credentials" in lower or "login failed" in lower or "auth failed" in lower:
        msg += " — Periksa username/password. Untuk Gmail, gunakan App Password (bukan password akun)."
    elif "application-specific password required" in lower:
        msg += " — Gmail butuh App Password. Generate di myaccount.google.com → Security → 2-Step Verification → App passwords."
    return msg


@api.post("/sub-companies/{sc_id}/test-imap")
async def test_sub_imap(sc_id: str, user: dict = Depends(get_current_user)):
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]})
    if not sc:
        raise HTTPException(404, "Sub-company not found")
    host = sc.get("imap_host")
    user_login = sc.get("imap_user") or sc.get("smtp_user")
    password = sc.get("imap_password") or sc.get("smtp_password")
    if not host or not user_login or not password:
        raise HTTPException(400, "IMAP host/user/password belum di-set")

    def _imap_check():
        import imaplib, socket
        port = int(sc.get("imap_port") or 993)
        use_ssl = bool(sc.get("imap_ssl", True))
        try:
            socket.setdefaulttimeout(15)
            cls = imaplib.IMAP4_SSL if use_ssl else imaplib.IMAP4
            with cls(host, port) as m:
                m.login(user_login, password)
                typ, data = m.select("INBOX", readonly=True)
                if typ != "OK":
                    return {"ok": False, "error": "Cannot select INBOX"}
                # Count messages
                typ, msgs = m.status("INBOX", "(MESSAGES UNSEEN)")
                return {"ok": True, "status": (msgs[0].decode() if msgs and msgs[0] else "")}
        except Exception as e:
            return {"ok": False, "error": _format_imap_error(e)}

    result = await asyncio.to_thread(_imap_check)
    if not result["ok"]:
        raise HTTPException(400, f"IMAP test gagal: {result['error']}")
    return {"ok": True, "message": f"IMAP login berhasil — {result.get('status', 'INBOX OK')}"}


@api.get("/inbox/companies")
async def inbox_companies(user: dict = Depends(get_current_user)):
    """List sub-companies user has access to with IMAP configured."""
    q = {"tenant_id": user["tenant_id"]}
    if user["role"] not in ("Owner", "Admin") and user.get("sub_company_ids"):
        q["id"] = {"$in": user["sub_company_ids"]}
    rows = await db.sub_companies.find(q, {"_id": 0, "id": 1, "name": 1, "imap_host": 1, "imap_user": 1, "smtp_user": 1}).to_list(100)
    out = []
    for r in rows:
        if r.get("imap_host"):
            out.append({"id": r["id"], "name": r["name"], "imap_host": r["imap_host"],
                        "email": r.get("imap_user") or r.get("smtp_user")})
    return out


# ─── IMAP helpers ───
FOLDER_KEYS = ("INBOX", "Sent", "Trash")


# ─── Mailer-Daemon bounce parsing ───
_BOUNCE_FROM_RE = re.compile(r"(mailer[\-\s]?daemon|postmaster|mail[\-\s]?delivery[\-\s]?system|mail[\-\s]?daemon)", re.I)
_BOUNCE_SUBJ_RE = re.compile(r"(undelivered|delivery (status notification|failed|failure)|returned to sender|mail delivery failed|failure notice|bounced|could not be delivered)", re.I)
_FINAL_RECIPIENT_RE = re.compile(r"(?:Final|Original)-Recipient:\s*[^;]+;\s*<?([^\s>,]+@[^\s>,]+)", re.I)
_STATUS_RE = re.compile(r"Status:\s*([245]\.\d+\.\d+)", re.I)
_DIAGNOSTIC_RE = re.compile(r"Diagnostic-Code:\s*[^;]*;\s*(.+)", re.I)
_EMAIL_ANGLE_RE = re.compile(r"<([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>")


def _is_bounce_email(from_str: str, subject: str) -> bool:
    """Heuristic untuk mendeteksi email Mailer-Daemon dari header From/Subject."""
    if from_str and _BOUNCE_FROM_RE.search(from_str):
        return True
    if subject and _BOUNCE_SUBJ_RE.search(subject):
        return True
    return False


def _parse_bounce_body(raw_bytes: bytes) -> list:
    """Parse DSN / plain-text bounce body. Return list of (failed_email, diagnostic).
    Hanya hard bounce (5.x.x) yang dianggap; soft bounce (4.x.x) di-skip."""
    import email as email_lib
    try:
        msg = email_lib.message_from_bytes(raw_bytes)
    except Exception:
        return []
    text_parts = []
    for part in msg.walk():
        ctype = part.get_content_type()
        if ctype == "message/delivery-status":
            # DSN: sub-parts are header-only Message objects per recipient.
            try:
                subs = part.get_payload()
                if isinstance(subs, list):
                    for sub in subs:
                        if hasattr(sub, "items"):
                            text_parts.append("\n".join(f"{k}: {v}" for k, v in sub.items()))
            except Exception:
                pass
            continue
        if ctype in ("text/plain", "text/rfc822-headers", "message/rfc822",
                     "message/global-delivery-status"):
            try:
                payload = part.get_payload(decode=True) or b""
                text_parts.append(payload.decode(errors="ignore"))
            except Exception:
                pass
    full_text = "\n".join(text_parts)
    if not full_text:
        try:
            full_text = (msg.get_payload(decode=True) or b"").decode(errors="ignore")
        except Exception:
            full_text = ""

    emails_found = set()
    for m in _FINAL_RECIPIENT_RE.finditer(full_text):
        emails_found.add(m.group(1).strip().lower())
    status_m = _STATUS_RE.search(full_text)
    status = status_m.group(1) if status_m else None
    diag_m = _DIAGNOSTIC_RE.search(full_text)
    diag = (diag_m.group(1).strip()[:300] if diag_m else None) or (status or "Mailer-Daemon bounce")
    # Skip soft bounce (4.x.x)
    if status and status.startswith("4."):
        return []
    if not emails_found:
        for m in _EMAIL_ANGLE_RE.finditer(full_text[:6000]):
            e = m.group(1).strip().lower()
            if any(b in e for b in ("mailer-daemon", "postmaster", "mail-daemon")):
                continue
            emails_found.add(e)
    return [(e, diag) for e in emails_found if e]


def _resolve_folder(imap_conn, folder_key: str) -> str:
    """Resolve a logical folder name (INBOX/Sent/Trash) to a real IMAP mailbox.
    Uses SPECIAL-USE flags first, falls back to common names per provider.
    """
    if folder_key == "INBOX":
        return "INBOX"
    flag_map = {"Sent": "\\Sent", "Trash": "\\Trash"}
    flag = flag_map.get(folder_key)
    try:
        typ, data = imap_conn.list()
        if typ == "OK" and data:
            for raw in data:
                if not raw:
                    continue
                line = raw.decode(errors="ignore") if isinstance(raw, bytes) else str(raw)
                if flag and flag in line:
                    # Format: (\HasNoChildren \Sent) "/" "INBOX/Sent"
                    parts = line.split(' "')
                    if len(parts) >= 2:
                        name = parts[-1].strip().strip('"')
                        return name
    except Exception:
        pass
    # Fallback common names
    fallback = {
        "Sent": ["Sent", "Sent Items", "[Gmail]/Sent Mail", "INBOX.Sent", "Sent Messages"],
        "Trash": ["Trash", "Deleted Items", "[Gmail]/Trash", "INBOX.Trash", "Deleted Messages"],
    }
    return fallback.get(folder_key, [folder_key])[0]


def _imap_connect(sc: dict):
    import imaplib, socket
    host = sc.get("imap_host")
    login = sc.get("imap_user") or sc.get("smtp_user")
    password = sc.get("imap_password") or sc.get("smtp_password")
    port = int(sc.get("imap_port") or 993)
    use_ssl = bool(sc.get("imap_ssl", True))
    socket.setdefaulttimeout(25)
    cls = imaplib.IMAP4_SSL if use_ssl else imaplib.IMAP4
    m = cls(host, port)
    m.login(login, password)
    return m


def _decode_hdr(value: str) -> str:
    from email.header import decode_header, make_header
    try:
        return str(make_header(decode_header(value or "")))
    except Exception:
        return value or ""


async def _check_inbox_access(sc_id: str, user: dict) -> dict:
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]})
    if not sc:
        raise HTTPException(404, "Sub-company not found")
    if user["role"] not in ("Owner", "Admin") and sc_id not in (user.get("sub_company_ids") or []):
        raise HTTPException(403, "Tidak punya akses ke inbox company ini")
    if not sc.get("imap_host") or not (sc.get("imap_user") or sc.get("smtp_user")) or not (sc.get("imap_password") or sc.get("smtp_password")):
        raise HTTPException(400, "IMAP belum di-set untuk company ini")
    return sc


@api.get("/inbox/{sc_id}")
async def inbox_list(
    sc_id: str,
    folder: str = "INBOX",
    limit: int = 50,
    unread_only: bool = False,
    sync: bool = False,
    user: dict = Depends(get_current_user),
):
    """Fetch emails for a sub-company folder.

    Strategy: CACHE-FIRST + DELTA SYNC. Tiap pesan disimpan di `inbox_cache` collection.
    Default (sync=False): kembalikan cached messages instan (sangat cepat, no IMAP call).
    sync=True: IMAP fetch HANYA UID baru (lebih besar dari max UID cache), upsert ke
    cache, lalu return cache terbaru. Email lama TIDAK di-fetch ulang → tidak berat.
    """
    if folder not in FOLDER_KEYS:
        raise HTTPException(400, "folder harus salah satu: INBOX, Sent, Trash")
    sc = await _check_inbox_access(sc_id, user)

    # Query cached
    cache_q = {"tenant_id": user["tenant_id"], "sub_company_id": sc_id, "folder": folder}
    if unread_only:
        cache_q["unread"] = True

    # Trigger IMAP sync ONLY when client explicitly requests (sync=true).
    # Initial cached-load (sync=false) selalu return instant dari MongoDB cache,
    # walau kosong → frontend trigger background sync setelah render cache.
    do_sync = bool(sync)

    if do_sync:
        # Find current max UID in cache for delta-sync
        last = await db.inbox_cache.find_one(
            {"tenant_id": user["tenant_id"], "sub_company_id": sc_id, "folder": folder},
            sort=[("uid_int", -1)],
            projection={"_id": 0, "uid_int": 1},
        )
        last_uid = (last or {}).get("uid_int", 0)

        def _fetch_new():
            import email
            try:
                with _imap_connect(sc) as m:
                    mailbox = _resolve_folder(m, folder)
                    typ, _ = m.select(mailbox, readonly=True)
                    if typ != "OK":
                        return {"_error": f"Folder tidak ditemukan: {mailbox}"}
                    # Search hanya UID > last_uid (delta — paling cepat)
                    criteria = f"UID {last_uid + 1}:*" if last_uid > 0 else "ALL"
                    typ, data = m.uid("search", None, criteria)
                    if typ != "OK" or not data or not data[0]:
                        return {"mailbox": mailbox, "new": []}
                    uids = data[0].split()
                    # Limit ke 200 email terbaru kalau initial sync (besar)
                    if last_uid == 0:
                        uids = uids[-200:]
                    items = []
                    for uid in uids:
                        typ, msg_data = m.uid("fetch", uid, "(BODY.PEEK[HEADER] FLAGS)")
                        if typ != "OK" or not msg_data:
                            continue
                        raw = b""
                        flags_str = ""
                        for part in msg_data:
                            if isinstance(part, tuple):
                                raw = part[1]
                            elif isinstance(part, bytes):
                                flags_str = part.decode(errors="ignore")
                        msg = email.message_from_bytes(raw)
                        from_s = _decode_hdr(msg.get("From", ""))
                        subject_s = _decode_hdr(msg.get("Subject", "")) or "(no subject)"
                        item = {
                            "uid": uid.decode(),
                            "uid_int": int(uid.decode()),
                            "from": from_s,
                            "to": _decode_hdr(msg.get("To", "")),
                            "subject": subject_s,
                            "date": msg.get("Date", ""),
                            "message_id": msg.get("Message-ID", ""),
                            "unread": "\\Seen" not in flags_str,
                        }
                        # Detect Mailer-Daemon bounce & fetch full body to parse failed recipients
                        if folder == "INBOX" and _is_bounce_email(from_s, subject_s):
                            try:
                                typ2, body_data = m.uid("fetch", uid, "(BODY.PEEK[])")
                                if typ2 == "OK" and body_data:
                                    raw_full = b""
                                    for p in body_data:
                                        if isinstance(p, tuple):
                                            raw_full = p[1]
                                            break
                                    if raw_full:
                                        item["_bounce_parsed"] = _parse_bounce_body(raw_full)
                                        item["is_bounce"] = True
                            except Exception:
                                pass
                        items.append(item)
                    return {"mailbox": mailbox, "new": items}
            except Exception as e:
                return {"_error": _format_imap_error(e)}

        result = await asyncio.to_thread(_fetch_new)
        if isinstance(result, dict) and "_error" in result:
            # IMAP error: kalau cache benar2 kosong, throw; kalau ada cache, soft-fail.
            cached_count = await db.inbox_cache.count_documents(cache_q)
            if cached_count == 0:
                raise HTTPException(400, f"IMAP error: {result['_error']}")
        else:
            # Process Mailer-Daemon auto-bounce + upsert ke cache
            bounce_processed = 0
            bounce_matched = 0
            for it in result.get("new", []):
                parsed = it.pop("_bounce_parsed", None) if isinstance(it, dict) else None
                if parsed:
                    for failed_email, diag in parsed:
                        try:
                            res = await _mark_bounced_by_email(
                                user["tenant_id"], failed_email,
                                f"Mailer-Daemon: {diag}",
                                source="inbox-auto",
                            )
                            bounce_processed += 1
                            if res.get("matched"):
                                bounce_matched += 1
                        except Exception:
                            pass
                await db.inbox_cache.update_one(
                    {"tenant_id": user["tenant_id"], "sub_company_id": sc_id, "folder": folder, "uid": it["uid"]},
                    {"$set": {**it, "tenant_id": user["tenant_id"], "sub_company_id": sc_id,
                              "folder": folder, "fetched_at": now_iso()}},
                    upsert=True,
                )

    # Return cached messages (sort newest first by uid_int desc)
    messages = await db.inbox_cache.find(cache_q, {"_id": 0, "tenant_id": 0, "sub_company_id": 0, "folder": 0, "fetched_at": 0}).sort("uid_int", -1).limit(limit).to_list(limit)
    return {
        "sub_company_id": sc_id,
        "sub_company_name": sc["name"],
        "folder": folder,
        "mailbox": folder,
        "count": len(messages),
        "messages": messages,
        "synced": do_sync,
        "bounce_processed": locals().get("bounce_processed", 0),
        "bounce_matched": locals().get("bounce_matched", 0),
    }


@api.post("/inbox/{sc_id}/rescan-bounces")
async def inbox_rescan_bounces(
    sc_id: str,
    folder: str = "INBOX",
    limit: int = 500,
    user: dict = Depends(get_current_user),
):
    """Rescan inbox utk Mailer-Daemon yang sudah ada (sebelum auto-detect aktif).
    Fetch FULL body untuk tiap email yang From/Subject-nya match bounce pattern,
    parse failed recipients, dan mark bounce di DB.
    """
    if folder not in FOLDER_KEYS:
        raise HTTPException(400, "folder harus salah satu: INBOX, Sent, Trash")
    sc = await _check_inbox_access(sc_id, user)

    # Ambil kandidat dari cache (lebih cepat) — pre-filter by From/Subject regex
    cached = await db.inbox_cache.find(
        {"tenant_id": user["tenant_id"], "sub_company_id": sc_id, "folder": folder},
        {"_id": 0, "uid": 1, "from": 1, "subject": 1},
    ).sort("uid_int", -1).limit(limit).to_list(limit)
    candidates = [c for c in cached if _is_bounce_email(c.get("from", ""), c.get("subject", ""))]
    if not candidates:
        return {"scanned": 0, "bounce_processed": 0, "bounce_matched": 0, "message": "Tidak ada email Mailer-Daemon di cache. Coba sync inbox dulu (?sync=true)."}

    def _fetch_bodies():
        import email as email_lib
        out = []
        try:
            with _imap_connect(sc) as m:
                mailbox = _resolve_folder(m, folder)
                typ, _ = m.select(mailbox, readonly=True)
                if typ != "OK":
                    return {"_error": f"Folder tidak ditemukan: {mailbox}"}
                for c in candidates:
                    uid = c.get("uid")
                    if not uid:
                        continue
                    try:
                        typ2, body_data = m.uid("fetch", uid, "(BODY.PEEK[])")
                        if typ2 != "OK" or not body_data:
                            continue
                        raw_full = b""
                        for p in body_data:
                            if isinstance(p, tuple):
                                raw_full = p[1]
                                break
                        if raw_full:
                            parsed = _parse_bounce_body(raw_full)
                            if parsed:
                                out.append({"uid": uid, "parsed": parsed})
                    except Exception:
                        continue
                return {"bodies": out}
        except Exception as e:
            return {"_error": _format_imap_error(e)}

    res = await asyncio.to_thread(_fetch_bodies)
    if "_error" in res:
        raise HTTPException(400, f"IMAP error: {res['_error']}")

    bounce_processed = 0
    bounce_matched = 0
    failed_emails: list = []
    for entry in res.get("bodies", []):
        for failed_email, diag in entry["parsed"]:
            try:
                r = await _mark_bounced_by_email(
                    user["tenant_id"], failed_email,
                    f"Mailer-Daemon: {diag}", source="inbox-rescan",
                )
                bounce_processed += 1
                if r.get("matched"):
                    bounce_matched += 1
                failed_emails.append({"email": failed_email, "matched": r.get("matched", False)})
            except Exception:
                pass
        # Tandai cached entry sbg sudah diproses
        await db.inbox_cache.update_one(
            {"tenant_id": user["tenant_id"], "sub_company_id": sc_id, "folder": folder, "uid": entry["uid"]},
            {"$set": {"is_bounce": True, "bounce_rescanned_at": now_iso()}},
        )

    return {
        "scanned": len(candidates),
        "bodies_parsed": len(res.get("bodies", [])),
        "bounce_processed": bounce_processed,
        "bounce_matched": bounce_matched,
        "failed_emails": failed_emails[:100],
    }


def _extract_body(msg) -> dict:
    """Return {text, html} from an email.Message."""
    text_body = ""
    html_body = ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "").lower()
            if "attachment" in disp:
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or "utf-8"
                decoded = payload.decode(charset, errors="replace")
            except Exception:
                continue
            if ctype == "text/plain" and not text_body:
                text_body = decoded
            elif ctype == "text/html" and not html_body:
                html_body = decoded
    else:
        try:
            payload = msg.get_payload(decode=True)
            charset = msg.get_content_charset() or "utf-8"
            decoded = payload.decode(charset, errors="replace") if payload else ""
        except Exception:
            decoded = ""
        if msg.get_content_type() == "text/html":
            html_body = decoded
        else:
            text_body = decoded
    return {"text": text_body, "html": html_body}


@api.get("/inbox/{sc_id}/message/{uid}")
async def inbox_message_detail(
    sc_id: str,
    uid: str,
    folder: str = "INBOX",
    mark_seen: bool = True,
    user: dict = Depends(get_current_user),
):
    """Fetch a single email's full body and mark it as read (default)."""
    if folder not in FOLDER_KEYS:
        raise HTTPException(400, "folder harus salah satu: INBOX, Sent, Trash")
    sc = await _check_inbox_access(sc_id, user)

    def _fetch():
        import email
        try:
            with _imap_connect(sc) as m:
                mailbox = _resolve_folder(m, folder)
                typ, _ = m.select(mailbox, readonly=not mark_seen)
                if typ != "OK":
                    return {"_error": f"Folder tidak ditemukan: {mailbox}"}
                typ, msg_data = m.fetch(uid.encode(), "(RFC822 FLAGS)")
                if typ != "OK" or not msg_data:
                    return {"_error": "Pesan tidak ditemukan"}
                raw = b""
                flags_str = ""
                for part in msg_data:
                    if isinstance(part, tuple):
                        raw = part[1]
                    elif isinstance(part, bytes):
                        flags_str = part.decode(errors="ignore")
                msg = email.message_from_bytes(raw)
                body = _extract_body(msg)
                was_unread = "\\Seen" not in flags_str
                if mark_seen and was_unread:
                    try:
                        m.store(uid.encode(), "+FLAGS", "\\Seen")
                    except Exception:
                        pass
                return {
                    "uid": uid,
                    "from": _decode_hdr(msg.get("From", "")),
                    "to": _decode_hdr(msg.get("To", "")),
                    "cc": _decode_hdr(msg.get("Cc", "")),
                    "subject": _decode_hdr(msg.get("Subject", "")) or "(no subject)",
                    "date": msg.get("Date", ""),
                    "message_id": msg.get("Message-ID", ""),
                    "in_reply_to": msg.get("In-Reply-To", ""),
                    "references": msg.get("References", ""),
                    "reply_to": _decode_hdr(msg.get("Reply-To", "")),
                    "text": body["text"],
                    "html": body["html"],
                    "unread": False if mark_seen else was_unread,
                }
        except Exception as e:
            return {"_error": str(e)}

    result = await asyncio.to_thread(_fetch)
    if isinstance(result, dict) and "_error" in result:
        raise HTTPException(400, f"IMAP error: {result['_error']}")
    return result


class InboxMarkReq(BaseModel):
    uid: str
    folder: str = "INBOX"
    seen: bool = True


@api.post("/inbox/{sc_id}/mark")
async def inbox_mark(sc_id: str, req: InboxMarkReq, user: dict = Depends(get_current_user)):
    """Mark a message as read/unread."""
    if req.folder not in FOLDER_KEYS:
        raise HTTPException(400, "folder tidak valid")
    sc = await _check_inbox_access(sc_id, user)

    def _mark():
        try:
            with _imap_connect(sc) as m:
                mailbox = _resolve_folder(m, req.folder)
                typ, _ = m.select(mailbox, readonly=False)
                if typ != "OK":
                    return {"_error": f"Folder tidak ditemukan: {mailbox}"}
                op = "+FLAGS" if req.seen else "-FLAGS"
                m.store(req.uid.encode(), op, "\\Seen")
                return {"ok": True}
        except Exception as e:
            return {"_error": str(e)}

    result = await asyncio.to_thread(_mark)
    if "_error" in result:
        raise HTTPException(400, f"IMAP error: {result['_error']}")
    return {"ok": True, "uid": req.uid, "seen": req.seen}


class InboxReplyReq(BaseModel):
    uid: str
    folder: str = "INBOX"
    to: EmailStr
    cc: Optional[str] = None
    subject: str
    body_html: str
    in_reply_to: Optional[str] = None
    references: Optional[str] = None


@api.post("/inbox/{sc_id}/reply")
async def inbox_reply(sc_id: str, req: InboxReplyReq, user: dict = Depends(get_current_user)):
    """Send a reply via SMTP using the sub-company config, with proper threading headers.
    Also appends the sent message to the Sent folder via IMAP.
    """
    sc = await _check_inbox_access(sc_id, user)
    if not sc.get("smtp_host") or not sc.get("smtp_user"):
        raise HTTPException(400, "SMTP belum di-set untuk company ini")

    from_email = sc.get("smtp_from_email") or sc.get("smtp_user")
    from_name = sc.get("smtp_from_name") or sc.get("name")

    # Build the message manually so we can attach In-Reply-To / References
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.utils import make_msgid, formatdate
    import re as _re

    msg = MIMEMultipart("alternative")
    msg["Subject"] = req.subject
    msg["From"] = f'"{from_name}" <{from_email}>' if from_name else from_email
    msg["To"] = req.to
    if req.cc:
        msg["Cc"] = req.cc
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid()
    if req.in_reply_to:
        msg["In-Reply-To"] = req.in_reply_to
        msg["References"] = (req.references + " " + req.in_reply_to).strip() if req.references else req.in_reply_to
    plain = _re.sub(r"<[^>]+>", " ", req.body_html)
    msg.attach(MIMEText(plain, "plain", "utf-8"))
    msg.attach(MIMEText(req.body_html, "html", "utf-8"))

    raw_msg = msg.as_string()

    def _send_and_append():
        import smtplib
        # Send via SMTP
        try:
            port = int(sc.get("smtp_port") or 587)
            use_tls = bool(sc.get("smtp_use_tls", True))
            if use_tls and port == 465:
                server = smtplib.SMTP_SSL(sc["smtp_host"], port, timeout=25)
            else:
                server = smtplib.SMTP(sc["smtp_host"], port, timeout=25)
                if use_tls:
                    server.ehlo(); server.starttls(); server.ehlo()
            if sc.get("smtp_user"):
                server.login(sc["smtp_user"], sc.get("smtp_password") or "")
            rcpts = [req.to] + ([c.strip() for c in (req.cc or "").split(",") if c.strip()])
            server.sendmail(from_email, rcpts, raw_msg)
            server.quit()
        except Exception as e:
            return {"_error": f"SMTP gagal: {e}"}
        # Append to Sent folder via IMAP (best-effort)
        try:
            with _imap_connect(sc) as m:
                sent_box = _resolve_folder(m, "Sent")
                m.append(sent_box, "\\Seen", None, raw_msg.encode("utf-8", errors="replace"))
        except Exception as e:
            return {"ok": True, "warn": f"Terkirim tapi gagal simpan ke Sent: {e}"}
        return {"ok": True}

    result = await asyncio.to_thread(_send_and_append)
    if "_error" in result:
        raise HTTPException(400, result["_error"])
    return result


@api.get("/working-config")
async def get_working_config(user: dict = Depends(get_current_user)):
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}) or {}
    return {
        "working_days": tenant.get("working_days") or DEFAULT_WORKING_DAYS,
        "holidays": tenant.get("holidays") or [],
    }


@api.patch("/working-config")
async def update_working_config(payload: WorkingConfigUpdate, user: dict = Depends(get_current_user)):
    perms = await get_user_permissions(user)
    if user["role"] != "Owner" and "manage_company" not in perms:
        raise HTTPException(403, "Missing permission: manage_company")
    upd = {}
    if payload.working_days is not None:
        upd["working_days"] = payload.working_days
    if payload.holidays is not None:
        # validate ISO format YYYY-MM-DD
        valid = []
        for h in payload.holidays:
            try:
                datetime.strptime(h, "%Y-%m-%d")
                valid.append(h)
            except ValueError:
                continue
        upd["holidays"] = sorted(set(valid))
    if upd:
        await db.tenants.update_one({"id": user["tenant_id"]}, {"$set": upd})
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}) or {}
    return {
        "working_days": tenant.get("working_days") or DEFAULT_WORKING_DAYS,
        "holidays": tenant.get("holidays") or [],
    }


def _email_view(c: dict) -> dict:
    """Build a UI-friendly email object from a workflow contact, preserving verifier details."""
    score = c.get("confidence_score") or 0
    status = c.get("status") or ("verified" if score >= 80 else "risky")
    verifier = c.get("verifier") or {}
    sources_list = c.get("sources_list") or []
    cross_validated = len(sources_list) > 1
    # Build a human-readable description so users can decide whether to save / send
    bits = []
    if cross_validated:
        bits.append("Cross-validated: ditemukan di Website crawl DAN Hunter.io (paling tepercaya)")
    elif c.get("source") == "website":
        bits.append("Ditemukan langsung di website — dianggap verified")
    elif c.get("source") == "website_external":
        bits.append("Ditemukan di website tapi domain berbeda (sibling brand / sub-domain group) — masih dianggap kontak resmi")
    elif c.get("source") == "hunter":
        bits.append("Dari Hunter.io domain-search (alias verifier internal dijalankan)")
    elif c.get("source") == "alias":
        bits.append("Alias generic (auto-injected) — diverifikasi via Alias Verifier internal (SMTP/MX/catch-all)")
    v_result = (verifier.get("result") or "").lower()
    v_score = verifier.get("score")
    if v_result == "deliverable":
        bits.append("Verifier: deliverable ✓ — aman dikirim")
    elif v_result == "undeliverable":
        bits.append("Verifier: undeliverable ✗ — kemungkinan besar bounce, JANGAN kirim")
    elif v_result == "risky":
        bits.append("Verifier: risky ⚠ — mungkin catch-all / role-based, ~50% chance bounce")
    elif v_result == "unknown":
        bits.append(f"Verifier: unknown — score {v_score or 0}, SMTP tidak respon (port mungkin diblok)")
    # New alias-verifier engine details
    engine_status = verifier.get("status")
    if engine_status == "VALID":
        bits.append("Status: VALID ✓ — public + SMTP 250")
    elif engine_status == "LIKELY_VALID":
        bits.append("Status: LIKELY_VALID — alias + SMTP 250 (bukan catch-all)")
    elif engine_status == "ACCEPT_ALL":
        bits.append("Status: ACCEPT_ALL ⚠ — SMTP terima email (sendable), tapi domain catch-all sehingga tidak bisa pastikan user spesifik ada")
    elif engine_status == "INVALID":
        bits.append("Status: INVALID ✗ — SMTP reject / domain tidak ada")
    elif engine_status == "UNKNOWN":
        bits.append("Status: UNKNOWN — SMTP tidak respon")
    if verifier.get("provider"):
        bits.append(f"Provider: {verifier['provider']}")
    if verifier.get("webmail"):
        bits.append("Webmail (Gmail/Yahoo dll) — kurang ideal untuk B2B outreach")
    if verifier.get("disposable"):
        bits.append("Disposable address — tidak disarankan")
    if verifier.get("accept_all") or verifier.get("catch_all"):
        bits.append("Server accept-all — tidak bisa pastikan ada user-nya")
    description = " · ".join(bits) if bits else "—"
    return {
        "email": c["email"],
        "name": c.get("name"),
        "job_title": c.get("job_title"),
        "source": c.get("source"),
        "sources": sources_list,
        "cross_validated": cross_validated,
        "confidence": score,
        "status": status,
        "description": description,
        "verifier": {k: verifier.get(k) for k in (
            "result", "score", "webmail", "disposable", "accept_all", "smtp_check",
            "status", "catch_all", "mx_found", "provider", "smtp_code", "reasons",
        )},
    }


@api.post("/prospects/discover")
async def prospects_discover(payload: HunterSearchReq, user: dict = Depends(get_current_user)):
    """Discover company info + emails for a domain (without saving). Front-end displays results."""
    from hunter_service import _extract_extra_path
    extra_path = _extract_extra_path(payload.domain)
    domain = _normalize_domain(payload.domain)
    cached = await db.global_hunter_cache.find_one({"domain": domain})
    if cached and not payload.force_refresh:
        age_days = (datetime.now(timezone.utc) - datetime.fromisoformat(cached["cached_at"])).days
        if age_days < GLOBAL_CACHE_DAYS:
            return {
                "domain": domain,
                "company": cached["company"],
                "emails": [_email_view(c) for c in cached["contacts"]],
                "cached": True, "age_days": age_days,
            }
    aliases = await _resolve_aliases_for_search(user["tenant_id"], payload.category_id)
    result = await run_hunter_workflow(domain, aliases=aliases, extra_path=extra_path)
    # update global cache
    await db.global_hunter_cache.update_one(
        {"domain": domain},
        {"$set": {"domain": domain, "company": result["company"], "contacts": result["contacts"],
                  "company_name": result["company"].get("company_name"), "cached_at": now_iso()}},
        upsert=True,
    )
    return {
        "domain": domain,
        "company": result["company"],
        "emails": [_email_view(c) for c in result["contacts"]],
        "cached": False,
    }


@api.get("/prospects")
async def list_prospects(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,
    assigned_user_id: Optional[str] = None,
    q: Optional[str] = None,
    sub_company_id: Optional[str] = None,
    category_id: Optional[str] = None,
    location_id: Optional[str] = None,
):
    qdoc = _prospect_scope(user)
    if status: qdoc["status"] = status
    if assigned_user_id: qdoc["assigned_user_id"] = assigned_user_id
    if sub_company_id: qdoc["sub_company_id"] = sub_company_id
    if category_id: qdoc["category_id"] = category_id
    if location_id: qdoc["location_id"] = location_id
    rows = await db.prospects.find(qdoc, {"_id": 0}).sort("created_at", -1).to_list(2000)
    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in
                f"{r.get('company_name','')} {r.get('website','')} {r.get('domain','')} {r.get('industry','')} {' '.join(e.get('email','') for e in r.get('emails',[]))}".lower()]
    users_map = {u["id"]: u async for u in db.users.find({"tenant_id": user["tenant_id"]}, {"_id": 0, "password_hash": 0})}
    sub_map = {s["id"]: s async for s in db.sub_companies.find({"tenant_id": user["tenant_id"]}, {"_id": 0})}
    return [_prospect_view(r, users_map, sub_map) for r in rows]


@api.post("/prospects")
async def create_prospect(payload: ProspectCreate, user: dict = Depends(get_current_user)):
    pid = str(uuid.uuid4())
    domain = _normalize_domain(payload.domain or payload.website or "") if (payload.domain or payload.website) else None
    emails = [e.model_dump() for e in payload.emails]
    # Ensure at most one primary, default first if none
    primary_count = sum(1 for e in emails if e.get("is_primary"))
    if primary_count == 0 and emails:
        emails[0]["is_primary"] = True
    elif primary_count > 1:
        seen = False
        for e in emails:
            if e.get("is_primary"):
                if seen: e["is_primary"] = False
                else: seen = True
    # Add ids to emails
    for e in emails:
        e["id"] = str(uuid.uuid4())

    doc = {
        "id": pid,
        "tenant_id": user["tenant_id"],
        "company_name": payload.company_name,
        "website": payload.website,
        "domain": domain,
        "industry": payload.industry,
        "country": payload.country,
        "city": payload.city,
        "phone": payload.phone,
        "linkedin": payload.linkedin,
        "emails": emails,
        "notes": payload.notes,
        "sub_company_id": payload.sub_company_id,
        "assigned_user_id": payload.assigned_user_id or user["id"],
        "category_id": payload.category_id,
        "location_id": payload.location_id,
        "status": payload.status,
        "created_by": user["id"],
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "last_activity_at": now_iso(),
    }
    await db.prospects.insert_one(doc)
    await _log_activity(pid, user["tenant_id"], "prospect_created", user["id"], {"company_name": payload.company_name})
    doc.pop("_id", None)
    return doc


@api.get("/prospects/{pid}")
async def get_prospect(pid: str, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one(_prospect_scope(user, {"id": pid}), {"_id": 0})
    if not p:
        raise HTTPException(404, "Prospect not found")
    activity = await db.prospect_activity.find({"prospect_id": pid}, {"_id": 0}).sort("created_at", -1).to_list(200)
    user_ids = list({a["user_id"] for a in activity if a.get("user_id")})
    users = {u["id"]: u["name"] async for u in db.users.find({"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "name": 1})}
    for a in activity:
        a["user_name"] = users.get(a.get("user_id"))
    # Email sends for this prospect
    sends = await db.email_sends.find({"prospect_id": pid}, {"_id": 0}).sort("created_at", -1).to_list(200)
    return {"prospect": _prospect_view(p), "activity": activity, "email_sends": sends}


@api.patch("/prospects/{pid}")
async def update_prospect(pid: str, payload: ProspectUpdate, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one(_prospect_scope(user, {"id": pid}))
    if not p:
        raise HTTPException(404, "Prospect not found")
    upd = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if "status" in upd and upd["status"] != p.get("status"):
        await _log_activity(pid, user["tenant_id"], "status_changed", user["id"],
                            {"from": p.get("status"), "to": upd["status"]})
    if upd:
        upd["updated_at"] = now_iso()
        upd["last_activity_at"] = now_iso()
        await db.prospects.update_one({"id": pid}, {"$set": upd})
    out = await db.prospects.find_one({"id": pid}, {"_id": 0})
    return _prospect_view(out)


@api.delete("/prospects/{pid}")
async def delete_prospect(pid: str, user: dict = Depends(get_current_user)):
    perms = await get_user_permissions(user)
    if user["role"] != "Owner" and "delete_prospects" not in perms:
        raise HTTPException(403, "Missing permission: delete_prospects")
    res = await db.prospects.delete_one(_prospect_scope(user, {"id": pid}))
    if res.deleted_count:
        await db.prospect_activity.delete_many({"prospect_id": pid})
        await db.email_sends.delete_many({"prospect_id": pid})
    return {"deleted": res.deleted_count}


@api.post("/prospects/{pid}/emails")
async def add_prospect_email(pid: str, payload: ProspectEmailAdd, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one(_prospect_scope(user, {"id": pid}))
    if not p:
        raise HTTPException(404, "Prospect not found")
    new_email = {"id": str(uuid.uuid4()), "email": payload.email, "is_primary": payload.is_primary,
                 "status": payload.status, "source": "manual", "confidence": None}
    emails = p.get("emails", [])
    if any(e["email"].lower() == payload.email.lower() for e in emails):
        raise HTTPException(400, "Email already exists for this prospect")
    if payload.is_primary:
        for e in emails:
            e["is_primary"] = False
    emails.append(new_email)
    await db.prospects.update_one({"id": pid}, {"$set": {"emails": emails, "updated_at": now_iso()}})
    return {"ok": True, "email": new_email}


@api.delete("/prospects/{pid}/emails/{email_id}")
async def remove_prospect_email(pid: str, email_id: str, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one(_prospect_scope(user, {"id": pid}))
    if not p:
        raise HTTPException(404, "Prospect not found")
    emails = [e for e in p.get("emails", []) if e.get("id") != email_id]
    await db.prospects.update_one({"id": pid}, {"$set": {"emails": emails, "updated_at": now_iso()}})
    return {"ok": True}


@api.post("/prospects/{pid}/notes")
async def add_prospect_note(pid: str, payload: NoteAdd, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]})
    if not p:
        raise HTTPException(404, "Prospect not found")
    await _log_activity(pid, user["tenant_id"], "note_added", user["id"], {"text": payload.text})
    await db.prospects.update_one({"id": pid}, {"$set": {"last_activity_at": now_iso()}})
    return {"ok": True}


# ─── Email send (single + bulk) ───
async def _load_template_extras(tenant_id: str, template_id: Optional[str]) -> tuple:
    """Return (body_type, attachments_list) for a template. Defaults to ('html', [])."""
    if not template_id:
        return "html", []
    tpl = await db.email_templates.find_one({"id": template_id, "tenant_id": tenant_id})
    if not tpl:
        return "html", []
    body_type = tpl.get("body_type") or "html"
    att_rows = await db.template_attachments.find(
        {"template_id": template_id, "tenant_id": tenant_id}
    ).to_list(50)
    atts = [
        {"filename": a.get("filename"), "content_type": a.get("content_type"), "data_b64": a.get("data_b64")}
        for a in att_rows
    ]
    return body_type, atts


def _apply_template_vars(text: str, prospect: dict, primary_email: str) -> str:
    """Replace {{name}}, {{company}}, {{email}}, {{industry}} variables."""
    if not text: return text
    # name = best email's local part as fallback name
    name = (primary_email or "").split("@")[0].replace(".", " ").replace("_", " ").title()
    repl = {
        "name": name,
        "company": prospect.get("company_name") or "",
        "email": primary_email or "",
        "industry": prospect.get("industry") or "",
        "website": prospect.get("website") or "",
        "city": prospect.get("city") or "",
        "country": prospect.get("country") or "",
    }
    for k, v in repl.items():
        text = text.replace("{{" + k + "}}", str(v))
        text = text.replace("{{ " + k + " }}", str(v))
    return text


async def _resolve_smtp(tenant_id: str, user_doc: dict, sub_company_id: Optional[str]) -> dict:
    """SMTP priority (highest → lowest):
      1. The user's OWN SMTP (if they set smtp_host) — overrides everything because each user
         sends with their own identity unless they explicitly opt in to use company SMTP.
      2. The explicit sub-company SMTP passed in (campaign target / prospect's company).
      3. Any sub-company assigned to the user that has SMTP configured.
      4. Tenant default SMTP.
    Setting user.smtp_use_company = True forces fallback to sub-company/tenant.
    """
    user_has_own = bool(user_doc.get("smtp_host"))
    use_company = bool(user_doc.get("smtp_use_company"))
    # 1. Prefer user's own SMTP unless they opted into company SMTP
    if user_has_own and not use_company:
        return user_doc
    # 2. Explicit sub-company SMTP (passed in)
    if sub_company_id:
        sc = await db.sub_companies.find_one({"id": sub_company_id, "tenant_id": tenant_id})
        if sc and sc.get("smtp_host"):
            return sc
    # 3. Any assigned sub-company with SMTP
    for sc_id in (user_doc.get("sub_company_ids") or []):
        sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": tenant_id})
        if sc and sc.get("smtp_host"):
            return sc
    # 4. Tenant fallback
    tenant = await db.tenants.find_one({"id": tenant_id})
    if tenant and tenant.get("smtp_host"):
        return tenant
    # 5. Last-resort: user's own SMTP even if smtp_use_company is True
    if user_has_own:
        return user_doc
    return None


@api.post("/prospects/{pid}/send-email")
async def send_prospect_email(pid: str, payload: SendEmailReq, background: BackgroundTasks, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]})
    if not p:
        raise HTTPException(404, "Prospect not found")
    # Daily quota lock check
    state = await _quota_state(user)
    if state["locked"] and not await _can_bypass_lock(user):
        raise HTTPException(423, f"Daily quota not met — add {state['remaining']} more prospect(s) before sending emails.")
    smtp_src = await _resolve_smtp(user["tenant_id"], user, payload.sub_company_id or p.get("sub_company_id"))
    if not smtp_src:
        raise HTTPException(400, "SMTP not configured (sub-company / user / tenant).")

    subject = _apply_template_vars(payload.subject, p, payload.to_email)
    body    = _apply_template_vars(payload.body_html, p, payload.to_email)

    send_id = str(uuid.uuid4())
    send_doc = {
        "id": send_id,
        "tenant_id": user["tenant_id"],
        "prospect_id": pid,
        "sender_user_id": user["id"],
        "sub_company_id": payload.sub_company_id or p.get("sub_company_id"),
        "template_id": payload.template_id,
        "to_email": payload.to_email,
        "subject": subject,
        "body_html": body,
        "scheduled_at": payload.scheduled_at,
        "status": "queued",
        "delivered": False, "opens": 0, "clicks": 0, "replied": False, "bounced": False,
        "error": None,
        "sent_at": None,
        "created_at": now_iso(),
    }
    await db.email_sends.insert_one(send_doc)

    async def _runner():
        body_type, atts = await _load_template_extras(user["tenant_id"], payload.template_id)
        from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
        from_name  = smtp_src.get("smtp_from_name")
        if body_type == "html":
            tracked = inject_tracking(body, send_id, PUBLIC_BASE_URL or "")
        else:
            tracked = body
        unsubscribe_url = f"{PUBLIC_BASE_URL}/api/track/unsubscribe/{send_id}" if PUBLIC_BASE_URL else None
        final_body, inline_imgs = await _extract_inline_images_for_send(tracked, user["tenant_id"])
        result = await asyncio.to_thread(
            send_smtp_email,
            smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
            smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
            bool(smtp_src.get("smtp_use_tls", True)),
            from_email, from_name, payload.to_email, subject, final_body,
            body_type, atts,
            inline_images=inline_imgs,
            list_unsubscribe_url=unsubscribe_url,
            reply_to=from_email,
        )
        if result["ok"]:
            await db.email_sends.update_one({"id": send_id}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
            await _log_activity(pid, user["tenant_id"], "email_sent", user["id"],
                                {"to": payload.to_email, "subject": subject, "send_id": send_id})
            # Auto-bump status from New → Contacted
            await db.prospects.update_one(
                {"id": pid, "status": "New"},
                {"$set": {"status": "Contacted", "last_activity_at": now_iso()}},
            )
        else:
            await _mark_bounced(send_id, result["error"], user["tenant_id"], payload.prospect_id, payload.to_email, user["id"])
            await _log_activity(pid, user["tenant_id"], "email_bounced", user["id"], {"to": payload.to_email, "error": result["error"]})
        await db.prospects.update_one({"id": pid}, {"$set": {"last_activity_at": now_iso()}})

    background.add_task(_runner)
    return {"send_id": send_id, "status": "queued"}


@api.post("/prospects/bulk-send-email")
async def bulk_send_email(payload: BulkSendEmailReq, background: BackgroundTasks, user: dict = Depends(get_current_user)):
    state = await _quota_state(user)
    if state["locked"] and not await _can_bypass_lock(user):
        raise HTTPException(423, f"Daily quota not met — add {state['remaining']} more prospect(s) before sending emails.")

    # Detect future schedule FIRST
    is_scheduled = False
    sched_iso = None
    if payload.scheduled_at:
        try:
            sched_dt = datetime.fromisoformat(payload.scheduled_at.replace("Z", "+00:00"))
            if sched_dt.tzinfo is None:
                sched_dt = sched_dt.replace(tzinfo=timezone.utc)
        except Exception:
            raise HTTPException(400, "scheduled_at format invalid — use ISO datetime (e.g. 2026-06-11T10:00:00Z)")
        if sched_dt <= datetime.now(timezone.utc) + timedelta(minutes=1):
            raise HTTPException(400, "scheduled_at harus minimal 1 menit dari sekarang")
        is_scheduled = True
        sched_iso = sched_dt.isoformat()

    # SMTP only required for immediate send. Scheduled emails will resolve SMTP at send-time.
    smtp_src = await _resolve_smtp(user["tenant_id"], user, payload.sub_company_id)
    if not is_scheduled and not smtp_src:
        raise HTTPException(400, "SMTP not configured.")

    prospects = await db.prospects.find({"tenant_id": user["tenant_id"], "id": {"$in": payload.prospect_ids}}, {"_id": 0}).to_list(2000)
    queued = 0
    new_send_ids = []
    for p in prospects:
        # Send to ALL valid emails of this prospect (not just primary)
        for e in (p.get("emails") or []):
            to_email = e.get("email")
            if not to_email:
                continue
            subject = _apply_template_vars(payload.subject, p, to_email)
            body    = _apply_template_vars(payload.body_html, p, to_email)
            send_id = str(uuid.uuid4())
            await db.email_sends.insert_one({
                "id": send_id, "tenant_id": user["tenant_id"], "prospect_id": p["id"],
                "sender_user_id": user["id"],
                "sub_company_id": payload.sub_company_id or p.get("sub_company_id"),
                "template_id": payload.template_id, "to_email": to_email,
                "subject": subject, "body_html": body,
                "scheduled_at": sched_iso,
                "status": "scheduled" if is_scheduled else "queued",
                "delivered": False, "opens": 0, "clicks": 0,
                "replied": False, "bounced": False, "error": None, "sent_at": None,
                "created_at": now_iso(),
            })
            queued += 1
            new_send_ids.append(send_id)

    # Transition any draft/ready task that contains these prospects → scheduled/sending.
    # Without this, the OutreachModal flow (Start Email Outreach button) would leave the
    # task as "draft" and it would keep showing up as "Tugas Aktif" forever.
    new_task_status = "scheduled" if is_scheduled else "sending"
    update_payload = {
        "status": new_task_status,
        "submit_at": now_iso(),
        "updated_at": now_iso(),
    }
    if is_scheduled:
        update_payload["scheduled_send_at"] = sched_iso
    await db.outreach_tasks.update_many(
        {
            "tenant_id": user["tenant_id"], "user_id": user["id"],
            "status": {"$in": ["draft", "ready"]},
            "prospect_ids": {"$elemMatch": {"$in": payload.prospect_ids}},
        },
        {"$set": update_payload},
    )

    # If scheduled, don't run now — scheduler worker picks it up
    if is_scheduled:
        return {"queued": queued, "scheduled_at": sched_iso, "scheduled": True}

    async def _runner_all():
        body_type, atts = await _load_template_extras(user["tenant_id"], payload.template_id)
        for sid in new_send_ids:
            s = await db.email_sends.find_one({"id": sid, "status": "queued"})
            if not s: continue
            from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
            from_name  = smtp_src.get("smtp_from_name")
            if body_type == "html":
                tracked = inject_tracking(s["body_html"], s["id"], PUBLIC_BASE_URL or "")
            else:
                tracked = s["body_html"]
            unsubscribe_url = f"{PUBLIC_BASE_URL}/api/track/unsubscribe/{s['id']}" if PUBLIC_BASE_URL else None
            final_body, inline_imgs = await _extract_inline_images_for_send(tracked, user["tenant_id"])
            result = await asyncio.to_thread(
                send_smtp_email,
                smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                bool(smtp_src.get("smtp_use_tls", True)),
                from_email, from_name, s["to_email"], s["subject"], final_body,
                body_type, atts,
                inline_images=inline_imgs,
                list_unsubscribe_url=unsubscribe_url,
                reply_to=from_email,
            )
            if result["ok"]:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                await _log_activity(s["prospect_id"], user["tenant_id"], "email_sent", user["id"], {"to": s["to_email"], "send_id": s["id"]})
                await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                              {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
            else:
                await _mark_bounced(s["id"], result["error"], user["tenant_id"], s.get("prospect_id"), s.get("to_email"), user["id"])
            await asyncio.sleep(180)  # 3-minute throttle between sends

    background.add_task(_runner_all)
    return {"queued": queued}


# ─── Email Test Send (before real outreach) ───
class TestSendReq(BaseModel):
    to_email: EmailStr
    subject: str
    body_html: str
    template_id: Optional[str] = None
    sub_company_id: Optional[str] = None


@api.post("/email/send-test")
async def send_test_email(payload: TestSendReq, user: dict = Depends(get_current_user)):
    """Send a one-off test email to the user's address (or any chosen address) to verify
    SMTP setting, template look, attachment, and anti-spam headers BEFORE doing real outreach.
    Does NOT count toward email_sends / quota / activity log."""
    smtp_src = await _resolve_smtp(user["tenant_id"], user, payload.sub_company_id)
    if not smtp_src:
        raise HTTPException(400, "SMTP belum di-set. Atur dulu di Settings → Companies / Users.")

    body_type, atts = await _load_template_extras(user["tenant_id"], payload.template_id)
    # Inject a small "[TEST]" prefix to subject so user knows
    subject = payload.subject if payload.subject.upper().startswith("[TEST]") else f"[TEST] {payload.subject}"
    # Replace template variables with sample values for the test preview
    sample = {"name": user.get("name", "Test User"), "company": "Sample Co.", "email": user["email"], "industry": "SaaS", "website": "example.com", "city": "Jakarta", "country": "ID"}
    body = payload.body_html
    for k, v in sample.items():
        body = body.replace("{{" + k + "}}", str(v))
        subject = subject.replace("{{" + k + "}}", str(v))

    from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
    from_name = smtp_src.get("smtp_from_name")

    final_body, inline_imgs = await _extract_inline_images_for_send(body, user["tenant_id"])
    result = await asyncio.to_thread(
        send_smtp_email,
        smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
        smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
        bool(smtp_src.get("smtp_use_tls", True)),
        from_email, from_name, payload.to_email, subject, final_body,
        body_type, atts,
        inline_images=inline_imgs,
        list_unsubscribe_url=None,
        reply_to=from_email,
    )
    if not result["ok"]:
        raise HTTPException(400, f"Test send gagal: {result['error']}")
    return {"ok": True, "to": payload.to_email, "subject": subject}


class ProbeEmailReq(BaseModel):
    email: str
    domain: Optional[str] = None  # optional, derived from email if missing


@api.post("/email-verifier/probe")
async def probe_single_email(payload: ProbeEmailReq, user: dict = Depends(get_current_user)):
    """Per-email aggressive re-check — runs the alias verifier on JUST this email
    with extra rigor (multiple polls, fresh cache). Returns the latest engine result.
    Use case: user clicks 🧪 Test button next to an UNVERIFIED alias to re-attempt
    deliverability proof on a catch-all domain."""
    from alias_verifier import verify_email
    email = (payload.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(400, "Email tidak valid")
    # Re-run with fresh catch-all cache for this single email
    res = await verify_email(
        email,
        public_on_website=False,
        alias_match=True,
        catch_all_cache={},
    )
    out = res.to_dict()
    # Map engine status to UI-friendly hint
    out["ui_status"] = {
        "VALID":        "verified",
        "LIKELY_VALID": "verified",
        "ACCEPT_ALL":   "unverified",   # alias-only — still can't prove per-user
        "INVALID":      "invalid",
        "UNKNOWN":      "unverified",
    }.get(res.status, "unverified")
    out["recommendation"] = (
        "Email aman dikirim" if res.status in ("VALID", "LIKELY_VALID")
        else "Server catch-all — kirim test mail dulu untuk pastikan" if res.status == "ACCEPT_ALL"
        else "JANGAN kirim — SMTP tolak / domain bermasalah" if res.status == "INVALID"
        else "Tidak ada respon SMTP — coba lagi nanti atau kirim test"
    )
    return out


# ─── Email Templates ───
async def _attach_template_attachments(rows: List[dict]) -> List[dict]:
    """Enrich template rows with attachment metadata (no file data)."""
    if not rows:
        return rows
    ids = [r["id"] for r in rows]
    atts = await db.template_attachments.find(
        {"template_id": {"$in": ids}},
        {"_id": 0, "data_b64": 0},
    ).to_list(2000)
    by_tpl = {}
    for a in atts:
        by_tpl.setdefault(a["template_id"], []).append(a)
    for r in rows:
        r["body_type"] = r.get("body_type") or "html"
        r["attachments"] = by_tpl.get(r["id"], [])
    return rows


@api.get("/templates")
async def list_templates(user: dict = Depends(get_current_user)):
    # Each user only sees templates they personally created.
    # Owner/Admin do NOT see other users' templates — each user has their own library.
    rows = await db.email_templates.find(
        {"tenant_id": user["tenant_id"], "created_by": user["id"]},
        {"_id": 0},
    ).sort("created_at", -1).to_list(500)
    return await _attach_template_attachments(rows)


@api.post("/templates")
async def create_template(payload: TemplateCreate, user: dict = Depends(get_current_user)):
    tid = str(uuid.uuid4())
    doc = {
        "id": tid, "tenant_id": user["tenant_id"],
        "name": payload.name, "subject": payload.subject, "body_html": payload.body_html,
        "body_type": payload.body_type,
        "created_by": user["id"], "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.email_templates.insert_one(doc)
    doc.pop("_id", None)
    doc["attachments"] = []
    return doc


@api.patch("/templates/{tid}")
async def update_template(tid: str, payload: TemplateUpdate, user: dict = Depends(get_current_user)):
    upd = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if upd:
        upd["updated_at"] = now_iso()
        res = await db.email_templates.update_one(
            {"id": tid, "tenant_id": user["tenant_id"], "created_by": user["id"]},
            {"$set": upd},
        )
        if not res.matched_count:
            raise HTTPException(404, "Template not found")
    row = await db.email_templates.find_one(
        {"id": tid, "tenant_id": user["tenant_id"], "created_by": user["id"]},
        {"_id": 0},
    )
    if row:
        await _attach_template_attachments([row])
    return row


@api.delete("/templates/{tid}")
async def delete_template(tid: str, user: dict = Depends(get_current_user)):
    res = await db.email_templates.delete_one(
        {"id": tid, "tenant_id": user["tenant_id"], "created_by": user["id"]}
    )
    if res.deleted_count:
        await db.template_attachments.delete_many({"template_id": tid, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


@api.post("/templates/{tid}/duplicate")
async def duplicate_template(tid: str, user: dict = Depends(get_current_user)):
    src = await db.email_templates.find_one(
        {"id": tid, "tenant_id": user["tenant_id"], "created_by": user["id"]}
    )
    if not src:
        raise HTTPException(404, "Template not found")
    new_id = str(uuid.uuid4())
    doc = {
        "id": new_id, "tenant_id": user["tenant_id"],
        "name": f"{src['name']} (copy)", "subject": src["subject"], "body_html": src["body_html"],
        "body_type": src.get("body_type") or "html",
        "created_by": user["id"], "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.email_templates.insert_one(doc)
    # Duplicate attachments too
    src_atts = await db.template_attachments.find({"template_id": tid, "tenant_id": user["tenant_id"]}).to_list(100)
    new_atts = []
    for a in src_atts:
        a.pop("_id", None)
        a["id"] = str(uuid.uuid4())
        a["template_id"] = new_id
        a["created_at"] = now_iso()
        new_atts.append(a)
    if new_atts:
        await db.template_attachments.insert_many(new_atts)
    doc.pop("_id", None)
    doc["attachments"] = [{k: v for k, v in a.items() if k not in ("data_b64", "_id")} for a in new_atts]
    return doc


# ─── Template Attachments ───
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024  # 8 MB per file
MAX_TOTAL_ATTACHMENTS_BYTES = 20 * 1024 * 1024  # 20 MB per template


from fastapi import UploadFile, File
import base64


@api.post("/templates/{tid}/attachments")
async def upload_template_attachment(
    tid: str,
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload an attachment for a template. Stored as base64 in MongoDB (≤8MB per file, ≤20MB total)."""
    tpl = await db.email_templates.find_one(
        {"id": tid, "tenant_id": user["tenant_id"], "created_by": user["id"]}
    )
    if not tpl:
        raise HTTPException(404, "Template not found")
    raw = await file.read()
    size = len(raw)
    if size == 0:
        raise HTTPException(400, "File kosong")
    if size > MAX_ATTACHMENT_BYTES:
        raise HTTPException(400, f"File terlalu besar (max {MAX_ATTACHMENT_BYTES // (1024*1024)} MB)")
    existing = await db.template_attachments.aggregate([
        {"$match": {"template_id": tid, "tenant_id": user["tenant_id"]}},
        {"$group": {"_id": None, "total": {"$sum": "$size"}}},
    ]).to_list(1)
    current_total = (existing[0]["total"] if existing else 0)
    if current_total + size > MAX_TOTAL_ATTACHMENTS_BYTES:
        raise HTTPException(400, f"Total ukuran attachment melebihi {MAX_TOTAL_ATTACHMENTS_BYTES // (1024*1024)} MB")
    att_id = str(uuid.uuid4())
    doc = {
        "id": att_id,
        "tenant_id": user["tenant_id"],
        "template_id": tid,
        "filename": file.filename or "attachment.bin",
        "content_type": file.content_type or "application/octet-stream",
        "size": size,
        "data_b64": base64.b64encode(raw).decode("ascii"),
        "created_at": now_iso(),
        "created_by": user["id"],
    }
    await db.template_attachments.insert_one(doc)
    meta = {k: v for k, v in doc.items() if k not in ("_id", "data_b64")}
    return meta


@api.delete("/templates/{tid}/attachments/{att_id}")
async def delete_template_attachment(tid: str, att_id: str, user: dict = Depends(get_current_user)):
    tpl = await db.email_templates.find_one(
        {"id": tid, "tenant_id": user["tenant_id"], "created_by": user["id"]}
    )
    if not tpl:
        raise HTTPException(404, "Template not found")
    res = await db.template_attachments.delete_one({"id": att_id, "template_id": tid, "tenant_id": user["tenant_id"]})
    if not res.deleted_count:
        raise HTTPException(404, "Attachment not found")
    return {"deleted": 1}


@api.get("/templates/{tid}/attachments/{att_id}/download")
async def download_template_attachment(tid: str, att_id: str, user: dict = Depends(get_current_user)):
    att = await db.template_attachments.find_one({"id": att_id, "template_id": tid, "tenant_id": user["tenant_id"]})
    if not att:
        raise HTTPException(404, "Attachment not found")
    raw = base64.b64decode(att["data_b64"])
    return FastAPIResponse(
        content=raw,
        media_type=att.get("content_type") or "application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{att["filename"]}"'},
    )


# ─── Inline Image Uploads (untuk gambar signature di body email) ──────────
# Quill editor mengupload gambar lewat endpoint ini → backend simpan base64 di
# MongoDB → return URL publik. Saat email dikirim, `<img src="...inline-images/{id}">`
# di body otomatis dikonversi ke CID inline-attachment supaya gambar muncul
# langsung di email client tanpa perlu download manual.

MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024  # 5MB upload cap (before resize)
MAX_INLINE_IMAGE_DIMENSION = 800           # downscale longest side to this many px
INLINE_IMAGE_JPEG_QUALITY = 85             # used for JPEG/WebP re-encode
ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}


def _optimize_inline_image(raw: bytes, ctype: str) -> tuple[bytes, str, str, dict]:
    """Resize & recompress an uploaded image to keep emails small.

    Rules:
    - GIF: keep as-is (preserve animation).
    - Anything else: open with Pillow, downscale if longest side > MAX_INLINE_IMAGE_DIMENSION,
      keep PNG when image has alpha (transparency — needed for logos/signatures),
      otherwise re-encode as JPEG quality 85 (typically 5-20× smaller than the original).
    - If optimization produces a LARGER blob than the input (rare, tiny images), fall back to original.

    Returns (new_bytes, new_content_type, ext, meta_dict).
    """
    from io import BytesIO
    from PIL import Image, ImageOps  # noqa: WPS433 — local import keeps startup fast

    original_size = len(raw)
    meta = {"original_size": original_size, "original_type": ctype}

    if ctype == "image/gif":
        # Don't touch GIFs — animation frames are hard to re-encode safely.
        return raw, ctype, "gif", {**meta, "skipped": "gif-animated-safe", "final_size": original_size}

    try:
        img = Image.open(BytesIO(raw))
        img = ImageOps.exif_transpose(img)  # respect EXIF orientation (phone photos)
        orig_w, orig_h = img.size
        # Resize if needed (longest side > MAX). LANCZOS = best quality downsampling.
        if max(orig_w, orig_h) > MAX_INLINE_IMAGE_DIMENSION:
            img.thumbnail((MAX_INLINE_IMAGE_DIMENSION, MAX_INLINE_IMAGE_DIMENSION), Image.LANCZOS)

        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        out = BytesIO()
        if has_alpha:
            # Transparency present (signature logos with cutout backgrounds) — keep PNG.
            if img.mode != "RGBA":
                img = img.convert("RGBA")
            img.save(out, format="PNG", optimize=True)
            new_ctype, ext = "image/png", "png"
        else:
            # No alpha → JPEG is much smaller. Convert to RGB to be safe.
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.save(out, format="JPEG", quality=INLINE_IMAGE_JPEG_QUALITY, optimize=True, progressive=True)
            new_ctype, ext = "image/jpeg", "jpg"

        new_bytes = out.getvalue()
        new_w, new_h = img.size
        # Safety: if no resize happened AND the new file is bigger, keep the original.
        # (Tiny already-well-compressed PNGs can grow under re-encoding.)
        was_resized = (orig_w, orig_h) != (new_w, new_h)
        if not was_resized and len(new_bytes) >= original_size:
            return raw, ctype, ctype.split("/", 1)[1].replace("jpeg", "jpg"), {
                **meta, "skipped": "would-grow", "final_size": original_size,
            }
        return new_bytes, new_ctype, ext, {
            **meta,
            "final_size": len(new_bytes),
            "original_dimensions": [orig_w, orig_h],
            "final_dimensions": [new_w, new_h],
            "reduction_pct": round(100 * (1 - len(new_bytes) / max(1, original_size)), 1),
        }
    except Exception as ex:  # noqa: BLE001 — Pillow can throw many things; fall back to original.
        logger.warning("Inline image optimize failed (%s) — keeping original: %s", ctype, ex)
        return raw, ctype, ctype.split("/", 1)[1].replace("jpeg", "jpg"), {
            **meta, "skipped": f"error:{type(ex).__name__}", "final_size": original_size,
        }


INLINE_IMAGE_URL_RE = re.compile(
    r'<img\b[^>]*\bsrc=["\'](?:https?://[^"\']*?)?/api/inline-images/([0-9a-f-]{8,})(?:\.[a-zA-Z]+)?["\'][^>]*>',
    re.IGNORECASE,
)


@api.post("/uploads/inline-image")
async def upload_inline_image(
    file: UploadFile = File(...),
    user: dict = Depends(get_current_user),
):
    """Upload gambar (≤5MB) untuk disisipkan ke body email. Return URL publik yang
    bisa langsung dipakai sebagai <img src>."""
    ctype = (file.content_type or "").lower()
    if ctype not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(400, f"Tipe file tidak didukung. Hanya: {', '.join(sorted(ALLOWED_IMAGE_TYPES))}")
    raw = await file.read()
    if len(raw) == 0:
        raise HTTPException(400, "File kosong")
    if len(raw) > MAX_INLINE_IMAGE_BYTES:
        raise HTTPException(400, f"Gambar terlalu besar (max {MAX_INLINE_IMAGE_BYTES // (1024*1024)} MB)")

    # Auto-resize & recompress (e.g. 4MB phone JPEG → ~150KB, dimensi max 800px)
    optimized, final_ctype, ext, optimize_meta = await asyncio.to_thread(
        _optimize_inline_image, raw, ctype
    )
    img_id = str(uuid.uuid4())
    doc = {
        "id": img_id,
        "tenant_id": user["tenant_id"],
        "user_id": user["id"],
        "filename": file.filename or f"image.{ext}",
        "content_type": final_ctype,
        "size": len(optimized),
        "data_b64": base64.b64encode(optimized).decode("ascii"),
        "optimize_meta": optimize_meta,
        "created_at": now_iso(),
    }
    await db.inline_images.insert_one(doc)
    base_url = os.environ.get("PUBLIC_BASE_URL") or ""
    url = f"{base_url}/api/inline-images/{img_id}.{ext}"
    return {
        "id": img_id,
        "url": url,
        "size": len(optimized),
        "content_type": final_ctype,
        "optimize": optimize_meta,
    }


@app.get("/api/inline-images/{img_id}")
@app.get("/api/inline-images/{img_id}.{ext}")
async def serve_inline_image(img_id: str, ext: str = ""):
    """Serve gambar inline secara publik (tanpa auth) — supaya editor preview
    dan email web client bisa load gambarnya langsung. URL berisi UUID yang sulit
    di-tebak sebagai akses control sederhana."""
    doc = await db.inline_images.find_one({"id": img_id})
    if not doc:
        raise HTTPException(404, "Image not found")
    raw = base64.b64decode(doc["data_b64"])
    return FastAPIResponse(
        content=raw,
        media_type=doc.get("content_type") or "image/png",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Disposition": f'inline; filename="{doc.get("filename", "image")}"',
        },
    )


async def _extract_inline_images_for_send(body_html: str, tenant_id: str) -> tuple[str, list[dict]]:
    """Scan body_html for <img src="...api/inline-images/{id}..."> and:
    1. Replace the src with `cid:img-{id}` (RFC2392 inline reference)
    2. Return list of [{cid, filename, content_type, data_b64}] for MIME attachment.
    Images not found in DB or from a different tenant are left as-is (will load
    via the public URL when recipient has internet)."""
    if not body_html:
        return body_html, []
    ids_in_body = INLINE_IMAGE_URL_RE.findall(body_html)
    if not ids_in_body:
        return body_html, []
    docs = await db.inline_images.find(
        {"id": {"$in": list(set(ids_in_body))}, "tenant_id": tenant_id}
    ).to_list(50)
    inline_list: list[dict] = []
    new_body = body_html
    for d in docs:
        cid = f"img-{d['id']}"
        inline_list.append({
            "cid": cid,
            "filename": d.get("filename", f"{d['id']}.png"),
            "content_type": d.get("content_type", "image/png"),
            "data_b64": d["data_b64"],
        })
        # Replace ANY src that references this image id (with or without ext, http or https or relative)
        pat = re.compile(
            r'src=["\'](?:https?://[^"\']*?)?/api/inline-images/' + re.escape(d["id"]) + r'(?:\.[a-zA-Z]+)?["\']',
            re.IGNORECASE,
        )
        new_body = pat.sub(f'src="cid:{cid}"', new_body)
    return new_body, inline_list


# ─── Email Activity ───
@api.get("/email-sends")
async def list_email_sends(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    prospect_id: Optional[str] = None,
    sender_user_id: Optional[str] = None,
):
    q = {"tenant_id": user["tenant_id"]}
    # RBAC scope: HANYA Owner (Super Admin) yang lihat SEMUA email di tenant.
    # Role lain (Admin, Manager, Staff, Sales) hanya boleh lihat email YANG MEREKA KIRIM SENDIRI.
    # Owner masih bisa filter "Show me emails by user X" via param sender_user_id.
    if user.get("role") != "Owner":
        q["sender_user_id"] = user["id"]
    elif sender_user_id:
        q["sender_user_id"] = sender_user_id
    if status: q["status"] = status
    if prospect_id: q["prospect_id"] = prospect_id
    if date_from or date_to:
        q["created_at"] = {}
        if date_from: q["created_at"]["$gte"] = date_from
        if date_to: q["created_at"]["$lte"] = date_to
    sends = await db.email_sends.find(q, {"_id": 0}).sort("created_at", -1).to_list(2000)
    # Enrich with prospect info
    pids = list({s["prospect_id"] for s in sends if s.get("prospect_id")})
    pmap = {p["id"]: p async for p in db.prospects.find({"id": {"$in": pids}}, {"_id": 0, "id": 1, "company_name": 1})}
    uids = list({s["sender_user_id"] for s in sends if s.get("sender_user_id")})
    umap = {u["id"]: u async for u in db.users.find({"id": {"$in": uids}}, {"_id": 0, "id": 1, "name": 1})}
    # Enrich with task (project) info — used by Email Activity untuk grouping per project day
    tids = list({s["task_id"] for s in sends if s.get("task_id")})
    tmap = {t["id"]: t async for t in db.outreach_tasks.find({"id": {"$in": tids}}, {"_id": 0, "id": 1, "name": 1, "date": 1, "status": 1})}
    for s in sends:
        s["prospect_name"] = pmap.get(s.get("prospect_id"), {}).get("company_name")
        s["sender_name"] = umap.get(s.get("sender_user_id"), {}).get("name")
        t = tmap.get(s.get("task_id")) if s.get("task_id") else None
        s["task_name"] = (t or {}).get("name")
        s["task_date"] = (t or {}).get("date")
        s["task_status"] = (t or {}).get("status")
    return sends


# ─── Tracking (also updates email_sends) ───
@api.get("/track/open/{send_id}")
async def track_open_v2(send_id: str):
    # Update both old (campaign_recipients) and new (email_sends) for backward compat
    res = await db.email_sends.update_one({"id": send_id}, {"$inc": {"opens": 1}, "$set": {"last_opened_at": now_iso(), "status": "opened"}})
    if res.modified_count:
        s = await db.email_sends.find_one({"id": send_id})
        if s and s.get("prospect_id"):
            await _log_activity(s["prospect_id"], s["tenant_id"], "email_opened", None, {"send_id": send_id})
    else:
        await db.campaign_recipients.update_one({"id": send_id}, {"$inc": {"opens": 1}, "$set": {"last_opened_at": now_iso()}})
    return FastAPIResponse(content=PIXEL_GIF, media_type="image/gif",
                           headers={"Cache-Control": "no-store, no-cache, must-revalidate"})


@api.get("/track/click/{send_id}")
async def track_click_v2(send_id: str, u: str = Query(...)):
    res = await db.email_sends.update_one({"id": send_id}, {"$inc": {"clicks": 1}, "$set": {"last_clicked_at": now_iso(), "status": "clicked"}})
    if res.modified_count:
        s = await db.email_sends.find_one({"id": send_id})
        if s and s.get("prospect_id"):
            await _log_activity(s["prospect_id"], s["tenant_id"], "email_clicked", None, {"send_id": send_id, "url": u})
    else:
        await db.campaign_recipients.update_one({"id": send_id}, {"$inc": {"clicks": 1}, "$set": {"last_clicked_at": now_iso()}})
    return RedirectResponse(url=u, status_code=302)


# ─── Daily target per user ───
async def _sync_user_open_task_targets(tenant_id: str, user_id: str, new_target: int) -> int:
    """Saat user mengubah daily_target, propagate ke semua task draft/ready milik user
    sehingga UI Prospects langsung sinkron (target lama tidak nyangkut).
    Task yang sudah submitted/scheduled/completed TIDAK diubah — history preserved."""
    res = await db.outreach_tasks.update_many(
        {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "status": {"$in": ["draft", "ready"]},
        },
        {"$set": {"target": new_target, "updated_at": now_iso()}},
    )
    return res.modified_count


@api.patch("/me/target")
async def set_my_daily_target(payload: DailyTargetUpdate, user: dict = Depends(get_current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {"daily_target": payload.daily_target, "updated_at": now_iso()}})
    synced = await _sync_user_open_task_targets(user["tenant_id"], user["id"], payload.daily_target)
    return {"daily_target": payload.daily_target, "tasks_synced": synced}


class LinkedInTargetUpdate(BaseModel):
    linkedin_daily_target: int = Field(ge=0, le=500)


@api.patch("/me/linkedin-target")
async def set_my_linkedin_target(payload: LinkedInTargetUpdate, user: dict = Depends(get_current_user)):
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"linkedin_daily_target": payload.linkedin_daily_target, "updated_at": now_iso()}},
    )
    return {"linkedin_daily_target": payload.linkedin_daily_target}


@api.patch("/team/{uid}/linkedin-target")
async def set_team_linkedin_target(uid: str, payload: LinkedInTargetUpdate, user: dict = Depends(get_current_user)):
    perms = await get_user_permissions(user)
    if user["role"] != "Owner" and "set_team_targets" not in perms:
        raise HTTPException(403, "Missing permission: set_team_targets")
    res = await db.users.update_one(
        {"id": uid, "tenant_id": user["tenant_id"]},
        {"$set": {"linkedin_daily_target": payload.linkedin_daily_target, "updated_at": now_iso()}},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "User not found")
    return {"linkedin_daily_target": payload.linkedin_daily_target}


@api.patch("/team/{uid}/target")
async def set_team_member_target(uid: str, payload: DailyTargetUpdate, user: dict = Depends(get_current_user)):
    perms = await get_user_permissions(user)
    if user["role"] != "Owner" and "set_team_targets" not in perms:
        raise HTTPException(403, "Missing permission: set_team_targets")
    res = await db.users.update_one({"id": uid, "tenant_id": user["tenant_id"]}, {"$set": {"daily_target": payload.daily_target, "updated_at": now_iso()}})
    if not res.matched_count:
        raise HTTPException(404, "User not found")
    synced = await _sync_user_open_task_targets(user["tenant_id"], uid, payload.daily_target)
    return {"daily_target": payload.daily_target, "tasks_synced": synced}


# ─── New CRM Dashboard ───
@api.get("/dashboard/daily")
async def dashboard_daily(user: dict = Depends(get_current_user)):
    tid = user["tenant_id"]
    uid = user["id"]
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_iso = today.isoformat()
    tomorrow_iso = (today + timedelta(days=1)).isoformat()

    daily_target = (await db.users.find_one({"id": uid}, {"_id": 0, "daily_target": 1})).get("daily_target") or 0

    prospects_today = await db.prospects.count_documents({
        "tenant_id": tid, "assigned_user_id": uid,
        "created_at": {"$gte": today_iso, "$lt": tomorrow_iso},
    })
    emails_sent_today = await db.email_sends.count_documents({
        "tenant_id": tid, "sender_user_id": uid,
        "delivered": True, "sent_at": {"$gte": today_iso, "$lt": tomorrow_iso},
    })
    # Total emails sent today across team
    team_emails_today = await db.email_sends.count_documents({
        "tenant_id": tid, "delivered": True,
        "sent_at": {"$gte": today_iso, "$lt": tomorrow_iso},
    })
    # Replies received (today, scoped to my prospects)
    replies = await db.email_sends.count_documents({
        "tenant_id": tid, "sender_user_id": uid, "replied": True,
        "created_at": {"$gte": today_iso, "$lt": tomorrow_iso},
    })
    interested = await db.prospects.count_documents({"tenant_id": tid, "assigned_user_id": uid, "status": "Interested"})
    customers_won = await db.prospects.count_documents({"tenant_id": tid, "assigned_user_id": uid, "status": "Customer"})

    # Last 14 days trend (prospects added + emails sent by this user)
    trend = []
    for i in range(13, -1, -1):
        d = today - timedelta(days=i)
        nd = d + timedelta(days=1)
        added = await db.prospects.count_documents({
            "tenant_id": tid, "assigned_user_id": uid,
            "created_at": {"$gte": d.isoformat(), "$lt": nd.isoformat()},
        })
        sent = await db.email_sends.count_documents({
            "tenant_id": tid, "sender_user_id": uid, "delivered": True,
            "sent_at": {"$gte": d.isoformat(), "$lt": nd.isoformat()},
        })
        trend.append({"date": d.strftime("%Y-%m-%d"), "label": d.strftime("%b %d"), "added": added, "sent": sent})

    # Recent prospects assigned to me
    recent = await db.prospects.find({"tenant_id": tid, "assigned_user_id": uid}, {"_id": 0}).sort("created_at", -1).to_list(5)

    # ─── Team breakdown (RBAC-scoped) ──────────────────────────────────────
    # Owner / Admin / Manager → leaderboard for users they can see; Staff → omitted.
    team_breakdown: List[dict] = []
    role = user.get("role")
    if role in ("Owner", "Admin"):
        team_q = {"tenant_id": tid}
    elif role == "Manager":
        my_subs = user.get("sub_company_ids") or []
        team_q = {"tenant_id": tid, "sub_company_ids": {"$in": my_subs}} if my_subs else None
    else:
        team_q = None  # Staff: no leaderboard

    if team_q is not None:
        team_users = await db.users.find(team_q, {"_id": 0, "id": 1, "name": 1, "email": 1, "daily_target": 1}).to_list(500)
        team_uids = [u["id"] for u in team_users]
        if team_uids:
            # 1 aggregation per metric — avoids N+1 queries
            async def _agg_count(coll, match: dict, group_field: str) -> dict:
                pipe = [{"$match": match}, {"$group": {"_id": f"${group_field}", "n": {"$sum": 1}}}]
                return {d["_id"]: d["n"] async for d in coll.aggregate(pipe)}

            prosp_today = await _agg_count(
                db.prospects,
                {"tenant_id": tid, "assigned_user_id": {"$in": team_uids},
                 "created_at": {"$gte": today_iso, "$lt": tomorrow_iso}},
                "assigned_user_id",
            )
            prosp_total = await _agg_count(
                db.prospects,
                {"tenant_id": tid, "assigned_user_id": {"$in": team_uids}},
                "assigned_user_id",
            )
            customers = await _agg_count(
                db.prospects,
                {"tenant_id": tid, "assigned_user_id": {"$in": team_uids}, "status": "Customer"},
                "assigned_user_id",
            )
            interested_map = await _agg_count(
                db.prospects,
                {"tenant_id": tid, "assigned_user_id": {"$in": team_uids}, "status": "Interested"},
                "assigned_user_id",
            )
            sent_today_map = await _agg_count(
                db.email_sends,
                {"tenant_id": tid, "sender_user_id": {"$in": team_uids}, "delivered": True,
                 "sent_at": {"$gte": today_iso, "$lt": tomorrow_iso}},
                "sender_user_id",
            )
            sent_total_map = await _agg_count(
                db.email_sends,
                {"tenant_id": tid, "sender_user_id": {"$in": team_uids}, "delivered": True},
                "sender_user_id",
            )
            replied_map = await _agg_count(
                db.email_sends,
                {"tenant_id": tid, "sender_user_id": {"$in": team_uids}, "replied": True},
                "sender_user_id",
            )

            for u in team_users:
                u_id = u["id"]
                p_today = prosp_today.get(u_id, 0)
                tgt = int(u.get("daily_target") or 0)
                pct = round(100 * p_today / tgt, 0) if tgt > 0 else None
                team_breakdown.append({
                    "user_id": u_id,
                    "name": u.get("name") or u.get("email"),
                    "color": _color_for(u_id),
                    "daily_target": tgt,
                    "prospects_today": p_today,
                    "quota_pct": pct,                       # None when no target set
                    "prospects_total": prosp_total.get(u_id, 0),
                    "emails_sent_today": sent_today_map.get(u_id, 0),
                    "emails_sent_total": sent_total_map.get(u_id, 0),
                    "replies_total": replied_map.get(u_id, 0),
                    "interested_total": interested_map.get(u_id, 0),
                    "customers_total": customers.get(u_id, 0),
                    "is_me": u_id == uid,
                })
            # Sort: prospects_today desc, then total desc, then name asc
            team_breakdown.sort(key=lambda r: (-r["prospects_today"], -r["prospects_total"], r["name"].lower()))

    return {
        "daily_target": daily_target,
        "cards": {
            "prospects_today": prospects_today,
            "emails_sent_today": emails_sent_today,
            "team_emails_today": team_emails_today,
            "replies_today": replies,
            "interested_count": interested,
            "customers_won": customers_won,
        },
        "trend": trend,
        "recent_prospects": recent,
        "team_breakdown": team_breakdown,
    }


@api.get("/")
async def root():
    return {"name": "Lead Hunter CRM API", "ok": True, "version": "2.0-crm"}


# ─── Version / Deploy diagnostic endpoint ──────────────────────────────────
# Sekali curl, langsung tahu backend di VPS pakai git commit mana + apakah
# endpoint terbaru (PATCH /whatsapp/accounts, assign, dll) ter-register.
@api.get("/version")
async def version_endpoint(request: Request):
    """Return git sha, build time, and a sample of registered routes.
    Useful to verify which code is actually running after deploy.
    """
    import subprocess
    from datetime import datetime, timezone as _tz
    # Try to get git sha — backend file path → find .git
    git_sha = None
    git_branch = None
    git_msg = None
    git_dirty = False
    try:
        backend_dir = os.path.dirname(os.path.abspath(__file__))
        repo_dir = os.path.dirname(backend_dir)  # parent (project root usually has .git)
        sha = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=2,
        )
        if sha.returncode == 0:
            git_sha = sha.stdout.strip()
        br = subprocess.run(
            ["git", "-C", repo_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=2,
        )
        if br.returncode == 0:
            git_branch = br.stdout.strip()
        msg = subprocess.run(
            ["git", "-C", repo_dir, "log", "-1", "--pretty=%s"],
            capture_output=True, text=True, timeout=2,
        )
        if msg.returncode == 0:
            git_msg = msg.stdout.strip()
        dirty = subprocess.run(
            ["git", "-C", repo_dir, "status", "--porcelain"],
            capture_output=True, text=True, timeout=2,
        )
        if dirty.returncode == 0 and dirty.stdout.strip():
            git_dirty = True
    except Exception:
        pass

    # File mtime — confirms when the deployed file was actually written
    try:
        mtime = datetime.fromtimestamp(
            os.path.getmtime(os.path.abspath(__file__)),
            tz=_tz.utc,
        ).isoformat()
    except Exception:
        mtime = None

    # Sample of key new endpoints — if list is empty for one of these, deploy is incomplete
    key_endpoints = [
        "PATCH /whatsapp/accounts/{sid}",
        "POST /whatsapp/accounts/{sid}/chats/{jid}/assign",
        "DELETE /whatsapp/accounts/{sid}/chats/{jid}/assign",
    ]
    registered_routes = []
    try:
        for r in request.app.routes:
            path = getattr(r, "path", None)
            methods = getattr(r, "methods", None)
            if path and methods and "/whatsapp/accounts" in path:
                for m in methods:
                    if m in ("GET", "POST", "PATCH", "DELETE", "PUT"):
                        registered_routes.append(f"{m} {path}")
    except Exception:
        pass

    has_patch_account = any("PATCH" in r and "/whatsapp/accounts/{sid}" in r and not r.endswith("/chats") for r in registered_routes)
    has_assign = any("/assign" in r and "POST" in r for r in registered_routes)

    return {
        "ok": True,
        "service": "lead-hunter-backend",
        "git_sha": git_sha,
        "git_branch": git_branch,
        "git_last_commit": git_msg,
        "git_dirty": git_dirty,
        "server_file_mtime": mtime,
        "server_time": datetime.now(_tz.utc).isoformat(),
        "key_endpoints_required": key_endpoints,
        "key_endpoints_status": {
            "patch_whatsapp_account": "ok" if has_patch_account else "MISSING",
            "assign_chat": "ok" if has_assign else "MISSING",
        },
        "whatsapp_routes_registered": sorted(set(registered_routes)),
    }






@api.get("/system/clock")
async def system_clock():
    """Return server's current time in both UTC and the configured app timezone (Asia/Makassar).
    Use this to verify scheduled emails will fire at the right wall-clock time relative to user's
    own browser timezone — both display strings should match expectations.
    """
    from datetime import datetime as _dt, timezone as _tz, timedelta as _td
    tz_name = os.environ.get("APP_TIMEZONE", "Asia/Makassar")
    offset_str = os.environ.get("APP_TIMEZONE_OFFSET", "+08:00")
    sign = 1 if offset_str.startswith("+") else -1
    hh, mm = offset_str.lstrip("+-").split(":")
    offset = _td(hours=sign * int(hh), minutes=sign * int(mm))
    app_tz = _tz(offset, name=tz_name)
    utc_now = _dt.now(_tz.utc)
    app_now = utc_now.astimezone(app_tz)
    return {
        "utc_iso": utc_now.isoformat(),
        "app_iso": app_now.isoformat(),
        "app_timezone": tz_name,
        "app_offset": offset_str,
        "scheduler": {
            "running": _scheduler_state.get("running", False),
            "poll_interval_seconds": 60,
            "throttle_per_send_seconds": 180,
        },
    }


# ────────────────────────────────────────────────────────────
# WhatsApp (Baileys sidecar proxy)
# ────────────────────────────────────────────────────────────
import httpx

WA_SERVICE_URL = os.environ.get("WA_SERVICE_URL", "http://localhost:3002")
WA_SERVICE_SECRET = os.environ.get("WA_SERVICE_SECRET", "")
WA_MAX_ACCOUNTS_PER_USER = 3


def _wa_headers():
    return {"X-WA-Secret": WA_SERVICE_SECRET, "Content-Type": "application/json"}


async def _wa_call(method: str, path: str, *, json: Optional[dict] = None, params: Optional[dict] = None):
    """Proxy helper to wa-service sidecar with timeout + error pass-through."""
    url = f"{WA_SERVICE_URL}{path}"
    async with httpx.AsyncClient(timeout=15.0) as cx:
        try:
            r = await cx.request(method, url, json=json, params=params, headers=_wa_headers())
        except httpx.HTTPError as e:
            raise HTTPException(503, f"WA service tidak tersedia: {e}")
    if r.status_code >= 400:
        try:
            detail = r.json().get("error") or r.text
        except Exception:
            detail = r.text
        raise HTTPException(r.status_code, f"WA service: {detail}")
    if r.headers.get("content-type", "").startswith("application/json"):
        return r.json()
    return {"raw": r.text}


def _wa_scope_query(user: dict) -> dict:
    """Owner sees ALL accounts in tenant (sales monitoring). Others: own only."""
    q = {"tenant_id": user["tenant_id"]}
    if user.get("role") != "Owner":
        q["user_id"] = user["id"]
    return q


async def _wa_user_has_assignment(session_id: str, user_id: str, tenant_id: str) -> bool:
    """Check if user has any chat assigned to them on this session (team inbox access)."""
    cnt = await db.wa_chat_assignments.count_documents({
        "session_id": session_id,
        "assigned_user_id": user_id,
        "tenant_id": tenant_id,
    })
    return cnt > 0


async def _wa_check_account_access(session_id: str, user: dict) -> dict:
    """Return account doc if user has access, else 404/403.

    Access rules:
      - Owner: any account in tenant
      - Account owner: own account
      - Other users: only if they have at least one chat assigned from this connection (team inbox)
    """
    # First check ownership / Owner scope
    acc = await db.wa_accounts.find_one({"session_id": session_id, **_wa_scope_query(user)})
    if acc:
        return acc
    # Then check team-inbox access (any assignment grants visibility of the account)
    exists = await db.wa_accounts.find_one({"session_id": session_id, "tenant_id": user["tenant_id"]}, {"_id": 0})
    if exists and await _wa_user_has_assignment(session_id, user["id"], user["tenant_id"]):
        return exists
    if exists:
        raise HTTPException(403, "Anda tidak punya akses ke akun WA ini")
    raise HTTPException(404, "Akun WA tidak ditemukan")


async def _wa_user_can_send_on_chat(session_id: str, jid: str, user: dict, acc: dict) -> bool:
    """User can send on a chat if:
       - They own the account, OR
       - They have this specific JID assigned to them (team inbox).
    """
    if acc["user_id"] == user["id"]:
        return True
    a = await db.wa_chat_assignments.find_one({
        "session_id": session_id,
        "jid": jid,
        "assigned_user_id": user["id"],
        "tenant_id": user["tenant_id"],
    })
    return a is not None


class WAAccountCreate(BaseModel):
    label: Optional[str] = None


@api.get("/whatsapp/health")
async def wa_health():
    """Diagnose WA service connectivity. Public — no auth needed so user can debug from anywhere."""
    out = {
        "backend": "ok",
        "wa_service_url": WA_SERVICE_URL,
        "wa_service": "unknown",
        "wa_service_detail": None,
    }
    if not WA_SERVICE_URL:
        out["wa_service"] = "not_configured"
        out["wa_service_detail"] = "WA_SERVICE_URL env var belum di-set di backend/.env"
        return out
    try:
        async with httpx.AsyncClient(timeout=5.0) as cx:
            r = await cx.get(f"{WA_SERVICE_URL}/health")
        if r.status_code == 200 and r.json().get("ok"):
            out["wa_service"] = "ok"
        else:
            out["wa_service"] = "error"
            out["wa_service_detail"] = f"Status {r.status_code}: {r.text[:120]}"
    except Exception as e:
        out["wa_service"] = "unreachable"
        out["wa_service_detail"] = f"{type(e).__name__}: {str(e)[:160]}"
    return out


@api.get("/whatsapp/accounts")
async def wa_list_accounts(user: dict = Depends(get_current_user)):
    """List WA accounts.
       - Owner: all accounts in tenant (sales monitoring).
       - Others: own accounts + accounts where they have at least 1 chat assigned (team inbox).
       Each row gets `is_assigned_inbox: true` if it's not owned by this user (team inbox view).
    """
    own_q = _wa_scope_query(user)
    own_rows = await db.wa_accounts.find(own_q, {"_id": 0}).sort("created_at", -1).to_list(50)
    own_ids = {r["session_id"] for r in own_rows}

    # Find sessions where this user has assignments (team inbox)
    assigned_sessions = []
    if user.get("role") != "Owner":
        sids = await db.wa_chat_assignments.distinct(
            "session_id",
            {"tenant_id": user["tenant_id"], "assigned_user_id": user["id"]},
        )
        sids = [s for s in sids if s not in own_ids]
        if sids:
            assigned_sessions = await db.wa_accounts.find(
                {"session_id": {"$in": sids}, "tenant_id": user["tenant_id"]},
                {"_id": 0},
            ).to_list(50)

    # Enrich with live status from sidecar (best-effort) + mark assigned inbox
    out = []
    for r in own_rows:
        live = None
        try:
            live = await _wa_call("GET", f"/sessions/{r['session_id']}")
        except HTTPException:
            live = None
        out.append({
            **r,
            "live_status": (live or {}).get("status"),
            "qr": (live or {}).get("qr"),
            "is_assigned_inbox": False,
            "is_own": r["user_id"] == user["id"],
        })
    for r in assigned_sessions:
        live = None
        try:
            live = await _wa_call("GET", f"/sessions/{r['session_id']}")
        except HTTPException:
            live = None
        # Count assignments for this user on this session
        n_assigned = await db.wa_chat_assignments.count_documents({
            "session_id": r["session_id"], "assigned_user_id": user["id"], "tenant_id": user["tenant_id"],
        })
        out.append({
            **r,
            "live_status": (live or {}).get("status"),
            "qr": (live or {}).get("qr"),
            "is_assigned_inbox": True,
            "is_own": False,
            "assigned_chat_count": n_assigned,
        })
    return out


class WAAccountUpdate(BaseModel):
    label: Optional[str] = None
    default_assigned_user_id: Optional[str] = None  # null = unset (no auto-assign)


@api.patch("/whatsapp/accounts/{sid}")
async def wa_update_account(sid: str, payload: WAAccountUpdate, user: dict = Depends(get_current_user)):
    """Update connection settings (gear icon): label + default assignee for incoming chats.
       Only owner of the account or tenant Owner can edit."""
    acc = await db.wa_accounts.find_one({"session_id": sid, "tenant_id": user["tenant_id"]})
    if not acc:
        raise HTTPException(404, "Akun WA tidak ditemukan")
    if acc["user_id"] != user["id"] and user.get("role") != "Owner":
        raise HTTPException(403, "Hanya pemilik akun atau Owner yang bisa edit koneksi")

    update_doc = {}
    # Allow partial updates: only set fields explicitly present in payload
    payload_data = payload.model_dump(exclude_unset=True)
    if "label" in payload_data:
        update_doc["label"] = (payload.label or "").strip() or None
    if "default_assigned_user_id" in payload_data:
        target_id = payload.default_assigned_user_id
        if target_id:
            target = await db.users.find_one(
                {"id": target_id, "tenant_id": user["tenant_id"]},
                {"_id": 0, "id": 1, "name": 1, "email": 1},
            )
            if not target:
                raise HTTPException(404, "User default tidak ditemukan di tenant")
            update_doc["default_assigned_user_id"] = target_id
            update_doc["default_assigned_user_name"] = target.get("name") or target.get("email")
        else:
            update_doc["default_assigned_user_id"] = None
            update_doc["default_assigned_user_name"] = None

    if update_doc:
        await db.wa_accounts.update_one({"session_id": sid}, {"$set": update_doc})

    # Optionally: backfill assignments for existing un-assigned chats when default changes
    new_default = update_doc.get("default_assigned_user_id")
    if "default_assigned_user_id" in update_doc and new_default:
        # Find chats without an assignment and bulk-insert
        existing_jids = await db.wa_chat_assignments.distinct(
            "jid", {"session_id": sid, "tenant_id": user["tenant_id"]}
        )
        chats_without = await db.wa_chats.find(
            {"session_id": sid, "jid": {"$nin": existing_jids}},
            {"_id": 0, "jid": 1},
        ).to_list(5000)
        if chats_without:
            ts = now_iso()
            await db.wa_chat_assignments.insert_many([
                {
                    "session_id": sid,
                    "jid": c["jid"],
                    "tenant_id": user["tenant_id"],
                    "assigned_user_id": new_default,
                    "assigned_by": user["id"],
                    "assigned_at": ts,
                    "auto_assigned": True,
                }
                for c in chats_without
            ])

    fresh = await db.wa_accounts.find_one({"session_id": sid}, {"_id": 0})
    return {"ok": True, **fresh}


@api.post("/whatsapp/accounts")
async def wa_create_account(payload: WAAccountCreate, user: dict = Depends(get_current_user)):
    """Create a new WA session for current user.
    Owner role: unlimited accounts.
    Other roles: limited by WA_MAX_ACCOUNTS_PER_USER (default 3).
    """
    if user.get("role") != "Owner":
        count = await db.wa_accounts.count_documents({"tenant_id": user["tenant_id"], "user_id": user["id"]})
        if count >= WA_MAX_ACCOUNTS_PER_USER:
            raise HTTPException(400, f"Maks {WA_MAX_ACCOUNTS_PER_USER} akun WA per user (Owner unlimited)")
    session_id = uuid.uuid4().hex
    res = await _wa_call(
        "POST", "/sessions",
        json={"session_id": session_id, "tenant_id": user["tenant_id"], "user_id": user["id"], "label": payload.label},
    )
    # Mirror to local DB (sidecar already upserted, but ensure tenant/user fields)
    await db.wa_accounts.update_one(
        {"session_id": session_id},
        {"$set": {
            "session_id": session_id,
            "tenant_id": user["tenant_id"],
            "user_id": user["id"],
            "label": payload.label,
        }},
        upsert=True,
    )
    return {"session_id": session_id, **res}


@api.get("/whatsapp/accounts/{sid}/status")
async def wa_account_status(sid: str, user: dict = Depends(get_current_user)):
    """Get live status (qr / connecting / connected / logged_out)."""
    await _wa_check_account_access(sid, user)
    return await _wa_call("GET", f"/sessions/{sid}")


@api.delete("/whatsapp/accounts/{sid}")
async def wa_delete_account(sid: str, user: dict = Depends(get_current_user)):
    """Logout + delete WA account. Non-Owner only deletes own; Owner can delete any in tenant."""
    acc = await _wa_check_account_access(sid, user)
    # Only account owner or Owner can delete (not team-inbox users)
    if acc["user_id"] != user["id"] and user.get("role") != "Owner":
        raise HTTPException(403, "Hanya Owner atau pemilik akun yang bisa menghapus")
    tenant_id = user["tenant_id"]
    # Try to ask wa-service to stop the session (best-effort — don't fail the request
    # if the sidecar is unreachable or already gone)
    try:
        await _wa_call("DELETE", f"/sessions/{sid}")
    except HTTPException as e:
        # Log but continue; we'll still purge from local DB so the UI reflects deletion
        print(f"[wa_delete_account] sidecar DELETE failed for {sid}: {e.detail} — continuing with DB purge")
    # DEFENSIVE: purge all traces at backend level regardless of wa-service result.
    # This prevents the "deleted item reappears" bug where a stale wa_accounts row
    # gets re-listed because the sidecar didn't actually clean it up.
    await db.wa_chat_assignments.delete_many({"session_id": sid, "tenant_id": tenant_id})
    await db.wa_accounts.delete_many({"session_id": sid})
    await db.wa_chats.delete_many({"session_id": sid})
    await db.wa_messages.delete_many({"session_id": sid})
    return {"ok": True, "session_id": sid}


@api.get("/whatsapp/accounts/{sid}/chats")
async def wa_list_chats(sid: str, limit: int = 100, since_ts: Optional[str] = None, user: dict = Depends(get_current_user)):
    acc = await _wa_check_account_access(sid, user)
    params = {"limit": limit}
    if since_ts:
        params["since_ts"] = since_ts
    chats = await _wa_call("GET", f"/sessions/{sid}/chats", params=params)

    # Auto-assign: if connection has a default_assigned_user_id, ensure every chat has an assignment.
    default_uid = acc.get("default_assigned_user_id")
    if default_uid and chats:
        all_jids = [c["jid"] for c in chats]
        existing = set(
            await db.wa_chat_assignments.distinct(
                "jid",
                {"session_id": sid, "tenant_id": user["tenant_id"], "jid": {"$in": all_jids}},
            )
        )
        missing = [j for j in all_jids if j not in existing]
        if missing:
            ts = now_iso()
            await db.wa_chat_assignments.insert_many([
                {
                    "session_id": sid,
                    "jid": j,
                    "tenant_id": user["tenant_id"],
                    "assigned_user_id": default_uid,
                    "assigned_by": acc.get("user_id"),
                    "assigned_at": ts,
                    "auto_assigned": True,
                }
                for j in missing
            ])

    # Build assignment map (jid -> {assigned_user_id, assigned_user_name})
    assignments = await db.wa_chat_assignments.find(
        {"session_id": sid, "tenant_id": user["tenant_id"]}
    ).to_list(2000)
    assigned_user_ids = list({a["assigned_user_id"] for a in assignments})
    user_name_map = {}
    if assigned_user_ids:
        users = await db.users.find(
            {"id": {"$in": assigned_user_ids}, "tenant_id": user["tenant_id"]},
            {"_id": 0, "id": 1, "name": 1, "email": 1},
        ).to_list(200)
        user_name_map = {u["id"]: u.get("name") or u.get("email") for u in users}
    a_by_jid = {a["jid"]: a for a in assignments}

    is_owner_or_admin = user.get("role") in ("Owner", "Admin")
    is_account_owner = acc["user_id"] == user["id"]

    enriched = []
    for c in chats or []:
        a = a_by_jid.get(c["jid"])
        c["assignment"] = (
            {
                "assigned_user_id": a["assigned_user_id"],
                "assigned_user_name": user_name_map.get(a["assigned_user_id"]),
                "assigned_at": a.get("assigned_at"),
                "auto_assigned": a.get("auto_assigned", False),
                "is_mine": a["assigned_user_id"] == user["id"],
            }
            if a
            else None
        )
        enriched.append(c)

    # Filter for users coming in via team inbox (not account owner, not Owner/Admin):
    # show only chats assigned to them.
    if not is_account_owner and not is_owner_or_admin:
        enriched = [c for c in enriched if c.get("assignment") and c["assignment"]["is_mine"]]

    return enriched


class WAAssignChat(BaseModel):
    user_id: str  # target user_id to assign chat to


@api.post("/whatsapp/accounts/{sid}/chats/{jid}/assign")
async def wa_assign_chat(sid: str, jid: str, payload: WAAssignChat, user: dict = Depends(get_current_user)):
    """Assign a chat (jid) on a connection to a specific tenant user (team inbox).
       Allowed: Owner or Admin or account owner.
    """
    acc = await db.wa_accounts.find_one({"session_id": sid, "tenant_id": user["tenant_id"]})
    if not acc:
        raise HTTPException(404, "Akun WA tidak ditemukan")
    is_admin = user.get("role") in ("Owner", "Admin")
    if not is_admin and acc["user_id"] != user["id"]:
        raise HTTPException(403, "Hanya Owner/Admin atau pemilik akun yang bisa assign chat")
    target = await db.users.find_one({"id": payload.user_id, "tenant_id": user["tenant_id"]}, {"_id": 0, "id": 1, "name": 1, "email": 1})
    if not target:
        raise HTTPException(404, "User target tidak ditemukan")
    doc = {
        "session_id": sid,
        "jid": jid,
        "tenant_id": user["tenant_id"],
        "assigned_user_id": payload.user_id,
        "assigned_by": user["id"],
        "assigned_at": now_iso(),
    }
    await db.wa_chat_assignments.update_one(
        {"session_id": sid, "jid": jid, "tenant_id": user["tenant_id"]},
        {"$set": doc},
        upsert=True,
    )
    return {"ok": True, **doc, "assigned_user_name": target.get("name") or target.get("email")}


@api.delete("/whatsapp/accounts/{sid}/chats/{jid}/assign")
async def wa_unassign_chat(sid: str, jid: str, user: dict = Depends(get_current_user)):
    """Remove an assignment. Allowed: Owner/Admin or account owner."""
    acc = await db.wa_accounts.find_one({"session_id": sid, "tenant_id": user["tenant_id"]})
    if not acc:
        raise HTTPException(404, "Akun WA tidak ditemukan")
    is_admin = user.get("role") in ("Owner", "Admin")
    if not is_admin and acc["user_id"] != user["id"]:
        raise HTTPException(403, "Hanya Owner/Admin atau pemilik akun yang bisa unassign")
    await db.wa_chat_assignments.delete_one(
        {"session_id": sid, "jid": jid, "tenant_id": user["tenant_id"]}
    )
    return {"ok": True}


@api.get("/whatsapp/accounts/{sid}/chats/{jid}/messages")
async def wa_list_messages(sid: str, jid: str, limit: int = 50, since_ts: Optional[str] = None, user: dict = Depends(get_current_user)):
    await _wa_check_account_access(sid, user)
    params = {"limit": limit}
    if since_ts:
        params["since_ts"] = since_ts
    return await _wa_call("GET", f"/sessions/{sid}/chats/{jid}/messages", params=params)


class WASendText(BaseModel):
    text: str


@api.post("/whatsapp/accounts/{sid}/chats/{jid}/messages")
async def wa_send_text(sid: str, jid: str, payload: WASendText, user: dict = Depends(get_current_user)):
    """Send text. Account owner OR assigned user can send.
    Owner/Admin without assignment is view-only on others' chats."""
    acc = await _wa_check_account_access(sid, user)
    if not await _wa_user_can_send_on_chat(sid, jid, user, acc):
        raise HTTPException(403, "Anda tidak punya akses untuk mengirim pesan di chat ini")
    return await _wa_call("POST", f"/sessions/{sid}/chats/{jid}/messages", json={"text": payload.text})


class WASendMedia(BaseModel):
    kind: Literal["image", "video", "document", "audio"]
    base64: str
    mimetype: Optional[str] = None
    file_name: Optional[str] = None
    caption: Optional[str] = None


@api.post("/whatsapp/accounts/{sid}/chats/{jid}/media")
async def wa_send_media(sid: str, jid: str, payload: WASendMedia, user: dict = Depends(get_current_user)):
    """Send image/video/document/audio. Max 50MB. Account owner OR assigned user can send."""
    acc = await _wa_check_account_access(sid, user)
    if not await _wa_user_can_send_on_chat(sid, jid, user, acc):
        raise HTTPException(403, "Anda tidak punya akses untuk mengirim media di chat ini")
    # Sanity check base64 length (~ 1.37x raw size). Allow up to 100MB raw (~137MB base64).
    if len(payload.base64) > 140 * 1024 * 1024:
        raise HTTPException(400, "File terlalu besar (max ~100MB)")
    return await _wa_call(
        "POST", f"/sessions/{sid}/chats/{jid}/media",
        json={
            "kind": payload.kind,
            "base64": payload.base64,
            "mimetype": payload.mimetype,
            "fileName": payload.file_name,
            "caption": payload.caption,
        },
    )


@api.get("/whatsapp/accounts/{sid}/messages/{msgid}/media")
async def wa_get_media(sid: str, msgid: str, request: Request, download: int = 0, token: Optional[str] = None):
    """Stream media bytes for a message (image/video/document/audio).
    Auth: either standard Authorization header OR ?token=<jwt> query (so <img>, <video>,
    <audio> tags can fetch media — they can't set headers).
    """
    # Manually resolve user — supports header OR query token
    auth_header = request.headers.get("Authorization", "")
    jwt_token = None
    if auth_header.startswith("Bearer "):
        jwt_token = auth_header[7:]
    elif token:
        jwt_token = token
    if not jwt_token:
        raise HTTPException(401, "Missing token")
    try:
        payload = jwt.decode(jwt_token, JWT_SECRET, algorithms=[JWT_ALG])
        user = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0})
        if not user:
            raise HTTPException(401, "User not found")
    except Exception:
        raise HTTPException(401, "Invalid token")

    await _wa_check_account_access(sid, user)
    import httpx
    headers = {"X-WA-Secret": os.environ.get("WA_SERVICE_SECRET", "dev-secret")}
    url = f"{WA_SERVICE_URL}/sessions/{sid}/messages/{msgid}/media"
    params = {"download": "1"} if download else {}
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        resp = await client.get(url, headers=headers, params=params)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("error", "Media tidak tersedia")
        except Exception:
            detail = resp.text or "Media tidak tersedia"
        raise HTTPException(resp.status_code, detail)
    return FastAPIResponse(
        content=resp.content,
        media_type=resp.headers.get("content-type", "application/octet-stream"),
        headers={
            "Content-Disposition": resp.headers.get("content-disposition", "inline"),
            "Cache-Control": "private, max-age=86400",
        },
    )


# ─── WhatsApp CRM Pipeline ─────────────────────────────────────────────────
# Statuses: cold, hot, warm, hold, deal, lost
# Follow-up = DYNAMIC queue (not a status) — computed from time rules.
# Rules (from user spec):
#   Cold: 3 days no reply → in follow-up list. After follow-up sent, hides for 3 days.
#         Repeated no-reply after N follow-ups → auto Lost.
#   Hot : 2 days no reply → in follow-up list. After follow-up sent, hides for 3 days.
#         2 consecutive follow-ups without reply → downgrade to Cold.
#   Lost/Deal: no follow-up reminders.
#   Any incoming reply from customer while Lost/Cold → auto-recycle to Hot.

PIPELINE_STATUSES = {"cold", "hot", "warm", "hold", "deal", "lost"}
FOLLOWUP_DAYS = {"cold": 3, "hot": 2, "warm": 3, "hold": 5}
FOLLOWUP_INTERVAL_AFTER = 3  # days between follow-ups after first one sent
MAX_STAGES_BEFORE_DOWNGRADE = 2  # after this many outgoing follow-ups with no reply → status change


def _compute_followup_due(chat: dict, now: datetime) -> bool:
    status = chat.get("pipeline_status") or "cold"
    if status in ("deal", "lost", "hold"):
        return False
    # Time reference = last incoming from customer (fallback to last_message_ts)
    ref = chat.get("last_incoming_ts") or chat.get("last_message_ts")
    if not ref:
        return True  # never contacted
    if isinstance(ref, str):
        try: ref_dt = datetime.fromisoformat(ref.replace("Z", "+00:00"))
        except Exception: return False
    else:
        ref_dt = ref
    if ref_dt.tzinfo is None:
        ref_dt = ref_dt.replace(tzinfo=timezone.utc)
    stage = chat.get("pipeline_stage") or 0
    # Interval: first follow-up per status rule; subsequent = 3 days
    days = FOLLOWUP_DAYS.get(status, 3) if stage == 0 else FOLLOWUP_INTERVAL_AFTER
    # If our last outgoing (follow-up sent) is newer than incoming, use that + interval instead
    last_out = chat.get("last_outgoing_ts")
    if last_out:
        if isinstance(last_out, str):
            try: last_out_dt = datetime.fromisoformat(last_out.replace("Z", "+00:00"))
            except Exception: last_out_dt = ref_dt
        else:
            last_out_dt = last_out
        if last_out_dt.tzinfo is None:
            last_out_dt = last_out_dt.replace(tzinfo=timezone.utc)
        if last_out_dt > ref_dt:
            ref_dt = last_out_dt
    return (now - ref_dt) >= timedelta(days=days)


class PipelineStatusUpdate(BaseModel):
    status: str  # cold|hot|warm|hold|deal|lost


@api.patch("/whatsapp/accounts/{sid}/chats/{jid}/pipeline")
async def wa_set_pipeline_status(sid: str, jid: str, payload: PipelineStatusUpdate, user: dict = Depends(get_current_user)):
    """Change pipeline status (Hot/Cold/Warm/Hold/Deal/Lost) manually."""
    acc = await _wa_check_account_access(sid, user)
    status = payload.status.lower()
    if status not in PIPELINE_STATUSES:
        raise HTTPException(400, f"Invalid status. Must be one of {sorted(PIPELINE_STATUSES)}")
    # Only account owner or assignee can change status (or Owner/Admin)
    can_edit = (
        acc["user_id"] == user["id"]
        or user.get("role") in ("Owner", "Admin")
        or await _wa_user_has_assignment(sid, user["id"], user["tenant_id"])
    )
    if not can_edit:
        raise HTTPException(403, "Anda tidak punya akses ke chat ini")
    # Reset stage when status manually changed
    await db.wa_chats.update_one(
        {"session_id": sid, "jid": jid},
        {"$set": {
            "pipeline_status": status,
            "pipeline_stage": 0,
            "pipeline_updated_at": now_iso(),
            "pipeline_updated_by": user["id"],
        }},
    )
    return {"ok": True, "session_id": sid, "jid": jid, "pipeline_status": status}


@api.get("/whatsapp/pipeline/counts")
async def wa_pipeline_counts(user: dict = Depends(get_current_user)):
    """Return chat counts per pipeline status + follow-up queue count.
    Scope: tenant-wide (Owner/Admin see all), else only chats on user's accounts or assignments.
    """
    from datetime import datetime as _dt
    now = _dt.now(timezone.utc)
    # Find accessible sessions
    own_sids = await db.wa_accounts.distinct("session_id", _wa_scope_query(user))
    assigned_sids = await db.wa_chat_assignments.distinct(
        "session_id", {"tenant_id": user["tenant_id"], "assigned_user_id": user["id"]},
    )
    accessible_sids = list(set(own_sids) | set(assigned_sids))
    if not accessible_sids:
        return {"cold": 0, "hot": 0, "warm": 0, "hold": 0, "deal": 0, "lost": 0, "follow_up": 0}
    q = {"session_id": {"$in": accessible_sids}}
    # For non-Owner/Admin using assigned inbox, restrict to their assigned chats only
    if user.get("role") not in ("Owner", "Admin"):
        assign_jids = await db.wa_chat_assignments.find(
            {"tenant_id": user["tenant_id"], "assigned_user_id": user["id"], "session_id": {"$in": assigned_sids}},
            {"_id": 0, "session_id": 1, "jid": 1},
        ).to_list(5000)
        assigned_jid_by_sid = {}
        for a in assign_jids:
            assigned_jid_by_sid.setdefault(a["session_id"], set()).add(a["jid"])
        # Chats: from own_sids all, from assigned_sids only assigned jids
        # For simplicity in aggregation, fetch all and filter in memory (small scale MVP)
    counts = {s: 0 for s in PIPELINE_STATUSES}
    counts["follow_up"] = 0
    async for chat in db.wa_chats.find(q, {"_id": 0}):
        # Filter for non-admin users on assigned inbox
        if user.get("role") not in ("Owner", "Admin"):
            sid_ = chat["session_id"]
            if sid_ in assigned_sids and sid_ not in own_sids:
                if chat["jid"] not in assigned_jid_by_sid.get(sid_, set()):
                    continue
        st = chat.get("pipeline_status") or "cold"
        if st in counts:
            counts[st] += 1
        if _compute_followup_due(chat, now):
            counts["follow_up"] += 1
    return counts


@api.get("/whatsapp/pipeline/chats")
async def wa_pipeline_chats(
    filter: str = "follow_up",
    limit: int = 200,
    user: dict = Depends(get_current_user),
):
    """List chats filtered by pipeline: hot|cold|warm|hold|deal|lost|follow_up (all sessions)."""
    from datetime import datetime as _dt
    now = _dt.now(timezone.utc)
    own_sids = await db.wa_accounts.distinct("session_id", _wa_scope_query(user))
    assigned_sids = await db.wa_chat_assignments.distinct(
        "session_id", {"tenant_id": user["tenant_id"], "assigned_user_id": user["id"]},
    )
    accessible_sids = list(set(own_sids) | set(assigned_sids))
    if not accessible_sids:
        return []
    q = {"session_id": {"$in": accessible_sids}}
    if filter in PIPELINE_STATUSES:
        q["pipeline_status"] = filter

    assigned_jid_by_sid = {}
    if user.get("role") not in ("Owner", "Admin"):
        assigns = await db.wa_chat_assignments.find(
            {"tenant_id": user["tenant_id"], "assigned_user_id": user["id"], "session_id": {"$in": assigned_sids}},
            {"_id": 0, "session_id": 1, "jid": 1},
        ).to_list(5000)
        for a in assigns:
            assigned_jid_by_sid.setdefault(a["session_id"], set()).add(a["jid"])

    # Attach account label for display
    accs = await db.wa_accounts.find({"session_id": {"$in": accessible_sids}}, {"_id": 0, "session_id": 1, "label": 1, "phone": 1}).to_list(200)
    acc_map = {a["session_id"]: a for a in accs}

    result = []
    async for chat in db.wa_chats.find(q, {"_id": 0}).sort("updated_at", -1).limit(limit * 3):
        if user.get("role") not in ("Owner", "Admin"):
            sid_ = chat["session_id"]
            if sid_ in assigned_sids and sid_ not in own_sids:
                if chat["jid"] not in assigned_jid_by_sid.get(sid_, set()):
                    continue
        due = _compute_followup_due(chat, now)
        if filter == "follow_up" and not due:
            continue
        chat["is_followup_due"] = due
        chat["_account"] = acc_map.get(chat["session_id"], {})
        result.append(chat)
        if len(result) >= limit:
            break
    return result



@api.get("/whatsapp/accounts/{sid}/groups")
async def wa_list_groups(sid: str, user: dict = Depends(get_current_user)):
    """Fetch all WhatsApp groups for this account (fresh from WA)."""
    await _wa_check_account_access(sid, user)
    return await _wa_call("GET", f"/sessions/{sid}/groups")


@api.post("/whatsapp/accounts/{sid}/chats/{jid}/read")
async def wa_mark_read(sid: str, jid: str, user: dict = Depends(get_current_user)):
    acc = await _wa_check_account_access(sid, user)
    if not await _wa_user_can_send_on_chat(sid, jid, user, acc):
        # Owner/Admin viewing — don't mark read on someone else's behalf
        return {"ok": True, "skipped": "viewer_only"}
    return await _wa_call("POST", f"/sessions/{sid}/chats/{jid}/read")


# ────────────────────────────────────────────────────────────
# LinkedIn Prospect Module (manual workflow + AI assist)
# ────────────────────────────────────────────────────────────
from linkedin_service import (
    research_company as li_research_company,
    generate_message as li_generate_message,
    PIPELINE_STAGES as LI_PIPELINE_STAGES,
)
from company_search import search_companies as li_search_companies


class LICompanySearch(BaseModel):
    keyword: str
    country: Optional[str] = None
    limit: int = Field(default=20, ge=1, le=50)
    linkedin_only: bool = False
    use_session: bool = False  # If True & user has li_session, do native enrichment
    use_scrapingdog: bool = False  # If True & tenant has scrapingdog key, use Google SERP


async def _filter_existing_prospects(tenant_id: str, rows: List[dict]) -> tuple[List[dict], int]:
    """Filter out companies that already exist in li_prospects for this tenant.
    Match by linkedin_url, website, or normalized company_name."""
    if not rows:
        return rows, 0
    # Collect candidate keys
    li_urls = []
    websites = []
    names = []
    for r in rows:
        if r.get("company_linkedin_url"):
            li_urls.append(r["company_linkedin_url"])
        if r.get("website") and "linkedin.com" not in r["website"]:
            websites.append(r["website"])
        if r.get("company_name"):
            names.append(r["company_name"].strip().lower())
    # Single OR query against li_prospects
    or_clauses = []
    if li_urls:
        or_clauses.append({"company_linkedin_url": {"$in": li_urls}})
    if websites:
        or_clauses.append({"website": {"$in": websites}})
    if names:
        # Use $regex-free $in with normalized lowercase for exact-match
        or_clauses.append({"_company_name_lc": {"$in": names}})
    if not or_clauses:
        return rows, 0
    cursor = db.li_prospects.find(
        {"tenant_id": tenant_id, "$or": or_clauses},
        {"_id": 0, "company_name": 1, "website": 1, "company_linkedin_url": 1},
    )
    existing = await cursor.to_list(length=500)
    existing_li = {e.get("company_linkedin_url") for e in existing if e.get("company_linkedin_url")}
    existing_web = {e.get("website") for e in existing if e.get("website")}
    existing_names = {(e.get("company_name") or "").strip().lower() for e in existing}
    filtered = []
    hidden = 0
    for r in rows:
        if (r.get("company_linkedin_url") in existing_li or
            r.get("website") in existing_web or
            (r.get("company_name") or "").strip().lower() in existing_names):
            hidden += 1
            continue
        filtered.append(r)
    return filtered, hidden


@api.post("/linkedin/search-companies")
async def li_search_companies_ep(payload: LICompanySearch, user: dict = Depends(get_current_user)):
    """Aggregator: search companies by keyword. Cached in MongoDB for 24 hours.
    Modes (priority): scrapingdog → li-native → li-only → web."""
    if payload.use_scrapingdog:
        mode = "scrapingdog"
    elif payload.use_session and payload.linkedin_only:
        mode = "li-native"
    elif payload.linkedin_only:
        mode = "li-only"
    else:
        mode = "web"
    cache_key = f"{(payload.keyword or '').strip().lower()}|{(payload.country or '').strip().lower()}|{payload.limit}|{mode}"
    now_dt = datetime.now(timezone.utc)
    cache = await db.li_search_cache.find_one({"key": cache_key}, {"_id": 0})
    if cache:
        try:
            cached_at = datetime.fromisoformat(cache["cached_at"])
            # Scrapingdog cache 7 days (paid), others 24h
            max_age = 86400 * 7 if mode == "scrapingdog" else 86400
            if (now_dt - cached_at).total_seconds() < max_age:
                return {"keyword": payload.keyword, "count": len(cache["results"]),
                        "results": cache["results"], "cached": True, "mode": mode}
        except Exception:
            pass

    # Scrapingdog Google SERP mode
    if payload.use_scrapingdog:
        tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0, "scrapingdog_api_key": 1})
        api_key = (tenant or {}).get("scrapingdog_api_key", "").strip()
        if not api_key:
            raise HTTPException(400, "Scrapingdog API key belum diset. Set di Settings → API Keys.")
        from scrapingdog_service import search_linkedin_companies as sd_search
        try:
            sd_res = await sd_search(api_key=api_key, keyword=payload.keyword,
                                       country=payload.country, limit=payload.limit)
            rows = [{**r, "country": payload.country or None} for r in sd_res["results"]]
            # Track usage
            await db.scrapingdog_usage.insert_one({
                "tenant_id": user["tenant_id"], "user_id": user["id"],
                "type": "search", "credits": sd_res.get("credits_used", 1),
                "keyword": payload.keyword, "country": payload.country,
                "results_count": len(rows), "ts": now_iso(),
            })
        except Exception as e:
            if cache and cache.get("results"):
                return {"keyword": payload.keyword, "count": len(cache["results"]),
                        "results": cache["results"], "cached": True, "stale": True, "mode": mode}
            raise HTTPException(502, f"Scrapingdog error: {e}")
        if rows:
            await db.li_search_cache.update_one(
                {"key": cache_key},
                {"$set": {"key": cache_key, "keyword": payload.keyword, "country": payload.country,
                          "results": rows, "cached_at": now_dt.isoformat(), "mode": mode}},
                upsert=True,
            )
        # Filter out already-prospected (don't waste sales' attention)
        rows, hidden = await _filter_existing_prospects(user["tenant_id"], rows)
        return {"keyword": payload.keyword, "count": len(rows), "results": rows,
                "cached": False, "mode": mode, "hidden_existing": hidden}

    # Load LinkedIn session from sub_company if requested
    li_session = None
    if payload.use_session and payload.linkedin_only:
        sender_ctx = await _li_get_user_sender_context(user)
        ls = sender_ctx or {}
        if ls.get("li_at"):
            li_session = {"li_at": ls.get("li_at"), "jsessionid": ls.get("jsessionid")}

    try:
        rows = await li_search_companies(
            payload.keyword, country=payload.country, limit=payload.limit,
            linkedin_only=payload.linkedin_only, li_session=li_session,
        )
    except Exception as e:
        if cache and cache.get("results"):
            return {"keyword": payload.keyword, "count": len(cache["results"]),
                    "results": cache["results"], "cached": True, "stale": True, "mode": mode}
        raise HTTPException(502, f"Search engine error: {e}")

    if rows:
        await db.li_search_cache.update_one(
            {"key": cache_key},
            {"$set": {"key": cache_key, "keyword": payload.keyword, "country": payload.country,
                      "results": rows, "cached_at": now_dt.isoformat(), "mode": mode}},
            upsert=True,
        )
    rows, hidden = await _filter_existing_prospects(user["tenant_id"], rows)
    return {"keyword": payload.keyword, "count": len(rows), "results": rows,
            "cached": False, "mode": mode, "hidden_existing": hidden}


@api.post("/linkedin/bulk-enrich-scrapingdog")
async def bulk_enrich_scrapingdog(payload: dict, user: dict = Depends(get_current_user)):
    """Enrich multiple companies in parallel. Body: {slugs: List[str]}.
    Each cached enrichment = 0 credits. New = 10 credits per company. Max 15 per call."""
    slugs = payload.get("slugs") or []
    if not isinstance(slugs, list) or not slugs:
        raise HTTPException(400, "slugs[] required")
    slugs = [s.strip() for s in slugs if s and isinstance(s, str)][:15]
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0, "scrapingdog_api_key": 1})
    api_key = (tenant or {}).get("scrapingdog_api_key", "").strip()
    if not api_key:
        raise HTTPException(400, "Scrapingdog API key belum diset")
    from scrapingdog_service import enrich_linkedin_company as sd_enrich
    import asyncio as _asyncio
    results = []
    total_credits = 0
    async def _one(slug):
        nonlocal total_credits
        # Normalize slug from URL if needed
        m = re.search(r"linkedin\.com/company/([^/?#]+)", slug)
        s = m.group(1).rstrip("/") if m else slug
        cache_key = f"sd-enrich|{s}"
        cached = await db.li_search_cache.find_one({"key": cache_key}, {"_id": 0})
        if cached:
            try:
                cached_at = datetime.fromisoformat(cached["cached_at"])
                if (datetime.now(timezone.utc) - cached_at).total_seconds() < 86400 * 30:
                    return {**cached["results"][0], "cached": True, "slug": s}
            except Exception:
                pass
        try:
            data = await sd_enrich(api_key=api_key, slug_or_url=s)
            total_credits += data.get("credits_used", 10) if data.get("ok") else 0
            if data.get("ok"):
                await db.li_search_cache.update_one(
                    {"key": cache_key},
                    {"$set": {"key": cache_key, "results": [data],
                              "cached_at": datetime.now(timezone.utc).isoformat(), "mode": "sd-enrich"}},
                    upsert=True,
                )
            return {**data, "cached": False, "slug": s}
        except Exception as e:
            return {"ok": False, "slug": s, "reason": str(e)[:200]}

    results = await _asyncio.gather(*[_one(s) for s in slugs])
    if total_credits > 0:
        await db.scrapingdog_usage.insert_one({
            "tenant_id": user["tenant_id"], "user_id": user["id"],
            "type": "enrich", "credits": total_credits,
            "bulk": True, "slug_count": len(slugs), "ts": now_iso(),
        })
    return {"enriched": results, "total_credits_used": total_credits,
            "cached_count": sum(1 for r in results if r.get("cached"))}


@api.post("/linkedin/enrich-scrapingdog")
async def enrich_via_scrapingdog(payload: dict, user: dict = Depends(get_current_user)):
    """Deep-enrich a LinkedIn company via Scrapingdog LinkedIn Scraper API.
    Body: {linkedin_url: str | slug: str}. Cost: ~10 credits."""
    slug = (payload.get("slug") or payload.get("linkedin_url") or "").strip()
    if not slug:
        raise HTTPException(400, "slug or linkedin_url required")
    tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0, "scrapingdog_api_key": 1})
    api_key = (tenant or {}).get("scrapingdog_api_key", "").strip()
    if not api_key:
        raise HTTPException(400, "Scrapingdog API key belum diset")
    # Cache enrichment 30 days
    cache_key = f"sd-enrich|{slug}"
    cached = await db.li_search_cache.find_one({"key": cache_key}, {"_id": 0})
    if cached:
        try:
            cached_at = datetime.fromisoformat(cached["cached_at"])
            if (datetime.now(timezone.utc) - cached_at).total_seconds() < 86400 * 30:
                return {**cached["results"][0], "cached": True}
        except Exception:
            pass
    from scrapingdog_service import enrich_linkedin_company as sd_enrich
    try:
        data = await sd_enrich(api_key=api_key, slug_or_url=slug)
    except Exception as e:
        raise HTTPException(502, f"Scrapingdog enrich error: {e}")
    await db.scrapingdog_usage.insert_one({
        "tenant_id": user["tenant_id"], "user_id": user["id"],
        "type": "enrich", "credits": data.get("credits_used", 10),
        "slug": slug, "ts": now_iso(),
    })
    if data.get("ok"):
        await db.li_search_cache.update_one(
            {"key": cache_key},
            {"$set": {"key": cache_key, "results": [data],
                      "cached_at": datetime.now(timezone.utc).isoformat(), "mode": "sd-enrich"}},
            upsert=True,
        )
    return {**data, "cached": False}


@api.post("/scrapingdog/validate")
async def validate_scrapingdog_key(payload: dict, user: dict = Depends(require_role("Owner", "Admin"))):
    """Test if Scrapingdog API key works. Body: {api_key?}. Uses key from payload or tenant settings."""
    api_key = (payload.get("api_key") or "").strip()
    if not api_key:
        tenant = await db.tenants.find_one({"id": user["tenant_id"]}, {"_id": 0, "scrapingdog_api_key": 1})
        api_key = (tenant or {}).get("scrapingdog_api_key", "").strip()
    if not api_key:
        raise HTTPException(400, "API key kosong")
    from scrapingdog_service import validate_api_key
    res = await validate_api_key(api_key)
    return res


@api.get("/scrapingdog/usage")
async def scrapingdog_usage_stats(user: dict = Depends(require_role("Owner", "Admin"))):
    """Aggregated credits used per day (last 30 days) per type."""
    pipeline = [
        {"$match": {"tenant_id": user["tenant_id"]}},
        {"$group": {
            "_id": {"date": {"$substr": ["$ts", 0, 10]}, "type": "$type"},
            "credits": {"$sum": "$credits"},
            "count": {"$sum": 1},
        }},
        {"$sort": {"_id.date": -1}},
        {"$limit": 60},
    ]
    rows = await db.scrapingdog_usage.aggregate(pipeline).to_list(60)
    by_day = {}
    total_credits = 0
    for r in rows:
        day = r["_id"]["date"]
        kind = r["_id"]["type"]
        by_day.setdefault(day, {"search": 0, "enrich": 0, "total": 0})
        by_day[day][kind] = r["credits"]
        by_day[day]["total"] += r["credits"]
        total_credits += r["credits"]
    return {"by_day": by_day, "total_30d": total_credits}


@api.get("/linkedin/reminders")
async def li_reminders(user: dict = Depends(get_current_user)):
    """Return prospects needing follow-up reminder (3/7/14 day buckets after connect_sent)."""
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    q = {**_li_scope_q(user), "status": "connect_sent", "connect_sent_at": {"$ne": None}}
    rows = await db.li_prospects.find(q, {"_id": 0}).to_list(500)
    buckets = {"day3": [], "day7": [], "day14": []}
    for p in rows:
        try:
            ts = datetime.fromisoformat(p["connect_sent_at"].replace("Z", "+00:00"))
            days = (now - ts).days
        except Exception:
            continue
        item = {"id": p["id"], "company_name": p["company_name"],
                "dm_name": (p.get("decision_maker") or {}).get("full_name"),
                "days_waiting": days}
        if days >= 14:
            buckets["day14"].append(item)
        elif days >= 7:
            buckets["day7"].append(item)
        elif days >= 3:
            buckets["day3"].append(item)
    return buckets


class LIDecisionMaker(BaseModel):
    full_name: str
    job_title: Optional[str] = None
    department: Optional[str] = None
    linkedin_url: Optional[str] = None
    business_email: Optional[str] = None
    phone: Optional[str] = None
    notes: Optional[str] = None


class LIProspectCreate(BaseModel):
    date: str  # YYYY-MM-DD
    company_name: str
    website: Optional[str] = None
    industry: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    company_linkedin_url: Optional[str] = None
    notes: Optional[str] = None


class LIProspectUpdate(BaseModel):
    company_name: Optional[str] = None
    website: Optional[str] = None
    industry: Optional[str] = None
    country: Optional[str] = None
    city: Optional[str] = None
    company_linkedin_url: Optional[str] = None
    notes: Optional[str] = None
    research: Optional[dict] = None
    decision_maker: Optional[LIDecisionMaker] = None
    status: Optional[str] = None
    messages: Optional[dict] = None  # {connection_note, ice_breaker, first_message, follow_up}
    reply_status: Optional[Literal["interested","not_interested","meeting_requested","no_response"]] = None
    priority: Optional[Literal["low","medium","high"]] = None


async def _li_add_timeline(tenant_id: str, user_id: str, prospect_id: str, type_: str, data: Optional[dict] = None):
    await db.li_timeline.insert_one({
        "id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "user_id": user_id,
        "prospect_id": prospect_id,
        "type": type_,
        "data": data or {},
        "at": now_iso(),
    })


def _li_scope_q(user: dict) -> dict:
    """Owner sees all. Others see own only."""
    q = {"tenant_id": user["tenant_id"]}
    if user.get("role") != "Owner":
        q["user_id"] = user["id"]
    return q


@api.get("/linkedin/dashboard")
async def li_dashboard(date: str, user: dict = Depends(get_current_user)):
    """Daily session: target + completed + remaining + today's prospects."""
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Invalid date YYYY-MM-DD")
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "linkedin_daily_target": 1, "daily_target": 1}) or {}
    target = int(u.get("linkedin_daily_target") or 15)
    q = {**_li_scope_q(user), "date": date}
    prospects = await db.li_prospects.find(q, {"_id": 0}).sort("created_at", 1).to_list(500)
    completed = len(prospects)
    return {
        "date": date,
        "target": target,
        "completed": completed,
        "remaining": max(0, target - completed),
        "prospects": prospects,
    }


@api.get("/linkedin/calendar")
async def li_calendar(year: int, month: int, user: dict = Depends(get_current_user)):
    """Counts per day in a month — for calendar dots / progress."""
    if month < 1 or month > 12:
        raise HTTPException(400, "Invalid month")
    from calendar import monthrange
    last = monthrange(year, month)[1]
    start = f"{year:04d}-{month:02d}-01"
    end = f"{year:04d}-{month:02d}-{last:02d}"
    q = {**_li_scope_q(user), "date": {"$gte": start, "$lte": end}}
    rows = await db.li_prospects.find(q, {"_id": 0, "date": 1, "status": 1}).to_list(2000)
    by_date: dict = {}
    for r in rows:
        d = by_date.setdefault(r["date"], {"total": 0, "won": 0, "accepted": 0, "connect_sent": 0})
        d["total"] += 1
        if r.get("status") == "won":
            d["won"] += 1
        if r.get("status") in ("accepted", "conversation", "follow_up", "meeting", "quotation", "won"):
            d["accepted"] += 1
        if r.get("status") in ("connect_sent", "accepted", "conversation", "follow_up", "meeting", "quotation", "won"):
            d["connect_sent"] += 1
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "linkedin_daily_target": 1}) or {}
    target = int(u.get("linkedin_daily_target") or 15)
    return {"year": year, "month": month, "target": target, "days": by_date}


@api.post("/linkedin/prospects")
async def li_create_prospect(payload: LIProspectCreate, user: dict = Depends(get_current_user)):
    try:
        datetime.strptime(payload.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Invalid date YYYY-MM-DD")
    pid = str(uuid.uuid4())
    doc = {
        "id": pid,
        "tenant_id": user["tenant_id"],
        "user_id": user["id"],
        "date": payload.date,
        "company_name": payload.company_name.strip(),
        "website": payload.website,
        "industry": payload.industry,
        "country": payload.country,
        "city": payload.city,
        "company_linkedin_url": payload.company_linkedin_url,
        "notes": payload.notes,
        "research": None,
        "decision_maker": None,
        "messages": {},
        "status": "added",
        "priority": "medium",
        "reply_status": None,
        "connect_sent_at": None,
        "accepted_at": None,
        "first_message_sent_at": None,
        "last_reply_at": None,
        "_company_name_lc": (payload.company_name or "").strip().lower(),  # for dedup
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }
    await db.li_prospects.insert_one(doc)
    await _li_add_timeline(user["tenant_id"], user["id"], pid, "prospect_added",
                           {"company_name": payload.company_name})
    return {k: v for k, v in doc.items() if k != "_id"}


@api.get("/linkedin/prospects")
async def li_list_prospects(
    date: Optional[str] = None,
    status: Optional[str] = None,
    q: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    """List with filters. status='all' or omitted = all stages."""
    query = _li_scope_q(user)
    if date:
        query["date"] = date
    if status and status != "all":
        query["status"] = status
    if q:
        query["$or"] = [
            {"company_name": {"$regex": re.escape(q), "$options": "i"}},
            {"website": {"$regex": re.escape(q), "$options": "i"}},
            {"industry": {"$regex": re.escape(q), "$options": "i"}},
            {"decision_maker.full_name": {"$regex": re.escape(q), "$options": "i"}},
            {"company_linkedin_url": {"$regex": re.escape(q), "$options": "i"}},
        ]
    rows = await db.li_prospects.find(query, {"_id": 0}).sort("created_at", -1).limit(500).to_list(500)
    return rows


@api.get("/linkedin/prospects/{pid}")
async def li_get_prospect(pid: str, user: dict = Depends(get_current_user)):
    p = await db.li_prospects.find_one({"id": pid, **_li_scope_q(user)}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Not found")
    # Attach timeline
    p["timeline"] = await db.li_timeline.find(
        {"prospect_id": pid, "tenant_id": user["tenant_id"]},
        {"_id": 0},
    ).sort("at", -1).limit(100).to_list(100)
    return p


@api.patch("/linkedin/prospects/{pid}")
async def li_update_prospect(pid: str, payload: LIProspectUpdate, user: dict = Depends(get_current_user)):
    p = await db.li_prospects.find_one({"id": pid, **_li_scope_q(user)}, {"_id": 0, "user_id": 1, "status": 1})
    if not p:
        raise HTTPException(404, "Not found")
    if p["user_id"] != user["id"] and user.get("role") != "Owner":
        raise HTTPException(403, "Tidak boleh edit prospect orang lain")

    changes = payload.model_dump(exclude_unset=True)
    if "decision_maker" in changes and changes["decision_maker"]:
        changes["decision_maker"] = changes["decision_maker"]  # already dict via model_dump

    new_status = changes.get("status")
    if new_status and new_status not in LI_PIPELINE_STAGES:
        raise HTTPException(400, f"Invalid status. Allowed: {LI_PIPELINE_STAGES}")

    # Auto-fill timestamps for key transitions
    ts = now_iso()
    if new_status == "connect_sent":
        changes.setdefault("connect_sent_at", ts)
    if new_status == "accepted":
        changes.setdefault("accepted_at", ts)
    if new_status == "conversation":
        changes.setdefault("first_message_sent_at", ts)

    changes["updated_at"] = ts
    await db.li_prospects.update_one({"id": pid}, {"$set": changes})

    # Timeline events for meaningful changes
    if new_status and new_status != p.get("status"):
        await _li_add_timeline(user["tenant_id"], user["id"], pid, f"status_{new_status}",
                               {"from": p.get("status"), "to": new_status})
    if "decision_maker" in changes:
        await _li_add_timeline(user["tenant_id"], user["id"], pid, "dm_updated",
                               {"name": (changes["decision_maker"] or {}).get("full_name")})

    updated = await db.li_prospects.find_one({"id": pid}, {"_id": 0})
    return updated


@api.delete("/linkedin/prospects/{pid}")
async def li_delete_prospect(pid: str, user: dict = Depends(get_current_user)):
    p = await db.li_prospects.find_one({"id": pid, **_li_scope_q(user)}, {"_id": 0, "user_id": 1})
    if not p:
        raise HTTPException(404, "Not found")
    if p["user_id"] != user["id"] and user.get("role") != "Owner":
        raise HTTPException(403, "Tidak boleh hapus prospect orang lain")
    await db.li_prospects.delete_one({"id": pid})
    await db.li_timeline.delete_many({"prospect_id": pid})
    return {"ok": True}


class LISenderContextResp(BaseModel):
    sub_company_id: Optional[str] = None
    profile_url: Optional[str] = None
    profile_name: Optional[str] = None
    signature: Optional[str] = None
    default_connection_template: Optional[str] = None


class LICompanySettings(BaseModel):
    profile_url: Optional[str] = None
    profile_name: Optional[str] = None
    signature: Optional[str] = None
    default_connection_template: Optional[str] = None
    # LinkedIn Session (optional, RISKY — for native search/enrichment)
    li_at: Optional[str] = None
    jsessionid: Optional[str] = None


@api.post("/companies/{sc_id}/linkedin-settings/validate-session")
async def validate_li_session(sc_id: str, payload: LICompanySettings,
                                user: dict = Depends(get_current_user)):
    """Test if the provided li_at cookie is valid. Returns {ok, name, headline}.
    Hits ONE LinkedIn page with the cookie & parses meta. Persists validation status."""
    if user["role"] not in ("Owner", "Admin"):
        raise HTTPException(403, "Hanya Owner / Admin")
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]}, {"_id": 0, "id": 1, "linkedin_settings": 1})
    if not sc:
        raise HTTPException(404, "Company tidak ditemukan")
    # Use provided cookies, or fallback to stored ones
    li_at = (payload.li_at or "").strip() or (sc.get("linkedin_settings") or {}).get("li_at", "").strip()
    if not li_at:
        raise HTTPException(400, "li_at cookie required")
    jsess = (payload.jsessionid or "").strip().strip('"') or (sc.get("linkedin_settings") or {}).get("jsessionid", "").strip().strip('"')
    cookies = {"li_at": li_at}
    if jsess:
        cookies["JSESSIONID"] = f'"{jsess}"'
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    }
    import httpx as _httpx
    status = "invalid"
    page_title = ""
    try:
        async with _httpx.AsyncClient(timeout=12.0, follow_redirects=True, cookies=cookies, headers=headers) as cx:
            r = await cx.get("https://www.linkedin.com/feed/")
        if r.status_code == 200 and "login" not in str(r.url).lower() and "authwall" not in r.text.lower():
            from bs4 import BeautifulSoup as _BS
            soup = _BS(r.text, "lxml")
            title_tag = soup.find("title")
            page_title = title_tag.get_text() if title_tag else ""
            status = "active"
    except Exception as e:
        await db.sub_companies.update_one(
            {"id": sc_id},
            {"$set": {"linkedin_settings.li_session_status": "error",
                       "linkedin_settings.li_session_validated_at": now_iso()}},
        )
        raise HTTPException(502, f"LinkedIn check failed: {e}")
    # Persist status
    await db.sub_companies.update_one(
        {"id": sc_id},
        {"$set": {"linkedin_settings.li_session_status": status,
                   "linkedin_settings.li_session_validated_at": now_iso()}},
    )
    return {"ok": status == "active", "status": status, "page_title": page_title[:120],
            "checked_at": now_iso()}


@api.post("/companies/{sc_id}/linkedin-settings/disconnect-session")
async def disconnect_li_session(sc_id: str, user: dict = Depends(get_current_user)):
    """Remove stored LinkedIn cookies from sub_company. Identity (name, signature) stays."""
    if user["role"] not in ("Owner", "Admin"):
        raise HTTPException(403, "Hanya Owner / Admin")
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]}, {"_id": 0, "id": 1})
    if not sc:
        raise HTTPException(404, "Company tidak ditemukan")
    await db.sub_companies.update_one(
        {"id": sc_id},
        {"$unset": {"linkedin_settings.li_at": "", "linkedin_settings.jsessionid": "",
                     "linkedin_settings.li_session_status": "", "linkedin_settings.li_session_validated_at": ""}},
    )
    return {"ok": True, "sub_company_id": sc_id}


@api.patch("/companies/{sc_id}/linkedin-settings")
async def set_company_linkedin_settings(sc_id: str, payload: LICompanySettings,
                                         user: dict = Depends(get_current_user)):
    """Owner / Admin sets LinkedIn identity for a sub_company. Users assigned to this
    sub_company will USE this LinkedIn profile context when generating connection notes."""
    if user["role"] not in ("Owner", "Admin"):
        raise HTTPException(403, "Hanya Owner / Admin yang bisa set LinkedIn settings")
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]}, {"_id": 0})
    if not sc:
        raise HTTPException(404, "Company tidak ditemukan")
    settings = payload.model_dump(exclude_unset=True)
    # Merge with existing — don't overwrite cookies with empty strings (user just editing other fields)
    existing = sc.get("linkedin_settings") or {}
    for k in ("li_at", "jsessionid"):
        if k in settings and not settings[k]:
            settings.pop(k, None)
    merged = {**existing, **settings}
    # If cookies changed, reset validation status
    if settings.get("li_at") and settings["li_at"] != existing.get("li_at"):
        merged["li_session_status"] = "configured"
        merged["li_session_validated_at"] = None
    await db.sub_companies.update_one(
        {"id": sc_id, "tenant_id": user["tenant_id"]},
        {"$set": {"linkedin_settings": merged, "updated_at": now_iso()}},
    )
    # Return masked response
    return {"sub_company_id": sc_id, "li_session_configured": bool(merged.get("li_at"))}


@api.get("/companies/{sc_id}/linkedin-settings")
async def get_company_linkedin_settings(sc_id: str, user: dict = Depends(get_current_user)):
    sc = await db.sub_companies.find_one(
        {"id": sc_id, "tenant_id": user["tenant_id"]},
        {"_id": 0, "id": 1, "name": 1, "linkedin_settings": 1},
    )
    if not sc:
        raise HTTPException(404, "Company tidak ditemukan")
    ls = sc.get("linkedin_settings") or {}
    # Mask sensitive cookies — only show first 4 + last 4 chars
    li_at = ls.get("li_at") or ""
    jsess = ls.get("jsessionid") or ""
    safe_ls = {
        "profile_url": ls.get("profile_url"),
        "profile_name": ls.get("profile_name"),
        "signature": ls.get("signature"),
        "default_connection_template": ls.get("default_connection_template"),
        "li_at_masked": (f"{li_at[:4]}…{li_at[-4:]}" if len(li_at) > 12 else ("•" * len(li_at) if li_at else "")),
        "jsessionid_masked": (f"{jsess[:4]}…{jsess[-4:]}" if len(jsess) > 12 else ("•" * len(jsess) if jsess else "")),
        "li_session_configured": bool(li_at),
        "li_session_validated_at": ls.get("li_session_validated_at"),
        "li_session_status": ls.get("li_session_status") or ("configured" if li_at else "none"),
    }
    return {"sub_company_id": sc["id"], "name": sc["name"], "linkedin_settings": safe_ls}


class LITestGenerateReq(BaseModel):
    settings: LICompanySettings
    kind: Literal["connection_note", "ice_breaker", "first_message", "follow_up"] = "connection_note"
    # Optional dummy prospect override for preview
    company_name: Optional[str] = "Acme Industries"
    industry: Optional[str] = "Manufacturing"
    country: Optional[str] = "Indonesia"
    city: Optional[str] = "Jakarta"
    website: Optional[str] = "acme.com"
    dm_name: Optional[str] = "Budi Santoso"
    dm_title: Optional[str] = "Head of Procurement"


@api.post("/companies/{sc_id}/linkedin-settings/test-generate")
async def test_generate_linkedin_message(sc_id: str, payload: LITestGenerateReq,
                                          user: dict = Depends(get_current_user)):
    """Preview a sample AI message using the provided LinkedIn settings + a dummy prospect.
    Does NOT save to DB. For Owner/Admin to sanity-check tone & signature before going live."""
    if user["role"] not in ("Owner", "Admin"):
        raise HTTPException(403, "Hanya Owner / Admin yang bisa test generate")
    sc = await db.sub_companies.find_one({"id": sc_id, "tenant_id": user["tenant_id"]}, {"_id": 0, "id": 1, "name": 1})
    if not sc:
        raise HTTPException(404, "Company tidak ditemukan")

    ls = payload.settings.model_dump(exclude_unset=False)
    hint_parts = []
    if ls.get("profile_name"):
        hint_parts.append(f"You are writing AS: {ls['profile_name']}")
    hint_parts.append(f"Representing company: {sc['name']}")
    if ls.get("signature"):
        hint_parts.append(f"End message with this signature (if appropriate): {ls['signature']}")
    if payload.kind == "connection_note" and ls.get("default_connection_template"):
        hint_parts.append(f"Use this template as base (rephrase + personalize): {ls['default_connection_template']}")
    sender_hint = " | ".join(hint_parts)

    dummy_prospect = {
        "company_name": payload.company_name,
        "website": payload.website,
        "industry": payload.industry,
        "country": payload.country,
        "city": payload.city,
        "research": {},
    }
    dummy_dm = {"full_name": payload.dm_name, "job_title": payload.dm_title}
    try:
        text = await li_generate_message(
            prospect_id=f"preview-{sc_id}", kind=payload.kind,
            prospect=dummy_prospect, dm=dummy_dm, custom_hint=sender_hint,
        )
    except Exception as e:
        raise HTTPException(500, f"AI message gen gagal: {e}")
    return {
        "kind": payload.kind,
        "text": text,
        "sender_context": {
            "sub_company_id": sc["id"],
            "sub_company_name": sc["name"],
            **ls,
        },
        "preview_prospect": {**dummy_prospect, "decision_maker": dummy_dm},
    }


async def _li_get_user_sender_context(user: dict) -> dict:
    """Get LinkedIn sender context from user's assigned sub_companies. Picks first
    sub_company that has linkedin_settings configured."""
    sub_ids = user.get("sub_company_ids") or []
    if not sub_ids:
        return {}
    rows = await db.sub_companies.find(
        {"id": {"$in": sub_ids}, "tenant_id": user["tenant_id"]},
        {"_id": 0, "id": 1, "name": 1, "linkedin_settings": 1},
    ).to_list(50)
    for r in rows:
        ls = r.get("linkedin_settings") or {}
        if ls.get("profile_url") or ls.get("profile_name") or ls.get("signature"):
            return {
                "sub_company_id": r["id"],
                "sub_company_name": r["name"],
                **ls,
            }
    return {}


@api.get("/linkedin/sender-context")
async def li_get_sender_context(user: dict = Depends(get_current_user)):
    """Return the LinkedIn identity that this user will use for their outreach
    (derived from their assigned sub_company linkedin_settings)."""
    ctx = await _li_get_user_sender_context(user)
    return ctx or {"empty": True}


@api.post("/linkedin/prospects/{pid}/research")
async def li_run_research(pid: str, user: dict = Depends(get_current_user)):
    """Trigger AI research via Claude Sonnet 4.5. Saves to prospect.research."""
    p = await db.li_prospects.find_one({"id": pid, **_li_scope_q(user)}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Not found")
    if p["user_id"] != user["id"] and user.get("role") != "Owner":
        raise HTTPException(403, "Tidak boleh research prospect orang lain")
    try:
        research = await li_research_company(
            prospect_id=pid,
            company_name=p["company_name"],
            website=p.get("website"),
            industry=p.get("industry"),
            country=p.get("country"),
            city=p.get("city"),
        )
    except Exception as e:
        raise HTTPException(500, f"AI research gagal: {e}")
    new_status = p.get("status") if p.get("status") not in ("added",) else "researched"
    await db.li_prospects.update_one(
        {"id": pid},
        {"$set": {"research": research, "status": new_status, "updated_at": now_iso()}},
    )
    await _li_add_timeline(user["tenant_id"], user["id"], pid, "research_completed",
                           {"lead_score": research.get("lead_score")})
    return {"research": research, "status": new_status}


class LIGenerateMessageReq(BaseModel):
    kind: Literal["connection_note", "ice_breaker", "first_message", "follow_up"]
    custom_hint: Optional[str] = None


@api.post("/linkedin/prospects/{pid}/messages/generate")
async def li_generate_msg(pid: str, payload: LIGenerateMessageReq, user: dict = Depends(get_current_user)):
    """Generate AI message variant via Gemini 3 Flash. Uses sender's assigned sub_company
    LinkedIn settings (signature, profile_name) as sender CONTEXT to LLM. Saves to prospect.messages."""
    p = await db.li_prospects.find_one({"id": pid, **_li_scope_q(user)}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Not found")
    if p["user_id"] != user["id"] and user.get("role") != "Owner":
        raise HTTPException(403, "Tidak boleh generate untuk prospect orang lain")
    dm = p.get("decision_maker") or {}
    if not dm.get("full_name") and payload.kind != "connection_note":
        raise HTTPException(400, "Tambahkan Decision Maker dulu untuk generate message ini")

    # Sender context from user's assigned sub_company (LinkedIn identity)
    sender_user = await db.users.find_one({"id": p["user_id"]}, {"_id": 0}) or user
    sender_ctx = await _li_get_user_sender_context(sender_user)

    # Build hint that includes sender brand context (so AI knows whose voice to write in)
    hint_parts = []
    if sender_ctx.get("profile_name"):
        hint_parts.append(f"You are writing AS: {sender_ctx['profile_name']}")
    if sender_ctx.get("sub_company_name"):
        hint_parts.append(f"Representing company: {sender_ctx['sub_company_name']}")
    if sender_ctx.get("signature"):
        hint_parts.append(f"End message with this signature (if appropriate): {sender_ctx['signature']}")
    if payload.kind == "connection_note" and sender_ctx.get("default_connection_template"):
        hint_parts.append(f"Use this template as base (rephrase + personalize): {sender_ctx['default_connection_template']}")
    if payload.custom_hint:
        hint_parts.append(f"Additional: {payload.custom_hint}")
    sender_hint = " | ".join(hint_parts) if hint_parts else None

    try:
        text = await li_generate_message(
            prospect_id=pid, kind=payload.kind,
            prospect=p, dm=dm, custom_hint=sender_hint,
        )
    except Exception as e:
        raise HTTPException(500, f"AI message gen gagal: {e}")
    messages = p.get("messages") or {}
    messages[payload.kind] = {
        "text": text,
        "generated_at": now_iso(),
        "sender_context": sender_ctx or None,
    }
    await db.li_prospects.update_one(
        {"id": pid},
        {"$set": {"messages": messages, "updated_at": now_iso()}},
    )
    await _li_add_timeline(user["tenant_id"], user["id"], pid, f"msg_{payload.kind}_generated",
                           {"via_company": (sender_ctx or {}).get("sub_company_name")})
    return {"kind": payload.kind, "text": text, "sender_context": sender_ctx or None}


@api.get("/linkedin/kpi")
async def li_kpi(date_from: Optional[str] = None, date_to: Optional[str] = None,
                 user: dict = Depends(get_current_user)):
    """Daily/range KPI: counters per pipeline stage + rates."""
    q = _li_scope_q(user)
    if date_from and date_to:
        q["date"] = {"$gte": date_from, "$lte": date_to}
    elif date_from:
        q["date"] = date_from
    rows = await db.li_prospects.find(q, {"_id": 0, "status": 1}).to_list(5000)
    counts = {s: 0 for s in LI_PIPELINE_STAGES}
    for r in rows:
        st = r.get("status") or "added"
        if st in counts:
            counts[st] += 1
    total = len(rows)
    connect_sent = sum(counts[s] for s in ("connect_sent","accepted","conversation","follow_up","meeting","quotation","won"))
    accepted = sum(counts[s] for s in ("accepted","conversation","follow_up","meeting","quotation","won"))
    conv = sum(counts[s] for s in ("conversation","follow_up","meeting","quotation","won"))
    meetings = sum(counts[s] for s in ("meeting","quotation","won"))
    deals = counts["won"]
    pct = lambda a, b: round((a / b) * 100, 1) if b > 0 else 0.0
    return {
        "total": total,
        "by_status": counts,
        "connect_sent": connect_sent,
        "accepted": accepted,
        "conversation": conv,
        "meetings": meetings,
        "deals": deals,
        "rates": {
            "acceptance_rate": pct(accepted, connect_sent),
            "conversation_rate": pct(conv, accepted),
            "meeting_rate": pct(meetings, conv),
            "deal_rate": pct(deals, meetings),
        },
    }


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    _scheduler_state["running"] = False
    client.close()


# ─── Scheduled-email worker (runs in background, polls every 60s) ───
_scheduler_state = {"running": False, "task": None}


async def _scheduler_loop():
    _scheduler_state["running"] = True
    while _scheduler_state["running"]:
        try:
            now = now_iso()
            # Find due scheduled emails — pick ONE at a time so we can throttle properly
            # between sends (most SMTP relays rate-limit to 1 email/sec or 1/minute).
            # Without this, all due emails would fire simultaneously → relay rejects → bounce.
            due = await db.email_sends.find({
                "status": "scheduled",
                "scheduled_at": {"$lte": now},
            }, {"_id": 0}).sort("scheduled_at", 1).limit(50).to_list(50)
            if due:
                logger.info(f"[scheduler tick @ {now}] {len(due)} email(s) due — dispatching sequentially with 180s throttle")
            for idx, s in enumerate(due):
                # Mark as 'sending' first to prevent another worker tick from picking it up
                claim = await db.email_sends.update_one(
                    {"id": s["id"], "status": "scheduled"},
                    {"$set": {"status": "sending"}},
                )
                if claim.modified_count == 0:
                    continue  # already claimed by previous tick
                # Resolve SMTP per send — use the SAME helper that send-now uses so we
                # honour the user → sub_company → tenant fallback chain correctly.
                # Without this, scheduled emails for users with smtp_use_company=true
                # fail with "SMTP not configured at send-time" even though send-now works.
                tenant = await db.tenants.find_one({"id": s["tenant_id"]}) or {}
                sender = await db.users.find_one({"id": s["sender_user_id"]})
                if not sender:
                    await _mark_bounced(s["id"], "Sender user not found at send-time", s["tenant_id"], s.get("prospect_id"), s.get("to_email"), s.get("sender_user_id"))
                    continue
                try:
                    smtp_src = await _resolve_smtp(s["tenant_id"], sender, s.get("sub_company_id"))
                except Exception as ex:
                    smtp_src = None
                    logger.warning(f"scheduler _resolve_smtp failed for {s['id']}: {ex}")
                if not smtp_src:
                    await _mark_bounced(s["id"], "SMTP not configured at send-time", s["tenant_id"], s.get("prospect_id"), s.get("to_email"), s.get("sender_user_id"))
                    continue
                from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
                from_name  = smtp_src.get("smtp_from_name")
                body_type, atts = await _load_template_extras(s["tenant_id"], s.get("template_id"))
                if body_type == "html":
                    tracked = inject_tracking(s["body_html"], s["id"], PUBLIC_BASE_URL or "")
                else:
                    tracked = s["body_html"]
                unsubscribe_url = f"{PUBLIC_BASE_URL}/api/track/unsubscribe/{s['id']}" if PUBLIC_BASE_URL else None
                final_body, inline_imgs = await _extract_inline_images_for_send(tracked, s["tenant_id"])
                result = await asyncio.to_thread(
                    send_smtp_email,
                    smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                    smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                    bool(smtp_src.get("smtp_use_tls", True)),
                    from_email, from_name, s["to_email"], s["subject"], final_body,
                    body_type, atts,
                    inline_images=inline_imgs,
                    list_unsubscribe_url=unsubscribe_url,
                    reply_to=from_email,
                )
                if result["ok"]:
                    await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                    if s.get("prospect_id"):
                        await _log_activity(s["prospect_id"], s["tenant_id"], "email_sent", s["sender_user_id"],
                                            {"to": s["to_email"], "send_id": s["id"], "scheduled": True})
                        await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                                       {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
                else:
                    await _mark_bounced(s["id"], result["error"], s["tenant_id"], s.get("prospect_id"), s.get("to_email"), s.get("sender_user_id"))
                # Throttle 3 minutes between sends to dodge SMTP relay rate-limits
                # (matches the immediate-send runner). Skip sleep after the last one.
                if idx < len(due) - 1:
                    await asyncio.sleep(180)
        except Exception as ex:
            logger.error("scheduler error: %s", ex)
        await asyncio.sleep(60)


@app.on_event("startup")
async def _start_scheduler():
    if _scheduler_state.get("task") is None:
        _scheduler_state["task"] = asyncio.create_task(_scheduler_loop())
        tz = os.environ.get("APP_TIMEZONE", "UTC")
        logger.info(f"Scheduled-email worker started (60s poll, 180s throttle, TZ={tz})")
