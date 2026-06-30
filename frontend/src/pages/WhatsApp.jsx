import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  WhatsappLogo, Plus, Trash, Eye, ArrowsClockwise, X, PaperPlaneRight,
  ChatCircleDots, Phone, User, ShieldCheck, Warning, CheckCircle,
  Paperclip, UsersThree,
} from "@phosphor-icons/react";
import { toast } from "sonner";

// ─── Helpers ───
function formatPhone(jid) {
  if (!jid) return "";
  if (jid.includes("@g.us")) return "";
  // @lid = LID (Anonymous WhatsApp privacy ID) — NOT a real phone number.
  // Show with explicit marker so user knows real number is hidden.
  if (jid.includes("@lid")) {
    const lidId = jid.split("@")[0].split(":")[0];
    // Show last 4 digits only to make clear it's anonymous
    return `🔒 LID#${lidId.slice(-6)}`;
  }
  const num = jid.split("@")[0].split(":")[0]; // strip device part :12
  return num.startsWith("+") ? num : "+" + num;
}
function jidName(jid, fallback) {
  if (!jid) return fallback || "Unknown";
  if (jid.includes("@g.us")) return fallback || "Group";
  // For private chats: ALWAYS show phone or LID marker — never alias/push name as primary.
  return formatPhone(jid);
}
// Is this JID an anonymous LID (no real PN resolved)?
function isLidOnly(jid) {
  return jid && jid.includes("@lid");
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString();
}

function statusBadge(status) {
  const map = {
    connected:    { tone: "success", label: "Connected",   icon: CheckCircle },
    connecting:   { tone: "info",    label: "Connecting…", icon: ArrowsClockwise },
    qr:           { tone: "warning", label: "Scan QR",     icon: Phone },
    reconnecting: { tone: "warning", label: "Reconnecting",icon: ArrowsClockwise },
    logged_out:   { tone: "danger",  label: "Logged out",  icon: Warning },
    init:         { tone: "neutral", label: "Initializing",icon: ArrowsClockwise },
  };
  return map[status] || { tone: "neutral", label: status || "Unknown", icon: ChatCircleDots };
}

// ─── QR Modal ───
function QrModal({ open, onClose, account, onConnected }) {
  const [state, setState] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    if (!open || !account) return;
    let stop = false;
    const poll = async () => {
      try {
        const { data } = await api.get(`/whatsapp/accounts/${account.session_id}/status`);
        if (stop) return;
        setState(data);
        if (data.status === "connected") {
          toast.success(`✅ WhatsApp ${data.phone || ""} terhubung!`);
          onConnected?.();
          onClose();
          return;
        }
      } catch (err) {
        if (!stop) toast.error(formatApiError(err));
      }
      if (!stop) timer.current = setTimeout(poll, 2000);
    };
    poll();
    return () => {
      stop = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, account?.session_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full my-auto max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="qr-modal">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <WhatsappLogo size={22} weight="fill" className="text-emerald-500" />
            <h3 className="font-bold text-slate-900">Scan QR untuk Connect WhatsApp</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100" data-testid="qr-modal-close">
            <X size={18} />
          </button>
        </div>
        <div className="p-6 text-center">
          {state?.qr ? (
            <>
              <img src={state.qr} alt="WA QR" className="mx-auto rounded-lg border border-slate-200" data-testid="qr-image" />
              <div className="mt-4 text-sm text-slate-600 space-y-1">
                <div>1. Buka <b>WhatsApp</b> di HP</div>
                <div>2. Menu <b>⋮ → Linked Devices → Link a Device</b></div>
                <div>3. Scan QR code di atas</div>
              </div>
              <div className="mt-4 text-[11px] text-slate-400">QR refresh otomatis tiap ~20 detik</div>
            </>
          ) : state?.status === "connecting" || state?.status === "init" ? (
            <div className="py-10">
              <ArrowsClockwise size={32} weight="bold" className="animate-spin text-indigo-500 mx-auto mb-2" />
              <div className="text-sm text-slate-600">Menyiapkan koneksi WhatsApp…</div>
            </div>
          ) : state?.status === "connected" ? (
            <div className="py-10">
              <CheckCircle size={48} weight="fill" className="text-emerald-500 mx-auto mb-3" />
              <div className="font-bold text-slate-900">Terhubung!</div>
              <div className="text-sm text-slate-600 mt-1">+{state.phone}</div>
            </div>
          ) : state?.status === "logged_out" ? (
            <div className="py-10 text-rose-600">
              <Warning size={32} weight="duotone" className="mx-auto mb-2" />
              <div className="text-sm">Logout dari HP. Hapus akun ini & buat baru.</div>
            </div>
          ) : (
            <div className="py-10 text-slate-500 text-sm">Memuat…</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main ───
export default function WhatsAppPage() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [activeSid, setActiveSid] = useState("");
  const [chats, setChats] = useState([]);
  const [chatsLoading, setChatsLoading] = useState(false);
  const [activeJid, setActiveJid] = useState("");
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [qrOpen, setQrOpen] = useState(false);
  const [qrAccount, setQrAccount] = useState(null);
  const [mediaUploading, setMediaUploading] = useState(false);
  const [health, setHealth] = useState(null);
  const messagesEnd = useRef(null);
  const lastChatSyncRef = useRef(null);
  const lastMsgSyncRef = useRef({});
  const fileInputRef = useRef(null);

  const activeAccount = useMemo(() => accounts.find((a) => a.session_id === activeSid), [accounts, activeSid]);
  const isOwnerView = activeAccount && activeAccount.user_id !== user?.id;

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/whatsapp/accounts");
      setAccounts(data);
      if (!activeSid && data.length > 0) {
        setActiveSid(data[0].session_id);
      }
    } catch (err) {
      if (err?.response?.status === 404) {
        toast.error(
          "Backend WhatsApp endpoint TIDAK ADA. Backend di VPS belum di-update. Jalankan `deploy` lagi.",
          { duration: 10000 }
        );
      } else {
        toast.error(formatApiError(err));
      }
    }
    finally { setLoading(false); }
  };

  const loadHealth = async () => {
    try {
      const { data } = await api.get("/whatsapp/health");
      setHealth(data);
    } catch (err) {
      if (err?.response?.status === 404) {
        setHealth({ backend: "outdated", wa_service: "unknown", wa_service_detail: "Backend belum di-deploy ulang setelah pull terbaru. Jalankan `deploy` di VPS." });
      } else {
        setHealth({ backend: "error", wa_service: "unknown", wa_service_detail: formatApiError(err) });
      }
    }
  };

  const loadChats = async (sid, opts = {}) => {
    if (!sid) return;
    const { delta = false } = opts;
    if (!delta) setChatsLoading(true);
    try {
      const params = { limit: 100 };
      if (delta && lastChatSyncRef.current) params.since_ts = lastChatSyncRef.current;
      const { data } = await api.get(`/whatsapp/accounts/${sid}/chats`, { params });
      if (delta && Array.isArray(data) && data.length === 0) {
        // no new chats — keep existing list
      } else if (delta && Array.isArray(data)) {
        // merge new/updated chats into existing list
        setChats((prev) => {
          const map = new Map(prev.map((c) => [c.jid, c]));
          for (const c of data) map.set(c.jid, c);
          return [...map.values()].sort((a, b) =>
            new Date(b.last_message_ts || b.updated_at || 0) -
            new Date(a.last_message_ts || a.updated_at || 0)
          );
        });
      } else {
        setChats(data);
      }
      lastChatSyncRef.current = new Date().toISOString();
    } catch (err) { if (!delta) toast.error(formatApiError(err)); }
    finally { if (!delta) setChatsLoading(false); }
  };

  const loadMessages = async (sid, jid, opts = {}) => {
    if (!sid || !jid) return;
    const { delta = false } = opts;
    if (!delta) setMessagesLoading(true);
    try {
      const params = { limit: 100 };
      if (delta && lastMsgSyncRef.current[jid]) params.since_ts = lastMsgSyncRef.current[jid];
      const { data } = await api.get(`/whatsapp/accounts/${sid}/chats/${encodeURIComponent(jid)}/messages`, { params });
      if (delta && Array.isArray(data)) {
        if (data.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.message_id));
            const newOnes = data.filter((m) => !seen.has(m.message_id));
            return [...prev, ...newOnes];
          });
        }
      } else {
        setMessages(data || []);
      }
      // Update last sync timestamp from the latest message we've seen
      const latestTs = (data && data.length > 0)
        ? data[data.length - 1].timestamp
        : null;
      if (latestTs) lastMsgSyncRef.current[jid] = latestTs;
      else if (!delta) lastMsgSyncRef.current[jid] = new Date().toISOString();
      // mark as read (best-effort, only on full load)
      if (!delta) {
        try { await api.post(`/whatsapp/accounts/${sid}/chats/${encodeURIComponent(jid)}/read`); } catch (_) { /* ignore */ }
      }
    } catch (err) { if (!delta) toast.error(formatApiError(err)); }
    finally { if (!delta) setMessagesLoading(false); }
  };

  useEffect(() => { loadAccounts(); loadHealth(); }, []); // eslint-disable-line
  useEffect(() => {
    if (activeSid) {
      lastChatSyncRef.current = null;
      lastMsgSyncRef.current = {};
      loadChats(activeSid);
    }
  }, [activeSid]); // eslint-disable-line
  useEffect(() => { if (activeSid && activeJid) loadMessages(activeSid, activeJid); }, [activeSid, activeJid]); // eslint-disable-line

  // Realtime feel via delta polling — incremental fetch by since_ts (tiny payloads).
  useEffect(() => {
    if (!activeSid) return;
    const t = setInterval(() => loadChats(activeSid, { delta: true }), 4000);
    return () => clearInterval(t);
  }, [activeSid]); // eslint-disable-line

  useEffect(() => {
    if (!activeSid || !activeJid) return;
    const t = setInterval(() => loadMessages(activeSid, activeJid, { delta: true }), 2500);
    return () => clearInterval(t);
  }, [activeSid, activeJid]); // eslint-disable-line

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, activeJid]);

  const handleAdd = async () => {
    try {
      const { data } = await api.post("/whatsapp/accounts", { label: null });
      toast.success("Akun WA dibuat. Scan QR untuk connect.");
      await loadAccounts();
      setQrAccount({ session_id: data.session_id });
      setQrOpen(true);
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        toast.error(
          "Backend belum mendukung WhatsApp. Cek 'WA Health' di bawah, lalu jalankan `deploy` di VPS.",
          { duration: 12000 }
        );
        loadHealth();
      } else if (status === 503) {
        toast.error(
          "WA Service tidak jalan. Setup supervisor config (/etc/supervisor/conf.d/hunter-wa-service.conf) + restart.",
          { duration: 12000 }
        );
        loadHealth();
      } else {
        toast.error(formatApiError(err));
      }
    }
  };

  const handleScanAgain = (acc) => {
    setQrAccount(acc);
    setQrOpen(true);
  };

  const handleDelete = async (acc) => {
    if (!confirm(`Hapus akun ${acc.phone || acc.label || "WA"} ini? Akan logout dari HP juga.`)) return;
    try {
      await api.delete(`/whatsapp/accounts/${acc.session_id}`);
      toast.success("Akun WA dihapus");
      if (activeSid === acc.session_id) {
        setActiveSid("");
        setActiveJid("");
        setMessages([]);
      }
      await loadAccounts();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const handleSend = async () => {
    if (!draft.trim() || !activeSid || !activeJid) return;
    const text = draft.trim();
    // Optimistic UI — show message immediately so user sees it without waiting for poll
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticMsg = {
      message_id: optimisticId,
      jid: activeJid,
      from_me: true,
      text,
      timestamp: new Date().toISOString(),
      _optimistic: true,
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setDraft("");
    setSending(true);
    try {
      await api.post(
        `/whatsapp/accounts/${activeSid}/chats/${encodeURIComponent(activeJid)}/messages`,
        { text }
      );
      // Re-fetch full list (will replace optimistic with real persisted message via same JID)
      setTimeout(() => {
        // Full reload (not delta) so we drop optimistic & get the real persisted row with proper id
        loadMessages(activeSid, activeJid);
      }, 800);
    } catch (err) {
      // Roll back optimistic on failure
      setMessages((prev) => prev.filter((m) => m.message_id !== optimisticId));
      setDraft(text);
      toast.error(formatApiError(err));
    }
    finally { setSending(false); }
  };

  const handleFilePick = () => fileInputRef.current?.click();

  const handleFileSelected = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting same file
    if (!file || !activeSid || !activeJid) return;
    if (file.size > 50 * 1024 * 1024) {
      toast.error("File terlalu besar (max 50MB)");
      return;
    }
    setMediaUploading(true);
    try {
      const buf = await file.arrayBuffer();
      // base64 encode (chunked to avoid stack overflow on large files)
      const bytes = new Uint8Array(buf);
      let binary = "";
      const chunk = 32768;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      const base64 = btoa(binary);
      const kind = file.type.startsWith("image/")
        ? "image"
        : file.type.startsWith("video/")
        ? "video"
        : file.type.startsWith("audio/")
        ? "audio"
        : "document";
      await api.post(
        `/whatsapp/accounts/${activeSid}/chats/${encodeURIComponent(activeJid)}/media`,
        {
          kind,
          base64,
          mimetype: file.type || null,
          file_name: file.name,
          caption: draft.trim() || null,
        }
      );
      setDraft("");
      toast.success(`📎 ${kind} terkirim: ${file.name}`);
      setTimeout(() => loadMessages(activeSid, activeJid, { delta: true }), 800);
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setMediaUploading(false);
    }
  };

  const ownAccountsCount = accounts.filter((a) => a.user_id === user?.id).length;
  const canAdd = ownAccountsCount < 3;

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="WhatsApp"
        subtitle={`Multi-account via Baileys · max 3 akun per user${user?.role === "Owner" ? " · (Owner sees all in tenant)" : ""}`}
        action={
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => { loadAccounts(); loadHealth(); }} disabled={loading} data-testid="wa-refresh">
              <ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} /> Refresh
            </GhostButton>
            <PrimaryButton onClick={handleAdd} disabled={!canAdd} data-testid="wa-add-account" title={!canAdd ? "Sudah max 3 akun" : ""}>
              <Plus size={14} weight="bold" /> Add WhatsApp
            </PrimaryButton>
          </div>
        }
      />

      {health && (health.wa_service !== "ok" || health.backend !== "ok") && (
        <div
          className="mb-4 rounded-lg border-2 border-rose-200 bg-rose-50 p-4"
          data-testid="wa-health-banner"
        >
          <div className="flex items-start gap-3">
            <Warning size={22} weight="fill" className="text-rose-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-rose-900 mb-1">WhatsApp Service tidak siap</div>
              <div className="text-sm text-rose-800 mb-2">
                <b>Backend:</b> {health.backend === "ok" ? "✓ OK" : `✗ ${health.backend}`} ·{" "}
                <b>WA Service:</b> {health.wa_service === "ok" ? "✓ OK" : `✗ ${health.wa_service}`}
              </div>
              {health.wa_service_detail && (
                <div className="text-xs text-rose-700 mb-2 font-mono break-words bg-rose-100 p-2 rounded">
                  {health.wa_service_detail}
                </div>
              )}
              <details className="text-xs text-rose-800">
                <summary className="cursor-pointer font-semibold">📖 Cara fix (klik untuk expand)</summary>
                <div className="mt-2 space-y-2 pl-3">
                  <div className="font-semibold text-rose-900">SSH ke VPS, jalankan SATU perintah ini:</div>
                  <pre className="bg-slate-900 text-emerald-300 p-3 rounded text-[11px] overflow-x-auto font-mono">
{`cd /var/www/hunter.elexart.com && sudo bash wa-setup.sh`}
                  </pre>
                  <div className="text-rose-700 mt-1">
                    Script otomatis: pull code, install deps, generate secret, setup supervisor, restart backend + wa-service, & verify.
                    <b> Idempotent</b> — aman dijalankan ulang.
                  </div>

                  <div className="font-semibold text-rose-900 mt-4">⚠️ Kalau wa-setup.sh udah jalan tapi MASIH error:</div>
                  <div className="text-rose-700 mt-1 mb-1">Backend di VPS mungkin spawn-error (Python venv rusak, dll). Jalankan diagnostic:</div>
                  <pre className="bg-slate-900 text-emerald-300 p-3 rounded text-[11px] overflow-x-auto font-mono">
{`cd /var/www/hunter.elexart.com && bash wa-doctor.sh`}
                  </pre>
                  <div className="text-rose-700 mt-1">
                    Script ini cuma <b>baca</b> (tidak modify). Screenshot output-nya, kirim ke saya supaya bisa diagnose exact error-nya.
                  </div>

                  <div className="font-semibold text-rose-900 mt-4">Common fix backend spawn-error:</div>
                  <pre className="bg-slate-900 text-emerald-300 p-3 rounded text-[11px] overflow-x-auto font-mono">
{`# Rebuild Python venv
cd /var/www/hunter.elexart.com/backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
sudo supervisorctl restart hunter-backend`}
                  </pre>
                </div>
              </details>
            </div>
          </div>
        </div>
      )}

      {accounts.length === 0 ? (
        <EmptyState
          icon={WhatsappLogo}
          title="Belum ada akun WhatsApp"
          description="Klik 'Add WhatsApp' untuk scan QR code dan hubungkan WA pertama Anda. Maks 3 akun per user."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px,320px,1fr] gap-3">
          {/* Account list (left rail) */}
          <Card className="!p-2 lg:max-h-[78vh] lg:overflow-y-auto">
            <div className="text-[11px] uppercase font-bold text-slate-500 px-2 py-1.5">Akun</div>
            {accounts.map((acc) => {
              const sb = statusBadge(acc.live_status || acc.status);
              const isOther = acc.user_id !== user?.id;
              return (
                <div
                  key={acc.session_id}
                  className={`group rounded-lg p-2 mb-1 cursor-pointer flex items-start gap-2 transition-all ${
                    activeSid === acc.session_id
                      ? "bg-emerald-50 border border-emerald-200"
                      : "hover:bg-slate-50 border border-transparent"
                  }`}
                  onClick={() => { setActiveSid(acc.session_id); setActiveJid(""); }}
                  data-testid={`wa-account-${acc.session_id}`}
                >
                  <WhatsappLogo size={20} weight="fill" className="text-emerald-500 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {acc.phone ? `+${acc.phone}` : acc.label || "Pending"}
                      </div>
                      {isOther && (
                        <Badge tone="warning" className="!text-[9px]">
                          <Eye size={9} weight="bold" /> {acc.user_id?.slice(0, 4)}
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">{acc.name || acc.label || "—"}</div>
                    <div className="mt-1">
                      <Badge tone={sb.tone} className="!text-[10px]">{sb.label}</Badge>
                    </div>
                  </div>
                  <div className="opacity-0 group-hover:opacity-100 transition flex flex-col gap-1">
                    {(acc.live_status === "qr" || acc.live_status === "logged_out") && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleScanAgain(acc); }}
                        className="p-1 rounded hover:bg-emerald-100 text-emerald-600"
                        title="Scan QR"
                        data-testid={`wa-rescan-${acc.session_id}`}
                      >
                        <Phone size={14} weight="bold" />
                      </button>
                    )}
                    {!isOther && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDelete(acc); }}
                        className="p-1 rounded hover:bg-rose-100 text-rose-600"
                        title="Hapus akun"
                        data-testid={`wa-delete-${acc.session_id}`}
                      >
                        <Trash size={14} weight="bold" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            <div className="text-[10px] text-slate-400 px-2 pt-2 border-t border-slate-100">
              {ownAccountsCount}/3 akun milik Anda
            </div>
          </Card>

          {/* Chat list (middle) */}
          <Card className="!p-0 lg:max-h-[78vh] flex flex-col">
            <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 text-xs text-slate-600 flex items-center justify-between">
              <span className="font-semibold">Chats</span>
              {isOwnerView && <Badge tone="warning" className="!text-[9px]"><ShieldCheck size={9} weight="bold" /> Monitoring</Badge>}
            </div>
            <div className="flex-1 overflow-y-auto">
              {chatsLoading ? (
                <div className="p-6 text-center text-sm text-slate-500">Memuat chats…</div>
              ) : chats.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">
                  {activeAccount?.live_status === "connected" ? "Belum ada chat. Tunggu pesan masuk." : "Akun belum connect. Scan QR dulu."}
                </div>
              ) : (
                chats.map((c) => (
                  <button
                    key={c.jid}
                    onClick={() => setActiveJid(c.jid)}
                    data-testid={`wa-chat-${c.jid}`}
                    className={`w-full text-left p-3 hover:bg-slate-50 flex items-start gap-2 transition-colors border-b border-slate-100 ${
                      activeJid === c.jid ? "bg-emerald-50" : (c.unread_count > 0 ? "bg-emerald-50/30" : "")
                    }`}
                  >
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                      c.is_group || c.jid?.includes("@g.us") ? "bg-emerald-100 text-emerald-700" : "bg-slate-200"
                    }`}>
                      {c.is_group || c.jid?.includes("@g.us") ? <UsersThree size={16} weight="bold" /> : <User size={16} weight="bold" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <div className="text-sm font-semibold text-slate-900 truncate flex-1 font-mono" data-testid={`wa-chat-name-${c.jid}`}>
                          {jidName(c.jid, c.name)}
                          {(c.is_group || c.jid?.includes("@g.us")) && c.group_size > 0 && (
                            <span className="ml-1 text-[10px] text-emerald-600 font-normal">({c.group_size})</span>
                          )}
                        </div>
                        <span className="text-[10px] text-slate-500 shrink-0">{fmtTime(c.last_message_ts)}</span>
                      </div>
                      {/* Show push-name / alias as secondary, smaller, italic — never primary */}
                      {!c.is_group && !c.jid?.includes("@g.us") && c.name && (
                        <div className="text-[10px] text-slate-500 italic truncate -mt-0.5" data-testid={`wa-chat-alias-${c.jid}`}>
                          ~{c.name}
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <div className="text-xs text-slate-600 truncate flex-1">
                          {c.last_from_me ? <span className="text-slate-400">✓ </span> : null}
                          {c.last_message || "(no preview)"}
                        </div>
                        {c.unread_count > 0 && (
                          <span className="bg-emerald-500 text-white rounded-full text-[10px] px-1.5 py-0.5 font-bold shrink-0">
                            {c.unread_count}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </Card>

          {/* Messages (right) */}
          <Card className="!p-0 lg:max-h-[78vh] flex flex-col">
            {!activeJid ? (
              <div className="flex-1 flex items-center justify-center text-sm text-slate-500 p-8">
                <div className="text-center">
                  <ChatCircleDots size={40} weight="duotone" className="text-slate-300 mx-auto mb-2" />
                  Pilih chat untuk baca pesan
                </div>
              </div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2 text-sm">
                  <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center">
                    <User size={14} weight="bold" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-900 truncate font-mono" data-testid="wa-active-header">{jidName(activeJid)}</div>
                    {isLidOnly(activeJid) && (
                      <div className="text-[10px] text-amber-700 italic -mt-0.5">
                        Nomor asli disembunyikan (WhatsApp privacy) — reply mereka akan masuk ke chat thread baru otomatis bila sudah pernah balas
                      </div>
                    )}
                    {(() => {
                      const c = chats.find((x) => x.jid === activeJid);
                      const alias = c?.name;
                      const isGroup = c?.is_group || activeJid?.includes("@g.us");
                      if (!alias || isGroup || isLidOnly(activeJid)) return null;
                      return <div className="text-[10px] text-slate-500 italic truncate -mt-0.5">~{alias}</div>;
                    })()}
                  </div>
                  {isOwnerView && <Badge tone="warning" className="!text-[9px]">View-only</Badge>}
                </div>
                <div className="flex-1 overflow-y-auto p-4 bg-slate-50/50 space-y-2">
                  {messagesLoading && messages.length === 0 ? (
                    <div className="text-center text-sm text-slate-500 py-8">Memuat pesan…</div>
                  ) : messages.length === 0 ? (
                    <div className="text-center text-sm text-slate-500 py-8">Belum ada pesan</div>
                  ) : (
                    messages.map((m) => {
                      const mt = m.media?.media_type;
                      const mediaLabel = mt === "image" ? "🖼️ Gambar"
                        : mt === "video" ? "🎬 Video"
                        : mt === "audio" ? "🎵 Audio"
                        : mt === "document" ? `📎 ${m.media?.file_name || "Dokumen"}`
                        : mt === "sticker" ? "🎟️ Sticker"
                        : null;
                      return (
                        <div key={m.message_id} className={`flex ${m.from_me ? "justify-end" : "justify-start"}`} data-testid={`wa-msg-${m.message_id}`}>
                          <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                            m.from_me ? "bg-emerald-500 text-white" : "bg-white text-slate-900 border border-slate-200"
                          }`}>
                            {/* For GROUP chats only: show sender phone (not push_name alias) */}
                            {!m.from_me && (activeJid?.includes("@g.us")) && m.sender_jid && (
                              <div className={`text-[10px] font-bold mb-0.5 font-mono ${m.from_me ? "text-emerald-100" : "text-emerald-600"}`} data-testid={`wa-msg-sender-${m.message_id}`}>
                                {formatPhone(m.sender_jid)}
                              </div>
                            )}
                            {mediaLabel && (
                              <div className={`text-xs font-semibold mb-1 px-2 py-1 rounded ${
                                m.from_me ? "bg-emerald-600/30" : "bg-slate-100"
                              }`}>
                                {mediaLabel}
                                {m.media?.file_length > 0 && (
                                  <span className={`ml-2 text-[10px] ${m.from_me ? "text-emerald-100" : "text-slate-500"}`}>
                                    {(m.media.file_length / 1024).toFixed(1)} KB
                                  </span>
                                )}
                              </div>
                            )}
                            {(m.text || (m.media && m.media.caption)) && (
                              <div className="whitespace-pre-wrap break-words">
                                {m.text || m.media?.caption}
                              </div>
                            )}
                            <div className={`text-[9px] mt-0.5 text-right ${m.from_me ? "text-emerald-100" : "text-slate-400"}`}>
                              {fmtTime(m.timestamp)}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEnd} />
                </div>
                {!isOwnerView ? (
                  <div className="border-t border-slate-200 p-2 flex items-end gap-2 bg-white">
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleFileSelected}
                      accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
                      data-testid="wa-file-input"
                    />
                    <button
                      onClick={handleFilePick}
                      disabled={mediaUploading || sending}
                      className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-50 transition"
                      title="Lampirkan media (gambar/dokumen/video, max 50MB)"
                      data-testid="wa-attach-btn"
                    >
                      <Paperclip size={18} weight="bold" className={mediaUploading ? "animate-pulse" : ""} />
                    </button>
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
                      }}
                      rows={1}
                      placeholder={mediaUploading ? "Uploading…" : "Tulis pesan… (Enter untuk kirim, klip untuk attach file)"}
                      className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-emerald-400"
                      data-testid="wa-message-input"
                      disabled={mediaUploading}
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || mediaUploading || !draft.trim()}
                      className="bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-300 text-white p-2 rounded-lg transition"
                      data-testid="wa-send-btn"
                    >
                      <PaperPlaneRight size={18} weight="fill" />
                    </button>
                  </div>
                ) : (
                  <div className="border-t border-slate-200 p-3 bg-amber-50 text-amber-800 text-xs text-center">
                    <ShieldCheck size={12} weight="bold" className="inline mb-0.5" /> Owner view-only — tidak bisa kirim pesan dari WA user lain
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      )}

      <QrModal
        open={qrOpen}
        account={qrAccount}
        onClose={() => setQrOpen(false)}
        onConnected={loadAccounts}
      />
    </div>
  );
}
