import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, Badge, EmptyState } from "@/components/term";
import {
  EnvelopeOpen, MagnifyingGlass, CalendarBlank, ArrowRight,
  CaretRight, XCircle, Clock, Buildings, UserCircle, ChartLine, Trash,
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

export default function EmailActivity() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [range, setRange] = useState("week");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [q, setQ] = useState("");
  const [openProjects, setOpenProjects] = useState(new Set());
  const [openProspects, setOpenProspects] = useState(new Set());
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
    return rows.filter((r) => `${r.to_email} ${r.subject} ${r.prospect_name || ""} ${r.task_name || ""} ${r.sender_name || ""}`.toLowerCase().includes(ql));
  }, [rows, q]);

  // 3-level tree: Project (task_id + date) → Prospects → Emails
  const projects = useMemo(() => {
    const projMap = new Map();
    for (const r of filtered) {
      const projKey = r.task_id || `__none__:${r.task_date || "no-date"}`;
      if (!projMap.has(projKey)) {
        projMap.set(projKey, {
          key: projKey,
          task_id: r.task_id,
          task_name: r.task_name || "(tanpa project)",
          task_date: r.task_date,
          task_status: r.task_status,
          senders: new Set(),
          prospects: new Map(),
          counts: {},
          total: 0,
          pending: 0,
          latest: null,
        });
      }
      const proj = projMap.get(projKey);
      const prosKey = r.prospect_id || r.prospect_name || "__unknown__";
      if (!proj.prospects.has(prosKey)) {
        proj.prospects.set(prosKey, {
          key: prosKey,
          prospect_id: r.prospect_id,
          prospect_name: r.prospect_name || "—",
          emails: [],
          counts: {},
          pending: 0,
        });
      }
      const pros = proj.prospects.get(prosKey);
      pros.emails.push(r);
      pros.counts[r.status] = (pros.counts[r.status] || 0) + 1;
      if (PENDING_STATUSES.has(r.status)) pros.pending += 1;

      if (r.sender_name) proj.senders.add(r.sender_name);
      proj.counts[r.status] = (proj.counts[r.status] || 0) + 1;
      proj.total += 1;
      if (PENDING_STATUSES.has(r.status)) proj.pending += 1;
      const when = r.sent_at || r.scheduled_at || r.created_at;
      if (when && (!proj.latest || when > proj.latest)) proj.latest = when;
    }
    return Array.from(projMap.values()).sort((a, b) => (b.task_date || b.latest || "").localeCompare(a.task_date || a.latest || ""));
  }, [filtered]);

  const stats = useMemo(() => {
    const s = { total: rows.length };
    STATUSES.forEach((k) => { s[k] = rows.filter((r) => r.status === k).length; });
    return s;
  }, [rows]);

  const toggleProj = (key) => {
    setOpenProjects((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };
  const toggleProspect = (key) => {
    setOpenProspects((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
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

  const cancelProject = async (taskId, taskName, pendingCount) => {
    if (!confirm(`Batalkan SEMUA ${pendingCount} email scheduled di project "${taskName}"?`)) return;
    setBusyId(`task-${taskId}`);
    try {
      const { data } = await api.post(`/scheduled-emails/cancel-task/${taskId}`);
      toast.success(`✓ ${data.cancelled} email di project dibatalkan`);
      setRows((prev) => prev.map((r) => (r.task_id === taskId && PENDING_STATUSES.has(r.status)
        ? { ...r, status: "cancelled", cancelled_at: new Date().toISOString() }
        : r)));
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setBusyId(null); }
  };

  const cancelProspect = async (prospectId, prospectName, pendingCount) => {
    if (!confirm(`Batalkan ${pendingCount} email scheduled ke ${prospectName}?`)) return;
    setBusyId(`prospect-${prospectId}`);
    try {
      const { data } = await api.post(`/scheduled-emails/cancel-prospect/${prospectId}`);
      toast.success(`✓ ${data.cancelled} email ke ${prospectName} dibatalkan`);
      setRows((prev) => prev.map((r) => (r.prospect_id === prospectId && PENDING_STATUSES.has(r.status)
        ? { ...r, status: "cancelled", cancelled_at: new Date().toISOString() }
        : r)));
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setBusyId(null); }
  };

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader title="Email Activity" subtitle="Per Project per Day → Prospect → Email · klik baris untuk lihat detail" />

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-7 gap-2 mb-5">
        <KpiPill label="Total" value={stats.total} tone="text-slate-900" active={status === ""} onClick={() => setStatus("")} testid="kpi-all" />
        {STATUSES.slice(0, 6).map((s) => (
          <KpiPill key={s} label={s} value={stats[s] || 0}
            tone={`text-${TONE[s] === "success" ? "emerald" : TONE[s] === "info" ? "cyan" : TONE[s] === "purple" ? "indigo" : TONE[s] === "error" ? "rose" : TONE[s] === "warning" ? "amber" : "slate"}-600`}
            active={status === s} onClick={() => setStatus(s)} testid={`kpi-${s}`} />
        ))}
      </div>

      {/* Filter bar */}
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
              placeholder="Cari company / project / sales / subject…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              data-testid="activity-search"
            />
          </div>
        </div>
      </Card>

      {/* 3-level tree */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="text-center py-10 text-slate-500">Loading…</div>
        ) : projects.length === 0 ? (
          <EmptyState icon={EnvelopeOpen} title="No emails yet" description="Send your first email from a prospect's detail page." />
        ) : (
          <div className="divide-y divide-slate-100">
            {projects.map((proj) => {
              const isProjOpen = openProjects.has(proj.key);
              const prospectsArr = Array.from(proj.prospects.values()).sort((a, b) => (b.emails.length - a.emails.length));
              return (
                <div key={proj.key} data-testid={`proj-${proj.key}`}>
                  {/* LEVEL 1 — Project row */}
                  <button
                    type="button"
                    onClick={() => toggleProj(proj.key)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-indigo-50/30 text-left transition"
                    data-testid={`proj-toggle-${proj.key}`}
                  >
                    <CaretRight size={14} weight="bold" className={`text-slate-400 shrink-0 transition-transform ${isProjOpen ? "rotate-90" : ""}`} />
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-100 to-purple-100 text-indigo-600 grid place-items-center shrink-0">
                      <ChartLine size={18} weight="bold" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className="font-medium text-sm text-slate-900 truncate max-w-[280px]" title={proj.task_name}>
                          {proj.task_name}
                        </div>
                        {proj.task_date && <Badge tone="info"><CalendarBlank size={10} weight="bold" /> {proj.task_date}</Badge>}
                        {proj.task_status && <Badge tone="neutral">{proj.task_status}</Badge>}
                      </div>
                      <div className="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
                        <UserCircle size={12} weight="bold" className="text-indigo-500" />
                        <span>{proj.senders.size > 0 ? Array.from(proj.senders).join(", ") : "—"}</span>
                        <span>·</span>
                        <span>{proj.prospects.size} prospect · {proj.total} email{proj.total > 1 ? "s" : ""}</span>
                        {proj.latest && <><span>·</span><span>{fmtRelative(proj.latest)}</span></>}
                      </div>
                    </div>
                    {/* Status pills inline */}
                    <div className="hidden md:flex items-center gap-1 shrink-0">
                      {["scheduled", "delivered", "bounce", "cancelled"].map((s) => (proj.counts[s] ? (
                        <Badge key={s} tone={TONE[s]}>{proj.counts[s]} {s}</Badge>
                      ) : null))}
                    </div>
                    {/* Cancel Project (only if has pending + task_id) */}
                    {proj.pending > 0 && proj.task_id && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(e) => { e.stopPropagation(); cancelProject(proj.task_id, proj.task_name, proj.pending); }}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); cancelProject(proj.task_id, proj.task_name, proj.pending); } }}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 shrink-0 cursor-pointer"
                        data-testid={`cancel-proj-${proj.task_id}`}
                        title={`Batalkan ${proj.pending} email scheduled di project ini`}
                      >
                        <Trash size={12} weight="bold" />
                        {busyId === `task-${proj.task_id}` ? "…" : `Cancel Project (${proj.pending})`}
                      </span>
                    )}
                  </button>

                  {/* LEVEL 2 — Prospects expanded inside project */}
                  {isProjOpen && (
                    <div className="bg-slate-50/60 border-t border-slate-100 px-4 py-3 space-y-2">
                      {prospectsArr.map((pros) => {
                        const isProsOpen = openProspects.has(`${proj.key}:${pros.key}`);
                        return (
                          <div key={pros.key} className="bg-white border border-slate-200 rounded-lg overflow-hidden" data-testid={`pros-${pros.key}`}>
                            {/* Prospect row */}
                            <button
                              type="button"
                              onClick={() => toggleProspect(`${proj.key}:${pros.key}`)}
                              className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 text-left transition"
                              data-testid={`pros-toggle-${pros.key}`}
                            >
                              <CaretRight size={12} weight="bold" className={`text-slate-400 shrink-0 transition-transform ${isProsOpen ? "rotate-90" : ""}`} />
                              <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 grid place-items-center shrink-0">
                                <Buildings size={14} weight="bold" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-slate-800 truncate">{pros.prospect_name}</div>
                                <div className="text-[10px] text-slate-500">
                                  {pros.emails.length} email{pros.emails.length > 1 ? "s" : ""}
                                </div>
                              </div>
                              <div className="hidden sm:flex items-center gap-1 shrink-0">
                                {STATUSES.map((s) => (pros.counts[s] ? (
                                  <Badge key={s} tone={TONE[s]}>{pros.counts[s]} {s}</Badge>
                                ) : null))}
                              </div>
                              {pros.pending > 0 && pros.prospect_id && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => { e.stopPropagation(); cancelProspect(pros.prospect_id, pros.prospect_name, pros.pending); }}
                                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); cancelProspect(pros.prospect_id, pros.prospect_name, pros.pending); } }}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 shrink-0 cursor-pointer"
                                  data-testid={`cancel-pros-${pros.prospect_id}`}
                                  title="Batalkan semua email scheduled ke prospect ini"
                                >
                                  <XCircle size={10} weight="bold" />
                                  {busyId === `prospect-${pros.prospect_id}` ? "…" : `Cancel (${pros.pending})`}
                                </span>
                              )}
                              {pros.prospect_id && (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => { e.stopPropagation(); navigate(`/prospects/${pros.prospect_id}`); }}
                                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); navigate(`/prospects/${pros.prospect_id}`); } }}
                                  className="text-indigo-600 hover:text-indigo-800 p-1 shrink-0 cursor-pointer"
                                  title="Buka detail prospect"
                                >
                                  <ArrowRight size={12} weight="bold" />
                                </span>
                              )}
                            </button>

                            {/* LEVEL 3 — Individual emails */}
                            {isProsOpen && (
                              <div className="border-t border-slate-100 bg-slate-50/30 overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead className="bg-white text-slate-500 text-[10px] uppercase tracking-wide">
                                    <tr>
                                      <th className="text-left px-3 py-2 whitespace-nowrap">When</th>
                                      <th className="text-left px-3 py-2 whitespace-nowrap">To</th>
                                      <th className="text-left px-3 py-2 whitespace-nowrap">Subject</th>
                                      <th className="text-left px-3 py-2 whitespace-nowrap">Status</th>
                                      <th className="text-center px-3 py-2 whitespace-nowrap">Opens</th>
                                      <th className="text-center px-3 py-2 whitespace-nowrap">Clicks</th>
                                      <th className="text-right px-3 py-2 whitespace-nowrap">Action</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {pros.emails.map((s) => {
                                      const isPending = PENDING_STATUSES.has(s.status);
                                      return (
                                        <tr key={s.id} className="border-t border-slate-100 hover:bg-white">
                                          <td className="px-3 py-2 whitespace-nowrap max-w-[140px] truncate" title={fmtTime(s.sent_at || s.scheduled_at || s.created_at)}>
                                            {s.status === "scheduled" && s.scheduled_at ? (
                                              <span className="text-purple-600 font-medium inline-flex items-center gap-1">
                                                <Clock size={10} weight="bold" /> {fmtTime(s.scheduled_at)}
                                              </span>
                                            ) : (
                                              <span className="text-slate-500">{fmtTime(s.sent_at || s.created_at)}</span>
                                            )}
                                          </td>
                                          <td className="px-3 py-2 font-mono text-[11px] text-slate-900 whitespace-nowrap max-w-[200px] truncate" title={s.to_email}>{s.to_email}</td>
                                          <td className="px-3 py-2 text-slate-700 whitespace-nowrap max-w-[220px] truncate" title={s.subject}>{s.subject}</td>
                                          <td className="px-3 py-2 whitespace-nowrap">
                                            <Badge tone={TONE[s.status] || "neutral"}>{s.status}</Badge>
                                            {s.status === "bounce" && s.error && (
                                              <div className="text-[10px] text-rose-600 mt-1 max-w-[180px] leading-tight truncate" title={s.error}>⚠ {s.error}</div>
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
                            )}
                          </div>
                        );
                      })}
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
