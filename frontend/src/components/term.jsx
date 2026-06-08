// Reusable UI bits for the terminal-green theme.
import { forwardRef } from "react";

export function PageHeader({ title, subtitle, action }) {
  return (
    <div className="flex items-start justify-between mb-6 pb-4 border-b border-zinc-800">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-zinc-100">{title}</h1>
        {subtitle && (
          <p className="text-sm text-zinc-500 mt-0.5 font-mono">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className = "", ...rest }) {
  return (
    <div
      {...rest}
      className={`bg-zinc-950 border border-zinc-800 rounded-sm ${className}`}
    >
      {children}
    </div>
  );
}

export const TermInput = forwardRef(function TermInput({ label, hint, error, className = "", ...rest }, ref) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[11px] font-mono uppercase tracking-widest text-zinc-400 mb-1.5">
          {label}
        </span>
      )}
      <input
        ref={ref}
        {...rest}
        className={`w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-sm px-3 py-2 text-sm font-mono placeholder:text-zinc-600 focus:border-green-500 focus:ring-1 focus:ring-green-500 transition-colors ${className}`}
      />
      {hint && !error && <span className="block text-[11px] text-zinc-600 mt-1">{hint}</span>}
      {error && <span className="block text-[11px] text-red-400 mt-1 font-mono">{error}</span>}
    </label>
  );
});

export function TermTextarea({ label, className = "", ...rest }) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[11px] font-mono uppercase tracking-widest text-zinc-400 mb-1.5">
          {label}
        </span>
      )}
      <textarea
        {...rest}
        className={`w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-sm px-3 py-2 text-sm font-mono placeholder:text-zinc-600 focus:border-green-500 focus:ring-1 focus:ring-green-500 transition-colors resize-y ${className}`}
      />
    </label>
  );
}

export function TermSelect({ label, children, className = "", ...rest }) {
  return (
    <label className="block">
      {label && (
        <span className="block text-[11px] font-mono uppercase tracking-widest text-zinc-400 mb-1.5">
          {label}
        </span>
      )}
      <select
        {...rest}
        className={`w-full bg-zinc-950 border border-zinc-800 text-zinc-200 rounded-sm px-3 py-2 text-sm font-mono focus:border-green-500 focus:ring-1 focus:ring-green-500 transition-colors ${className}`}
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
      className={`inline-flex items-center justify-center gap-2 bg-green-500 text-black hover:bg-green-400 disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed font-mono text-xs uppercase tracking-widest px-4 py-2 rounded-sm transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export function GhostButton({ children, className = "", ...rest }) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-2 bg-zinc-900 border border-zinc-800 hover:border-green-500/50 hover:text-green-400 text-zinc-300 font-mono text-xs uppercase tracking-widest px-3 py-2 rounded-sm transition-colors ${className}`}
    >
      {children}
    </button>
  );
}

export function Badge({ tone = "neutral", children, className = "" }) {
  const tones = {
    neutral: "bg-zinc-900 text-zinc-300 border-zinc-700",
    success: "bg-green-500/10 text-green-400 border-green-500/30",
    warning: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
    error: "bg-red-500/10 text-red-400 border-red-500/30",
    info: "bg-cyan-500/10 text-cyan-400 border-cyan-500/30",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest font-mono border rounded-sm ${tones[tone]} ${className}`}>
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
  const map = { active: "success", unverified: "warning", invalid: "error", draft: "neutral", sent: "info", sending: "warning" };
  return <Badge tone={map[status] || "neutral"}>{status}</Badge>;
}

export function EmptyState({ title, description, action }) {
  return (
    <div className="border border-dashed border-zinc-800 rounded-sm p-10 text-center">
      <div className="font-mono text-xs text-zinc-500 uppercase tracking-widest mb-2">/ empty</div>
      <div className="font-display text-lg text-zinc-200">{title}</div>
      {description && <div className="text-sm text-zinc-500 mt-1">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
