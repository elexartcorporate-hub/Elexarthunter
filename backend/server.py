"""
Lead Hunter & Email Marketing Platform — FastAPI backend.
Multi-tenant SaaS with JWT auth, Hunter workflow, email campaigns + tracking.
"""
from dotenv import load_dotenv
from pathlib import Path
load_dotenv(Path(__file__).parent / ".env")

import os
import uuid
import logging
import asyncio
from datetime import datetime, timezone, timedelta
from typing import Optional, List, Literal, Dict, Any

import bcrypt
import jwt
from fastapi import FastAPI, APIRouter, HTTPException, Request, Depends, Response, Query, BackgroundTasks
from fastapi.responses import RedirectResponse, Response as FastAPIResponse
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
    status: Literal["verified", "risky", "invalid"] = "risky"
    confidence: Optional[int] = None
    source: Optional[str] = None  # website / hunter / manual


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
    status: Literal["verified", "risky", "invalid"] = "risky"


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
    return {
        "user": {
            "id": user["id"], "name": user["name"], "email": user["email"],
            "role": user["role"], "tenant_id": user["tenant_id"],
            "permissions": perms,
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
    rows = await db.sub_companies.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("name", 1).to_list(200)
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


@api.get("/prospects/calendar")
async def prospects_calendar(
    user: dict = Depends(get_current_user),
    year: int = Query(...),
    month: int = Query(..., ge=1, le=12),
):
    """Per-day aggregates for a month: prospects_added, emails_sent, emails_scheduled."""
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
    res = await db.email_sends.update_one(
        {"id": send_id, "tenant_id": user["tenant_id"], "status": {"$in": ["queued", "scheduled"]}},
        {"$set": {"status": "cancelled", "cancelled_at": now_iso()}},
    )
    if not res.matched_count:
        raise HTTPException(404, "Not found or already processed")
    return {"ok": True}


# ─── Outreach Tasks (workflow) ───
async def _task_view(t: dict) -> dict:
    t.pop("_id", None)
    pids = t.get("prospect_ids") or []
    t["prospect_count"] = len(pids)
    return t


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
    for r in rows:
        r["prospect_count"] = len(r.get("prospect_ids") or [])
    return rows


@api.post("/tasks")
async def create_task(payload: OutreachTaskCreate, user: dict = Depends(get_current_user)):
    try:
        datetime.strptime(payload.date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(400, "Invalid date, use YYYY-MM-DD")
    # Resolve target from user's daily_target if not provided
    target = payload.target
    if not target:
        u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "daily_target": 1}) or {}
        target = u.get("daily_target") or 0
    if not target or target < 1:
        raise HTTPException(400, "Target harian belum di-set. Atur di Settings → Target Harian dulu.")
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
            result = await asyncio.to_thread(
                send_smtp_email,
                smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                bool(smtp_src.get("smtp_use_tls", True)),
                from_email, from_name, s["to_email"], s["subject"], tracked,
                body_type, atts, unsubscribe_url, from_email,
            )
            if result["ok"]:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                if s.get("prospect_id"):
                    await _log_activity(s["prospect_id"], user["tenant_id"], "email_sent", user["id"], {"to": s["to_email"], "send_id": s["id"], "task_id": tid})
                    await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                                   {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
            else:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "bounce", "bounced": True, "error": result["error"]}})
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
    limit: int = 20,
    unread_only: bool = False,
    user: dict = Depends(get_current_user),
):
    """Fetch latest emails from IMAP for a sub-company. folder=INBOX|Sent|Trash"""
    if folder not in FOLDER_KEYS:
        raise HTTPException(400, "folder harus salah satu: INBOX, Sent, Trash")
    sc = await _check_inbox_access(sc_id, user)

    def _fetch():
        import email
        try:
            with _imap_connect(sc) as m:
                mailbox = _resolve_folder(m, folder)
                typ, _ = m.select(mailbox, readonly=True)
                if typ != "OK":
                    return {"_error": f"Folder tidak ditemukan: {mailbox}"}
                criteria = "(UNSEEN)" if unread_only else "ALL"
                typ, data = m.search(None, criteria)
                if typ != "OK" or not data or not data[0]:
                    return {"mailbox": mailbox, "messages": []}
                ids = data[0].split()[-limit:][::-1]
                items = []
                for mid in ids:
                    typ, msg_data = m.fetch(mid, "(BODY.PEEK[HEADER] FLAGS)")
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
                    items.append({
                        "uid": mid.decode(),
                        "from": _decode_hdr(msg.get("From", "")),
                        "to": _decode_hdr(msg.get("To", "")),
                        "subject": _decode_hdr(msg.get("Subject", "")) or "(no subject)",
                        "date": msg.get("Date", ""),
                        "message_id": msg.get("Message-ID", ""),
                        "unread": "\\Seen" not in flags_str,
                    })
                return {"mailbox": mailbox, "messages": items}
        except Exception as e:
            return {"_error": _format_imap_error(e)}

    result = await asyncio.to_thread(_fetch)
    if isinstance(result, dict) and "_error" in result:
        raise HTTPException(400, f"IMAP error: {result['_error']}")
    return {
        "sub_company_id": sc_id,
        "sub_company_name": sc["name"],
        "folder": folder,
        "mailbox": result["mailbox"],
        "count": len(result["messages"]),
        "messages": result["messages"],
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
    result = await run_hunter_workflow(domain, aliases=aliases)
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
        result = await asyncio.to_thread(
            send_smtp_email,
            smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
            smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
            bool(smtp_src.get("smtp_use_tls", True)),
            from_email, from_name, payload.to_email, subject, tracked,
            body_type, atts, unsubscribe_url, from_email,
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
            await db.email_sends.update_one({"id": send_id}, {"$set": {"status": "bounce", "bounced": True, "error": result["error"]}})
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
            result = await asyncio.to_thread(
                send_smtp_email,
                smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                bool(smtp_src.get("smtp_use_tls", True)),
                from_email, from_name, s["to_email"], s["subject"], tracked,
                body_type, atts, unsubscribe_url, from_email,
            )
            if result["ok"]:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                await _log_activity(s["prospect_id"], user["tenant_id"], "email_sent", user["id"], {"to": s["to_email"], "send_id": s["id"]})
                await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                              {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
            else:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "bounce", "bounced": True, "error": result["error"]}})
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

    result = await asyncio.to_thread(
        send_smtp_email,
        smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
        smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
        bool(smtp_src.get("smtp_use_tls", True)),
        from_email, from_name, payload.to_email, subject, body,
        body_type, atts, None, from_email,
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
    rows = await db.email_templates.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
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
        res = await db.email_templates.update_one({"id": tid, "tenant_id": user["tenant_id"]}, {"$set": upd})
        if not res.matched_count:
            raise HTTPException(404, "Template not found")
    row = await db.email_templates.find_one({"id": tid}, {"_id": 0})
    if row:
        await _attach_template_attachments([row])
    return row


@api.delete("/templates/{tid}")
async def delete_template(tid: str, user: dict = Depends(get_current_user)):
    res = await db.email_templates.delete_one({"id": tid, "tenant_id": user["tenant_id"]})
    if res.deleted_count:
        await db.template_attachments.delete_many({"template_id": tid, "tenant_id": user["tenant_id"]})
    return {"deleted": res.deleted_count}


@api.post("/templates/{tid}/duplicate")
async def duplicate_template(tid: str, user: dict = Depends(get_current_user)):
    src = await db.email_templates.find_one({"id": tid, "tenant_id": user["tenant_id"]})
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
    tpl = await db.email_templates.find_one({"id": tid, "tenant_id": user["tenant_id"]})
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
    tpl = await db.email_templates.find_one({"id": tid, "tenant_id": user["tenant_id"]})
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
    if status: q["status"] = status
    if prospect_id: q["prospect_id"] = prospect_id
    if sender_user_id: q["sender_user_id"] = sender_user_id
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
    for s in sends:
        s["prospect_name"] = pmap.get(s.get("prospect_id"), {}).get("company_name")
        s["sender_name"] = umap.get(s.get("sender_user_id"), {}).get("name")
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
@api.patch("/me/target")
async def set_my_daily_target(payload: DailyTargetUpdate, user: dict = Depends(get_current_user)):
    await db.users.update_one({"id": user["id"]}, {"$set": {"daily_target": payload.daily_target, "updated_at": now_iso()}})
    return {"daily_target": payload.daily_target}


@api.patch("/team/{uid}/target")
async def set_team_member_target(uid: str, payload: DailyTargetUpdate, user: dict = Depends(get_current_user)):
    perms = await get_user_permissions(user)
    if user["role"] != "Owner" and "set_team_targets" not in perms:
        raise HTTPException(403, "Missing permission: set_team_targets")
    res = await db.users.update_one({"id": uid, "tenant_id": user["tenant_id"]}, {"$set": {"daily_target": payload.daily_target, "updated_at": now_iso()}})
    if not res.matched_count:
        raise HTTPException(404, "User not found")
    return {"daily_target": payload.daily_target}


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
    }


@api.get("/")
async def root():
    return {"name": "Lead Hunter CRM API", "ok": True, "version": "2.0-crm"}






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
            for idx, s in enumerate(due):
                # Mark as 'sending' first to prevent another worker tick from picking it up
                claim = await db.email_sends.update_one(
                    {"id": s["id"], "status": "scheduled"},
                    {"$set": {"status": "sending"}},
                )
                if claim.modified_count == 0:
                    continue  # already claimed by previous tick
                # Resolve SMTP per send
                tenant = await db.tenants.find_one({"id": s["tenant_id"]}) or {}
                sender = await db.users.find_one({"id": s["sender_user_id"]})
                smtp_src = None
                if s.get("sub_company_id"):
                    sc = await db.sub_companies.find_one({"id": s["sub_company_id"], "tenant_id": s["tenant_id"]})
                    if sc and sc.get("smtp_host"): smtp_src = sc
                if smtp_src is None and sender and sender.get("smtp_use_company") is False and sender.get("smtp_host"):
                    smtp_src = sender
                if smtp_src is None and tenant.get("smtp_host"):
                    smtp_src = tenant
                if not smtp_src:
                    await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "bounce", "bounced": True, "error": "SMTP not configured at send-time"}})
                    continue
                from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
                from_name  = smtp_src.get("smtp_from_name")
                body_type, atts = await _load_template_extras(s["tenant_id"], s.get("template_id"))
                if body_type == "html":
                    tracked = inject_tracking(s["body_html"], s["id"], PUBLIC_BASE_URL or "")
                else:
                    tracked = s["body_html"]
                unsubscribe_url = f"{PUBLIC_BASE_URL}/api/track/unsubscribe/{s['id']}" if PUBLIC_BASE_URL else None
                result = await asyncio.to_thread(
                    send_smtp_email,
                    smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                    smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                    bool(smtp_src.get("smtp_use_tls", True)),
                    from_email, from_name, s["to_email"], s["subject"], tracked,
                    body_type, atts, unsubscribe_url, from_email,
                )
                if result["ok"]:
                    await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                    if s.get("prospect_id"):
                        await _log_activity(s["prospect_id"], s["tenant_id"], "email_sent", s["sender_user_id"],
                                            {"to": s["to_email"], "send_id": s["id"], "scheduled": True})
                        await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                                       {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
                else:
                    await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "bounce", "bounced": True, "error": result["error"]}})
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
        logger.info("Scheduled-email worker started (60s poll)")
