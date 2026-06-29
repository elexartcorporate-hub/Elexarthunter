import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  LinkedinLogo, Plus, Trash, ArrowsClockwise, X, MagnifyingGlass, Buildings,
  User, PaperPlaneTilt, Copy, ArrowSquareOut, Sparkle, Target, ListBullets, Kanban,
  PencilSimple, ChartLine, CheckCircle, Clock, Warning,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const PIPELINE = [
  { key: "added",         label: "Added",            tone: "neutral" },
  { key: "researched",    label: "Researched",       tone: "info" },
  { key: "dm_added",      label: "DM Added",         tone: "info" },
  { key: "ready",         label: "Ready",            tone: "warning" },
  { key: "connect_sent",  label: "Connect Sent",     tone: "warning" },
  { key: "accepted",      label: "Accepted",         tone: "success" },
  { key: "conversation",  label: "Conversation",     tone: "success" },
  { key: "follow_up",     label: "Follow Up",        tone: "purple" },
  { key: "meeting",       label: "Meeting",          tone: "purple" },
  { key: "quotation",     label: "Quotation",        tone: "purple" },
  { key: "won",           label: "Won",              tone: "success" },
  { key: "lost",          label: "Lost",             tone: "danger" },
];

const stageMap = Object.fromEntries(PIPELINE.map((s) => [s.key, s]));

function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(s) { return s ? new Date(s).toLocaleDateString("id-ID",{day:"numeric",month:"short",year:"numeric"}) : ""; }
function daysSince(iso) { if (!iso) return null; const d=Math.floor((Date.now()-new Date(iso).getTime())/86400000); return d; }

// ─── Add Prospect Modal ───
function AddModal({ open, date, onClose, onCreated }) {
  const [form, setForm] = useState({ company_name: "", website: "", industry: "", country: "Indonesia", city: "", company_linkedin_url: "" });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ company_name: "", website: "", industry: "", country: "Indonesia", city: "", company_linkedin_url: "" }); }, [open]);
  const save = async () => {
    if (!form.company_name.trim()) { toast.error("Company name wajib"); return; }
    setSaving(true);
    try {
      const { data } = await api.post("/linkedin/prospects", { date, ...form });
      toast.success(`✅ Prospect ${data.company_name} ditambahkan`);
      onCreated?.(data);
      onClose();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full" onClick={(e)=>e.stopPropagation()} data-testid="li-add-modal">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-bold flex items-center gap-2"><LinkedinLogo size={18} weight="fill" className="text-[#0A66C2]" /> Add LinkedIn Prospect</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          {[
            { k: "company_name", l: "Company Name *", req: true },
            { k: "website", l: "Website" },
            { k: "company_linkedin_url", l: "Company LinkedIn URL" },
            { k: "industry", l: "Industry" },
            { k: "country", l: "Country" },
            { k: "city", l: "City" },
          ].map((f) => (
            <div key={f.k}>
              <label className="text-xs text-slate-600 font-semibold">{f.l}</label>
              <input
                value={form[f.k]} onChange={(e)=>setForm({...form,[f.k]:e.target.value})}
                className="mt-0.5 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#0A66C2]"
                data-testid={`li-input-${f.k}`}
              />
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
          <GhostButton onClick={onClose}>Batal</GhostButton>
          <PrimaryButton onClick={save} disabled={saving || !form.company_name.trim()} data-testid="li-add-save">
            <Plus size={14} weight="bold" /> {saving ? "Saving…" : "Save"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─── Detail Drawer ───
function DetailDrawer({ open, prospectId, onClose, onChanged }) {
  const [p, setP] = useState(null);
  const [loading, setLoading] = useState(false);
  const [gen, setGen] = useState({ research: false, connection_note: false, ice_breaker: false, first_message: false, follow_up: false });
  const [dmForm, setDmForm] = useState({});
  const [dmDirty, setDmDirty] = useState(false);
  const load = async () => {
    if (!prospectId) return;
    setLoading(true);
    try {
      const { data } = await api.get(`/linkedin/prospects/${prospectId}`);
      setP(data); setDmForm(data.decision_maker || {}); setDmDirty(false);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { if (open && prospectId) load(); /* eslint-disable-next-line */ }, [open, prospectId]);

  const runResearch = async () => {
    setGen((g)=>({...g,research:true}));
    try {
      await api.post(`/linkedin/prospects/${prospectId}/research`);
      toast.success("✨ Research generated");
      await load(); onChanged?.();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setGen((g)=>({...g,research:false})); }
  };
  const genMsg = async (kind) => {
    setGen((g)=>({...g,[kind]:true}));
    try {
      await api.post(`/linkedin/prospects/${prospectId}/messages/generate`, { kind });
      toast.success("✨ Message generated");
      await load(); onChanged?.();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setGen((g)=>({...g,[kind]:false})); }
  };
  const saveDm = async () => {
    if (!dmForm.full_name?.trim()) { toast.error("Nama wajib"); return; }
    try {
      const isNew = !p.decision_maker?.full_name;
      const patch = { decision_maker: dmForm };
      if (isNew && p.status === "researched") patch.status = "dm_added";
      await api.patch(`/linkedin/prospects/${prospectId}`, patch);
      toast.success("Decision maker tersimpan");
      await load(); onChanged?.();
    } catch (err) { toast.error(formatApiError(err)); }
  };
  const setStatus = async (newStatus) => {
    try {
      await api.patch(`/linkedin/prospects/${prospectId}`, { status: newStatus });
      toast.success(`Status → ${stageMap[newStatus]?.label || newStatus}`);
      await load(); onChanged?.();
    } catch (err) { toast.error(formatApiError(err)); }
  };
  const copy = async (txt) => { await navigator.clipboard.writeText(txt || ""); toast.success("Tersalin"); };
  const open_li = (url) => { if (url) window.open(url, "_blank", "noopener"); };

  if (!open) return null;
  const wait = daysSince(p?.connect_sent_at);
  const research = p?.research || {};
  const dm = p?.decision_maker || {};
  const messages = p?.messages || {};

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full sm:max-w-[600px] bg-white border-l border-slate-200 shadow-2xl flex flex-col" data-testid="li-detail-drawer">
      <div className="px-5 py-3 border-b border-slate-200 flex items-center gap-2 bg-slate-50">
        <LinkedinLogo size={20} weight="fill" className="text-[#0A66C2]" />
        <div className="flex-1 min-w-0">
          <div className="font-bold text-slate-900 truncate">{p?.company_name || "Loading…"}</div>
          {p && <Badge tone={stageMap[p.status]?.tone || "neutral"}>{stageMap[p.status]?.label || p.status}</Badge>}
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-slate-200"><X size={18} /></button>
      </div>
      {loading || !p ? (
        <div className="p-10 text-center text-slate-500 text-sm">Memuat…</div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5 space-y-5 text-sm">
          {/* Company info */}
          <Card className="p-3">
            <div className="text-xs uppercase font-bold text-slate-500 mb-2">Company</div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div><span className="text-slate-500">Website:</span> {p.website || "-"}</div>
              <div><span className="text-slate-500">Industry:</span> {p.industry || "-"}</div>
              <div><span className="text-slate-500">Country:</span> {p.country || "-"}</div>
              <div><span className="text-slate-500">City:</span> {p.city || "-"}</div>
            </div>
            {p.company_linkedin_url && (
              <button onClick={()=>open_li(p.company_linkedin_url)} className="mt-2 inline-flex items-center gap-1 text-xs text-[#0A66C2] hover:underline">
                <ArrowSquareOut size={12} weight="bold" /> Open Company LinkedIn
              </button>
            )}
          </Card>

          {/* Research */}
          <Card className="p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs uppercase font-bold text-slate-500 flex items-center gap-1">
                <Sparkle size={12} weight="fill" className="text-amber-500" /> AI Research
              </div>
              <GhostButton onClick={runResearch} disabled={gen.research} data-testid="li-run-research">
                <ArrowsClockwise size={12} weight="bold" className={gen.research?"animate-spin":""}/>
                {research.summary ? "Re-run" : "Run Research"}
              </GhostButton>
            </div>
            {research.summary ? (
              <div className="space-y-2 text-xs">
                <div><b>Summary:</b> {research.summary}</div>
                <div><b>Category:</b> {research.category}</div>
                {research.size_estimate && <div><b>Size:</b> {research.size_estimate}</div>}
                {research.products?.length > 0 && <div><b>Products:</b> {research.products.join(", ")}</div>}
                {research.services?.length > 0 && <div><b>Services:</b> {research.services.join(", ")}</div>}
                {research.opportunity?.length > 0 && (
                  <div><b>Opportunity:</b>
                    <ul className="list-disc ml-4 mt-0.5">{research.opportunity.map((o,i)=><li key={i}>{o}</li>)}</ul>
                  </div>
                )}
                {research.lead_score != null && (
                  <div className="mt-1"><b>Lead Score:</b> <span className="font-bold text-[#0A66C2] text-base">{research.lead_score}</span>/100</div>
                )}
              </div>
            ) : (
              <div className="text-xs text-slate-500 italic">Belum di-research. Klik &quot;Run Research&quot; untuk generate via Claude Sonnet.</div>
            )}
          </Card>

          {/* Decision Maker */}
          <Card className="p-3">
            <div className="text-xs uppercase font-bold text-slate-500 mb-2 flex items-center gap-1">
              <User size={12} weight="bold" /> Decision Maker
            </div>
            <div className="space-y-2">
              {[
                { k: "full_name", l: "Full Name *", w: "full" },
                { k: "job_title", l: "Job Title", w: "half" },
                { k: "department", l: "Department", w: "half" },
                { k: "linkedin_url", l: "LinkedIn Profile URL", w: "full" },
                { k: "business_email", l: "Business Email", w: "half" },
                { k: "phone", l: "Phone", w: "half" },
                { k: "notes", l: "Notes", w: "full" },
              ].map((f) => (
                <div key={f.k} className={f.w==="half"?"inline-block w-1/2 pr-1 align-top":"block"}>
                  <label className="text-[10px] text-slate-600 font-semibold uppercase">{f.l}</label>
                  <input
                    value={dmForm[f.k] || ""}
                    onChange={(e)=>{setDmForm({...dmForm,[f.k]:e.target.value}); setDmDirty(true);}}
                    className="w-full border border-slate-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-[#0A66C2]"
                    data-testid={`li-dm-${f.k}`}
                  />
                </div>
              ))}
              {dmDirty && (
                <PrimaryButton onClick={saveDm} className="!text-xs !py-1" data-testid="li-dm-save">Save DM</PrimaryButton>
              )}
              {dm.linkedin_url && (
                <button onClick={()=>open_li(dm.linkedin_url)} className="mt-1 inline-flex items-center gap-1 text-xs text-[#0A66C2] hover:underline">
                  <ArrowSquareOut size={12} weight="bold" /> Open DM LinkedIn Profile
                </button>
              )}
            </div>
          </Card>

          {/* AI Personalization */}
          <Card className="p-3">
            <div className="text-xs uppercase font-bold text-slate-500 mb-2 flex items-center gap-1">
              <Sparkle size={12} weight="fill" className="text-amber-500" /> AI Personalization
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { k: "connection_note", l: "Connection Note" },
                { k: "ice_breaker", l: "Ice Breaker" },
                { k: "first_message", l: "First Message" },
                { k: "follow_up", l: "Follow Up" },
              ].map((m) => {
                const saved = messages[m.k];
                return (
                  <div key={m.k} className="border border-slate-200 rounded p-2">
                    <div className="flex items-center justify-between mb-1">
                      <div className="text-[10px] font-bold uppercase text-slate-600">{m.l}</div>
                      <button onClick={()=>genMsg(m.k)} disabled={gen[m.k]} className="text-[10px] text-[#0A66C2] hover:underline disabled:opacity-50" data-testid={`li-gen-${m.k}`}>
                        {gen[m.k] ? "…" : (saved ? "Re-gen" : "Generate")}
                      </button>
                    </div>
                    {saved ? (
                      <div className="space-y-1">
                        <div className="text-[11px] text-slate-700 whitespace-pre-wrap max-h-32 overflow-y-auto bg-slate-50 rounded p-1.5">{saved.text}</div>
                        <button onClick={()=>copy(saved.text)} className="text-[10px] text-[#0A66C2] inline-flex items-center gap-1 hover:underline">
                          <Copy size={10} weight="bold" /> Copy
                        </button>
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-400 italic">Belum di-generate</div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Status Actions */}
          <Card className="p-3">
            <div className="text-xs uppercase font-bold text-slate-500 mb-2">Pipeline Action</div>
            <div className="flex flex-wrap gap-1.5">
              {p.status === "dm_added" && (
                <PrimaryButton onClick={()=>setStatus("ready")} className="!text-xs" data-testid="li-set-ready">Mark Ready to Connect →</PrimaryButton>
              )}
              {p.status === "ready" && dm.linkedin_url && (
                <>
                  <PrimaryButton onClick={()=>{ open_li(dm.linkedin_url); }} className="!text-xs"><ArrowSquareOut size={12} weight="bold"/> Open LinkedIn</PrimaryButton>
                  <GhostButton onClick={()=>copy(messages.connection_note?.text)} disabled={!messages.connection_note} className="!text-xs"><Copy size={12} weight="bold"/> Copy Note</GhostButton>
                  <PrimaryButton onClick={()=>setStatus("connect_sent")} className="!text-xs bg-emerald-600 hover:bg-emerald-700" data-testid="li-set-connect-sent">✓ Mark Connect Sent</PrimaryButton>
                </>
              )}
              {p.status === "connect_sent" && (
                <>
                  <div className="text-xs text-amber-700 flex items-center gap-1 px-2 py-1 bg-amber-50 rounded">
                    <Clock size={12} weight="bold"/> Waiting {wait != null ? `${wait} days` : ""}
                  </div>
                  <PrimaryButton onClick={()=>setStatus("accepted")} className="!text-xs bg-emerald-600 hover:bg-emerald-700" data-testid="li-set-accepted">Accepted</PrimaryButton>
                  <GhostButton onClick={()=>setStatus("lost")} className="!text-xs">Rejected</GhostButton>
                </>
              )}
              {p.status === "accepted" && (
                <>
                  <PrimaryButton onClick={()=>{ open_li(dm.linkedin_url); }} className="!text-xs"><ArrowSquareOut size={12} weight="bold"/> Open Chat</PrimaryButton>
                  <GhostButton onClick={()=>copy(messages.first_message?.text)} disabled={!messages.first_message} className="!text-xs"><Copy size={12} weight="bold"/> Copy First Msg</GhostButton>
                  <PrimaryButton onClick={()=>setStatus("conversation")} className="!text-xs bg-emerald-600 hover:bg-emerald-700" data-testid="li-set-conv">✓ Mark Message Sent</PrimaryButton>
                </>
              )}
              {(p.status === "conversation" || p.status === "follow_up") && (
                <>
                  <GhostButton onClick={()=>setStatus("follow_up")} className="!text-xs">Follow Up</GhostButton>
                  <PrimaryButton onClick={()=>setStatus("meeting")} className="!text-xs">Meeting Scheduled</PrimaryButton>
                  <GhostButton onClick={()=>setStatus("lost")} className="!text-xs">Lost</GhostButton>
                </>
              )}
              {p.status === "meeting" && (
                <>
                  <PrimaryButton onClick={()=>setStatus("quotation")} className="!text-xs">Quotation Sent</PrimaryButton>
                  <PrimaryButton onClick={()=>setStatus("won")} className="!text-xs bg-emerald-600 hover:bg-emerald-700">🏆 Won</PrimaryButton>
                  <GhostButton onClick={()=>setStatus("lost")} className="!text-xs">Lost</GhostButton>
                </>
              )}
              {p.status === "quotation" && (
                <>
                  <PrimaryButton onClick={()=>setStatus("won")} className="!text-xs bg-emerald-600 hover:bg-emerald-700">🏆 Won</PrimaryButton>
                  <GhostButton onClick={()=>setStatus("lost")} className="!text-xs">Lost</GhostButton>
                </>
              )}
            </div>
          </Card>

          {/* Timeline */}
          <Card className="p-3">
            <div className="text-xs uppercase font-bold text-slate-500 mb-2">Timeline</div>
            <div className="space-y-1">
              {(p.timeline || []).slice(0, 20).map((t) => (
                <div key={t.id} className="text-[11px] text-slate-600 flex gap-2 items-start">
                  <Clock size={10} weight="bold" className="text-slate-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <div className="font-mono text-[10px] text-slate-400">{new Date(t.at).toLocaleString("id-ID")}</div>
                    <div>{t.type}</div>
                  </div>
                </div>
              ))}
              {(p.timeline || []).length === 0 && <div className="text-xs text-slate-400 italic">Belum ada event</div>}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── Main page ───
export default function LinkedInProspect() {
  const { user } = useAuth();
  const [date, setDate] = useState(todayISO());
  const [view, setView] = useState("list"); // 'list' | 'kanban'
  const [dashboard, setDashboard] = useState(null);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [target, setTarget] = useState(15);
  const [editTarget, setEditTarget] = useState(false);
  const [kpi, setKpi] = useState(null);

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/linkedin/dashboard`, { params: { date } });
      setDashboard(data); setProspects(data.prospects); setTarget(data.target);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };
  const loadKpi = async () => {
    try {
      const { data } = await api.get(`/linkedin/kpi`, { params: { date_from: date } });
      setKpi(data);
    } catch (_) { /* ignore */ }
  };

  useEffect(() => { loadDashboard(); loadKpi(); /* eslint-disable-next-line */ }, [date]);

  const saveTarget = async () => {
    try {
      await api.patch("/me/linkedin-target", { linkedin_daily_target: parseInt(target) || 0 });
      toast.success("Target tersimpan");
      setEditTarget(false);
      loadDashboard();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const grouped = useMemo(() => {
    const g = {};
    for (const s of PIPELINE) g[s.key] = [];
    for (const p of prospects) (g[p.status] ||= []).push(p);
    return g;
  }, [prospects]);

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="LinkedIn Prospect"
        subtitle={`Manual workflow + AI assist · ${user?.role || ""}`}
        action={
          <div className="flex items-center gap-2">
            <input type="date" value={date} onChange={(e)=>setDate(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-sm" data-testid="li-date-picker" />
            <GhostButton onClick={loadDashboard} disabled={loading}><ArrowsClockwise size={14} weight="bold" className={loading?"animate-spin":""}/> Refresh</GhostButton>
            <PrimaryButton onClick={()=>setAddOpen(true)} data-testid="li-add-btn"><Plus size={14} weight="bold"/> Add Prospect</PrimaryButton>
          </div>
        }
      />

      {/* Daily progress + KPI */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <Card className="p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase font-bold text-slate-500">Daily Target</div>
            {!editTarget ? (
              <button onClick={()=>setEditTarget(true)} className="text-[10px] text-[#0A66C2] hover:underline"><PencilSimple size={10} weight="bold" className="inline"/> Edit</button>
            ) : (
              <button onClick={saveTarget} className="text-[10px] text-emerald-600 hover:underline">Save</button>
            )}
          </div>
          {editTarget ? (
            <input type="number" min="0" max="500" value={target} onChange={(e)=>setTarget(e.target.value)}
              className="w-24 text-2xl font-bold border-b border-[#0A66C2]" data-testid="li-target-input" />
          ) : (
            <div className="text-3xl font-bold text-[#0A66C2]" data-testid="li-target-display">{dashboard?.target ?? 15}</div>
          )}
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">Completed</div>
          <div className="text-3xl font-bold text-emerald-600">{dashboard?.completed ?? 0}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-1">Remaining</div>
          <div className="text-3xl font-bold text-amber-600">{dashboard?.remaining ?? 0}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-1 flex items-center gap-1"><ChartLine size={11} weight="bold"/> Acceptance Rate</div>
          <div className="text-3xl font-bold text-slate-900">{kpi?.rates?.acceptance_rate ?? 0}<span className="text-base font-normal">%</span></div>
          <div className="text-[10px] text-slate-500 mt-1">{kpi?.accepted ?? 0} / {kpi?.connect_sent ?? 0} accepted</div>
        </Card>
      </div>

      {/* View switch */}
      <div className="flex items-center gap-2 mb-3">
        <GhostButton onClick={()=>setView("list")} className={view==="list"?"!bg-[#0A66C2] !text-white":""} data-testid="li-view-list">
          <ListBullets size={14} weight="bold"/> List
        </GhostButton>
        <GhostButton onClick={()=>setView("kanban")} className={view==="kanban"?"!bg-[#0A66C2] !text-white":""} data-testid="li-view-kanban">
          <Kanban size={14} weight="bold"/> Kanban
        </GhostButton>
      </div>

      {prospects.length === 0 && !loading ? (
        <EmptyState icon={LinkedinLogo} title="Belum ada prospect untuk hari ini" description="Klik 'Add Prospect' untuk mulai." />
      ) : view === "list" ? (
        <div className="space-y-2">
          {prospects.map((p) => (
            <Card key={p.id} className="p-3 hover:shadow-md cursor-pointer transition" onClick={()=>setDetailId(p.id)} data-testid={`li-card-${p.id}`}>
              <div className="flex items-center gap-3">
                <Buildings size={20} weight="duotone" className="text-[#0A66C2] shrink-0"/>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-900 truncate">{p.company_name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {p.decision_maker?.full_name ? `${p.decision_maker.full_name} • ${p.decision_maker.job_title || ""}` : "DM belum diisi"}
                    {p.industry && ` • ${p.industry}`}
                    {p.city && ` • ${p.city}`}
                  </div>
                </div>
                {p.research?.lead_score != null && (
                  <div className="text-center shrink-0">
                    <div className="text-lg font-bold text-[#0A66C2]">{p.research.lead_score}</div>
                    <div className="text-[9px] text-slate-500 uppercase">Lead Score</div>
                  </div>
                )}
                <Badge tone={stageMap[p.status]?.tone || "neutral"} className="shrink-0">
                  {stageMap[p.status]?.label || p.status}
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex gap-3 min-w-max pb-2">
            {PIPELINE.filter((s)=>grouped[s.key]?.length > 0 || ["added","researched","ready","connect_sent","accepted"].includes(s.key)).map((s) => (
              <div key={s.key} className="w-64 shrink-0">
                <div className="px-2 py-1.5 mb-2 bg-slate-100 rounded-t font-bold text-[10px] uppercase text-slate-700 flex items-center justify-between">
                  <span>{s.label}</span>
                  <span className="bg-white text-slate-600 px-1.5 rounded-full">{grouped[s.key]?.length || 0}</span>
                </div>
                <div className="space-y-2 max-h-[60vh] overflow-y-auto">
                  {(grouped[s.key] || []).map((p) => (
                    <Card key={p.id} className="p-2 hover:shadow-md cursor-pointer transition text-xs" onClick={()=>setDetailId(p.id)} data-testid={`li-kanban-${p.id}`}>
                      <div className="font-semibold text-slate-900 truncate">{p.company_name}</div>
                      {p.decision_maker?.full_name && <div className="text-[10px] text-slate-500 truncate">{p.decision_maker.full_name}</div>}
                      {p.research?.lead_score != null && (
                        <div className="text-[10px] mt-1"><b className="text-[#0A66C2]">{p.research.lead_score}</b>/100</div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <AddModal open={addOpen} date={date} onClose={()=>setAddOpen(false)} onCreated={()=>{ loadDashboard(); loadKpi(); }} />
      <DetailDrawer open={!!detailId} prospectId={detailId} onClose={()=>setDetailId(null)} onChanged={()=>{ loadDashboard(); loadKpi(); }} />
    </div>
  );
}
