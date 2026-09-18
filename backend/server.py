from dotenv import load_dotenv
from pathlib import Path
import os

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

from fastapi import FastAPI, APIRouter, HTTPException, Request, Response, Depends, Header, Query
from fastapi.responses import Response as FastResponse
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import logging
from pydantic import BaseModel, Field, EmailStr, BeforeValidator
from typing import List, Optional, Annotated, Any
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from bson import ObjectId
import bcrypt
import jwt
import asyncio
import math
import secrets
import requests
import httpx
import csv
import io
import re
import ipaddress
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Config & DB
# ---------------------------------------------------------------------------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_ALGORITHM = "HS256"
DK_TZ = ZoneInfo("Europe/Copenhagen")
FOUR_HOUR_MINUTES = 240

# Emergent managed email proxy (constant — never read from env so it survives deploy)
EMAIL_BASE_URL = "https://integrations.emergentagent.com"
EMAIL_KEY = os.environ.get("EMERGENT_EMAIL_KEY")
EMAIL_FROM_NAME = os.environ.get("EMAIL_FROM_NAME", "QAKK Time Registration")
EMAIL_REPLY_TO = os.environ.get("EMAIL_REPLY_TO")
GOOGLE_SHEET_ID = os.environ.get("GOOGLE_SHEET_ID")
GOOGLE_SA_FILE = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE", str(ROOT_DIR / "service_account.json"))

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("qakk")

app = FastAPI()
api_router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
PyObjectId = Annotated[str, BeforeValidator(str)]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def get_jwt_secret() -> str:
    return os.environ["JWT_SECRET"]


def create_access_token(user_id: str, email: str, role: str) -> str:
    payload = {
        "sub": user_id, "email": email, "role": role,
        "exp": now_utc() + timedelta(days=7), "type": "access",
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)


def dk_now_str(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(DK_TZ).strftime("%Y-%m-%d %H:%M:%S")


def parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def log_email(to: str, subject: str, body: str, category: str):
    """Build the log document persisted to db.email_log and shown in the admin UI."""
    logger.info("EMAIL [%s] -> %s | %s", category, to, subject)
    return {
        "to": to, "subject": subject, "body": body, "category": category,
        "created_at": now_utc().isoformat(),
    }


# --- Email guardrail gate (from Resend playbook — do not weaken) ----------------
_SHORTENERS = ("bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "goo.gl", "rebrand.ly")
_CRED_ASK = ("reply with your password", "reply with the code", "send your password", "cvv",
             "send us your password", "enter your password below", "confirm your card number",
             "your full card number", "seed phrase", "recovery phrase", "verify your card",
             "social security number", "confirm your bank details")
_HOSTISH = re.compile(r"\b(?:https?://)?((?:[a-z0-9-]+\.)+[a-z]{2,})", re.I)


def _host_ok(host: str) -> bool:
    if not host or "xn--" in host:
        return False
    try:
        ipaddress.ip_address(host)
        return False
    except ValueError:
        pass
    return not any(host == s or host.endswith("." + s) for s in _SHORTENERS)


def _same_site(shown: str, real: str) -> bool:
    return shown == real or real.endswith("." + shown) or shown.endswith("." + real)


class _EmailScan(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags, self.urls, self.anchors = set(), [], []
        self._href, self._text = None, []

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag.lower())
        self.urls += [v for k, v in attrs if k.lower() in ("href", "src") and v]
        if tag.lower() == "a":
            self._href = dict((k.lower(), v) for k, v in attrs).get("href")
            self._text = []

    def handle_data(self, data):
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "a" and self._href is not None:
            self.anchors.append((self._href, "".join(self._text)))
            self._href, self._text = None, []


def _assert_safe_email(subject: str, html: str) -> None:
    scan = _EmailScan(); scan.feed(html)
    if scan.tags & {"form", "input", "textarea", "select"}:
        raise ValueError("No forms or input fields in email (G2)")
    body = f"{subject}\n{html}".lower()
    for p in _CRED_ASK:
        if p in body:
            raise ValueError(f"Email asks the recipient for credentials: {p!r} (G2)")
    for url in scan.urls:
        low = url.strip().lower()
        if low.startswith(("mailto:", "tel:", "cid:", "#")):
            continue
        if not low.startswith("https://"):
            raise ValueError(f"Email links/assets must be absolute https: {url!r} (G3)")
        host = urlparse(low).hostname or ""
        if not _host_ok(host) or urlparse(low).username is not None:
            raise ValueError(f"Shortened, numeric-host or credential-bearing URL: {url!r} (G3)")
    for href, text in scan.anchors:
        real = urlparse(href.strip().lower()).hostname or ""
        if not real:
            continue
        for m in _HOSTISH.finditer(text):
            if not _same_site(m.group(1).lower(), real):
                raise ValueError(f"Anchor text {m.group(1)!r} ≠ real link host {real!r} (G3)")


def build_email_html(heading: str, text_body: str) -> str:
    safe_lines = "".join(f"<p style='margin:0 0 8px'>{escape(line)}</p>" if line.strip() else "<br/>"
                         for line in text_body.split("\n"))
    return (
        "<table role='presentation' width='100%' style='background:#0b0f19;padding:24px'>"
        "<tr><td align='center'>"
        "<table role='presentation' width='560' style='background:#111827;border-radius:12px;"
        "font-family:Arial,Helvetica,sans-serif;color:#f9fafb;overflow:hidden'>"
        "<tr><td style='background:#059669;padding:16px 24px;font-size:18px;font-weight:bold'>"
        f"{escape(EMAIL_FROM_NAME)}</td></tr>"
        f"<tr><td style='padding:24px'><h2 style='margin:0 0 16px;font-size:18px'>{escape(heading)}</h2>"
        f"<div style='font-size:14px;line-height:1.5;color:#d1d5db'>{safe_lines}</div></td></tr>"
        "<tr><td style='padding:16px 24px;border-top:1px solid #1f2937;font-size:12px;color:#6b7280'>"
        f"Sent automatically by {escape(EMAIL_FROM_NAME)}. We never ask for your password by email.</td></tr>"
        "</table></td></tr></table>"
    )


async def send_email(*, to: str, subject: str, html: str) -> Optional[str]:
    if not EMAIL_KEY:
        raise RuntimeError("EMERGENT_EMAIL_KEY not configured")
    _assert_safe_email(subject, html)
    payload = {"to": [to], "subject": subject, "html": html, "from_name": EMAIL_FROM_NAME}
    if EMAIL_REPLY_TO:
        payload["contact_email"] = EMAIL_REPLY_TO
    async with httpx.AsyncClient(timeout=30) as http_client:
        resp = await http_client.post(
            f"{EMAIL_BASE_URL}/api/v1/email/send",
            headers={"X-Email-Key": EMAIL_KEY},
            json=payload,
        )
    resp.raise_for_status()
    return resp.json().get("id")


async def notify(to: str, subject: str, text_body: str, category: str):
    """Send a real email via Resend AND persist it to the notification log."""
    doc = log_email(to, subject, text_body, category)
    sent_id, error = None, None
    try:
        sent_id = await send_email(to=to, subject=subject, html=build_email_html(subject, text_body))
    except Exception as e:
        error = str(e)
        logger.error("notify send failed for %s: %s", to, e)
    doc["sent"] = sent_id is not None
    doc["provider_id"] = sent_id
    if error:
        doc["error"] = error
    await db.email_log.insert_one(doc)
    return doc


# --- Google Sheet master-list sync ---------------------------------------------
async def _fetch_sheet_rows():
    if not GOOGLE_SHEET_ID:
        raise HTTPException(status_code=400, detail="No Google Sheet configured")
    url = f"https://docs.google.com/spreadsheets/d/{GOOGLE_SHEET_ID}/export?format=csv"

    def _get():
        r = requests.get(url, timeout=15)
        return r.status_code, r.text

    status, text = await asyncio.to_thread(_get)
    if status != 200 or text.lstrip().startswith("<!DOCTYPE"):
        raise HTTPException(
            status_code=400,
            detail="Cannot read the sheet. In Google Sheets set Share → 'Anyone with the link' → Viewer.",
        )
    return list(csv.DictReader(io.StringIO(text)))


# --- Monthly report data & export helpers --------------------------------------
def _period_bounds(month: Optional[str]):
    now = now_utc().astimezone(DK_TZ)
    if month:
        y, m = month.split("-")
        start = datetime(int(y), int(m), 1, tzinfo=DK_TZ)
    else:
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
    return start.astimezone(timezone.utc).isoformat(), end.astimezone(timezone.utc).isoformat(), start


async def _report_data(month: Optional[str]):
    s_iso, e_iso, start = _period_bounds(month)
    shifts = await db.shifts.find({
        "status": "closed",
        "checkout_time": {"$gte": s_iso, "$lt": e_iso},
    }).to_list(10000)
    groups: dict[str, dict] = {}
    for s in shifts:
        groups.setdefault(s["user_id"], {"user_id": s["user_id"], "name": s.get("user_name", "?"), "shifts": []})
        groups[s["user_id"]]["shifts"].append(s)
    result = []
    for uid, g in groups.items():
        g["shifts"].sort(key=lambda x: x["checkin_time"])
        g["total"] = round(sum(w.get("calculated_hours") or 0 for w in g["shifts"]), 2)
        worker = await db.users.find_one({"_id": ObjectId(uid)})
        g["email"] = worker["email"] if worker else None
        result.append(g)
    result.sort(key=lambda r: r["name"])
    return result, start.strftime("%B %Y"), start


def _csv_response(rows, filename):
    buf = io.StringIO()
    writer = csv.writer(buf)
    for r in rows:
        writer.writerow(r)
    return FastResponse(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _build_pdf(groups, label) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=18 * mm, bottomMargin=18 * mm)
    styles = getSampleStyleSheet()
    title = ParagraphStyle("t", parent=styles["Title"], textColor=colors.HexColor("#059669"))
    h2 = ParagraphStyle("h2", parent=styles["Heading2"], textColor=colors.HexColor("#111827"))
    elements = [Paragraph(f"QAKK Payroll Report — {label}", title), Spacer(1, 8)]

    summary = [["Worker", "Shifts", "Total Hours"]]
    grand = 0.0
    for g in groups:
        summary.append([g["name"], str(len(g["shifts"])), f"{g['total']:.2f}"])
        grand += g["total"]
    summary.append(["COMPANY TOTAL", "", f"{grand:.2f}"])
    st = Table(summary, colWidths=[90 * mm, 30 * mm, 40 * mm])
    st.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#059669")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BACKGROUND", (0, -1), (-1, -1), colors.HexColor("#e5e7eb")),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#9ca3af")),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#f3f4f6")]),
    ]))
    elements += [Paragraph("Company summary", h2), st, Spacer(1, 14)]

    for g in groups:
        elements.append(Paragraph(f"{g['name']} — {g['total']:.2f} h", h2))
        rows = [["Check-In (CET)", "Check-Out (CET)", "Location", "Client / Event", "Hours"]]
        for w in g["shifts"]:
            ci = dk_now_str(parse_iso(w["checkin_time"]))
            co = dk_now_str(parse_iso(w["checkout_time"])) if w.get("checkout_time") else ""
            rows.append([ci, co, (w.get("checkin_street") or "")[:28],
                         f"{w.get('client_name') or ''} / {w.get('event_name') or ''}"[:30],
                         f"{w.get('calculated_hours')}"])
        t = Table(rows, colWidths=[32 * mm, 32 * mm, 40 * mm, 46 * mm, 16 * mm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#111827")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d1d5db")),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f4f6")]),
        ]))
        elements += [t, Spacer(1, 12)]

    if not groups:
        elements.append(Paragraph("No shifts recorded for this period.", styles["Normal"]))
    doc.build(elements)
    return buf.getvalue()


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def _reverse_geocode_sync(lat: float, lng: float) -> str:
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/reverse",
            params={"lat": lat, "lon": lng, "format": "json", "zoom": 18, "addressdetails": 1},
            headers={"User-Agent": "QAKK-TimeTracker/1.0 (contact@qakk.dk)"},
            timeout=8,
        )
        if r.status_code == 200:
            data = r.json()
            addr = data.get("address", {})
            road = addr.get("road") or addr.get("pedestrian") or addr.get("footway") or addr.get("neighbourhood")
            house = addr.get("house_number")
            city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("municipality") or ""
            street = None
            if road:
                street = f"{road} {house}".strip() if house else road
            label = ", ".join([p for p in [street, city] if p])
            return label or data.get("display_name", f"{lat:.5f}, {lng:.5f}")
    except Exception as e:
        logger.warning("reverse geocode failed: %s", e)
    return f"{lat:.5f}, {lng:.5f}"


async def reverse_geocode(lat: float, lng: float) -> str:
    return await asyncio.to_thread(_reverse_geocode_sync, lat, lng)


def street_key(street: str) -> str:
    return (street or "").strip().lower()


def compute_hours(checkin: datetime, checkout: datetime):
    raw_minutes = max(0, int((checkout - checkin).total_seconds() // 60))
    credited_minutes = FOUR_HOUR_MINUTES if raw_minutes < FOUR_HOUR_MINUTES else raw_minutes
    return raw_minutes, round(credited_minutes / 60.0, 2)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class LoginBody(BaseModel):
    email: EmailStr
    password: str


class WorkerCreate(BaseModel):
    name: str
    email: EmailStr
    password: str


class WorkerUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    password: Optional[str] = None
    active: Optional[bool] = None


class CheckInBody(BaseModel):
    event_name: str
    client_name: str
    lat: Optional[float] = None
    lng: Optional[float] = None


class CheckOutBody(BaseModel):
    lat: Optional[float] = None
    lng: Optional[float] = None
    note: Optional[str] = None


class EditHoursBody(BaseModel):
    calculated_hours: float
    reason: str


class SettingsBody(BaseModel):
    alert_email: Optional[EmailStr] = None
    payroll_email: Optional[EmailStr] = None


class ChangePasswordBody(BaseModel):
    current_password: str
    new_password: str


class AdminShiftCreate(BaseModel):
    user_id: str
    event_name: str
    client_name: str
    checkin_time: str
    checkout_time: Optional[str] = None
    checkin_street: Optional[str] = None
    checkout_street: Optional[str] = None
    calculated_hours: Optional[float] = None


# ---------------------------------------------------------------------------
# Auth dependency
# ---------------------------------------------------------------------------
async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("access_token")
    if not token:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user = await db.users.find_one({"_id": ObjectId(payload["sub"])})
        if not user:
            raise HTTPException(status_code=401, detail="User not found")
        user["id"] = str(user.pop("_id"))
        user.pop("password_hash", None)
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def serialize_user(u: dict) -> dict:
    return {
        "id": str(u.get("_id", u.get("id"))),
        "name": u.get("name"),
        "email": u.get("email"),
        "role": u.get("role"),
        "active": u.get("active", True),
    }


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------
@api_router.post("/auth/login")
async def login(body: LoginBody, response: Response):
    email = body.email.lower().strip()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.get("active", True):
        raise HTTPException(status_code=403, detail="This account is deactivated")
    uid = str(user["_id"])
    token = create_access_token(uid, email, user["role"])
    response.set_cookie("access_token", token, httponly=True, secure=True,
                        samesite="none", max_age=604800, path="/")
    return {"token": token, "user": serialize_user(user)}


@api_router.post("/auth/logout")
async def logout(response: Response, user: dict = Depends(get_current_user)):
    response.delete_cookie("access_token", path="/")
    return {"ok": True}


@api_router.get("/auth/me")
async def me(user: dict = Depends(get_current_user)):
    return {"user": serialize_user(user)}


@api_router.post("/auth/change-password")
async def change_password(body: ChangePasswordBody, user: dict = Depends(get_current_user)):
    if len(body.new_password) < 6:
        raise HTTPException(status_code=400, detail="New password must be at least 6 characters")
    full = await db.users.find_one({"_id": ObjectId(user["id"])})
    if not full or not verify_password(body.current_password, full["password_hash"]):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    await db.users.update_one({"_id": ObjectId(user["id"])},
                              {"$set": {"password_hash": hash_password(body.new_password)}})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Worker management (admin)
# ---------------------------------------------------------------------------
@api_router.get("/workers")
async def list_workers(admin: dict = Depends(require_admin)):
    workers = await db.users.find({"role": "worker"}).sort("name", 1).to_list(1000)
    return [serialize_user(w) for w in workers]


@api_router.post("/workers")
async def create_worker(body: WorkerCreate, admin: dict = Depends(require_admin)):
    email = body.email.lower().strip()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="A user with this email already exists")
    doc = {
        "name": body.name.strip(), "email": email,
        "password_hash": hash_password(body.password), "role": "worker",
        "active": True, "created_at": now_utc().isoformat(),
    }
    res = await db.users.insert_one(doc)
    doc["_id"] = res.inserted_id
    login_url = os.environ.get("FRONTEND_URL", "")
    welcome = (
        f"Hi {body.name.strip()}, welcome to QAKK Time Registration! "
        "An account has been created for you. "
        + (f"Log in at {login_url}/login " if login_url else "Open the QAKK app ")
        + "using your email address. Your manager will share your password with you securely. "
        "If you did not expect this, please contact your manager."
    )
    await notify(email, "[QAKK] Welcome to QAKK", welcome, "welcome")
    return serialize_user(doc)


@api_router.put("/workers/{worker_id}")
async def update_worker(worker_id: str, body: WorkerUpdate, admin: dict = Depends(require_admin)):
    updates = {}
    if body.name is not None:
        updates["name"] = body.name.strip()
    if body.email is not None:
        updates["email"] = body.email.lower().strip()
    if body.password:
        updates["password_hash"] = hash_password(body.password)
    if body.active is not None:
        updates["active"] = body.active
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    res = await db.users.update_one({"_id": ObjectId(worker_id), "role": "worker"}, {"$set": updates})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Worker not found")
    w = await db.users.find_one({"_id": ObjectId(worker_id)})
    if not w:
        raise HTTPException(status_code=404, detail="Worker not found")
    if body.password:
        await notify(
            w["email"],
            "[QAKK] Your password was reset",
            (f"Hi {w['name']}, your QAKK password was reset by an administrator. "
             "Please log in with your new password. If you did not expect this, contact your manager."),
            "password_reset",
        )
    return serialize_user(w)


@api_router.delete("/workers/{worker_id}")
async def delete_worker(worker_id: str, admin: dict = Depends(require_admin)):
    await db.shifts.delete_many({"user_id": worker_id})
    res = await db.users.delete_one({"_id": ObjectId(worker_id), "role": "worker"})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Worker not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Geocoding preview
# ---------------------------------------------------------------------------
@api_router.get("/geocode")
async def geocode(lat: float, lng: float, user: dict = Depends(get_current_user)):
    return {"street": await reverse_geocode(lat, lng)}


# ---------------------------------------------------------------------------
# Worker shift routes
# ---------------------------------------------------------------------------
def serialize_shift(s: dict) -> dict:
    return {
        "id": str(s.get("_id", s.get("id"))),
        "user_id": s.get("user_id"),
        "user_name": s.get("user_name"),
        "event_name": s.get("event_name"),
        "client_name": s.get("client_name"),
        "checkin_time": s.get("checkin_time"),
        "checkout_time": s.get("checkout_time"),
        "checkin_street": s.get("checkin_street"),
        "checkout_street": s.get("checkout_street"),
        "checkin_lat": s.get("checkin_lat"),
        "checkin_lng": s.get("checkin_lng"),
        "checkout_lat": s.get("checkout_lat"),
        "checkout_lng": s.get("checkout_lng"),
        "raw_minutes": s.get("raw_minutes"),
        "calculated_hours": s.get("calculated_hours"),
        "status": s.get("status"),
        "closed_by": s.get("closed_by"),
        "location_mismatch": s.get("location_mismatch", False),
        "four_hour_applied": s.get("four_hour_applied", False),
        "override_reason": s.get("override_reason"),
        "note": s.get("note"),
    }


@api_router.get("/shifts/active")
async def get_active_shift(user: dict = Depends(get_current_user)):
    s = await db.shifts.find_one({"user_id": user["id"], "status": "active"})
    return {"shift": serialize_shift(s) if s else None}


@api_router.post("/shifts/checkin")
async def checkin(body: CheckInBody, user: dict = Depends(get_current_user)):
    existing = await db.shifts.find_one({"user_id": user["id"], "status": "active"})
    if existing:
        raise HTTPException(status_code=400, detail="You are already checked in")
    if body.lat is None or body.lng is None:
        raise HTTPException(status_code=400,
                            detail="Location is required to check in. Please enable GPS/location on your device.")
    street = await reverse_geocode(body.lat, body.lng)
    now = now_utc()
    doc = {
        "user_id": user["id"], "user_name": user["name"],
        "event_name": body.event_name.strip(), "client_name": body.client_name.strip(),
        "checkin_time": now.isoformat(),
        "checkin_lat": body.lat, "checkin_lng": body.lng, "checkin_street": street,
        "checkout_time": None, "checkout_lat": None, "checkout_lng": None, "checkout_street": None,
        "raw_minutes": None, "calculated_hours": None, "four_hour_applied": False,
        "status": "active", "closed_by": None, "location_mismatch": False,
        "override_reason": None, "note": None,
        "created_at": now.isoformat(),
    }
    res = await db.shifts.insert_one(doc)
    doc["_id"] = res.inserted_id
    return serialize_shift(doc)


async def _close_shift(shift: dict, checkout_dt: datetime, closed_by: str,
                      lat=None, lng=None, street=None, note=None):
    checkin_dt = parse_iso(shift["checkin_time"])
    raw_minutes, calc_hours = compute_hours(checkin_dt, checkout_dt)
    mismatch = False
    if street and shift.get("checkin_street"):
        if street_key(street) != street_key(shift["checkin_street"]):
            mismatch = True
    if (mismatch is False and lat is not None and shift.get("checkin_lat") is not None):
        try:
            if haversine_m(shift["checkin_lat"], shift["checkin_lng"], lat, lng) > 200:
                mismatch = True
        except Exception:
            pass
    updates = {
        "checkout_time": checkout_dt.isoformat(),
        "checkout_lat": lat, "checkout_lng": lng, "checkout_street": street,
        "raw_minutes": raw_minutes, "calculated_hours": calc_hours,
        "four_hour_applied": raw_minutes < FOUR_HOUR_MINUTES,
        "status": "closed", "closed_by": closed_by,
        "location_mismatch": mismatch, "note": note,
    }
    await db.shifts.update_one({"_id": shift["_id"]}, {"$set": updates})
    if mismatch:
        await notify(
            await get_alert_email(),
            f"[QAKK ALERT] Location mismatch — {shift['user_name']}",
            (f"Worker {shift['user_name']} checked IN at '{shift.get('checkin_street')}' "
             f"but checked OUT at '{street}'. Please review this shift."),
            "location_mismatch",
        )
    merged = {**shift, **updates}
    return merged


@api_router.post("/shifts/checkout")
async def checkout(body: CheckOutBody, user: dict = Depends(get_current_user)):
    shift = await db.shifts.find_one({"user_id": user["id"], "status": "active"})
    if not shift:
        raise HTTPException(status_code=400, detail="You are not checked in")
    if body.lat is None or body.lng is None:
        raise HTTPException(status_code=400,
                            detail="Location is required to check out. Please enable GPS/location on your device.")
    street = await reverse_geocode(body.lat, body.lng)
    merged = await _close_shift(shift, now_utc(), "worker", body.lat, body.lng, street, body.note)
    return serialize_shift(merged)


# ---------------------------------------------------------------------------
# Admin dashboard routes
# ---------------------------------------------------------------------------
@api_router.get("/admin/team-status")
async def team_status(admin: dict = Depends(require_admin)):
    workers = await db.users.find({"role": "worker"}).sort("name", 1).to_list(1000)
    active = await db.shifts.find({"status": "active"}).to_list(1000)
    active_by_user = {a["user_id"]: a for a in active}
    result = []
    for w in workers:
        wid = str(w["_id"])
        s = active_by_user.get(wid)
        result.append({
            "id": wid, "name": w["name"], "email": w["email"],
            "active": w.get("active", True),
            "online": s is not None,
            "shift": serialize_shift(s) if s else None,
        })
    online_count = sum(1 for r in result if r["online"])
    return {"workers": result, "online_count": online_count, "total": len(result)}


@api_router.get("/admin/active-locations")
async def active_locations(admin: dict = Depends(require_admin)):
    active = await db.shifts.find({"status": "active"}).to_list(1000)
    groups: dict[str, dict] = {}
    for s in active:
        street = s.get("checkin_street") or "Unknown location"
        key = street_key(street)
        if key not in groups:
            groups[key] = {"street": street, "workers": []}
        groups[key]["workers"].append(serialize_shift(s))
    ordered = sorted(groups.values(), key=lambda g: (-len(g["workers"]), g["street"]))
    return {"locations": ordered}


@api_router.get("/admin/recent-shifts")
async def recent_shifts(admin: dict = Depends(require_admin)):
    shifts = await db.shifts.find({"status": "closed"}).sort("checkout_time", -1).limit(100).to_list(100)
    return {"shifts": [serialize_shift(s) for s in shifts]}


@api_router.post("/admin/force-checkout/{shift_id}")
async def force_checkout(shift_id: str, admin: dict = Depends(require_admin)):
    shift = await db.shifts.find_one({"_id": ObjectId(shift_id), "status": "active"})
    if not shift:
        raise HTTPException(status_code=404, detail="Active shift not found")
    merged = await _close_shift(shift, now_utc(), "admin")
    return serialize_shift(merged)


@api_router.put("/admin/shifts/{shift_id}/hours")
async def edit_hours(shift_id: str, body: EditHoursBody, admin: dict = Depends(require_admin)):
    shift = await db.shifts.find_one({"_id": ObjectId(shift_id)})
    if not shift:
        raise HTTPException(status_code=404, detail="Shift not found")
    updates = {
        "calculated_hours": round(float(body.calculated_hours), 2),
        "override_reason": body.reason.strip(),
        "overridden_by": admin["email"],
        "overridden_at": now_utc().isoformat(),
    }
    await db.shifts.update_one({"_id": ObjectId(shift_id)}, {"$set": updates})
    await db.audit_log.insert_one({
        "shift_id": shift_id, "admin": admin["email"], "action": "edit_hours",
        "new_hours": updates["calculated_hours"], "reason": body.reason.strip(),
        "created_at": now_utc().isoformat(),
    })
    merged = {**shift, **updates}
    return serialize_shift(merged)


@api_router.delete("/admin/shifts/{shift_id}")
async def delete_shift(shift_id: str, admin: dict = Depends(require_admin)):
    res = await db.shifts.delete_one({"_id": ObjectId(shift_id)})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Shift not found")
    await db.audit_log.insert_one({
        "shift_id": shift_id, "admin": admin["email"], "action": "delete_shift",
        "created_at": now_utc().isoformat(),
    })
    return {"ok": True}


@api_router.post("/admin/shifts")
async def admin_create_shift(body: AdminShiftCreate, admin: dict = Depends(require_admin)):
    worker = await db.users.find_one({"_id": ObjectId(body.user_id)})
    if not worker:
        raise HTTPException(status_code=404, detail="Worker not found")

    def to_utc(v: str) -> datetime:
        dt = datetime.fromisoformat(v)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=DK_TZ)
        return dt.astimezone(timezone.utc)

    ci = to_utc(body.checkin_time)
    checkout_iso = None
    raw = calc = None
    four = False
    status = "active"
    if body.checkout_time:
        co = to_utc(body.checkout_time)
        if co <= ci:
            raise HTTPException(status_code=400, detail="Check-out must be after check-in")
        raw, calc = compute_hours(ci, co)
        if body.calculated_hours is not None:
            calc = round(float(body.calculated_hours), 2)
        four = raw < FOUR_HOUR_MINUTES
        checkout_iso = co.isoformat()
        status = "closed"
    else:
        existing = await db.shifts.find_one({"user_id": body.user_id, "status": "active"})
        if existing:
            raise HTTPException(status_code=400, detail="This worker already has an active (open) shift")
    doc = {
        "user_id": body.user_id, "user_name": worker["name"],
        "event_name": body.event_name.strip(), "client_name": body.client_name.strip(),
        "checkin_time": ci.isoformat(),
        "checkin_lat": None, "checkin_lng": None, "checkin_street": body.checkin_street,
        "checkout_time": checkout_iso, "checkout_lat": None, "checkout_lng": None,
        "checkout_street": body.checkout_street,
        "raw_minutes": raw, "calculated_hours": calc, "four_hour_applied": four,
        "status": status, "closed_by": "admin" if status == "closed" else None,
        "location_mismatch": False,
        "override_reason": "Manually added by admin" if status == "closed" else None,
        "note": None, "created_at": now_utc().isoformat(),
    }
    res = await db.shifts.insert_one(doc)
    doc["_id"] = res.inserted_id
    await db.audit_log.insert_one({
        "shift_id": str(res.inserted_id), "admin": admin["email"], "action": "create_shift",
        "created_at": now_utc().isoformat(),
    })
    return serialize_shift(doc)


@api_router.get("/admin/email-log")
async def email_log(admin: dict = Depends(require_admin)):
    logs = await db.email_log.find().sort("created_at", -1).limit(50).to_list(50)
    for l in logs:
        l.pop("_id", None)
    return {"emails": logs}


# ---------------------------------------------------------------------------
# Google Sheet sync & report export (admin)
# ---------------------------------------------------------------------------
async def _run_sheet_sync(source: str = "manual"):
    rows = await _fetch_sheet_rows()
    created = updated = deactivated = 0
    seen = set()
    INACTIVE = {"inactive", "inaktiv", "deactivated", "disabled", "off", "no", "false", "0", "nej"}
    for row in rows:
        norm = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        name = norm.get("name") or norm.get("navn") or norm.get("full name")
        email = (norm.get("email") or norm.get("e-mail") or norm.get("mail") or "").lower()
        password = norm.get("password") or norm.get("adgangskode") or norm.get("kodeord")
        status = (norm.get("status") or "").lower()
        is_active = status not in INACTIVE
        if not email or not name:
            continue
        seen.add(email)
        existing = await db.users.find_one({"email": email})
        if existing:
            if existing.get("role") == "admin":
                continue
            upd = {"name": name, "active": is_active, "role": "worker"}
            if password:
                upd["password_hash"] = hash_password(password)
            await db.users.update_one({"email": email}, {"$set": upd})
            updated += 1
            if not is_active and existing.get("active", True):
                deactivated += 1
        else:
            await db.users.insert_one({
                "name": name, "email": email,
                "password_hash": hash_password(password or "changeme123"),
                "role": "worker", "active": is_active, "created_at": now_utc().isoformat(),
            })
            created += 1
            if not is_active:
                deactivated += 1
    for w in await db.users.find({"role": "worker"}).to_list(1000):
        if w["email"] not in seen and w.get("active", True):
            await db.users.update_one({"_id": w["_id"]}, {"$set": {"active": False}})
            deactivated += 1
    result = {"created": created, "updated": updated, "deactivated": deactivated,
              "total_in_sheet": len(seen), "source": source, "created_at": now_utc().isoformat()}
    await db.sync_log.insert_one({**result})
    return result


@api_router.post("/admin/sync-sheet")
async def sync_sheet(admin: dict = Depends(require_admin)):
    return await _run_sheet_sync("manual")


@api_router.get("/admin/sync-status")
async def sync_status(admin: dict = Depends(require_admin)):
    last = await db.sync_log.find_one(sort=[("created_at", -1)])
    if last:
        last.pop("_id", None)
    return {"last_sync": last}


@api_router.get("/admin/reports")
async def export_report(fmt: str = Query("pdf"), month: Optional[str] = Query(None),
                        admin: dict = Depends(require_admin)):
    groups, label, start = await _report_data(month)
    base = f"QAKK_payroll_{start.strftime('%Y_%m')}"
    if fmt == "csv_summary":
        rows = [["QAKK Payroll Summary", label], [], ["Worker", "Shifts", "Total Hours"]]
        grand = 0.0
        for g in groups:
            rows.append([g["name"], len(g["shifts"]), g["total"]]); grand += g["total"]
        rows += [[], ["COMPANY TOTAL", "", round(grand, 2)]]
        return _csv_response(rows, f"{base}_summary.csv")
    if fmt == "csv_detailed":
        rows = [["QAKK Payroll Detailed", label], [],
                ["Worker", "Check-In (CET)", "Check-Out (CET)", "Location", "Client", "Event", "Raw Minutes", "Calculated Hours"]]
        for g in groups:
            for w in g["shifts"]:
                rows.append([g["name"], dk_now_str(parse_iso(w["checkin_time"])),
                             dk_now_str(parse_iso(w["checkout_time"])) if w.get("checkout_time") else "",
                             w.get("checkin_street") or "", w.get("client_name") or "",
                             w.get("event_name") or "", w.get("raw_minutes"), w.get("calculated_hours")])
            rows += [[f"{g['name']} TOTAL", "", "", "", "", "", "", g["total"]], []]
        return _csv_response(rows, f"{base}_detailed.csv")
    pdf = await asyncio.to_thread(_build_pdf, groups, label)
    return FastResponse(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{base}.pdf"'})


def _col_letter(n: int) -> str:
    s, n = "", n + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _write_back_sync(sheet_id: str, email_totals: dict, label: str):
    if not os.path.exists(GOOGLE_SA_FILE):
        raise HTTPException(
            status_code=400,
            detail="Two-way sync not configured. Upload a Google Service Account JSON and share the sheet as Editor with its client_email.",
        )
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    creds = service_account.Credentials.from_service_account_file(
        GOOGLE_SA_FILE, scopes=["https://www.googleapis.com/auth/spreadsheets"])
    sheet = build("sheets", "v4", credentials=creds).spreadsheets()
    try:
        data = sheet.values().get(spreadsheetId=sheet_id, range="A1:Z10000").execute().get("values", [])
    except HttpError as e:
        if "SERVICE_DISABLED" in str(e) or e.resp.status == 403 and "has not been used" in str(e):
            raise HTTPException(status_code=400, detail=(
                "Google Sheets API is not enabled for this project. Enable it at "
                "https://console.cloud.google.com/apis/library/sheets.googleapis.com?project=qakk-checkin "
                "then wait 1-2 minutes and retry."))
        if e.resp.status == 403:
            raise HTTPException(status_code=400, detail=(
                "The service account cannot access the sheet. Share it as Editor with "
                "qakk-check-in@qakk-checkin.iam.gserviceaccount.com."))
        raise HTTPException(status_code=400, detail=f"Google Sheets error: {e}")
    if not data:
        raise HTTPException(status_code=400, detail="Sheet is empty")
    header = data[0]

    def n(x):
        return (x or "").strip().lower()

    email_idx = next((i for i, h in enumerate(header) if n(h) in ("email", "e-mail", "mail")), None)
    if email_idx is None:
        raise HTTPException(status_code=400, detail="No 'Email' column found in the sheet")
    col_title = f"Hours {label}"
    hours_idx = next((i for i, h in enumerate(header) if n(h) == n(col_title)), len(header))
    letter = _col_letter(hours_idx)
    values = [[col_title]]
    written = 0
    for row in data[1:]:
        em = n(row[email_idx]) if email_idx < len(row) else ""
        if em in email_totals:
            values.append([str(email_totals[em])])
            written += 1
        else:
            values.append([""])
    rng = f"{letter}1:{letter}{len(values)}"
    try:
        sheet.values().update(spreadsheetId=sheet_id, range=rng,
                              valueInputOption="RAW", body={"values": values}).execute()
    except HttpError as e:
        raise HTTPException(status_code=400, detail=f"Failed to write to sheet: {e}")
    return {"written": written, "column": col_title, "range": rng}


@api_router.post("/admin/write-hours")
async def write_hours(month: Optional[str] = Query(None), admin: dict = Depends(require_admin)):
    groups, label, start = await _report_data(month)
    email_totals = {g["email"].lower(): g["total"] for g in groups if g.get("email")}
    return await asyncio.to_thread(_write_back_sync, GOOGLE_SHEET_ID, email_totals, label)


# ---------------------------------------------------------------------------
# Settings (report emails) & admin management
# ---------------------------------------------------------------------------
async def get_setting(key: str, default=None):
    doc = await db.settings.find_one({"key": key})
    return doc["value"] if doc and doc.get("value") else default


async def set_setting(key: str, value):
    await db.settings.update_one({"key": key}, {"$set": {"value": value}}, upsert=True)


async def get_alert_email():
    return await get_setting("alert_email", os.environ.get("ALERT_EMAIL", "alerts@qakk.dk"))


async def get_payroll_email():
    return await get_setting("payroll_email", os.environ.get("PAYROLL_EMAIL", "payroll@qakk.dk"))


@api_router.get("/admin/settings")
async def get_settings(admin: dict = Depends(require_admin)):
    return {"alert_email": await get_alert_email(), "payroll_email": await get_payroll_email()}


@api_router.put("/admin/settings")
async def update_settings(body: SettingsBody, admin: dict = Depends(require_admin)):
    if body.alert_email is not None:
        await set_setting("alert_email", body.alert_email.lower().strip())
    if body.payroll_email is not None:
        await set_setting("payroll_email", body.payroll_email.lower().strip())
    return {"alert_email": await get_alert_email(), "payroll_email": await get_payroll_email()}


@api_router.get("/admin/admins")
async def list_admins(admin: dict = Depends(require_admin)):
    admins = await db.users.find({"role": "admin"}).sort("name", 1).to_list(1000)
    return [serialize_user(a) for a in admins]


@api_router.post("/admin/admins")
async def create_admin(body: WorkerCreate, admin: dict = Depends(require_admin)):
    email = body.email.lower().strip()
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="A user with this email already exists")
    doc = {
        "name": body.name.strip(), "email": email,
        "password_hash": hash_password(body.password), "role": "admin",
        "active": True, "created_at": now_utc().isoformat(),
    }
    res = await db.users.insert_one(doc)
    doc["_id"] = res.inserted_id
    return serialize_user(doc)


@api_router.delete("/admin/admins/{admin_id}")
async def delete_admin(admin_id: str, admin: dict = Depends(require_admin)):
    if admin_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    if await db.users.count_documents({"role": "admin"}) <= 1:
        raise HTTPException(status_code=400, detail="At least one admin must remain")
    res = await db.users.delete_one({"_id": ObjectId(admin_id), "role": "admin"})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Admin not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Cron endpoints
# ---------------------------------------------------------------------------
def _check_cron_auth(authorization: Optional[str]):
    secret = os.environ.get("WEBHOOK_CRON_SECRET", "")
    expected = f"Bearer {secret}"
    if not authorization or not secret or not secrets.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail="Unauthorized")


async def _run_forgotten_checkout():
    threshold = now_utc() - timedelta(hours=24)
    active = await db.shifts.find({"status": "active"}).to_list(1000)
    for s in active:
        if s.get("forgotten_notified"):
            continue
        if parse_iso(s["checkin_time"]) <= threshold:
            worker = await db.users.find_one({"_id": ObjectId(s["user_id"])})
            to = worker["email"] if worker else "unknown"
            await notify(
                to,
                "[QAKK] Please check out",
                "Hey, please check out and let your boss know! Your shift has been running for over 24 hours.",
                "forgotten_checkout",
            )
            await db.shifts.update_one({"_id": s["_id"]}, {"$set": {"forgotten_notified": True}})


async def _run_monthly_payroll():
    now = now_utc().astimezone(DK_TZ)
    # Previous full period: shifts closed this month up to the 24th
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    period_start_iso = month_start.astimezone(timezone.utc).isoformat()
    shifts = await db.shifts.find({
        "status": "closed",
        "checkout_time": {"$gte": period_start_iso},
    }).to_list(5000)
    by_worker: dict[str, list] = {}
    for s in shifts:
        by_worker.setdefault(s["user_id"], []).append(s)
    company_lines = []
    email_totals: dict[str, float] = {}
    for uid, ws in by_worker.items():
        worker = await db.users.find_one({"_id": ObjectId(uid)})
        if not worker:
            continue
        total_hours = sum(w.get("calculated_hours") or 0 for w in ws)
        lines = [f"Monthly summary for {worker['name']} — {now.strftime('%B %Y')}", ""]
        for w in ws:
            lines.append(
                f"- {dk_now_str(parse_iso(w['checkin_time']))} -> "
                f"{dk_now_str(parse_iso(w['checkout_time'])) if w.get('checkout_time') else '?'} | "
                f"{w.get('checkin_street')} | {w.get('client_name')} / {w.get('event_name')} | "
                f"{w.get('calculated_hours')}h")
        lines.append("")
        lines.append(f"TOTAL: {round(total_hours, 2)} hours")
        await notify(worker["email"], f"[QAKK] Your monthly summary — {now.strftime('%B %Y')}",
                     "\n".join(lines), "monthly_worker")
        email_totals[worker["email"].lower()] = round(total_hours, 2)
        company_lines.append(f"{worker['name']}: {round(total_hours, 2)}h ({len(ws)} shifts)")
    company_body = (f"QAKK Company payroll report — {now.strftime('%B %Y')}\n\n" +
                    ("\n".join(company_lines) if company_lines else "No shifts this period."))
    await notify(await get_payroll_email(),
                 f"[QAKK] Company payroll report — {now.strftime('%B %Y')}",
                 company_body, "monthly_company")
    if GOOGLE_SHEET_ID and email_totals:
        try:
            await asyncio.to_thread(_write_back_sync, GOOGLE_SHEET_ID, email_totals, now.strftime("%B %Y"))
            logger.info("Monthly payroll: wrote hours back to Google Sheet")
        except Exception as e:
            logger.error("Monthly sheet write-back failed: %s", e)


@api_router.post("/cron/forgotten-checkout")
async def cron_forgotten_checkout(request: Request, authorization: Optional[str] = Header(None)):
    # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
    _check_cron_auth(authorization)
    asyncio.create_task(_run_forgotten_checkout())
    return {"accepted": True}


@api_router.post("/cron/monthly-payroll")
async def cron_monthly_payroll(request: Request, authorization: Optional[str] = Header(None)):
    # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
    _check_cron_auth(authorization)
    asyncio.create_task(_run_monthly_payroll())
    return {"accepted": True}


@api_router.post("/cron/sheet-sync")
async def cron_sheet_sync(request: Request, authorization: Optional[str] = Header(None)):
    # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
    _check_cron_auth(authorization)
    asyncio.create_task(_run_sheet_sync("cron"))
    return {"accepted": True}


# ---------------------------------------------------------------------------
# Startup: seed admin & indexes
# ---------------------------------------------------------------------------
async def seed_admin():
    email = os.environ.get("ADMIN_EMAIL", "admin@example.com").lower()
    password = os.environ.get("ADMIN_PASSWORD", "admin123")
    name = os.environ.get("ADMIN_NAME", "Manager")
    existing = await db.users.find_one({"email": email})
    if existing is None:
        await db.users.insert_one({
            "name": name, "email": email, "password_hash": hash_password(password),
            "role": "admin", "active": True, "created_at": now_utc().isoformat(),
        })
        logger.info("Seeded admin %s", email)
    else:
        # Do NOT reset the password here — the admin can change it from the UI,
        # and that change must survive backend restarts. Only ensure the role.
        if existing.get("role") != "admin":
            await db.users.update_one({"email": email}, {"$set": {"role": "admin"}})


@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.shifts.create_index([("user_id", 1), ("status", 1)])
    await seed_admin()


@app.on_event("shutdown")
async def shutdown():
    client.close()


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
