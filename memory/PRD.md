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
- **Templates UX overhaul (Phase 3, Feb 2026)**: Added `body_type` field (`html`|`plain`) to templates with toggle in UI, integrated **ReactQuill** WYSIWYG editor for HTML mode. Built template **attachment system** — files stored as base64 in MongoDB (`template_attachments` collection), max 8MB/file and 20MB/template. Endpoints: `POST /api/templates/{tid}/attachments` (multipart upload), `DELETE /api/templates/{tid}/attachments/{att_id}`, `GET /api/templates/{tid}/attachments/{att_id}/download`. Duplicate cascades attachments; delete cascades cleanup. Email sending in all paths (bulk, single, outreach task, scheduled worker) now auto-loads template `body_type` and `attachments` and sends with proper MIME `multipart/mixed` + `multipart/alternative` structure.
- **Anti-spam email service rewrite (Feb 2026)**: `send_smtp_email` now sets `Message-ID` (with sender's domain), `Date`, `MIME-Version`, `X-Mailer`, `Reply-To`, `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` headers. HTML bodies are wrapped with proper `<!DOCTYPE html><html><head>…</head><body>…</body></html>` if not already wrapped. Plain-text fallback (`multipart/alternative`) is always generated from HTML. Attachments use `multipart/mixed` with base64 transfer encoding. Tracking pixel only injected for HTML body_type (plain text doesn't get `<img>` tags).
- **Inbox Module Phase 2 (Feb 2026)**: Folder support (INBOX/Sent/Trash) with dynamic resolution via IMAP SPECIAL-USE flags + common-name fallback. Endpoints: `GET /api/inbox/{sc_id}?folder=…&limit=20`, `GET /api/inbox/{sc_id}/message/{uid}` (returns full body + auto-marks Seen), `POST /api/inbox/{sc_id}/mark`, `POST /api/inbox/{sc_id}/reply` (proper `In-Reply-To` + `References` threading + APPEND to Sent folder).
- **Settings modal overflow fix**: ModalShell rewritten to use `overflow-y-auto` on outer fixed overlay + `min-h-full flex items-start` wrapper. Modal headers/footers reachable at all viewport sizes including 1366x768.

## Prioritized Backlog

### Recently Completed (Feb 2026)
- **Inline Image Auto-Resize/Optimize** (Feb 22, 2026) — Backend `_optimize_inline_image()` (Pillow): downsize ke max 800px sisi terpanjang + recompress (JPEG quality 85, PNG dengan optimize=True, alpha preserved jika ada). EXIF orientation respected (foto HP otomatis tegak). GIF di-skip (preserve animation). Result: 3.2MB JPEG → 169KB (-94.8%). Safety fallback: tidak menggantikan kalau hasil lebih besar tanpa resize. Frontend toast tampilkan reduction percentage saat sukses.
- **Inline Image Upload in Email Body (Signature)** (Feb 22, 2026) — User dapat upload gambar (max 5MB: png/jpg/gif/webp) langsung dari toolbar Quill editor di OutreachModal, EmailStep, dan Templates page. Backend endpoint: `POST /api/uploads/inline-image` simpan base64 di MongoDB `inline_images`, return URL publik (`/api/inline-images/{id}.{ext}`). Saat email dikirim, helper `_extract_inline_images_for_send()` parse `<img src>` lalu konversi ke `cid:img-{id}` + attach sebagai MIME multipart/related inline parts → gambar otomatis tampil di Gmail/Outlook/Apple Mail tanpa download manual (RFC2392 standard).
- **Dashboard Team Performance (P1)** (Feb 21, 2026) — `/dashboard/daily` now returns `team_breakdown` for Owner/Admin/Manager: per-user leaderboard with prospects_today, quota_pct progress bar, emails sent today, total prospects, interested, customers won, replies. Sorted by prospects_today desc with trophy icon on #1. Staff sees own stats only (empty leaderboard). Highlighted "you" row in indigo. Quota bar color: red <50%, amber <100%, emerald 100%.
- **Per-user Templates scope** (Feb 21, 2026) — `/templates` endpoint + update/delete/duplicate/attachments now filter by `created_by == user.id`. Each user only sees & manages templates they personally created.
- **Per-user Sub-companies scope** (Feb 21, 2026) — `/sub-companies` endpoint now filters by user's `sub_company_ids`. Staff users only see their assigned company's SMTP. Owner/Admin (manage_company perm) still see all in tenant.
- **Outreach Modal refresh button** (Feb 21, 2026) — Added explicit "Refresh" button next to Template dropdown + auto-refresh on window focus. Both OutreachModal (Prospects bulk) and EmailStep (Tab 3 task submit) include this. Warning banner shown when user has no templates yet.
- Category-based dynamic alias injection (backend + Settings UI) — DONE
- Required category dropdown before domain search on Add Prospect tab — DONE
- Added Today sidebar isolated per active task (no stale prospects from submitted tasks) — DONE
- OutreachModal: Mode toggle Kirim Sekarang vs Jadwalkan with date+time picker — DONE
- Backend defensive validation: `scheduled_at` past-date rejected with 400 — DONE
- **Hunter verifier polling for HTTP 202 pending status** — DONE (3 polls × 2s)
- **Website-sourced emails auto-marked `verified`** (published on official site = trustworthy) — DONE
- **Alias emails get accurate status** based on Hunter.io verifier (deliverable→verified, undeliverable→invalid, risky→risky, unknown→score-based) — DONE
- **Refresh button** on Prospects search result to bypass 30-day cache & re-verify — DONE

### P1
- Real Hunter.io API integration (swap mock when user supplies key in Settings → Hunter.io API) — DONE (real API + Playwright deep crawl)
- Email body WYSIWYG (currently raw HTML textarea — works fine but plain) — DONE (ReactQuill)
- Audit log untuk aksi user (login, send email, add prospect)
- AES encryption untuk SMTP/IMAP password di MongoDB
- Lead Export to CSV (My Leads + Master Database)
- Per-user statistics on Dashboard (leads saved by each team member) — DONE (Feb 21, 2026 — Team Performance leaderboard)

### P2
- Email templates library + `{{variable}}` substitution per recipient — DONE
- Unsubscribe link auto-injection + suppression list — DONE
- Forgot-password flow
- Webhook receiver for SMTP bounces
- Custom tracking domains
- WebSocket streaming for Hunter pipeline (currently 2s polling)
- Refactor backend/server.py (>3600 lines) into routers (auth, hunter, prospects, email, inbox)

## Auth credentials
See `/app/memory/test_credentials.md`. Active demo: `demo@test.com / demo1234`.

## Deployment Workflow
After code changes verified: user clicks "Save to GitHub" in Emergent UI, then SSHs into Contabo VPS and runs `deploy` to pull & restart.
