import React from "react";
import { useLang } from "@/i18n";

export const LangToggle = ({ className = "" }) => {
  const { lang, toggle } = useLang();
  return (
    <button
      data-testid="worker-lang-toggle"
      onClick={toggle}
      className={`relative flex items-center rounded-full border border-[#1F2937] bg-[#111827] p-1 text-xs font-bold ${className}`}
    >
      <span
        className={`px-3 py-1 rounded-full transition-colors ${
          lang === "en" ? "bg-emerald-600 text-white" : "text-[#9CA3AF]"
        }`}
      >
        EN
      </span>
      <span
        className={`px-3 py-1 rounded-full transition-colors ${
          lang === "da" ? "bg-emerald-600 text-white" : "text-[#9CA3AF]"
        }`}
      >
        DA
      </span>
    </button>
  );
};
