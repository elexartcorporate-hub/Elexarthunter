import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Buildings, UsersThree, ShieldCheck, Tag, MapPin, Key,
  Plus, Trash, PencilSimple, X, Lock, EnvelopeSimple,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const SUB_NAV = [
  { key: "companies",  label: "Companies",    icon: Buildings,    desc: "Sub-companies under your tenant" },
  { key: "users",      label: "Users",         icon: UsersThree,   desc: "Team members & access" },
  { key: "roles",      label: "Roles",         icon: ShieldCheck,  desc: "Permissions per role" },
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
          {section === "categories" && <SimpleListSection title="Categories" subtitle="Industry, niche or vertical — used to organize your saved leads." path="categories" icon={Tag} placeholder="e.g. Travel, SaaS, E-commerce" />}
          {section === "locations"  && <SimpleListSection title="Locations" subtitle="City, country or region — to filter your leads geographically." path="locations" icon={MapPin} placeholder="e.g. Jakarta, Bali, Singapore" />}
          {section === "api"        && <ApiSection />}
        </section>
      </div>
    </div>
  );
}

/* ──────────── COMPANIES (sub-companies) ──────────── */
function CompaniesSection() {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null); // null | "new" | id
  const [form, setForm] = useState({ name: "", legal_name: "", phone: "", smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_from_email: "", smtp_from_name: "", smtp_use_tls: true });

  const load = async () => { try { const { data } = await api.get("/sub-companies"); setList(data); } catch (e) { toast.error(formatApiError(e)); } };
  useEffect(() => { load(); }, []);

  const startNew = () => { setForm({ name: "", legal_name: "", phone: "", smtp_host: "", smtp_port: 587, smtp_user: "", smtp_password: "", smtp_from_email: "", smtp_from_name: "", smtp_use_tls: true }); setEditing("new"); };
  const startEdit = (sc) => { setForm({ ...sc, smtp_password: "" }); setEditing(sc.id); };

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
        <ModalShell title={editing === "new" ? "New Sub-Company" : "Edit Sub-Company"} onClose={() => setEditing(null)} onSave={save}>
          <div className="space-y-4">
            <div className="text-sm font-medium text-slate-700">Company info</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TermInput label="Company Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="sc-name" />
              <TermInput label="Legal Name (Nama PT)" value={form.legal_name || ""} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} />
              <TermInput label="Phone" value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div className="text-sm font-medium text-slate-700 pt-2 flex items-center gap-2"><EnvelopeSimple size={14} weight="bold" /> SMTP for this company</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <TermInput label="SMTP Host" value={form.smtp_host || ""} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />
              <TermInput label="SMTP Port" type="number" value={form.smtp_port || 587} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} />
              <TermInput label="SMTP Username" value={form.smtp_user || ""} onChange={(e) => setForm({ ...form, smtp_user: e.target.value })} />
              <TermInput label="SMTP Password" type="password" placeholder={editing === "new" ? "" : "(leave empty to keep)"} value={form.smtp_password || ""} onChange={(e) => setForm({ ...form, smtp_password: e.target.value })} />
              <TermInput label="From Email" value={form.smtp_from_email || ""} onChange={(e) => setForm({ ...form, smtp_from_email: e.target.value })} />
              <TermInput label="From Name" value={form.smtp_from_name || ""} onChange={(e) => setForm({ ...form, smtp_from_name: e.target.value })} />
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
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "Staff", sub_company_ids: [] });

  const loadAll = async () => {
    try {
      const [t, r, sc] = await Promise.all([api.get("/team"), api.get("/roles"), api.get("/sub-companies")]);
      setTeam(t.data); setRoles(r.data); setSubCompanies(sc.data);
    } catch (e) { /* ignore */ }
  };
  useEffect(() => { loadAll(); }, []);

  const startNew = () => { setForm({ name: "", email: "", password: "", role: "Staff", sub_company_ids: [] }); setEditing("new"); };
  const startEdit = (u) => { setForm({ name: u.name, email: u.email, password: "", role: u.role, sub_company_ids: u.sub_company_ids || [] }); setEditing(u.id); };
  const toggleSc = (id) => {
    const s = new Set(form.sub_company_ids);
    s.has(id) ? s.delete(id) : s.add(id);
    setForm({ ...form, sub_company_ids: Array.from(s) });
  };

  const save = async () => {
    if (!form.name || !form.email) return toast.error("Name & email required");
    try {
      if (editing === "new") {
        if (!form.password || form.password.length < 6) return toast.error("Password min 6 chars");
        const { data } = await api.post("/team", { name: form.name, email: form.email, password: form.password, role: form.role });
        if (form.sub_company_ids.length > 0) await api.patch(`/team/${data.id}`, { sub_company_ids: form.sub_company_ids });
        toast.success("User added");
      } else {
        const payload = { name: form.name, email: form.email, role: form.role, sub_company_ids: form.sub_company_ids };
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
function ModalShell({ title, children, onClose, onSave, saveLabel = "Save" }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card
          className="w-full max-w-3xl shadow-2xl flex flex-col my-auto"
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
