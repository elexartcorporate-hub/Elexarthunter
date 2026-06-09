import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Tray, ArrowsClockwise, Buildings, EnvelopeSimple, EnvelopeOpen, Funnel, Warning,
  PaperPlaneTilt, ArrowBendUpLeft, X, PaperPlaneRight, CaretLeft,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const FOLDERS = [
  { key: "INBOX", label: "Inbox" },
  { key: "Sent",  label: "Sent" },
  { key: "Trash", label: "Trash" },
];

// ─── Module-level cache (survives component remounts when navigating menus) ───
const listCache    = new Map();   // key: `${scId}::${folder}::${unreadOnly?1:0}` -> { data, fetchedAt }
const detailCache  = new Map();   // key: `${scId}::${folder}::${uid}` -> detail
const lastSelected = new Map();   // key: `${scId}::${folder}` -> selected msg header (to restore selection on remount)

// Persist the set of UIDs we've marked as read locally — even when IMAP forgets after a refresh.
const READ_LS_KEY = "lh_inbox_read_uids_v1";
function loadLocalRead() {
  try { return new Set(JSON.parse(localStorage.getItem(READ_LS_KEY) || "[]")); }
  catch { return new Set(); }
}
function saveLocalRead(set) {
  try { localStorage.setItem(READ_LS_KEY, JSON.stringify([...set].slice(-2000))); }
  catch { /* quota – ignore */ }
}
function markLocalRead(scId, folder, uid) {
  const s = loadLocalRead();
  s.add(`${scId}::${folder}::${uid}`);
  saveLocalRead(s);
}
function applyLocalRead(scId, folder, messages) {
  const s = loadLocalRead();
  return messages.map((m) =>
    s.has(`${scId}::${folder}::${m.uid}`) && m.unread ? { ...m, unread: false } : m
  );
}

const cacheKey   = (scId, folder, unreadOnly) => `${scId}::${folder}::${unreadOnly ? 1 : 0}`;
const detailKey  = (scId, folder, uid)       => `${scId}::${folder}::${uid}`;
const selectKey  = (scId, folder)            => `${scId}::${folder}`;

export default function Inbox() {
  const [companies, setCompanies] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [folder, setFolder] = useState("INBOX");
  const [data, setData] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastFetchedAt, setLastFetchedAt] = useState(null);

  // Detail view state
  const [selected, setSelected] = useState(null); // message header
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(null);

  // Reply state
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyTo, setReplyTo] = useState("");
  const [replySubject, setReplySubject] = useState("");
  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);

  const loadCompanies = async () => {
    try {
      const { data } = await api.get("/inbox/companies");
      setCompanies(data);
      if (data.length > 0 && !activeId) setActiveId(data[0].id);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { loadCompanies(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  // Fetch inbox: by default uses cache if available. Force=true bypasses cache (Refresh button).
  const loadInbox = async (force = false) => {
    if (!activeId) return;
    const key = cacheKey(activeId, folder, unreadOnly);
    // Try to restore selection that belongs to the (company, folder) we're switching to.
    const restoreSelection = () => {
      const sel = lastSelected.get(selectKey(activeId, folder));
      const cachedDetail = sel ? detailCache.get(detailKey(activeId, folder, sel.uid)) : null;
      if (sel && cachedDetail) {
        setSelected(sel);
        setDetail(cachedDetail);
        setDetailLoading(false);
        setDetailError(null);
      } else {
        setSelected(null);
        setDetail(null);
        setDetailLoading(false);
        setDetailError(null);
      }
    };
    if (!force) {
      const cached = listCache.get(key);
      if (cached) {
        setData(cached.data);
        setError(null);
        setLoading(false);
        setLastFetchedAt(cached.fetchedAt);
        restoreSelection();
        return;
      }
    }
    setLoading(true); setError(null);
    if (force) {
      setSelected(null); setDetail(null);
    } else {
      restoreSelection();
    }
    try {
      const { data } = await api.get(`/inbox/${activeId}`, {
        params: { folder, limit: 20, unread_only: unreadOnly },
      });
      // Merge in any UIDs we already opened locally — protects against IMAP servers
      // that don't persist \Seen reliably and prevents the "comes back as unread" issue.
      const merged = { ...data, messages: applyLocalRead(activeId, folder, data.messages) };
      setData(merged);
      const fetchedAt = Date.now();
      listCache.set(key, { data: merged, fetchedAt });
      setLastFetchedAt(fetchedAt);
    } catch (err) {
      setError(formatApiError(err));
      setData(null);
    } finally { setLoading(false); }
  };
  useEffect(() => {
    if (activeId) loadInbox(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, folder, unreadOnly]);

  const openMessage = async (msg) => {
    setSelected(msg);
    lastSelected.set(selectKey(activeId, folder), msg);
    setDetailError(null);
    // Show cached detail instantly if we have it
    const dKey = detailKey(activeId, folder, msg.uid);
    const cachedDetail = detailCache.get(dKey);
    if (cachedDetail) {
      setDetail(cachedDetail);
      setDetailLoading(false);
      // Still apply unread→read optimistic update once
      if (msg.unread) {
        markLocalRead(activeId, folder, msg.uid);
        markCachedRead(activeId, folder, msg.uid, unreadOnly, setData);
      }
      return;
    }
    setDetail(null); setDetailLoading(true);
    try {
      const { data } = await api.get(`/inbox/${activeId}/message/${msg.uid}`, {
        params: { folder, mark_seen: true },
      });
      setDetail(data);
      detailCache.set(dKey, data);
      // Persist read status in both list state + cache + localStorage
      if (msg.unread) {
        markLocalRead(activeId, folder, msg.uid);
        markCachedRead(activeId, folder, msg.uid, unreadOnly, setData);
      }
    } catch (err) {
      setDetailError(formatApiError(err));
    } finally { setDetailLoading(false); }
  };

  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeId),
    [companies, activeId]
  );

  const startReply = () => {
    if (!detail) return;
    const replyAddr = parseAddress(detail.reply_to || detail.from);
    const subj = detail.subject || "";
    setReplyTo(replyAddr);
    setReplySubject(subj.toLowerCase().startsWith("re:") ? subj : `Re: ${subj}`);
    const quoted = buildQuotedReply(detail);
    setReplyBody(quoted);
    setReplyOpen(true);
  };

  const cancelReply = () => {
    setReplyOpen(false);
    setReplyTo(""); setReplySubject(""); setReplyBody("");
  };

  const sendReply = async () => {
    if (!detail || !replyTo.trim() || !replySubject.trim()) {
      toast.error("To dan Subject wajib diisi");
      return;
    }
    setSending(true);
    try {
      const { data: res } = await api.post(`/inbox/${activeId}/reply`, {
        uid: detail.uid,
        folder,
        to: replyTo.trim(),
        subject: replySubject,
        body_html: replyBody,
        in_reply_to: detail.message_id || "",
        references: detail.references || "",
      });
      toast.success(res.warn ? `Terkirim (${res.warn})` : "Balasan terkirim");
      // Invalidate Sent + current folder caches so refresh/visit shows latest
      [0, 1].forEach((u) => {
        listCache.delete(`${activeId}::Sent::${u}`);
        listCache.delete(`${activeId}::${folder}::${u}`);
      });
      cancelReply();
    } catch (err) {
      toast.error(formatApiError(err));
    } finally { setSending(false); }
  };

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="Inbox"
        subtitle="Baca & balas email langsung dari CRM — pakai IMAP/SMTP yang sudah di-set per company"
        action={
          <div className="flex items-center gap-2">
            {lastFetchedAt && !loading && (
              <span className="text-[11px] text-slate-500 hidden sm:inline" data-testid="last-fetched">
                Updated {fmtRelative(lastFetchedAt)}
              </span>
            )}
            <PrimaryButton onClick={() => loadInbox(true)} disabled={loading || !activeId} data-testid="refresh-inbox">
              <ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} /> Refresh
            </PrimaryButton>
          </div>
        }
      />

      {companies.length === 0 ? (
        <EmptyState
          icon={Tray}
          title="Belum ada company dengan IMAP"
          description="Setup IMAP di Settings → Companies dulu, atau minta admin assign sub-company ke akun Anda."
        />
      ) : (
        <>
          {/* Company picker */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {companies.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                data-testid={`pick-company-${c.id}`}
                className={`px-3 py-2 rounded-lg text-sm font-medium border flex items-center gap-2 transition-all ${
                  activeId === c.id
                    ? "bg-indigo-600 text-white border-indigo-600"
                    : "bg-white border-slate-200 text-slate-700 hover:border-slate-300"
                }`}
              >
                <Buildings size={14} weight="bold" />
                <span>{c.name}</span>
                {c.email && <span className={`text-[11px] ${activeId === c.id ? "opacity-80" : "text-slate-500"}`}>· {c.email}</span>}
              </button>
            ))}
          </div>

          {/* Folder tabs + unread filter */}
          <div className="flex flex-wrap items-center gap-1 mb-4 border-b border-slate-200">
            {FOLDERS.map((f) => (
              <button
                key={f.key}
                onClick={() => setFolder(f.key)}
                data-testid={`folder-${f.key.toLowerCase()}`}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  folder === f.key
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {f.label}
              </button>
            ))}
            <div className="ml-auto pb-2">
              <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={unreadOnly}
                  onChange={(e) => setUnreadOnly(e.target.checked)}
                  data-testid="unread-only"
                />
                <Funnel size={12} weight="bold" /> Unread only
              </label>
            </div>
          </div>

          {/* Split layout */}
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4">
            {/* List pane */}
            <Card className="p-0 overflow-hidden">
              {error ? (
                <div className="p-8 text-center">
                  <Warning size={32} weight="duotone" className="text-rose-500 mx-auto mb-2" />
                  <div className="text-sm font-medium text-rose-700" data-testid="inbox-error">{error}</div>
                  <div className="text-xs text-slate-500 mt-2">Periksa setting IMAP di Settings → Companies → Test IMAP</div>
                </div>
              ) : loading ? (
                <div className="p-12 text-center text-slate-500">Memuat email...</div>
              ) : !data || data.messages.length === 0 ? (
                <div className="p-12 text-center">
                  <Tray size={40} weight="duotone" className="text-slate-300 mx-auto mb-2" />
                  <div className="text-sm text-slate-500">
                    {unreadOnly ? "Tidak ada email belum dibaca" : `${FOLDERS.find(f=>f.key===folder)?.label} kosong`}
                  </div>
                </div>
              ) : (
                <>
                  <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 text-xs text-slate-600 flex items-center justify-between">
                    <span>{data.sub_company_name} · {data.mailbox} · {data.count} pesan</span>
                    <Badge tone="info">IMAP</Badge>
                  </div>
                  <div className="divide-y divide-slate-100 max-h-[70vh] overflow-y-auto">
                    {data.messages.map((m) => (
                      <button
                        key={m.uid}
                        onClick={() => openMessage(m)}
                        data-testid={`mail-${m.uid}`}
                        className={`w-full text-left p-3 hover:bg-slate-50 flex items-start gap-3 transition-colors ${
                          selected?.uid === m.uid ? "bg-indigo-50" : (m.unread ? "bg-indigo-50/30" : "")
                        }`}
                      >
                        <div className="mt-1">
                          {m.unread
                            ? <EnvelopeSimple size={18} weight="fill" className="text-indigo-600" />
                            : <EnvelopeOpen size={18} weight="bold" className="text-slate-400" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2 flex-wrap">
                            <div className={`text-sm truncate ${m.unread ? "font-bold text-slate-900" : "font-medium text-slate-700"}`}>
                              {m.from}
                            </div>
                            {m.unread && <Badge tone="info">UNREAD</Badge>}
                          </div>
                          <div className={`text-sm truncate ${m.unread ? "text-slate-900 font-medium" : "text-slate-600"}`}>
                            {m.subject}
                          </div>
                        </div>
                        <div className="text-[11px] text-slate-500 whitespace-nowrap shrink-0">{fmtDate(m.date)}</div>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </Card>

            {/* Detail pane */}
            <Card className="p-0 overflow-hidden">
              {!selected ? (
                <div className="p-12 text-center text-slate-400">
                  <EnvelopeOpen size={40} weight="duotone" className="mx-auto mb-2" />
                  <div className="text-sm">Pilih email untuk baca isinya</div>
                </div>
              ) : detailLoading ? (
                <div className="p-12 text-center text-slate-500">Memuat pesan...</div>
              ) : detailError ? (
                <div className="p-8 text-center">
                  <Warning size={32} weight="duotone" className="text-rose-500 mx-auto mb-2" />
                  <div className="text-sm font-medium text-rose-700">{detailError}</div>
                </div>
              ) : detail ? (
                <div className="flex flex-col max-h-[70vh]">
                  <div className="px-5 py-4 border-b border-slate-200">
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => { setSelected(null); setDetail(null); }}
                        className="lg:hidden p-1 -ml-1 rounded hover:bg-slate-100"
                        data-testid="back-to-list"
                        aria-label="Back"
                      >
                        <CaretLeft size={18} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="text-base font-semibold text-slate-900 break-words" data-testid="mail-subject">
                          {detail.subject}
                        </div>
                        <div className="text-xs text-slate-500 mt-1 truncate"><b>From:</b> {detail.from}</div>
                        <div className="text-xs text-slate-500 truncate"><b>To:</b> {detail.to}</div>
                        {detail.cc && <div className="text-xs text-slate-500 truncate"><b>Cc:</b> {detail.cc}</div>}
                        <div className="text-xs text-slate-400 mt-1">{detail.date}</div>
                      </div>
                      {folder !== "Sent" && (
                        <GhostButton onClick={startReply} data-testid="reply-btn" className="!py-2 !px-3 shrink-0">
                          <ArrowBendUpLeft size={14} weight="bold" /> Reply
                        </GhostButton>
                      )}
                    </div>
                  </div>
                  <div className="px-5 py-4 overflow-y-auto flex-1" data-testid="mail-body">
                    {detail.html ? (
                      <iframe
                        title="email-body"
                        srcDoc={sanitizeHtml(detail.html)}
                        sandbox=""
                        className="w-full min-h-[400px] border-0 bg-white"
                        style={{ height: "60vh" }}
                      />
                    ) : (
                      <pre className="whitespace-pre-wrap text-sm text-slate-800 font-sans">{detail.text || "(empty)"}</pre>
                    )}
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        </>
      )}

      {/* Reply modal */}
      {replyOpen && detail && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center overflow-y-auto p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl min-h-fit my-auto">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PaperPlaneTilt size={18} weight="bold" className="text-indigo-600" />
                <h3 className="font-semibold text-slate-900">Reply</h3>
                <Badge tone="info">{activeCompany?.email}</Badge>
              </div>
              <button onClick={cancelReply} className="p-1 rounded hover:bg-slate-100" data-testid="close-reply">
                <X size={18} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="text-xs font-medium text-slate-600">To</label>
                <input
                  value={replyTo}
                  onChange={(e) => setReplyTo(e.target.value)}
                  data-testid="reply-to"
                  className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Subject</label>
                <input
                  value={replySubject}
                  onChange={(e) => setReplySubject(e.target.value)}
                  data-testid="reply-subject"
                  className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-slate-600">Body (HTML supported)</label>
                <textarea
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  data-testid="reply-body"
                  rows={12}
                  className="w-full mt-1 px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-end gap-2">
              <GhostButton onClick={cancelReply} disabled={sending} data-testid="cancel-reply">Cancel</GhostButton>
              <PrimaryButton onClick={sendReply} disabled={sending} data-testid="send-reply">
                <PaperPlaneRight size={14} weight="bold" /> {sending ? "Sending..." : "Send Reply"}
              </PrimaryButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Mark a cached message as read across both the React state and the module-level list cache.
function markCachedRead(scId, folder, uid, unreadOnly, setData) {
  const updateMsgs = (msgs) => msgs.map((x) => x.uid === uid ? { ...x, unread: false } : x);
  // Update both cache keys (unread-only filter on/off)
  [0, 1].forEach((u) => {
    const k = `${scId}::${folder}::${u}`;
    const c = listCache.get(k);
    if (!c) return;
    let nextMsgs = updateMsgs(c.data.messages);
    // If we're on the unread-only view, remove the now-read item from THAT cached view
    if (u === 1) nextMsgs = nextMsgs.filter((x) => x.uid !== uid);
    listCache.set(k, { ...c, data: { ...c.data, messages: nextMsgs } });
  });
  // Update the live UI
  setData((d) => {
    if (!d) return d;
    let next = updateMsgs(d.messages);
    if (unreadOnly) next = next.filter((x) => x.uid !== uid);
    return { ...d, messages: next };
  });
}

function fmtRelative(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}

function fmtDate(s) {
  if (!s) return "";
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    const now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch { return s; }
}

function parseAddress(s) {
  if (!s) return "";
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim();
}

function buildQuotedReply(detail) {
  const original = (detail.text || stripHtml(detail.html || "")).trim();
  const quoted = original.split("\n").map((l) => "> " + l).join("\n");
  const header = `\n\n\n--- On ${detail.date || ""}, ${detail.from || ""} wrote: ---\n`;
  return `<p></p><br/><blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#555">${header}<pre style="white-space:pre-wrap;font-family:inherit">${quoted}</pre></blockquote>`;
}

function stripHtml(html) {
  if (!html) return "";
  return html.replace(/<style[\s\S]*?<\/style>/gi, "")
             .replace(/<script[\s\S]*?<\/script>/gi, "")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ");
}

function sanitizeHtml(html) {
  // Basic sanitization: strip script tags. iframe is sandboxed with no permissions.
  return (html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/on\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/on\w+\s*=\s*'[^']*'/gi, "");
}
