import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Buildings, UsersThree, ShieldCheck, Tag, MapPin, Key,
  Plus, Trash, PencilSimple, X, Lock, EnvelopeSimple, CalendarBlank, Target,
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
          {section === "categories" && <SimpleListSection title="Categories" subtitle="Industry, niche or vertical — used to organize your saved leads." path="categories" icon={Tag} placeholder="e.g. Travel, SaaS, E-commerce" />}
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
  const [myTarget, setMyTarget] = useState("");
  const [savingMy, setSavingMy] = useState(false);
  const [edits, setEdits] = useState({});

  const canManageTeam = currentUser?.role === "Owner" ||
    (currentUser?.permissions || []).includes("set_team_targets");

  const load = async () => {
    try {
      const me = await api.get("/auth/me");
      setMyTarget(String(me.data.user.daily_target ?? 0));
      if (canManageTeam) {
        const { data } = await api.get("/team");
        setUsers(data);
      }
    } catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, []);

  const saveMy = async () => {
    const n = parseInt(myTarget, 10);
    if (Number.isNaN(n) || n < 0) return toast.error("Target harus angka >= 0");
    setSavingMy(true);
    try {
      await api.patch("/me/target", { daily_target: n });
      toast.success(`Target Anda di-set ke ${n}`);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSavingMy(false); }
  };

  const saveUser = async (uid) => {
    const v = edits[uid];
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 0) return toast.error("Target harus angka >= 0");
    try {
      await api.patch(`/team/${uid}/target`, { daily_target: n });
      toast.success("Target di-update");
      setEdits((e) => { const c = { ...e }; delete c[uid]; return c; });
      load();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <h2 className="font-display text-xl text-slate-900">Target Harian Saya</h2>
        <p className="text-sm text-slate-500 mb-4">Berapa prospect yang harus Anda tambahkan per hari kerja. Email outreach terkunci sampai target tercapai.</p>
        <div className="flex items-end gap-3 max-w-md">
          <div className="flex-1">
            <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">Daily target</label>
            <input
              type="number"
              min="0"
              max="1000"
              value={myTarget}
              onChange={(e) => setMyTarget(e.target.value)}
              className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-base focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
              data-testid="my-target-input"
            />
          </div>
          <PrimaryButton onClick={saveMy} disabled={savingMy} data-testid="save-my-target-btn">
            <Target size={14} weight="bold" /> {savingMy ? "Saving..." : "Simpan"}
          </PrimaryButton>
        </div>
        <div className="text-[11px] text-slate-500 mt-2">Set ke 0 untuk menonaktifkan daily-quest mode.</div>
      </Card>

      {canManageTeam && (
        <Card className="p-6">
          <h2 className="font-display text-xl text-slate-900">Target Tim</h2>
          <p className="text-sm text-slate-500 mb-4">Atur target harian untuk setiap anggota tim. Hanya Owner/Admin yang bisa mengubah.</p>
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                <tr>
                  <th className="text-left p-3">Nama</th>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3 w-32">Target Harian</th>
                  <th className="text-right p-3 w-28"></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const draft = edits[u.id];
                  const cur = u.daily_target ?? 0;
                  const isEditing = draft !== undefined;
                  return (
                    <tr key={u.id} className="border-t border-slate-100">
                      <td className="p-3 font-medium text-slate-900">{u.name}</td>
                      <td className="p-3 text-xs text-slate-500">{u.email}</td>
                      <td className="p-3 text-xs"><Badge tone="info">{u.role}</Badge></td>
                      <td className="p-3">
                        <input
                          type="number"
                          min="0"
                          max="1000"
                          value={isEditing ? draft : cur}
                          onChange={(e) => setEdits({ ...edits, [u.id]: e.target.value })}
                          className="w-20 px-2 py-1 border border-slate-200 rounded text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/20"
                          data-testid={`target-input-${u.id}`}
                        />
                      </td>
                      <td className="p-3 text-right">
                        {isEditing && (
                          <PrimaryButton onClick={() => saveUser(u.id)} data-testid={`save-target-${u.id}`}>
                            Save
                          </PrimaryButton>
                        )}
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

  const load = async () => { try { const { data } = await api.get("/sub-companies"); setList(data); } catch (e) { toast.error(formatApiError(e)); } };
  useEffect(() => { load(); }, []);

  const startNew = () => { setForm({ name: "", legal_name: "", phone: "", email_provider: "other", smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_from_email: "", smtp_from_name: "", smtp_use_tls: true, imap_host: "", imap_port: 993, imap_ssl: true, imap_user: "", imap_password: "" }); setEditing("new"); };
  const startEdit = (sc) => { setForm({ ...sc, email_provider: sc.email_provider || "other", smtp_password: "", imap_password: "" }); setEditing(sc.id); };

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
      if (editing === "new") await api.post("/sub-companies", payload);
      else {
        if (!payload.smtp_password) delete payload.smtp_password;
        await api.patch(`/sub-companies/${editing}`, payload);
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
          </div>
        </ModalShell>
      )}
    </Card>
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
  useEffect(() => { api.get("/settings").then((r) => setSettings(r.data)).catch(() => {}); }, []);
  const save = async () => { setLoading(true); try { const { data } = await api.patch("/settings", { hunter_api_key: settings.hunter_api_key }); setSettings(data); toast.success("Saved"); } catch (e) { toast.error(formatApiError(e)); } finally { setLoading(false); } };
  return (
    <Card className="p-6 max-w-2xl">
      <h2 className="font-display text-lg font-semibold text-slate-900">Hunter.io API Key</h2>
      <p className="text-sm text-slate-500 mb-4">Currently using <Badge tone="warning">MOCK</Badge>. Get a real key at <a href="https://hunter.io/api-keys" target="_blank" rel="noreferrer" className="text-indigo-600 underline">hunter.io/api-keys</a>.</p>
      <TermInput label="API Key" placeholder="(leave empty to use MOCK)" value={settings.hunter_api_key || ""} onChange={(e) => setSettings({ ...settings, hunter_api_key: e.target.value })} />
      <div className="mt-4"><PrimaryButton onClick={save} disabled={loading}>{loading ? "Saving..." : "Save API Key"}</PrimaryButton></div>
    </Card>
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
