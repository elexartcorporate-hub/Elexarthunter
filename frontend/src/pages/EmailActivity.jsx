import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, Badge, EmptyState } from "@/components/term";
import {
  EnvelopeOpen, MagnifyingGlass, CalendarBlank, ArrowRight,
  CaretRight, XCircle, Clock, Buildings, UserCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const STATUSES = ["scheduled", "queued", "delivered", "opened", "clicked", "replied", "bounce", "unsubscribed", "cancelled"];
const TONE = {
  scheduled: "purple", queued: "neutral", delivered: "success", opened: "info",
  clicked: "purple", replied: "success", bounce: "error", unsubscribed: "warning", cancelled: "neutral",
};
const RANGES = [
  { key: "today",  label: "Today" },
  { key: "week",   label: "This Week" },
  { key: "month",  label: "This Month" },
  { key: "custom", label: "Custom" },
  { key: "all",    label: "All Time" },
];
const PENDING_STATUSES = new Set(["scheduled", "queued"]);

const dayKey = (iso) => {
  if (!iso) return "no-date";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export default function EmailActivity() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [q, setQ] = useState("");
  const [openGroups, setOpenGroups] = useState(new Set());
  const [busyId, setBusyId] = useState(null);

  const computeRange = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (range === "today") return { date_from: today.toISOString() };
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
    return rows.filter((r) => `${r.to_email} ${r.subject} ${r.prospect_name || ""} ${r.sender_name || ""}`.toLowerCase().includes(ql));
  }, [rows, q]);

  // Group by Prospect + Day. Key = `${prospect_id}|${YYYY-MM-DD}` based on
  // the email's send/schedule day (or task_date if email was scheduled to a future day).
  const groups = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const when = r.task_date || r.scheduled_at || r.sent_at || r.created_at;
      const day = r.task_date || dayKey(when);
      const proKey = r.prospect_id || r.prospect_name || "__unknown__";
      const key = `${proKey}|${day}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          prospect_id: r.prospect_id,
          prospect_name: r.prospect_name || "—",
          day,
          senders: new Set(),
          emails: [],
          counts: {},
          pending: 0,
          latest: null,
        });
      }
      const g = map.get(key);
      g.emails.push(r);
      g.counts[r.status] = (g.counts[r.status] || 0) + 1;
      if (PENDING_STATUSES.has(r.status)) g.pending += 1;
      if (r.sender_name) g.senders.add(r.sender_name);
      const whenIso = r.sent_at || r.scheduled_at || r.created_at;
      if (whenIso && (!g.latest || whenIso > g.latest)) g.latest = whenIso;
    }
    // Sort: by day desc, then latest desc
    return Array.from(map.values()).sort((a, b) => {
      if (b.day !== a.day) return (b.day || "").localeCompare(a.day || "");
      return (b.latest || "").localeCompare(a.latest || "");
    });
  }, [filtered]);

  const stats = useMemo(() => {
    const s = { total: rows.length };
    STATUSES.forEach((k) => { s[k] = rows.filter((r) => r.status === k).length; });
    return s;
  }, [rows]);

  const toggle = (key) => {
    setOpenGroups((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  const cancelOne = async (sendId, toEmail) => {
    if (!confirm(`Batalkan email ke ${toEmail}?`)) return;
    setBusyId(sendId);
    try {
      await api.post(`/scheduled-emails/${sendId}/cancel`);
      toast.success(`✓ Email ke ${toEmail} dibatalkan`);
      setRows((prev) => prev.map((r) => (r.id === sendId ? { ...r, status: "cancelled", cancelled_at: new Date().toISOString() } : r)));
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setBusyId(null); }
  };

  const cancelGroup = async (group) => {
    // Cancel all pending emails in this prospect-day group.
    // Loop individual sendIds (so we only touch emails of THIS day, not all pending for prospect across days).
    const pendingIds = group.emails.filter((e) => PENDING_STATUSES.has(e.status)).map((e) => e.id);
    if (pendingIds.length === 0) return;
    if (!confirm(`Batalkan ${pendingIds.length} email scheduled ke ${group.prospect_name} (${group.day})?`)) return;
    setBusyId(`group-${group.key}`);
    try {
      const results = await Promise.allSettled(
        pendingIds.map((id) => api.post(`/scheduled-emails/${id}/cancel`))
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      toast.success(`✓ ${ok} email dibatalkan`);
      setRows((prev) => prev.map((r) => (pendingIds.includes(r.id)
        ? { ...r, status: "cancelled", cancelled_at: new Date().toISOString() }
        : r)));
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setBusyId(null); }
  };

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader title="Email Activity" subtitle="Laporan per Prospect per Hari — klik baris untuk lihat semua email yang akan dikirim" />

      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 mb-5">
        <KpiPill label="Total" value={stats.total} tone="text-slate-900" active={status === ""} onClick={() => setStatus("")} testid="kpi-all" />
        {STATUSES.slice(0, 6).map((s) => (
          <KpiPill key={s} label={s} value={stats[s] || 0}
            tone={`text-${TONE[s] === "success" ? "emerald" : TONE[s] === "info" ? "cyan" : TONE[s] === "purple" ? "indigo" : TONE[s] === "error" ? "rose" : TONE[s] === "warning" ? "amber" : "slate"}-600`}
            active={status === s} onClick={() => setStatus(s)} testid={`kpi-${s}`} />
        ))}
      </div>

      <Card className="p-4 mb-4">
        <div className="flex flex-wrap items-center gap-2">
          {RANGES.map((r) => (
            <button key={r.key} onClick={() => setRange(r.key)} data-testid={`range-${r.key}`}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                range === r.key ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
              }`}>
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
              placeholder="Cari company / sales / subject…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="activity-search"
            />
          </div>
        </div>
      </Card>

      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="text-center py-10 text-slate-500">Loading…</div>
        ) : groups.length === 0 ? (
          <EmptyState icon={EnvelopeOpen} title="No emails yet" description="Send your first email from a prospect's detail page." />
        ) : (
          <div className="divide-y divide-slate-100">
            {groups.map((g) => {
              const isOpen = openGroups.has(g.key);
              return (
                <div key={g.key} data-testid={`group-${g.key}`}>
                  {/* Prospect-per-Day row */}
                  <button
                    type="button"
                    onClick={() => toggle(g.key)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-indigo-50/30 text-left transition"
                    data-testid={`group-toggle-${g.key}`}
                  >
                    <CaretRight size={14} weight="bold" className={`text-slate-400 shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                    <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 grid place-items-center shrink-0">
                      <Buildings size={18} weight="bold" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium text-sm text-slate-900 truncate max-w-[280px]" title={g.prospect_name}>
                          {g.prospect_name}
                        </div>
                        <Badge tone="info"><CalendarBlank size={10} weight="bold" /> {g.day}</Badge>
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                        <UserCircle size={12} weight="bold" className="text-indigo-500" />
                        <span>{g.senders.size > 0 ? Array.from(g.senders).join(", ") : "—"}</span>
                        <span>·</span>
                        <span>{g.emails.length} email{g.emails.length > 1 ? "s" : ""}</span>
                        {g.latest && <><span>·</span><span>{fmtRelative(g.latest)}</span></>}
                      </div>
                    </div>
                    {/* Status count pills inline */}
                    <div className="hidden md:flex items-center gap-1 shrink-0">
                      {STATUSES.map((s) => (g.counts[s] ? (
                        <Badge key={s} tone={TONE[s]}>{g.counts[s]} {s}</Badge>
                      ) : null))}
                    </div>
                    {/* Cancel All (pending in this prospect-day) */}
                    {g.pending > 0 && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); cancelGroup(g); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); cancelGroup(g); } }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 shrink-0 cursor-pointer"
                        data-testid={`cancel-group-${g.key}`}
                        title={`Batalkan ${g.pending} email scheduled di prospect-day ini`}
                      >
                        <XCircle size={11} weight="bold" />
                        {busyId === `group-${g.key}` ? "…" : `Cancel All (${g.pending})`}
                      </span>
                    )}
                    {g.prospect_id && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); navigate(`/prospects/${g.prospect_id}`); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); navigate(`/prospects/${g.prospect_id}`); } }}
                        className="text-indigo-600 hover:text-indigo-800 p-1 shrink-0 cursor-pointer"
                        title="Buka detail prospect"
                      >
                        <ArrowRight size={14} weight="bold" />
                      </span>
                    )}
                  </button>

                  {/* Detail emails (semua email queue/sent untuk prospect-day ini) */}
                  {isOpen && (
                    <div className="bg-slate-50/50 px-4 pb-4 pt-1">
                      <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wide">
                            <tr>
                              <th className="text-left px-3 py-2 whitespace-nowrap">When</th>
                              <th className="text-left px-3 py-2 whitespace-nowrap">To</th>
                              <th className="text-left px-3 py-2 whitespace-nowrap">Subject</th>
                              <th className="text-left px-3 py-2 whitespace-nowrap">Sender</th>
                              <th className="text-left px-3 py-2 whitespace-nowrap">Status</th>
                              <th className="text-center px-3 py-2 whitespace-nowrap">Opens</th>
                              <th className="text-center px-3 py-2 whitespace-nowrap">Clicks</th>
                              <th className="text-right px-3 py-2 whitespace-nowrap">Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.emails.map((s) => {
                              const isPending = PENDING_STATUSES.has(s.status);
                              return (
                                <tr key={s.id} className="border-t border-slate-100 hover:bg-slate-50">
                                  <td className="px-3 py-2 whitespace-nowrap max-w-[140px] truncate" title={fmtTime(s.sent_at || s.scheduled_at || s.created_at)}>
                                    {s.status === "scheduled" && s.scheduled_at ? (
                                      <span className="text-purple-600 font-medium inline-flex items-center gap-1">
                                        <Clock size={11} weight="bold" /> {fmtTime(s.scheduled_at)}
                                      </span>
                                    ) : (
                                      <span className="text-slate-500">{fmtTime(s.sent_at || s.created_at)}</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 font-mono text-[11px] text-slate-900 whitespace-nowrap max-w-[200px] truncate" title={s.to_email}>{s.to_email}</td>
                                  <td className="px-3 py-2 text-slate-700 whitespace-nowrap max-w-[220px] truncate" title={s.subject}>{s.subject}</td>
                                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap max-w-[120px] truncate" title={s.sender_name || ""}>{s.sender_name || "—"}</td>
                                  <td className="px-3 py-2 whitespace-nowrap">
                                    <Badge tone={TONE[s.status] || "neutral"}>{s.status}</Badge>
                                    {s.status === "bounce" && s.error && (
                                      <div className="text-[10px] text-rose-600 mt-1 max-w-[200px] leading-tight truncate" title={s.error}>⚠ {s.error}</div>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-center">{s.opens > 0 ? <Badge tone="info">{s.opens}</Badge> : <span className="text-slate-400">0</span>}</td>
                                  <td className="px-3 py-2 text-center">{s.clicks > 0 ? <Badge tone="purple">{s.clicks}</Badge> : <span className="text-slate-400">0</span>}</td>
                                  <td className="px-3 py-2 text-right whitespace-nowrap">
                                    {isPending ? (
                                      <button
                                        onClick={() => cancelOne(s.id, s.to_email)}
                                        disabled={busyId === s.id}
                                        className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 disabled:opacity-50"
                                        data-testid={`cancel-${s.id}`}
                                      >
                                        <XCircle size={10} weight="bold" />
                                        {busyId === s.id ? "…" : "Cancel"}
                                      </button>
                                    ) : (
                                      <span className="text-slate-300 text-[10px]">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 0) {
    const f = Math.abs(diff);
    if (f < 3600) return `dalam ${Math.round(f / 60)}m`;
    if (f < 86400) return `dalam ${Math.round(f / 3600)}j`;
    return `dalam ${Math.round(f / 86400)}h`;
  }
  if (diff < 60)   return "baru saja";
  if (diff < 3600) return `${Math.round(diff / 60)}m lalu`;
  if (diff < 86400) return `${Math.round(diff / 3600)}j lalu`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)}h lalu`;
  return d.toLocaleDateString("id-ID");
}
