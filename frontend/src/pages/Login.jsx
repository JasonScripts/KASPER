import React, { useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Clock, Eye, EyeOff } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useLang } from "@/i18n";
import { formatApiError } from "@/lib/api";
import { LangToggle } from "@/components/LangToggle";

export default function Login() {
  const { login } = useAuth();
  const { t } = useLang();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(formatApiError(err.response?.data?.detail) || err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-between max-w-md mx-auto p-6 bg-[#0B0F19] text-[#F9FAFB] relative overflow-hidden">
      <div className="absolute -top-24 -right-24 w-72 h-72 rounded-full bg-emerald-600/10 blur-3xl pointer-events-none" />
      <div className="flex justify-end pt-2">
        <LangToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="flex-1 flex flex-col justify-center"
      >
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 rounded-2xl bg-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-600/30">
            <Clock className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold tracking-tight" style={{ fontFamily: "Outfit, sans-serif" }}>
              {t("appName")}
            </h1>
            <p className="text-xs font-mono uppercase tracking-widest text-emerald-400">{t("appSub")}</p>
          </div>
        </div>

        <form onSubmit={submit} className="mt-8 space-y-4">
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-[#9CA3AF]">{t("email")}</label>
            <input
              data-testid="worker-login-email-input"
              type="email"
              autoCapitalize="none"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 w-full rounded-xl bg-[#111827] border border-[#1F2937] px-4 py-4 text-base outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wider text-[#9CA3AF]">{t("password")}</label>
            <div className="relative mt-1">
              <input
                data-testid="worker-login-password-input"
                type={showPw ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full rounded-xl bg-[#111827] border border-[#1F2937] px-4 py-4 pr-12 text-base outline-none focus:border-emerald-500 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPw((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#6B7280] hover:text-white transition-colors"
                data-testid="toggle-password-visibility"
              >
                {showPw ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {error && (
            <p data-testid="login-error" className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            data-testid="worker-login-submit-button"
            type="submit"
            disabled={loading}
            className="w-full rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-bold text-lg py-4 shadow-lg shadow-emerald-600/30 transition-transform transition-colors flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
            {loading ? t("loggingIn") : t("login")}
          </button>
        </form>
      </motion.div>

      <p className="text-center text-xs text-[#6B7280] pb-2">© {new Date().getFullYear()} QAKK</p>
    </div>
  );
}
