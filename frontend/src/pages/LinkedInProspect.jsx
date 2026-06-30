import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import LinkedInCalendar from "./LinkedInCalendar";
import {
  LinkedinLogo, Plus, Trash, ArrowsClockwise, X, MagnifyingGlass, Buildings,
  User, PaperPlaneTilt, Copy, ArrowSquareOut, Sparkle, Target, ListBullets, Kanban,
  PencilSimple, ChartLine, CheckCircle, Clock, Warning, Table as TableIcon, Bell,
  CalendarCheck, Crosshair, UsersFour, Lock,
} from "@phosphor-icons/react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
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

// Country dropdown — covers ASEAN + major business hubs + "Worldwide" option
const COUNTRIES = [
  { code: "",            name: "🌐 Worldwide (semua negara)" },
  { code: "Indonesia",   name: "🇮🇩 Indonesia" },
  { code: "Singapore",   name: "🇸🇬 Singapore" },
  { code: "Malaysia",    name: "🇲🇾 Malaysia" },
  { code: "Thailand",    name: "🇹🇭 Thailand" },
  { code: "Vietnam",     name: "🇻🇳 Vietnam" },
  { code: "Philippines", name: "🇵🇭 Philippines" },
  { code: "Brunei",      name: "🇧🇳 Brunei" },
  { code: "Cambodia",    name: "🇰🇭 Cambodia" },
  { code: "Laos",        name: "🇱🇦 Laos" },
  { code: "Myanmar",     name: "🇲🇲 Myanmar" },
  { code: "Timor-Leste", name: "🇹🇱 Timor-Leste" },
  { code: "India",       name: "🇮🇳 India" },
  { code: "China",       name: "🇨🇳 China" },
  { code: "Hong Kong",   name: "🇭🇰 Hong Kong" },
  { code: "Taiwan",      name: "🇹🇼 Taiwan" },
  { code: "Japan",       name: "🇯🇵 Japan" },
  { code: "South Korea", name: "🇰🇷 South Korea" },
  { code: "Australia",   name: "🇦🇺 Australia" },
  { code: "New Zealand", name: "🇳🇿 New Zealand" },
  { code: "United Arab Emirates", name: "🇦🇪 United Arab Emirates" },
  { code: "Saudi Arabia",name: "🇸🇦 Saudi Arabia" },
  { code: "Qatar",       name: "🇶🇦 Qatar" },
  { code: "United Kingdom", name: "🇬🇧 United Kingdom" },
  { code: "Germany",     name: "🇩🇪 Germany" },
  { code: "France",      name: "🇫🇷 France" },
  { code: "Netherlands", name: "🇳🇱 Netherlands" },
  { code: "Spain",       name: "🇪🇸 Spain" },
  { code: "Italy",       name: "🇮🇹 Italy" },
  { code: "United States", name: "🇺🇸 United States" },
  { code: "Canada",      name: "🇨🇦 Canada" },
  { code: "Mexico",      name: "🇲🇽 Mexico" },
  { code: "Brazil",      name: "🇧🇷 Brazil" },
  { code: "Argentina",   name: "🇦🇷 Argentina" },
  { code: "South Africa",name: "🇿🇦 South Africa" },
  { code: "Nigeria",     name: "🇳🇬 Nigeria" },
  { code: "Egypt",       name: "🇪🇬 Egypt" },
  { code: "Turkey",      name: "🇹🇷 Turkey" },
];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmtDate(s) { return s ? new Date(s).toLocaleDateString("id-ID",{day:"numeric",month:"short",year:"numeric"}) : ""; }
function daysSince(iso) { if (!iso) return null; const d=Math.floor((Date.now()-new Date(iso).getTime())/86400000); return d; }

// ─── Search Companies Modal (DDG/Bing aggregator) ───
function SearchModal({ open, date, onClose, onAdded }) {
  const [kw, setKw] = useState("");
  const [country, setCountry] = useState("Indonesia");
  const [linkedinOnly, setLinkedinOnly] = useState(false);
  const [useSession, setUseSession] = useState(false);
  const [useScrapingdog, setUseScrapingdog] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState([]);
  const [adding, setAdding] = useState(null);
  const [resultMode, setResultMode] = useState(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [enrichingSlug, setEnrichingSlug] = useState(null);
  const [bulkEnriching, setBulkEnriching] = useState(false);
  useEffect(() => { if (open) { setKw(""); setResults([]); setResultMode(null); setHiddenCount(0); } }, [open]);
  const doSearch = async () => {
    if (!kw.trim()) return;
    setLoading(true); setResults([]); setResultMode(null); setHiddenCount(0);
    try {
      const { data } = await api.post("/linkedin/search-companies", {
        keyword: kw, country, limit: 15,
        linkedin_only: linkedinOnly || useScrapingdog,
        use_session: useSession && linkedinOnly && !useScrapingdog,
        use_scrapingdog: useScrapingdog,
      });
      setResults(data.results || []);
      setResultMode(data.mode || null);
      setHiddenCount(data.hidden_existing || 0);
      if ((data.results || []).length === 0 && (data.hidden_existing || 0) > 0) {
        toast.message(`Semua ${data.hidden_existing} hasil sudah pernah di-prospect — coba keyword lain.`);
      } else if ((data.results || []).length === 0) toast.message("Tidak ada hasil. Coba keyword lain.");
      else if (data.stale) toast.warning(`${data.count} hasil dari cache lama`);
      else if (data.cached) toast.success(`${data.count} hasil ⚡ dari cache`);
      else toast.success(`${data.count} hasil baru${data.mode === "scrapingdog" ? " · Scrapingdog" : data.mode === "li-native" ? " · LinkedIn Native" : ""}`);
    } catch (err) {
      if (err?.response?.status === 404) {
        toast.warning("Endpoint search belum tersedia di backend VPS. Jalankan: bash wa-setup.sh");
      } else if (err?.response?.status === 400 && useScrapingdog) {
        toast.error("Scrapingdog API key belum diset di Settings → API Keys");
      } else {
        toast.error(formatApiError(err));
      }
    }
    finally { setLoading(false); }
  };

  const enrichOne = async (r) => {
    if (!r.linkedin_slug) return;
    setEnrichingSlug(r.linkedin_slug);
    try {
      const { data } = await api.post("/linkedin/enrich-scrapingdog", { slug: r.linkedin_slug });
      if (!data.ok) { toast.error(data.reason || "Enrich gagal"); return; }
      setResults((prev) => prev.map((x) => x.linkedin_slug === r.linkedin_slug
        ? { ...x, ...data, enriched: true, industry: data.industry, city: data.headquarters,
            snippet: data.description || x.snippet, company_size: data.company_size,
            tagline: data.tagline, employees: data.employees, scrapingdog_enriched: true }
        : x));
      toast.success(`✓ ${r.company_name} di-enrich${data.cached ? " (cache)" : " (10 credits)"}`);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setEnrichingSlug(null); }
  };

  const bulkEnrichAll = async () => {
    const toEnrich = results.filter(r => r.linkedin_slug && !r.scrapingdog_enriched);
    if (toEnrich.length === 0) { toast.message("Semua sudah di-enrich"); return; }
    const estimateCredits = toEnrich.length * 10;
    if (!window.confirm(`Enrich ${toEnrich.length} companies sekaligus?\nEstimasi: ${estimateCredits} credits (~$${(estimateCredits * 0.0002).toFixed(3)}).\nHasil cache akan FREE.`)) return;
    setBulkEnriching(true);
    try {
      const slugs = toEnrich.map(r => r.linkedin_slug);
      const { data } = await api.post("/linkedin/bulk-enrich-scrapingdog", { slugs });
      const bySlug = Object.fromEntries((data.enriched || []).map(e => [e.slug, e]));
      setResults((prev) => prev.map((x) => {
        if (!x.linkedin_slug || !bySlug[x.linkedin_slug]) return x;
        const e = bySlug[x.linkedin_slug];
        if (!e.ok) return x;
        return { ...x, ...e, enriched: true, industry: e.industry, city: e.headquarters,
                 snippet: e.description || x.snippet, company_size: e.company_size,
                 tagline: e.tagline, employees: e.employees, scrapingdog_enriched: true };
      }));
      const ok = (data.enriched || []).filter(e => e.ok).length;
      toast.success(`✓ ${ok}/${toEnrich.length} berhasil · ${data.total_credits_used} credits used · ${data.cached_count} dari cache (FREE)`);
    } catch (err) {
      if (err?.response?.status === 400) toast.error("Scrapingdog API key belum diset di Settings → API Keys");
      else toast.error(formatApiError(err));
    } finally { setBulkEnriching(false); }
  };
  const addOne = async (r) => {
    setAdding(r.domain || r.website);
    try {
      const payload = {
        date,
        company_name: r.company_name,
        website: r.website,
        country: r.country,
        industry: r.industry || null,
        city: r.city || r.headquarters || null,
      };
      if (r.website && r.website.includes("linkedin.com/company")) {
        payload.company_linkedin_url = r.website;
      }
      // Include enriched data if available
      if (r.scrapingdog_enriched) {
        payload.tagline = r.tagline;
        payload.company_size = r.company_size;
        payload.description = r.description;
      }
      const { data } = await api.post("/linkedin/prospects", payload);
      // Auto-add decision makers from Scrapingdog enrichment
      if (r.employees && r.employees.length > 0 && data?.id) {
        for (const emp of r.employees.slice(0, 5).filter(e => e.name)) {
          try {
            await api.post(`/linkedin/prospects/${data.id}/decision-makers`, {
              full_name: emp.name,
              job_title: emp.title || null,
              linkedin_url: emp.linkedin_url || null,
            });
          } catch (_) { /* ignore individual dm errors */ }
        }
      }
      toast.success(`✅ ${r.company_name} ditambahkan${r.employees?.length ? ` + ${Math.min(r.employees.length, 5)} contacts` : ""}`);
      onAdded?.(data);
      setResults((prev) => prev.filter((x) => (x.domain || x.website) !== (r.domain || r.website)));
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setAdding(null); }
  };
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[92vh] sm:max-h-[88vh] flex flex-col" onClick={(e)=>e.stopPropagation()} data-testid="li-search-modal">
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-slate-200">
          <h3 className="font-bold flex items-center gap-2 text-sm sm:text-base"><MagnifyingGlass size={18} weight="bold" className="text-[#0A66C2]" /> Search Companies (Aggregator)</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={16} /></button>
        </div>
        <div className="p-3 sm:p-4 border-b border-slate-200">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 sm:items-end">
            <div className="sm:col-span-6">
              <label className="text-[10px] uppercase font-bold text-slate-500">Keyword <span className="text-red-500">*</span></label>
              <input value={kw} onChange={(e)=>setKw(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&doSearch()}
                placeholder="e.g. Hotel Bali, Corporate Jakarta, Event Organizer"
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#0A66C2]"
                data-testid="li-search-keyword" autoFocus/>
            </div>
            <div className="sm:col-span-4">
              <label className="text-[10px] uppercase font-bold text-slate-500">Country</label>
              <select value={country} onChange={(e)=>setCountry(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-2 py-2 text-sm focus:outline-none focus:border-[#0A66C2] bg-white"
                data-testid="li-search-country">
                {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <PrimaryButton onClick={doSearch} disabled={loading || !kw.trim()} data-testid="li-search-submit" className="w-full !justify-center">
                {loading ? <ArrowsClockwise size={14} weight="bold" className="animate-spin"/> : <MagnifyingGlass size={14} weight="bold"/>} Search
              </PrimaryButton>
            </div>
          </div>
          {!kw.trim() && (
            <p className="text-[11px] text-slate-500 mt-2">💡 Isi <b>Keyword</b> dulu (industry/jenis bisnis). Country boleh <b>Worldwide</b> kalau cari di semua negara.</p>
          )}
          {/* Mode toggles */}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={useScrapingdog} onChange={(e) => { setUseScrapingdog(e.target.checked); if (e.target.checked) setLinkedinOnly(true); }}
                className="accent-purple-600" data-testid="li-search-use-scrapingdog"/>
              <span className="font-semibold text-purple-700">🟣 Scrapingdog</span>
              <span className="text-slate-400">(Google SERP → LinkedIn URLs, 1 credit)</span>
            </label>
            {!useScrapingdog && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={linkedinOnly} onChange={(e) => setLinkedinOnly(e.target.checked)}
                  className="accent-[#0A66C2]" data-testid="li-search-linkedin-only"/>
                <LinkedinLogo size={12} weight="fill" className="text-[#0A66C2]" />
                <span className="font-semibold text-slate-700">LinkedIn-only (web)</span>
              </label>
            )}
            {linkedinOnly && !useScrapingdog && (
              <label className="flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={useSession} onChange={(e) => setUseSession(e.target.checked)}
                  className="accent-amber-600" data-testid="li-search-use-session"/>
                <span className="font-semibold text-amber-700">+ Cookie native</span>
              </label>
            )}
            {resultMode && (
              <span className={`ml-auto text-[10px] font-bold px-2 py-0.5 rounded ${
                resultMode === "scrapingdog" ? "bg-purple-100 text-purple-800" :
                resultMode === "li-native" ? "bg-amber-100 text-amber-800" :
                resultMode === "li-only" ? "bg-blue-100 text-blue-800" :
                "bg-slate-100 text-slate-600"
              }`}>
                Mode: {resultMode === "scrapingdog" ? "Scrapingdog" : resultMode === "li-native" ? "LinkedIn Native" : resultMode === "li-only" ? "LinkedIn URLs" : "Web Search"}
              </span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {/* Header bar: hidden count + bulk enrich */}
          {(results.length > 0 || hiddenCount > 0) && (
            <div className="flex items-center justify-between px-1 mb-1 text-[11px]">
              <div className="flex items-center gap-2">
                {hiddenCount > 0 && (
                  <Badge tone="neutral" data-testid="li-hidden-count">
                    🙈 {hiddenCount} sudah pernah di-prospect (disembunyikan)
                  </Badge>
                )}
              </div>
              {results.length > 0 && useScrapingdog && results.some(r => r.linkedin_slug && !r.scrapingdog_enriched) && (
                <button onClick={bulkEnrichAll} disabled={bulkEnriching}
                  className="text-[11px] px-2.5 py-1 rounded bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 font-semibold"
                  data-testid="li-bulk-enrich-all">
                  {bulkEnriching ? "Enriching…" : `🚀 Bulk Enrich All (${results.filter(r => r.linkedin_slug && !r.scrapingdog_enriched).length} × 10c)`}
                </button>
              )}
            </div>
          )}
          {loading && <div className="text-center text-sm text-slate-500 py-10">Mencari…</div>}
          {!loading && results.length === 0 && (
            <div className="text-center text-xs text-slate-400 py-10 px-4">
              Tip: keyword spesifik = hasil lebih relevan.<br/>
              Contoh: &quot;Hotel Bintang 4 Bali&quot;, &quot;Travel Agency Singapore&quot;, &quot;Manufacturing Surabaya&quot;.<br/>
              <span className="text-[10px] text-slate-500 mt-2 inline-block">
                💡 <b>LinkedIn-only + Native</b> mode butuh cookie LinkedIn diset di Settings → Companies → LinkedIn Identity.
              </span>
            </div>
          )}
          {results.map((r) => (
            <Card key={r.domain || r.website} className="p-3 hover:shadow-sm transition" data-testid={`li-search-result-${r.domain || r.website}`}>
              <div className="flex items-start gap-3">
                {(r.linkedin_native || r.scrapingdog_serp || r.scrapingdog_enriched) ? (
                  <LinkedinLogo size={18} weight="fill" className="text-[#0A66C2] mt-0.5 shrink-0"/>
                ) : (
                  <Buildings size={18} weight="duotone" className="text-[#0A66C2] mt-0.5 shrink-0"/>
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-sm text-slate-900 flex items-center gap-1.5 flex-wrap">
                    {r.company_name}
                    {r.linkedin_native && <Badge tone="info" className="!text-[9px] !px-1.5 !py-0">LinkedIn Native</Badge>}
                    {r.scrapingdog_serp && !r.scrapingdog_enriched && <Badge tone="info" className="!text-[9px] !px-1.5 !py-0">Scrapingdog</Badge>}
                    {r.scrapingdog_enriched && <Badge tone="success" className="!text-[9px] !px-1.5 !py-0">✓ Enriched</Badge>}
                    {r.company_size && <Badge tone="neutral" className="!text-[9px] !px-1.5 !py-0">{r.company_size}</Badge>}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono truncate">{r.domain}</div>
                  {(r.industry || r.city || r.headquarters) && (
                    <div className="text-[11px] text-slate-600 mt-0.5">
                      {r.industry && <span>{r.industry}</span>}
                      {r.industry && (r.city || r.headquarters) && <span> · </span>}
                      {(r.city || r.headquarters) && <span>📍 {r.city || r.headquarters}</span>}
                    </div>
                  )}
                  {r.tagline && <div className="text-[11px] italic text-slate-500 mt-0.5">&ldquo;{r.tagline}&rdquo;</div>}
                  {r.snippet && <div className="text-xs text-slate-600 mt-1 line-clamp-2">{r.snippet}</div>}
                  {r.employees && r.employees.length > 0 && (
                    <div className="text-[11px] text-slate-600 mt-1.5 flex items-center gap-1">
                      <span className="font-semibold">{r.employees.length} contacts</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500 truncate">{r.employees.slice(0,2).map(e => e.name).filter(Boolean).join(", ")}{r.employees.length > 2 ? ` +${r.employees.length - 2}` : ""}</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <PrimaryButton onClick={()=>addOne(r)} disabled={adding===(r.domain||r.website)} className="!text-xs">
                    <Plus size={12} weight="bold"/> Add
                  </PrimaryButton>
                  {r.scrapingdog_serp && !r.scrapingdog_enriched && (
                    <button onClick={() => enrichOne(r)} disabled={enrichingSlug === r.linkedin_slug}
                      className="text-[10px] px-2 py-1 rounded bg-purple-100 text-purple-700 hover:bg-purple-200 disabled:opacity-50 font-semibold"
                      data-testid={`li-enrich-${r.linkedin_slug}`}>
                      {enrichingSlug === r.linkedin_slug ? "..." : "Enrich (10c)"}
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

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
          <div>
            <label className="text-xs text-slate-600 font-semibold">Country</label>
            <select
              value={form.country || ""}
              onChange={(e) => setForm({ ...form, country: e.target.value })}
              className="mt-0.5 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#0A66C2] bg-white"
              data-testid="li-input-country"
            >
              {COUNTRIES.filter(c => c.code).map(c => (
                <option key={c.code} value={c.code}>{c.name}</option>
              ))}
            </select>
          </div>
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
  const [view, setView] = useState("list"); // 'list' | 'kanban' | 'table'
  const [dashboard, setDashboard] = useState(null);
  const [prospects, setProspects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [target, setTarget] = useState(15);
  const [editTarget, setEditTarget] = useState(false);
  const [kpi, setKpi] = useState(null);
  const [reminders, setReminders] = useState({ day3: [], day7: [], day14: [] });
  const [dragId, setDragId] = useState(null);
  const [filterStatus, setFilterStatus] = useState("");
  const [filterQ, setFilterQ] = useState("");
  const [senderCtx, setSenderCtx] = useState(null); // {profile_name, sub_company_name, ...} or {empty:true}
  const [backendOutdated, setBackendOutdated] = useState(false);
  const [tab, setTab] = useState("add"); // 'jadwal' | 'add' | 'connect' | 'analitik' | 'list' | 'rejected'

  const loadDashboard = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/linkedin/dashboard`, { params: { date } });
      setDashboard(data); setProspects(data.prospects); setTarget(data.target);
    } catch (err) {
      if (err?.response?.status === 404) setBackendOutdated(true);
      else toast.error(formatApiError(err));
    }
    finally { setLoading(false); }
  };
  const loadKpi = async () => {
    try {
      const { data } = await api.get(`/linkedin/kpi`, { params: { date_from: date } });
      setKpi(data);
    } catch (_) { /* ignore */ }
  };

  const loadReminders = async () => {
    try {
      const { data } = await api.get(`/linkedin/reminders`);
      setReminders(data || { day3: [], day7: [], day14: [] });
    } catch (_) { /* ignore */ }
  };

  const loadSenderContext = async () => {
    try {
      const { data } = await api.get(`/linkedin/sender-context`);
      setSenderCtx(data || { empty: true });
      setBackendOutdated(false);
    } catch (err) {
      setSenderCtx(null);
      if (err?.response?.status === 404) setBackendOutdated(true);
    }
  };

  useEffect(() => { loadDashboard(); loadKpi(); loadReminders(); /* eslint-disable-next-line */ }, [date]);
  useEffect(() => { loadSenderContext(); }, []);

  // Drag-and-drop kanban: handle drop on a stage column
  const onDropStage = async (newStatus) => {
    if (!dragId) return;
    const p = prospects.find((x) => x.id === dragId);
    if (!p || p.status === newStatus) { setDragId(null); return; }
    setDragId(null);
    try {
      await api.patch(`/linkedin/prospects/${p.id}`, { status: newStatus });
      toast.success(`${p.company_name} → ${stageMap[newStatus]?.label}`);
      loadDashboard(); loadKpi();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const filteredProspects = useMemo(() => {
    let list = prospects;
    if (filterStatus) list = list.filter((p) => p.status === filterStatus);
    if (filterQ) {
      const q = filterQ.toLowerCase();
      list = list.filter((p) =>
        (p.company_name || "").toLowerCase().includes(q) ||
        (p.industry || "").toLowerCase().includes(q) ||
        (p.city || "").toLowerCase().includes(q) ||
        (p.decision_maker?.full_name || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [prospects, filterStatus, filterQ]);

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
    for (const p of filteredProspects) (g[p.status] ||= []).push(p);
    return g;
  }, [filteredProspects]);

  const completed = dashboard?.completed ?? 0;
  const dailyTarget = dashboard?.target ?? 15;
  const connectUnlocked = completed >= dailyTarget && dailyTarget > 0;
  const todayProspects = prospects;
  const connectQueue = useMemo(() => {
    // Today's prospects ready to "be connected" — those with messages generated or with DM added
    return todayProspects.filter((p) =>
      ["dm_added", "ready", "researched"].includes(p.status) ||
      (p.messages?.connection_note && p.status !== "connect_sent" && p.status !== "accepted")
    );
  }, [todayProspects]);
  const totalReminders = reminders.day3.length + reminders.day7.length + reminders.day14.length;

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="LinkedIn Prospect"
        subtitle={`Manual workflow + AI assist · ${user?.role || ""}`}
        action={
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={date} onChange={(e)=>setDate(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-sm" data-testid="li-date-picker" />
            {totalReminders > 0 && (
              <GhostButton onClick={()=>{ setTab("add"); setView("kanban"); }} className="!text-amber-700 !border-amber-300" data-testid="li-reminders-btn">
                <Bell size={14} weight="fill"/> {totalReminders} reminders
              </GhostButton>
            )}
            <GhostButton onClick={()=>setSearchOpen(true)} data-testid="li-search-btn"><MagnifyingGlass size={14} weight="bold"/> Search</GhostButton>
            <GhostButton onClick={loadDashboard} disabled={loading}><ArrowsClockwise size={14} weight="bold" className={loading?"animate-spin":""}/> Refresh</GhostButton>
            <PrimaryButton onClick={()=>setAddOpen(true)} data-testid="li-add-btn"><Plus size={14} weight="bold"/> Add Manual</PrimaryButton>
          </div>
        }
      />

      {/* Step tabs */}
      <div className="flex flex-wrap border border-slate-200 rounded-lg overflow-hidden w-fit bg-white mb-6 shadow-sm">
        <LiTabBtn active={tab === "jadwal"} onClick={() => setTab("jadwal")} icon={CalendarCheck} label="1 · Jadwal" testid="li-tab-jadwal" />
        <LiTabBtn active={tab === "add"} onClick={() => setTab("add")} icon={Crosshair} label={`2 · Add Prospect (${completed}/${dailyTarget})`} testid="li-tab-add" />
        <LiTabBtn
          active={tab === "connect"}
          onClick={() => connectUnlocked ? setTab("connect") : toast.error("Selesaikan target dulu di tab Add Prospect")}
          icon={connectUnlocked ? PaperPlaneTilt : Lock}
          label="3 · Connect"
          testid="li-tab-connect"
          disabled={!connectUnlocked}
        />
        <LiTabBtn active={tab === "analitik"} onClick={() => setTab("analitik")} icon={ChartLine} label="4 · Analitik" testid="li-tab-analitik" />
        <LiTabBtn active={tab === "list"} onClick={() => setTab("list")} icon={UsersFour} label="Prospect List" testid="li-tab-list" />
      </div>

      {/* Tab: JADWAL (Calendar) */}
      {tab === "jadwal" && (
        <LinkedInCalendar onPickDate={(d) => { setDate(d); setTab("add"); }} />
      )}

      {/* Tab: CONNECT (queue of prospects ready to send connect) */}
      {tab === "connect" && (
        <ConnectQueue
          prospects={connectQueue}
          onPick={(p) => setDetailId(p.id)}
          onMarkSent={async (p) => {
            try {
              await api.patch(`/linkedin/prospects/${p.id}`, { status: "connect_sent", connect_sent_at: new Date().toISOString() });
              toast.success(`✓ ${p.company_name} marked Connect Sent`);
              loadDashboard(); loadKpi();
            } catch (err) { toast.error(formatApiError(err)); }
          }}
        />
      )}

      {/* Tab: ANALITIK (KPI) */}
      {tab === "analitik" && (
        <AnalitikPanel kpi={kpi} date={date} />
      )}

      {/* Tab: PROSPECT LIST (all prospects across dates) */}
      {tab === "list" && (
        <AllProspectsList onPick={(p) => setDetailId(p.id)} />
      )}

      {/* Tab: ADD PROSPECT — original full view */}
      {tab === "add" && (
        <>

      {/* Backend outdated banner — VPS belum di-update */}
      {backendOutdated && (
        <div className="mb-3 flex items-start justify-between gap-3 px-3 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-[12px]" data-testid="li-backend-outdated">
          <div className="flex items-start gap-2 text-amber-800">
            <Warning size={14} weight="fill" className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">Backend VPS Anda belum di-update.</div>
              <div className="text-amber-700 mt-0.5">
                Beberapa endpoint LinkedIn baru (sender-context, search, dll) belum tersedia. SSH ke VPS lalu jalankan:
                <code className="ml-1 px-1.5 py-0.5 bg-amber-100 rounded font-mono text-[11px]">bash wa-setup.sh</code>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Sender identity badge — derived from sub_company linkedin_settings */}
      {senderCtx && !senderCtx.empty && (senderCtx.profile_name || senderCtx.profile_url) && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-[#0A66C2]/5 border border-[#0A66C2]/20 text-[12px]" data-testid="li-sender-badge">
          <LinkedinLogo size={14} weight="fill" className="text-[#0A66C2]" />
          <span className="text-slate-700">Sending as</span>
          <span className="font-semibold text-[#0A66C2]" data-testid="li-sender-name">{senderCtx.profile_name || senderCtx.profile_url}</span>
          {senderCtx.sub_company_name && (
            <span className="text-slate-500">· {senderCtx.sub_company_name}</span>
          )}
          {senderCtx.profile_url && (
            <a href={senderCtx.profile_url} target="_blank" rel="noreferrer" className="ml-1 text-[#0A66C2] hover:underline inline-flex items-center gap-0.5">
              <ArrowSquareOut size={11} weight="bold" />
            </a>
          )}
        </div>
      )}
      {!backendOutdated && senderCtx?.empty && (user?.role === "Owner" || user?.role === "Admin") && (
        <div className="mb-3 flex items-center justify-between px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[12px]" data-testid="li-sender-missing">
          <div className="flex items-center gap-2 text-amber-800">
            <Warning size={14} weight="fill" />
            <span>LinkedIn identity belum diset di Company Profile — AI message akan generik.</span>
          </div>
          <a href="/settings" className="text-amber-700 font-semibold hover:underline">Set di Settings → Companies →</a>
        </div>
      )}

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

      {/* KPI chart */}
      {kpi && kpi.total > 0 && (
        <Card className="p-3 mb-4">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-2 flex items-center gap-1">
            <ChartLine size={11} weight="bold"/> Pipeline distribution
          </div>
          <div style={{ width: "100%", height: 160 }}>
            <ResponsiveContainer>
              <BarChart data={PIPELINE.map((s) => ({ name: s.label, value: kpi.by_status[s.key] || 0, key: s.key }))}>
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={50}/>
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false}/>
                <Tooltip />
                <Bar dataKey="value" radius={[3, 3, 0, 0]}>
                  {PIPELINE.map((s, i) => (
                    <Cell key={i} fill={
                      s.tone === "success" ? "#10b981" :
                      s.tone === "danger" ? "#ef4444" :
                      s.tone === "warning" ? "#f59e0b" :
                      s.tone === "purple" ? "#8b5cf6" :
                      s.tone === "info" ? "#0A66C2" : "#94a3b8"
                    }/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* View switch + filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <GhostButton onClick={()=>setView("list")} className={view==="list"?"!bg-[#0A66C2] !text-white":""} data-testid="li-view-list">
          <ListBullets size={14} weight="bold"/> List
        </GhostButton>
        <GhostButton onClick={()=>setView("kanban")} className={view==="kanban"?"!bg-[#0A66C2] !text-white":""} data-testid="li-view-kanban">
          <Kanban size={14} weight="bold"/> Kanban
        </GhostButton>
        <GhostButton onClick={()=>setView("table")} className={view==="table"?"!bg-[#0A66C2] !text-white":""} data-testid="li-view-table">
          <TableIcon size={14} weight="bold"/> Table
        </GhostButton>
        <div className="flex-1"/>
        <input
          placeholder="🔍 Filter company / DM / city…"
          value={filterQ} onChange={(e)=>setFilterQ(e.target.value)}
          className="border border-slate-200 rounded-lg px-2 py-1 text-sm w-56"
          data-testid="li-filter-q"/>
        <select value={filterStatus} onChange={(e)=>setFilterStatus(e.target.value)}
          className="border border-slate-200 rounded-lg px-2 py-1 text-sm" data-testid="li-filter-status">
          <option value="">All stages</option>
          {PIPELINE.map((s)=><option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      {filteredProspects.length === 0 && !loading ? (
        <EmptyState icon={LinkedinLogo} title={prospects.length===0?"Belum ada prospect untuk hari ini":"Tidak ada yang match filter"} description={prospects.length===0?"Klik 'Search' atau 'Add Manual' untuk mulai.":"Coba ubah filter / clear."} />
      ) : view === "list" ? (
        <div className="space-y-2">
          {filteredProspects.map((p) => {
            const wait = daysSince(p.connect_sent_at);
            const needsReminder = p.status === "connect_sent" && wait != null && wait >= 3;
            return (
              <Card key={p.id} className="p-3 hover:shadow-md cursor-pointer transition" onClick={()=>setDetailId(p.id)} data-testid={`li-card-${p.id}`}>
                <div className="flex items-center gap-3">
                  <Buildings size={20} weight="duotone" className="text-[#0A66C2] shrink-0"/>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-900 truncate flex items-center gap-1">
                      {p.company_name}
                      {needsReminder && <Bell size={11} weight="fill" className="text-amber-500" title={`${wait} days waiting`}/>}
                    </div>
                    <div className="text-xs text-slate-500 truncate">
                      {p.decision_maker?.full_name ? `${p.decision_maker.full_name} • ${p.decision_maker.job_title || ""}` : "DM belum diisi"}
                      {p.industry && ` • ${p.industry}`}
                      {p.city && ` • ${p.city}`}
                      {needsReminder && ` • ⏳ ${wait}d`}
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
            );
          })}
        </div>
      ) : view === "table" ? (
        <Card className="!p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                {["Company","DM","Title","Industry","City","Score","Status","Updated"].map((h)=>(
                  <th key={h} className="text-left px-3 py-2 font-bold text-slate-600 uppercase text-[10px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredProspects.map((p)=>(
                <tr key={p.id} onClick={()=>setDetailId(p.id)} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" data-testid={`li-row-${p.id}`}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{p.company_name}</td>
                  <td className="px-3 py-2">{p.decision_maker?.full_name || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{p.decision_maker?.job_title || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{p.industry || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{p.city || "—"}</td>
                  <td className="px-3 py-2 font-bold text-[#0A66C2]">{p.research?.lead_score ?? "—"}</td>
                  <td className="px-3 py-2"><Badge tone={stageMap[p.status]?.tone||"neutral"} className="!text-[10px]">{stageMap[p.status]?.label || p.status}</Badge></td>
                  <td className="px-3 py-2 text-slate-500 text-[10px]">{p.updated_at ? new Date(p.updated_at).toLocaleString("id-ID",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex gap-3 min-w-max pb-2">
            {PIPELINE.filter((s)=>grouped[s.key]?.length > 0 || ["added","researched","ready","connect_sent","accepted"].includes(s.key)).map((s) => (
              <div
                key={s.key}
                className="w-64 shrink-0"
                onDragOver={(e)=>{ e.preventDefault(); e.currentTarget.classList.add("ring-2","ring-[#0A66C2]","rounded-lg"); }}
                onDragLeave={(e)=>{ e.currentTarget.classList.remove("ring-2","ring-[#0A66C2]","rounded-lg"); }}
                onDrop={(e)=>{ e.preventDefault(); e.currentTarget.classList.remove("ring-2","ring-[#0A66C2]","rounded-lg"); onDropStage(s.key); }}
                data-testid={`li-stage-${s.key}`}
              >
                <div className="px-2 py-1.5 mb-2 bg-slate-100 rounded-t font-bold text-[10px] uppercase text-slate-700 flex items-center justify-between">
                  <span>{s.label}</span>
                  <span className="bg-white text-slate-600 px-1.5 rounded-full">{grouped[s.key]?.length || 0}</span>
                </div>
                <div className="space-y-2 max-h-[60vh] overflow-y-auto p-1">
                  {(grouped[s.key] || []).map((p) => {
                    const wait = daysSince(p.connect_sent_at);
                    const needsReminder = p.status === "connect_sent" && wait != null && wait >= 3;
                    return (
                      <Card
                        key={p.id}
                        className={`p-2 hover:shadow-md cursor-grab transition text-xs ${dragId===p.id ? "opacity-50":""}`}
                        draggable
                        onDragStart={()=>setDragId(p.id)}
                        onDragEnd={()=>setDragId(null)}
                        onClick={()=>setDetailId(p.id)}
                        data-testid={`li-kanban-${p.id}`}
                      >
                        <div className="font-semibold text-slate-900 truncate flex items-center gap-1">
                          {needsReminder && <Bell size={9} weight="fill" className="text-amber-500"/>}
                          {p.company_name}
                        </div>
                        {p.decision_maker?.full_name && <div className="text-[10px] text-slate-500 truncate">{p.decision_maker.full_name}</div>}
                        <div className="flex items-center justify-between mt-1">
                          {p.research?.lead_score != null && (
                            <div className="text-[10px]"><b className="text-[#0A66C2]">{p.research.lead_score}</b>/100</div>
                          )}
                          {needsReminder && <span className="text-[9px] text-amber-700">⏳ {wait}d</span>}
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
        </>
      )}

      <SearchModal open={searchOpen} date={date} onClose={()=>setSearchOpen(false)} onAdded={()=>{ loadDashboard(); loadKpi(); }} />

      <AddModal open={addOpen} date={date} onClose={()=>setAddOpen(false)} onCreated={()=>{ loadDashboard(); loadKpi(); }} />
      <DetailDrawer open={!!detailId} prospectId={detailId} onClose={()=>setDetailId(null)} onChanged={()=>{ loadDashboard(); loadKpi(); }} />
    </div>
  );
}

/* ────────────── Tab helpers ────────────── */
function LiTabBtn({ active, onClick, icon: Icon, label, testid, disabled }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      disabled={disabled}
      className={`px-4 py-2.5 text-sm font-medium flex items-center gap-2 transition-colors border-r border-slate-200 last:border-r-0 ${
        active
          ? "bg-[#0A66C2] text-white"
          : disabled
            ? "text-slate-400 cursor-not-allowed bg-slate-50"
            : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
      }`}
    >
      <Icon size={14} weight={active ? "fill" : "regular"} />
      <span>{label}</span>
    </button>
  );
}

function ConnectQueue({ prospects, onPick, onMarkSent }) {
  if (prospects.length === 0) {
    return (
      <Card className="p-8 text-center">
        <PaperPlaneTilt size={32} className="text-slate-300 mx-auto mb-2"/>
        <div className="text-sm font-semibold text-slate-700">Tidak ada prospect siap untuk Connect</div>
        <div className="text-xs text-slate-500 mt-1">
          Prospect siap connect = punya Decision Maker + Connection Note. Generate dulu di tab Add Prospect → klik detail.
        </div>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500 mb-2">
        🎯 Target tercapai. Buka tiap prospect → klik <b>Open Company LinkedIn</b> → kirim connect manual → klik <b>Mark Sent</b> di sini.
      </div>
      {prospects.map((p) => (
        <Card key={p.id} className="p-3 hover:shadow-md transition" data-testid={`li-connect-${p.id}`}>
          <div className="flex items-start gap-3">
            <LinkedinLogo size={20} weight="fill" className="text-[#0A66C2] mt-0.5 shrink-0"/>
            <div className="min-w-0 flex-1 cursor-pointer" onClick={() => onPick(p)}>
              <div className="font-semibold text-slate-900">{p.company_name}</div>
              <div className="text-xs text-slate-500">
                {p.decision_maker?.full_name ? `${p.decision_maker.full_name} • ${p.decision_maker.job_title || ""}` : "⚠️ DM belum diisi"}
              </div>
              {p.messages?.connection_note && (
                <div className="text-[11px] text-slate-700 mt-1.5 line-clamp-2 bg-slate-50 px-2 py-1 rounded border border-slate-200">
                  💬 {p.messages.connection_note}
                </div>
              )}
              {!p.messages?.connection_note && (
                <div className="text-[11px] text-amber-700 mt-1">⚠️ Connection note belum di-generate</div>
              )}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              {p.company_linkedin_url && (
                <a href={p.company_linkedin_url} target="_blank" rel="noreferrer"
                  className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded bg-[#0A66C2] text-white hover:bg-[#084d92] font-semibold"
                  data-testid={`li-open-${p.id}`}>
                  <ArrowSquareOut size={11} weight="bold"/> Open LinkedIn
                </a>
              )}
              <button onClick={() => onMarkSent(p)}
                className="text-[10px] px-2 py-1 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-semibold"
                data-testid={`li-mark-sent-${p.id}`}>
                ✓ Mark Sent
              </button>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function AnalitikPanel({ kpi, date }) {
  if (!kpi) return <Card className="p-6"><div className="text-sm text-slate-500">Loading KPI…</div></Card>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card className="p-3"><div className="text-[10px] uppercase font-bold text-slate-500">Total Today</div><div className="text-2xl font-bold text-slate-900">{kpi.total ?? 0}</div></Card>
        <Card className="p-3"><div className="text-[10px] uppercase font-bold text-slate-500">Connect Sent</div><div className="text-2xl font-bold text-[#0A66C2]">{kpi.connect_sent ?? 0}</div></Card>
        <Card className="p-3"><div className="text-[10px] uppercase font-bold text-slate-500">Accepted</div><div className="text-2xl font-bold text-emerald-600">{kpi.accepted ?? 0}</div></Card>
        <Card className="p-3"><div className="text-[10px] uppercase font-bold text-slate-500">Won</div><div className="text-2xl font-bold text-emerald-700">{kpi.won ?? 0}</div></Card>
        <Card className="p-3"><div className="text-[10px] uppercase font-bold text-slate-500">Acceptance Rate</div><div className="text-2xl font-bold text-slate-900">{kpi.rates?.acceptance_rate ?? 0}%</div></Card>
      </div>
      {kpi.total > 0 && (
        <Card className="p-3">
          <div className="text-[10px] uppercase font-bold text-slate-500 mb-2 flex items-center gap-1">
            <ChartLine size={11} weight="bold"/> Pipeline Distribution (since {date})
          </div>
          <div style={{ width: "100%", height: 280 }}>
            <ResponsiveContainer>
              <BarChart data={PIPELINE.map((s) => ({ name: s.label, value: kpi.by_status?.[s.key] || 0, key: s.key }))}>
                <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" height={70}/>
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false}/>
                <Tooltip />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {PIPELINE.map((s, i) => (
                    <Cell key={i} fill={
                      s.tone === "success" ? "#10b981" :
                      s.tone === "danger" ? "#ef4444" :
                      s.tone === "warning" ? "#f59e0b" :
                      s.tone === "purple" ? "#8b5cf6" :
                      s.tone === "info" ? "#0A66C2" : "#94a3b8"
                    }/>
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}
    </div>
  );
}

function AllProspectsList({ onPick }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState("");
  useEffect(() => {
    setLoading(true);
    api.get("/linkedin/prospects").then(({ data }) => setList(data || []))
      .catch(() => {}).finally(() => setLoading(false));
  }, []);
  const filtered = list.filter((p) => {
    if (statusF && p.status !== statusF) return false;
    if (q) {
      const qq = q.toLowerCase();
      return (p.company_name || "").toLowerCase().includes(qq)
          || (p.industry || "").toLowerCase().includes(qq)
          || (p.decision_maker?.full_name || "").toLowerCase().includes(qq);
    }
    return true;
  });
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input placeholder="🔍 Search…" value={q} onChange={(e) => setQ(e.target.value)}
          className="border border-slate-200 rounded-lg px-2 py-1 text-sm w-56" data-testid="li-all-filter-q"/>
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1 text-sm">
          <option value="">All stages</option>
          {PIPELINE.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <span className="text-xs text-slate-500 ml-auto">{filtered.length} of {list.length} prospects</span>
      </div>
      {loading ? <Card className="p-6 text-center text-sm text-slate-500">Loading…</Card> :
        filtered.length === 0 ? <EmptyState icon={LinkedinLogo} title="Belum ada prospect" description="Mulai dari tab Add Prospect → Search"/> :
        <Card className="!p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>{["Date","Company","DM","Industry","City","Status","Updated"].map((h) => (
                <th key={h} className="text-left px-3 py-2 font-bold text-slate-600 uppercase text-[10px]">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} onClick={() => onPick(p)} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" data-testid={`li-all-row-${p.id}`}>
                  <td className="px-3 py-2 font-mono text-[10px] text-slate-500">{p.date}</td>
                  <td className="px-3 py-2 font-semibold text-slate-900">{p.company_name}</td>
                  <td className="px-3 py-2">{p.decision_maker?.full_name || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{p.industry || "—"}</td>
                  <td className="px-3 py-2 text-slate-600">{p.city || "—"}</td>
                  <td className="px-3 py-2"><Badge tone={stageMap[p.status]?.tone || "neutral"} className="!text-[10px]">{stageMap[p.status]?.label || p.status}</Badge></td>
                  <td className="px-3 py-2 text-slate-500 text-[10px]">{p.updated_at ? new Date(p.updated_at).toLocaleString("id-ID", {day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      }
    </div>
  );
}
