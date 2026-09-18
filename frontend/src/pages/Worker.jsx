import React, { useEffect, useState, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LogOut, MapPin, Loader2, Radio, CalendarClock } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLang } from "@/i18n";
import { api, formatApiError } from "@/lib/api";
import { LangToggle } from "@/components/LangToggle";
import { toast } from "sonner";

function useGeolocation() {
  const [coords, setCoords] = useState(null);
  const [street, setStreet] = useState(null);
  const [status, setStatus] = useState("locating"); // locating | ok | off

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus("off");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const c = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(c);
        setStatus("ok");
        try {
          const { data } = await api.get(`/geocode?lat=${c.lat}&lng=${c.lng}`);
          setStreet(data.street);
        } catch {
          /* ignore */
        }
      },
      () => setStatus("off"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }, []);

  useEffect(() => {
    locate();
  }, [locate]);

  return { coords, street, status, locate };
}

function ElapsedTimer({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const start = new Date(since).getTime();
  const diff = Math.max(0, Math.floor((now - start) / 1000));
  const h = String(Math.floor(diff / 3600)).padStart(2, "0");
  const m = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
  const s = String(diff % 60).padStart(2, "0");
  return (
    <span data-testid="worker-elapsed-timer" className="font-mono text-4xl font-bold tracking-tight">
      {h}:{m}:{s}
    </span>
  );
}

function fmtDkTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("da-DK", {
      timeZone: "Europe/Copenhagen",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function Worker() {
  const { user, logout } = useAuth();
  const { t } = useLang();
  const geo = useGeolocation();
  const [shift, setShift] = useState(null);
  const [event, setEvent] = useState("");
  const [clientName, setClientName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadActive = useCallback(async () => {
    try {
      const { data } = await api.get("/shifts/active");
      setShift(data.shift);
    } catch {
      /* ignore */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadActive();
  }, [loadActive]);

  const doCheckIn = async () => {
    if (!event.trim() || !clientName.trim()) {
      toast.error(t("fillFields"));
      return;
    }
    if (!geo.coords) {
      toast.error(t("gpsRequired"));
      geo.locate();
      return;
    }
    setBusy(true);
    try {
      const body = {
        event_name: event.trim(),
        client_name: clientName.trim(),
        lat: geo.coords?.lat ?? null,
        lng: geo.coords?.lng ?? null,
      };
      const { data } = await api.post("/shifts/checkin", body);
      setShift(data);
      setEvent("");
      setClientName("");
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const doCheckOut = async () => {
    if (!geo.coords) {
      toast.error(t("gpsRequired"));
      geo.locate();
      return;
    }
    setBusy(true);
    try {
      const body = { lat: geo.coords?.lat ?? null, lng: geo.coords?.lng ?? null };
      const { data } = await api.post("/shifts/checkout", body);
      setShift(null);
      geo.locate();
      const hrs = data.calculated_hours;
      toast.success(`${t("checkOut")} · ${hrs}h`);
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const online = !!shift;

  return (
    <div className="min-h-[100dvh] w-full flex flex-col max-w-md mx-auto p-6 bg-[#0B0F19] text-[#F9FAFB] relative overflow-hidden">
      <div
        className={`absolute -top-32 -right-24 w-80 h-80 rounded-full blur-3xl pointer-events-none transition-colors ${
          online ? "bg-red-600/10" : "bg-emerald-600/10"
        }`}
      />

      {/* Header */}
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-widest text-[#6B7280]">{t("appName")}</p>
          <h1 className="text-2xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>
            {t("hi")}, {user?.name?.split(" ")[0]}
          </h1>
          <div className="flex items-center gap-2 mt-1">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                online ? "bg-emerald-500 animate-pulse" : "bg-gray-500"
              }`}
            />
            <span className="text-sm text-[#9CA3AF]" data-testid="worker-status-badge">
              {online ? t("online") : t("offline")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LangToggle />
          <button
            data-testid="worker-logout-button"
            onClick={logout}
            className="w-10 h-10 rounded-full bg-[#111827] border border-[#1F2937] flex items-center justify-center text-[#9CA3AF] hover:text-white transition-colors"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* GPS status */}
      <div className={`mt-6 flex items-center gap-2 rounded-xl bg-[#111827] border px-4 py-3 ${geo.status === "off" ? "border-red-500/50" : "border-[#1F2937]"}`}>
        <MapPin className={`w-5 h-5 shrink-0 ${geo.status === "ok" ? "text-emerald-400" : geo.status === "off" ? "text-red-400" : "text-amber-400"}`} />
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wider text-[#6B7280]">{t("gpsActive")}</p>
          <p className={`text-sm truncate ${geo.status === "off" ? "text-red-400" : ""}`} data-testid="worker-gps-street">
            {geo.status === "locating"
              ? t("gpsLocating")
              : geo.status === "off"
              ? t("gpsOff")
              : geo.street || `${geo.coords?.lat?.toFixed(5)}, ${geo.coords?.lng?.toFixed(5)}`}
          </p>
        </div>
        {geo.status === "off" && (
          <button data-testid="worker-gps-retry" onClick={geo.locate}
            className="text-xs font-bold rounded-lg bg-red-600/20 text-red-400 border border-red-600/40 px-2 py-1 hover:bg-red-600/30 transition-colors shrink-0">
            {t("retry")}
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex flex-col justify-center py-6">
        <AnimatePresence mode="wait">
          {!loaded ? (
            <div key="load" className="flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-[#6B7280]" />
            </div>
          ) : !online ? (
            <motion.div
              key="offline"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="space-y-4"
            >
              <p className="text-sm text-[#9CA3AF]">{t("readyToCheckIn")}</p>
              <div>
                <label className="text-xs font-medium uppercase tracking-wider text-[#9CA3AF]">{t("eventName")}</label>
                <input
                  data-testid="worker-event-input"
                  value={event}
                  onChange={(e) => setEvent(e.target.value)}
                  placeholder={t("eventPlaceholder")}
                  className="mt-1 w-full rounded-xl bg-[#111827] border border-[#1F2937] px-4 py-4 text-base outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
              <div>
                <label className="text-xs font-medium uppercase tracking-wider text-[#9CA3AF]">{t("clientName")}</label>
                <input
                  data-testid="worker-client-input"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder={t("clientPlaceholder")}
                  className="mt-1 w-full rounded-xl bg-[#111827] border border-[#1F2937] px-4 py-4 text-base outline-none focus:border-emerald-500 transition-colors"
                />
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="online"
              data-testid="worker-active-shift-panel"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="rounded-2xl bg-[#111827] border border-[#1F2937] p-6 space-y-5"
            >
              <div className="flex items-center gap-2 text-emerald-400">
                <Radio className="w-4 h-4 animate-pulse" />
                <span className="text-xs font-mono uppercase tracking-widest">{t("atWork")}</span>
              </div>
              <div className="flex flex-col items-center py-2">
                <span className="text-xs uppercase tracking-wider text-[#6B7280] mb-1">{t("elapsed")}</span>
                <ElapsedTimer since={shift.checkin_time} />
              </div>
              <div className="grid grid-cols-1 gap-3 text-sm">
                <Info label={t("currentEvent")} value={shift.event_name} />
                <Info label={t("client")} value={shift.client_name} />
                <Info label={t("startedAt")} value={fmtDkTime(shift.checkin_time)} />
                <Info label={t("location")} value={shift.checkin_street || "—"} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Action button */}
      {loaded && !online && (
        <button
          data-testid="worker-checkin-button"
          onClick={doCheckIn}
          disabled={busy || !geo.coords}
          className="w-full rounded-3xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.97] text-white font-extrabold text-2xl py-8 shadow-2xl shadow-emerald-600/40 transition-transform transition-colors flex items-center justify-center gap-3 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-7 h-7 animate-spin" /> : null}
          {busy ? t("checkingIn") : t("checkIn")}
        </button>
      )}
      {loaded && online && (
        <button
          data-testid="worker-checkout-button"
          onClick={doCheckOut}
          disabled={busy || !geo.coords}
          className="w-full rounded-3xl bg-red-600 hover:bg-red-700 active:scale-[0.97] text-white font-extrabold text-2xl py-8 shadow-2xl shadow-red-600/40 transition-transform transition-colors flex items-center justify-center gap-3 disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-7 h-7 animate-spin" /> : null}
          {busy ? t("checkingOut") : t("checkOut")}
        </button>
      )}
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="flex items-center justify-between border-b border-[#1F2937] pb-2 last:border-0">
      <span className="text-xs uppercase tracking-wider text-[#6B7280]">{label}</span>
      <span className="font-medium text-right max-w-[60%] truncate">{value}</span>
    </div>
  );
}
