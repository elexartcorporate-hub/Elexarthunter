import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Buildings, UsersThree, ShieldCheck, Tag, MapPin, Key,
  Plus, Trash, PencilSimple, X, Lock, EnvelopeSimple, CalendarBlank, Target,
  LinkedinLogo,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const SUB_NAV = [
  { key: "companies",  label: "Companies",    icon: Buildings,    desc: "Sub-companies under your tenant" },
  { key: "users",      label: "Users",         icon: UsersThree,   desc: "Team members & access" },
  { key: "roles",      label: "Roles",         icon: ShieldCheck,  desc: "Permissions per role" },
  { key: "targets",    label: "Target Harian", icon: Target,       desc: "Set daily prospect target per user" },
  { key: "schedule",   label: "Working Days",  icon: CalendarBlank, desc: "Working days & holidays" },
  { key: "categories", label: "Categories",    icon: Tag,          desc: "Industry / vertical tags" },
  { key: "locations",  label: "Locations",     icon: MapPin,       desc: "Cities / regions" },
  { key: "api",        label: "Hunter.io API", icon: Key,          desc: "External API key" },
];

export default function Settings() {
  const { user, tenant } = useAuth();
  const [section, setSection] = useState("companies");
  if (!user) return null;

  return (
    <div className="p-8 max-w-[1600px] mx-auto fade-up">
      <PageHeader title="Settings" subtitle="Manage your tenant, sub-companies, team and integrations" />
      <div className="grid grid-cols-12 gap-6">
        <aside className="col-span-12 md:col-span-3 lg:col-span-2">
          <Card className="p-2">
            {SUB_NAV.map((s) => (
              <button
                key={s.key}
                onClick={() => setSection(s.key)}
                data-testid={`subnav-${s.key}`}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  section === s.key
                    ? "bg-indigo-50 text-indigo-700"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
              >
                <s.icon size={18} weight={section === s.key ? "fill" : "regular"} />
                <span>{s.label}</span>
              </button>
            ))}
          </Card>
        </aside>
        <section className="col-span-12 md:col-span-9 lg:col-span-10">
          {section === "companies"  && <CompaniesSection />}
          {section === "users"      && <UsersSection currentUser={user} />}
          {section === "roles"      && <RolesSection currentUser={user} />}
          {section === "targets"    && <TargetsSection currentUser={user} />}
          {section === "schedule"   && <ScheduleSection />}
          {section === "categories" && <CategoriesSection />}
          {section === "locations"  && <SimpleListSection title="Locations" subtitle="City, country or region — to filter your leads geographically." path="locations" icon={MapPin} placeholder="e.g. Jakarta, Bali, Singapore" />}
          {section === "api"        && <ApiSection />}
        </section>
      </div>
    </div>
  );
}

/* ──────────── TARGETS (Daily Target per user) ──────────── */
function TargetsSection({ currentUser }) {
  const [users, setUsers] = useState([]);
  const [myEmailTarget, setMyEmailTarget] = useState("");
  const [myLiTarget, setMyLiTarget] = useState("");
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingLi, setSavingLi] = useState(false);
  const [emailEdits, setEmailEdits] = useState({});
  const [liEdits, setLiEdits] = useState({});

  const canManageTeam = currentUser?.role === "Owner" ||
    (currentUser?.permissions || []).includes("set_team_targets");

  const load = async () => {
    try {
      const me = await api.get("/auth/me");
      setMyEmailTarget(String(me.data.user.daily_target ?? 0));
      setMyLiTarget(String(me.data.user.linkedin_daily_target ?? 15));
      if (canManageTeam) {
        const { data } = await api.get("/team");
        setUsers(data);
      }
    } catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, []);

  const saveMyEmail = async () => {
    const n = parseInt(myEmailTarget, 10);
    if (Number.isNaN(n) || n < 0) return toast.error("Target harus angka >= 0");
    setSavingEmail(true);
    try {
      await api.patch("/me/target", { daily_target: n });
      toast.success(`Target Email Anda di-set ke ${n}`);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSavingEmail(false); }
  };

  const saveMyLi = async () => {
    const n = parseInt(myLiTarget, 10);
    if (Number.isNaN(n) || n < 0) return toast.error("Target harus angka >= 0");
    setSavingLi(true);
    try {
      await api.patch("/me/linkedin-target", { linkedin_daily_target: n });
      toast.success(`Target LinkedIn Anda di-set ke ${n}`);
    } catch (err) {
      if (err?.response?.status === 404) toast.warning("Endpoint LinkedIn target belum tersedia di backend VPS. Jalankan: bash wa-setup.sh");
      else toast.error(formatApiError(err));
    }
    finally { setSavingLi(false); }
  };

  const saveUserTarget = async (uid, kind) => {
    const v = (kind === "email" ? emailEdits : liEdits)[uid];
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 0) return toast.error("Target harus angka >= 0");
    try {
      const path = kind === "email" ? `/team/${uid}/target` : `/team/${uid}/linkedin-target`;
      const body = kind === "email" ? { daily_target: n } : { linkedin_daily_target: n };
      await api.patch(path, body);
      toast.success(`Target ${kind} di-update`);
      if (kind === "email") setEmailEdits((e) => { const c = { ...e }; delete c[uid]; return c; });
      else setLiEdits((e) => { const c = { ...e }; delete c[uid]; return c; });
      load();
    } catch (err) {
      if (err?.response?.status === 404 && kind === "linkedin") {
        toast.warning("Endpoint LinkedIn target belum tersedia di backend VPS. Jalankan: bash wa-setup.sh");
      } else toast.error(formatApiError(err));
    }
  };

  return (
    <div className="space-y-5">
      {/* My targets — two cards side by side on desktop */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* EMAIL TARGET */}
        <Card className="p-6 border-l-4 border-l-indigo-500">
          <div className="flex items-center gap-2 mb-2">
            <EnvelopeSimple size={20} weight="fill" className="text-indigo-600"/>
            <h2 className="font-display text-lg font-bold text-slate-900">Target Harian — Email</h2>
          </div>
          <p className="text-sm text-slate-500 mb-4">Jumlah <b>prospect (domain)</b> per hari untuk email outreach. Email outreach terkunci sampai target tercapai.</p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">Daily target (domain)</label>
              <input type="number" min="0" max="1000" value={myEmailTarget} onChange={(e) => setMyEmailTarget(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-base focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                data-testid="my-target-input" />
            </div>
            <PrimaryButton onClick={saveMyEmail} disabled={savingEmail} data-testid="save-my-target-btn">
              <Target size={14} weight="bold" /> {savingEmail ? "..." : "Simpan"}
            </PrimaryButton>
          </div>
          <div className="text-[11px] text-slate-500 mt-2">Set 0 untuk disable daily-quest.</div>
        </Card>

        {/* LINKEDIN TARGET */}
        <Card className="p-6 border-l-4 border-l-[#0A66C2]">
          <div className="flex items-center gap-2 mb-2">
            <LinkedinLogo size={20} weight="fill" className="text-[#0A66C2]"/>
            <h2 className="font-display text-lg font-bold text-slate-900">Target Harian — LinkedIn</h2>
          </div>
          <p className="text-sm text-slate-500 mb-4">Jumlah <b>prospect LinkedIn</b> yang harus di-Add per hari. Tab <b>3 · Connect</b> terkunci sampai target tercapai.</p>
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">Daily target (prospect)</label>
              <input type="number" min="0" max="500" value={myLiTarget} onChange={(e) => setMyLiTarget(e.target.value)}
                className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-base focus:border-[#0A66C2] focus:ring-2 focus:ring-[#0A66C2]/20"
                data-testid="my-li-target-input" />
            </div>
            <PrimaryButton onClick={saveMyLi} disabled={savingLi} data-testid="save-my-li-target-btn"
              className="!bg-[#0A66C2] hover:!bg-[#084d92]">
              <LinkedinLogo size={14} weight="bold" /> {savingLi ? "..." : "Simpan"}
            </PrimaryButton>
          </div>
          <div className="text-[11px] text-slate-500 mt-2">Default: 15. Setiap prospect yang di-Add di tab Add Prospect bertambah ke counter.</div>
        </Card>
      </div>

      {/* Team targets table — combined view */}
      {canManageTeam && (
        <Card className="p-6">
          <h2 className="font-display text-xl text-slate-900">Target Tim</h2>
          <p className="text-sm text-slate-500 mb-4">Atur target harian Email & LinkedIn untuk setiap anggota tim. Hanya Owner/Admin yang bisa mengubah.</p>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                <tr>
                  <th className="text-left p-3">Nama</th>
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3 w-40">
                    <span className="inline-flex items-center gap-1"><EnvelopeSimple size={12} weight="fill" className="text-indigo-600"/> Target Email</span>
                  </th>
                  <th className="text-left p-3 w-40">
                    <span className="inline-flex items-center gap-1"><LinkedinLogo size={12} weight="fill" className="text-[#0A66C2]"/> Target LinkedIn</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const emailDraft = emailEdits[u.id];
                  const liDraft = liEdits[u.id];
                  const emailCur = u.daily_target ?? 0;
                  const liCur = u.linkedin_daily_target ?? 15;
                  const emailIsEditing = emailDraft !== undefined;
                  const liIsEditing = liDraft !== undefined;
                  return (
                    <tr key={u.id} className="border-t border-slate-100">
                      <td className="p-3">
                        <div className="font-medium text-slate-900">{u.name}</div>
                        <div className="text-[11px] text-slate-500">{u.email}</div>
                      </td>
                      <td className="p-3 text-xs"><Badge tone="info">{u.role}</Badge></td>
                      <td className="p-3">
                        <div className="flex gap-1">
                          <input type="number" min="0" max="1000"
                            value={emailIsEditing ? emailDraft : emailCur}
                            onChange={(e) => setEmailEdits({ ...emailEdits, [u.id]: e.target.value })}
                            className="w-20 px-2 py-1 border border-slate-200 rounded text-sm focus:border-indigo-500"
                            data-testid={`target-input-${u.id}`} />
                          {emailIsEditing && (
                            <button onClick={() => saveUserTarget(u.id, "email")}
                              className="px-2 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 font-semibold"
                              data-testid={`save-target-${u.id}`}>Save</button>
                          )}
                        </div>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1">
                          <input type="number" min="0" max="500"
                            value={liIsEditing ? liDraft : liCur}
                            onChange={(e) => setLiEdits({ ...liEdits, [u.id]: e.target.value })}
                            className="w-20 px-2 py-1 border border-slate-200 rounded text-sm focus:border-[#0A66C2]"
                            data-testid={`li-target-input-${u.id}`} />
                          {liIsEditing && (
                            <button onClick={() => saveUserTarget(u.id, "linkedin")}
                              className="px-2 py-1 text-xs bg-[#0A66C2] text-white rounded hover:bg-[#084d92] font-semibold"
                              data-testid={`save-li-target-${u.id}`}>Save</button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}



/* ──────────── SCHEDULE (Working Days & Holidays) ──────────── */
function ScheduleSection() {
  const DAYS = [
    { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
    { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" },
  ];
  const [config, setConfig] = useState({ working_days: [], holidays: [] });
  const [newDate, setNewDate] = useState("");
  const [loading, setLoading] = useState(false);

  const load = async () => {
    try { const { data } = await api.get("/working-config"); setConfig(data); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { load(); }, []);

  const save = async (patch, after) => {
    setLoading(true);
    try {
      const { data } = await api.patch("/working-config", patch);
      setConfig(data);
      toast.success("Saved");
      if (after) after();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  const toggleDay = (k) => {
    const next = config.working_days.includes(k)
      ? config.working_days.filter((d) => d !== k)
      : [...config.working_days, k];
    save({ working_days: next });
  };

  const addHoliday = () => {
    if (!newDate) return;
    if (config.holidays.includes(newDate)) return toast.error("Already added");
    save({ holidays: [...config.holidays, newDate] }, () => setNewDate(""));
  };
  const removeHoliday = (d) => save({ holidays: config.holidays.filter((x) => x !== d) });

  return (
    <Card className="p-6">
      <h2 className="font-display text-xl text-slate-900">Working Days &amp; Holidays</h2>
      <p className="text-sm text-slate-500 mb-5">Used by the daily-quota lock — emails auto-unlock on non-working days &amp; holidays.</p>

      <div className="mb-6">
        <div className="text-sm font-semibold text-slate-700 mb-2">Working days</div>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((d) => {
            const on = config.working_days.includes(d.key);
            return (
              <button
                key={d.key}
                onClick={() => toggleDay(d.key)}
                disabled={loading}
                data-testid={`day-${d.key}`}
                className={`px-4 py-2 rounded-lg text-xs font-medium border transition-all ${
                  on ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-200 text-slate-600 hover:border-slate-300"
                }`}
              >
                {d.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-slate-500 mt-2">Tick the days your team works. Default: Mon–Fri.</p>
      </div>

      <div>
        <div className="text-sm font-semibold text-slate-700 mb-2">Holidays (one-off dates)</div>
        <div className="flex items-center gap-2 mb-3">
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            data-testid="holiday-date-input"
          />
          <PrimaryButton onClick={addHoliday} disabled={!newDate || loading} data-testid="add-holiday-btn">
            <Plus size={14} weight="bold" /> Add holiday
          </PrimaryButton>
        </div>
        {config.holidays.length === 0 ? (
          <div className="text-xs text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">No holidays set</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {config.holidays.map((d) => (
              <div key={d} className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 rounded-full text-xs" data-testid={`holiday-${d}`}>
                <CalendarBlank size={12} weight="bold" />
                {new Date(d).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}
                <button onClick={() => removeHoliday(d)} className="text-amber-500 hover:text-rose-600" data-testid={`remove-holiday-${d}`}>
                  <X size={12} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}


/* ──────────── COMPANIES (sub-companies) ──────────── */
function CompaniesSection() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null); // null | "new" | id
  const [form, setForm] = useState({ name: "", legal_name: "", phone: "", email_provider: "other", smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_from_email: "", smtp_from_name: "", smtp_use_tls: true, imap_host: "", imap_port: 993, imap_ssl: true, imap_user: "", imap_password: "" });
  const [linkedin, setLinkedin] = useState({ profile_url: "", profile_name: "", signature: "", default_connection_template: "" });
  const [linkedinDirty, setLinkedinDirty] = useState(false);
  const [linkedinAvailable, setLinkedinAvailable] = useState(true); // endpoint missing on old VPS backends

  const load = async () => { try { const { data } = await api.get("/sub-companies"); setList(data); } catch (e) { toast.error(formatApiError(e)); } };
  useEffect(() => { load(); }, []);

  const blankLinkedin = () => ({ profile_url: "", profile_name: "", signature: "", default_connection_template: "", li_session_configured: false, li_session_status: "none", li_at_masked: "", jsessionid_masked: "", li_session_validated_at: null });

  const startNew = () => { setForm({ name: "", legal_name: "", phone: "", email_provider: "other", smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_from_email: "", smtp_from_name: "", smtp_use_tls: true, imap_host: "", imap_port: 993, imap_ssl: true, imap_user: "", imap_password: "" }); setLinkedin(blankLinkedin()); setLinkedinDirty(false); setEditing("new"); };
  const startEdit = async (sc) => {
    setForm({ ...sc, email_provider: sc.email_provider || "other", smtp_password: "", imap_password: "" });
    setLinkedin(blankLinkedin());
    setLinkedinDirty(false);
    setEditing(sc.id);
    // Try fetching LinkedIn settings — gracefully degrade if endpoint missing on old backend
    try {
      const { data } = await api.get(`/companies/${sc.id}/linkedin-settings`);
      const ls = data?.linkedin_settings || {};
      setLinkedin({
        profile_url: ls.profile_url || "",
        profile_name: ls.profile_name || "",
        signature: ls.signature || "",
        default_connection_template: ls.default_connection_template || "",
        li_session_configured: !!ls.li_session_configured,
        li_session_status: ls.li_session_status || "none",
        li_at_masked: ls.li_at_masked || "",
        jsessionid_masked: ls.jsessionid_masked || "",
        li_session_validated_at: ls.li_session_validated_at || null,
      });
      setLinkedinAvailable(true);
    } catch (err) {
      if (err?.response?.status === 404) setLinkedinAvailable(false);
    }
  };

  const applyProvider = (provider) => {
    const presets = {
      zoho:  { smtp_host: "smtppro.zoho.com", smtp_port: 465, smtp_use_tls: true, imap_host: "imappro.zoho.com", imap_port: 993, imap_ssl: true },
      gmail: { smtp_host: "smtp.gmail.com",    smtp_port: 465, smtp_use_tls: true, imap_host: "imap.gmail.com",    imap_port: 993, imap_ssl: true },
      other: {},
    };
    setForm((f) => ({ ...f, email_provider: provider, ...(presets[provider] || {}) }));
  };

  const testSmtp = async () => {
    if (editing === "new") return toast.error("Save dulu sebelum test");
    const to = window.prompt("Test SMTP — kirim test email ke alamat:", form.smtp_from_email || "");
    if (!to) return;
    try {
      const { data } = await api.post(`/sub-companies/${editing}/test-smtp`, { to_email: to });
      toast.success(`✓ ${data.message}`);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const testImap = async () => {
    if (editing === "new") return toast.error("Save dulu sebelum test");
    try {
      const { data } = await api.post(`/sub-companies/${editing}/test-imap`);
      toast.success(`✓ ${data.message}`);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const save = async () => {
    if (!form.name.trim()) return toast.error("Company name required");
    try {
      const payload = { ...form, smtp_port: parseInt(form.smtp_port) || 587 };
      let scId = editing;
      if (editing === "new") {
        const { data } = await api.post("/sub-companies", payload);
        scId = data?.id || null;
      } else {
        if (!payload.smtp_password) delete payload.smtp_password;
        await api.patch(`/sub-companies/${editing}`, payload);
      }
      // Save LinkedIn settings if dirty and we have an id (only the editable fields)
      if (linkedinDirty && scId && linkedinAvailable) {
        try {
          const liPayload = {
            profile_url: linkedin.profile_url,
            profile_name: linkedin.profile_name,
            signature: linkedin.signature,
            default_connection_template: linkedin.default_connection_template,
          };
          await api.patch(`/companies/${scId}/linkedin-settings`, liPayload);
        } catch (err) {
          if (err?.response?.status === 404) {
            setLinkedinAvailable(false);
            toast.warning("LinkedIn settings tidak tersimpan — backend VPS belum di-update. Jalankan: bash wa-setup.sh");
          } else {
            toast.error(formatApiError(err));
          }
        }
      }
      toast.success("Saved"); setEditing(null); load();
    } catch (e) { toast.error(formatApiError(e)); }
  };
  const del = async (id) => {
    if (!window.confirm("Delete this sub-company?")) return;
    try { await api.delete(`/sub-companies/${id}`); toast.success("Deleted"); load(); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-1">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">Sub-Companies</h2>
          <p className="text-sm text-slate-500">Manage multiple companies under your tenant. Each has own SMTP & assigned users.</p>
        </div>
        <PrimaryButton onClick={startNew} data-testid="add-subcompany-btn"><Plus size={14} weight="bold" /> Add Company</PrimaryButton>
      </div>
      <div className="mt-5">
        {list.length === 0 ? (
          <EmptyState icon={Buildings} title="No sub-companies yet" description="Add your first sub-company to organize teams." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {list.map((sc) => (
              <div key={sc.id} className="border border-slate-200 rounded-xl p-4 hover:border-indigo-200 transition-colors bg-white">
                <div className="flex items-start justify-between">
                  <div className="min-w-0">
                    <div className="font-display font-semibold text-slate-900">{sc.name}</div>
                    {sc.legal_name && <div className="text-xs text-slate-500">{sc.legal_name}</div>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => startEdit(sc)} className="text-slate-400 hover:text-indigo-600 p-1"><PencilSimple size={16} weight="bold" /></button>
                    <button onClick={() => del(sc.id)} className="text-slate-400 hover:text-red-500 p-1"><Trash size={16} weight="bold" /></button>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  {sc.phone && <Badge tone="neutral">📞 {sc.phone}</Badge>}
                  {sc.smtp_host && <Badge tone="info">SMTP configured</Badge>}
                  {sc.linkedin_settings?.profile_name && (
                    <Badge tone="info"><LinkedinLogo size={10} weight="fill" className="inline mr-0.5" />{sc.linkedin_settings.profile_name}</Badge>
                  )}
                  <Badge tone="success">{sc.user_count || 0} users</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && (
        <ModalShell title={editing === "new" ? "New Sub-Company" : "Edit Sub-Company"} onClose={() => setEditing(null)} onSave={save} maxWidth="max-w-5xl">
          <div className="space-y-5">
            {/* Provider preset */}
            <div>
              <div className="text-sm font-semibold text-slate-700 mb-2">Email Provider</div>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: "zoho",  name: "Zoho Mail", desc: "smtppro.zoho.com" },
                  { key: "gmail", name: "Gmail",     desc: "smtp.gmail.com (App Password)" },
                  { key: "other", name: "Other SMTP", desc: "Manual config" },
                ].map((p) => (
                  <button
                    key={p.key} type="button"
                    onClick={() => applyProvider(p.key)}
                    data-testid={`provider-${p.key}`}
                    className={`text-left border rounded-xl p-3 transition-all ${form.email_provider === p.key ? "border-indigo-500 ring-2 ring-indigo-100 bg-indigo-50" : "border-slate-200 hover:border-slate-300"}`}
                  >
                    <div className="font-medium text-slate-900 text-sm">{p.name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{p.desc}</div>
                  </button>
                ))}
              </div>
              {(form.email_provider === "gmail" || form.email_provider === "zoho") && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                  ⚠️ {form.email_provider === "gmail" ? "Gmail" : "Zoho"} butuh <b>App Password</b>, bukan password akun biasa. {" "}
                  <a className="underline" target="_blank" rel="noreferrer" href={form.email_provider === "gmail" ? "https://support.google.com/accounts/answer/185833" : "https://www.zoho.com/mail/help/imap-access.html"}>Cara buat App Password →</a>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-3">
                <div className="text-sm font-semibold text-slate-700 flex items-center gap-2"><Buildings size={14} weight="bold" className="text-indigo-600" /> Company info</div>
                <TermInput label="Company Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="sc-name" />
                <TermInput label="Legal Name (Nama PT)" value={form.legal_name || ""} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} />
                <TermInput label="Phone" value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-slate-700 flex items-center gap-2"><EnvelopeSimple size={14} weight="bold" className="text-indigo-600" /> SMTP (Outgoing)</div>
                  {editing !== "new" && (
                    <button type="button" onClick={testSmtp} data-testid="test-smtp-btn" className="text-[11px] px-2.5 py-1 rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200 font-medium">Test SMTP</button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2"><TermInput label="SMTP Host" value={form.smtp_host || ""} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} data-testid="smtp-host" /></div>
                  <TermInput label="Port" type="number" value={form.smtp_port || 587} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <TermInput label="SMTP Username" value={form.smtp_user || ""} onChange={(e) => setForm({ ...form, smtp_user: e.target.value })} data-testid="smtp-user" />
                  <TermInput label="SMTP Password" type="password" placeholder={editing === "new" ? "" : "(leave empty)"} value={form.smtp_password || ""} onChange={(e) => setForm({ ...form, smtp_password: e.target.value })} data-testid="smtp-password" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <TermInput label="From Email" value={form.smtp_from_email || ""} onChange={(e) => setForm({ ...form, smtp_from_email: e.target.value })} />
                  <TermInput label="From Name" value={form.smtp_from_name || ""} onChange={(e) => setForm({ ...form, smtp_from_name: e.target.value })} />
                </div>
              </div>
            </div>

            {/* IMAP section */}
            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold text-slate-700 flex items-center gap-2"><EnvelopeSimple size={14} weight="bold" className="text-purple-600" /> IMAP (Incoming inbox)</div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-slate-600 flex items-center gap-1">
                    <input type="checkbox" className="accent-indigo-600" checked={!form.imap_user && !form.imap_password} onChange={(e) => { if (e.target.checked) setForm({ ...form, imap_user: "", imap_password: "" }); }} />
                    Sama dengan SMTP
                  </label>
                  {editing !== "new" && (
                    <button type="button" onClick={testImap} data-testid="test-imap-btn" className="text-[11px] px-2.5 py-1 rounded-md bg-purple-100 text-purple-700 hover:bg-purple-200 font-medium">Test IMAP</button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2"><TermInput label="IMAP Host" value={form.imap_host || ""} onChange={(e) => setForm({ ...form, imap_host: e.target.value })} data-testid="imap-host" /></div>
                  <TermInput label="Port" type="number" value={form.imap_port || 993} onChange={(e) => setForm({ ...form, imap_port: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <TermInput label="IMAP Username" placeholder="(same as SMTP)" value={form.imap_user || ""} onChange={(e) => setForm({ ...form, imap_user: e.target.value })} />
                  <TermInput label="IMAP Password" type="password" placeholder={editing === "new" ? "(same as SMTP)" : "(leave empty)"} value={form.imap_password || ""} onChange={(e) => setForm({ ...form, imap_password: e.target.value })} />
                </div>
              </div>
            </div>

            {/* LinkedIn Identity section */}
            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                  <LinkedinLogo size={14} weight="fill" className="text-[#0A66C2]" /> LinkedIn Identity
                </div>
                <span className="text-[11px] text-slate-500">Dipakai AI saat generate connection note</span>
              </div>
              {editing === "new" ? (
                <div className="text-[12px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  Save the company first, then edit it again to configure LinkedIn identity.
                </div>
              ) : !linkedinAvailable ? (
                <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  ⚠️ LinkedIn settings endpoint belum tersedia di backend VPS Anda. Jalankan <code>bash wa-setup.sh</code> untuk pull versi terbaru.
                </div>
              ) : (
                <LinkedInIdentityFields
                  scId={editing}
                  linkedin={linkedin}
                  setLinkedin={(v) => { setLinkedin(v); setLinkedinDirty(true); }}
                />
              )}
            </div>
          </div>
        </ModalShell>
      )}
    </Card>
  );
}

/* ──────────── LinkedIn Identity Fields (with Test Generate preview) ──────────── */
function LinkedInIdentityFields({ scId, linkedin, setLinkedin }) {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState(null); // {text, kind}
  const [kind, setKind] = useState("connection_note");
  const [dmName, setDmName] = useState("Budi Santoso");
  const [dmTitle, setDmTitle] = useState("Head of Procurement");
  const [companyName, setCompanyName] = useState("PT Maju Bersama");
  const [industry, setIndustry] = useState("Logistics");

  const setField = (k, v) => setLinkedin({ ...linkedin, [k]: v });

  const runPreview = async () => {
    setPreviewing(true);
    setPreview(null);
    try {
      const { data } = await api.post(`/companies/${scId}/linkedin-settings/test-generate`, {
        settings: linkedin,
        kind,
        company_name: companyName,
        industry,
        country: "Indonesia",
        city: "Jakarta",
        dm_name: dmName,
        dm_title: dmTitle,
      });
      setPreview({ text: data.text, kind: data.kind });
    } catch (err) {
      if (err?.response?.status === 404) {
        toast.warning("Endpoint test-generate belum ada di backend VPS. Jalankan: bash wa-setup.sh");
      } else {
        toast.error(formatApiError(err));
      }
    } finally {
      setPreviewing(false);
    }
  };

  const copy = async () => {
    if (!preview?.text) return;
    try { await navigator.clipboard.writeText(preview.text); toast.success("Tersalin"); }
    catch { toast.error("Copy gagal"); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <TermInput label="LinkedIn Profile URL" placeholder="https://www.linkedin.com/in/your-handle"
          value={linkedin.profile_url || ""} onChange={(e) => setField("profile_url", e.target.value)} data-testid="li-profile-url" />
        <TermInput label="Profile Name (sender)" placeholder="e.g. Andi · Sales Lead at Acme"
          value={linkedin.profile_name || ""} onChange={(e) => setField("profile_name", e.target.value)} data-testid="li-profile-name" />
      </div>
      <TermTextarea label="Signature / Closing" placeholder="— Andi, Sales at Acme · acme.com" rows={2}
        value={linkedin.signature || ""} onChange={(e) => setField("signature", e.target.value)} data-testid="li-signature" />
      <TermTextarea label="Default Connection Template (opsional, AI akan tetap personalisasi)"
        placeholder="Hi {{first_name}}, saya {{sender}} dari {{company}}. Saya tertarik dengan {{target_company}}…" rows={3}
        value={linkedin.default_connection_template || ""}
        onChange={(e) => setField("default_connection_template", e.target.value)} data-testid="li-default-template" />
      <p className="text-[11px] text-slate-500">
        User yang ditugaskan ke company ini akan memakai identitas LinkedIn di atas saat AI generate connection note (Gemini Flash 3).
      </p>

      {/* Test Generate panel */}
      <div className="border border-dashed border-indigo-200 rounded-xl p-3 bg-indigo-50/40">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-semibold text-indigo-700 flex items-center gap-1.5">
            <LinkedinLogo size={12} weight="fill" /> Test Generate — preview AI message dengan settings di atas
          </div>
          <span className="text-[10px] text-slate-500">Tidak tersimpan ke DB</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2">
          <div className="md:col-span-1">
            <label className="block text-[11px] text-slate-600 mb-0.5">Message kind</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)}
              className="w-full text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white"
              data-testid="li-test-kind">
              <option value="connection_note">Connection Note</option>
              <option value="ice_breaker">Ice Breaker</option>
              <option value="first_message">First Message</option>
              <option value="follow_up">Follow Up</option>
            </select>
          </div>
          <TermInput label="Dummy company" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          <TermInput label="Industry" value={industry} onChange={(e) => setIndustry(e.target.value)} />
          <div className="grid grid-cols-2 gap-1">
            <TermInput label="DM name" value={dmName} onChange={(e) => setDmName(e.target.value)} />
            <TermInput label="DM title" value={dmTitle} onChange={(e) => setDmTitle(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PrimaryButton onClick={runPreview} disabled={previewing} data-testid="li-test-generate-btn">
            {previewing ? "Generating…" : "Generate Preview"}
          </PrimaryButton>
          {preview?.text && (
            <GhostButton onClick={copy} data-testid="li-test-copy-btn">Copy</GhostButton>
          )}
        </div>
        {preview?.text && (
          <div className="mt-3 bg-white border border-slate-200 rounded-lg p-3 whitespace-pre-wrap text-[13px] text-slate-800 leading-relaxed" data-testid="li-test-preview-text">
            {preview.text}
          </div>
        )}
      </div>

      {/* LinkedIn Session — Native Mode (ADVANCED, RISKY) */}
      <LinkedInSessionPanel scId={scId} linkedin={linkedin} setLinkedin={setLinkedin} />
    </div>
  );
}

/* ──────────── LinkedIn Session Panel (cookie auth — ADVANCED) ──────────── */
function LinkedInSessionPanel({ scId, linkedin, setLinkedin }) {
  const [showCookies, setShowCookies] = useState(false);
  const [liAt, setLiAt] = useState("");
  const [jsess, setJsess] = useState("");
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const configured = linkedin?.li_session_configured;
  const status = linkedin?.li_session_status || (configured ? "configured" : "none");
  const validatedAt = linkedin?.li_session_validated_at;

  const saveAndTest = async () => {
    if (!liAt.trim()) { toast.error("li_at cookie wajib"); return; }
    setTesting(true);
    try {
      // Save cookies first
      await api.patch(`/companies/${scId}/linkedin-settings`, { li_at: liAt.trim(), jsessionid: jsess.trim() });
      // Then validate
      const { data } = await api.post(`/companies/${scId}/linkedin-settings/validate-session`, {
        li_at: liAt.trim(), jsessionid: jsess.trim(),
      });
      if (data.ok) {
        toast.success(`✓ Session aktif — ${data.page_title || "OK"}`);
        setLinkedin({ ...linkedin, li_session_configured: true, li_session_status: "active", li_session_validated_at: data.checked_at });
        setLiAt(""); setJsess(""); setShowCookies(false);
      } else {
        toast.error(`Session invalid: ${data.reason || data.status}`);
      }
    } catch (err) {
      if (err?.response?.status === 404) {
        toast.warning("Endpoint validate-session belum tersedia. Jalankan: bash wa-setup.sh");
      } else {
        toast.error(formatApiError(err));
      }
    } finally { setTesting(false); }
  };

  const reTest = async () => {
    setTesting(true);
    try {
      const { data } = await api.post(`/companies/${scId}/linkedin-settings/validate-session`, {});
      if (data.ok) {
        toast.success(`✓ Session masih aktif`);
        setLinkedin({ ...linkedin, li_session_status: "active", li_session_validated_at: data.checked_at });
      } else {
        toast.error(`Session expired — re-input cookie`);
        setLinkedin({ ...linkedin, li_session_status: data.status });
      }
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setTesting(false); }
  };

  const disconnect = async () => {
    if (!window.confirm("Hapus LinkedIn session dari company ini? Native search jadi mati.")) return;
    setDisconnecting(true);
    try {
      await api.post(`/companies/${scId}/linkedin-settings/disconnect-session`, {});
      toast.success("Session di-disconnect");
      setLinkedin({ ...linkedin, li_session_configured: false, li_session_status: "none", li_at_masked: "", jsessionid_masked: "" });
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setDisconnecting(false); }
  };

  return (
    <div className="border border-dashed border-amber-300 rounded-xl p-3 bg-amber-50/50">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-bold text-amber-800 flex items-center gap-1.5">
          <LinkedinLogo size={12} weight="fill" /> LinkedIn Native Session — ADVANCED MODE
        </div>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
          status === "active" ? "bg-emerald-100 text-emerald-700" :
          status === "configured" ? "bg-blue-100 text-blue-700" :
          status === "invalid" || status === "error" ? "bg-red-100 text-red-700" :
          "bg-slate-100 text-slate-500"
        }`} data-testid="li-session-status">
          {status === "active" ? "✓ Active" : status === "configured" ? "Not Tested" : status === "invalid" ? "✗ Invalid" : status === "error" ? "✗ Error" : "Not Connected"}
        </span>
      </div>
      <div className="text-[11px] text-amber-700 bg-amber-100/60 border border-amber-200 rounded p-2 mb-2 leading-relaxed">
        <b>⚠️ RISIKO: Akun LinkedIn bisa di-restrict / banned.</b><br/>
        Mode ini mengakses LinkedIn lewat cookie session Anda untuk dapat data company asli (industry, location, followers) seperti search di LinkedIn langsung. Tips aman:
        <ul className="list-disc ml-4 mt-1 space-y-0.5">
          <li>Gunakan akun LinkedIn <b>khusus untuk prospecting</b> — bukan akun utama.</li>
          <li>Limit search: <b>max 30-50 query/hari per akun</b>.</li>
          <li>Cookie expired tiap ~30 hari. Re-test berkala.</li>
        </ul>
      </div>

      {configured && !showCookies ? (
        <div className="space-y-2">
          <div className="text-[11px] text-slate-700">
            <div>Cookie tersimpan: <code className="text-[10px] bg-white px-1 py-0.5 rounded border">li_at = {linkedin.li_at_masked || "(set)"}</code></div>
            {linkedin.jsessionid_masked && <div className="mt-1">JSESSIONID: <code className="text-[10px] bg-white px-1 py-0.5 rounded border">{linkedin.jsessionid_masked}</code></div>}
            {validatedAt && <div className="mt-1 text-slate-500">Last check: {new Date(validatedAt).toLocaleString("id-ID")}</div>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={reTest} disabled={testing} className="text-[11px] px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50" data-testid="li-session-retest">
              {testing ? "Testing…" : "Test Connection"}
            </button>
            <button onClick={() => { setShowCookies(true); setLiAt(""); setJsess(""); }} className="text-[11px] px-2.5 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200" data-testid="li-session-replace">
              Replace Cookie
            </button>
            <button onClick={disconnect} disabled={disconnecting} className="text-[11px] px-2.5 py-1 rounded bg-red-100 text-red-700 hover:bg-red-200 ml-auto" data-testid="li-session-disconnect">
              {disconnecting ? "..." : "Disconnect"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <details className="text-[11px] text-slate-600 mb-1">
            <summary className="cursor-pointer font-semibold text-blue-700 hover:underline">📖 Cara dapatkan li_at cookie (klik untuk lihat)</summary>
            <ol className="list-decimal ml-5 mt-1 space-y-0.5">
              <li>Buka <b>linkedin.com</b> di Chrome/Edge, login.</li>
              <li>Tekan <kbd className="px-1 py-0.5 bg-slate-200 rounded text-[10px]">F12</kbd> → tab <b>Application</b> → <b>Cookies</b> → <b>https://www.linkedin.com</b>.</li>
              <li>Cari row <b>li_at</b> → copy &quot;Value&quot;-nya. (Long string ~150 char)</li>
              <li>Cari row <b>JSESSIONID</b> → copy &quot;Value&quot;-nya. (Format: <code>ajax:1234567890</code>)</li>
              <li>Paste keduanya di bawah → klik &quot;Save &amp; Test&quot;.</li>
            </ol>
          </details>
          <div>
            <label className="text-[11px] font-semibold text-slate-700">li_at cookie <span className="text-red-500">*</span></label>
            <input type="password" value={liAt} onChange={(e) => setLiAt(e.target.value)}
              placeholder="AQEDAR... (150+ char dari Cookies → li_at)"
              className="w-full font-mono text-[11px] border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:border-amber-400"
              data-testid="li-session-li-at"/>
          </div>
          <div>
            <label className="text-[11px] font-semibold text-slate-700">JSESSIONID cookie (recommended)</label>
            <input type="password" value={jsess} onChange={(e) => setJsess(e.target.value)}
              placeholder='ajax:1234567890 (dari Cookies → JSESSIONID, hilangkan tanda kutip)'
              className="w-full font-mono text-[11px] border border-slate-200 rounded px-2 py-1.5 focus:outline-none focus:border-amber-400"
              data-testid="li-session-jsessionid"/>
          </div>
          <div className="flex gap-2">
            <button onClick={saveAndTest} disabled={testing || !liAt.trim()}
              className="text-[11px] px-3 py-1.5 rounded bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 font-semibold"
              data-testid="li-session-save-test">
              {testing ? "Testing…" : "💾 Save & Test Connection"}
            </button>
            {configured && (
              <button onClick={() => setShowCookies(false)} className="text-[11px] px-2.5 py-1 rounded bg-slate-100 text-slate-700 hover:bg-slate-200">
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ──────────── USERS ──────────── */
function UsersSection({ currentUser }) {
  const [team, setTeam] = useState([]);
  const [roles, setRoles] = useState([]);
  const [subCompanies, setSubCompanies] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    name: "", email: "", password: "", role: "Staff", sub_company_ids: [],
    smtp_use_company: true,
    smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "",
    smtp_use_tls: true, smtp_from_email: "", smtp_from_name: "",
  });

  const loadAll = async () => {
    try {
      const [t, r, sc] = await Promise.all([api.get("/team"), api.get("/roles"), api.get("/sub-companies")]);
      setTeam(t.data); setRoles(r.data); setSubCompanies(sc.data);
    } catch (e) { /* ignore */ }
  };
  useEffect(() => { loadAll(); }, []);

  const startNew = () => { setForm({ name: "", email: "", password: "", role: "Staff", sub_company_ids: [], smtp_use_company: true, smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_use_tls: true, smtp_from_email: "", smtp_from_name: "" }); setEditing("new"); };
  const startEdit = (u) => { setForm({
    name: u.name, email: u.email, password: "", role: u.role,
    sub_company_ids: u.sub_company_ids || [],
    smtp_use_company: u.smtp_use_company !== false,
    smtp_host: u.smtp_host || "", smtp_port: u.smtp_port || 587,
    smtp_user: u.smtp_user || "", smtp_password: "",
    smtp_use_tls: u.smtp_use_tls !== false,
    smtp_from_email: u.smtp_from_email || "", smtp_from_name: u.smtp_from_name || "",
  }); setEditing(u.id); };
  const toggleSc = (id) => {
    const s = new Set(form.sub_company_ids);
    s.has(id) ? s.delete(id) : s.add(id);
    setForm({ ...form, sub_company_ids: Array.from(s) });
  };

  const save = async () => {
    if (!form.name || !form.email) return toast.error("Name & email required");
    const smtpFields = {
      smtp_use_company: form.smtp_use_company,
      smtp_host: form.smtp_host || null,
      smtp_port: Number(form.smtp_port) || 587,
      smtp_user: form.smtp_user || null,
      smtp_use_tls: form.smtp_use_tls,
      smtp_from_email: form.smtp_from_email || null,
      smtp_from_name: form.smtp_from_name || null,
    };
    if (form.smtp_password) smtpFields.smtp_password = form.smtp_password;
    try {
      if (editing === "new") {
        if (!form.password || form.password.length < 6) return toast.error("Password min 6 chars");
        const { data } = await api.post("/team", { name: form.name, email: form.email, password: form.password, role: form.role });
        await api.patch(`/team/${data.id}`, { sub_company_ids: form.sub_company_ids, ...smtpFields });
        toast.success("User added");
      } else {
        const payload = { name: form.name, email: form.email, role: form.role, sub_company_ids: form.sub_company_ids, ...smtpFields };
        if (form.password) payload.password = form.password;
        await api.patch(`/team/${editing}`, payload);
        toast.success("User updated");
      }
      setEditing(null); loadAll();
    } catch (e) { toast.error(formatApiError(e)); }
  };
  const del = async (id) => {
    if (!window.confirm("Delete this user?")) return;
    try { await api.delete(`/team/${id}`); toast.success("Deleted"); loadAll(); } catch (e) { toast.error(formatApiError(e)); }
  };

  const scNamesFor = (u) => (u.sub_company_ids || []).map((id) => subCompanies.find((sc) => sc.id === id)?.name).filter(Boolean);

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="font-display text-lg font-semibold text-slate-900">Team Members</h2>
          <p className="text-sm text-slate-500">Assign each user to one or more sub-companies.</p>
        </div>
        <PrimaryButton onClick={startNew} data-testid="add-user-btn"><Plus size={14} weight="bold" /> Add User</PrimaryButton>
      </div>
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
            <tr><th className="text-left p-3">Name</th><th className="text-left p-3">Email</th><th className="text-left p-3">Role</th><th className="text-left p-3">Companies</th><th className="text-right p-3">Actions</th></tr>
          </thead>
          <tbody>
            {team.map((u) => (
              <tr key={u.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-3 text-slate-900 font-medium">{u.name}</td>
                <td className="p-3 text-slate-700 text-xs">{u.email}</td>
                <td className="p-3"><Badge tone={u.role === "Owner" ? "success" : u.role === "Admin" ? "info" : "neutral"}>{u.role}</Badge></td>
                <td className="p-3"><div className="flex flex-wrap gap-1">{scNamesFor(u).map((n) => <Badge key={n} tone="purple">{n}</Badge>)}{scNamesFor(u).length === 0 && <span className="text-xs text-slate-400">—</span>}</div></td>
                <td className="p-3 text-right">
                  <button onClick={() => startEdit(u)} className="text-slate-400 hover:text-indigo-600 p-1"><PencilSimple size={16} weight="bold" /></button>
                  {currentUser.role === "Owner" && u.id !== currentUser.id && (
                    <button onClick={() => del(u.id)} className="text-slate-400 hover:text-red-500 p-1 ml-1"><Trash size={16} weight="bold" /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <ModalShell title={editing === "new" ? "Add User" : "Edit User"} onClose={() => setEditing(null)} onSave={save}>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TermInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="u-name" />
              <TermInput label="Email (Login)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="u-email" />
              <TermInput label={editing === "new" ? "Password" : "New password (leave empty)"} type="text" placeholder={editing === "new" ? "min 6 chars" : ""} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <TermSelect label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} disabled={currentUser.role !== "Owner"}>
                {roles.filter((r) => editing === "new" ? r.name !== "Owner" : true).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </TermSelect>
            </div>
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Assigned Sub-Companies</div>
              {subCompanies.length === 0 ? (
                <div className="text-xs text-amber-600">No sub-companies yet. Create some in Settings → Companies first.</div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {subCompanies.map((sc) => (
                    <label key={sc.id} className={`flex items-center gap-2 px-3 py-2 border rounded-lg cursor-pointer ${form.sub_company_ids.includes(sc.id) ? "border-indigo-600 bg-indigo-50" : "border-slate-200 hover:border-slate-300"}`}>
                      <input type="checkbox" checked={form.sub_company_ids.includes(sc.id)} onChange={() => toggleSc(sc.id)} className="accent-indigo-600" />
                      <span className="text-sm text-slate-900">{sc.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            {/* SMTP per-user — overrides sub-company SMTP when set */}
            <div className="border-t border-slate-200 pt-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">SMTP User (Optional)</div>
                  <div className="text-[11px] text-slate-500">
                    Kalau di-set, user ini akan kirim email dari SMTP miliknya sendiri. Kalau tidak, ikut SMTP company yang di-assign.
                  </div>
                </div>
                <label className="text-xs flex items-center gap-1.5 shrink-0 cursor-pointer whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={form.smtp_use_company}
                    onChange={(e) => setForm({ ...form, smtp_use_company: e.target.checked })}
                    className="accent-indigo-600"
                    data-testid="u-smtp-use-company"
                  />
                  <span>Pakai SMTP company</span>
                </label>
              </div>

              {!form.smtp_use_company && (
                <div className="space-y-3 bg-slate-50 border border-slate-200 rounded-lg p-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <TermInput label="SMTP host" placeholder="smtp.gmail.com / smtp.zoho.com" value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} data-testid="u-smtp-host" />
                    <TermInput label="SMTP port" type="number" value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} data-testid="u-smtp-port" />
                    <TermInput label="SMTP user" placeholder="yourname@domain.com" value={form.smtp_user} onChange={(e) => setForm({ ...form, smtp_user: e.target.value })} data-testid="u-smtp-user" />
                    <TermInput
                      label={editing === "new" || !form.smtp_user ? "SMTP password" : "New SMTP password (leave empty to keep)"}
                      type="password"
                      value={form.smtp_password}
                      onChange={(e) => setForm({ ...form, smtp_password: e.target.value })}
                      data-testid="u-smtp-password"
                    />
                    <TermInput label="From email (optional)" placeholder="defaults to SMTP user" value={form.smtp_from_email} onChange={(e) => setForm({ ...form, smtp_from_email: e.target.value })} data-testid="u-smtp-from-email" />
                    <TermInput label="From name (optional)" placeholder={form.name || "Your name"} value={form.smtp_from_name} onChange={(e) => setForm({ ...form, smtp_from_name: e.target.value })} data-testid="u-smtp-from-name" />
                  </div>
                  <label className="text-xs flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.smtp_use_tls}
                      onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.checked })}
                      className="accent-indigo-600"
                      data-testid="u-smtp-tls"
                    />
                    <span>Pakai TLS/SSL (port 465 = SSL otomatis, port 587 = TLS)</span>
                  </label>
                  <div className="text-[10px] text-slate-500">
                    💡 Gmail: pakai App Password (myaccount.google.com → Security → 2-Step Verification → App passwords). Zoho: aktifkan IMAP & SMTP di mail settings.
                  </div>
                </div>
              )}
            </div>
          </div>
        </ModalShell>
      )}
    </Card>
  );
}

/* ──────────── ROLES ──────────── */
function RolesSection({ currentUser }) {
  const [roles, setRoles] = useState([]);
  const [perms, setPerms] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: "", permissions: [] });

  const load = async () => {
    try { const [r, p] = await Promise.all([api.get("/roles"), api.get("/permissions")]); setRoles(r.data); setPerms(p.data); } catch (e) { /* */ }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setForm({ name: "", permissions: ["dashboard"] }); setEditing("new"); };
  const startEdit = (r) => { setForm({ name: r.name, permissions: [...r.permissions] }); setEditing(r.id); };
  const toggleP = (k) => setForm({ ...form, permissions: form.permissions.includes(k) ? form.permissions.filter((x) => x !== k) : [...form.permissions, k] });
  const save = async () => {
    if (!form.name.trim()) return toast.error("Name required");
    try {
      if (editing === "new") await api.post("/roles", form);
      else await api.patch(`/roles/${editing}`, form);
      toast.success("Saved"); setEditing(null); load();
    } catch (e) { toast.error(formatApiError(e)); }
  };
  const del = async (id) => { if (!window.confirm("Delete role?")) return; try { await api.delete(`/roles/${id}`); toast.success("Deleted"); load(); } catch (e) { toast.error(formatApiError(e)); } };

  const editingRole = roles.find((r) => r.id === editing);
  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-5">
        <div><h2 className="font-display text-lg font-semibold text-slate-900">Roles & Permissions</h2><p className="text-sm text-slate-500">Control which menus and actions each role can access.</p></div>
        <PrimaryButton onClick={startNew}><Plus size={14} weight="bold" /> Add Role</PrimaryButton>
      </div>
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
            <tr><th className="text-left p-3">Role</th><th className="text-left p-3">Permissions</th><th className="text-left p-3">Users</th><th className="text-left p-3">Type</th><th className="text-right p-3">Actions</th></tr>
          </thead>
          <tbody>
            {roles.map((r) => (
              <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="p-3 font-medium text-slate-900">{r.name}</td>
                <td className="p-3"><div className="flex flex-wrap gap-1 max-w-md">{r.permissions.slice(0, 5).map((p) => <Badge key={p} tone="info">{p}</Badge>)}{r.permissions.length > 5 && <Badge tone="neutral">+{r.permissions.length - 5}</Badge>}</div></td>
                <td className="p-3"><Badge tone="success">{r.user_count}</Badge></td>
                <td className="p-3"><Badge tone={r.is_system ? "neutral" : "warning"}>{r.is_system ? "system" : "custom"}</Badge></td>
                <td className="p-3 text-right">
                  <button onClick={() => startEdit(r)} className="text-slate-400 hover:text-indigo-600 p-1"><PencilSimple size={16} weight="bold" /></button>
                  {!r.is_system && r.user_count === 0 && (
                    <button onClick={() => del(r.id)} className="text-slate-400 hover:text-red-500 p-1 ml-1"><Trash size={16} weight="bold" /></button>
                  )}
                  {r.is_system && <Lock size={14} className="text-slate-300 inline ml-2" />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <ModalShell title={editing === "new" ? "New Role" : `Edit Role: ${editingRole?.name || ""}`} onClose={() => setEditing(null)} onSave={save}>
          <div className="space-y-4">
            <TermInput label="Role Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={editingRole?.is_system} />
            {["menu", "action"].map((kind) => (
              <div key={kind}>
                <div className="text-sm font-medium text-slate-700 mb-2">{kind === "menu" ? "Menu Access" : "Action Permissions"}</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {perms.filter((p) => kind === "menu" ? p.menu : !p.menu).map((p) => (
                    <label key={p.key} className={`flex items-start gap-2 p-2.5 border rounded-lg cursor-pointer ${form.permissions.includes(p.key) ? "border-indigo-600 bg-indigo-50" : "border-slate-200 hover:border-slate-300"}`}>
                      <input type="checkbox" checked={form.permissions.includes(p.key)} onChange={() => toggleP(p.key)} className="mt-0.5 accent-indigo-600" />
                      <div className="min-w-0"><div className="text-sm text-slate-900">{p.label}</div><div className="text-[10px] text-slate-500 font-mono">{p.key}</div></div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </ModalShell>
      )}
    </Card>
  );
}

/* ──────────── Generic list (categories / locations) ──────────── */
function CategoriesSection() {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const [defaultAliases, setDefaultAliases] = useState([]);
  const [defaultDraft, setDefaultDraft] = useState("");
  const [defaultIsCustom, setDefaultIsCustom] = useState(false);
  const [editing, setEditing] = useState(null); // category being edited
  const [editName, setEditName] = useState("");
  const [editAliases, setEditAliases] = useState("");

  const load = async () => {
    try {
      const [c, d] = await Promise.all([
        api.get("/hunter-settings/categories"),
        api.get("/hunter-settings/default-aliases"),
      ]);
      setItems(c.data);
      setDefaultAliases(d.data.aliases || []);
      setDefaultIsCustom(!d.data.is_default);
    } catch (e) { /* */ }
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!name.trim()) return;
    try { await api.post("/hunter-settings/categories", { name: name.trim() }); setName(""); load(); toast.success("Category added"); }
    catch (e) { toast.error(formatApiError(e)); }
  };
  const del = async (id) => {
    if (!window.confirm("Delete category?")) return;
    try { await api.delete(`/hunter-settings/categories/${id}`); load(); toast.success("Deleted"); }
    catch (e) { toast.error(formatApiError(e)); }
  };

  const startEdit = (cat) => {
    setEditing(cat.id);
    setEditName(cat.name);
    setEditAliases((cat.aliases || []).join(", "));
  };
  const saveEdit = async () => {
    const aliases = editAliases.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    try {
      await api.patch(`/hunter-settings/categories/${editing}`, { name: editName.trim(), aliases });
      toast.success("Updated"); setEditing(null); load();
    } catch (e) { toast.error(formatApiError(e)); }
  };

  const saveDefaults = async () => {
    const aliases = defaultDraft.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    if (aliases.length === 0) { toast.error("Setidaknya 1 alias"); return; }
    try {
      const { data } = await api.put("/hunter-settings/default-aliases", { aliases });
      setDefaultAliases(data.aliases); setDefaultIsCustom(true); setDefaultDraft("");
      toast.success("Default aliases tersimpan");
    } catch (e) { toast.error(formatApiError(e)); }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex items-center gap-2 mb-1">
          <Tag size={20} weight="bold" className="text-indigo-600" />
          <h2 className="font-display text-lg font-semibold text-slate-900">Categories <span className="text-slate-400 font-normal">({items.length})</span></h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Industry / niche tags. Setiap kategori bisa punya <b>aliases</b> (email prefix umum) yang otomatis di-inject saat search domain di kategori tsb.
        </p>

        <div className="flex gap-2 mb-4">
          <input className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-lg px-3 py-2.5 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            placeholder="e.g. Hotel & Resort, SaaS, Event Venue"
            value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <PrimaryButton onClick={add}><Plus size={14} weight="bold" /> Add</PrimaryButton>
        </div>

        <div className="space-y-2">
          {items.length === 0 && <div className="text-sm text-slate-400 py-3 text-center">Belum ada kategori</div>}
          {items.map((c) => (
            <div key={c.id} className="border border-slate-200 rounded-lg p-3">
              {editing === c.id ? (
                <div className="space-y-2">
                  <input className="w-full bg-white border border-indigo-300 rounded-lg px-3 py-2 text-sm" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Category name" />
                  <input className="w-full bg-white border border-indigo-300 rounded-lg px-3 py-2 text-sm font-mono" value={editAliases} onChange={(e) => setEditAliases(e.target.value)} placeholder="aliases (pisah dgn koma): gm, sales, event, reservations" />
                  <div className="text-[11px] text-slate-500">Hanya prefix sebelum @, contoh: <code>gm</code> → akan jadi <code>gm@domain.com</code></div>
                  <div className="flex gap-2 justify-end">
                    <GhostButton onClick={() => setEditing(null)}>Cancel</GhostButton>
                    <PrimaryButton onClick={saveEdit}>Save</PrimaryButton>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-slate-900">{c.name}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {(c.aliases || []).length > 0 ? (
                        <>Aliases: <span className="font-mono text-indigo-700">{(c.aliases || []).join(", ")}</span></>
                      ) : (
                        <span className="text-slate-400">No custom aliases — pakai default tenant</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => startEdit(c)} className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded" title="Edit aliases"><PencilSimple size={14} weight="bold" /></button>
                    <button onClick={() => del(c.id)} className="p-1.5 text-rose-500 hover:bg-rose-50 rounded" title="Delete"><Trash size={14} weight="bold" /></button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="font-display text-lg font-semibold text-slate-900 mb-1">Default Aliases (Tenant Fallback)</h2>
        <p className="text-sm text-slate-500 mb-4">
          Digunakan kalau category yang dipilih tidak punya aliases (atau search tanpa category). {defaultIsCustom ? <Badge tone="success">Custom</Badge> : <Badge tone="neutral">System default</Badge>}
        </p>
        <div className="mb-3">
          <div className="text-xs text-slate-500 mb-1">Active default:</div>
          <div className="font-mono text-sm text-slate-900 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">{defaultAliases.join(", ") || "—"}</div>
        </div>
        <div className="flex gap-2">
          <input className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-mono" placeholder="ganti default: e.g. info, contact, sales, support, hr" value={defaultDraft} onChange={(e) => setDefaultDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveDefaults()} />
          <PrimaryButton onClick={saveDefaults}>Save default</PrimaryButton>
        </div>
      </Card>
    </div>
  );
}

function SimpleListSection({ title, subtitle, path, icon: Icon, placeholder }) {
  const [items, setItems] = useState([]);
  const [name, setName] = useState("");
  const load = async () => { try { const { data } = await api.get(`/hunter-settings/${path}`); setItems(data); } catch (e) { /* */ } };
  useEffect(() => { load(); }, []);
  const add = async () => { if (!name.trim()) return; try { await api.post(`/hunter-settings/${path}`, { name: name.trim() }); setName(""); load(); toast.success("Added"); } catch (e) { toast.error(formatApiError(e)); } };
  const del = async (id) => { if (!window.confirm("Delete?")) return; try { await api.delete(`/hunter-settings/${path}/${id}`); load(); toast.success("Deleted"); } catch (e) { toast.error(formatApiError(e)); } };
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-1"><Icon size={20} weight="bold" className="text-indigo-600" /><h2 className="font-display text-lg font-semibold text-slate-900">{title} <span className="text-slate-400 font-normal">({items.length})</span></h2></div>
      <p className="text-sm text-slate-500 mb-4">{subtitle}</p>
      <div className="flex gap-2 mb-4">
        <input className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-lg px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20" placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <PrimaryButton onClick={add}><Plus size={14} weight="bold" /> Add</PrimaryButton>
      </div>
      <div className="space-y-1.5">
        {items.length === 0 && <div className="text-sm text-slate-400 py-3 text-center">None yet</div>}
        {items.map((i) => (
          <div key={i.id} className="flex items-center justify-between px-3 py-2.5 bg-slate-50 rounded-lg hover:bg-slate-100">
            <span className="text-sm text-slate-700">{i.name}</span>
            <button onClick={() => del(i.id)} className="text-slate-400 hover:text-red-500"><Trash size={14} weight="bold" /></button>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ──────────── API ──────────── */
function ApiSection() {
  const [settings, setSettings] = useState({});
  const [loading, setLoading] = useState(false);
  const [sdLoading, setSdLoading] = useState(false);
  const [sdTesting, setSdTesting] = useState(false);
  const [sdUsage, setSdUsage] = useState(null);

  useEffect(() => {
    api.get("/settings").then((r) => setSettings(r.data)).catch(() => {});
    api.get("/scrapingdog/usage").then((r) => setSdUsage(r.data)).catch(() => {});
  }, []);

  const saveHunter = async () => {
    setLoading(true);
    try {
      const { data } = await api.patch("/settings", { hunter_api_key: settings.hunter_api_key });
      setSettings(data); toast.success("Saved");
    } catch (e) { toast.error(formatApiError(e)); } finally { setLoading(false); }
  };

  const saveSd = async () => {
    setSdLoading(true);
    try {
      const { data } = await api.patch("/settings", { scrapingdog_api_key: settings.scrapingdog_api_key });
      setSettings(data); toast.success("Scrapingdog key saved");
    } catch (e) { toast.error(formatApiError(e)); } finally { setSdLoading(false); }
  };

  const testSd = async () => {
    setSdTesting(true);
    try {
      const { data } = await api.post("/scrapingdog/validate", { api_key: settings.scrapingdog_api_key });
      if (data.ok) toast.success("✓ Scrapingdog API key valid");
      else toast.error(`Invalid: ${data.reason || data.status_code}`);
    } catch (e) {
      if (e?.response?.status === 404) toast.warning("Endpoint validate belum tersedia di backend VPS. Jalankan: bash wa-setup.sh");
      else toast.error(formatApiError(e));
    } finally { setSdTesting(false); }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <Card className="p-6">
        <h2 className="font-display text-lg font-semibold text-slate-900">Hunter.io API Key</h2>
        <p className="text-sm text-slate-500 mb-4">Currently using <Badge tone="warning">MOCK</Badge>. Get a real key at <a href="https://hunter.io/api-keys" target="_blank" rel="noreferrer" className="text-indigo-600 underline">hunter.io/api-keys</a>.</p>
        <TermInput label="API Key" placeholder="(leave empty to use MOCK)" value={settings.hunter_api_key || ""} onChange={(e) => setSettings({ ...settings, hunter_api_key: e.target.value })} data-testid="hunter-api-key"/>
        <div className="mt-4"><PrimaryButton onClick={saveHunter} disabled={loading}>{loading ? "Saving..." : "Save API Key"}</PrimaryButton></div>
      </Card>

      <Card className="p-6">
        <div className="flex items-start justify-between mb-1">
          <div>
            <h2 className="font-display text-lg font-semibold text-slate-900 flex items-center gap-2">
              <LinkedinLogo size={18} weight="fill" className="text-purple-600"/> Scrapingdog API Key
              <Badge tone="info">LinkedIn Search</Badge>
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Google SERP search + LinkedIn Scraper untuk dapat real company data. Cost: <b>1 credit/search</b>, <b>10 credits/enrichment</b>.<br/>
              Get key at <a href="https://www.scrapingdog.com" target="_blank" rel="noreferrer" className="text-purple-600 underline">scrapingdog.com</a> (1000 free credits).
            </p>
          </div>
        </div>
        <TermInput label="API Key" placeholder="Your Scrapingdog API key"
          value={settings.scrapingdog_api_key || ""}
          onChange={(e) => setSettings({ ...settings, scrapingdog_api_key: e.target.value })}
          data-testid="scrapingdog-api-key"/>
        <div className="mt-4 flex gap-2">
          <PrimaryButton onClick={saveSd} disabled={sdLoading} data-testid="scrapingdog-save">
            {sdLoading ? "Saving..." : "Save Key"}
          </PrimaryButton>
          <button onClick={testSd} disabled={sdTesting || !settings.scrapingdog_api_key}
            className="px-3 py-2 text-sm rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50 font-semibold"
            data-testid="scrapingdog-test">
            {sdTesting ? "Testing..." : "Test Connection"}
          </button>
        </div>
        {sdUsage && (sdUsage.total_30d > 0) && (
          <div className="mt-4 pt-4 border-t border-slate-200">
            <div className="text-xs font-semibold text-slate-600 mb-2">Usage (last 30 days)</div>
            <div className="flex items-center gap-3 text-xs">
              <Badge tone="info">Total: {sdUsage.total_30d} credits</Badge>
              <span className="text-slate-500">≈ ${(sdUsage.total_30d * 0.0002).toFixed(2)} estimated</span>
            </div>
            {Object.entries(sdUsage.by_day || {}).slice(0, 7).map(([day, vals]) => (
              <div key={day} className="text-[11px] text-slate-600 flex justify-between mt-1">
                <span>{day}</span>
                <span>🔍 {vals.search || 0} search · 🎯 {vals.enrich || 0} enrich · <b>{vals.total}</b> total</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ──────────── Modal shell ──────────── */
function ModalShell({ title, children, onClose, onSave, saveLabel = "Save", maxWidth = "max-w-3xl" }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card
          className={`w-full ${maxWidth} shadow-2xl flex flex-col my-auto`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-white rounded-t-xl">
            <h2 className="font-display text-lg text-slate-900">{title}</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500" data-testid="modal-close-btn"><X size={20} weight="bold" /></button>
          </div>
          <div className="p-6">{children}</div>
          <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2 bg-white rounded-b-xl">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton onClick={onSave} data-testid="modal-save-btn">{saveLabel}</PrimaryButton>
          </div>
        </Card>
      </div>
    </div>
  );
}
