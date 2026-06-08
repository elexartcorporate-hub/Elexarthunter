import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermSelect, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Plus, MagnifyingGlass, Crosshair, ListBullets, UsersFour, At, Globe, Buildings,
  CaretRight, Spinner, PaperPlaneTilt, FloppyDisk, CheckCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const STATUSES = ["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"];
const STATUS_TONE = {
  "New": "neutral",
  "Contacted": "info",
  "Interested": "warning",
  "Meeting Scheduled": "purple",
  "Customer": "success",
  "Lost": "error",
};

export default function Prospects() {
  const [tab, setTab] = useState("add");
  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader title="Prospects" subtitle="Discover, save and engage prospects from one place" />
      <div className="flex border border-slate-200 rounded-lg overflow-hidden w-fit bg-white mb-6 shadow-sm">
        <TabBtn active={tab === "add"}  onClick={() => setTab("add")}  icon={Crosshair}    label="Add Prospect" testid="tab-add" />
        <TabBtn active={tab === "list"} onClick={() => setTab("list")} icon={ListBullets}  label="Prospect List" testid="tab-list" />
      </div>
      {tab === "add"  && <AddProspect />}
      {tab === "list" && <ProspectList />}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2.5 text-sm font-medium flex items-center gap-2 transition-colors border-r border-slate-200 last:border-r-0 ${
        active ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
      }`}
    >
      <Icon size={16} weight="bold" />
      {label}
    </button>
  );
}

/* ─────────────── TAB 1: ADD PROSPECT (search emails by domain) ─────────────── */
function AddProspect() {
  const navigate = useNavigate();
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);

  const search = async () => {
    if (!domain.trim()) return toast.error("Enter a domain");
    setLoading(true); setResult(null); setSavedId(null);
    try {
      const { data } = await api.post("/prospects/discover", { domain: domain.trim() });
      setResult(data);
      toast.success(`Found ${data.emails.length} email(s) on ${data.domain}`);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally { setLoading(false); }
  };

  const saveProspect = async (sendAfter = false) => {
    if (!result) return;
    try {
      const payload = {
        company_name: result.company.company_name || result.domain,
        website: `https://${result.domain}`,
        domain: result.domain,
        industry: result.company.industry,
        country: result.company.country,
        phone: (result.company.phones || [])[0] || null,
        linkedin: result.company.socials?.linkedin,
        emails: result.emails.map((e, i) => ({
          email: e.email, is_primary: i === 0, status: e.status, confidence: e.confidence, source: e.source,
        })),
      };
      const { data } = await api.post("/prospects", payload);
      setSavedId(data.id);
      toast.success(`Saved as prospect: ${data.company_name}`);
      if (sendAfter) {
        navigate(`/prospects/${data.id}?send=1`);
      }
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="text-sm font-medium text-slate-700 mb-2">Search a domain for emails</div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Globe size={16} weight="bold" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full pl-9 pr-3 py-2.5 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && search()}
              data-testid="discover-domain-input"
            />
          </div>
          <PrimaryButton onClick={search} disabled={loading} data-testid="discover-search-btn">
            {loading ? <><Spinner size={14} weight="bold" className="animate-spin" /> Searching...</>
                     : <><Crosshair size={14} weight="bold" /> Search Emails</>}
          </PrimaryButton>
        </div>
        <div className="text-[11px] text-slate-500 mt-2">Discovery pipeline: Playwright deep crawl + Hunter.io (mock). Cache 30 days.</div>
      </Card>

      {result && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <Buildings size={18} weight="bold" className="text-indigo-600" />
                <h3 className="font-display text-lg font-semibold text-slate-900">{result.company.company_name || result.domain}</h3>
                {result.cached && <Badge tone="neutral">cached {result.age_days}d</Badge>}
              </div>
              <div className="text-xs text-slate-500 flex flex-wrap gap-3">
                <span>🌐 {result.domain}</span>
                {result.company.industry && <span>Industry: {result.company.industry}</span>}
                {result.company.country && <span>{result.company.country}</span>}
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <GhostButton onClick={() => saveProspect(false)} disabled={savedId} data-testid="save-prospect-btn">
                <FloppyDisk size={14} weight="bold" /> {savedId ? "Saved" : "Save Prospect"}
              </GhostButton>
              <PrimaryButton onClick={() => saveProspect(true)} disabled={savedId} data-testid="save-send-btn">
                <PaperPlaneTilt size={14} weight="bold" /> Save & Send Email
              </PrimaryButton>
            </div>
          </div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500 font-medium mb-2">Emails found ({result.emails.length})</div>
          {result.emails.length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center border border-dashed border-slate-200 rounded-lg">No emails discovered</div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                  <tr><th className="text-left p-2">Email</th><th className="text-left p-2">Name</th><th className="text-left p-2">Title</th><th className="text-left p-2">Source</th><th className="text-left p-2">Score</th><th className="text-left p-2">Status</th></tr>
                </thead>
                <tbody>
                  {result.emails.map((e, i) => (
                    <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="p-2 font-mono text-xs text-slate-900">{e.email}</td>
                      <td className="p-2 text-xs text-slate-700">{e.name || "—"}</td>
                      <td className="p-2 text-xs text-slate-500">{e.job_title || "—"}</td>
                      <td className="p-2"><Badge tone="neutral">{e.source || "—"}</Badge></td>
                      <td className="p-2"><Badge tone={e.confidence >= 80 ? "success" : e.confidence >= 50 ? "warning" : "error"}>{e.confidence ?? "—"}</Badge></td>
                      <td className="p-2"><Badge tone={e.status === "verified" ? "success" : e.status === "risky" ? "warning" : "error"}>{e.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {savedId && (
            <div className="mt-4 flex items-center gap-2 text-sm text-emerald-600">
              <CheckCircle size={16} weight="fill" /> Prospect saved. <a className="underline" onClick={() => navigate(`/prospects/${savedId}`)}>Open detail →</a>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/* ─────────────── TAB 2: PROSPECT LIST ─────────────── */
function ProspectList() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (q) params.q = q;
      const { data } = await api.get("/prospects", { params });
      setRows(data);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const counts = useMemo(() => {
    const c = { all: rows.length };
    STATUSES.forEach((s) => { c[s] = rows.filter((r) => r.status === s).length; });
    return c;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill label={`All`}      active={statusFilter === ""} onClick={() => setStatusFilter("")} count={counts.all} testid="filter-all" />
        {STATUSES.map((s) => (
          <FilterPill key={s} label={s} active={statusFilter === s} onClick={() => setStatusFilter(s)} count={counts[s]} testid={`filter-${s.replace(/\s/g,'')}`} />
        ))}
      </div>
      <Card className="p-5">
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <MagnifyingGlass size={14} weight="bold" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              placeholder="Search by company / website / email / industry..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && load()}
              data-testid="list-search"
            />
          </div>
          <PrimaryButton onClick={load} data-testid="list-search-btn">Search</PrimaryButton>
        </div>

        {loading ? (
          <div className="text-center py-8 text-slate-500"><Spinner size={20} weight="bold" className="animate-spin inline" /> Loading...</div>
        ) : rows.length === 0 ? (
          <EmptyState icon={UsersFour} title="No prospects yet" description="Switch to 'Add Prospect' tab to discover and save your first prospect." />
        ) : (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                <tr>
                  <th className="text-left p-3">Company</th>
                  <th className="text-left p-3">Website</th>
                  <th className="text-left p-3">Primary Email</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-left p-3">Last Activity</th>
                  <th className="text-left p-3">Assigned</th>
                  <th className="text-right p-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                  return (
                    <tr
                      key={p.id}
                      onClick={() => navigate(`/prospects/${p.id}`)}
                      className="border-t border-slate-100 hover:bg-indigo-50/40 cursor-pointer transition-colors"
                      data-testid={`prospect-row-${p.id}`}
                    >
                      <td className="p-3">
                        <div className="font-medium text-slate-900">{p.company_name}</div>
                        <div className="text-[11px] text-slate-500">{p.industry || "—"}</div>
                      </td>
                      <td className="p-3 text-xs text-slate-700">{p.website || p.domain || "—"}</td>
                      <td className="p-3 font-mono text-xs text-slate-900">{primary?.email || "—"}</td>
                      <td className="p-3"><Badge tone={STATUS_TONE[p.status] || "neutral"}>{p.status}</Badge></td>
                      <td className="p-3 text-xs text-slate-500">{fmtDate(p.last_activity_at)}</td>
                      <td className="p-3 text-xs text-slate-700">{p.assigned_user_name || "—"}</td>
                      <td className="p-3 text-right"><CaretRight size={16} weight="bold" className="text-slate-300" /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function FilterPill({ label, active, onClick, count, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
        active ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
      }`}
    >
      {label} <span className={`ml-1 ${active ? "opacity-80" : "text-slate-400"}`}>({count || 0})</span>
    </button>
  );
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff/86400)}d ago`;
  return d.toLocaleDateString();
}
