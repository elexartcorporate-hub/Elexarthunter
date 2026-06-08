import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge } from "@/components/term";
import {
  ArrowLeft, Buildings, At, Phone, MapPin, LinkedinLogo, Globe,
  PaperPlaneTilt, Plus, Trash, PencilSimple, X, ClockCounterClockwise,
  EnvelopeSimple, CheckCircle, Cursor, ChatCircle, Tag, NotePencil, Eye, Lock,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const STATUSES = ["New", "Contacted", "Interested", "Meeting Scheduled", "Customer", "Lost"];
const STATUS_TONE = {
  "New": "neutral", "Contacted": "info", "Interested": "warning",
  "Meeting Scheduled": "purple", "Customer": "success", "Lost": "error",
};

const ACTIVITY_ICON = {
  prospect_created: { icon: Plus, tone: "text-indigo-600", label: "Prospect created" },
  email_sent:       { icon: PaperPlaneTilt, tone: "text-emerald-600", label: "Email sent" },
  email_opened:     { icon: Eye, tone: "text-cyan-600", label: "Email opened" },
  email_clicked:    { icon: Cursor, tone: "text-blue-600", label: "Link clicked" },
  email_bounced:    { icon: X, tone: "text-rose-600", label: "Email bounced" },
  reply_received:   { icon: ChatCircle, tone: "text-purple-600", label: "Reply received" },
  status_changed:   { icon: Tag, tone: "text-amber-600", label: "Status changed" },
  note_added:       { icon: NotePencil, tone: "text-slate-600", label: "Note added" },
};

export default function ProspectDetail() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [quota, setQuota] = useState(null);
  const [showSend, setShowSend] = useState(params.get("send") === "1");
  const [showEdit, setShowEdit] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [newEmail, setNewEmail] = useState({ email: "", status: "verified" });

  const load = async () => {
    try {
      const { data } = await api.get(`/prospects/${id}`);
      setData(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  const loadQuota = async () => {
    try { const { data } = await api.get("/prospects/quota"); setQuota(data); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { load(); loadQuota(); }, [id]);

  const trySend = () => {
    if (quota?.locked && !quota?.can_bypass) {
      toast.error(`🔒 Daily quota not met — add ${quota.remaining} more prospect(s) before sending emails`, { duration: 4000 });
      return;
    }
    setShowSend(true);
  };

  const updateField = async (field, value) => {
    try {
      await api.patch(`/prospects/${id}`, { [field]: value });
      load();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const addNote = async () => {
    if (!noteText.trim()) return;
    try {
      await api.post(`/prospects/${id}/notes`, { text: noteText.trim() });
      setNoteText("");
      load();
      toast.success("Note added");
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const addEmail = async () => {
    if (!newEmail.email) return;
    try {
      await api.post(`/prospects/${id}/emails`, newEmail);
      setNewEmail({ email: "", status: "verified" });
      load();
      toast.success("Email added");
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const removeEmail = async (emailId) => {
    if (!window.confirm("Remove this email?")) return;
    try { await api.delete(`/prospects/${id}/emails/${emailId}`); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  const deleteProspect = async () => {
    if (!window.confirm("Delete this prospect? This cannot be undone.")) return;
    try { await api.delete(`/prospects/${id}`); toast.success("Deleted"); navigate("/prospects"); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  if (!data) return <div className="p-8 text-slate-500">Loading...</div>;
  const p = data.prospect;
  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <button onClick={() => navigate("/prospects")} className="text-xs text-slate-500 hover:text-slate-900 flex items-center gap-1 mb-2" data-testid="back-btn">
            <ArrowLeft size={12} weight="bold" /> Back to prospects
          </button>
          <div className="flex items-center gap-3 flex-wrap">
            <Buildings size={28} weight="duotone" className="text-indigo-600" />
            <h1 className="font-display text-2xl font-bold text-slate-900">{p.company_name}</h1>
            <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
          </div>
          <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-3">
            {p.website && <span className="flex items-center gap-1"><Globe size={12} weight="bold" />{p.website}</span>}
            {p.industry && <span>· {p.industry}</span>}
            {p.country && <span>· {p.country}</span>}
            {p.assigned_user_name && <span>· assigned to <b className="text-slate-700">{p.assigned_user_name}</b></span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <TermSelect value={p.status} onChange={(e) => updateField("status", e.target.value)} className="w-44" data-testid="status-select">
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </TermSelect>
          <GhostButton onClick={() => setShowEdit(true)} data-testid="edit-btn"><PencilSimple size={14} weight="bold" /> Edit</GhostButton>
          {quota?.locked && !quota?.can_bypass ? (
            <button
              onClick={trySend}
              data-testid="send-email-btn"
              className="px-3 py-1.5 rounded-lg bg-slate-200 text-slate-500 text-sm font-medium flex items-center gap-1.5 cursor-not-allowed border border-slate-300"
              title={`Locked — add ${quota.remaining} more prospect(s) today`}
            >
              <Lock size={14} weight="bold" /> Send Email
            </button>
          ) : (
            <PrimaryButton onClick={trySend} data-testid="send-email-btn"><PaperPlaneTilt size={14} weight="bold" /> Send Email</PrimaryButton>
          )}
          <GhostButton onClick={deleteProspect} className="text-rose-600 hover:bg-rose-50" data-testid="delete-btn"><Trash size={14} weight="bold" /></GhostButton>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* LEFT — company info + emails */}
        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2"><Buildings size={16} weight="bold" className="text-indigo-600" /> Company Information</h3>
            <div className="space-y-2 text-sm">
              <InfoRow icon={Globe}  label="Website" v={p.website} />
              <InfoRow icon={Globe}  label="Domain"  v={p.domain} />
              <InfoRow icon={Tag}    label="Industry" v={p.industry} />
              <InfoRow icon={MapPin} label="Location" v={[p.city, p.country].filter(Boolean).join(", ")} />
              <InfoRow icon={Phone}  label="Phone"    v={p.phone} />
              <InfoRow icon={LinkedinLogo} label="LinkedIn" v={p.linkedin} />
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2"><At size={16} weight="bold" className="text-indigo-600" /> Email Database ({(p.emails || []).length})</h3>
            <div className="space-y-2">
              {(p.emails || []).map((e) => (
                <div key={e.id} className={`flex items-center justify-between gap-2 p-2 rounded-lg border ${e.is_primary ? "bg-indigo-50 border-indigo-200" : "bg-slate-50 border-slate-200"}`}>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-slate-900 truncate flex items-center gap-1.5">
                      {e.email}
                      {e.is_primary && <Badge tone="info">primary</Badge>}
                    </div>
                  </div>
                  <Badge tone={e.status === "verified" ? "success" : e.status === "risky" ? "warning" : "error"}>{e.status}</Badge>
                  <button onClick={() => removeEmail(e.id)} className="text-slate-400 hover:text-rose-500" data-testid={`del-email-${e.id}`}>
                    <Trash size={14} weight="bold" />
                  </button>
                </div>
              ))}
              {(p.emails || []).length === 0 && <div className="text-xs text-slate-400 py-2 text-center">No emails saved</div>}
            </div>
            <div className="mt-3 flex gap-2">
              <input
                className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                placeholder="add@email.com"
                value={newEmail.email}
                onChange={(e) => setNewEmail({ ...newEmail, email: e.target.value })}
                data-testid="add-email-input"
              />
              <select
                className="px-2 py-2 border border-slate-200 rounded-lg text-sm"
                value={newEmail.status}
                onChange={(e) => setNewEmail({ ...newEmail, status: e.target.value })}
              >
                <option value="verified">verified</option>
                <option value="risky">risky</option>
                <option value="invalid">invalid</option>
              </select>
              <PrimaryButton onClick={addEmail} data-testid="add-email-btn"><Plus size={14} weight="bold" /></PrimaryButton>
            </div>
          </Card>
        </div>

        {/* MIDDLE — activity timeline */}
        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2">
              <ClockCounterClockwise size={16} weight="bold" className="text-indigo-600" /> Activity Timeline
            </h3>
            <div className="space-y-3 max-h-[500px] overflow-y-auto">
              {(data.activity || []).length === 0 && <div className="text-xs text-slate-400 py-4 text-center">No activity yet</div>}
              {(data.activity || []).map((a) => {
                const meta = ACTIVITY_ICON[a.type] || { icon: ChatCircle, tone: "text-slate-500", label: a.type };
                const Icon = meta.icon;
                return (
                  <div key={a.id} className="flex items-start gap-3">
                    <div className={`w-8 h-8 rounded-full bg-slate-50 border border-slate-200 grid place-items-center shrink-0 ${meta.tone}`}>
                      <Icon size={14} weight="bold" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-slate-900">
                        {meta.label}
                        {a.data?.to && <span className="text-xs text-slate-500"> → {a.data.to}</span>}
                        {a.data?.from && a.data?.to_status && <span className="text-xs text-slate-500"> {a.data.from} → {a.data.to_status}</span>}
                        {a.type === "status_changed" && <span className="text-xs text-slate-500"> {a.data?.from} → <b>{a.data?.to}</b></span>}
                      </div>
                      {a.type === "note_added" && a.data?.text && (
                        <div className="text-xs text-slate-700 bg-yellow-50 border border-yellow-200 rounded-lg px-2.5 py-1.5 mt-1">{a.data.text}</div>
                      )}
                      {a.data?.subject && <div className="text-xs text-slate-500 mt-0.5 truncate">subject: {a.data.subject}</div>}
                      <div className="text-[10px] text-slate-400 mt-0.5">{fmtTime(a.created_at)} {a.user_name && `· ${a.user_name}`}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* RIGHT — notes + email sends */}
        <div className="space-y-5">
          <Card className="p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2"><NotePencil size={16} weight="bold" className="text-indigo-600" /> Add Note</h3>
            <TermTextarea
              rows={4}
              placeholder="Write internal note or conversation summary..."
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              data-testid="note-input"
            />
            <div className="mt-2 flex justify-end">
              <PrimaryButton onClick={addNote} disabled={!noteText.trim()} data-testid="add-note-btn"><Plus size={14} weight="bold" /> Add Note</PrimaryButton>
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-display text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2"><EnvelopeSimple size={16} weight="bold" className="text-indigo-600" /> Email History ({(data.email_sends || []).length})</h3>
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {(data.email_sends || []).length === 0 && <div className="text-xs text-slate-400 py-3 text-center">No emails sent yet</div>}
              {(data.email_sends || []).map((s) => (
                <div key={s.id} className="border border-slate-200 rounded-lg p-2.5 bg-slate-50">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-mono text-xs text-slate-900 truncate flex-1">{s.subject}</div>
                    <SendStatusBadge status={s.status} />
                  </div>
                  <div className="text-[11px] text-slate-500 flex flex-wrap gap-2">
                    <span>→ {s.to_email}</span>
                    <span>· {fmtTime(s.created_at)}</span>
                    {s.opens > 0 && <Badge tone="info">{s.opens} opens</Badge>}
                    {s.clicks > 0 && <Badge tone="purple">{s.clicks} clicks</Badge>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {showSend && <SendEmailModal prospect={p} onClose={() => setShowSend(false)} onSent={() => { setShowSend(false); load(); }} />}
      {showEdit && <EditProspectModal prospect={p} onClose={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />}
    </div>
  );
}

function InfoRow({ icon: Icon, label, v }) {
  if (!v) return null;
  return (
    <div className="flex items-start gap-2">
      <Icon size={14} weight="bold" className="text-slate-400 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-slate-400 font-medium">{label}</div>
        <div className="text-sm text-slate-900 break-all">{v}</div>
      </div>
    </div>
  );
}

function SendStatusBadge({ status }) {
  const tone = {
    queued: "neutral", delivered: "success", opened: "info",
    clicked: "purple", replied: "success", bounce: "error", unsubscribed: "warning",
  }[status] || "neutral";
  return <Badge tone={tone}>{status}</Badge>;
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

/* ─────────────── Send Email Modal ─────────────── */
function SendEmailModal({ prospect, onClose, onSent }) {
  const [templates, setTemplates] = useState([]);
  const [subCompanies, setSubCompanies] = useState([]);
  const [form, setForm] = useState({
    to_email: ((prospect.emails || []).find((e) => e.is_primary) || prospect.emails?.[0] || {}).email || "",
    template_id: "",
    subject: "",
    body_html: "<p>Hi {{name}},</p>\n<p>I'd love to connect about {{company}}.</p>\n<p>Best,<br/>Your Name</p>",
    sub_company_id: prospect.sub_company_id || "",
  });
  const [sending, setSending] = useState(false);

  useEffect(() => {
    api.get("/templates").then(({ data }) => setTemplates(data)).catch(() => {});
    api.get("/sub-companies").then(({ data }) => setSubCompanies(data)).catch(() => {});
  }, []);

  const pickTemplate = (tid) => {
    setForm((f) => ({ ...f, template_id: tid }));
    if (!tid) return;
    const t = templates.find((x) => x.id === tid);
    if (t) setForm((f) => ({ ...f, subject: t.subject, body_html: t.body_html }));
  };

  const send = async () => {
    if (!form.to_email || !form.subject || !form.body_html) {
      return toast.error("To, subject and body are required");
    }
    setSending(true);
    try {
      await api.post(`/prospects/${prospect.id}/send-email`, {
        to_email: form.to_email, subject: form.subject, body_html: form.body_html,
        template_id: form.template_id || null,
        sub_company_id: form.sub_company_id || null,
      });
      toast.success("Email queued");
      onSent();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSending(false); }
  };

  const previewBody = useMemo(() => applyVars(form.body_html, prospect, form.to_email), [form.body_html, prospect, form.to_email]);
  const previewSubject = useMemo(() => applyVars(form.subject, prospect, form.to_email), [form.subject, prospect, form.to_email]);

  return (
    <ModalShell onClose={onClose} title={`Send Email · ${prospect.company_name}`} maxWidth="max-w-5xl">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <TermSelect label="Template" value={form.template_id} onChange={(e) => pickTemplate(e.target.value)} data-testid="send-template-select">
              <option value="">— blank —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </TermSelect>
            <TermSelect label="Send from (SMTP)" value={form.sub_company_id} onChange={(e) => setForm({ ...form, sub_company_id: e.target.value })}>
              <option value="">User / Tenant default</option>
              {subCompanies.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}{sc.smtp_host ? "" : " (no SMTP)"}</option>)}
            </TermSelect>
          </div>
          <TermSelect label="To" value={form.to_email} onChange={(e) => setForm({ ...form, to_email: e.target.value })} data-testid="send-to-select">
            {(prospect.emails || []).map((e) => <option key={e.email} value={e.email}>{e.email}{e.is_primary ? " · primary" : ""}</option>)}
          </TermSelect>
          <TermInput label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="send-subject" />
          <TermTextarea label="Body (HTML, supports {{name}} {{company}} {{email}} {{industry}})" rows={10} value={form.body_html} onChange={(e) => setForm({ ...form, body_html: e.target.value })} data-testid="send-body" />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-2">Preview</div>
          <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
            <div className="border-b border-slate-200 px-4 py-3 bg-white text-xs space-y-0.5">
              <div className="text-slate-500">To: <span className="text-slate-900">{form.to_email}</span></div>
              <div className="text-slate-500">Subject: <span className="text-slate-900 font-medium">{previewSubject || "(no subject)"}</span></div>
            </div>
            <div className="p-4 text-sm text-slate-900 prose prose-sm max-w-none max-h-[400px] overflow-y-auto" dangerouslySetInnerHTML={{ __html: previewBody }} />
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-200">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={send} disabled={sending} data-testid="send-now-btn">
          <PaperPlaneTilt size={14} weight="bold" /> {sending ? "Sending..." : "Send Now"}
        </PrimaryButton>
      </div>
    </ModalShell>
  );
}

function applyVars(text, p, email) {
  if (!text) return text;
  const name = (email || "").split("@")[0].replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const repl = {
    name, company: p.company_name || "", email: email || "",
    industry: p.industry || "", website: p.website || "", city: p.city || "", country: p.country || "",
  };
  return Object.entries(repl).reduce((acc, [k, v]) => acc.replace(new RegExp(`{{\\s*${k}\\s*}}`, "g"), v), text);
}

/* ─────────────── Edit Prospect Modal ─────────────── */
function EditProspectModal({ prospect, onClose, onSaved }) {
  const [form, setForm] = useState({
    company_name: prospect.company_name || "",
    website: prospect.website || "",
    industry: prospect.industry || "",
    country: prospect.country || "",
    city: prospect.city || "",
    phone: prospect.phone || "",
    linkedin: prospect.linkedin || "",
    notes: prospect.notes || "",
  });
  const save = async () => {
    try {
      await api.patch(`/prospects/${prospect.id}`, form);
      toast.success("Saved");
      onSaved();
    } catch (err) { toast.error(formatApiError(err)); }
  };
  return (
    <ModalShell onClose={onClose} title="Edit Prospect" maxWidth="max-w-3xl">
      <div className="grid grid-cols-2 gap-3">
        <TermInput label="Company Name" value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
        <TermInput label="Website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
        <TermInput label="Industry" value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} />
        <TermInput label="LinkedIn" value={form.linkedin} onChange={(e) => setForm({ ...form, linkedin: e.target.value })} />
        <TermInput label="Country" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        <TermInput label="City" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
        <TermInput label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-200">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={save} data-testid="save-edit-btn">Save</PrimaryButton>
      </div>
    </ModalShell>
  );
}

/* ─────────────── Reusable modal shell ─────────────── */
function ModalShell({ title, children, onClose, maxWidth = "max-w-3xl" }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card className={`w-full ${maxWidth} shadow-2xl my-auto`} onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 rounded-t-xl">
            <h2 className="font-display text-lg text-slate-900">{title}</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500" data-testid="modal-close-btn"><X size={20} weight="bold" /></button>
          </div>
          <div className="p-6">{children}</div>
        </Card>
      </div>
    </div>
  );
}
