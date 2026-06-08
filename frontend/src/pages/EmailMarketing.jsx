import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermTextarea, TermSelect, PrimaryButton, GhostButton, Badge, StatusBadge, EmptyState } from "@/components/term";
import { EnvelopeSimple, PaperPlaneTilt, ChartBar, Plus, X, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";

export default function EmailMarketing() {
  const [tab, setTab] = useState("campaigns");
  const [campaigns, setCampaigns] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [filters, setFilters] = useState({ industry: "", country: "", source: "", min_score: "" });
  const [selectedContacts, setSelectedContacts] = useState(new Set());
  const [showBuilder, setShowBuilder] = useState(false);
  const [activeCampaign, setActiveCampaign] = useState(null);
  const [loading, setLoading] = useState(false);

  const [form, setForm] = useState({
    name: "",
    subject: "",
    body_html: "<p>Hi there,</p><p>I'd love to connect about ...</p><p>Best,<br/>Your Name</p>",
    from_name: "",
    from_email: "",
  });

  const loadCampaigns = async () => {
    try {
      const { data } = await api.get("/campaigns");
      setCampaigns(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const loadContacts = async () => {
    try {
      const params = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
      const { data } = await api.get("/contacts", { params });
      setContacts(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  useEffect(() => { loadCampaigns(); loadContacts(); }, []);

  const toggleSelect = (id) => {
    const s = new Set(selectedContacts);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedContacts(s);
  };

  const selectAll = () => {
    if (selectedContacts.size === contacts.length) setSelectedContacts(new Set());
    else setSelectedContacts(new Set(contacts.map((c) => c.id)));
  };

  const createDraft = async () => {
    if (!form.name || !form.subject || !form.body_html) {
      return toast.error("Name, subject and body required");
    }
    setLoading(true);
    try {
      const payload = {
        ...form,
        contact_ids: Array.from(selectedContacts),
      };
      const { data } = await api.post("/campaigns", payload);
      toast.success("Campaign draft created");
      setShowBuilder(false);
      setActiveCampaign(data);
      setForm({ ...form, name: "", subject: "" });
      setSelectedContacts(new Set());
      loadCampaigns();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally { setLoading(false); }
  };

  const sendCampaign = async (campId) => {
    if (!window.confirm("Send this campaign now? Recipients will receive emails immediately.")) return;
    try {
      const { data } = await api.post(`/campaigns/${campId}/send`, { send_now: true });
      toast.success(`Queued ${data.recipients_count} recipients`);
      setTimeout(loadCampaigns, 2000);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const deleteCampaign = async (campId) => {
    if (!window.confirm("Delete this campaign?")) return;
    try {
      await api.delete(`/campaigns/${campId}`);
      toast.success("Deleted");
      loadCampaigns();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader
        title="Email Marketing"
        subtitle="Create email campaigns and track delivery, opens, clicks and replies"
        action={
          <PrimaryButton onClick={() => { setShowBuilder(true); setActiveCampaign(null); }} data-testid="new-campaign-btn">
            <Plus size={14} weight="bold" /> New Campaign
          </PrimaryButton>
        }
      />

      <div className="flex border border-slate-200 rounded-sm overflow-hidden w-fit mb-5">
        <TabBtn active={tab === "campaigns"} onClick={() => setTab("campaigns")} icon={EnvelopeSimple} label={`Campaigns (${campaigns.length})`} testid="tab-campaigns" />
        <TabBtn active={tab === "contacts"} onClick={() => setTab("contacts")} icon={ChartBar} label="Contact List" testid="tab-contacts" />
      </div>

      {tab === "campaigns" && (
        campaigns.length === 0 && !showBuilder ? (
          <EmptyState
            title="No campaigns yet"
            description="Create your first campaign to start reaching out to discovered contacts."
            action={<PrimaryButton onClick={() => setShowBuilder(true)} data-testid="empty-new-campaign-btn"><Plus size={14} weight="bold"/> New Campaign</PrimaryButton>}
          />
        ) : (
          <div className="space-y-3">
            {campaigns.map((c) => (
              <Card key={c.id} className="p-4">
                <div className="flex items-start justify-between mb-3 gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-display text-lg text-slate-900 truncate">{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="font-mono text-xs text-slate-500 truncate">subject: {c.subject}</div>
                  </div>
                  <div className="flex gap-2">
                    {c.status === "draft" && (
                      <PrimaryButton onClick={() => sendCampaign(c.id)} data-testid={`send-${c.id}`}>
                        <PaperPlaneTilt size={14} weight="bold" /> Send Now
                      </PrimaryButton>
                    )}
                    <GhostButton onClick={() => deleteCampaign(c.id)} data-testid={`del-camp-${c.id}`}>
                      <Trash size={14} weight="bold" /> Delete
                    </GhostButton>
                  </div>
                </div>
                <div className="grid grid-cols-5 gap-2 text-center">
                  <Metric label="Recipients" value={c.metrics?.total || 0} tone="text-slate-900" />
                  <Metric label="Delivered" value={c.metrics?.delivered || 0} tone="text-emerald-500" />
                  <Metric label="Opened" value={c.metrics?.opened || 0} tone="text-cyan-400" />
                  <Metric label="Clicked" value={c.metrics?.clicked || 0} tone="text-green-300" />
                  <Metric label="Bounced" value={c.metrics?.bounced || 0} tone="text-red-400" />
                </div>
              </Card>
            ))}
          </div>
        )
      )}

      {tab === "contacts" && (
        <Card className="p-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3">
            <TermInput label="Industry" value={filters.industry} onChange={(e) => setFilters({ ...filters, industry: e.target.value })} />
            <TermInput label="Country" value={filters.country} onChange={(e) => setFilters({ ...filters, country: e.target.value })} />
            <TermSelect label="Source" value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })}>
              <option value="">all</option>
              <option value="website">website</option>
              <option value="hunter">hunter</option>
              <option value="manual">manual</option>
            </TermSelect>
            <TermInput label="Min Score" type="number" value={filters.min_score} onChange={(e) => setFilters({ ...filters, min_score: e.target.value })} />
            <div className="flex items-end">
              <PrimaryButton onClick={loadContacts} className="w-full" data-testid="filter-apply">Apply</PrimaryButton>
            </div>
          </div>
          <div className="text-xs text-slate-500 font-mono mb-2">{contacts.length} contacts · {selectedContacts.size} selected</div>
          <div className="border border-slate-200 rounded-sm overflow-hidden max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr className="text-slate-500 text-[11px] font-medium">
                  <th className="p-2"><input type="checkbox" checked={selectedContacts.size === contacts.length && contacts.length > 0} onChange={selectAll} /></th>
                  <th className="text-left p-2">Email</th>
                  <th className="text-left p-2">Name</th>
                  <th className="text-left p-2">Company</th>
                  <th className="text-left p-2">Score</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-t border-slate-200/60 hover:bg-slate-50/40">
                    <td className="p-2 text-center">
                      <input type="checkbox" checked={selectedContacts.has(c.id)} onChange={() => toggleSelect(c.id)} data-testid={`select-${c.id}`} />
                    </td>
                    <td className="p-2 font-mono text-xs text-slate-900">{c.email}</td>
                    <td className="p-2 text-xs text-slate-700">{c.name || "—"}</td>
                    <td className="p-2 text-xs text-slate-500">{c.company_name || c.company_domain || "—"}</td>
                    <td className="p-2"><Badge tone={c.confidence_score >= 80 ? "success" : c.confidence_score >= 50 ? "warning" : "error"}>{c.confidence_score}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedContacts.size > 0 && (
            <div className="mt-3">
              <PrimaryButton onClick={() => { setTab("campaigns"); setShowBuilder(true); }} data-testid="use-selection-btn">
                <EnvelopeSimple size={14} weight="bold" /> Use {selectedContacts.size} selected in new campaign
              </PrimaryButton>
            </div>
          )}
        </Card>
      )}

      {/* Builder Modal */}
      {showBuilder && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <Card className="w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-5 pb-3 border-b border-slate-200">
              <div>
                <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500">New campaign</div>
                <h2 className="font-display text-xl">Campaign Builder</h2>
              </div>
              <button onClick={() => setShowBuilder(false)} className="text-slate-500 hover:text-red-400" data-testid="close-builder">
                <X size={20} weight="bold" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Left: config */}
              <div className="space-y-3">
                <TermInput label="Campaign Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="builder-name" />
                <TermInput label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="builder-subject" />
                <div className="grid grid-cols-2 gap-3">
                  <TermInput label="From Name" placeholder="(optional)" value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
                  <TermInput label="From Email" placeholder="(optional, uses SMTP default)" value={form.from_email} onChange={(e) => setForm({ ...form, from_email: e.target.value })} />
                </div>
                <TermTextarea label="Body HTML" rows={10} value={form.body_html} onChange={(e) => setForm({ ...form, body_html: e.target.value })} data-testid="builder-body" />
                <div className="text-[11px] font-mono text-slate-500">
                  Tracking pixel + click-redirect auto-injected. Recipients: <span className="text-emerald-500">{selectedContacts.size}</span>
                  {selectedContacts.size === 0 && <span className="text-yellow-400"> (filtered list will be used at send time)</span>}
                </div>
              </div>
              {/* Right: live preview */}
              <div>
                <div className="font-mono text-[11px] uppercase tracking-widest text-slate-500 mb-1.5">Preview</div>
                <div className="bg-slate-50 border border-slate-200 rounded-sm">
                  <div className="border-b border-slate-200 px-4 py-2 text-xs">
                    <div className="text-slate-500 font-mono">From: <span className="text-slate-700">{form.from_name || "(SMTP default)"}</span></div>
                    <div className="text-slate-500 font-mono">Subject: <span className="text-slate-900">{form.subject || "(no subject)"}</span></div>
                  </div>
                  <div className="p-4 prose prose-invert max-w-none text-sm text-slate-900" dangerouslySetInnerHTML={{ __html: form.body_html }} />
                </div>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <GhostButton onClick={() => setShowBuilder(false)} data-testid="cancel-builder">Cancel</GhostButton>
              <PrimaryButton onClick={createDraft} disabled={loading} data-testid="save-draft-btn">Save Draft</PrimaryButton>
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
      className={`px-4 py-2 text-xs font-mono uppercase tracking-widest flex items-center gap-2 transition-colors border-r border-slate-200 last:border-r-0 ${
        active ? "bg-indigo-500/10 text-emerald-500" : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="bg-slate-50/60 rounded-sm p-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`font-mono text-xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}
