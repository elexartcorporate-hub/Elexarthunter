import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermTextarea, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import { Plus, Trash, PencilSimple, Copy, X, ListChecks, Eye } from "@phosphor-icons/react";
import { toast } from "sonner";

const SAMPLE = `<p>Hi {{name}},</p>
<p>I noticed {{company}} works in {{industry}} — we help similar teams ...</p>
<p>Would you be open to a quick chat next week?</p>
<p>Best,<br/>Your Name</p>`;

export default function Templates() {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // null | "new" | id
  const [form, setForm] = useState({ name: "", subject: "", body_html: SAMPLE });
  const [preview, setPreview] = useState(null);

  const load = async () => {
    try { const { data } = await api.get("/templates"); setRows(data); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => { setForm({ name: "", subject: "", body_html: SAMPLE }); setEditing("new"); };
  const startEdit = (t) => { setForm({ name: t.name, subject: t.subject, body_html: t.body_html }); setEditing(t.id); };

  const save = async () => {
    if (!form.name || !form.subject || !form.body_html) return toast.error("All fields required");
    try {
      if (editing === "new") await api.post("/templates", form);
      else await api.patch(`/templates/${editing}`, form);
      toast.success("Saved");
      setEditing(null); load();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const del = async (id) => {
    if (!window.confirm("Delete this template?")) return;
    try { await api.delete(`/templates/${id}`); toast.success("Deleted"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  const duplicate = async (id) => {
    try { await api.post(`/templates/${id}/duplicate`); toast.success("Duplicated"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="Email Templates"
        subtitle="Reusable email content with {{name}} {{company}} {{email}} {{industry}} variables"
        action={<PrimaryButton onClick={startNew} data-testid="new-template-btn"><Plus size={14} weight="bold" /> New Template</PrimaryButton>}
      />

      {rows.length === 0 && !editing ? (
        <EmptyState
          icon={ListChecks}
          title="No templates yet"
          description="Create your first reusable email template. Use {{name}}, {{company}}, etc. for personalization."
          action={<PrimaryButton onClick={startNew}><Plus size={14} weight="bold" /> New Template</PrimaryButton>}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rows.map((t) => (
            <Card key={t.id} className="p-5 group hover:border-indigo-200 transition-colors">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <div className="font-display font-semibold text-slate-900 truncate">{t.name}</div>
                  <div className="text-xs text-slate-500 truncate">subject: {t.subject}</div>
                </div>
                <Badge tone="info">tpl</Badge>
              </div>
              <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 line-clamp-3 prose prose-xs max-w-none" dangerouslySetInnerHTML={{ __html: t.body_html }} />
              <div className="flex items-center gap-1 opacity-100">
                <button onClick={() => setPreview(t)} className="text-slate-400 hover:text-indigo-600 p-1.5 rounded hover:bg-indigo-50" data-testid={`preview-${t.id}`}><Eye size={14} weight="bold" /></button>
                <button onClick={() => startEdit(t)} className="text-slate-400 hover:text-indigo-600 p-1.5 rounded hover:bg-indigo-50" data-testid={`edit-${t.id}`}><PencilSimple size={14} weight="bold" /></button>
                <button onClick={() => duplicate(t.id)} className="text-slate-400 hover:text-indigo-600 p-1.5 rounded hover:bg-indigo-50" data-testid={`dup-${t.id}`}><Copy size={14} weight="bold" /></button>
                <button onClick={() => del(t.id)} className="ml-auto text-slate-400 hover:text-rose-600 p-1.5 rounded hover:bg-rose-50" data-testid={`del-${t.id}`}><Trash size={14} weight="bold" /></button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && <TemplateModal form={form} setForm={setForm} onClose={() => setEditing(null)} onSave={save} isNew={editing === "new"} />}
      {preview && <PreviewModal template={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function TemplateModal({ form, setForm, onClose, onSave, isNew }) {
  return (
    <ModalShell onClose={onClose} title={isNew ? "New Template" : "Edit Template"} maxWidth="max-w-4xl">
      <div className="space-y-3">
        <TermInput label="Template name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="tpl-name" />
        <TermInput label="Subject (vars allowed)" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="tpl-subject" />
        <TermTextarea label="Body HTML" rows={14} value={form.body_html} onChange={(e) => setForm({ ...form, body_html: e.target.value })} data-testid="tpl-body" />
        <div className="text-[11px] text-slate-500">
          Variables: <Badge tone="info">{`{{name}}`}</Badge> <Badge tone="info">{`{{company}}`}</Badge> <Badge tone="info">{`{{email}}`}</Badge> <Badge tone="info">{`{{industry}}`}</Badge> <Badge tone="info">{`{{website}}`}</Badge> <Badge tone="info">{`{{city}}`}</Badge> <Badge tone="info">{`{{country}}`}</Badge>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4 mt-4 border-t border-slate-200">
        <GhostButton onClick={onClose}>Cancel</GhostButton>
        <PrimaryButton onClick={onSave} data-testid="tpl-save-btn">Save</PrimaryButton>
      </div>
    </ModalShell>
  );
}

function PreviewModal({ template, onClose }) {
  return (
    <ModalShell onClose={onClose} title={`Preview · ${template.name}`} maxWidth="max-w-2xl">
      <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3 bg-white text-xs space-y-0.5">
          <div className="text-slate-500">Subject: <span className="text-slate-900 font-medium">{template.subject}</span></div>
        </div>
        <div className="p-4 text-sm text-slate-900 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: template.body_html }} />
      </div>
    </ModalShell>
  );
}

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
