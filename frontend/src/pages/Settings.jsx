import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, TermInput, TermSelect, PrimaryButton, GhostButton, Badge } from "@/components/term";
import { UsersThree, Key, Plus, Trash, PencilSimple, X, Buildings, EnvelopeSimple, CaretDown, CaretUp, ShieldCheck, Lock, Tag, MapPin } from "@phosphor-icons/react";
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
  const { user, tenant, refreshTenant, hasPermission } = useAuth();
  const isOwnerOrAdmin = user?.role === "Owner" || user?.role === "Admin";
  const [tab, setTab] = useState("users");
  const [settings, setSettings] = useState(null);
  const [team, setTeam] = useState([]);
  const [roles, setRoles] = useState([]);
  const [permissionCatalog, setPermissionCatalog] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCompany, setShowCompany] = useState(true);
  const [showRoles, setShowRoles] = useState(true);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState(EMPTY_USER_FORM);
  const [editingRole, setEditingRole] = useState(null); // null | "new" | roleId
  const [roleForm, setRoleForm] = useState({ name: "", permissions: [] });

  const loadTeam = async () => {
    try {
      const { data } = await api.get("/team");
      setTeam(data);
    } catch (e) {
      /* ignore */
    }
  };

  const loadRoles = async () => {
    try {
      const { data } = await api.get("/roles");
      setRoles(data);
    } catch (e) {
      /* ignore */
    }
  };

  const loadPermissions = async () => {
    try {
      const { data } = await api.get("/permissions");
      setPermissionCatalog(data);
    } catch (e) {
      /* ignore */
    }
  };

  useEffect(() => {
    if (isOwnerOrAdmin) {
      api.get("/settings").then((r) => setSettings(r.data)).catch((e) => toast.error(formatApiError(e)));
    } else {
      setSettings({});
    }
    loadTeam();
    loadRoles();
    loadPermissions();
  }, [isOwnerOrAdmin]);

  if (!settings) return <div className="p-10 font-mono text-indigo-600">Loading...</div>;

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

  // ─── Role CRUD handlers ────────────────────────────────
  const startNewRole = () => {
    setRoleForm({ name: "", permissions: ["dashboard"] });
    setEditingRole("new");
  };

  const startEditRole = (r) => {
    setRoleForm({ name: r.name, permissions: [...(r.permissions || [])] });
    setEditingRole(r.id);
  };

  const togglePermission = (key) => {
    const p = roleForm.permissions.includes(key)
      ? roleForm.permissions.filter((x) => x !== key)
      : [...roleForm.permissions, key];
    setRoleForm({ ...roleForm, permissions: p });
  };

  const saveRole = async () => {
    if (!roleForm.name.trim()) return toast.error("Role name required");
    try {
      if (editingRole === "new") {
        await api.post("/roles", roleForm);
        toast.success("Role created");
      } else {
        await api.patch(`/roles/${editingRole}`, roleForm);
        toast.success("Role updated");
      }
      setEditingRole(null);
      loadRoles();
      await refreshTenant();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const deleteRole = async (id) => {
    if (!window.confirm("Delete this role?")) return;
    try {
      await api.delete(`/roles/${id}`);
      toast.success("Role deleted");
      loadRoles();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  // ─── Render ────────────────────────────────────────────
  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader title="Settings" subtitle="Manage your workspace, team and integrations" />

      <div className="flex border border-slate-200 rounded-sm overflow-hidden w-fit mb-5">
        <TabBtn active={tab === "users"} onClick={() => setTab("users")} icon={UsersThree} label="User Management" testid="tab-users" />
        <TabBtn active={tab === "hunter-settings"} onClick={() => setTab("hunter-settings")} icon={Tag} label="Hunter Settings" testid="tab-hunter-settings" />
        <TabBtn active={tab === "hunter"} onClick={() => setTab("hunter")} icon={Key} label="Hunter.io API" testid="tab-hunter-api" />
      </div>

      {tab === "hunter-settings" && <HunterSettingsTab />}

      {tab === "users" && (
        <div className="space-y-4">
          {/* ──── COMPANY SECTION ──── */}
          <Card className="overflow-hidden">
            <button
              onClick={() => setShowCompany(!showCompany)}
              className="w-full flex items-center justify-between px-5 py-3 border-b border-slate-200 hover:bg-slate-50 transition-colors"
              data-testid="toggle-company"
            >
              <div className="flex items-center gap-2">
                <Buildings size={18} weight="bold" className="text-indigo-600" />
                <div className="text-left">
                  <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">Company info $ company/settings SMTP</div>
                  <div className="font-display text-base text-slate-900">Company Information</div>
                </div>
              </div>
              {showCompany ? <CaretUp size={16} className="text-slate-500" /> : <CaretDown size={16} className="text-slate-500" />}
            </button>

            {showCompany && (
              <div className="p-5">
                {!isOwnerOrAdmin ? (
                  <div className="text-sm text-slate-500 font-mono">Only Owner/Admin can edit company settings.</div>
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

                    <div className="border-t border-slate-200 pt-4">
                      <div className="flex items-center gap-2 mb-3">
                        <EnvelopeSimple size={16} weight="bold" className="text-indigo-600" />
                        <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">Company Default SMTP</div>
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
                    <div className="mt-3 text-[11px] font-mono text-slate-500">
                      Tip: Gmail smtp.gmail.com:587 (App Password) · Outlook smtp.office365.com:587 · Mailgun smtp.mailgun.org:587
                    </div>
                  </>
                )}
              </div>
            )}
          </Card>

          {/* ──── ROLES & PERMISSIONS SECTION ──── */}
          <Card className="overflow-hidden">
            <button
              onClick={() => setShowRoles(!showRoles)}
              className="w-full flex items-center justify-between px-5 py-3 border-b border-slate-200 hover:bg-slate-50 transition-colors"
              data-testid="toggle-roles"
            >
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} weight="bold" className="text-indigo-600" />
                <div className="text-left">
                  <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">Roles $ roles/permissions access control</div>
                  <div className="font-display text-base text-slate-900">Roles &amp; Menu Access ({roles.length})</div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {hasPermission && hasPermission("manage_roles") && (
                  <PrimaryButton
                    onClick={(e) => { e.stopPropagation(); startNewRole(); }}
                    data-testid="add-role-btn"
                  >
                    <Plus size={14} weight="bold" /> Add Role
                  </PrimaryButton>
                )}
                {showRoles ? <CaretUp size={16} className="text-slate-500" /> : <CaretDown size={16} className="text-slate-500" />}
              </div>
            </button>

            {showRoles && (
              <div className="p-5">
                <div className="border border-slate-200 rounded-sm overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                      <tr>
                        <th className="text-left p-3">Role</th>
                        <th className="text-left p-3">Permissions</th>
                        <th className="text-left p-3">Users</th>
                        <th className="text-left p-3">Type</th>
                        <th className="text-right p-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map((r) => (
                        <tr key={r.id} className="border-t border-slate-200 hover:bg-slate-50">
                          <td className="p-3 font-mono text-sm text-slate-900">{r.name}</td>
                          <td className="p-3">
                            <div className="flex flex-wrap gap-1 max-w-md">
                              {(r.permissions || []).slice(0, 6).map((p) => (
                                <Badge key={p} tone="info">{p}</Badge>
                              ))}
                              {(r.permissions || []).length > 6 && (
                                <Badge tone="neutral">+{r.permissions.length - 6} more</Badge>
                              )}
                            </div>
                          </td>
                          <td className="p-3"><Badge tone="success">{r.user_count}</Badge></td>
                          <td className="p-3">
                            <Badge tone={r.is_system ? "neutral" : "warning"}>
                              {r.is_system ? "system" : "custom"}
                            </Badge>
                          </td>
                          <td className="p-3 text-right space-x-1">
                            {hasPermission("manage_roles") && (
                              <>
                                <button
                                  onClick={() => startEditRole(r)}
                                  className="text-slate-500 hover:text-indigo-600 inline-flex items-center"
                                  title="Edit"
                                  data-testid={`edit-role-${r.id}`}
                                >
                                  <PencilSimple size={16} weight="bold" />
                                </button>
                                {!r.is_system && r.user_count === 0 && (
                                  <button
                                    onClick={() => deleteRole(r.id)}
                                    className="text-slate-500 hover:text-red-500 inline-flex items-center ml-2"
                                    title="Delete"
                                    data-testid={`del-role-${r.id}`}
                                  >
                                    <Trash size={16} weight="bold" />
                                  </button>
                                )}
                                {r.is_system && (
                                  <span className="text-slate-300 ml-2 inline-flex items-center" title="System role — cannot delete">
                                    <Lock size={14} weight="bold" />
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 text-[11px] font-mono text-slate-500">
                  System roles (Owner / Admin / Staff) tidak bisa dihapus tapi permissions bisa diatur ulang. Custom roles bisa dibuat bebas.
                </div>
              </div>
            )}
          </Card>

          {/* ──── USERS SECTION ──── */}
          <Card className="p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <UsersThree size={18} weight="bold" className="text-indigo-600" />
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">Team members</div>
                  <div className="font-display text-base text-slate-900">Users ({team.length})</div>
                </div>
              </div>
              {isOwnerOrAdmin && (
                <PrimaryButton onClick={startNew} data-testid="add-user-btn">
                  <Plus size={14} weight="bold" /> Add User
                </PrimaryButton>
              )}
            </div>

            <div className="border border-slate-200 rounded-sm overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
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
                      <tr key={u.id} className="border-t border-slate-200 hover:bg-slate-50">
                        <td className="p-3 text-slate-900">{u.name}</td>
                        <td className="p-3 font-mono text-xs text-slate-700">{u.email}</td>
                        <td className="p-3">
                          <Badge tone={u.role === "Owner" ? "success" : u.role === "Admin" ? "info" : "neutral"}>{u.role}</Badge>
                        </td>
                        <td className="p-3">
                          <Badge tone={u.smtp_use_company === false ? "warning" : "neutral"}>
                            {u.smtp_use_company === false ? "Custom" : "Company default"}
                          </Badge>
                        </td>
                        <td className="p-3 font-mono text-xs text-slate-500">{u.created_at?.slice(0, 10)}</td>
                        <td className="p-3 text-right space-x-1">
                          {canEditThis && (
                            <button onClick={() => startEdit(u)} className="text-slate-500 hover:text-indigo-600 inline-flex items-center" data-testid={`edit-${u.id}`} title="Edit">
                              <PencilSimple size={16} weight="bold" />
                            </button>
                          )}
                          {canDeleteThis && (
                            <button onClick={() => deleteUser(u.id)} className="text-slate-500 hover:text-red-500 inline-flex items-center ml-2" data-testid={`del-user-${u.id}`} title="Delete">
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
          <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500 mb-1">Hunter.io integration</div>
          <h2 className="font-display text-lg mb-1">Hunter.io API Key</h2>
          <div className="text-xs text-slate-500 mb-4">
            Currently using <Badge tone="warning">MOCK</Badge>. Get key at{" "}
            <a className="text-indigo-600 underline" href="https://hunter.io/api-keys" target="_blank" rel="noreferrer">hunter.io/api-keys</a>.
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
          availableRoles={roles}
        />
      )}

      {/* Role Edit/Create Modal */}
      {editingRole && (
        <RoleModal
          isNew={editingRole === "new"}
          form={roleForm}
          setForm={setRoleForm}
          togglePermission={togglePermission}
          permissionCatalog={permissionCatalog}
          onSave={saveRole}
          onClose={() => setEditingRole(null)}
          isSystem={editingRole !== "new" && roles.find((r) => r.id === editingRole)?.is_system}
        />
      )}
    </div>
  );
}

function UserModal({ isNew, form, setForm, onSave, onClose, currentUserRole, availableRoles = [] }) {
  // Filter out 'Owner' from invite dropdown (can only be assigned by Owner via edit, not new invite)
  const rolesForDropdown = availableRoles
    .map((r) => r.name)
    .filter((rn) => isNew ? rn !== "Owner" : true);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 fade-up">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">$ user/{isNew ? "new" : "edit"}</div>
            <h2 className="font-display text-lg text-slate-900">{isNew ? "Add User" : "Edit User"}</h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-red-500" data-testid="close-user-modal">
            <X size={20} weight="bold" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Identity */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Identity</div>
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
                {rolesForDropdown.map((rn) => (
                  <option key={rn} value={rn}>{rn}</option>
                ))}
              </TermSelect>
            </div>
          </div>

          {/* SMTP method */}
          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Email SMTP Method</div>
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
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 p-4 bg-slate-50 border border-slate-200 rounded-sm">
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

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2">
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
        active ? "border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600" : "border-slate-200 hover:border-slate-300 bg-white"
      }`}
    >
      <div className="font-mono text-xs text-slate-900 font-bold mb-0.5">{title}</div>
      <div className="text-[11px] text-slate-500">{description}</div>
    </button>
  );
}

function RoleModal({ isNew, form, setForm, togglePermission, permissionCatalog, onSave, onClose, isSystem }) {
  const menuPerms = permissionCatalog.filter((p) => p.menu);
  const actionPerms = permissionCatalog.filter((p) => !p.menu);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4 fade-up">
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">$ role/{isNew ? "new" : "edit"}</div>
            <h2 className="font-display text-lg text-slate-900 flex items-center gap-2">
              {isNew ? "New Role" : "Edit Role"}
              {isSystem && <Badge tone="neutral">system role</Badge>}
            </h2>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-red-500" data-testid="close-role-modal">
            <X size={20} weight="bold" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <TermInput
            label="Role Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            disabled={isSystem}
            placeholder="e.g. Sales Manager, Marketing Lead"
            hint={isSystem ? "System roles cannot be renamed" : "Pick a unique name within your tenant"}
            data-testid="role-form-name"
          />

          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Menu Access</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {menuPerms.map((p) => (
                <PermCheckbox
                  key={p.key}
                  perm={p}
                  checked={form.permissions.includes(p.key)}
                  onChange={() => togglePermission(p.key)}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-slate-500 mb-2">Action Permissions</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {actionPerms.map((p) => (
                <PermCheckbox
                  key={p.key}
                  perm={p}
                  checked={form.permissions.includes(p.key)}
                  onChange={() => togglePermission(p.key)}
                />
              ))}
            </div>
          </div>

          <div className="text-[11px] font-mono text-slate-500">
            Tip: User dengan role ini cuma akan melihat menu yang dicentang di sidebar. Permission action mengontrol API endpoint yang boleh diakses.
          </div>
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2">
          <GhostButton onClick={onClose} data-testid="cancel-role-modal">Cancel</GhostButton>
          <PrimaryButton onClick={onSave} data-testid="save-role-modal">{isNew ? "Create Role" : "Save Changes"}</PrimaryButton>
        </div>
      </Card>
    </div>
  );
}

function PermCheckbox({ perm, checked, onChange }) {
  return (
    <label className={`flex items-start gap-2 p-2.5 border rounded-sm cursor-pointer transition-all ${
      checked ? "border-indigo-600 bg-indigo-50" : "border-slate-200 hover:border-slate-300 bg-white"
    }`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 accent-indigo-600"
        data-testid={`perm-${perm.key}`}
      />
      <div className="min-w-0">
        <div className="font-mono text-xs text-slate-900">{perm.label}</div>
        <div className="text-[10px] text-slate-500 font-mono">{perm.key}</div>
      </div>
    </label>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2 text-[12px] font-medium flex items-center gap-2 transition-colors border-r border-slate-200 last:border-r-0 ${
        active ? "bg-indigo-50 text-indigo-700" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}

function HunterSettingsTab() {
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);
  const [newCat, setNewCat] = useState("");
  const [newLoc, setNewLoc] = useState("");

  const load = async () => {
    try {
      const [c, l] = await Promise.all([
        api.get("/hunter-settings/categories"),
        api.get("/hunter-settings/locations"),
      ]);
      setCategories(c.data);
      setLocations(l.data);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, []);

  const addCat = async () => {
    if (!newCat.trim()) return;
    try { await api.post("/hunter-settings/categories", { name: newCat.trim() }); setNewCat(""); toast.success("Category added"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  const delCat = async (id) => {
    if (!window.confirm("Delete this category?")) return;
    try { await api.delete(`/hunter-settings/categories/${id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  const addLoc = async () => {
    if (!newLoc.trim()) return;
    try { await api.post("/hunter-settings/locations", { name: newLoc.trim() }); setNewLoc(""); toast.success("Location added"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  const delLoc = async (id) => {
    if (!window.confirm("Delete this location?")) return;
    try { await api.delete(`/hunter-settings/locations/${id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Card className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <Tag size={18} weight="bold" className="text-indigo-600" />
          <h3 className="font-display text-base font-semibold text-slate-900">Categories ({categories.length})</h3>
        </div>
        <div className="text-xs text-slate-500 mb-3">Industry, niche or vertical — used to organize your saved leads.</div>
        <div className="flex gap-2 mb-3">
          <input
            className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-lg px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            placeholder="e.g. Travel, SaaS, E-commerce"
            value={newCat}
            onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCat()}
            data-testid="new-category-input"
          />
          <PrimaryButton onClick={addCat} data-testid="add-category-btn"><Plus size={14} weight="bold" /> Add</PrimaryButton>
        </div>
        <div className="space-y-1.5">
          {categories.length === 0 && <div className="text-sm text-slate-400 py-3 text-center">No categories yet</div>}
          {categories.map((c) => (
            <div key={c.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg hover:bg-slate-100">
              <span className="text-sm text-slate-700">{c.name}</span>
              <button onClick={() => delCat(c.id)} className="text-slate-400 hover:text-red-500" data-testid={`del-cat-${c.id}`}><Trash size={14} weight="bold" /></button>
            </div>
          ))}
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-3">
          <MapPin size={18} weight="bold" className="text-indigo-600" />
          <h3 className="font-display text-base font-semibold text-slate-900">Locations ({locations.length})</h3>
        </div>
        <div className="text-xs text-slate-500 mb-3">City, country or region — to filter your leads geographically.</div>
        <div className="flex gap-2 mb-3">
          <input
            className="flex-1 bg-white border border-slate-200 text-slate-900 rounded-lg px-3 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            placeholder="e.g. Jakarta, Bali, Singapore"
            value={newLoc}
            onChange={(e) => setNewLoc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addLoc()}
            data-testid="new-location-input"
          />
          <PrimaryButton onClick={addLoc} data-testid="add-location-btn"><Plus size={14} weight="bold" /> Add</PrimaryButton>
        </div>
        <div className="space-y-1.5">
          {locations.length === 0 && <div className="text-sm text-slate-400 py-3 text-center">No locations yet</div>}
          {locations.map((l) => (
            <div key={l.id} className="flex items-center justify-between px-3 py-2 bg-slate-50 rounded-lg hover:bg-slate-100">
              <span className="text-sm text-slate-700">{l.name}</span>
              <button onClick={() => delLoc(l.id)} className="text-slate-400 hover:text-red-500" data-testid={`del-loc-${l.id}`}><Trash size={14} weight="bold" /></button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
