import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Plus, Trash, PencilSimple, Copy, X, ListChecks, Eye, Paperclip,
  TextT, FileArrowUp, DownloadSimple, Code, ArrowRight,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import "./templates.css";

const SAMPLE_HTML = `<p>Hi {{name}},</p>
<p>I noticed <strong>{{company}}</strong> works in {{industry}} — we help similar teams streamline their outreach.</p>
<p>Would you be open to a quick chat next week?</p>
<p>Best,<br/>Your Name</p>`;

const SAMPLE_PLAIN = `Hi {{name}},

I noticed {{company}} works in {{industry}} — we help similar teams streamline their outreach.

Would you be open to a quick chat next week?

Best,
Your Name`;

const QUILL_MODULES = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ["bold", "italic", "underline", "strike"],
    [{ color: [] }, { background: [] }],
    [{ list: "ordered" }, { list: "bullet" }],
    [{ align: [] }],
    ["link", "blockquote"],
    ["clean"],
  ],
};

const VARIABLES = ["name", "company", "email", "industry", "website", "city", "country"];

export default function Templates() {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // null | "pick" | "new" | id
  const [form, setForm] = useState({ name: "", subject: "", body_html: SAMPLE_HTML, body_type: "html" });
  const [preview, setPreview] = useState(null);

  const load = async () => {
    try { const { data } = await api.get("/templates"); setRows(data); }
    catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, []);

  const startNew = () => {
    setEditing("pick");
  };

  const pickType = (type) => {
    setForm({
      name: "",
      subject: "",
      body_html: type === "html" ? SAMPLE_HTML : SAMPLE_PLAIN,
      body_type: type,
    });
    setEditing("new");
  };

  const startEdit = (t) => {
    setForm({
      name: t.name,
      subject: t.subject,
      body_html: t.body_html,
      body_type: t.body_type || "html",
      id: t.id,
      attachments: t.attachments || [],
    });
    setEditing(t.id);
  };

  const save = async (newForm) => {
    if (!newForm.name || !newForm.subject || !newForm.body_html) {
      toast.error("Nama, Subject, dan Body wajib diisi");
      return null;
    }
    try {
      const payload = {
        name: newForm.name,
        subject: newForm.subject,
        body_html: newForm.body_html,
        body_type: newForm.body_type,
      };
      let saved;
      if (editing === "new") {
        ({ data: saved } = await api.post("/templates", payload));
      } else {
        ({ data: saved } = await api.patch(`/templates/${editing}`, payload));
      }
      toast.success("Tersimpan");
      await load();
      return saved;
    } catch (err) {
      toast.error(formatApiError(err));
      return null;
    }
  };

  const del = async (id) => {
    if (!window.confirm("Hapus template ini?")) return;
    try { await api.delete(`/templates/${id}`); toast.success("Dihapus"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  const duplicate = async (id) => {
    try { await api.post(`/templates/${id}/duplicate`); toast.success("Diduplikasi"); load(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="Email Templates"
        subtitle="Template HTML/plain-text dengan variable {{name}} {{company}} {{email}} dan support attachment"
        action={
          <PrimaryButton onClick={startNew} data-testid="new-template-btn">
            <Plus size={14} weight="bold" /> New Template
          </PrimaryButton>
        }
      />

      {rows.length === 0 && !editing ? (
        <EmptyState
          icon={ListChecks}
          title="Belum ada template"
          description="Buat template email pertama Anda. Gunakan {{name}}, {{company}}, dll untuk personalisasi."
          action={<PrimaryButton onClick={startNew}><Plus size={14} weight="bold" /> New Template</PrimaryButton>}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rows.map((t) => (
            <Card key={t.id} className="p-5 group hover:border-indigo-200 transition-colors flex flex-col">
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                  <div className="font-display font-semibold text-slate-900 truncate" data-testid={`tpl-name-${t.id}`}>{t.name}</div>
                  <div className="text-xs text-slate-500 truncate">subject: {t.subject}</div>
                </div>
                <Badge tone={t.body_type === "plain" ? "neutral" : "info"}>
                  {t.body_type === "plain" ? <><TextT size={10} weight="bold" /> plain</> : <><Code size={10} weight="bold" /> html</>}
                </Badge>
              </div>
              {t.body_type === "plain" ? (
                <pre className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 line-clamp-3 font-sans whitespace-pre-wrap">{t.body_html}</pre>
              ) : (
                <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-3 line-clamp-3 prose prose-xs max-w-none" dangerouslySetInnerHTML={{ __html: t.body_html }} />
              )}
              {(t.attachments || []).length > 0 && (
                <div className="flex items-center gap-1 text-[11px] text-slate-500 mb-2">
                  <Paperclip size={11} weight="bold" />
                  <span>{t.attachments.length} attachment{t.attachments.length > 1 ? "s" : ""}</span>
                </div>
              )}
              <div className="flex items-center gap-1 mt-auto">
                <button onClick={() => setPreview(t)} className="text-slate-400 hover:text-indigo-600 p-1.5 rounded hover:bg-indigo-50" data-testid={`preview-${t.id}`} title="Preview"><Eye size={14} weight="bold" /></button>
                <button onClick={() => startEdit(t)} className="text-slate-400 hover:text-indigo-600 p-1.5 rounded hover:bg-indigo-50" data-testid={`edit-${t.id}`} title="Edit"><PencilSimple size={14} weight="bold" /></button>
                <button onClick={() => duplicate(t.id)} className="text-slate-400 hover:text-indigo-600 p-1.5 rounded hover:bg-indigo-50" data-testid={`dup-${t.id}`} title="Duplicate"><Copy size={14} weight="bold" /></button>
                <button onClick={() => del(t.id)} className="ml-auto text-slate-400 hover:text-rose-600 p-1.5 rounded hover:bg-rose-50" data-testid={`del-${t.id}`} title="Delete"><Trash size={14} weight="bold" /></button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing === "pick" && (
        <TypePickerModal onClose={() => setEditing(null)} onPick={pickType} />
      )}
      {(editing === "new" || (editing && editing !== "pick")) && (
        <TemplateModal
          form={form}
          setForm={setForm}
          onClose={() => setEditing(null)}
          onSave={save}
          isNew={editing === "new"}
          templateId={editing === "new" ? null : editing}
          onUpdated={load}
        />
      )}
      {preview && <PreviewModal template={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

function TypePickerModal({ onClose, onPick }) {
  return (
    <ModalShell onClose={onClose} title="Pilih tipe template" maxWidth="max-w-xl">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => onPick("html")}
          className="group p-5 border border-slate-200 rounded-xl text-left hover:border-indigo-400 hover:bg-indigo-50/50 transition-all"
          data-testid="pick-html-btn"
        >
          <div className="w-10 h-10 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center mb-3">
            <Code size={20} weight="bold" />
          </div>
          <div className="font-display font-semibold text-slate-900 mb-1 flex items-center gap-1">
            HTML Template <ArrowRight size={14} weight="bold" className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-xs text-slate-500 leading-snug">
            Rich text editor dengan Bold, Italic, List, Link, Color. Tampilan menarik, cocok untuk newsletter & outreach formal.
          </div>
        </button>
        <button
          type="button"
          onClick={() => onPick("plain")}
          className="group p-5 border border-slate-200 rounded-xl text-left hover:border-indigo-400 hover:bg-indigo-50/50 transition-all"
          data-testid="pick-plain-btn"
        >
          <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center mb-3">
            <TextT size={20} weight="bold" />
          </div>
          <div className="font-display font-semibold text-slate-900 mb-1 flex items-center gap-1">
            Plain Text <ArrowRight size={14} weight="bold" className="opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div className="text-xs text-slate-500 leading-snug">
            Teks polos tanpa formatting. Lebih personal, terlihat manual, biasanya delivery rate-nya lebih tinggi (tidak masuk spam).
          </div>
        </button>
      </div>
    </ModalShell>
  );
}

function TemplateModal({ form, setForm, onClose, onSave, isNew, templateId, onUpdated }) {
  const [savedId, setSavedId] = useState(templateId);
  const [attachments, setAttachments] = useState(form.attachments || []);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const updateField = (patch) => setForm({ ...form, ...patch });

  const insertVar = (v) => {
    if (form.body_type === "html") {
      // Append to end of HTML — user can move it
      updateField({ body_html: (form.body_html || "") + ` {{${v}}}` });
    } else {
      updateField({ body_html: (form.body_html || "") + ` {{${v}}}` });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    const saved = await onSave(form);
    setSaving(false);
    if (saved) {
      setSavedId(saved.id);
      if (saved.attachments) setAttachments(saved.attachments);
    }
    return saved;
  };

  const handleAttachClick = async () => {
    let tid = savedId;
    // If creating new and not yet saved, save first
    if (!tid) {
      const saved = await handleSave();
      if (!saved) return;
      tid = saved.id;
    }
    fileRef.current?.click();
  };

  const onFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File terlalu besar (max 8 MB)");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const { data } = await api.post(`/templates/${savedId}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setAttachments((prev) => [...prev, data]);
      toast.success(`Attachment "${data.filename}" terupload`);
      onUpdated?.();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (att) => {
    if (!window.confirm(`Hapus attachment "${att.filename}"?`)) return;
    try {
      await api.delete(`/templates/${savedId}/attachments/${att.id}`);
      setAttachments((prev) => prev.filter((a) => a.id !== att.id));
      toast.success("Attachment dihapus");
      onUpdated?.();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <ModalShell onClose={onClose} title={isNew ? "New Template" : "Edit Template"} maxWidth="max-w-4xl"
      footer={
        <>
          <div className="text-xs text-slate-500 mr-auto flex items-center gap-1">
            <Paperclip size={12} weight="bold" /> {attachments.length} attachment{attachments.length !== 1 ? "s" : ""}
          </div>
          <GhostButton onClick={onClose} disabled={saving} data-testid="tpl-cancel-btn">Cancel</GhostButton>
          <PrimaryButton onClick={handleSave} disabled={saving} data-testid="tpl-save-btn">
            {saving ? "Saving..." : (savedId ? "Update Template" : "Save Template")}
          </PrimaryButton>
        </>
      }
    >
      {/* Top fields */}
      <div className="space-y-3">
        <TermInput
          label="Template name"
          value={form.name}
          onChange={(e) => updateField({ name: e.target.value })}
          data-testid="tpl-name"
          placeholder="e.g., Outreach v1 — SaaS founders"
        />
        <TermInput
          label="Subject (variables allowed)"
          value={form.subject}
          onChange={(e) => updateField({ subject: e.target.value })}
          data-testid="tpl-subject"
          placeholder="Quick question about {{company}}"
        />

        {/* Body section */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs font-medium text-slate-700">Body</label>
            <Badge tone={form.body_type === "plain" ? "neutral" : "info"}>
              {form.body_type === "plain" ? <><TextT size={10} weight="bold" /> plain text</> : <><Code size={10} weight="bold" /> html</>}
            </Badge>
          </div>

          {form.body_type === "html" ? (
            <div className="quill-wrapper" data-testid="tpl-body-html">
              <ReactQuill
                theme="snow"
                value={form.body_html}
                onChange={(v) => updateField({ body_html: v })}
                modules={QUILL_MODULES}
                placeholder="Tulis email Anda di sini..."
              />
            </div>
          ) : (
            <textarea
              value={form.body_html}
              onChange={(e) => updateField({ body_html: e.target.value })}
              rows={12}
              data-testid="tpl-body-plain"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Tulis email plain-text..."
            />
          )}
        </div>

        {/* Variables */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-500 mr-1">Insert variable:</span>
          {VARIABLES.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => insertVar(v)}
              className="px-2 py-0.5 text-[11px] bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded border border-indigo-200 font-mono"
              data-testid={`tpl-var-${v}`}
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>

        {/* Attachments section */}
        <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
              <Paperclip size={12} weight="bold" /> Attachments
            </label>
            <button
              type="button"
              onClick={handleAttachClick}
              disabled={uploading}
              className="text-xs font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1 disabled:opacity-50"
              data-testid="tpl-attach-btn"
            >
              <FileArrowUp size={14} weight="bold" />
              {uploading ? "Uploading..." : (savedId ? "Add file" : "Save template first to attach")}
            </button>
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={onFileChange}
              data-testid="tpl-attach-input"
            />
          </div>
          {attachments.length === 0 ? (
            <div className="text-[11px] text-slate-400 py-2 text-center">
              Belum ada attachment. Max 8 MB per file, 20 MB total per template.
            </div>
          ) : (
            <div className="space-y-1.5">
              {attachments.map((a) => (
                <div key={a.id} className="flex items-center gap-2 px-2 py-1.5 bg-white border border-slate-200 rounded text-xs">
                  <Paperclip size={12} weight="bold" className="text-slate-400 shrink-0" />
                  <span className="font-medium text-slate-700 truncate flex-1" data-testid={`att-name-${a.id}`}>{a.filename}</span>
                  <span className="text-slate-400 shrink-0">{fmtSize(a.size)}</span>
                  <button
                    onClick={() => removeAttachment(a)}
                    className="text-slate-400 hover:text-rose-600 p-0.5"
                    data-testid={`att-del-${a.id}`}
                    title="Remove"
                  >
                    <Trash size={12} weight="bold" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Anti-spam tips */}
        <details className="text-xs">
          <summary className="text-slate-500 cursor-pointer hover:text-slate-700 select-none">
            Tips agar tidak masuk spam
          </summary>
          <ul className="mt-2 space-y-1 text-[11px] text-slate-500 list-disc pl-4">
            <li>Pastikan SPF, DKIM, dan DMARC sudah diset di domain Anda.</li>
            <li>Hindari kata-kata trigger spam (FREE, Buy now, semua-huruf-besar).</li>
            <li>Tulis dengan rasio teks-ke-link yang wajar — jangan link saja.</li>
            <li>Selalu sertakan plain-text fallback (otomatis untuk HTML).</li>
            <li>List-Unsubscribe header otomatis ditambahkan saat dikirim.</li>
            <li>Personalisasi pesan dengan variable {`{{name}}, {{company}}`}.</li>
          </ul>
        </details>
      </div>
    </ModalShell>
  );
}

function PreviewModal({ template, onClose }) {
  return (
    <ModalShell onClose={onClose} title={`Preview · ${template.name}`} maxWidth="max-w-2xl"
      footer={<GhostButton onClick={onClose}>Close</GhostButton>}
    >
      <div className="bg-slate-50 border border-slate-200 rounded-xl overflow-hidden">
        <div className="border-b border-slate-200 px-4 py-3 bg-white text-xs space-y-0.5">
          <div className="text-slate-500">Subject: <span className="text-slate-900 font-medium">{template.subject}</span></div>
          <div className="text-slate-500">Type: <Badge tone={template.body_type === "plain" ? "neutral" : "info"}>{template.body_type || "html"}</Badge></div>
        </div>
        {template.body_type === "plain" ? (
          <pre className="p-4 text-sm text-slate-900 whitespace-pre-wrap font-sans">{template.body_html}</pre>
        ) : (
          <div className="p-4 text-sm text-slate-900 prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: template.body_html }} />
        )}
        {(template.attachments || []).length > 0 && (
          <div className="border-t border-slate-200 px-4 py-3 bg-white">
            <div className="text-[11px] text-slate-500 mb-1.5 flex items-center gap-1">
              <Paperclip size={11} weight="bold" /> Attachments ({template.attachments.length})
            </div>
            <div className="space-y-1">
              {template.attachments.map((a) => (
                <div key={a.id} className="text-xs text-slate-700 flex items-center gap-1.5">
                  <DownloadSimple size={11} weight="bold" className="text-slate-400" />
                  {a.filename} <span className="text-slate-400">({fmtSize(a.size)})</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose, maxWidth = "max-w-3xl", footer }) {
  const bodyRef = useRef(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const reset = () => { if (bodyRef.current) bodyRef.current.scrollTop = 0; };
    reset();
    const t1 = setTimeout(reset, 50);
    const t2 = setTimeout(reset, 200);
    return () => {
      document.body.style.overflow = prev;
      clearTimeout(t1); clearTimeout(t2);
    };
  }, []);
  // Render outside the page tree via portal so `position: fixed` is relative to viewport,
  // not to any ancestor with `transform` (e.g. our page's fade-up animation).
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm fade-in" onClick={onClose}>
      <div className="absolute inset-0 flex items-center justify-center p-4 pointer-events-none">
        <div
          className={`pointer-events-auto w-full ${maxWidth} bg-white rounded-xl shadow-2xl flex flex-col`}
          style={{ maxHeight: "calc(100vh - 2rem)" }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Sticky header */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 rounded-t-xl shrink-0">
            <h2 className="font-display text-base font-semibold text-slate-900">{title}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-rose-500 p-1 rounded hover:bg-slate-100" data-testid="modal-close-btn">
              <X size={18} weight="bold" />
            </button>
          </div>
          {/* Scrollable body (only scrolls internally when needed) */}
          <div ref={bodyRef} className="flex-1 overflow-y-auto px-6 py-4 min-h-0 modal-body-scroll">{children}</div>
          {/* Sticky footer */}
          {footer && (
            <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-slate-200 bg-slate-50/50 rounded-b-xl shrink-0">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
