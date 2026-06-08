import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, TermInput, TermSelect, PrimaryButton, GhostButton, Badge } from "@/components/term";
import { Gear, EnvelopeSimple, Key, UsersThree, Plus, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";

export default function Settings() {
  const { user, tenant, refreshTenant } = useAuth();
  const isOwnerOrAdmin = user?.role === "Owner" || user?.role === "Admin";
  const [tab, setTab] = useState("smtp");
  const [settings, setSettings] = useState(null);
  const [team, setTeam] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [invite, setInvite] = useState({ name: "", email: "", password: "", role: "Staff" });

  useEffect(() => {
    if (isOwnerOrAdmin) {
      api.get("/settings").then((r) => setSettings(r.data)).catch((e) => toast.error(formatApiError(e)));
    }
    api.get("/team").then((r) => setTeam(r.data)).catch(() => {});
  }, [isOwnerOrAdmin]);

  if (!isOwnerOrAdmin)
    return (
      <div className="p-10">
        <Card className="p-6 text-center">
          <div className="font-mono text-xs uppercase tracking-widest text-zinc-500 mb-2">403</div>
          <div className="font-display text-lg">Insufficient permissions</div>
          <div className="text-sm text-zinc-500">Only Owner / Admin can access settings.</div>
        </Card>
      </div>
    );

  if (!settings) return <div className="p-10 font-mono text-green-500">Loading...</div>;

  const update = (key, value) => setSettings({ ...settings, [key]: value });

  const save = async () => {
    setLoading(true);
    try {
      const payload = {
        smtp_host: settings.smtp_host,
        smtp_port: settings.smtp_port ? parseInt(settings.smtp_port) : null,
        smtp_user: settings.smtp_user,
        smtp_password: settings.smtp_password,
        smtp_use_tls: settings.smtp_use_tls,
        smtp_from_email: settings.smtp_from_email,
        smtp_from_name: settings.smtp_from_name,
        hunter_api_key: settings.hunter_api_key,
      };
      const { data } = await api.patch("/settings", payload);
      setSettings(data);
      await refreshTenant();
      toast.success("Settings saved");
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  const inviteUser = async () => {
    try {
      await api.post("/team", invite);
      toast.success("User invited");
      setShowInvite(false);
      setInvite({ name: "", email: "", password: "", role: "Staff" });
      const { data } = await api.get("/team");
      setTeam(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const deleteUser = async (id) => {
    if (!window.confirm("Remove this user?")) return;
    try {
      await api.delete(`/team/${id}`);
      toast.success("Removed");
      const { data } = await api.get("/team");
      setTeam(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader title="Settings" subtitle={`$ tenant/${tenant?.company_name?.toLowerCase().replace(/\s+/g, "-")}`} />

      <div className="flex border border-zinc-800 rounded-sm overflow-hidden w-fit mb-5">
        <TabBtn active={tab === "smtp"} onClick={() => setTab("smtp")} icon={EnvelopeSimple} label="SMTP" testid="tab-smtp" />
        <TabBtn active={tab === "hunter"} onClick={() => setTab("hunter")} icon={Key} label="Hunter.io API" testid="tab-hunter-api" />
        <TabBtn active={tab === "team"} onClick={() => setTab("team")} icon={UsersThree} label={`Team (${team.length})`} testid="tab-team" />
      </div>

      {tab === "smtp" && (
        <Card className="p-6 max-w-3xl">
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mb-1">$ smtp/configure</div>
          <h2 className="font-display text-lg mb-4">SMTP Outbound Email</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TermInput label="SMTP Host" placeholder="smtp.gmail.com" value={settings.smtp_host || ""} onChange={(e) => update("smtp_host", e.target.value)} data-testid="smtp-host" />
            <TermInput label="SMTP Port" type="number" placeholder="587" value={settings.smtp_port || ""} onChange={(e) => update("smtp_port", e.target.value)} data-testid="smtp-port" />
            <TermInput label="SMTP Username" placeholder="user@gmail.com" value={settings.smtp_user || ""} onChange={(e) => update("smtp_user", e.target.value)} data-testid="smtp-user" />
            <TermInput label="SMTP Password" type="password" placeholder="••••••••" value={settings.smtp_password || ""} onChange={(e) => update("smtp_password", e.target.value)} data-testid="smtp-password" />
            <TermInput label="From Email" placeholder="hello@yourdomain.com" value={settings.smtp_from_email || ""} onChange={(e) => update("smtp_from_email", e.target.value)} data-testid="smtp-from-email" />
            <TermInput label="From Name" placeholder="Your Brand" value={settings.smtp_from_name || ""} onChange={(e) => update("smtp_from_name", e.target.value)} data-testid="smtp-from-name" />
            <TermSelect label="Use TLS/STARTTLS" value={settings.smtp_use_tls ? "yes" : "no"} onChange={(e) => update("smtp_use_tls", e.target.value === "yes")} data-testid="smtp-tls">
              <option value="yes">Yes (recommended)</option>
              <option value="no">No</option>
            </TermSelect>
          </div>
          <div className="mt-5 flex gap-2">
            <PrimaryButton onClick={save} disabled={loading} data-testid="save-smtp">{loading ? "Saving..." : "Save SMTP"}</PrimaryButton>
          </div>
          <div className="mt-4 text-[11px] font-mono text-zinc-500">
            Gmail: smtp.gmail.com:587 (use App Password) · Outlook: smtp.office365.com:587 · Mailgun: smtp.mailgun.org:587
          </div>
        </Card>
      )}

      {tab === "hunter" && (
        <Card className="p-6 max-w-2xl">
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mb-1">$ hunter/api-key</div>
          <h2 className="font-display text-lg mb-1">Hunter.io API Key</h2>
          <div className="text-xs text-zinc-500 mb-4">
            Currently using <Badge tone="warning">MOCK</Badge> data. Add your real Hunter.io key to swap the integration.
            Get a key at <a className="text-green-400" href="https://hunter.io/api-keys" target="_blank" rel="noreferrer">hunter.io/api-keys</a>.
          </div>
          <TermInput label="API Key" placeholder="(leave empty to use MOCK)" value={settings.hunter_api_key || ""} onChange={(e) => update("hunter_api_key", e.target.value)} data-testid="hunter-api-key" />
          <div className="mt-4">
            <PrimaryButton onClick={save} disabled={loading} data-testid="save-hunter-key">{loading ? "Saving..." : "Save API Key"}</PrimaryButton>
          </div>
        </Card>
      )}

      {tab === "team" && (
        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">$ team/list</div>
              <h2 className="font-display text-lg">Team Members</h2>
            </div>
            <PrimaryButton onClick={() => setShowInvite(true)} data-testid="invite-btn">
              <Plus size={14} weight="bold" /> Invite User
            </PrimaryButton>
          </div>
          <div className="border border-zinc-800 rounded-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase tracking-widest font-mono">
                <tr>
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Role</th>
                  <th className="text-left p-3">Joined</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {team.map((u) => (
                  <tr key={u.id} className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                    <td className="p-3 text-zinc-200">{u.name}</td>
                    <td className="p-3 font-mono text-xs text-zinc-300">{u.email}</td>
                    <td className="p-3"><Badge tone={u.role === "Owner" ? "success" : u.role === "Admin" ? "info" : "neutral"}>{u.role}</Badge></td>
                    <td className="p-3 font-mono text-xs text-zinc-500">{u.created_at?.slice(0, 10)}</td>
                    <td className="p-3 text-right">
                      {user.role === "Owner" && u.id !== user.id && (
                        <button onClick={() => deleteUser(u.id)} className="text-zinc-500 hover:text-red-400" data-testid={`del-user-${u.id}`}>
                          <Trash size={14} weight="bold" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {showInvite && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4">
          <Card className="w-full max-w-md p-6">
            <h2 className="font-display text-lg mb-4">Invite team member</h2>
            <div className="space-y-3">
              <TermInput label="Name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} data-testid="invite-name" />
              <TermInput label="Email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} data-testid="invite-email" />
              <TermInput label="Temporary Password" type="text" value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })} hint="They can change it later" data-testid="invite-password" />
              <TermSelect label="Role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })} data-testid="invite-role">
                <option value="Admin">Admin</option>
                <option value="Staff">Staff</option>
              </TermSelect>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <GhostButton onClick={() => setShowInvite(false)}>Cancel</GhostButton>
              <PrimaryButton onClick={inviteUser} data-testid="invite-submit">Create User</PrimaryButton>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2 text-xs font-mono uppercase tracking-widest flex items-center gap-2 transition-colors border-r border-zinc-800 last:border-r-0 ${
        active ? "bg-green-500/10 text-green-400" : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}
