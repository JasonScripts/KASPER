# QAKK — Mobilalkalmazás és Munkaidő-nyilvántartó Rendszer (PRD)

## Original Problem Statement
Fully automated, mobile-optimized fullscreen web app for worker check-in/check-out, work-time calculation and location tracking. Closed licensing (admin-managed workers, no self-registration), fast check-in with Danish time + GPS street, live admin dashboard (team status, street-grouped locations, recent shifts with 4-hour guarantee and manual override), anomaly alerts (location mismatch, 24h forgotten checkout), and automated monthly payroll reports on the 24th at 11:00 Danish time. Bilingual EN/DA.

## User Choices
- Built-in worker management (no Google Sheets); "sheet" data stored in app.
- Email not actually sent — logged only (Notification Log).
- Reverse geocoding via OpenStreetMap Nominatim (no key).
- Separate admin account (email+password), seeded from env.
- Danish translation authored in-app; UI default English with EN/DA toggle.

## Architecture
- Backend: FastAPI + MongoDB (motor). JWT Bearer auth (bcrypt). CORS wildcard (no cookies). Nominatim reverse geocode. Danish tz via zoneinfo.
- Frontend: React 19 + Tailwind + framer-motion + lucide + sonner. Bearer token in localStorage. LanguageContext (EN/DA). Routes: /login, / (worker mobile 100dvh), /admin (dashboard).
- Scheduling: .emergent/crons.yml — forgotten-checkout hourly, monthly-payroll 24th 11:00 Europe/Copenhagen. Endpoints secured by WEBHOOK_CRON_SECRET.

## User Personas
- Worker: logs in, checks in with event/client + GPS, checks out.
- Manager (admin): monitors live status, manages workers, overrides hours, force check-out, reviews notifications.

## Core Requirements (static)
1. Closed login (admin-managed). 2. Check-in with Danish time + GPS street. 3. Live dashboard (status dots, street groups, force check-out). 4. 4-hour guarantee. 5. Location mismatch + 24h forgotten-checkout alerts (logged). 6. Admin override / force check-out. 7. Monthly payroll (24th 11:00 CET) worker + company reports.

## Implemented (2026-06)
- JWT auth + admin seeding (jaki960119@gmail.hu). Worker CRUD (admin).
- Check-in/out with Nominatim geocoding; 4-hour rule; live elapsed timer.
- Admin: team-status, active-locations (street grouping), recent-shifts, force-checkout, edit-hours (audit log), notification log.
- EN/DA i18n across all screens.
- Cron endpoints + crons.yml (forgotten-checkout, monthly-payroll) verified.
- Tested: 15/15 backend pytest + full Playwright e2e — 100%.

## Backlog / Remaining
- P1: Real email delivery (Resend) when user is ready.
- P1: Google Sheets master-list sync (currently in-app).
- P2: Client site geofencing for smarter mismatch detection.
- P2: CSV/PDF export of monthly reports; historical reports archive.
- P2: Split server.py into modules (auth/shifts/admin/cron).

## Next Tasks
- Await user feedback; enable real email + exports on request.

## Update (2026-06) — Emails, Sheets sync, Report export
- Real email via Emergent-managed Resend: notify() sends + logs. Recipients — alerts: jjwolf232@gmail.com, payroll: tirak0720@icloud.com. Verified real deliveries (company + worker). from_name="QAKK Time Registration", guardrail gate enforced.
- Google Sheet master-list sync: POST /api/admin/sync-sheet reads public CSV export of GOOGLE_SHEET_ID (columns Name/Email/Password), upserts workers, deactivates workers missing from sheet. "Sync from Google Sheet" button in Manage Workers. NOTE: sheet must be shared "Anyone with the link → Viewer" (currently 401 until the user changes sharing).
- Report export: GET /api/admin/reports?fmt=csv_summary|csv_detailed|pdf&month=YYYY-MM (reportlab PDF). Toolbar with month picker + 3 buttons in Recent Shifts. Company summary + per-worker breakdown.
