import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Plus, MagnifyingGlass, Crosshair, ListBullets, UsersFour, Globe, Buildings,
  CaretRight, Spinner, PaperPlaneTilt, FloppyDisk, CheckCircle, Lock, LockOpen,
  Target, ArrowRight, X, CalendarCheck,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import Calendar from "./ProspectsCalendar";

const STATUSES = ["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"];
const STATUS_TONE = {
  "New": "neutral", "Contacted": "info", "Interested": "warning",
  "Meeting Scheduled": "purple", "Customer": "success", "Lost": "error",
};

export default function Prospects() {
  const [tab, setTab] = useState("add");
  const [quota, setQuota] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadQuota = async () => {
    try { const { data } = await api.get("/prospects/quota"); setQuota(data); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { loadQuota(); }, [refreshKey]);

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader title="Prospects" subtitle="Discover, save and engage prospects from one place" />

      <div className="flex border border-slate-200 rounded-lg overflow-hidden w-fit bg-white mb-6 shadow-sm">
        <TabBtn active={tab === "add"}      onClick={() => setTab("add")}      icon={Crosshair}       label="Add Prospect"   testid="tab-add" />
        <TabBtn active={tab === "list"}     onClick={() => setTab("list")}     icon={ListBullets}     label="Prospect List"  testid="tab-list" />
        <TabBtn active={tab === "calendar"} onClick={() => setTab("calendar")} icon={CalendarCheck}   label="Jadwal"         testid="tab-calendar" />
      </div>

      {tab === "add"      && <AddProspect quota={quota} onProspectSaved={() => setRefreshKey((k) => k + 1)} />}
      {tab === "list"     && <ProspectList quota={quota} />}
      {tab === "calendar" && <Calendar quota={quota} onChanged={() => setRefreshKey((k) => k + 1)} />}
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

/* ─────────────── DAILY QUOTA HERO ─────────────── */
function QuotaHero({ quota, justHit }) {
  if (!quota) return null;
  const target = quota.daily_target || 0;
  const added  = quota.prospects_today || 0;
  const pct = target > 0 ? Math.min(100, Math.round((added / target) * 100)) : 0;
  const dots = Array.from({ length: Math.max(target, 0) }, (_, i) => i < added);

  if (!quota.is_working_day) {
    return (
      <Card className="p-5 bg-gradient-to-br from-emerald-50 via-white to-cyan-50 border-emerald-100 mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-700 grid place-items-center">
            <LockOpen size={20} weight="bold" />
          </div>
          <div>
            <div className="font-display text-lg font-semibold text-slate-900">Day off · No quota today</div>
            <div className="text-xs text-slate-600">{quota.is_holiday ? "Today is set as a holiday" : "Outside working days"} — email outreach is fully unlocked</div>
          </div>
        </div>
      </Card>
    );
  }

  if (target === 0) {
    return (
      <Card className="p-5 bg-slate-50 border-slate-200 mb-5">
        <div className="flex items-center gap-3">
          <Target size={20} weight="bold" className="text-slate-500" />
          <div>
            <div className="text-sm font-medium text-slate-700">No daily target set — emails are unlocked</div>
            <div className="text-xs text-slate-500">Set a target from the Dashboard to enable the daily quest mode</div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={`p-6 mb-5 transition-all overflow-hidden relative ${
      quota.locked
        ? "bg-gradient-to-br from-indigo-50 via-white to-purple-50 border-indigo-100"
        : "bg-gradient-to-br from-emerald-50 via-white to-emerald-50 border-emerald-200"
    }`} data-testid="quota-hero">
      {justHit && <ConfettiBurst />}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-semibold mb-1">
            <Target size={14} weight="bold" className={quota.locked ? "text-indigo-600" : "text-emerald-600"} />
            <span className={quota.locked ? "text-indigo-600" : "text-emerald-600"}>Today&apos;s Quest</span>
            {!quota.locked && <Badge tone="success">🎉 Unlocked</Badge>}
          </div>
          <div className="font-display text-3xl md:text-4xl font-bold text-slate-900" data-testid="quota-count">
            {added}<span className="text-slate-400 text-2xl"> / {target}</span>
            <span className="ml-3 text-base font-medium text-slate-500">prospects</span>
          </div>
        </div>

        <div className="text-right">
          <div className={`text-3xl font-bold ${quota.locked ? "text-indigo-600" : "text-emerald-600"}`}>{pct}%</div>
          <div className="text-[11px] text-slate-500">
            {quota.locked ? <>🔒 Email outreach unlocks at {target}/{target}</> : <>✓ Email outreach unlocked</>}
          </div>
        </div>
      </div>

      {/* Dot indicators */}
      <div className="flex flex-wrap gap-1.5 mt-4">
        {dots.map((on, i) => (
          <div
            key={i}
            className={`w-7 h-2.5 rounded-full transition-all ${
              on
                ? quota.locked
                  ? "bg-gradient-to-r from-indigo-500 to-purple-500"
                  : "bg-gradient-to-r from-emerald-500 to-emerald-400"
                : "bg-slate-200"
            }`}
            data-testid={`quota-dot-${i}`}
          />
        ))}
      </div>

      <div className="text-[11px] text-slate-500 mt-3">
        {quota.locked ? (
          <>💪 Tambah <b className="text-indigo-600">{quota.remaining}</b> prospect lagi untuk membuka kirim email</>
        ) : (
          <>🚀 Quota tercapai! Klik &quot;Email Outreach&quot; di kanan atau buka prospect detail untuk mulai kirim.</>
        )}
      </div>
    </Card>
  );
}

function ConfettiBurst() {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {Array.from({ length: 30 }).map((_, i) => (
        <div
          key={i}
          className="absolute w-2 h-2 rounded-sm"
          style={{
            left: `${Math.random() * 100}%`,
            top: `-10px`,
            background: ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"][i % 5],
            animation: `confetti-fall 1.5s ${Math.random() * 0.5}s ease-out forwards`,
            transform: `rotate(${Math.random() * 360}deg)`,
          }}
        />
      ))}
      <style>{`@keyframes confetti-fall { to { transform: translateY(200px) rotate(720deg); opacity: 0; } }`}</style>
    </div>
  );
}

/* ─────────────── TAB 1: ADD PROSPECT ─────────────── */
function AddProspect({ quota, onProspectSaved }) {
  const navigate = useNavigate();
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [todayList, setTodayList] = useState([]);
  const [justHit, setJustHit] = useState(false);
  const [showOutreach, setShowOutreach] = useState(false);
  const inputRef = useRef(null);

  const loadToday = async () => {
    try { const { data } = await api.get("/prospects/today"); setTodayList(data); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { loadToday(); }, []);

  const search = async () => {
    if (!domain.trim()) return toast.error("Enter a domain");
    setLoading(true); setResult(null); setSavedId(null);
    try {
      const { data } = await api.post("/prospects/discover", { domain: domain.trim() });
      setResult(data);
      toast.success(`Found ${data.emails.length} email(s) on ${data.domain}`);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  const saveProspect = async (next = false) => {
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
      toast.success(`✓ ${data.company_name} saved`);
      onProspectSaved();
      await loadToday();
      // Check if we just hit target
      const newQuota = await api.get("/prospects/quota").then((r) => r.data);
      if (quota?.locked && !newQuota.locked) {
        setJustHit(true);
        setTimeout(() => setJustHit(false), 2500);
        toast.success("🎉 Daily quota hit! Email outreach unlocked.");
      }
      if (next) {
        // Save & Next: clear input + result and focus
        setResult(null); setSavedId(null); setDomain("");
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const isUnlocked = !quota?.locked;

  return (
    <div className="space-y-5">
      <QuotaHero quota={quota} justHit={justHit} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* LEFT — search + result */}
        <div className="lg:col-span-2 space-y-5">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-slate-700">Search a domain for emails</div>
              {quota?.daily_target > 0 && quota?.is_working_day && (
                <button
                  onClick={() => isUnlocked && setShowOutreach(true)}
                  disabled={!isUnlocked}
                  data-testid="email-outreach-cta"
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    isUnlocked
                      ? "bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                      : "bg-slate-100 text-slate-400 cursor-not-allowed"
                  }`}
                >
                  {isUnlocked ? <LockOpen size={12} weight="bold" /> : <Lock size={12} weight="bold" />}
                  Email Outreach
                  {isUnlocked && <ArrowRight size={12} weight="bold" />}
                </button>
              )}
            </div>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Globe size={16} weight="bold" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  ref={inputRef}
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
                    <FloppyDisk size={14} weight="bold" /> {savedId ? "Saved" : "Save"}
                  </GhostButton>
                  <PrimaryButton onClick={() => saveProspect(true)} disabled={savedId} data-testid="save-next-btn">
                    <FloppyDisk size={14} weight="bold" /> Save &amp; Next →
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
                      <tr><th className="text-left p-2">Email</th><th className="text-left p-2">Name</th><th className="text-left p-2">Title</th><th className="text-left p-2">Score</th><th className="text-left p-2">Status</th></tr>
                    </thead>
                    <tbody>
                      {result.emails.map((e, i) => (
                        <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                          <td className="p-2 font-mono text-xs text-slate-900">{e.email}</td>
                          <td className="p-2 text-xs text-slate-700">{e.name || "—"}</td>
                          <td className="p-2 text-xs text-slate-500">{e.job_title || "—"}</td>
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
                  <CheckCircle size={16} weight="fill" /> Saved! <a className="underline cursor-pointer" onClick={() => navigate(`/prospects/${savedId}`)}>Open detail →</a>
                </div>
              )}
            </Card>
          )}
        </div>

        {/* RIGHT — Added Today sidebar */}
        <div className="lg:col-span-1">
          <Card className="p-5 sticky top-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display text-sm font-semibold text-slate-900 flex items-center gap-2">
                <CheckCircle size={16} weight="bold" className="text-emerald-600" /> Added Today
              </h3>
              <Badge tone="info">{todayList.length}</Badge>
            </div>
            {todayList.length === 0 ? (
              <div className="text-xs text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">
                Belum ada prospect ditambah hari ini
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
                {todayList.map((p) => {
                  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                  return (
                    <button
                      key={p.id}
                      onClick={() => navigate(`/prospects/${p.id}`)}
                      className="w-full text-left p-2.5 rounded-lg border border-slate-200 hover:border-indigo-200 hover:bg-indigo-50/40 transition-colors group"
                      data-testid={`today-${p.id}`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 bg-indigo-50 text-indigo-600 rounded-lg grid place-items-center font-medium text-xs shrink-0">
                          {(p.company_name || "?").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-slate-900 truncate">{p.company_name}</div>
                          <div className="text-[10px] text-slate-500 truncate">{primary?.email || p.domain}</div>
                        </div>
                        <CaretRight size={12} weight="bold" className="text-slate-300 group-hover:text-indigo-500 shrink-0" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
            {todayList.length > 0 && quota && !quota.locked && quota.daily_target > 0 && (
              <button
                onClick={() => setShowOutreach(true)}
                data-testid="open-outreach-btn"
                className="mt-3 w-full px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium flex items-center justify-center gap-2 shadow-sm"
              >
                <PaperPlaneTilt size={14} weight="bold" /> Start Email Outreach
              </button>
            )}
          </Card>
        </div>
      </div>

      {showOutreach && <OutreachModal todayList={todayList} onClose={() => setShowOutreach(false)} />}
    </div>
  );
}

/* ─────────────── BULK OUTREACH MODAL ─────────────── */
function OutreachModal({ todayList, onClose }) {
  const [templates, setTemplates] = useState([]);
  const [subCompanies, setSubCompanies] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set(todayList.map((p) => p.id)));
  const [form, setForm] = useState({
    template_id: "",
    subject: "Hi {{name}}, interested in a quick chat?",
    body_html: "<p>Hi {{name}},</p>\n<p>I came across {{company}} and wanted to reach out about a quick chat.</p>\n<p>Best,<br/>Your Name</p>",
    sub_company_id: "",
  });
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.get("/templates").then(({ data }) => setTemplates(data)).catch(() => {});
    api.get("/sub-companies").then(({ data }) => setSubCompanies(data)).catch(() => {});
  }, []);

  const pickTemplate = (tid) => {
    setForm((f) => ({ ...f, template_id: tid }));
    if (!tid) return;
    const t = templates.find((x) => x.id === tid);
    if (t) setForm((f) => ({ ...f, subject: t.subject, body_html: t.body_html }));
  };

  const toggle = (id) => {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  };

  const send = async () => {
    if (selectedIds.size === 0) return toast.error("Pick at least one prospect");
    setSending(true);
    try {
      const { data } = await api.post("/prospects/bulk-send-email", {
        prospect_ids: Array.from(selectedIds),
        subject: form.subject,
        body_html: form.body_html,
        template_id: form.template_id || null,
        sub_company_id: form.sub_company_id || null,
      });
      toast.success(`Queued ${data.queued} email(s)`);
      onClose();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSending(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card className="w-full max-w-5xl shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 rounded-t-xl">
            <div>
              <h2 className="font-display text-lg text-slate-900 flex items-center gap-2"><PaperPlaneTilt size={18} weight="bold" className="text-emerald-600" /> Email Outreach — Today&apos;s Batch</h2>
              <div className="text-xs text-slate-500">Send to {selectedIds.size} of {todayList.length} prospects added today</div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500"><X size={20} weight="bold" /></button>
          </div>
          <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <TermSelect label="Template" value={form.template_id} onChange={(e) => pickTemplate(e.target.value)} data-testid="outreach-template">
                  <option value="">— blank —</option>
                  {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </TermSelect>
                <TermSelect label="Send from (SMTP)" value={form.sub_company_id} onChange={(e) => setForm({ ...form, sub_company_id: e.target.value })}>
                  <option value="">User / Tenant default</option>
                  {subCompanies.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}{sc.smtp_host ? "" : " (no SMTP)"}</option>)}
                </TermSelect>
              </div>
              <TermInput label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="outreach-subject" />
              <TermTextarea label="Body (HTML, supports {{name}} {{company}} variables)" rows={10} value={form.body_html} onChange={(e) => setForm({ ...form, body_html: e.target.value })} data-testid="outreach-body" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-2">Recipients ({selectedIds.size}/{todayList.length})</div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[420px] overflow-y-auto">
                {todayList.map((p) => {
                  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                  return (
                    <label key={p.id} className={`flex items-center gap-2 p-2 border-b border-slate-100 last:border-b-0 cursor-pointer ${selectedIds.has(p.id) ? "bg-indigo-50/50" : "bg-white"}`}>
                      <input type="checkbox" className="accent-indigo-600" checked={selectedIds.has(p.id)} onChange={() => toggle(p.id)} data-testid={`outreach-pick-${p.id}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 truncate">{p.company_name}</div>
                        <div className="text-xs text-slate-500 truncate font-mono">{primary?.email || "no email"}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between rounded-b-xl">
            <div className="text-xs text-slate-500">Tracking pixel + click-redirect auto-injected. {`{{name}}`}, {`{{company}}`} etc replaced per prospect.</div>
            <div className="flex gap-2">
              <GhostButton onClick={onClose}>Cancel</GhostButton>
              <PrimaryButton onClick={send} disabled={sending || selectedIds.size === 0} data-testid="outreach-send-btn">
                <PaperPlaneTilt size={14} weight="bold" /> {sending ? "Queuing..." : `Send to ${selectedIds.size}`}
              </PrimaryButton>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ─────────────── TAB 2: PROSPECT LIST ─────────────── */
function ProspectList({ quota }) {
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
      {quota?.locked && quota?.daily_target > 0 && (
        <div className="p-3 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-700 flex items-center gap-2">
          <Lock size={14} weight="bold" /> Email sending locked: add <b>{quota.remaining}</b> more prospect{quota.remaining > 1 ? "s" : ""} today to unlock outreach
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill label="All" active={statusFilter === ""} onClick={() => setStatusFilter("")} count={counts.all} testid="filter-all" />
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
