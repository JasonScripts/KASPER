"""QAKK backend API integration tests."""
import os
import time
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://checkinsystem-3.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "jaki960119@gmail.hu"
ADMIN_PASSWORD = "Admin1234"
CRON_SECRET = "qakk_cron_9d4f7b2a6e138c05af92e7b41d6038ca"

WORKER_EMAIL = f"test_worker_{int(time.time())}@qakk.dk"
WORKER_PASSWORD = "Worker1234"
WORKER_NAME = "TEST_Worker"


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=15)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "token" in data and data["user"]["role"] == "admin"
    return data["token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def worker(admin_headers):
    # Create fresh worker for this run
    r = requests.post(f"{API}/workers", json={"name": WORKER_NAME, "email": WORKER_EMAIL, "password": WORKER_PASSWORD},
                      headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    w = r.json()
    assert w["email"] == WORKER_EMAIL
    yield w
    # cleanup
    requests.delete(f"{API}/workers/{w['id']}", headers=admin_headers, timeout=15)


@pytest.fixture(scope="module")
def worker_token(worker):
    r = requests.post(f"{API}/auth/login", json={"email": WORKER_EMAIL, "password": WORKER_PASSWORD}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["token"]


@pytest.fixture(scope="module")
def worker_headers(worker_token):
    return {"Authorization": f"Bearer {worker_token}"}


# -------- Auth --------
class TestAuth:
    def test_login_invalid(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "wrongpw"}, timeout=15)
        assert r.status_code == 401

    def test_me_requires_auth(self):
        r = requests.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 401

    def test_me_admin(self, admin_headers):
        r = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "admin"


# -------- Role separation --------
class TestRoleSeparation:
    def test_worker_cannot_list_workers(self, worker_headers):
        r = requests.get(f"{API}/workers", headers=worker_headers, timeout=15)
        assert r.status_code == 403

    def test_worker_cannot_team_status(self, worker_headers):
        r = requests.get(f"{API}/admin/team-status", headers=worker_headers, timeout=15)
        assert r.status_code == 403

    def test_unauth_workers(self):
        r = requests.get(f"{API}/workers", timeout=15)
        assert r.status_code == 401


# -------- Workers CRUD --------
class TestWorkers:
    def test_worker_appears_in_list(self, admin_headers, worker):
        r = requests.get(f"{API}/workers", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        emails = [w["email"] for w in r.json()]
        assert WORKER_EMAIL in emails

    def test_duplicate_email_rejected(self, admin_headers, worker):
        r = requests.post(f"{API}/workers",
                          json={"name": "x", "email": WORKER_EMAIL, "password": "x12345"},
                          headers=admin_headers, timeout=15)
        assert r.status_code == 400


# -------- Shift flow + 4-hour rule --------
class TestShifts:
    def test_full_shift_flow_and_four_hour_rule(self, worker_headers, admin_headers, worker):
        # ensure clean
        r = requests.get(f"{API}/shifts/active", headers=worker_headers, timeout=15)
        assert r.status_code == 200
        if r.json().get("shift"):
            requests.post(f"{API}/admin/force-checkout/" + r.json()["shift"]["id"],
                          headers=admin_headers, timeout=15)

        # check-in without coords
        r = requests.post(f"{API}/shifts/checkin",
                          json={"event_name": "TEST_Event", "client_name": "TEST_Client"},
                          headers=worker_headers, timeout=20)
        assert r.status_code == 200, r.text
        shift = r.json()
        assert shift["status"] == "active"
        assert shift["event_name"] == "TEST_Event"
        assert shift["checkin_street"] is None  # no coords

        # duplicate check-in blocked
        r2 = requests.post(f"{API}/shifts/checkin",
                           json={"event_name": "x", "client_name": "y"},
                           headers=worker_headers, timeout=15)
        assert r2.status_code == 400

        # team status shows online
        r = requests.get(f"{API}/admin/team-status", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        my = [w for w in r.json()["workers"] if w["id"] == worker["id"]]
        assert my and my[0]["online"] is True

        # active-locations includes it
        r = requests.get(f"{API}/admin/active-locations", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert isinstance(r.json()["locations"], list)

        # checkout — same-minute -> 4h rule applies
        r = requests.post(f"{API}/shifts/checkout", json={}, headers=worker_headers, timeout=15)
        assert r.status_code == 200, r.text
        closed = r.json()
        assert closed["status"] == "closed"
        assert closed["calculated_hours"] == 4.0
        assert closed["four_hour_applied"] is True
        assert closed["closed_by"] == "worker"

        # in recent shifts
        r = requests.get(f"{API}/admin/recent-shifts", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        ids = [s["id"] for s in r.json()["shifts"]]
        assert closed["id"] in ids

    def test_force_checkout_and_edit_hours(self, worker_headers, admin_headers):
        # check-in
        r = requests.post(f"{API}/shifts/checkin",
                          json={"event_name": "TEST_FE", "client_name": "TEST_FC"},
                          headers=worker_headers, timeout=15)
        assert r.status_code == 200
        sid = r.json()["id"]

        # admin force checkout
        r = requests.post(f"{API}/admin/force-checkout/{sid}", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert r.json()["closed_by"] == "admin"
        assert r.json()["status"] == "closed"

        # edit hours override
        r = requests.put(f"{API}/admin/shifts/{sid}/hours",
                         json={"calculated_hours": 6.5, "reason": "TEST override"},
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert r.json()["calculated_hours"] == 6.5
        assert r.json()["override_reason"] == "TEST override"

        # verify persisted via recent-shifts
        r = requests.get(f"{API}/admin/recent-shifts", headers=admin_headers, timeout=15)
        match = next((s for s in r.json()["shifts"] if s["id"] == sid), None)
        assert match and match["calculated_hours"] == 6.5


# -------- Cron auth --------
class TestCron:
    def test_forgotten_no_auth(self):
        r = requests.post(f"{API}/cron/forgotten-checkout", timeout=15)
        assert r.status_code == 401

    def test_forgotten_wrong_auth(self):
        r = requests.post(f"{API}/cron/forgotten-checkout",
                          headers={"Authorization": "Bearer wrong"}, timeout=15)
        assert r.status_code == 401

    def test_forgotten_ok(self):
        r = requests.post(f"{API}/cron/forgotten-checkout",
                          headers={"Authorization": f"Bearer {CRON_SECRET}"}, timeout=15)
        assert r.status_code == 200
        assert r.json().get("accepted") is True

    def test_monthly_no_auth(self):
        r = requests.post(f"{API}/cron/monthly-payroll", timeout=15)
        assert r.status_code == 401

    def test_monthly_ok_and_logs(self, admin_headers):
        r = requests.post(f"{API}/cron/monthly-payroll",
                          headers={"Authorization": f"Bearer {CRON_SECRET}"}, timeout=15)
        assert r.status_code == 200
        # Give the background task a moment
        time.sleep(3)
        r = requests.get(f"{API}/admin/email-log", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        cats = [e.get("category") for e in r.json()["emails"]]
        assert "monthly_company" in cats
