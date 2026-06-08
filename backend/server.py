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


# ─── Permission catalog (frontend uses these keys to filter menus) ───
ALL_PERMISSIONS = [
    {"key": "dashboard",          "label": "View Dashboard",                    "menu": True},
    {"key": "hunter",             "label": "Hunter (lead discovery)",           "menu": True},
    {"key": "database",           "label": "Database (companies & contacts)",   "menu": True},
    {"key": "email_marketing",    "label": "Email Marketing (campaigns)",       "menu": True},
    {"key": "settings",           "label": "Settings page access",              "menu": True},
    {"key": "manage_users",       "label": "Add / edit / delete users",         "menu": False},
    {"key": "manage_roles",       "label": "Create / edit / delete roles",      "menu": False},
    {"key": "manage_company",     "label": "Edit company info & SMTP",          "menu": False},
    {"key": "manage_api_keys",    "label": "Edit Hunter.io API key",            "menu": False},
    {"key": "delete_records",     "label": "Delete companies / contacts",       "menu": False},
    {"key": "send_campaigns",     "label": "Send email campaigns",              "menu": False},
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
            "dashboard", "hunter", "database", "email_marketing", "settings",
            "manage_users", "manage_company", "manage_api_keys",
            "delete_records", "send_campaigns",
        ],
    },
    {
        "name": "Staff",
        "is_system": True,
        "permissions": [
            "dashboard", "hunter", "database", "email_marketing", "send_campaigns",
        ],
    },
]


async def ensure_tenant_roles(tenant_id: str):
    """Seed default roles if not exist (lazy/idempotent)."""
    existing = await db.roles.count_documents({"tenant_id": tenant_id})
    if existing == 0:
        for r in DEFAULT_ROLES:
            await db.roles.insert_one({
                "id": str(uuid.uuid4()),
                "tenant_id": tenant_id,
                "name": r["name"],
                "permissions": r["permissions"],
                "is_system": r["is_system"],
                "created_at": now_iso(),
            })


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
    contact_ids: List[str] = []
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
        "user": {"id": user_id, "name": payload.name, "email": email, "role": "Owner", "tenant_id": tenant_id},
        "tenant": {"id": tenant_id, "company_name": payload.company_name},
    }


@api.post("/auth/login")
async def login(payload: LoginReq, response: Response):
    email = payload.email.lower().strip()
    user = await db.users.find_one({"email": email})
    if not user or not verify_pw(payload.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    tenant = await db.tenants.find_one({"id": user["tenant_id"]})
    token = create_access_token(user["id"], user["tenant_id"], user["role"], email)
    response.set_cookie("access_token", token, httponly=True, samesite="lax", max_age=ACCESS_EXPIRE_MIN * 60, path="/")
    return {
        "token": token,
        "user": {"id": user["id"], "name": user["name"], "email": email, "role": user["role"], "tenant_id": user["tenant_id"]},
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
    if not tenant.get("smtp_host"):
        raise HTTPException(400, "SMTP not configured. Go to Settings.")

    # Resolve recipient list
    contact_ids = camp.get("contact_ids") or []
    if not contact_ids:
        # use filters
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

    if not contacts:
        raise HTTPException(400, "No recipients matched")

    # Create recipient rows
    recipient_ids = []
    for c in contacts:
        rid = str(uuid.uuid4())
        await db.campaign_recipients.insert_one({
            "id": rid,
            "campaign_id": campaign_id,
            "tenant_id": user["tenant_id"],
            "contact_id": c["id"],
            "email": c["email"],
            "name": c.get("name"),
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

    # Resolve SMTP source: per-user override OR tenant default
    sender_user = await db.users.find_one({"id": camp.get("created_by")}) if camp.get("created_by") else None
    if sender_user and sender_user.get("smtp_use_company") is False and sender_user.get("smtp_host"):
        smtp_src = sender_user
    else:
        smtp_src = tenant

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
@api.get("/")
async def root():
    return {"name": "Lead Hunter API", "ok": True, "version": "1.0"}


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
