import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  WhatsappLogo, Plus, Trash, Eye, ArrowsClockwise, X, PaperPlaneRight,
  ChatCircleDots, Phone, User, ShieldCheck, Warning, CheckCircle, DotsThreeVertical,
} from "@phosphor-icons/react";
import { toast } from "sonner";

// ─── Helpers ───
function jidName(jid, fallback) {
  if (!jid) return fallback || "Unknown";
  if (jid.includes("@g.us")) return fallback || "Group";
  const num = jid.split("@")[0];
  return fallback || (num.startsWith("+") ? num : "+" + num);
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
  const messagesEnd = useRef(null);

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
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  const loadChats = async (sid) => {
    if (!sid) return;
    setChatsLoading(true);
    try {
      const { data } = await api.get(`/whatsapp/accounts/${sid}/chats`, { params: { limit: 100 } });
      setChats(data);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setChatsLoading(false); }
  };

  const loadMessages = async (sid, jid) => {
    if (!sid || !jid) return;
    setMessagesLoading(true);
    try {
      const { data } = await api.get(`/whatsapp/accounts/${sid}/chats/${encodeURIComponent(jid)}/messages`, { params: { limit: 100 } });
      setMessages(data);
      // mark as read (best-effort)
      try { await api.post(`/whatsapp/accounts/${sid}/chats/${encodeURIComponent(jid)}/read`); } catch (_) { /* ignore */ }
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setMessagesLoading(false); }
  };

  useEffect(() => { loadAccounts(); }, []); // eslint-disable-line
  useEffect(() => { if (activeSid) loadChats(activeSid); }, [activeSid]); // eslint-disable-line
  useEffect(() => { if (activeSid && activeJid) loadMessages(activeSid, activeJid); }, [activeSid, activeJid]); // eslint-disable-line

  // Auto-poll chats every 8s + messages every 5s (lightweight refresh)
  useEffect(() => {
    if (!activeSid) return;
    const t = setInterval(() => loadChats(activeSid), 8000);
    return () => clearInterval(t);
  }, [activeSid]); // eslint-disable-line

  useEffect(() => {
    if (!activeSid || !activeJid) return;
    const t = setInterval(() => loadMessages(activeSid, activeJid), 5000);
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
    } catch (err) { toast.error(formatApiError(err)); }
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
    setSending(true);
    try {
      await api.post(
        `/whatsapp/accounts/${activeSid}/chats/${encodeURIComponent(activeJid)}/messages`,
        { text: draft.trim() }
      );
      setDraft("");
      // optimistic refresh
      setTimeout(() => loadMessages(activeSid, activeJid), 500);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSending(false); }
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
            <GhostButton onClick={loadAccounts} disabled={loading} data-testid="wa-refresh">
              <ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} /> Refresh
            </GhostButton>
            <PrimaryButton onClick={handleAdd} disabled={!canAdd} data-testid="wa-add-account" title={!canAdd ? "Sudah max 3 akun" : ""}>
              <Plus size={14} weight="bold" /> Add WhatsApp
            </PrimaryButton>
          </div>
        }
      />

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
                    <div className="w-9 h-9 rounded-full bg-slate-200 flex items-center justify-center shrink-0">
                      {c.jid?.includes("@g.us") ? <ChatCircleDots size={16} weight="bold" /> : <User size={16} weight="bold" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <div className="text-sm font-semibold text-slate-900 truncate flex-1">{jidName(c.jid, c.name)}</div>
                        <span className="text-[10px] text-slate-500 shrink-0">{fmtTime(c.last_message_ts)}</span>
                      </div>
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
                  <div className="font-semibold text-slate-900 flex-1 truncate">{jidName(activeJid)}</div>
                  {isOwnerView && <Badge tone="warning" className="!text-[9px]">View-only</Badge>}
                </div>
                <div className="flex-1 overflow-y-auto p-4 bg-slate-50/50 space-y-2">
                  {messagesLoading && messages.length === 0 ? (
                    <div className="text-center text-sm text-slate-500 py-8">Memuat pesan…</div>
                  ) : messages.length === 0 ? (
                    <div className="text-center text-sm text-slate-500 py-8">Belum ada pesan</div>
                  ) : (
                    messages.map((m) => (
                      <div key={m.message_id} className={`flex ${m.from_me ? "justify-end" : "justify-start"}`} data-testid={`wa-msg-${m.message_id}`}>
                        <div className={`max-w-[75%] rounded-lg px-3 py-2 text-sm shadow-sm ${
                          m.from_me ? "bg-emerald-500 text-white" : "bg-white text-slate-900 border border-slate-200"
                        }`}>
                          {!m.from_me && m.push_name && (
                            <div className={`text-[10px] font-bold mb-0.5 ${m.from_me ? "text-emerald-100" : "text-emerald-600"}`}>
                              {m.push_name}
                            </div>
                          )}
                          <div className="whitespace-pre-wrap break-words">{m.text || "(media/attachment)"}</div>
                          <div className={`text-[9px] mt-0.5 text-right ${m.from_me ? "text-emerald-100" : "text-slate-400"}`}>
                            {fmtTime(m.timestamp)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                  <div ref={messagesEnd} />
                </div>
                {!isOwnerView ? (
                  <div className="border-t border-slate-200 p-2 flex items-end gap-2 bg-white">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
                      }}
                      rows={1}
                      placeholder="Tulis pesan… (Enter untuk kirim, Shift+Enter untuk newline)"
                      className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-emerald-400"
                      data-testid="wa-message-input"
                    />
                    <button
                      onClick={handleSend}
                      disabled={sending || !draft.trim()}
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
