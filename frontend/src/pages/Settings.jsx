import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, TermInput, TermSelect, PrimaryButton, GhostButton, Badge } from "@/components/term";
import { UsersThree, Key, Plus, Trash, PencilSimple, X, Buildings, EnvelopeSimple, CaretDown, CaretUp } from "@phosphor-icons/react";
import { toast } from "sonner";

const EMPTY_USER_FORM = {
  name: "",
  email: "",
  password: "",
  role: "Staff",
  smtp_use_company: true,
  smtp_host: "",
  smtp_port: 587,
  smtp_user: "",
  smtp_password: "",
  smtp_use_tls: true,
  smtp_from_email: "",
  smtp_from_name: "",
};

export default function Settings() {
  const { user, tenant, refreshTenant } = useAuth();
  const isOwnerOrAdmin = user?.role === "Owner" || user?.role === "Admin";
  const [tab, setTab] = useState("users");
  const [settings, setSettings] = useState(null);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCompany, setShowCompany] = useState(true);
  const [editingUser, setEditingUser] = useState(null); // null | "new" | userId
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM);

  const loadTeam = async () => {
    try {
      const { data } = await api.get("/team");
      setTeam(data);
    } catch (e) {
      /* ignore */
    }
  };

  useEffect(() => {
    if (isOwnerOrAdmin) {
      api.get("/settings").then((r) => setSettings(r.data)).catch((e) => toast.error(formatApiError(e)));
    } else {
      // Staff can still load their own settings (just refresh tenant data)
      setSettings({});
    }
    loadTeam();
  }, [isOwnerOrAdmin]);

  if (!settings) return <div className="p-10 font-mono text-green-600">Loading...</div>;

  // ─── Company settings handlers ─────────────────────────
  const updateCompany = (key, value) => setSettings({ ...settings, [key]: value });

  const saveCompany = async () => {
    setLoading(true);
    try {
      const payload = {
        company_name: settings.company_name,
        legal_name: settings.legal_name,
        phone: settings.phone,
        smtp_host: settings.smtp_host,
        smtp_port: settings.smtp_port ? parseInt(settings.smtp_port) : null,
        smtp_user: settings.smtp_user,
        smtp_password: settings.smtp_password,
        smtp_use_tls: settings.smtp_use_tls,
        smtp_from_email: settings.smtp_from_email,
        smtp_from_name: settings.smtp_from_name,
      };
      const { data } = await api.patch("/settings", payload);
      setSettings(data);
      await refreshTenant();
      toast.success("Company settings saved");
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  const saveHunterKey = async () => {
    setLoading(true);
    try {
      const { data } = await api.patch("/settings", { hunter_api_key: settings.hunter_api_key });
      setSettings(data);
      toast.success("Hunter API key saved");
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  // ─── User CRUD handlers ────────────────────────────────
  const startNew = () => {
    setUserForm(EMPTY_USER_FORM);
    setEditingUser("new");
  };

  const startEdit = (u) => {
    setUserForm({
      name: u.name || "",
      email: u.email || "",
      password: "",
      role: u.role || "Staff",
      smtp_use_company: u.smtp_use_company !== false,
      smtp_host: u.smtp_host || "",
      smtp_port: u.smtp_port || 587,
      smtp_user: u.smtp_user || "",
      smtp_password: "",
      smtp_use_tls: u.smtp_use_tls !== false,
      smtp_from_email: u.smtp_from_email || "",
      smtp_from_name: u.smtp_from_name || "",
    });
    setEditingUser(u.id);
  };

  const saveUser = async () => {
    if (!userForm.name || !userForm.email) return toast.error("Name & email required");
    if (editingUser === "new" && (!userForm.password || userForm.password.length < 6))
      return toast.error("Password min 6 chars");
    try {
      const smtpFields = userForm.smtp_use_company
        ? { smtp_use_company: true }
        : {
            smtp_use_company: false,
            smtp_host: userForm.smtp_host,
            smtp_port: parseInt(userForm.smtp_port) || 587,
            smtp_user: userForm.smtp_user,
            smtp_use_tls: !!userForm.smtp_use_tls,
            smtp_from_email: userForm.smtp_from_email || null,
            smtp_from_name: userForm.smtp_from_name,
            ...(userForm.smtp_password ? { smtp_password: userForm.smtp_password } : {}),
          };
      if (editingUser === "new") {
        // POST /team — only role Admin/Staff allowed via invite endpoint
        await api.post("/team", {
          name: userForm.name,
          email: userForm.email,
          password: userForm.password,
          role: userForm.role === "Owner" ? "Admin" : userForm.role,
        });
        // If SMTP override or password override needed, do PATCH after
        const { data: all } = await api.get("/team");
        const created = all.find((x) => x.email === userForm.email.toLowerCase());
        if (created && !userForm.smtp_use_company) {
          await api.patch(`/team/${created.id}`, smtpFields);
        }
        toast.success("User added");
      } else {
        const payload = {
          name: userForm.name,
          email: userForm.email,
          role: userForm.role,
          ...smtpFields,
        };
        if (userForm.password) payload.password = userForm.password;
        await api.patch(`/team/${editingUser}`, payload);
        toast.success("User updated");
      }
      setEditingUser(null);
      loadTeam();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const deleteUser = async (id) => {
    if (!window.confirm("Delete this user permanently?")) return;
    try {
      await api.delete(`/team/${id}`);
      toast.success("User deleted");
      loadTeam();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // ─── Render ────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader title="Settings" subtitle={`$ tenant/${tenant?.company_name?.toLowerCase().replace(/\s+/g, "-")}`} />

      <div className="flex border border-zinc-200 rounded-sm overflow-hidden w-fit mb-5">
        <TabBtn active={tab === "users"} onClick={() => setTab("users")} icon={UsersThree} label="User Management" testid="tab-users" />
        <TabBtn active={tab === "hunter"} onClick={() => setTab("hunter")} icon={Key} label="Hunter.io API" testid="tab-hunter-api" />
      </div>

      {tab === "users" && (
        <div className="space-y-4">
          {/* ──── COMPANY SECTION ──── */}
          <Card className="overflow-hidden">
            <button
              onClick={() => setShowCompany(!showCompany)}
              className="w-full flex items-center justify-between px-5 py-3 border-b border-zinc-200 hover:bg-zinc-50 transition-colors"
              data-testid="toggle-company"
            >
              <div className="flex items-center gap-2">
                <Buildings size={18} weight="bold" className="text-green-600" />
                <div className="text-left">
                  <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">$ company/settings</div>
                  <div className="font-display text-base text-zinc-900">Company Information</div>
                </div>
              </div>
              {showCompany ? <CaretUp size={16} className="text-zinc-500" /> : <CaretDown size={16} className="text-zinc-500" />}
            </button>

            {showCompany && (
              <div className="p-5">
                {!isOwnerOrAdmin ? (
                  <div className="text-sm text-zinc-500 font-mono">Only Owner/Admin can edit company settings.</div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                      <TermInput
                        label="Company Name (Brand)"
                        placeholder="e.g. Elexart"
                        value={settings.company_name || ""}
                        onChange={(e) => updateCompany("company_name", e.target.value)}
                        data-testid="company-name"
                      />
                      <TermInput
                        label="Legal Name (Nama PT)"
                        placeholder="e.g. PT Elexart Corporate Hub"
                        value={settings.legal_name || ""}
                        onChange={(e) => updateCompany("legal_name", e.target.value)}
                        data-testid="company-legal-name"
                      />
                      <TermInput
                        label="Phone (No HP umum)"
                        placeholder="+62 812 3456 7890"
                        value={settings.phone || ""}
                        onChange={(e) => updateCompany("phone", e.target.value)}
                        data-testid="company-phone"
                      />
                    </div>

                    <div className="border-t border-zinc-200 pt-4">
                      <div className="flex items-center gap-2 mb-3">
                        <EnvelopeSimple size={16} weight="bold" className="text-green-600" />
                        <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Company Default SMTP</div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <TermInput label="SMTP Host" placeholder="smtp.gmail.com" value={settings.smtp_host || ""} onChange={(e) => updateCompany("smtp_host", e.target.value)} data-testid="smtp-host" />
                        <TermInput label="SMTP Port" type="number" placeholder="587" value={settings.smtp_port || ""} onChange={(e) => updateCompany("smtp_port", e.target.value)} data-testid="smtp-port" />
                        <TermInput label="SMTP Username" placeholder="user@gmail.com" value={settings.smtp_user || ""} onChange={(e) => updateCompany("smtp_user", e.target.value)} data-testid="smtp-user" />
                        <TermInput label="SMTP Password" type="password" placeholder="••••••••" value={settings.smtp_password || ""} onChange={(e) => updateCompany("smtp_password", e.target.value)} data-testid="smtp-password" />
                        <TermInput label="From Email" placeholder="hello@yourdomain.com" value={settings.smtp_from_email || ""} onChange={(e) => updateCompany("smtp_from_email", e.target.value)} />
                        <TermInput label="From Name" placeholder="Your Brand" value={settings.smtp_from_name || ""} onChange={(e) => updateCompany("smtp_from_name", e.target.value)} />
                        <TermSelect label="Use TLS/STARTTLS" value={settings.smtp_use_tls ? "yes" : "no"} onChange={(e) => updateCompany("smtp_use_tls", e.target.value === "yes")}>
                          <option value="yes">Yes (recommended)</option>
                          <option value="no">No</option>
                        </TermSelect>
                      </div>
                    </div>

                    <div className="mt-5 flex gap-2">
                      <PrimaryButton onClick={saveCompany} disabled={loading} data-testid="save-company">
                        {loading ? "Saving..." : "Save Company Settings"}
                      </PrimaryButton>
                    </div>
                    <div className="mt-3 text-[11px] font-mono text-zinc-500">
                      Tip: Gmail smtp.gmail.com:587 (App Password) · Outlook smtp.office365.com:587 · Mailgun smtp.mailgun.org:587
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>

          {/* ──── USERS SECTION ──── */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <UsersThree size={18} weight="bold" className="text-green-600" />
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">$ users/list</div>
                  <div className="font-display text-base text-zinc-900">Users ({team.length})</div>
                </div>
              </div>
              {isOwnerOrAdmin && (
                <PrimaryButton onClick={startNew} data-testid="add-user-btn">
                  <Plus size={14} weight="bold" /> Add User
                </PrimaryButton>
              )}
            </div>

            <div className="border border-zinc-200 rounded-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-zinc-500 text-[10px] uppercase tracking-widest font-mono">
                  <tr>
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Email (Login)</th>
                    <th className="text-left p-3">Role</th>
                    <th className="text-left p-3">SMTP</th>
                    <th className="text-left p-3">Joined</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {team.map((u) => {
                    const canEditThis =
                      user.role === "Owner" ||
                      user.id === u.id ||
                      (user.role === "Admin" && u.role === "Staff");
                    const canDeleteThis = user.role === "Owner" && u.id !== user.id;
                    return (
                      <tr key={u.id} className="border-t border-zinc-200 hover:bg-zinc-50">
                        <td className="p-3 text-zinc-900">{u.name}</td>
                        <td className="p-3 font-mono text-xs text-zinc-700">{u.email}</td>
                        <td className="p-3">
                          <Badge tone={u.role === "Owner" ? "success" : u.role === "Admin" ? "info" : "neutral"}>{u.role}</Badge>
                        </td>
                        <td className="p-3">
                          <Badge tone={u.smtp_use_company === false ? "warning" : "neutral"}>
                            {u.smtp_use_company === false ? "Custom" : "Company default"}
                          </Badge>
                        </td>
                        <td className="p-3 font-mono text-xs text-zinc-500">{u.created_at?.slice(0, 10)}</td>
                        <td className="p-3 text-right space-x-1">
                          {canEditThis && (
                            <button onClick={() => startEdit(u)} className="text-zinc-500 hover:text-green-600 inline-flex items-center" data-testid={`edit-${u.id}`} title="Edit">
                              <PencilSimple size={16} weight="bold" />
                            </button>
                          )}
                          {canDeleteThis && (
                            <button onClick={() => deleteUser(u.id)} className="text-zinc-500 hover:text-red-500 inline-flex items-center ml-2" data-testid={`del-user-${u.id}`} title="Delete">
                              <Trash size={16} weight="bold" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {tab === "hunter" && (
        <Card className="p-6 max-w-2xl">
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mb-1">$ hunter/api-key</div>
          <h2 className="font-display text-lg mb-1">Hunter.io API Key</h2>
          <div className="text-xs text-zinc-500 mb-4">
            Currently using <Badge tone="warning">MOCK</Badge>. Get key at{" "}
            <a className="text-green-600 underline" href="https://hunter.io/api-keys" target="_blank" rel="noreferrer">hunter.io/api-keys</a>.
          </div>
          <TermInput
            label="API Key"
            placeholder="(leave empty to use MOCK)"
            value={settings.hunter_api_key || ""}
            onChange={(e) => setSettings({ ...settings, hunter_api_key: e.target.value })}
            data-testid="hunter-api-key"
          />
          <div className="mt-4">
            <PrimaryButton onClick={saveHunterKey} disabled={loading} data-testid="save-hunter-key">
              {loading ? "Saving..." : "Save API Key"}
            </PrimaryButton>
          </div>
        </Card>
      )}

      {/* User Edit/Create Modal */}
      {editingUser && (
        <UserModal
          isNew={editingUser === "new"}
          form={userForm}
          setForm={setUserForm}
          onSave={saveUser}
          onClose={() => setEditingUser(null)}
          currentUserRole={user.role}
        />
      )}
    </div>
  );
}

function UserModal({ isNew, form, setForm, onSave, onClose, currentUserRole }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 fade-up">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">$ user/{isNew ? "new" : "edit"}</div>
            <h2 className="font-display text-lg text-zinc-900">{isNew ? "Add User" : "Edit User"}</h2>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-red-500" data-testid="close-user-modal">
            <X size={20} weight="bold" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Identity */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Identity</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <TermInput label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="user-form-name" />
              <TermInput label="Email (Login Username)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} data-testid="user-form-email" />
              <TermInput
                label={isNew ? "Login Password" : "New Password (leave empty to keep)"}
                type="text"
                placeholder={isNew ? "min 6 chars" : "••••••••"}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                data-testid="user-form-password"
              />
              <TermSelect
                label="Role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                disabled={currentUserRole !== "Owner"}
                data-testid="user-form-role"
              >
                {currentUserRole === "Owner" && <option value="Owner">Owner</option>}
                <option value="Admin">Admin</option>
                <option value="Staff">Staff</option>
              </TermSelect>
            </div>
          </div>

          {/* SMTP method */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500 mb-2">Email SMTP Method</div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <SmtpMethodCard
                active={form.smtp_use_company}
                onClick={() => setForm({ ...form, smtp_use_company: true })}
                title="Default (from Company)"
                description="Use the company-wide SMTP configured by Owner."
                testid="smtp-method-company"
              />
              <SmtpMethodCard
                active={!form.smtp_use_company}
                onClick={() => setForm({ ...form, smtp_use_company: false })}
                title="Custom (per user)"
                description="Use your own SMTP for outgoing emails."
                testid="smtp-method-custom"
              />
            </div>

            {!form.smtp_use_company && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 p-4 bg-zinc-50 border border-zinc-200 rounded-sm">
                <TermInput label="SMTP Host" placeholder="smtp.gmail.com" value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} />
                <TermInput label="SMTP Port" type="number" value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} />
                <TermInput label="SMTP Username" value={form.smtp_user} onChange={(e) => setForm({ ...form, smtp_user: e.target.value })} />
                <TermInput label="SMTP Password" type="password" placeholder={isNew ? "" : "(leave empty to keep)"} value={form.smtp_password} onChange={(e) => setForm({ ...form, smtp_password: e.target.value })} />
                <TermInput label="From Email" placeholder="me@yourbrand.com" value={form.smtp_from_email} onChange={(e) => setForm({ ...form, smtp_from_email: e.target.value })} />
                <TermInput label="From Name" value={form.smtp_from_name} onChange={(e) => setForm({ ...form, smtp_from_name: e.target.value })} />
                <TermSelect label="Use TLS" value={form.smtp_use_tls ? "yes" : "no"} onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.value === "yes" })}>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </TermSelect>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-zinc-200 flex justify-end gap-2">
          <GhostButton onClick={onClose} data-testid="cancel-user-modal">Cancel</GhostButton>
          <PrimaryButton onClick={onSave} data-testid="save-user-modal">{isNew ? "Create User" : "Save Changes"}</PrimaryButton>
        </div>
      </Card>
    </div>
  );
}

function SmtpMethodCard({ active, onClick, title, description, testid }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testid}
      className={`text-left p-3 border rounded-sm transition-all ${
        active ? "border-green-600 bg-green-50 ring-1 ring-green-600" : "border-zinc-200 hover:border-zinc-300 bg-white"
      }`}
    >
      <div className="font-mono text-xs text-zinc-900 font-bold mb-0.5">{title}</div>
      <div className="text-[11px] text-zinc-500">{description}</div>
    </button>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2 text-xs font-mono uppercase tracking-widest flex items-center gap-2 transition-colors border-r border-zinc-200 last:border-r-0 ${
        active ? "bg-green-50 text-green-700" : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}
