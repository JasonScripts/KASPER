import React, { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  LogOut, MapPin, Users, Clock, AlertTriangle, Pencil, UserPlus,
  Trash2, X, Radio, Bell, ShieldCheck, Download, FileText, FileSpreadsheet, RefreshCw, Upload,
  Settings, Shield, Mail, KeyRound, Plus,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLang } from "@/i18n";
import { api, formatApiError } from "@/lib/api";
import { LangToggle } from "@/components/LangToggle";
import { toast } from "sonner";

function fmtDkTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("da-DK", {
      timeZone: "Europe/Copenhagen",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export default function Admin() {
  const { user, logout } = useAuth();
  const { t } = useLang();
  const [team, setTeam] = useState({ workers: [], online_count: 0, total: 0 });
  const [locations, setLocations] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [tab, setTab] = useState("dashboard"); // dashboard | workers | log
  const [editShift, setEditShift] = useState(null);
  const [showAddShift, setShowAddShift] = useState(false);
  const [emails, setEmails] = useState([]);
  const [month, setMonth] = useState("");
  const [exporting, setExporting] = useState("");

  const downloadReport = async (fmt) => {
    setExporting(fmt);
    try {
      const res = await api.get(`/admin/reports?fmt=${fmt}${month ? `&month=${month}` : ""}`, {
        responseType: "blob",
      });
      const cd = res.headers["content-disposition"] || "";
      const m = cd.match(/filename="?([^"]+)"?/);
      const name = m ? m[1] : `qakk_report.${fmt.includes("csv") ? "csv" : "pdf"}`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting("");
    }
  };

  const writeHours = async () => {
    setExporting("write");
    try {
      const { data } = await api.post(`/admin/write-hours${month ? `?month=${month}` : ""}`);
      toast.success(`${t("writeDone")}: ${data.written} · ${data.column}`);
    } catch (e) {
      toast.error(formatApiError(e.response?.data?.detail));
    } finally {
      setExporting("");
    }
  };

  const load = useCallback(async () => {
    try {
      const [ts, loc, rs] = await Promise.all([
        api.get("/admin/team-status"),
        api.get("/admin/active-locations"),
        api.get("/admin/recent-shifts"),
      ]);
      setTeam(ts.data);
      setLocations(loc.data.locations);
      setShifts(rs.data.shifts);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const forceCheckout = async (shiftId) => {
    try {
      await api.post(`/admin/force-checkout/${shiftId}`);
      toast.success(t("forceCheckout"));
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  const deleteShift = async (id) => {
    if (!window.confirm(t("confirmDeleteShift"))) return;
    try {
      await api.delete(`/admin/shifts/${id}`);
      toast.success(t("shiftDeleted"));
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  return (
    <div className="min-h-screen bg-[#090D16] text-[#F9FAFB] flex flex-col md:flex-row" style={{ fontFamily: "Inter, sans-serif" }}>
      {/* Sidebar - Live Team Status */}
      <aside className="w-full md:w-80 lg:w-96 bg-[#0F172A] border-r border-[#1E293B] flex flex-col shrink-0">
        <div className="p-5 border-b border-[#1E293B]">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-6 h-6 text-emerald-500" />
            <h1 className="text-xl font-extrabold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>
              {t("dashboard")}
            </h1>
          </div>
          <div className="flex items-center gap-2 mt-3">
            <Radio className="w-4 h-4 text-emerald-400" />
            <span className="text-sm text-[#94A3B8]">
              {t("teamStatus")} · <span className="text-emerald-400 font-bold" data-testid="admin-online-count">{team.online_count}</span>/{team.total} {t("online")}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1" data-testid="admin-team-list">
          {team.workers.map((w) => (
            <div
              key={w.id}
              data-testid={`admin-team-row-${w.id}`}
              className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-[#111C33] transition-colors"
            >
              <span
                className={`w-3 h-3 rounded-full shrink-0 ${
                  w.online ? "bg-emerald-500 shadow-[0_0_8px_2px_rgba(16,185,129,0.5)]" : "bg-gray-600"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{w.name}</p>
                <p className="text-xs text-[#64748B] truncate">
                  {w.online ? w.shift?.checkin_street || w.shift?.client_name : t("loggedOff")}
                </p>
              </div>
              {w.online && (
                <button
                  data-testid={`admin-force-checkout-btn-${w.id}`}
                  onClick={() => forceCheckout(w.shift.id)}
                  className="text-xs font-bold rounded-lg bg-red-600/20 text-red-400 border border-red-600/40 px-2 py-1 hover:bg-red-600/30 active:scale-95 transition-transform transition-colors"
                >
                  {t("forceCheckout")}
                </button>
              )}
            </div>
          ))}
          {team.workers.length === 0 && (
            <p className="text-sm text-[#64748B] p-3">{t("noEmails")}</p>
          )}
        </div>

        <div className="p-4 border-t border-[#1E293B] flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{user?.name}</p>
            <p className="text-xs text-[#64748B] truncate">{user?.email}</p>
          </div>
          <div className="flex items-center gap-2">
            <LangToggle />
            <button
              data-testid="admin-logout-button"
              onClick={logout}
              className="w-9 h-9 rounded-full bg-[#111C33] flex items-center justify-center text-[#94A3B8] hover:text-white transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col p-6 space-y-6 overflow-y-auto bg-[#0B0F19]">
        {/* Tabs */}
        <div className="flex items-center gap-2">
          <TabButton active={tab === "dashboard"} onClick={() => setTab("dashboard")} testid="admin-tab-dashboard" icon={MapPin} label={t("activeLocations")} />
          <TabButton active={tab === "workers"} onClick={() => setTab("workers")} testid="admin-tab-workers" icon={Users} label={t("manageWorkers")} />
          <TabButton active={tab === "log"} onClick={() => { setTab("log"); api.get("/admin/email-log").then((r) => setEmails(r.data.emails)); }} testid="admin-tab-log" icon={Bell} label={t("emailLog")} />
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} testid="admin-tab-settings" icon={Settings} label={t("settings")} />
        </div>

        {tab === "dashboard" && (
          <>
            {/* Active Locations */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <MapPin className="w-5 h-5 text-emerald-400" />
                <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("activeLocations")}</h2>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4" data-testid="admin-locations-grid">
                {locations.map((loc, i) => (
                  <motion.div
                    key={loc.street + i}
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="rounded-xl bg-[#111827] border border-[#1F2937] p-4 shadow-xl"
                  >
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <MapPin className="w-4 h-4 text-emerald-400 shrink-0" />
                        <span className="font-semibold truncate">{loc.street}</span>
                      </div>
                      <span className="text-xs font-bold rounded-full bg-emerald-600/20 text-emerald-400 px-2 py-1 whitespace-nowrap">
                        {loc.workers.length} {t("workersActive")}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {loc.workers.map((s) => (
                        <div key={s.id} className="rounded-lg bg-[#0B0F19] border border-[#1F2937] px-3 py-2">
                          <p className="font-medium text-sm">{s.user_name}</p>
                          <p className="text-xs text-[#64748B]">
                            {s.client_name} · {s.event_name}
                          </p>
                          <p className="text-xs text-emerald-400/80 font-mono mt-0.5">{fmtDkTime(s.checkin_time)}</p>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                ))}
                {locations.length === 0 && (
                  <p className="text-sm text-[#64748B]">{t("noActiveLocations")}</p>
                )}
              </div>
            </section>

            {/* Recent Shifts */}
            <section className="bg-[#111827] border border-[#1F2937] rounded-xl p-5 shadow-2xl">
              <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-5 h-5 text-emerald-400" />
                  <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("recentShifts")}</h2>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button data-testid="admin-add-shift-button" onClick={() => setShowAddShift(true)}
                    className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> {t("addShift")}
                  </button>
                  <input
                    data-testid="report-month-input"
                    type="month"
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                    className="rounded-lg bg-[#0B0F19] border border-[#1F2937] px-3 py-1.5 text-xs outline-none focus:border-emerald-500 transition-colors"
                  />
                  <button data-testid="export-csv-summary" onClick={() => downloadReport("csv_summary")} disabled={!!exporting}
                    className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-[#0B0F19] border border-[#1F2937] px-2.5 py-1.5 hover:border-emerald-500 transition-colors disabled:opacity-50">
                    <FileSpreadsheet className="w-3.5 h-3.5" /> {t("csvSummary")}
                  </button>
                  <button data-testid="export-csv-detailed" onClick={() => downloadReport("csv_detailed")} disabled={!!exporting}
                    className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-[#0B0F19] border border-[#1F2937] px-2.5 py-1.5 hover:border-emerald-500 transition-colors disabled:opacity-50">
                    <FileSpreadsheet className="w-3.5 h-3.5" /> {t("csvDetailed")}
                  </button>
                  <button data-testid="export-pdf" onClick={() => downloadReport("pdf")} disabled={!!exporting}
                    className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-emerald-600 hover:bg-emerald-700 px-2.5 py-1.5 transition-colors disabled:opacity-50">
                    <FileText className="w-3.5 h-3.5" /> {t("pdfReport")}
                  </button>
                  <button data-testid="write-hours-button" onClick={writeHours} disabled={!!exporting}
                    className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-blue-600 hover:bg-blue-700 px-2.5 py-1.5 transition-colors disabled:opacity-50">
                    <Upload className="w-3.5 h-3.5" /> {t("writeHours")}
                  </button>
                </div>
              </div>
              <p className="text-xs text-[#64748B] flex items-center gap-1 mb-4">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> {t("nextPayroll")}
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]" data-testid="admin-recent-shifts-table">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-[#64748B] border-b border-[#1F2937]">
                      <th className="py-2 pr-4">{t("worker")}</th>
                      <th className="py-2 pr-4">{t("location")}</th>
                      <th className="py-2 pr-4">{t("checkInCol")}</th>
                      <th className="py-2 pr-4">{t("checkOutCol")}</th>
                      <th className="py-2 pr-4">{t("rawMinutes")}</th>
                      <th className="py-2 pr-4">{t("calcHours")}</th>
                      <th className="py-2 pr-4">{t("actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shifts.map((s) => (
                      <tr key={s.id} data-testid={`admin-shift-row-${s.id}`} className="border-b border-[#1F2937]/60">
                        <td className="py-3 pr-4 font-medium">{s.user_name}</td>
                        <td className="py-3 pr-4 text-[#94A3B8]">
                          <div className="flex items-center gap-1">
                            {s.checkin_street || "—"}
                            {s.location_mismatch && (
                              <span title={t("mismatch")} className="inline-flex items-center gap-1 text-amber-400 text-xs">
                                <AlertTriangle className="w-3.5 h-3.5" />
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pr-4 font-mono text-xs">{fmtDkTime(s.checkin_time)}</td>
                        <td className="py-3 pr-4 font-mono text-xs">{fmtDkTime(s.checkout_time)}</td>
                        <td className="py-3 pr-4 text-[#94A3B8]">{s.raw_minutes}m</td>
                        <td className="py-3 pr-4">
                          <span className="font-bold">{s.calculated_hours}h</span>
                          {s.four_hour_applied && (
                            <span className="ml-1 text-[10px] rounded bg-amber-500/15 text-amber-400 px-1.5 py-0.5" title={t("fourHourApplied")}>4h</span>
                          )}
                          {s.override_reason && (
                            <span className="ml-1 text-[10px] rounded bg-blue-500/15 text-blue-400 px-1.5 py-0.5">✎</span>
                          )}
                        </td>
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-2">
                            <button
                              data-testid={`admin-edit-hours-btn-${s.id}`}
                              onClick={() => setEditShift(s)}
                              className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-[#0B0F19] border border-[#1F2937] px-2.5 py-1.5 hover:border-emerald-500 transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" /> {t("editHours")}
                            </button>
                            <button
                              data-testid={`admin-delete-shift-btn-${s.id}`}
                              onClick={() => deleteShift(s.id)}
                              title={t("deleteShift")}
                              className="inline-flex items-center gap-1 text-xs font-bold rounded-lg bg-[#0B0F19] border border-[#1F2937] px-2.5 py-1.5 text-red-400 hover:border-red-500 hover:bg-red-600/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" /> {t("delete")}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {shifts.length === 0 && (
                      <tr><td colSpan={7} className="py-6 text-center text-[#64748B]">{t("noRecentShifts")}</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {tab === "workers" && <WorkersManager t={t} />}
        {tab === "log" && <EmailLog t={t} emails={emails} />}
        {tab === "settings" && <SettingsManager t={t} />}
      </main>

      {editShift && (
        <EditHoursModal
          t={t}
          shift={editShift}
          onClose={() => setEditShift(null)}
          onSaved={() => { setEditShift(null); load(); }}
        />
      )}
      {showAddShift && (
        <AddShiftModal
          t={t}
          workers={team.workers}
          onClose={() => setShowAddShift(false)}
          onSaved={() => { setShowAddShift(false); load(); }}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${
        active ? "bg-emerald-600 text-white" : "bg-[#111827] text-[#94A3B8] border border-[#1F2937] hover:text-white"
      }`}
    >
      <Icon className="w-4 h-4" /> {label}
    </button>
  );
}

function EditHoursModal({ t, shift, onClose, onSaved }) {
  const [hours, setHours] = useState(shift.calculated_hours ?? 0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!reason.trim()) {
      toast.error(t("reason"));
      return;
    }
    setBusy(true);
    try {
      await api.put(`/admin/shifts/${shift.id}/hours`, {
        calculated_hours: parseFloat(hours),
        reason: reason.trim(),
      });
      toast.success(t("saveOverride"));
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" data-testid="admin-edit-hours-modal">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-[#111827] border border-[#1F2937] rounded-2xl p-6 w-full max-w-md"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{t("editHours")} — {shift.user_name}</h3>
          <button onClick={onClose} className="text-[#64748B] hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("newHours")}</label>
            <input
              data-testid="admin-edit-hours-input"
              type="number" step="0.25" min="0"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              className="mt-1 w-full rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("reason")}</label>
            <textarea
              data-testid="admin-edit-hours-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm bg-[#0B0F19] border border-[#1F2937] hover:text-white transition-colors">{t("cancel")}</button>
            <button data-testid="admin-save-override-button" onClick={save} disabled={busy} className="rounded-xl px-4 py-2 text-sm font-bold bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-60">{t("saveOverride")}</button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function AddShiftModal({ t, workers, onClose, onSaved }) {
  const [f, setF] = useState({ user_id: "", event_name: "", client_name: "", checkin_time: "", checkout_time: "", checkin_street: "", checkout_street: "", calculated_hours: "" });
  const [busy, setBusy] = useState(false);

  const upd = (k, v) => setF({ ...f, [k]: v });

  const save = async () => {
    if (!f.user_id || !f.event_name.trim() || !f.client_name.trim() || !f.checkin_time) {
      toast.error(t("fillFields"));
      return;
    }
    setBusy(true);
    try {
      await api.post("/admin/shifts", {
        user_id: f.user_id,
        event_name: f.event_name,
        client_name: f.client_name,
        checkin_time: f.checkin_time,
        checkout_time: f.checkout_time || null,
        checkin_street: f.checkin_street || null,
        checkout_street: f.checkout_street || null,
        calculated_hours: f.calculated_hours ? parseFloat(f.calculated_hours) : null,
      });
      toast.success(t("shiftAdded"));
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = "mt-1 w-full rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors";

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" data-testid="admin-add-shift-modal">
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        className="bg-[#111827] border border-[#1F2937] rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">{t("addShift")}</h3>
          <button onClick={onClose} className="text-[#64748B] hover:text-white transition-colors"><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("selectWorker")}</label>
            <select data-testid="add-shift-worker" value={f.user_id} onChange={(e) => upd("user_id", e.target.value)} className={inputCls}>
              <option value="">—</option>
              {(workers || []).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("eventName")}</label>
              <input data-testid="add-shift-event" value={f.event_name} onChange={(e) => upd("event_name", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("clientName")}</label>
              <input data-testid="add-shift-client" value={f.client_name} onChange={(e) => upd("client_name", e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("checkInTime")}</label>
              <input data-testid="add-shift-checkin" type="datetime-local" value={f.checkin_time} onChange={(e) => upd("checkin_time", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("checkOutTime")}</label>
              <input data-testid="add-shift-checkout" type="datetime-local" value={f.checkout_time} onChange={(e) => upd("checkout_time", e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("checkInLocation")}</label>
              <input data-testid="add-shift-checkin-loc" value={f.checkin_street} onChange={(e) => upd("checkin_street", e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("checkOutLocation")}</label>
              <input data-testid="add-shift-checkout-loc" value={f.checkout_street} onChange={(e) => upd("checkout_street", e.target.value)} className={inputCls} />
            </div>
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("hoursOverride")}</label>
            <input data-testid="add-shift-hours" type="number" step="0.25" min="0" value={f.calculated_hours} onChange={(e) => upd("calculated_hours", e.target.value)} className={inputCls} />
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button onClick={onClose} className="rounded-xl px-4 py-2 text-sm bg-[#0B0F19] border border-[#1F2937] hover:text-white transition-colors">{t("cancel")}</button>
            <button data-testid="add-shift-save" onClick={save} disabled={busy} className="rounded-xl px-4 py-2 text-sm font-bold bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-60">{t("save")}</button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function WorkersManager({ t }) {
  const [workers, setWorkers] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);

  const load = useCallback(async () => {
    const { data } = await api.get("/workers");
    setWorkers(data);
    try {
      const s = await api.get("/admin/sync-status");
      setSyncStatus(s.data.last_sync);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/workers", form);
      setForm({ name: "", email: "", password: "" });
      toast.success(t("addWorker"));
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (w) => {
    await api.put(`/workers/${w.id}`, { active: !w.active });
    load();
  };

  const remove = async (w) => {
    if (!window.confirm(t("confirmDelete"))) return;
    await api.delete(`/workers/${w.id}`);
    load();
  };

  const resetPw = async (w) => {
    const np = window.prompt(`${t("resetPassword")} — ${w.name}`, "");
    if (np === null) return;
    if (np.trim().length < 6) {
      toast.error(t("passwordTooShort"));
      return;
    }
    try {
      await api.put(`/workers/${w.id}`, { password: np.trim() });
      toast.success(t("passwordChanged"));
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  const [syncing, setSyncing] = useState(false);
  const syncSheet = async () => {
    setSyncing(true);
    try {
      const { data } = await api.post("/admin/sync-sheet");
      toast.success(`${t("syncDone")}: +${data.created} / ~${data.updated} / -${data.deactivated}`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-emerald-400" />
            <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("addWorker")}</h2>
          </div>
          <button
            data-testid="sync-sheet-button"
            onClick={syncSheet}
            disabled={syncing}
            className="inline-flex items-center gap-2 text-sm font-bold rounded-xl bg-[#0B0F19] border border-emerald-600/40 text-emerald-400 px-3 py-2 hover:bg-emerald-600/10 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? t("syncing") : t("syncSheet")}
          </button>
        </div>
        <p className="text-xs text-[#64748B] mb-4" data-testid="sync-status">
          {syncStatus ? (
            <>
              {t("lastSyncLabel")}:{" "}
              <span className="text-[#94A3B8]">
                {new Date(syncStatus.created_at).toLocaleString("da-DK", { timeZone: "Europe/Copenhagen" })}
              </span>
              {" · "}
              <span className="text-emerald-400">+{syncStatus.created}</span>{" / "}
              <span className="text-blue-400">~{syncStatus.updated}</span>{" / "}
              <span className="text-red-400">-{syncStatus.deactivated}</span>
              {syncStatus.source === "cron" ? " · auto" : ""}
            </>
          ) : (
            t("neverSynced")
          )}
        </p>
        <form onSubmit={add} className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input data-testid="worker-form-name" required placeholder={t("name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <input data-testid="worker-form-email" required type="email" autoCapitalize="none" placeholder={t("email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <input data-testid="worker-form-password" required type="text" placeholder={t("password")} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <button data-testid="worker-form-submit" type="submit" disabled={busy} className="rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold px-4 py-3 transition-colors disabled:opacity-60">{t("addWorker")}</button>
        </form>
      </div>

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-5 h-5 text-emerald-400" />
          <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("workers")}</h2>
        </div>
        <div className="space-y-2" data-testid="workers-list">
          {workers.map((w) => (
            <div key={w.id} data-testid={`worker-item-${w.id}`} className="flex items-center gap-3 rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{w.name}</p>
                <p className="text-xs text-[#64748B] truncate">{w.email}</p>
              </div>
              <button onClick={() => toggleActive(w)} className={`text-xs font-bold rounded-lg px-2.5 py-1 border transition-colors ${w.active ? "bg-emerald-600/20 text-emerald-400 border-emerald-600/40" : "bg-gray-600/20 text-gray-400 border-gray-600/40"}`}>
                {w.active ? t("active") : t("inactive")}
              </button>
              <button data-testid={`worker-reset-pw-${w.id}`} onClick={() => resetPw(w)} title={t("resetPassword")}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[#94A3B8] hover:bg-[#1F2937] transition-colors">
                <KeyRound className="w-4 h-4" />
              </button>
              <button data-testid={`worker-delete-${w.id}`} onClick={() => remove(w)} className="w-8 h-8 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-600/20 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          {workers.length === 0 && <p className="text-sm text-[#64748B]">—</p>}
        </div>
      </div>
    </section>
  );
}

function EmailLog({ t, emails }) {
  return (
    <section className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Bell className="w-5 h-5 text-amber-400" />
        <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("emailLog")}</h2>
      </div>
      <div className="space-y-2" data-testid="email-log-list">
        {emails.map((e, i) => (
          <div key={i} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-sm">{e.subject}</span>
              <span className="text-[10px] uppercase tracking-wider rounded bg-[#1F2937] px-2 py-0.5 text-[#94A3B8]">{e.category}</span>
            </div>
            <p className="text-xs text-[#64748B] mt-1">→ {e.to}</p>
            <p className="text-xs text-[#94A3B8] mt-1 whitespace-pre-wrap line-clamp-4">{e.body}</p>
          </div>
        ))}
        {emails.length === 0 && <p className="text-sm text-[#64748B]">{t("noEmails")}</p>}
      </div>
    </section>
  );
}

function SettingsManager({ t }) {
  const { user } = useAuth();
  const [emails, setEmails] = useState({ alert_email: "", payroll_email: "" });
  const [admins, setAdmins] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [savingEmails, setSavingEmails] = useState(false);
  const [addingAdmin, setAddingAdmin] = useState(false);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [changingPw, setChangingPw] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.get("/admin/settings");
      setEmails(s.data);
      const a = await api.get("/admin/admins");
      setAdmins(a.data);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveEmails = async (e) => {
    e.preventDefault();
    setSavingEmails(true);
    try {
      const { data } = await api.put("/admin/settings", emails);
      setEmails(data);
      toast.success(t("settingsSaved"));
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setSavingEmails(false);
    }
  };

  const addAdmin = async (e) => {
    e.preventDefault();
    setAddingAdmin(true);
    try {
      await api.post("/admin/admins", form);
      setForm({ name: "", email: "", password: "" });
      toast.success(t("adminAdded"));
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setAddingAdmin(false);
    }
  };

  const removeAdmin = async (a) => {
    if (!window.confirm(t("confirmDeleteAdmin"))) return;
    try {
      await api.delete(`/admin/admins/${a.id}`);
      load();
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (pw.next.length < 6) { toast.error(t("passwordTooShort")); return; }
    if (pw.next !== pw.confirm) { toast.error(t("passwordMismatch")); return; }
    setChangingPw(true);
    try {
      await api.post("/auth/change-password", { current_password: pw.current, new_password: pw.next });
      setPw({ current: "", next: "", confirm: "" });
      toast.success(t("passwordChanged"));
    } catch (err) {
      toast.error(formatApiError(err.response?.data?.detail));
    } finally {
      setChangingPw(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="w-5 h-5 text-emerald-400" />
          <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("changePassword")}</h2>
        </div>
        <form onSubmit={changePassword} className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <input data-testid="change-pw-current" type="password" required autoComplete="current-password" placeholder={t("currentPassword")}
            value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })}
            className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <input data-testid="change-pw-new" type="password" required autoComplete="new-password" placeholder={t("newPassword")}
            value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })}
            className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <input data-testid="change-pw-confirm" type="password" required autoComplete="new-password" placeholder={t("confirmPassword")}
            value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
            className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <button data-testid="change-pw-submit" type="submit" disabled={changingPw}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold px-4 py-3 transition-colors disabled:opacity-60">
            {t("changePassword")}
          </button>
        </form>
      </div>

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Mail className="w-5 h-5 text-emerald-400" />
          <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("reportEmails")}</h2>
        </div>
        <form onSubmit={saveEmails} className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
          <div>
            <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("alertEmail")}</label>
            <input data-testid="settings-alert-email-input" type="email" autoCapitalize="none" required
              value={emails.alert_email || ""} onChange={(e) => setEmails({ ...emails, alert_email: e.target.value })}
              className="mt-1 w-full rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          </div>
          <div>
            <label className="text-xs uppercase tracking-wider text-[#94A3B8]">{t("payrollEmail")}</label>
            <input data-testid="settings-payroll-email-input" type="email" autoCapitalize="none" required
              value={emails.payroll_email || ""} onChange={(e) => setEmails({ ...emails, payroll_email: e.target.value })}
              className="mt-1 w-full rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          </div>
          <button data-testid="settings-save-button" type="submit" disabled={savingEmails}
            className="rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold px-4 py-3 transition-colors disabled:opacity-60">
            {t("saveSettings")}
          </button>
        </form>
      </div>

      <div className="bg-[#111827] border border-[#1F2937] rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-5 h-5 text-emerald-400" />
          <h2 className="text-xl font-bold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>{t("admins")}</h2>
        </div>
        <form onSubmit={addAdmin} className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-5">
          <input data-testid="admin-form-name" required placeholder={t("name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <input data-testid="admin-form-email" required type="email" autoCapitalize="none" placeholder={t("email")} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <input data-testid="admin-form-password" required type="text" placeholder={t("password")} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3 outline-none focus:border-emerald-500 transition-colors" />
          <button data-testid="admin-form-submit" type="submit" disabled={addingAdmin} className="rounded-xl bg-emerald-600 hover:bg-emerald-700 font-bold px-4 py-3 transition-colors disabled:opacity-60">{t("addAdmin")}</button>
        </form>
        <div className="space-y-2" data-testid="admins-list">
          {admins.map((a) => (
            <div key={a.id} data-testid={`admin-item-${a.id}`} className="flex items-center gap-3 rounded-xl bg-[#0B0F19] border border-[#1F2937] px-4 py-3">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{a.name} {a.id === user?.id && <span className="text-xs text-emerald-400">({t("you")})</span>}</p>
                <p className="text-xs text-[#64748B] truncate">{a.email}</p>
              </div>
              {a.id !== user?.id && (
                <button data-testid={`admin-delete-${a.id}`} onClick={() => removeAdmin(a)} className="w-8 h-8 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-600/20 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
