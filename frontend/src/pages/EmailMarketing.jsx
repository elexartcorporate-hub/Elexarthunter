import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermTextarea, TermSelect, PrimaryButton, GhostButton, Badge, StatusBadge, EmptyState } from "@/components/term";
import {
  EnvelopeSimple, PaperPlaneTilt, Plus, X, Trash, Buildings, UsersThree, At, Eye, MagnifyingGlass,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const RECIPIENT_SOURCES = [
  { key: "my_leads", label: "My Leads",    icon: UsersThree, desc: "Pick from your saved personal leads" },
  { key: "contacts", label: "Database",    icon: Buildings,  desc: "All contacts from the master database" },
  { key: "manual",   label: "Manual",      icon: At,         desc: "Paste/type email addresses directly" },
];

export default function EmailMarketing() {
  const [campaigns, setCampaigns] = useState([]);
  const [subCompanies, setSubCompanies] = useState([]);
  const [showBuilder, setShowBuilder] = useState(false);
  const [previewCamp, setPreviewCamp] = useState(null);

  const loadCampaigns = async () => {
    try { const { data } = await api.get("/campaigns"); setCampaigns(data); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  const loadSubCompanies = async () => {
    try { const { data } = await api.get("/sub-companies"); setSubCompanies(data); }
    catch (err) { /* ignore */ }
  };

  useEffect(() => { loadCampaigns(); loadSubCompanies(); }, []);

  const sendCampaign = async (campId) => {
    if (!window.confirm("Send this campaign now? Recipients will receive emails immediately.")) return;
    try {
      const { data } = await api.post(`/campaigns/${campId}/send`, { send_now: true });
      toast.success(`Queued ${data.recipients_count} recipients`);
      setTimeout(loadCampaigns, 2000);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  const deleteCampaign = async (campId) => {
    if (!window.confirm("Delete this campaign?")) return;
    try { await api.delete(`/campaigns/${campId}`); toast.success("Deleted"); loadCampaigns(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  const subCompanyName = (id) => subCompanies.find((sc) => sc.id === id)?.name || "Tenant default";

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader
        title="Email Marketing"
        subtitle="Compose campaigns, pick a sub-company SMTP, and target the right recipients"
        action={
          <PrimaryButton onClick={() => setShowBuilder(true)} data-testid="new-campaign-btn">
            <Plus size={14} weight="bold" /> New Campaign
          </PrimaryButton>
        }
      />

      {campaigns.length === 0 ? (
        <EmptyState
          icon={EnvelopeSimple}
          title="No campaigns yet"
          description="Create your first campaign to start reaching out to leads."
          action={<PrimaryButton onClick={() => setShowBuilder(true)} data-testid="empty-new-campaign-btn"><Plus size={14} weight="bold"/> New Campaign</PrimaryButton>}
        />
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => (
            <Card key={c.id} className="p-5">
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-display text-lg font-semibold text-slate-900 truncate">{c.name}</span>
                    <StatusBadge status={c.status} />
                    {c.sub_company_id && <Badge tone="purple"><Buildings size={11} weight="bold" /> {subCompanyName(c.sub_company_id)}</Badge>}
                    <Badge tone="neutral">{c.recipient_source || "contacts"}</Badge>
                  </div>
                  <div className="text-xs text-slate-500 truncate">subject: {c.subject}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <GhostButton onClick={() => setPreviewCamp(c)} data-testid={`preview-${c.id}`}>
                    <Eye size={14} weight="bold" /> Preview
                  </GhostButton>
                  {c.status === "draft" && (
                    <PrimaryButton onClick={() => sendCampaign(c.id)} data-testid={`send-${c.id}`}>
                      <PaperPlaneTilt size={14} weight="bold" /> Send Now
                    </PrimaryButton>
                  )}
                  <GhostButton onClick={() => deleteCampaign(c.id)} data-testid={`del-camp-${c.id}`}>
                    <Trash size={14} weight="bold" />
                  </GhostButton>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                <Metric label="Recipients" value={c.metrics?.total || 0} tone="text-slate-900" />
                <Metric label="Delivered"  value={c.metrics?.delivered || 0} tone="text-emerald-600" />
                <Metric label="Opened"     value={c.metrics?.opened || 0} tone="text-cyan-600" />
                <Metric label="Clicked"    value={c.metrics?.clicked || 0} tone="text-indigo-600" />
                <Metric label="Bounced"    value={c.metrics?.bounced || 0} tone="text-rose-500" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {showBuilder && (
        <CampaignBuilder
          subCompanies={subCompanies}
          onClose={() => setShowBuilder(false)}
          onSaved={() => { setShowBuilder(false); loadCampaigns(); }}
        />
      )}

      {previewCamp && (
        <CampaignPreviewModal camp={previewCamp} onClose={() => setPreviewCamp(null)} subCompanyName={subCompanyName} />
      )}
    </div>
  );
}

/* ────────────── Campaign Builder ────────────── */
function CampaignBuilder({ subCompanies, onClose, onSaved }) {
  const [step, setStep] = useState(1); // 1: source, 2: recipients, 3: compose
  const [form, setForm] = useState({
    name: "",
    subject: "",
    body_html: "<p>Hi {{name}},</p>\n<p>I'd love to connect about ...</p>\n<p>Best,<br/>Your Name</p>",
    from_name: "",
    from_email: "",
    sub_company_id: "",
    recipient_source: "my_leads",
  });
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [manualEmails, setManualEmails] = useState("");
  const [loading, setLoading] = useState(false);

  const [myLeads, setMyLeads] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState("");

  // Lazy-load lists once when needed
  useEffect(() => {
    if (form.recipient_source === "my_leads" && myLeads.length === 0) {
      api.get("/my-leads").then(({ data }) => setMyLeads(data)).catch(() => {});
    }
    if (form.recipient_source === "contacts" && contacts.length === 0) {
      api.get("/contacts").then(({ data }) => setContacts(data)).catch(() => {});
    }
  }, [form.recipient_source]);

  const changeSource = (key) => {
    setForm((f) => ({ ...f, recipient_source: key }));
    setSelectedIds(new Set());
    setSearch("");
  };

  const pickSubCompany = (id) => {
    const sc = id ? subCompanies.find((s) => s.id === id) : null;
    setForm((f) => ({
      ...f,
      sub_company_id: id,
      from_name:  f.from_name  || sc?.smtp_from_name  || "",
      from_email: f.from_email || sc?.smtp_from_email || "",
    }));
  };

  const filteredLeads = useMemo(() => {
    const q = search.toLowerCase();
    return myLeads.filter((l) => !q || `${l.email} ${l.contact_name} ${l.company_name} ${l.category_name} ${l.location_name}`.toLowerCase().includes(q));
  }, [myLeads, search]);
  const filteredContacts = useMemo(() => {
    const q = search.toLowerCase();
    return contacts.filter((c) => !q || `${c.email} ${c.name} ${c.company_name} ${c.company_domain}`.toLowerCase().includes(q));
  }, [contacts, search]);

  const toggleId = (id) => {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  };
  const selectAll = () => {
    const all = form.recipient_source === "my_leads" ? filteredLeads : filteredContacts;
    if (selectedIds.size === all.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(all.map((x) => x.id)));
  };

  const manualEmailList = useMemo(() => {
    return Array.from(new Set(manualEmails.split(/[,;\s\n]+/).map((e) => e.trim()).filter((e) => e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))));
  }, [manualEmails]);

  const recipientCount = form.recipient_source === "manual" ? manualEmailList.length : selectedIds.size;

  const save = async (sendNow = false) => {
    if (!form.name.trim()) return toast.error("Campaign name required");
    if (!form.subject.trim()) return toast.error("Subject required");
    if (!form.body_html.trim()) return toast.error("Body required");
    if (recipientCount === 0) return toast.error("Select at least one recipient");

    const payload = {
      name: form.name,
      subject: form.subject,
      body_html: form.body_html,
      from_name: form.from_name || null,
      from_email: form.from_email || null,
      sub_company_id: form.sub_company_id || null,
      recipient_source: form.recipient_source,
      contact_ids:  form.recipient_source === "contacts" ? Array.from(selectedIds) : [],
      my_lead_ids:  form.recipient_source === "my_leads" ? Array.from(selectedIds) : [],
      manual_emails: form.recipient_source === "manual" ? manualEmailList : [],
    };

    setLoading(true);
    try {
      const { data } = await api.post("/campaigns", payload);
      if (sendNow) {
        try {
          const r = await api.post(`/campaigns/${data.id}/send`, { send_now: true });
          toast.success(`Campaign sending — ${r.data.recipients_count} recipients`);
        } catch (err) {
          toast.warning(`Saved as draft (send failed: ${formatApiError(err)})`);
        }
      } else {
        toast.success("Saved as draft");
      }
      onSaved();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally { setLoading(false); }
  };

  return (
    <BigModal onClose={onClose} title="New Campaign">
      {/* Stepper */}
      <div className="flex items-center gap-2 mb-6">
        {[
          { n: 1, label: "Sender & Source" },
          { n: 2, label: "Recipients" },
          { n: 3, label: "Compose & Send" },
        ].map((s, i) => (
          <div key={s.n} className="flex items-center gap-2">
            <button
              onClick={() => setStep(s.n)}
              data-testid={`step-${s.n}`}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                step === s.n
                  ? "bg-indigo-600 text-white"
                  : step > s.n
                    ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                    : "bg-slate-100 text-slate-500"
              }`}
            >
              <span className={`w-5 h-5 rounded-full grid place-items-center text-[10px] font-bold ${step === s.n ? "bg-white/20" : step > s.n ? "bg-emerald-500 text-white" : "bg-slate-300 text-white"}`}>{s.n}</span>
              {s.label}
            </button>
            {i < 2 && <div className="w-6 h-px bg-slate-200" />}
          </div>
        ))}
      </div>

      {/* STEP 1 */}
      {step === 1 && (
        <div className="space-y-5">
          <div>
            <div className="text-sm font-medium text-slate-700 mb-2">Sub-company (SMTP profile)</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => pickSubCompany("")}
                data-testid="sc-tenant-default"
                className={`text-left border rounded-xl p-3 transition-all ${form.sub_company_id === "" ? "border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50" : "border-slate-200 hover:border-slate-300"}`}
              >
                <div className="font-medium text-slate-900 text-sm">Tenant default</div>
                <div className="text-xs text-slate-500">Uses the SMTP set at tenant level</div>
              </button>
              {subCompanies.map((sc) => (
                <button
                  type="button"
                  key={sc.id}
                  onClick={() => pickSubCompany(sc.id)}
                  data-testid={`sc-${sc.id}`}
                  className={`text-left border rounded-xl p-3 transition-all ${form.sub_company_id === sc.id ? "border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <div className="font-medium text-slate-900 text-sm flex items-center gap-2">
                    <Buildings size={14} weight="bold" className="text-indigo-600" />
                    {sc.name}
                    {sc.smtp_host ? <Badge tone="success">SMTP set</Badge> : <Badge tone="warning">no SMTP</Badge>}
                  </div>
                  {sc.smtp_from_email && <div className="text-xs text-slate-500 mt-1 truncate">{sc.smtp_from_email}</div>}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="text-sm font-medium text-slate-700 mb-2">Recipient source</div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {RECIPIENT_SOURCES.map((s) => (
                <button
                  type="button"
                  key={s.key}
                  onClick={() => changeSource(s.key)}
                  data-testid={`source-${s.key}`}
                  className={`text-left border rounded-xl p-4 transition-all ${form.recipient_source === s.key ? "border-indigo-600 ring-2 ring-indigo-100 bg-indigo-50" : "border-slate-200 hover:border-slate-300"}`}
                >
                  <s.icon size={20} weight="bold" className={form.recipient_source === s.key ? "text-indigo-600" : "text-slate-500"} />
                  <div className="font-medium text-slate-900 text-sm mt-2">{s.label}</div>
                  <div className="text-xs text-slate-500 mt-0.5">{s.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <PrimaryButton onClick={() => setStep(2)} data-testid="step1-next">Continue →</PrimaryButton>
          </div>
        </div>
      )}

      {/* STEP 2 */}
      {step === 2 && (
        <div className="space-y-4">
          {form.recipient_source !== "manual" && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <MagnifyingGlass size={14} weight="bold" className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  placeholder="Search by email, name, company..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  data-testid="recipients-search"
                />
              </div>
              <GhostButton onClick={selectAll} data-testid="select-all-btn">
                {selectedIds.size === (form.recipient_source === "my_leads" ? filteredLeads : filteredContacts).length ? "Clear" : "Select all"}
              </GhostButton>
              <Badge tone="info">{selectedIds.size} selected</Badge>
            </div>
          )}

          {form.recipient_source === "my_leads" && (
            <RecipientsTable
              rows={filteredLeads}
              selected={selectedIds}
              onToggle={toggleId}
              columns={[
                { key: "email",         label: "Email" },
                { key: "contact_name",  label: "Name",     fallback: "—" },
                { key: "company_name",  label: "Company",  fallback: "—" },
                { key: "category_name", label: "Category", fallback: "—", badge: "info" },
                { key: "location_name", label: "Location", fallback: "—", badge: "purple" },
              ]}
              empty="No leads saved yet. Save leads from the Hunter page first."
              testidPrefix="lead"
            />
          )}

          {form.recipient_source === "contacts" && (
            <RecipientsTable
              rows={filteredContacts}
              selected={selectedIds}
              onToggle={toggleId}
              columns={[
                { key: "email",        label: "Email" },
                { key: "name",         label: "Name",    fallback: "—" },
                { key: "company_name", label: "Company", fallback: "—" },
                { key: "confidence_score", label: "Score", badge: "score" },
              ]}
              empty="No contacts in the master database yet."
              testidPrefix="contact"
            />
          )}

          {form.recipient_source === "manual" && (
            <div>
              <div className="text-sm font-medium text-slate-700 mb-2">Email addresses</div>
              <TermTextarea
                rows={8}
                placeholder="alice@example.com, bob@example.com&#10;charlie@example.com"
                value={manualEmails}
                onChange={(e) => setManualEmails(e.target.value)}
                data-testid="manual-emails"
              />
              <div className="text-xs text-slate-500 mt-2">
                Separate emails with comma, semicolon, space or newline. Detected: <Badge tone="success">{manualEmailList.length} valid</Badge>
              </div>
            </div>
          )}

          <div className="flex justify-between pt-2">
            <GhostButton onClick={() => setStep(1)}>← Back</GhostButton>
            <PrimaryButton onClick={() => setStep(3)} disabled={recipientCount === 0} data-testid="step2-next">
              Continue → ({recipientCount} recipients)
            </PrimaryButton>
          </div>
        </div>
      )}

      {/* STEP 3 */}
      {step === 3 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="space-y-3">
            <TermInput  label="Campaign Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="builder-name" />
            <TermInput  label="Subject"       value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="builder-subject" />
            <div className="grid grid-cols-2 gap-3">
              <TermInput label="From Name"  placeholder="(optional)" value={form.from_name}  onChange={(e) => setForm({ ...form, from_name: e.target.value })} />
              <TermInput label="From Email" placeholder="(SMTP default)" value={form.from_email} onChange={(e) => setForm({ ...form, from_email: e.target.value })} />
            </div>
            <TermTextarea label="Body (HTML)" rows={12} value={form.body_html} onChange={(e) => setForm({ ...form, body_html: e.target.value })} data-testid="builder-body" />
            <div className="text-[11px] text-slate-500">
              Tracking pixel + click-redirect auto-injected. Recipients: <span className="text-indigo-600 font-medium">{recipientCount}</span>
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Live Preview</div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
              <div className="border-b border-slate-200 px-4 py-3 text-xs space-y-0.5 bg-white">
                <div className="text-slate-500">From: <span className="text-slate-900">{form.from_name || "(default)"} &lt;{form.from_email || "default@smtp"}&gt;</span></div>
                <div className="text-slate-500">Subject: <span className="text-slate-900 font-medium">{form.subject || "(no subject)"}</span></div>
              </div>
              <div className="p-4 text-sm text-slate-900 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: form.body_html }} />
            </div>
          </div>

          <div className="lg:col-span-2 flex justify-between pt-2 border-t border-slate-200 mt-2">
            <GhostButton onClick={() => setStep(2)}>← Back</GhostButton>
            <div className="flex gap-2">
              <GhostButton onClick={() => save(false)} disabled={loading} data-testid="save-draft-btn">Save Draft</GhostButton>
              <PrimaryButton onClick={() => save(true)} disabled={loading} data-testid="save-send-btn">
                <PaperPlaneTilt size={14} weight="bold" /> {loading ? "Sending..." : "Save & Send"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </BigModal>
  );
}

/* ────────────── Recipients table ────────────── */
function RecipientsTable({ rows, selected, onToggle, columns, empty, testidPrefix }) {
  if (rows.length === 0) {
    return <div className="text-sm text-slate-400 text-center py-10 border border-dashed border-slate-200 rounded-lg">{empty}</div>;
  }
  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[50vh] overflow-y-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 sticky top-0 z-10">
          <tr className="text-slate-500 text-[11px] font-medium">
            <th className="p-2 w-8"></th>
            {columns.map((c) => <th key={c.key} className="text-left p-2">{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`border-t border-slate-100 hover:bg-slate-50 ${selected.has(r.id) ? "bg-indigo-50/40" : ""}`}>
              <td className="p-2 text-center">
                <input type="checkbox" className="accent-indigo-600" checked={selected.has(r.id)} onChange={() => onToggle(r.id)} data-testid={`${testidPrefix}-pick-${r.id}`} />
              </td>
              {columns.map((c) => {
                const v = r[c.key];
                if (c.badge === "score") {
                  return <td key={c.key} className="p-2"><Badge tone={v >= 80 ? "success" : v >= 50 ? "warning" : "error"}>{v ?? "—"}</Badge></td>;
                }
                if (c.badge && v) {
                  return <td key={c.key} className="p-2"><Badge tone={c.badge}>{v}</Badge></td>;
                }
                return <td key={c.key} className="p-2 text-slate-700 text-xs">{v || c.fallback || "—"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────── Preview modal ────────────── */
function CampaignPreviewModal({ camp, onClose, subCompanyName }) {
  const [recipients, setRecipients] = useState([]);
  useEffect(() => {
    api.get(`/campaigns/${camp.id}`).then(({ data }) => setRecipients(data.recipients || [])).catch(() => {});
  }, [camp.id]);
  return (
    <BigModal onClose={onClose} title={camp.name} subtitle={`subject: ${camp.subject}`}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Configuration</div>
          <div className="space-y-1.5 text-sm bg-slate-50 border border-slate-200 rounded-xl p-4">
            <Row k="Status" v={<StatusBadge status={camp.status} />} />
            <Row k="Sub-company" v={subCompanyName(camp.sub_company_id)} />
            <Row k="Source" v={<Badge tone="neutral">{camp.recipient_source || "contacts"}</Badge>} />
            <Row k="From" v={`${camp.from_name || "(default)"} <${camp.from_email || "smtp default"}>`} />
            <Row k="Recipients" v={camp.metrics?.total ?? recipients.length} />
            <Row k="Delivered / Opened / Clicked / Bounced"
              v={`${camp.metrics?.delivered || 0} / ${camp.metrics?.opened || 0} / ${camp.metrics?.clicked || 0} / ${camp.metrics?.bounced || 0}`} />
          </div>
          {recipients.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Recipients ({recipients.length})</div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[40vh] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr className="text-slate-500 text-[11px]">
                      <th className="text-left p-2">Email</th>
                      <th className="text-left p-2">Delivered</th>
                      <th className="text-left p-2">Opens</th>
                      <th className="text-left p-2">Clicks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recipients.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100">
                        <td className="p-2 text-slate-900">{r.email}</td>
                        <td className="p-2">{r.delivered ? <Badge tone="success">✓</Badge> : r.bounced ? <Badge tone="error">bounce</Badge> : <Badge tone="neutral">queued</Badge>}</td>
                        <td className="p-2 text-slate-700">{r.opens}</td>
                        <td className="p-2 text-slate-700">{r.clicks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-widest text-slate-500 font-medium mb-2">Body Preview</div>
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm text-slate-900 prose prose-sm max-w-none max-h-[60vh] overflow-y-auto"
            dangerouslySetInnerHTML={{ __html: camp.body_html }} />
        </div>
      </div>
    </BigModal>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="text-xs text-slate-500 min-w-[120px]">{k}</div>
      <div className="text-xs text-slate-900 text-right">{v}</div>
    </div>
  );
}

function Metric({ label, value, tone }) {
  return (
    <div className="bg-slate-50 rounded-lg p-2.5 text-center">
      <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}

/* ────────────── Reusable big modal ────────────── */
function BigModal({ title, subtitle, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start justify-center p-4 py-8">
        <Card
          className="w-full max-w-5xl shadow-2xl flex flex-col my-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between px-6 py-4 border-b border-slate-200 bg-white rounded-t-xl">
            <div>
              <h2 className="font-display text-lg text-slate-900">{title}</h2>
              {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500" data-testid="modal-close-x">
              <X size={20} weight="bold" />
            </button>
          </div>
          <div className="p-6">{children}</div>
        </Card>
      </div>
    </div>
  );
}
