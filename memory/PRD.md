# PRD — Lead Hunter & Email Marketing Platform

## Original Problem Statement
Multi-tenant SaaS for lead generation and email marketing. Five modules: Dashboard, Hunter, Database, Email Marketing, Settings. Multi-tenant isolation via `tenant_id`. Role-based: Owner / Admin / Staff. Domain → company contact discovery with 7-step pipeline (Global Cache → Playwright Deep Crawl → Hunter.io → Merge → Dedupe → Confidence Scoring → Save).

## User Choices (verbatim)
- Auth: **JWT custom** (signup auto-creates tenant + Owner)
- Hunter.io: **MOCK** first, real API key swap-in via Settings
- Crawl engine: **Playwright real** (deep crawl: homepage, /contact, /about, /team, /careers, etc.)
- Email: **SMTP custom per-tenant** (input host/port/user/pass in Settings)
- Tracking: **Built-in** (1×1 pixel `/api/track/open/{id}` + redirect `/api/track/click/{id}`)
- Design: **Dark-mode terminal-green** hacker aesthetic ("Hunter" theme)

## Architecture
- **Backend**: FastAPI + Motor (MongoDB async) + bcrypt + PyJWT + Playwright + BeautifulSoup + smtplib (async via `asyncio.to_thread`)
- **Frontend**: React 19 + React Router 7 + TailwindCSS 3 + Phosphor Icons + Recharts + Sonner toasts + Shadcn primitives
- **DB**: MongoDB 7, collections: `tenants`, `users`, `companies`, `contacts`, `campaigns`, `campaign_recipients`, `searches`, `bulk_jobs`, `global_hunter_cache`
- **Routing**: All API under `/api/*`. Frontend SPA at `/`, `/login`, `/register`, `/hunter`, `/database`, `/email`, `/settings`

## User Personas
1. **Owner**: founder of small B2B agency — full access, manages SMTP, billing-like Hunter API key, invites staff
2. **Admin**: sales-ops manager — runs hunts, manages DB, creates campaigns, configures SMTP (cannot delete users)
3. **Staff**: SDR — uses Hunter, sees own contacts, sends own campaigns

## Core Requirements (static)
1. Multi-tenant data isolation enforced on EVERY query via `tenant_id` from JWT
2. Global hunter cache (cross-tenant) keyed by domain to reduce Hunter API costs (<30d reuse)
3. 7-step Hunter pipeline with live terminal-style log visualization in UI
4. Per-tenant SMTP config — no global default sender
5. Open/click tracking via injected pixel + URL rewrite at send time
6. Unique constraints: `(tenant_id, domain)` companies; `(tenant_id, email)` contacts
7. Confidence scoring: website=100, hunter_conf>=90 → 95, >=80 → 85, else 70

## Implemented (Jan 2026)
| Area | Status | Notes |
|---|---|---|
| Auth: register/login/logout/me | ✅ Tested | JWT 24h, bcrypt, httpOnly cookie + Bearer |
| Multi-tenant isolation | ✅ Tested | Verified cross-tenant invisibility |
| Hunter single search | ✅ Tested | Playwright real crawl + mock Hunter.io merge |
| Hunter cache (30d) | ✅ Tested | 2nd search → status='hit' |
| Hunter bulk (async background) | ✅ Tested | BackgroundTask + polling endpoint |
| CSV import | ✅ Working | Client-side parse → bulk input |
| Companies CRUD | ✅ Tested | With contact_count attached |
| Contacts CRUD + filters | ✅ Tested | Joined with company industry/country |
| Campaigns CRUD + metrics | ✅ Tested | Aggregated open/click/bounce per campaign |
| Campaign send (SMTP) | ✅ Tested | Returns 400 if SMTP not configured |
| Open/click tracking | ✅ Tested | Pixel GIF + 302 redirect |
| Team management | ✅ Tested | Owner-only delete, RBAC enforced |
| Settings: SMTP + Hunter API key | ✅ Tested | Owner/Admin only |
| Dashboard: 8 KPIs + 2 trend charts + 3 recent lists | ✅ Tested | 14-day rolling window |
| RBAC enforcement | ✅ Tested | Staff blocked from settings (403) |
| UI: dark terminal-green theme | ✅ | Chivo + JetBrains Mono fonts, scanlines, blinking cursor, step-active glow |
| 7-step pipeline visualizer | ✅ | Live status per step + terminal log scroll |

## Bug fixes during testing
- POST /api/team returned 500 due to ObjectId leak — fixed with `pop('_id')` after insert

## Prioritized Backlog (P0/P1/P2)

### P0 — None remaining (MVP complete)

### P1
- Swap Hunter.io mock with real API call when user adds key in Settings (read `tenant.hunter_api_key`, call `https://api.hunter.io/v2/domain-search?domain=X&api_key=Y`)
- Pagination meta on `/api/companies` and `/api/contacts` (currently single array, limit 200/500)
- Forgot-password flow (token email + reset)
- Campaign scheduling (currently `send_now=true` only)
- Email body WYSIWYG editor (currently raw HTML textarea)

### P2
- Email templates library + variables (`{{name}}` placeholders)
- Unsubscribe link auto-injection + suppression list
- Webhook receiver for SMTP bounce notifications
- Custom domains for tracking links (instead of preview URL)
- Pricing tiers + Stripe subscriptions
- Analytics export (PDF/CSV per campaign)
- Real-time Hunter pipeline streaming via WebSocket (current: poll bulk job every 2s)
- Email reply detection via IMAP

## Next Tasks
- Wait for user feedback on UI/UX
- Add real Hunter.io API integration when user provides key
- Production deployment to Contabo (tutorial in `/app/tutorial/`)
