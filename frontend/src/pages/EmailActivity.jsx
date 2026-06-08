import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermSelect, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import { EnvelopeOpen, MagnifyingGlass, CalendarBlank, ArrowRight } from "@phosphor-icons/react";
import { toast } from "sonner";

const STATUSES = ["queued", "delivered", "opened", "clicked", "replied", "bounce", "unsubscribed"];
const TONE = {
  queued: "neutral", delivered: "success", opened: "info",
  clicked: "purple", replied: "success", bounce: "error", unsubscribed: "warning",
};
const RANGES = [
  { key: "today",     label: "Today" },
  { key: "week",      label: "This Week" },
  { key: "month",     label: "This Month" },
  { key: "custom",    label: "Custom" },
  { key: "all",       label: "All Time" },
];

export default function EmailActivity() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [q, setQ] = useState("");

  const computeRange = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (range === "today")
      return { date_from: today.toISOString() };
    if (range === "week") {
      const w = new Date(today); w.setDate(w.getDate() - 7);
      return { date_from: w.toISOString() };
    }
    if (range === "month") {
      const m = new Date(today.getFullYear(), today.getMonth(), 1);
      return { date_from: m.toISOString() };
    }
    if (range === "custom") {
      const r = {};
      if (customFrom) r.date_from = new Date(customFrom).toISOString();
      if (customTo)   r.date_to   = new Date(customTo + "T23:59:59").toISOString();
      return r;
    }
    return {};
  };

  const load = async () => {
    setLoading(true);
    try {
      const params = { ...computeRange() };
      if (status) params.status = status;
      const { data } = await api.get("/email-sends", { params });
      setRows(data);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [status, range, customFrom, customTo]);

  const filtered = useMemo(() => {
    if (!q) return rows;
    const ql = q.toLowerCase();
    return rows.filter((r) => `${r.to_email} ${r.subject} ${r.prospect_name || ""}`.toLowerCase().includes(ql));
  }, [rows, q]);

  const stats = useMemo(() => {
    const s = { total: rows.length };
    STATUSES.forEach((k) => { s[k] = rows.filter((r) => r.status === k).length; });
    return s;
  }, [rows]);

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader title="Email Activity" subtitle="Track all outbound emails — delivery, opens, clicks, bounces" />

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 mb-5">
        <KpiPill label="Total"     value={stats.total}        tone="text-slate-900" active={status === ""} onClick={() => setStatus("")} testid="kpi-all" />
        {STATUSES.map((s) => (
          <KpiPill key={s} label={s} value={stats[s] || 0} tone={`text-${TONE[s] === "success" ? "emerald" : TONE[s] === "info" ? "cyan" : TONE[s] === "purple" ? "indigo" : TONE[s] === "error" ? "rose" : TONE[s] === "warning" ? "amber" : "slate"}-600`} active={status === s} onClick={() => setStatus(s)} testid={`kpi-${s}`} />
        ))}
      </div>

      {/* Range filter */}
      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              data-testid={`range-${r.key}`}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                range === r.key ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
              }`}
            >
              <CalendarBlank size={12} weight="bold" className="inline mr-1" />{r.label}
            </button>
          ))}
          {range === "custom" && (
            <div className="flex items-center gap-2 ml-2">
              <input type="date" className="px-2 py-1 border border-slate-200 rounded-lg text-xs" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
              <span className="text-xs text-slate-400">→</span>
              <input type="date" className="px-2 py-1 border border-slate-200 rounded-lg text-xs" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </div>
          )}
          <div className="relative ml-auto">
            <MagnifyingGlass size={14} weight="bold" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="pl-9 pr-3 py-1.5 border border-slate-200 rounded-lg text-xs w-72 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Search by email / subject / company..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="activity-search"
            />
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="text-center py-10 text-slate-500">Loading...</div>
        ) : filtered.length === 0 ? (
          <EmptyState icon={EnvelopeOpen} title="No emails yet" description="Send your first email from a prospect's detail page." />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
              <tr>
                <th className="text-left p-3">When</th>
                <th className="text-left p-3">To</th>
                <th className="text-left p-3">Subject</th>
                <th className="text-left p-3">Prospect</th>
                <th className="text-left p-3">Sender</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Opens</th>
                <th className="text-left p-3">Clicks</th>
                <th className="text-right p-3"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="p-3 text-xs text-slate-500">{fmtTime(s.created_at)}</td>
                  <td className="p-3 font-mono text-xs text-slate-900">{s.to_email}</td>
                  <td className="p-3 text-xs text-slate-700 max-w-xs truncate">{s.subject}</td>
                  <td className="p-3 text-xs text-slate-700">{s.prospect_name || "—"}</td>
                  <td className="p-3 text-xs text-slate-500">{s.sender_name || "—"}</td>
                  <td className="p-3"><Badge tone={TONE[s.status] || "neutral"}>{s.status}</Badge></td>
                  <td className="p-3 text-xs">{s.opens > 0 ? <Badge tone="info">{s.opens}</Badge> : <span className="text-slate-400">0</span>}</td>
                  <td className="p-3 text-xs">{s.clicks > 0 ? <Badge tone="purple">{s.clicks}</Badge> : <span className="text-slate-400">0</span>}</td>
                  <td className="p-3 text-right">
                    {s.prospect_id && (
                      <button onClick={() => navigate(`/prospects/${s.prospect_id}`)} className="text-indigo-600 hover:text-indigo-800" data-testid={`open-prospect-${s.id}`}>
                        <ArrowRight size={14} weight="bold" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function KpiPill({ label, value, tone, active, onClick, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`text-left p-3 rounded-xl border transition-all ${
        active ? "border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50" : "border-slate-200 bg-white hover:border-slate-300"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">{label}</div>
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
    </button>
  );
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString();
}
