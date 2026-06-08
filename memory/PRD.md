# PRD — Lead Hunter & Email Marketing Platform

## Original Problem Statement
Multi-tenant SaaS for lead generation and email marketing. Five modules: Dashboard, Hunter, Database, Email Marketing, Settings. Multi-tenant isolation via `tenant_id`. Multi-company hierarchy (sub-companies under one tenant with their own SMTP). Role-based access. Domain → company contact discovery with 7-step pipeline (Global Cache → Playwright Deep Crawl → Hunter.io → Merge → Dedupe → Confidence Scoring → Save).

User language: **Bahasa Indonesia** (respond in Indonesian).

## User Choices (verbatim)
- Auth: **JWT custom** (signup auto-creates tenant + Owner)
- Hunter.io: **MOCK** first, real API key swap-in via Settings
- Crawl engine: **Playwright real** (deep crawl)
- Email: **SMTP custom per sub-company** (or fallback tenant SMTP)
- Tracking: **Built-in** pixel + click-redirect
- Design: **Light SaaS aesthetic** (Indigo/Slate) — moved away from dark terminal theme per user request

## Architecture
- **Backend**: FastAPI + Motor + bcrypt + PyJWT + Playwright + smtplib (async)
- **Frontend**: React 19 + React Router 7 + Tailwind + Phosphor Icons + Sonner + Shadcn
- **DB**: MongoDB 7
- **Routing**: /api prefix; frontend SPA at /, /login, /register, /hunter, /database, /email, /settings
- **Infra**: Contabo VPS, Nginx, Let's Encrypt, Supervisor, auto-deploy bash script

## Core Requirements
1. Multi-tenant isolation via tenant_id from JWT
2. Sub-companies under one tenant, each with own SMTP + assigned users
3. Global hunter cache (cross-tenant) keyed by domain (<30d reuse)
4. 7-step Hunter pipeline with live UI feedback
5. Role-based access control (Owner / Admin / Staff + custom roles)
6. Email campaigns: pick sub-company SMTP, pick recipient source (my_leads / contacts / manual), tracking
7. Personal "My Leads" list per user

## Implemented (Feb 2026)

| Area | Status |
|---|---|
| JWT Auth (register / login / me / logout) | ✅ Tested |
| Multi-tenant isolation | ✅ Tested |
| Hunter single + bulk search (Playwright + mock Hunter.io) | ✅ Tested |
| Global hunter cache (30d) | ✅ Tested |
| Companies / Contacts CRUD | ✅ Tested |
| Sub-Companies CRUD + per-sub-company SMTP | ✅ Tested |
| Roles & Permissions (system + custom) | ✅ Tested |
| Categories & Locations | ✅ Tested |
| My Leads (private per-user list) | ✅ Tested |
| Light-mode SaaS UI redesign | ✅ Tested |
| Settings modal overlay (scroll fix) | ✅ Fixed Feb 2026 |
| Email Marketing 3-step Builder | ✅ NEW Feb 2026 |
| ↳ Sub-company SMTP picker | ✅ Tested |
| ↳ Recipient source: my_leads / contacts / manual | ✅ Tested |
| ↳ Live preview + draft + send-now | ✅ Tested |
| ↳ Campaign preview modal with recipients table | ✅ Tested |
| Open / click tracking | ✅ Tested |
| Dashboard KPIs + trends + recent | ✅ Tested |
| Contabo VPS deploy script (`deploy`) | ✅ |

## Recent Changes (Feb 2026)
- **Settings modal overflow fix**: ModalShell rewritten to use `overflow-y-auto` on outer fixed overlay + `min-h-full flex items-start sm:items-center` wrapper. Modal headers/footers reachable at all viewport sizes including 1366x768.
- **Email Marketing rebuild**: replaced old single-form builder with 3-step wizard (Sender & Source → Recipients → Compose & Send). Added sub_company SMTP picker and recipient source switcher (my_leads, master contacts, manual emails). Added campaign Preview modal. Backend `CampaignCreate` extended with `sub_company_id`, `recipient_source`, `my_lead_ids`, `manual_emails`; backward compatible with `contact_ids`. SMTP resolution priority: sub-company > tenant.

## Prioritized Backlog

### P1
- Real Hunter.io API integration (swap mock when user supplies key in Settings → Hunter.io API)
- Email body WYSIWYG (currently raw HTML textarea — works fine but plain)
- Lead Export to CSV (My Leads + Master Database)
- Per-user statistics on Dashboard (leads saved by each team member)

### P2
- Email templates library + `{{variable}}` substitution per recipient
- Unsubscribe link auto-injection + suppression list
- Campaign scheduling (`schedule_at` field exists in model but no scheduler yet)
- Pagination meta on /api/companies and /api/contacts
- Forgot-password flow
- Webhook receiver for SMTP bounces
- Custom tracking domains
- WebSocket streaming for Hunter pipeline (currently 2s polling)
- Refactor backend/server.py (now ~1495 lines) into routers (auth, hunter, campaigns, sub_companies, team)

## Auth credentials
See `/app/memory/test_credentials.md`. Active demo: `demo@test.com / demo1234`.

## Deployment Workflow
After code changes verified: user clicks "Save to GitHub" in Emergent UI, then SSHs into Contabo VPS and runs `deploy` to pull & restart.
