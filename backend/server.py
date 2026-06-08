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
    role: Optional[Literal["Owner", "Admin", "Staff"]] = None
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


class RoleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    permissions: List[str] = []


class RoleUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=40)
    permissions: Optional[List[str]] = None


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class LocationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class MyLeadAdd(BaseModel):
    company_id: str
    contact_ids: List[str] = Field(min_length=1)
    category_id: Optional[str] = None
    location_id: Optional[str] = None
    notes: Optional[str] = None


class SubCompanyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    legal_name: Optional[str] = ""
    phone: Optional[str] = ""
    smtp_host: Optional[str] = None
    smtp_port: Optional[int] = 587
    smtp_user: Optional[str] = None
    smtp_password: Optional[str] = None
    smtp_use_tls: Optional[bool] = True
    smtp_from_email: Optional[EmailStr] = None
    smtp_from_name: Optional[str] = None


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
    status: Optional[Literal["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"]] = None


class ProspectEmailAdd(BaseModel):
    email: EmailStr
    is_primary: bool = False
    status: Literal["verified", "risky", "invalid"] = "risky"


class TemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    subject: str
    body_html: str


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    subject: Optional[str] = None
    body_html: Optional[str] = None


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


# ─── Permission catalog (frontend uses these keys to filter menus) ───
ALL_PERMISSIONS = [
    {"key": "dashboard",          "label": "View Dashboard",                    "menu": True},
    {"key": "prospects",          "label": "Prospects (CRM)",                   "menu": True},
    {"key": "email_activity",     "label": "Email Activity tracker",            "menu": True},
    {"key": "templates",          "label": "Email Templates",                   "menu": True},
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
            "dashboard", "prospects", "email_activity", "templates", "settings",
            "manage_users", "manage_company", "manage_api_keys",
            "delete_prospects", "send_emails", "set_team_targets", "bypass_daily_lock",
        ],
    },
    {
        "name": "Staff",
        "is_system": True,
        "permissions": [
            "dashboard", "prospects", "email_activity", "templates", "send_emails",
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
        "created_by": user["id"],
        "created_at": now_iso(),
    }
    await db.categories.insert_one(doc)
    doc.pop("_id", None)
    return doc


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
            if user["role"] != "Owner":
                raise HTTPException(403, "Only Owner can change role")
            # Validate role exists
            role_doc = await db.roles.find_one({"tenant_id": user["tenant_id"], "name": v})
            if not role_doc:
                raise HTTPException(400, f"Role '{v}' does not exist")
            if target["role"] == "Owner" and v != "Owner":
                owner_count = await db.users.count_documents({"tenant_id": user["tenant_id"], "role": "Owner"})
                if owner_count <= 1:
                    raise HTTPException(400, "Cannot demote the last Owner")
            upd["role"] = v
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
            "logs": logs + ["> Using cached result. Saving to tenant DB..."],
            "steps": steps + [
                {"name": "Playwright Deep Crawl", "status": "skip"},
                {"name": "Hunter.io Domain Search [MOCK]", "status": "skip"},
                {"name": "Data Merge", "status": "skip"},
                {"name": "Confidence Scoring", "status": "skip"},
            ],
            "company": cached["company"],
            "contacts": cached["contacts"],
        }
    else:
        logs.append("  > Cache MISS or refresh forced. Running full workflow...")
        steps.append({"name": "Global DB Check", "status": "miss"})
        result = await run_hunter_workflow(domain)
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
    rows = await db.searches.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("created_at", -1).to_list(limit)
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
            await asyncio.sleep(0.3)  # gentle throttle
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
    prospects_today = await db.prospects.count_documents({
        "tenant_id": user["tenant_id"], "assigned_user_id": user["id"],
        "created_at": {"$gte": today.isoformat(), "$lt": tomorrow.isoformat()},
    })
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


@api.get("/prospects/quota")
async def get_quota(user: dict = Depends(get_current_user)):
    state = await _quota_state(user)
    state["can_bypass"] = await _can_bypass_lock(user)
    return state


@api.get("/prospects/today")
async def list_today_prospects(user: dict = Depends(get_current_user)):
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    tomorrow = today + timedelta(days=1)
    rows = await db.prospects.find({
        "tenant_id": user["tenant_id"],
        "assigned_user_id": user["id"],
        "created_at": {"$gte": today.isoformat(), "$lt": tomorrow.isoformat()},
    }, {"_id": 0}).sort("created_at", -1).to_list(500)
    return rows


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
                "emails": [
                    {
                        "email": c["email"], "name": c.get("name"), "job_title": c.get("job_title"),
                        "source": c.get("source"), "confidence": c.get("confidence_score", 50),
                        "status": "verified" if c.get("confidence_score", 0) >= 80 else "risky",
                    } for c in cached["contacts"]
                ],
                "cached": True, "age_days": age_days,
            }
    result = await run_hunter_workflow(domain)
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
        "emails": [
            {
                "email": c["email"], "name": c.get("name"), "job_title": c.get("job_title"),
                "source": c.get("source"), "confidence": c.get("confidence_score", 50),
                "status": "verified" if c.get("confidence_score", 0) >= 80 else "risky",
            } for c in result["contacts"]
        ],
        "cached": False,
    }


@api.get("/prospects")
async def list_prospects(
    user: dict = Depends(get_current_user),
    status: Optional[str] = None,
    assigned_user_id: Optional[str] = None,
    q: Optional[str] = None,
    sub_company_id: Optional[str] = None,
):
    qdoc: dict = {"tenant_id": user["tenant_id"]}
    if status: qdoc["status"] = status
    if assigned_user_id: qdoc["assigned_user_id"] = assigned_user_id
    if sub_company_id: qdoc["sub_company_id"] = sub_company_id
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
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]}, {"_id": 0})
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
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]})
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
    res = await db.prospects.delete_one({"id": pid, "tenant_id": user["tenant_id"]})
    if res.deleted_count:
        await db.prospect_activity.delete_many({"prospect_id": pid})
        await db.email_sends.delete_many({"prospect_id": pid})
    return {"deleted": res.deleted_count}


@api.post("/prospects/{pid}/emails")
async def add_prospect_email(pid: str, payload: ProspectEmailAdd, user: dict = Depends(get_current_user)):
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]})
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
    p = await db.prospects.find_one({"id": pid, "tenant_id": user["tenant_id"]})
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
    """SMTP priority: sub-company > user's own (if smtp_use_company=False) > tenant default."""
    if sub_company_id:
        sc = await db.sub_companies.find_one({"id": sub_company_id, "tenant_id": tenant_id})
        if sc and sc.get("smtp_host"):
            return sc
    if user_doc.get("smtp_use_company") is False and user_doc.get("smtp_host"):
        return user_doc
    tenant = await db.tenants.find_one({"id": tenant_id})
    if tenant and tenant.get("smtp_host"):
        return tenant
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
        from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
        from_name  = smtp_src.get("smtp_from_name")
        tracked = inject_tracking(body, send_id, PUBLIC_BASE_URL or "")
        result = await asyncio.to_thread(
            send_smtp_email,
            smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
            smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
            bool(smtp_src.get("smtp_use_tls", True)),
            from_email, from_name, payload.to_email, subject, tracked,
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
    smtp_src = await _resolve_smtp(user["tenant_id"], user, payload.sub_company_id)
    if not smtp_src:
        raise HTTPException(400, "SMTP not configured.")
    prospects = await db.prospects.find({"tenant_id": user["tenant_id"], "id": {"$in": payload.prospect_ids}}, {"_id": 0}).to_list(2000)
    queued = 0
    for p in prospects:
        primary = next((e for e in p.get("emails", []) if e.get("is_primary")), None) or (p.get("emails") or [{}])[0]
        to_email = primary.get("email")
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
            "scheduled_at": payload.scheduled_at,
            "status": "queued", "delivered": False, "opens": 0, "clicks": 0,
            "replied": False, "bounced": False, "error": None, "sent_at": None,
            "created_at": now_iso(),
        })
        queued += 1

    async def _runner_all():
        sends = await db.email_sends.find({"tenant_id": user["tenant_id"], "status": "queued",
                                            "sender_user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(queued)
        for s in sends[:queued]:
            from_email = smtp_src.get("smtp_from_email") or smtp_src.get("smtp_user") or "noreply@example.com"
            from_name  = smtp_src.get("smtp_from_name")
            tracked = inject_tracking(s["body_html"], s["id"], PUBLIC_BASE_URL or "")
            result = await asyncio.to_thread(
                send_smtp_email,
                smtp_src["smtp_host"], int(smtp_src.get("smtp_port") or 587),
                smtp_src.get("smtp_user") or "", smtp_src.get("smtp_password") or "",
                bool(smtp_src.get("smtp_use_tls", True)),
                from_email, from_name, s["to_email"], s["subject"], tracked,
            )
            if result["ok"]:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "delivered", "delivered": True, "sent_at": now_iso()}})
                await _log_activity(s["prospect_id"], user["tenant_id"], "email_sent", user["id"], {"to": s["to_email"], "send_id": s["id"]})
                await db.prospects.update_one({"id": s["prospect_id"], "status": "New"},
                                              {"$set": {"status": "Contacted", "last_activity_at": now_iso()}})
            else:
                await db.email_sends.update_one({"id": s["id"]}, {"$set": {"status": "bounce", "bounced": True, "error": result["error"]}})
            await asyncio.sleep(0.3)

    background.add_task(_runner_all)
    return {"queued": queued}


# ─── Email Templates ───
@api.get("/templates")
async def list_templates(user: dict = Depends(get_current_user)):
    rows = await db.email_templates.find({"tenant_id": user["tenant_id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return rows


@api.post("/templates")
async def create_template(payload: TemplateCreate, user: dict = Depends(get_current_user)):
    tid = str(uuid.uuid4())
    doc = {
        "id": tid, "tenant_id": user["tenant_id"],
        "name": payload.name, "subject": payload.subject, "body_html": payload.body_html,
        "created_by": user["id"], "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.email_templates.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api.patch("/templates/{tid}")
async def update_template(tid: str, payload: TemplateUpdate, user: dict = Depends(get_current_user)):
    upd = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    if upd:
        upd["updated_at"] = now_iso()
        res = await db.email_templates.update_one({"id": tid, "tenant_id": user["tenant_id"]}, {"$set": upd})
        if not res.matched_count:
            raise HTTPException(404, "Template not found")
    return await db.email_templates.find_one({"id": tid}, {"_id": 0})


@api.delete("/templates/{tid}")
async def delete_template(tid: str, user: dict = Depends(get_current_user)):
    res = await db.email_templates.delete_one({"id": tid, "tenant_id": user["tenant_id"]})
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
        "created_by": user["id"], "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.email_templates.insert_one(doc)
    doc.pop("_id", None)
    return doc


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
    client.close()
