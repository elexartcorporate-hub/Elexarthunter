// Refined UI primitives — modern SaaS aesthetic
import { forwardRef } from "react";

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between mb-8 gap-4">
      <div>
        <h1 className="font-display text-[28px] font-bold text-slate-900 leading-tight">{title}</h1>
        {subtitle && (
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "", hoverable = false, ...rest }) {
  return (
    <div
      {...rest}
      className={`elegant-card ${hoverable ? "elegant-card-hover" : ""} ${className}`}
    >
      {children}
    </div>
  );
}

export const TermInput = forwardRef(function TermInput({ label, hint, error, className = "", ...rest }, ref) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[13px] font-medium text-slate-700 mb-1.5">
          {label}
        </span>
      )}
      <input
        ref={ref}
        {...rest}
        className={`w-full bg-white border border-slate-200 text-slate-900 rounded-lg px-3.5 py-2.5 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all ${className}`}
      />
      {hint && !error && <span className="block text-xs text-slate-500 mt-1.5">{hint}</span>}
      {error && <span className="block text-xs text-red-600 mt-1.5">{error}</span>}
    </label>
  );
});

export function TermTextarea({ label, className = "", ...rest }) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[13px] font-medium text-slate-700 mb-1.5">
          {label}
        </span>
      )}
      <textarea
        {...rest}
        className={`w-full bg-white border border-slate-200 text-slate-900 rounded-lg px-3.5 py-2.5 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all resize-y ${className}`}
      />
    </label>
  );
}

export function TermSelect({ label, children, className = "", ...rest }) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[13px] font-medium text-slate-700 mb-1.5">
          {label}
        </span>
      )}
      <select
        {...rest}
        className={`w-full bg-white border border-slate-200 text-slate-900 rounded-lg px-3.5 py-2.5 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all ${className}`}
      >
        {children}
      </select>
    </label>
  );
}

export function PrimaryButton({ children, className = "", ...rest }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 bg-indigo-600 text-white hover:bg-indigo-700 active:bg-indigo-800 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed font-medium text-sm px-4 py-2.5 rounded-lg shadow-sm hover:shadow transition-all ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = "", ...rest }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 bg-white border border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700 font-medium text-sm px-3.5 py-2.5 rounded-lg transition-all ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, className = "" }) {
  const tones = {
    neutral: "bg-slate-100 text-slate-700 border-slate-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
    warning: "bg-amber-50 text-amber-700 border-amber-200",
    error:   "bg-red-50 text-red-700 border-red-200",
    info:    "bg-indigo-50 text-indigo-700 border-indigo-200",
    purple:  "bg-purple-50 text-purple-700 border-purple-200",
    teal:    "bg-teal-50 text-teal-700 border-teal-200",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium border rounded-md ${tones[tone]} ${className}`}>
      {children}
    </span>
  );
}

export function ConfidenceBadge({ score = 0 }) {
  if (score >= 80) return <Badge tone="success">{score}</Badge>;
  if (score >= 50) return <Badge tone="warning">{score}</Badge>;
  return <Badge tone="error">{score}</Badge>;
}

export function StatusBadge({ status }) {
  const map = {
    active: "success", unverified: "warning", invalid: "error",
    draft: "neutral", sent: "info", sending: "warning",
  };
  return <Badge tone={map[status] || "neutral"}>{status}</Badge>;
}

export function EmptyState({ title, description, action, icon: Icon }) {
  return (
    <div className="bg-white border border-dashed border-slate-200 rounded-xl p-12 text-center">
      {Icon && (
        <div className="inline-flex items-center justify-center w-14 h-14 bg-slate-50 rounded-full mb-4">
          <Icon size={24} className="text-slate-400" />
        </div>
      )}
      <div className="font-display text-lg font-semibold text-slate-900">{title}</div>
      {description && <div className="text-sm text-slate-500 mt-1.5 max-w-md mx-auto">{description}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
