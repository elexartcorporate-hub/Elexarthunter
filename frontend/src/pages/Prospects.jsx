import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Plus, MagnifyingGlass, Crosshair, ListBullets, UsersFour, Globe, Buildings,
  CaretRight, Spinner, PaperPlaneTilt, FloppyDisk, CheckCircle, Lock, LockOpen,
  Target, ArrowRight, X, CalendarCheck, Clock, Trash, ChartLine,
  XCircle, Warning, Question, SealCheck,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import "../pages/templates.css";
import Calendar from "./ProspectsCalendar";
import EmailActivity from "./EmailActivity";
import { useAuth } from "@/contexts/AuthContext";

const QUILL_SIMPLE_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline"],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ align: ["", "center", "right", "justify"] }],
    ["link", "clean"],
  ],
};

// Wrap legacy plain-text bodies in <p>/<br> so Quill renders them with paragraphs preserved.
const ensureHtml = (body) => {
  if (!body) return "";
  if (/<\w+[^>]*>/.test(body)) return body;
  return body.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br/>")}</p>`).join("");
};

const STATUSES = ["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"];
const STATUS_TONE = {
  "New": "neutral", "Contacted": "info", "Interested": "warning",
  "Meeting Scheduled": "purple", "Customer": "success", "Lost": "error",
};

export default function Prospects() {
  const [tab, setTab] = useState("jadwal");
  const [quota, setQuota] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTask, setActiveTask] = useState(null); // current task being worked on
  const [tasksRefresh, setTasksRefresh] = useState(0);

  const loadQuota = async () => {
    try { const { data } = await api.get("/prospects/quota"); setQuota(data); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { loadQuota(); }, [refreshKey]);

  // Auto-pick the most-recent draft/ready task as the active one ONLY when nothing is set.
  // Never override an existing activeTask (e.g. one just created via the Calendar) — that
  // would clobber the user's intent and snap them back to an older task they already worked on.
  // We sort tasks by date DESC so a future-dated new task takes precedence over an older draft.
  useEffect(() => {
    if (activeTask) return; // do not override a user-selected/just-created task
    api.get("/tasks").then(({ data }) => {
      // tasks already sorted by date desc on the backend
      const active = (data || []).find((t) => t.status === "draft" || t.status === "ready");
      if (active) setActiveTask(active);
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasksRefresh]);

  const refreshTask = async () => {
    if (!activeTask) return;
    try { const { data } = await api.get(`/tasks/${activeTask.id}`); setActiveTask(data); }
    catch (err) { /* ignore */ }
  };

  // Tab "3 · Email" hanya terbuka kalau task masih actionable (draft/ready) DAN sudah hit target.
  // Task yang sudah scheduled/sending/completed dianggap selesai — user lihat status di Analitik.
  const emailTabUnlocked = !!activeTask
    && (activeTask.status === "draft" || activeTask.status === "ready")
    && (activeTask.prospect_count >= activeTask.target);

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader title="Prospects" subtitle="Discover, save and engage prospects from one place" />

      <div className="flex flex-wrap border border-slate-200 rounded-lg overflow-hidden w-fit bg-white mb-6 shadow-sm">
        <TabBtn active={tab === "jadwal"}    onClick={() => setTab("jadwal")}    icon={CalendarCheck} label="1 · Jadwal"       testid="tab-jadwal" />
        <TabBtn active={tab === "add"}       onClick={() => setTab("add")}       icon={Crosshair}     label={`2 · Add Prospect${activeTask ? ` (${activeTask.prospect_count}/${activeTask.target})` : ""}`}  testid="tab-add" />
        <TabBtn
          active={tab === "email"}
          onClick={() => emailTabUnlocked ? setTab("email") : toast.error("Selesaikan target dulu di tab Add Prospect")}
          icon={emailTabUnlocked ? PaperPlaneTilt : Lock}
          label="3 · Email"
          testid="tab-email"
          disabled={!emailTabUnlocked}
        />
        <TabBtn active={tab === "analitik"} onClick={() => setTab("analitik")} icon={ChartLine}      label="4 · Analitik"     testid="tab-analitik" />
        <TabBtn active={tab === "tersimpan"} onClick={() => setTab("tersimpan")} icon={ListBullets}   label="Tersimpan"        testid="tab-tersimpan" />
        <TabBtn active={tab === "list"}      onClick={() => setTab("list")}      icon={UsersFour}     label="Prospect List"    testid="tab-list" />
      </div>

      {tab === "jadwal"    && <Calendar quota={quota} onChanged={() => { setRefreshKey((k) => k + 1); setTasksRefresh((k) => k + 1); }} onTaskCreated={(t) => { setActiveTask(t); setTab("add"); setTasksRefresh((k) => k + 1); }} onTaskContinue={(t) => { setActiveTask(t); setTab(t.prospect_count >= t.target ? "email" : "add"); setTasksRefresh((k) => k + 1); }} />}
      {tab === "add"       && <AddProspect quota={quota} activeTask={activeTask} refreshTask={refreshTask} onProspectSaved={() => setRefreshKey((k) => k + 1)} onGoEmail={() => setTab("email")} />}
      {tab === "email"     && emailTabUnlocked && <EmailStep task={activeTask} onSubmitted={() => { setTab("tersimpan"); setActiveTask(null); setTasksRefresh((k) => k + 1); setRefreshKey((k) => k + 1); }} />}
      {tab === "analitik"  && <EmailActivity />}
      {tab === "tersimpan" && <TasksList refreshKey={tasksRefresh} onPick={(t) => { setActiveTask(t); setTab("add"); }} onRefresh={() => setTasksRefresh((k) => k + 1)} />}
      {tab === "list"      && <ProspectList quota={quota} />}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid, disabled }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2.5 text-sm font-medium flex items-center gap-2 transition-colors border-r border-slate-200 last:border-r-0 ${
        active ? "bg-indigo-600 text-white"
               : disabled ? "text-slate-300 bg-slate-50 cursor-not-allowed"
                          : "text-slate-600 hover:bg-slate-50"
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
            <div className="text-sm font-medium text-slate-700">No daily prospect target set — outreach unlocked</div>
            <div className="text-xs text-slate-500">Set a target (domain count) from the Dashboard to enable the daily quest mode</div>
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
            <span className="ml-3 text-base font-medium text-slate-500">prospects (domain)</span>
          </div>
        </div>

        <div className="text-right">
          <div className={`text-3xl font-bold ${quota.locked ? "text-indigo-600" : "text-emerald-600"}`}>{pct}%</div>
          <div className="text-[11px] text-slate-500">
            {quota.locked ? <>🔒 Email outreach unlocks at {target}/{target} domain</> : <>✓ Email outreach unlocked (email per domain bebas)</>}
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
function AddProspect({ quota, activeTask, refreshTask, onProspectSaved, onGoEmail }) {
  const navigate = useNavigate();
  const [domain, setDomain] = useState("");
  const [searchCategoryId, setSearchCategoryId] = useState("");
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [todayList, setTodayList] = useState([]);
  const [justHit, setJustHit] = useState(false);
  const [showOutreach, setShowOutreach] = useState(false);
  const [pickerMode, setPickerMode] = useState(null); // null | "save" | "save_next"
  const inputRef = useRef(null);

  const loadToday = async () => {
    try {
      // Show the active task's prospects in the sidebar while the task is still in
      // draft/ready (i.e. not yet submitted). User sees exactly which domain + how many
      // emails they've gathered up until the moment they hit submit. Once the task is
      // submitted (sending/scheduled/sent/...), it disappears from activeTask and the
      // sidebar falls back to /prospects/today which excludes submitted prospects.
      if (activeTask?.id && (activeTask.status === "draft" || activeTask.status === "ready")) {
        const { data } = await api.get(`/tasks/${activeTask.id}`);
        setTodayList(data.prospects || []);
      } else {
        const { data } = await api.get("/prospects/today");
        setTodayList(data);
      }
    } catch (err) { /* ignore */ }
  };
  const loadCategories = async () => {
    try { const { data } = await api.get("/hunter-settings/categories"); setCategories(data || []); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { loadToday(); loadCategories(); }, [activeTask?.id, activeTask?.prospect_count]);

  const selectedCategory = useMemo(
    () => categories.find((c) => c.id === searchCategoryId),
    [categories, searchCategoryId]
  );

  const search = async (forceRefresh = false) => {
    if (!domain.trim()) return toast.error("Masukkan domain dulu");
    if (!searchCategoryId) return toast.error("Pilih kategori dulu — alias pencarian disesuaikan per kategori");
    setLoading(true); setResult(null); setSavedId(null);
    try {
      const { data } = await api.post("/prospects/discover", {
        domain: domain.trim(),
        category_id: searchCategoryId,
        force_refresh: forceRefresh === true,
      });
      setResult(data);
      toast.success(`Found ${data.emails.length} email(s) on ${data.domain}${forceRefresh ? " (fresh)" : ""}`);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  const openPicker = (next) => {
    if (!result) return;
    if (result.emails.length === 0) return toast.error("No emails to save");
    setPickerMode(next ? "save_next" : "save");
  };

  const confirmSave = async (selectedEmails, primaryEmail, categoryId, locationId) => {
    if (!result || selectedEmails.length === 0) return;
    const next = pickerMode === "save_next";
    setPickerMode(null);
    try {
      const payload = {
        company_name: result.company.company_name || result.domain,
        website: `https://${result.domain}`,
        domain: result.domain,
        industry: result.company.industry,
        country: result.company.country,
        phone: (result.company.phones || [])[0] || null,
        linkedin: result.company.socials?.linkedin,
        category_id: categoryId || null,
        location_id: locationId || null,
        emails: selectedEmails.map((e) => ({
          email: e.email,
          is_primary: e.email === primaryEmail,
          status: e.status,
          confidence: e.confidence,
          source: e.source,
        })),
      };
      const { data } = await api.post("/prospects", payload);
      // Attach to active task if any
      if (activeTask) {
        try { await api.post(`/tasks/${activeTask.id}/prospects/${data.id}`); }
        catch (err) { /* ignore */ }
        refreshTask?.();
      }
      setSavedId(data.id);
      toast.success(`✓ ${data.company_name} (${selectedEmails.length} email${selectedEmails.length > 1 ? "s" : ""}) saved`);
      onProspectSaved();
      await loadToday();
      const newQuota = await api.get("/prospects/quota").then((r) => r.data);
      if (quota?.locked && !newQuota.locked) {
        setJustHit(true);
        setTimeout(() => setJustHit(false), 2500);
        toast.success("🎉 Daily quota hit! Email outreach unlocked.");
      }
      if (next) {
        setResult(null); setSavedId(null); setDomain("");
        setTimeout(() => inputRef.current?.focus(), 100);
      }
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // Email Outreach is gated by the ACTIVE TASK's domain target (1 prospect = 1 domain),
  // NOT the global daily quota — emails per domain are unlimited.
  // Fallback to daily quota only when no active task is set.
  const isUnlocked = activeTask
    ? (activeTask.prospect_count >= activeTask.target)
    : !quota?.locked;

  // A task is "in progress" only while user is still hunting prospects. Once the target
  // is hit, the task is "ready to ship" — UI on Add Prospect tab should be CLEAN so user
  // is nudged to the Email tab. After submit, the task disappears entirely (handled by
  // /tasks auto-heal + setActiveTask(null)).
  const taskInProgress = !!activeTask && activeTask.prospect_count < activeTask.target;
  const taskReady = !!activeTask && activeTask.prospect_count >= activeTask.target;

  return (
    <div className="space-y-5">
      {taskInProgress && (
        <Card className="p-4 bg-gradient-to-br from-indigo-50 to-purple-50 border-indigo-200">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white grid place-items-center font-bold">{activeTask.prospect_count}</div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-indigo-600 font-semibold">Tugas Aktif</div>
                <div className="font-display text-base font-semibold text-slate-900">{activeTask.name}</div>
                <div className="text-xs text-slate-500">{activeTask.date} · target {activeTask.target} prospect</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="text-right">
                <div className="text-2xl font-bold text-indigo-600">{activeTask.prospect_count}<span className="text-slate-400 text-base"> / {activeTask.target}</span></div>
                <div className="text-[10px] text-slate-500">{activeTask.prospect_count >= activeTask.target ? "✓ Target tercapai" : `${activeTask.target - activeTask.prospect_count} lagi`}</div>
              </div>
              {activeTask.prospect_count >= activeTask.target && (
                <PrimaryButton onClick={onGoEmail} data-testid="goto-email-btn">
                  <PaperPlaneTilt size={14} weight="bold" /> Ke Tab Email →
                </PrimaryButton>
              )}
            </div>
          </div>
          {activeTask.target > 0 && (
            <div className="mt-3 h-2 bg-white rounded-full overflow-hidden border border-indigo-100">
              <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all" style={{ width: `${Math.min(100, Math.round((activeTask.prospect_count / activeTask.target) * 100))}%` }} />
            </div>
          )}
        </Card>
      )}
      {taskReady && (
        <Card className="p-4 bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200" data-testid="task-ready-banner">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white grid place-items-center">
                <CheckCircle size={20} weight="bold" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-emerald-600 font-semibold">Tugas Siap Dikirim</div>
                <div className="font-display text-base font-semibold text-slate-900">{activeTask.name}</div>
                <div className="text-xs text-slate-500">Target {activeTask.target} prospect tercapai — lanjut ke tab Email untuk kirim / jadwalkan.</div>
              </div>
            </div>
            <PrimaryButton onClick={onGoEmail} data-testid="goto-email-btn-clean">
              <PaperPlaneTilt size={14} weight="bold" /> Ke Tab Email →
            </PrimaryButton>
          </div>
        </Card>
      )}
      {!activeTask && (
        <Card className="p-4 bg-amber-50 border-amber-200">
          <div className="flex items-center gap-3 text-sm text-amber-800">
            <CalendarCheck size={20} weight="bold" />
            <div>
              <div className="font-semibold">Belum ada tugas aktif untuk hari ini</div>
              <div className="text-xs text-amber-700">Buka tab <b>Jadwal</b> dan klik tanggal untuk buat tugas baru, atau lanjut tambah prospect bebas tanpa tugas.</div>
            </div>
          </div>
        </Card>
      )}
      {/* QuotaHero shows the GLOBAL daily progress. When there's an active task,
          the "Tugas Aktif" card above already shows the task-scoped progress, so we hide
          this one to avoid two conflicting counters (e.g. task 0/2 vs daily 2/2). */}
      {!activeTask && <QuotaHero quota={quota} justHit={justHit} />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* LEFT — search + result */}
        <div className="lg:col-span-2 space-y-5">
          <Card className="p-5">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-slate-700">Search a domain for emails</div>
              {/* Hide the CTA entirely when there's an active task that's not yet complete —
                  the user must finish the task target first. Falls back to the daily-quota
                  gate when no active task is set. */}
              {isUnlocked && (
                <button
                  onClick={() => setShowOutreach(true)}
                  data-testid="email-outreach-cta"
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                >
                  <LockOpen size={12} weight="bold" />
                  Email Outreach
                  <ArrowRight size={12} weight="bold" />
                </button>
              )}
            </div>

            {/* Category selector — required so the backend injects the right aliases */}
            <div className="mb-2">
              <label className="text-[11px] font-medium text-slate-600 flex items-center justify-between mb-1">
                <span>Kategori target <span className="text-rose-500">*</span></span>
                {selectedCategory && (selectedCategory.aliases?.length || 0) > 0 && (
                  <span className="text-[10px] text-emerald-600">
                    {selectedCategory.aliases.length} alias akan diinjeksi
                  </span>
                )}
                {selectedCategory && (selectedCategory.aliases?.length || 0) === 0 && (
                  <span className="text-[10px] text-amber-600">
                    Belum ada alias — pakai default tenant
                  </span>
                )}
              </label>
              <select
                value={searchCategoryId}
                onChange={(e) => setSearchCategoryId(e.target.value)}
                className={`w-full px-3 py-2 border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  searchCategoryId ? "border-slate-200" : "border-amber-300"
                }`}
                data-testid="search-category-select"
              >
                <option value="">— Pilih kategori target (wajib) —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.aliases?.length ? ` (${c.aliases.length} alias)` : ""}
                  </option>
                ))}
              </select>
              {categories.length === 0 && (
                <div className="text-[10px] text-rose-600 mt-1">
                  Belum ada kategori. Tambahkan dulu di Settings → Hunter → Categories.
                </div>
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
              <PrimaryButton onClick={() => search()} disabled={loading || !searchCategoryId} data-testid="discover-search-btn">
                {loading ? <><Spinner size={14} weight="bold" className="animate-spin" /> Searching...</>
                         : <><Crosshair size={14} weight="bold" /> Search Emails</>}
              </PrimaryButton>
            </div>
            <div className="text-[11px] text-slate-500 mt-2">Discovery pipeline: Playwright deep crawl + Hunter.io domain-search → Alias Verifier internal (SMTP/MX/catch-all). Cache 30 hari.</div>
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
                  {result.cached && (
                    <GhostButton onClick={() => search(true)} disabled={loading} data-testid="refresh-search-btn" title="Force re-crawl & re-verify (bypass 30-day cache)">
                      <Spinner size={14} weight="bold" className={loading ? "animate-spin" : ""} /> Refresh
                    </GhostButton>
                  )}
                  <GhostButton onClick={() => openPicker(false)} disabled={savedId} data-testid="save-prospect-btn">
                    <FloppyDisk size={14} weight="bold" /> {savedId ? "Saved" : "Save"}
                  </GhostButton>
                  <PrimaryButton onClick={() => openPicker(true)} disabled={savedId} data-testid="save-next-btn">
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
                      <tr>
                        <th className="text-left p-2">Email</th>
                        <th className="text-left p-2">Name</th>
                        <th className="text-left p-2">Title</th>
                        <th className="text-left p-2">Score</th>
                        <th className="text-left p-2">Status</th>
                        <th className="text-left p-2 hidden md:table-cell">Catatan / Risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.emails.map((e, i) => {
                        const statusTone = e.status === "verified" ? "success"
                                         : e.status === "risky" ? "warning"
                                         : e.status === "invalid" ? "error" : "neutral";
                        const noteColor = e.status === "invalid"
                          ? "text-rose-600"
                          : e.status === "risky"
                          ? "text-amber-700"
                          : "text-slate-500";
                        return (
                          <tr key={i} className="border-t border-slate-100 hover:bg-slate-50">
                            <td className="p-2 font-mono text-xs text-slate-900 align-top">{e.email}</td>
                            <td className="p-2 text-xs text-slate-700 align-top">{e.name || "—"}</td>
                            <td className="p-2 text-xs text-slate-500 align-top">{e.job_title || "—"}</td>
                            <td className="p-2 align-top"><Badge tone={e.confidence >= 80 ? "success" : e.confidence >= 50 ? "warning" : "error"}>{e.confidence ?? "—"}</Badge></td>
                            <td className="p-2 align-top"><Badge tone={statusTone}>{e.status}</Badge></td>
                            <td className={`p-2 text-[11px] leading-snug hidden md:table-cell ${noteColor}`} title={e.description}>
                              {e.description || "—"}
                            </td>
                          </tr>
                        );
                      })}
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

        {/* RIGHT — Added Today sidebar. Always show the list of prospects collected
            in the active task (or today's loose prospects) so user knows what they have. */}
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
            {todayList.length > 0 && isUnlocked && (
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

      {showOutreach && <OutreachModal todayList={todayList} activeTask={activeTask} onClose={() => setShowOutreach(false)} onSent={() => { setShowOutreach(false); loadToday(); refreshTask?.(); onProspectSaved?.(); }} />}
      {pickerMode && result && (
        <EmailPickerModal
          emails={result.emails}
          company={result.company.company_name || result.domain}
          domain={result.domain}
          nextMode={pickerMode === "save_next"}
          initialCategoryId={searchCategoryId}
          onClose={() => setPickerMode(null)}
          onConfirm={confirmSave}
        />
      )}
    </div>
  );
}

/* ─────────────── EMAIL PICKER MODAL ─────────────── */
function EmailPickerModal({ emails: initialEmails, company, domain, nextMode, initialCategoryId, onClose, onConfirm }) {
  const [emails, setEmails] = useState(initialEmails);  // local copy so probe results update in place
  const [selected, setSelected] = useState(new Set(initialEmails.map((e) => e.email)));
  const [primary, setPrimary] = useState(initialEmails[0]?.email || "");
  const [probing, setProbing] = useState({});  // {email: true} while testing

  // Category & Location for the prospect being saved
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [categoryId, setCategoryId] = useState(initialCategoryId || "");
  const [locationId, setLocationId] = useState("");
  const [newCatName, setNewCatName] = useState("");
  const [newLocName, setNewLocName] = useState("");
  const [showNewCat, setShowNewCat] = useState(false);
  const [showNewLoc, setShowNewLoc] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [c, l] = await Promise.all([
          api.get("/hunter-settings/categories"),
          api.get("/hunter-settings/locations"),
        ]);
        setCategories(c.data || []);
        setLocations(l.data || []);
      } catch { /* settings not seeded yet — empty dropdowns are fine */ }
    })();
  }, []);

  const addNewCategory = async () => {
    const name = newCatName.trim();
    if (!name) return;
    try {
      const { data } = await api.post("/hunter-settings/categories", { name });
      setCategories((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setCategoryId(data.id);
      setNewCatName(""); setShowNewCat(false);
      toast.success(`Kategori "${name}" ditambahkan`);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const addNewLocation = async () => {
    const name = newLocName.trim();
    if (!name) return;
    try {
      const { data } = await api.post("/hunter-settings/locations", { name });
      setLocations((prev) => [...prev, data].sort((a, b) => a.name.localeCompare(b.name)));
      setLocationId(data.id);
      setNewLocName(""); setShowNewLoc(false);
      toast.success(`Lokasi "${name}" ditambahkan`);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const toggle = (email) => {
    const s = new Set(selected);
    if (s.has(email)) {
      s.delete(email);
      if (primary === email) {
        const next = [...s][0];
        if (next) setPrimary(next);
      }
    } else {
      s.add(email);
      if (!primary) setPrimary(email);
    }
    setSelected(s);
  };

  const probeEmail = async (email) => {
    setProbing((p) => ({ ...p, [email]: true }));
    try {
      const { data } = await api.post("/email-verifier/probe", { email });
      const eng = data.status; // VALID | LIKELY_VALID | ACCEPT_ALL | INVALID | UNKNOWN
      const newUiStatus = data.ui_status || "unverified";
      const tested = {
        at: new Date().toISOString(),
        status: eng,
        ui_status: newUiStatus,
        recommendation: data.recommendation,
        score: data.score || 0,
      };
      // Merge probe result into the email object in-place
      setEmails((prev) => prev.map((e) =>
        e.email === email
          ? {
              ...e,
              status: newUiStatus,
              confidence: Math.max(e.confidence || 0, data.score || 0),
              verifier: { ...(e.verifier || {}), ...data },
              _tested: tested,
            }
          : e
      ));
      // Visible feedback toast — long enough to read
      if (eng === "VALID" || eng === "LIKELY_VALID") {
        toast.success(`✓ ${email} — VERIFIED (${eng}). Aman dikirim.`);
      } else if (eng === "INVALID") {
        toast.error(`✗ ${email} — INVALID. JANGAN kirim.`);
      } else if (eng === "ACCEPT_ALL") {
        toast.info(`⚠ ${email} — ACCEPT_ALL (catch-all). SMTP terima, tapi user spesifik tidak terbukti.`);
      } else {
        toast.info(`? ${email} — UNKNOWN. SMTP tidak respon.`);
      }
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setProbing((p) => ({ ...p, [email]: false }));
    }
  };

  const toggleAll = () => {
    if (selected.size === emails.length) {
      setSelected(new Set());
      setPrimary("");
    } else {
      setSelected(new Set(emails.map((e) => e.email)));
      if (!primary) setPrimary(emails[0]?.email || "");
    }
  };

  const submit = () => {
    if (selected.size === 0) return toast.error("Pilih minimal 1 email");
    const picked = emails.filter((e) => selected.has(e.email));
    onConfirm(picked, primary || picked[0].email, categoryId || null, locationId || null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card className="w-full max-w-2xl shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between rounded-t-xl">
            <div>
              <h2 className="font-display text-lg text-slate-900">Pilih email yang akan disimpan</h2>
              <div className="text-xs text-slate-500 mt-0.5">
                <b className="text-slate-700">{company}</b> · {domain}
              </div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500" data-testid="picker-close">
              <X size={20} weight="bold" />
            </button>
          </div>

          <div className="p-6">
            {/* Category & Location selector */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
              <div>
                <label className="text-xs font-medium text-slate-700 flex items-center justify-between">
                  Category
                  <button
                    type="button"
                    onClick={() => { setShowNewCat((v) => !v); setShowNewLoc(false); }}
                    className="text-[11px] text-indigo-600 hover:text-indigo-700 font-medium"
                    data-testid="add-cat-toggle"
                  >+ tambah baru</button>
                </label>
                {showNewCat ? (
                  <div className="mt-1 flex gap-1">
                    <input
                      type="text"
                      value={newCatName}
                      onChange={(e) => setNewCatName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addNewCategory()}
                      placeholder="Nama kategori..."
                      className="flex-1 px-2.5 py-1.5 border border-indigo-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      data-testid="new-cat-input"
                      autoFocus
                    />
                    <button type="button" onClick={addNewCategory} className="px-2 py-1.5 text-xs bg-indigo-600 text-white rounded-lg font-medium" data-testid="new-cat-save">Save</button>
                    <button type="button" onClick={() => { setShowNewCat(false); setNewCatName(""); }} className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700">×</button>
                  </div>
                ) : (
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="w-full mt-1 px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    data-testid="picker-category"
                  >
                    <option value="">— Pilih kategori (opsional) —</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className="text-xs font-medium text-slate-700 flex items-center justify-between">
                  Location
                  <button
                    type="button"
                    onClick={() => { setShowNewLoc((v) => !v); setShowNewCat(false); }}
                    className="text-[11px] text-indigo-600 hover:text-indigo-700 font-medium"
                    data-testid="add-loc-toggle"
                  >+ tambah baru</button>
                </label>
                {showNewLoc ? (
                  <div className="mt-1 flex gap-1">
                    <input
                      type="text"
                      value={newLocName}
                      onChange={(e) => setNewLocName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addNewLocation()}
                      placeholder="Nama lokasi..."
                      className="flex-1 px-2.5 py-1.5 border border-indigo-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      data-testid="new-loc-input"
                      autoFocus
                    />
                    <button type="button" onClick={addNewLocation} className="px-2 py-1.5 text-xs bg-indigo-600 text-white rounded-lg font-medium" data-testid="new-loc-save">Save</button>
                    <button type="button" onClick={() => { setShowNewLoc(false); setNewLocName(""); }} className="px-2 py-1.5 text-xs text-slate-500 hover:text-slate-700">×</button>
                  </div>
                ) : (
                  <select
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    className="w-full mt-1 px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    data-testid="picker-location"
                  >
                    <option value="">— Pilih lokasi (opsional) —</option>
                    {locations.map((l) => (
                      <option key={l.id} value={l.id}>{l.name}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between mb-3">
              <button onClick={toggleAll} className="text-xs text-indigo-600 hover:text-indigo-800 font-medium" data-testid="picker-toggle-all">
                {selected.size === emails.length ? "Uncheck all" : "Check all"}
              </button>
              <Badge tone="info">{selected.size} dari {emails.length} dipilih</Badge>
            </div>

            <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[420px] overflow-y-auto">
              {emails.map((e) => {
                const isChecked = selected.has(e.email);
                const isPrimary = primary === e.email;
                return (
                  <div
                    key={e.email}
                    className={`p-3 border-b border-slate-100 last:border-b-0 flex items-start gap-3 ${isChecked ? "bg-indigo-50/40" : "bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      className="accent-indigo-600 mt-1"
                      checked={isChecked}
                      onChange={() => toggle(e.email)}
                      data-testid={`picker-email-${e.email}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Status icon — instant visual signal for "can I send this?" */}
                        {(() => {
                          const eng = e.verifier?.status;
                          if (e.status === "verified" && eng === "VALID")        return <CheckCircle size={18} weight="fill" className="text-emerald-500" title="VALID — public + SMTP ok" />;
                          if (e.status === "verified" && eng === "LIKELY_VALID") return <CheckCircle size={18} weight="fill" className="text-emerald-500" title="LIKELY_VALID — SMTP ok" />;
                          if (e.status === "verified" && eng === "ACCEPT_ALL")   return <SealCheck  size={18} weight="fill" className="text-emerald-500" title="ACCEPT_ALL — alias confirmed on website" />;
                          if (e.status === "verified")                            return <CheckCircle size={18} weight="fill" className="text-emerald-500" title="Verified" />;
                          if (e.status === "invalid")                             return <XCircle    size={18} weight="fill" className="text-rose-500"    title="INVALID — SMTP rejected" />;
                          if (e.status === "risky")                               return <Warning    size={18} weight="fill" className="text-amber-500"   title="Risky" />;
                          if (eng === "ACCEPT_ALL")                               return <Warning    size={18} weight="fill" className="text-amber-500"   title="ACCEPT_ALL — domain catch-all, tidak terbukti user spesifik" />;
                          if (eng === "UNKNOWN")                                  return <Question   size={18} weight="fill" className="text-slate-400"   title="UNKNOWN — SMTP tidak respon" />;
                          return <Question size={18} weight="fill" className="text-slate-400" title="Unverified" />;
                        })()}
                        <span className="font-mono text-sm text-slate-900 break-all">{e.email}</span>
                        {isPrimary && isChecked && <Badge tone="info">primary</Badge>}
                        <Badge tone={e.status === "verified" ? "success" : e.status === "risky" ? "warning" : e.status === "invalid" ? "error" : "neutral"}>{e.status}</Badge>
                        {e.verifier?.status && e.verifier.status !== "VALID" && e.verifier.status !== "LIKELY_VALID" && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{e.verifier.status}</span>
                        )}
                        {e.confidence != null && (
                          <Badge tone={e.confidence >= 80 ? "success" : e.confidence >= 50 ? "warning" : "error"}>score {e.confidence}</Badge>
                        )}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {e.name && <span className="text-slate-700">{e.name}</span>}
                        {e.job_title && <span> · {e.job_title}</span>}
                        {e.source && <span> · src: {e.source}</span>}
                      </div>
                      {e.description && e.description !== "—" && (
                        <div className={`text-[11px] mt-1 leading-snug ${
                          e.status === "invalid" ? "text-rose-600"
                          : e.status === "risky" ? "text-amber-700"
                          : "text-slate-500"
                        }`}>
                          {e.description}
                        </div>
                      )}
                      {/* Verifier checks breakdown — proves engine ran SMTP/MX/catch-all */}
                      {e.verifier && (e.verifier.smtp_code != null || e.verifier.mx_found != null) && (
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap text-[10px]">
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${e.verifier.mx_found ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-600"}`}>
                            {e.verifier.mx_found ? "✓" : "✗"} MX{e.verifier.provider ? ` · ${e.verifier.provider}` : ""}
                          </span>
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${e.verifier.smtp_code === 250 ? "bg-emerald-50 text-emerald-700" : e.verifier.smtp_code == null ? "bg-slate-100 text-slate-500" : "bg-rose-50 text-rose-600"}`}>
                            {e.verifier.smtp_code === 250 ? "✓" : e.verifier.smtp_code == null ? "?" : "✗"} SMTP {e.verifier.smtp_code ?? "no-resp"}
                          </span>
                          {e.verifier.catch_all != null && (
                            <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded ${e.verifier.catch_all ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"}`}>
                              {e.verifier.catch_all ? "⚠ catch-all" : "✓ unique"}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Test result banner — appears after user clicks 🧪 Test */}
                      {e._tested && (() => {
                        const t = e._tested;
                        const isOk = t.status === "VALID" || t.status === "LIKELY_VALID";
                        const isFail = t.status === "INVALID";
                        const tone = isOk ? "emerald" : isFail ? "rose" : t.status === "ACCEPT_ALL" ? "amber" : "slate";
                        const icon = isOk ? "✓" : isFail ? "✗" : t.status === "ACCEPT_ALL" ? "⚠" : "?";
                        const label = isOk ? "VERIFIED — Aman dikirim" : isFail ? "INVALID — JANGAN kirim" : `${t.status} — Sendable, tapi belum 100% terbukti`;
                        const timeStr = new Date(t.at).toLocaleTimeString();
                        return (
                          <div
                            data-testid={`probe-result-${e.email}`}
                            className={`mt-2 rounded-lg border p-2.5 text-xs flex items-start gap-2 bg-${tone}-50 border-${tone}-200 text-${tone}-900`}
                            style={{
                              backgroundColor: isOk ? "#ecfdf5" : isFail ? "#fef2f2" : t.status === "ACCEPT_ALL" ? "#fffbeb" : "#f8fafc",
                              borderColor: isOk ? "#a7f3d0" : isFail ? "#fecaca" : t.status === "ACCEPT_ALL" ? "#fde68a" : "#e2e8f0",
                            }}
                          >
                            <div className="text-base leading-none mt-0.5">{icon}</div>
                            <div className="flex-1">
                              <div className="font-semibold flex items-center gap-1.5 flex-wrap">
                                Re-checked: {label}
                                <span className="text-[10px] font-normal opacity-70">@ {timeStr}</span>
                              </div>
                              <div className="text-[11px] mt-0.5 opacity-90">
                                {t.recommendation}
                              </div>
                              <div className="text-[10px] mt-1 opacity-70">
                                Status baru: <b>{t.ui_status}</b> · score <b>{t.score}</b>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                    <button
                      onClick={() => { setPrimary(e.email); if (!isChecked) toggle(e.email); }}
                      className={`text-[10px] px-2 py-1 rounded font-medium transition-colors shrink-0 ${
                        isPrimary && isChecked
                          ? "bg-indigo-600 text-white"
                          : "bg-slate-100 text-slate-600 hover:bg-indigo-100 hover:text-indigo-700"
                      }`}
                      data-testid={`picker-primary-${e.email}`}
                    >
                      Set primary
                    </button>
                    <button
                      onClick={() => probeEmail(e.email)}
                      disabled={probing[e.email]}
                      title="Re-check email pakai SMTP/MX/catch-all"
                      className="text-[10px] px-2 py-1 rounded font-medium transition-colors shrink-0 bg-violet-100 text-violet-700 hover:bg-violet-200 disabled:opacity-40 disabled:cursor-wait inline-flex items-center gap-1"
                      data-testid={`picker-probe-${e.email}`}
                    >
                      {probing[e.email] ? <Spinner size={10} weight="bold" className="animate-spin" /> : "🧪"} Test
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="text-[11px] text-slate-500 mt-3">
              💡 Klik <b>🧪 Test</b> untuk re-check satu email (SMTP probe + catch-all detection). Berguna untuk verifikasi alias yang masih ⚠ unverified.
            </div>
          </div>

          <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2 rounded-b-xl">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton onClick={submit} disabled={selected.size === 0} data-testid="picker-confirm-btn">
              <FloppyDisk size={14} weight="bold" /> Simpan {selected.size} email {nextMode ? "& Next →" : ""}
            </PrimaryButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ─────────────── BULK OUTREACH MODAL ─────────────── */
function OutreachModal({ todayList, activeTask, onClose, onSent }) {
  const { user } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set(todayList.map((p) => p.id)));
  const [form, setForm] = useState({
    template_id: "",
    subject: "Hi {{name}}, interested in a quick chat?",
    body_html: "<p>Hi {{name}},</p>\n<p>I came across {{company}} and wanted to reach out about a quick chat.</p>\n<p>Best,<br/>Your Name</p>",
    send_mode: "now",
    scheduled_date: activeTask?.date || new Date().toISOString().slice(0, 10),
    scheduled_time: "09:00",
  });
  const [sending, setSending] = useState(false);
  const [testEmail, setTestEmail] = useState(user?.email || "");
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    api.get("/templates").then(({ data }) => setTemplates(data)).catch(() => {});
  }, []);

  const pickTemplate = (tid) => {
    setForm((f) => ({ ...f, template_id: tid }));
    if (!tid) return;
    const t = templates.find((x) => x.id === tid);
    if (t) setForm((f) => ({ ...f, subject: t.subject, body_html: ensureHtml(t.body_html) }));
  };

  const toggle = (id) => {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  };

  const totalEmails = useMemo(() => {
    let total = 0;
    todayList.forEach((p) => { if (selectedIds.has(p.id)) total += (p.emails || []).length; });
    return total;
  }, [todayList, selectedIds]);

  const send = async () => {
    if (selectedIds.size === 0) return toast.error("Pick at least one prospect");
    if (!tested) {
      const proceed = window.confirm("Anda belum kirim test email. Yakin ingin lanjut kirim ke semua prospect?\n\nKlik OK untuk tetap kirim, atau Cancel untuk kirim test dulu.");
      if (!proceed) return;
    }
    setSending(true);
    try {
      const payload = {
        prospect_ids: Array.from(selectedIds),
        subject: form.subject,
        body_html: form.body_html,
        template_id: form.template_id || null,
      };
      if (form.send_mode === "scheduled") {
        const dt = new Date(`${form.scheduled_date}T${form.scheduled_time}:00`);
        if (isNaN(dt.getTime())) { setSending(false); return toast.error("Tanggal/jam jadwal tidak valid"); }
        if (dt.getTime() < Date.now() + 60_000) { setSending(false); return toast.error("Jadwal harus minimal 1 menit dari sekarang"); }
        payload.scheduled_at = dt.toISOString();
      }
      const { data } = await api.post("/prospects/bulk-send-email", payload);
      if (data.scheduled) {
        toast.success(`✓ ${data.queued} email terjadwal pada ${form.scheduled_date} ${form.scheduled_time}`);
      } else {
        toast.success(`Queued ${data.queued} email — jeda 3 menit per pengiriman`);
      }
      onSent ? onSent() : onClose();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSending(false); }
  };

  const sendTest = async () => {
    if (!testEmail || !testEmail.includes("@")) {
      toast.error("Masukkan email tujuan test yang valid");
      return;
    }
    setTesting(true);
    try {
      const { data } = await api.post("/email/send-test", {
        to_email: testEmail,
        subject: form.subject,
        body_html: form.body_html,
        template_id: form.template_id || null,
      });
      toast.success(`Test email terkirim ke ${data.to}. Cek inbox sebelum kirim ke prospect.`);
      setTested(true);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setTesting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card className="w-full max-w-5xl shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 rounded-t-xl">
            <div>
              <h2 className="font-display text-lg text-slate-900 flex items-center gap-2"><PaperPlaneTilt size={18} weight="bold" className="text-emerald-600" /> Email Outreach — Today&apos;s Batch</h2>
              <div className="text-xs text-slate-500">Send to <b>{totalEmails}</b> email(s) across {selectedIds.size} of {todayList.length} companies</div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500"><X size={20} weight="bold" /></button>
          </div>
          <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-3">
              <TermSelect label="Template" value={form.template_id} onChange={(e) => pickTemplate(e.target.value)} data-testid="outreach-template">
                <option value="">— blank —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </TermSelect>
              <TermInput label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="outreach-subject" />
              <div>
                <label className="text-xs font-medium text-slate-700 block mb-1.5">Body (supports {`{{name}}`} {`{{company}}`} variables)</label>
                <div className="quill-wrapper" data-testid="outreach-body">
                  <ReactQuill
                    theme="snow"
                    value={form.body_html}
                    onChange={(v) => setForm({ ...form, body_html: v })}
                    modules={QUILL_SIMPLE_MODULES}
                    placeholder="Tulis email Anda di sini..."
                  />
                </div>
              </div>
              <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                💡 SMTP otomatis pakai setting Anda (user) atau company tenant. Atur di Settings → Companies / Users.
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-2">Companies ({selectedIds.size}/{todayList.length}) · {totalEmails} email total</div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[480px] overflow-y-auto">
                {todayList.map((p) => {
                  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                  const cnt = (p.emails || []).length;
                  return (
                    <label key={p.id} className={`flex items-center gap-2 p-2 border-b border-slate-100 last:border-b-0 cursor-pointer ${selectedIds.has(p.id) ? "bg-indigo-50/50" : "bg-white"}`}>
                      <input type="checkbox" className="accent-indigo-600" checked={selectedIds.has(p.id)} onChange={() => toggle(p.id)} data-testid={`outreach-pick-${p.id}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 truncate">{p.company_name}</div>
                        <div className="text-xs text-slate-500 truncate font-mono">{primary?.email || "no email"}{cnt > 1 ? ` · +${cnt - 1} more` : ""}</div>
                      </div>
                      <Badge tone="info">{cnt}</Badge>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-slate-200 rounded-b-xl space-y-3">
            {/* Send Mode toggle (Now vs Schedule) */}
            <div>
              <div className="text-xs font-medium text-slate-700 mb-2">Mode Pengiriman</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, send_mode: "now" })}
                  data-testid="outreach-mode-now"
                  className={`text-left border rounded-xl p-3 transition-all ${form.send_mode === "now" ? "border-emerald-500 ring-2 ring-emerald-100 bg-emerald-50" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <PaperPlaneTilt size={16} weight="bold" className={form.send_mode === "now" ? "text-emerald-600" : "text-slate-400"} />
                  <div className="font-medium text-slate-900 text-sm mt-1">Kirim Sekarang</div>
                  <div className="text-[11px] text-slate-500">Langsung antri & terkirim (jeda 3 menit)</div>
                </button>
                <button
                  type="button"
                  onClick={() => setForm({ ...form, send_mode: "scheduled" })}
                  data-testid="outreach-mode-scheduled"
                  className={`text-left border rounded-xl p-3 transition-all ${form.send_mode === "scheduled" ? "border-purple-500 ring-2 ring-purple-100 bg-purple-50" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <Clock size={16} weight="bold" className={form.send_mode === "scheduled" ? "text-purple-600" : "text-slate-400"} />
                  <div className="font-medium text-slate-900 text-sm mt-1">Jadwalkan</div>
                  <div className="text-[11px] text-slate-500">Pilih tanggal & jam pengiriman</div>
                </button>
              </div>
              {form.send_mode === "scheduled" && (
                <div className="mt-2 grid grid-cols-2 gap-2 p-3 bg-purple-50 border border-purple-200 rounded-xl">
                  <div>
                    <label className="text-[11px] font-medium text-purple-900 block mb-1">Tanggal</label>
                    <input
                      type="date"
                      value={form.scheduled_date}
                      min={new Date().toISOString().slice(0, 10)}
                      onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })}
                      className="w-full px-2.5 py-1.5 border border-purple-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                      data-testid="outreach-scheduled-date"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] font-medium text-purple-900 block mb-1">Jam</label>
                    <input
                      type="time"
                      value={form.scheduled_time}
                      onChange={(e) => setForm({ ...form, scheduled_time: e.target.value })}
                      className="w-full px-2.5 py-1.5 border border-purple-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-purple-500"
                      data-testid="outreach-scheduled-time"
                    />
                  </div>
                  <div className="col-span-2 text-[10px] text-purple-700">
                    Email akan otomatis terkirim sesuai jadwal · zona waktu <b>Asia/Makassar (WITA, UTC+8)</b> · worker scheduler poll tiap 60 detik · throttle 180 detik antar pengiriman.
                  </div>
                </div>
              )}
            </div>

            {/* Test Email row */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <PaperPlaneTilt size={14} weight="bold" className="text-amber-600" />
                <span className="text-xs font-semibold text-amber-900">Kirim Test Email dulu</span>
                {tested && <Badge tone="success">✓ Test terkirim</Badge>}
              </div>
              <div className="flex gap-2 items-stretch">
                <input
                  type="email"
                  value={testEmail}
                  onChange={(e) => { setTestEmail(e.target.value); setTested(false); }}
                  placeholder="email-anda@domain.com"
                  className="flex-1 px-3 py-1.5 border border-amber-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                  data-testid="test-email-input"
                />
                <button
                  onClick={sendTest}
                  disabled={testing}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50 shrink-0"
                  data-testid="send-test-btn"
                >
                  <PaperPlaneTilt size={12} weight="bold" /> {testing ? "Mengirim test..." : "Kirim Test"}
                </button>
              </div>
              <div className="text-[10px] text-amber-700 mt-1.5">
                Test akan kirim 1 email dengan prefix [TEST] + variable {`{{name}}/{{company}}`} terisi contoh, ke email Anda. Tidak masuk hitungan quota / activity log.
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="text-xs text-slate-500">
                Tracking pixel + click-redirect auto-injected. <b>Jeda 3 menit antar email</b> (anti-spam).
              </div>
              <div className="flex gap-2">
                <GhostButton onClick={onClose}>Cancel</GhostButton>
                <PrimaryButton onClick={send} disabled={sending || selectedIds.size === 0} data-testid="outreach-send-btn">
                  {form.send_mode === "scheduled"
                    ? <><Clock size={14} weight="bold" /> {sending ? "Scheduling..." : `Jadwalkan ${totalEmails} email`}</>
                    : <><PaperPlaneTilt size={14} weight="bold" /> {sending ? "Queuing..." : `Send ${totalEmails} email`}</>}
                </PrimaryButton>
              </div>
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


/* ─────────────── EMAIL STEP (Tab 3) ─────────────── */
function EmailStep({ task, onSubmitted }) {
  const { user } = useAuth();
  const [templates, setTemplates] = useState([]);
  const [prospects, setProspects] = useState([]);
  const [form, setForm] = useState({
    template_id: "",
    subject: "Hi {{name}}, quick question about {{company}}",
    body_html: "<p>Hi {{name}},</p>\n<p>I came across {{company}} and wanted to reach out.</p>\n<p>Best,<br/>Your Name</p>",
    send_mode: "now",
    scheduled_date: task?.date || new Date().toISOString().slice(0, 10),
    scheduled_time: "09:00",
  });
  const [submitting, setSubmitting] = useState(false);
  const [testEmail, setTestEmail] = useState(user?.email || "");
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    api.get("/templates").then(({ data }) => setTemplates(data)).catch(() => {});
    api.get(`/tasks/${task.id}`).then(({ data }) => setProspects(data.prospects || [])).catch(() => {});
  }, [task.id]);

  const pickTemplate = (tid) => {
    setForm((f) => ({ ...f, template_id: tid }));
    if (!tid) return;
    const t = templates.find((x) => x.id === tid);
    if (t) setForm((f) => ({ ...f, subject: t.subject, body_html: ensureHtml(t.body_html) }));
  };

  const sendTest = async () => {
    if (!testEmail || !testEmail.includes("@")) {
      toast.error("Masukkan email tujuan test yang valid");
      return;
    }
    setTesting(true);
    try {
      const { data } = await api.post("/email/send-test", {
        to_email: testEmail,
        subject: form.subject,
        body_html: form.body_html,
        template_id: form.template_id || null,
      });
      toast.success(`Test email terkirim ke ${data.to}. Cek inbox sebelum kirim ke prospect.`);
      setTested(true);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setTesting(false); }
  };

  const totalEmails = useMemo(() => prospects.reduce((acc, p) => acc + (p.emails || []).length, 0), [prospects]);

  const submit = async () => {
    if (!tested) {
      const proceed = window.confirm("Anda belum kirim test email. Yakin ingin lanjut kirim ke semua prospect?\n\nKlik OK untuk tetap kirim, atau Cancel untuk kirim test dulu.");
      if (!proceed) return;
    }
    setSubmitting(true);
    try {
      const payload = {
        template_id: form.template_id || null,
        subject: form.subject,
        body_html: form.body_html,
        send_mode: form.send_mode,
      };
      if (form.send_mode === "scheduled") {
        const dt = new Date(`${form.scheduled_date}T${form.scheduled_time}:00`);
        payload.scheduled_send_at = dt.toISOString();
      }
      const { data } = await api.post(`/tasks/${task.id}/submit`, payload);
      toast.success(form.send_mode === "scheduled"
        ? `✓ ${data.queued} email terjadwal pada ${form.scheduled_date} ${form.scheduled_time}`
        : `✓ ${data.queued} email dikirim — jeda 3 menit per email`);
      onSubmitted();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSubmitting(false); }
  };

  return (
    <div className="space-y-5">
      {/* If the task has been submitted (scheduled / sending / sent / completed) → show a
          clean read-only confirmation. No form, no buttons. User is nudged to Analitik. */}
      {task.status && !["draft", "ready"].includes(task.status) ? (
        <Card className="p-6 bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200" data-testid="task-submitted-confirmation">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-600 text-white grid place-items-center shrink-0">
              <CheckCircle size={28} weight="fill" />
            </div>
            <div className="flex-1">
              <div className="text-[10px] uppercase tracking-widest text-emerald-700 font-semibold">
                {task.status === "scheduled" ? "Email Telah Dijadwalkan" : task.status === "completed" ? "Email Telah Terkirim" : "Email Sedang Diproses"}
              </div>
              <div className="font-display text-lg font-semibold text-slate-900 mt-0.5">{task.name}</div>
              <div className="text-sm text-slate-600 mt-1">
                {task.prospect_count} prospect · target {task.target} · tanggal {task.date}
              </div>
              {task.status === "scheduled" && task.scheduled_send_at && (
                <div className="mt-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-emerald-200 text-xs text-emerald-700 font-medium">
                  <Clock size={14} weight="bold" /> Akan terkirim: {new Date(task.scheduled_send_at).toLocaleString()}
                </div>
              )}
              <div className="text-xs text-slate-500 mt-4">
                Tugas tanggal ini sudah selesai. Cek progress di tab <b className="text-slate-700">4 · Analitik</b> untuk status pengiriman (queued / delivered / opened / replied).
              </div>
            </div>
          </div>
        </Card>
      ) : (
      <>
      <Card className="p-4 bg-emerald-50 border-emerald-200">
        <div className="flex items-center gap-3">
          <CheckCircle size={20} weight="fill" className="text-emerald-600" />
          <div>
            <div className="font-display text-sm font-semibold text-slate-900">Tugas Siap Dikirim: {task.name}</div>
            <div className="text-xs text-slate-600">{task.prospect_count} prospect terkumpul · target {task.target} tercapai · {task.date}</div>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card className="p-5">
          <h3 className="font-display text-base font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <PaperPlaneTilt size={16} weight="bold" className="text-indigo-600" /> Konfigurasi Email
          </h3>
          <div className="space-y-3">
            <TermSelect label="Template" value={form.template_id} onChange={(e) => pickTemplate(e.target.value)} data-testid="email-template">
              <option value="">— blank —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </TermSelect>
            <TermInput label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="email-subject" />
            <div>
              <label className="text-xs font-medium text-slate-700 block mb-1.5">Body (supports {`{{name}}`} {`{{company}}`})</label>
              <div className="quill-wrapper" data-testid="email-body">
                <ReactQuill
                  theme="snow"
                  value={form.body_html}
                  onChange={(v) => setForm({ ...form, body_html: v })}
                  modules={QUILL_SIMPLE_MODULES}
                  placeholder="Tulis email Anda di sini..."
                />
              </div>
            </div>
            <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
              💡 SMTP otomatis pakai setting Anda (user) atau company tenant. Atur di Settings → Companies / Users.
            </div>
          </div>

          {/* Test Email — kirim 1 email contoh ke diri sendiri dulu */}
          <div className="mt-4 border-t border-slate-200 pt-4">
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <PaperPlaneTilt size={14} weight="bold" className="text-amber-600" />
                <span className="text-sm font-semibold text-amber-900">Kirim Test Email dulu</span>
                {tested && <Badge tone="success">✓ Test terkirim</Badge>}
              </div>
              <div className="flex gap-2 items-stretch">
                <input
                  type="email"
                  value={testEmail}
                  onChange={(e) => { setTestEmail(e.target.value); setTested(false); }}
                  placeholder="email-anda@domain.com"
                  className="flex-1 px-3 py-1.5 border border-amber-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                  data-testid="emailstep-test-email-input"
                />
                <button
                  onClick={sendTest}
                  disabled={testing}
                  className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium flex items-center gap-1 disabled:opacity-50 shrink-0"
                  data-testid="emailstep-send-test-btn"
                >
                  <PaperPlaneTilt size={12} weight="bold" /> {testing ? "Mengirim..." : "Kirim Test"}
                </button>
              </div>
              <div className="text-[10px] text-amber-700 mt-1.5">
                Kirim 1 email dengan prefix [TEST] + variable {`{{name}}/{{company}}`} terisi contoh. Tidak masuk hitungan quota / activity log.
              </div>
            </div>
          </div>

          {/* Send mode */}
          <div className="mt-4 border-t border-slate-200 pt-4">
            <div className="text-sm font-medium text-slate-700 mb-2">Mode Pengiriman</div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <button
                type="button"
                onClick={() => setForm({ ...form, send_mode: "now" })}
                data-testid="mode-now"
                className={`text-left border rounded-xl p-3 transition-all ${form.send_mode === "now" ? "border-emerald-500 ring-2 ring-emerald-100 bg-emerald-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <PaperPlaneTilt size={18} weight="bold" className={form.send_mode === "now" ? "text-emerald-600" : "text-slate-400"} />
                <div className="font-medium text-slate-900 text-sm mt-1">Kirim Sekarang</div>
                <div className="text-[11px] text-slate-500">Langsung antri & terkirim</div>
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, send_mode: "scheduled" })}
                data-testid="mode-scheduled"
                className={`text-left border rounded-xl p-3 transition-all ${form.send_mode === "scheduled" ? "border-purple-500 ring-2 ring-purple-100 bg-purple-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <Clock size={18} weight="bold" className={form.send_mode === "scheduled" ? "text-purple-600" : "text-slate-400"} />
                <div className="font-medium text-slate-900 text-sm mt-1">Jadwalkan</div>
                <div className="text-[11px] text-slate-500">Tentukan jam & tanggal</div>
              </button>
            </div>
            {form.send_mode === "scheduled" && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-1">Tanggal</label>
                  <input type="date" value={form.scheduled_date} onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" data-testid="schedule-date" />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-1">Jam (UTC)</label>
                  <input type="time" value={form.scheduled_time} onChange={(e) => setForm({ ...form, scheduled_time: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm" data-testid="schedule-time" />
                </div>
              </div>
            )}
          </div>

          <div className="mt-5 pt-4 border-t border-slate-200">
            <PrimaryButton onClick={submit} disabled={submitting} data-testid="submit-task-btn" className="w-full justify-center">
              {form.send_mode === "now"
                ? <><PaperPlaneTilt size={14} weight="bold" /> {submitting ? "Mengirim..." : `Kirim ${totalEmails} email ke ${prospects.length} company sekarang`}</>
                : <><Clock size={14} weight="bold" /> {submitting ? "Menjadwalkan..." : `Jadwalkan ${totalEmails} email`}</>}
            </PrimaryButton>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-display text-base font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <UsersFour size={16} weight="bold" className="text-indigo-600" /> Recipients ({prospects.length} company · {totalEmails} email)
          </h3>
          <div className="border border-slate-200 rounded-lg max-h-[480px] overflow-y-auto">
            {prospects.map((p) => {
              const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
              const cnt = (p.emails || []).length;
              return (
                <div key={p.id} className="p-2.5 border-b border-slate-100 last:border-b-0 flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-indigo-50 text-indigo-600 grid place-items-center font-medium text-xs">
                    {(p.company_name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900 truncate">{p.company_name}</div>
                    <div className="text-xs text-slate-500 truncate font-mono">{primary?.email || "—"}{cnt > 1 ? ` · +${cnt - 1} more` : ""}</div>
                  </div>
                  <Badge tone="info">{cnt}</Badge>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      </>
      )}
    </div>
  );
}

/* ─────────────── TASKS LIST (Tersimpan tab) ─────────────── */
function TasksList({ refreshKey, onPick, onRefresh }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");

  const load = async () => {
    const params = {};
    if (statusFilter) params.status = statusFilter;
    try { const { data } = await api.get("/tasks", { params }); setRows(data); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, [statusFilter, refreshKey]);

  const remove = async (tid) => {
    if (!window.confirm("Hapus tugas ini?")) return;
    try { await api.delete(`/tasks/${tid}`); toast.success("Dihapus"); onRefresh?.(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  const STATUSES = [
    { key: "",          label: "Semua" },
    { key: "draft",     label: "📝 Draft" },
    { key: "ready",     label: "🎯 Siap Kirim" },
    { key: "sending",   label: "🚀 Sedang Kirim" },
    { key: "scheduled", label: "⏰ Terjadwal" },
    { key: "completed", label: "✅ Selesai" },
  ];

  const STATUS_TONES = {
    draft: "neutral", ready: "info", sending: "warning",
    scheduled: "purple", completed: "success",
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s.key}
            onClick={() => setStatusFilter(s.key)}
            data-testid={`task-filter-${s.key || "all"}`}
            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
              statusFilter === s.key ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={CalendarCheck} title="Belum ada tugas tersimpan" description="Buat tugas baru dari tab Jadwal dengan klik tanggal di kalender." />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rows.map((t) => {
            const pct = t.target > 0 ? Math.min(100, Math.round((t.prospect_count / t.target) * 100)) : 0;
            const editable = t.status === "draft" || t.status === "ready";
            return (
              <Card key={t.id} className="p-5 hover:border-indigo-200 transition-colors">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="min-w-0">
                    <div className="font-display text-base font-semibold text-slate-900 truncate">{t.name}</div>
                    <div className="text-xs text-slate-500">{t.date}</div>
                  </div>
                  <Badge tone={STATUS_TONES[t.status] || "neutral"}>{t.status}</Badge>
                </div>
                <div className="mb-2">
                  <div className="flex justify-between items-baseline mb-1">
                    <div className="text-sm font-medium text-slate-700">{t.prospect_count} / {t.target} prospects</div>
                    <div className="text-xs text-slate-500">{pct}%</div>
                  </div>
                  <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-indigo-500 to-purple-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                {t.scheduled_send_at && (
                  <div className="text-[11px] text-purple-600 mb-2"><Clock size={11} weight="bold" className="inline" /> {new Date(t.scheduled_send_at).toLocaleString("id-ID")}</div>
                )}
                <div className="flex items-center gap-1 mt-3">
                  {editable && (
                    <PrimaryButton onClick={() => onPick(t)} data-testid={`task-pick-${t.id}`}>
                      Lanjutkan →
                    </PrimaryButton>
                  )}
                  {!editable && t.send_ids?.length > 0 && (
                    <GhostButton onClick={() => navigate("/activity")} data-testid={`task-view-${t.id}`}>
                      Lihat aktivitas
                    </GhostButton>
                  )}
                  <button onClick={() => remove(t.id)} className="ml-auto text-slate-400 hover:text-rose-600 p-1.5" data-testid={`task-del-${t.id}`}><Trash size={14} weight="bold" /></button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
