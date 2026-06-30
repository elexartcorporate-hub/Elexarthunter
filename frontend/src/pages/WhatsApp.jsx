import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  WhatsappLogo, Plus, Trash, Eye, ArrowsClockwise, X, PaperPlaneRight,
  ChatCircleDots, Phone, User, ShieldCheck, Warning, CheckCircle,
  Paperclip, UsersThree, Gear, UserPlus, Users, Tag,
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

// ─── Confirm Delete Modal (replaces browser confirm() that gets blocked on some platforms) ───
function ConfirmDeleteModal({ open, onClose, account, onConfirm }) {
  const [deleting, setDeleting] = useState(false);
  if (!open || !account) return null;
  const handleConfirm = async () => {
    setDeleting(true);
    try { await onConfirm(account); } finally { setDeleting(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-sm w-full my-auto" onClick={(e) => e.stopPropagation()} data-testid="wa-confirm-delete-modal">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center gap-2">
          <Warning size={20} weight="fill" className="text-rose-500" />
          <h3 className="font-bold text-slate-900">Hapus Koneksi WhatsApp?</h3>
        </div>
        <div className="p-5 space-y-2 text-sm">
          <div className="text-slate-700">
            Yakin hapus koneksi <b>{account.label || (account.phone ? `+${account.phone}` : "Pending")}</b>?
          </div>
          <div className="text-xs text-rose-700 bg-rose-50 rounded p-2">
            ⚠️ Akun akan <b>logout dari HP</b>, semua chat & history terhapus, dan assignment ke user lain juga dibatalkan.
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <GhostButton onClick={onClose} disabled={deleting}>Batal</GhostButton>
          <button
            onClick={handleConfirm}
            disabled={deleting}
            className="bg-rose-500 hover:bg-rose-600 disabled:bg-slate-300 text-white text-sm font-semibold rounded-lg px-4 py-2"
            data-testid="wa-confirm-delete-btn"
          >
            {deleting ? "Menghapus…" : "Hapus"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Connection Settings Modal (rename + default assignee) ───
function ConnectionSettingsModal({ open, onClose, account, teamMembers, onSaved }) {
  const [label, setLabel] = useState("");
  const [defaultUserId, setDefaultUserId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setLabel(account?.label || "");
      setDefaultUserId(account?.default_assigned_user_id || "");
    }
  }, [open, account?.session_id]); // eslint-disable-line
  if (!open || !account) return null;
  const handleSave = async () => {
    setSaving(true);
    try {
      await api.patch(`/whatsapp/accounts/${account.session_id}`, {
        label: label.trim() || null,
        default_assigned_user_id: defaultUserId || null,
      });
      toast.success(
        defaultUserId
          ? "Setting tersimpan. Chat masuk akan otomatis di-route ke user yang dipilih."
          : "Setting tersimpan."
      );
      onSaved?.();
      onClose();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 405 || status === 404) {
        toast.error(
          "Backend di VPS belum punya endpoint setting koneksi ini. Jalankan `deploy` di VPS untuk update backend.",
          { duration: 10000 }
        );
      } else {
        toast.error(formatApiError(err));
      }
    } finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full my-auto" onClick={(e) => e.stopPropagation()} data-testid="wa-settings-modal">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <Gear size={20} weight="bold" className="text-indigo-500" />
            <h3 className="font-bold text-slate-900">Setting Koneksi WhatsApp</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="text-xs text-slate-500">
            Nomor: <span className="font-mono font-semibold text-slate-700">+{account.phone || "—"}</span>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Nama / Label Koneksi</label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Contoh: CS Bali, Sales Jakarta, Admin Pusat"
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
              maxLength={64}
              data-testid="wa-settings-label-input"
            />
            <div className="text-[10px] text-slate-400 mt-1">Label memudahkan tim mengenali fungsi koneksi.</div>
          </div>

          <div className="border-t border-slate-100 pt-3">
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              <UserPlus size={11} weight="bold" className="inline mr-1" />
              Assign Otomatis ke User (Default Penerima Chat)
            </label>
            <select
              value={defaultUserId}
              onChange={(e) => setDefaultUserId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
              data-testid="wa-settings-default-user"
            >
              <option value="">— Tidak ada (chat tetap di pemilik koneksi) —</option>
              {teamMembers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name || u.email} ({u.role})
                </option>
              ))}
            </select>
            <div className="text-[10px] text-slate-400 mt-1">
              Semua chat masuk dari koneksi ini akan <b>otomatis</b> di-route ke user yang dipilih.
              Mereka akan melihatnya di tab <b>Inbox Tim</b> dan bisa membalas pakai koneksi ini.
            </div>
            {account?.default_assigned_user_name && account.default_assigned_user_id === defaultUserId && (
              <div className="mt-2 text-[11px] text-emerald-700 bg-emerald-50 rounded px-2 py-1 flex items-center gap-1">
                <CheckCircle size={11} weight="fill" /> Saat ini di-route ke: <b>{account.default_assigned_user_name}</b>
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <GhostButton onClick={onClose} disabled={saving}>Batal</GhostButton>
          <PrimaryButton onClick={handleSave} disabled={saving} data-testid="wa-settings-save">
            {saving ? "Menyimpan…" : "Simpan"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// ─── Assign Chat to User Modal ───
function AssignChatModal({ open, onClose, sessionId, jid, currentAssignment, teamMembers, onSaved }) {
  const [targetUserId, setTargetUserId] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setTargetUserId(currentAssignment?.assigned_user_id || "");
  }, [open, jid]); // eslint-disable-line
  if (!open) return null;
  const handleSave = async () => {
    if (!targetUserId) { toast.error("Pilih user tujuan"); return; }
    setSaving(true);
    try {
      await api.post(
        `/whatsapp/accounts/${sessionId}/chats/${encodeURIComponent(jid)}/assign`,
        { user_id: targetUserId }
      );
      toast.success("Chat berhasil di-assign");
      onSaved?.();
      onClose();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };
  const handleUnassign = async () => {
    setSaving(true);
    try {
      await api.delete(`/whatsapp/accounts/${sessionId}/chats/${encodeURIComponent(jid)}/assign`);
      toast.success("Assignment dihapus");
      onSaved?.();
      onClose();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-start sm:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full my-auto" onClick={(e) => e.stopPropagation()} data-testid="wa-assign-modal">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <UserPlus size={20} weight="bold" className="text-indigo-500" />
            <h3 className="font-bold text-slate-900">Assign Chat ke User</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div className="text-xs text-slate-500">
            Chat: <span className="font-mono font-semibold text-slate-700">{jid}</span>
          </div>
          {currentAssignment ? (
            <div className="rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2 text-xs">
              <div className="font-semibold text-indigo-900">Saat ini di-assign ke:</div>
              <div className="text-indigo-700 mt-0.5">{currentAssignment.assigned_user_name}</div>
            </div>
          ) : null}
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Pilih User Sales/CS</label>
            <select
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
              data-testid="wa-assign-select"
            >
              <option value="">— Pilih user —</option>
              {teamMembers.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email} ({u.role})</option>
              ))}
            </select>
            <div className="text-[10px] text-slate-400 mt-1">
              User akan melihat chat ini di tab <b>Inbox Tim</b> dan bisa membalas pakai koneksi ini.
            </div>
          </div>
        </div>
        <div className="flex justify-between gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          {currentAssignment ? (
            <button
              onClick={handleUnassign}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded-lg text-rose-600 hover:bg-rose-50 font-semibold"
              data-testid="wa-assign-remove"
            >Hapus Assignment</button>
          ) : <span />}
          <div className="flex gap-2">
            <GhostButton onClick={onClose} disabled={saving}>Batal</GhostButton>
            <PrimaryButton onClick={handleSave} disabled={saving || !targetUserId} data-testid="wa-assign-save">
              {saving ? "Menyimpan…" : "Assign"}
            </PrimaryButton>
          </div>
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
  const [tab, setTab] = useState("own"); // "own" | "inbox"
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameAccount, setRenameAccount] = useState(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignJid, setAssignJid] = useState("");
  const [teamMembers, setTeamMembers] = useState([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteAccount, setDeleteAccount] = useState(null);
  // Backend feature support — detect if VPS backend has the new PATCH/assign endpoints
  const [backendSupport, setBackendSupport] = useState({ patch: null, assign: null });
  const messagesEnd = useRef(null);
  const lastChatSyncRef = useRef(null);
  const lastMsgSyncRef = useRef({});
  const fileInputRef = useRef(null);

  const activeAccount = useMemo(() => accounts.find((a) => a.session_id === activeSid), [accounts, activeSid]);
  const isAdmin = user?.role === "Owner" || user?.role === "Admin";
  const isAccountOwner = activeAccount && activeAccount.user_id === user?.id;
  const isAssignedInbox = activeAccount?.is_assigned_inbox;
  // Read-only when viewing someone else's account without assigned chats (Owner/Admin monitoring)
  const isMonitorView = activeAccount && !isAccountOwner && !isAssignedInbox;

  // Partition accounts by tab
  const ownAccounts = useMemo(() => accounts.filter((a) => !a.is_assigned_inbox), [accounts]);
  const inboxAccounts = useMemo(() => accounts.filter((a) => a.is_assigned_inbox), [accounts]);
  const visibleAccounts = tab === "own" ? ownAccounts : inboxAccounts;

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/whatsapp/accounts");
      setAccounts(data);
      // Auto-select first visible account based on current tab
      const initialList = (tab === "own")
        ? data.filter((a) => !a.is_assigned_inbox)
        : data.filter((a) => a.is_assigned_inbox);
      if (!activeSid && initialList.length > 0) {
        setActiveSid(initialList[0].session_id);
      } else if (activeSid && !data.find((a) => a.session_id === activeSid)) {
        // Active account no longer accessible — reset
        setActiveSid(initialList[0]?.session_id || "");
        setActiveJid("");
        setMessages([]);
      }
      // Probe backend support for new endpoints (only once we have a sample sid)
      if (data.length > 0 && backendSupport.patch === null) {
        detectBackendSupport(data[0].session_id);
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

  const loadTeamMembers = async () => {
    if (!isAdmin) return;
    try {
      const { data } = await api.get("/team");
      // Exclude self from the assign list (you can't assign to yourself meaningfully — but keep it for flexibility)
      setTeamMembers(data || []);
    } catch (_) { /* ignore */ }
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

  // Detect if backend supports the new endpoints (PATCH account + assign chat).
  // We do an OPTIONS-like probe by attempting a no-op PATCH with empty body to a fake sid
  // — but the safer way is to look at /api/openapi.json or hit a sentinel endpoint.
  // Simplest reliable approach: call PATCH with no body to a real account and see what status returns.
  // 405 = endpoint missing. 422/400 = endpoint exists. 404 = sid not found.
  const detectBackendSupport = async (sampleSid) => {
    if (!sampleSid) return;
    try {
      // Send empty PATCH — if endpoint exists, backend returns 200/422; if not, 405.
      await api.patch(`/whatsapp/accounts/${sampleSid}`, {});
      setBackendSupport((s) => ({ ...s, patch: true }));
    } catch (err) {
      const status = err?.response?.status;
      if (status === 405 || status === 404) {
        setBackendSupport((s) => ({ ...s, patch: false }));
      } else {
        // 400/422/403 means endpoint exists but request was invalid → supported
        setBackendSupport((s) => ({ ...s, patch: true }));
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
      // Optimistic messages must NEVER vanish until their real counterpart actually arrives.
      // Strategy: always keep optimistic in state; only swap when a real persisted message
      // with matching text + from_me + within 90s window appears.
      const matchesOptimistic = (real, opt) =>
        real.from_me &&
        (real.text || "").trim() === (opt.text || "").trim() &&
        Math.abs(new Date(real.timestamp).getTime() - new Date(opt.timestamp).getTime()) < 90000;

      if (delta && Array.isArray(data)) {
        if (data.length > 0) {
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.message_id));
            const newOnes = data.filter((m) => !seen.has(m.message_id));
            // Replace optimistic in place when matching real arrives
            const merged = prev.map((m) => {
              if (!m._optimistic) return m;
              const real = newOnes.find((n) => matchesOptimistic(n, m));
              return real ? real : m;
            });
            // Append remaining new messages that didn't replace any optimistic
            const replacedIds = new Set(
              merged.filter((m) => !m._optimistic && data.find((d) => d.message_id === m.message_id))
                .map((m) => m.message_id)
            );
            const toAppend = newOnes.filter((n) => !replacedIds.has(n.message_id));
            return [...merged, ...toAppend];
          });
        }
      } else {
        // Full load — preserve any optimistic messages still pending
        setMessages((prev) => {
          const pending = prev.filter((m) => m._optimistic);
          const dataList = data || [];
          if (!pending.length) return dataList;
          // Drop optimistic whose real counterpart appears in fresh data
          const stillPending = pending.filter(
            (m) => !dataList.find((n) => matchesOptimistic(n, m))
          );
          return [...dataList, ...stillPending];
        });
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

  useEffect(() => { loadAccounts(); loadHealth(); loadTeamMembers(); }, []); // eslint-disable-line

  // Reset active selection when switching tabs
  useEffect(() => {
    const list = tab === "own" ? ownAccounts : inboxAccounts;
    const stillVisible = list.find((a) => a.session_id === activeSid);
    if (!stillVisible) {
      setActiveSid(list[0]?.session_id || "");
      setActiveJid("");
      setMessages([]);
    }
  }, [tab, accounts.length]); // eslint-disable-line
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
    try {
      await api.delete(`/whatsapp/accounts/${acc.session_id}`);
      toast.success("Akun WA dihapus");
      // Optimistic removal: drop from list immediately so user sees instant feedback,
      // even if loadAccounts is slow or polling hasn't refreshed yet.
      setAccounts((prev) => prev.filter((a) => a.session_id !== acc.session_id));
      if (activeSid === acc.session_id) {
        setActiveSid("");
        setActiveJid("");
        setMessages([]);
        setChats([]);
      }
      // Fetch fresh list (in case of any cleanup discrepancies)
      setTimeout(() => loadAccounts(), 500);
      setDeleteOpen(false);
      setDeleteAccount(null);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const askDelete = (acc) => {
    setDeleteAccount(acc);
    setDeleteOpen(true);
  };

  const handleSend = async () => {
    if (!draft.trim() || !activeSid || !activeJid) return;
    const text = draft.trim();
    const optimisticId = `optimistic-${Date.now()}`;
    const optimisticMsg = {
      message_id: optimisticId,
      jid: activeJid,
      from_me: true,
      text,
      timestamp: new Date().toISOString(),
      _optimistic: true,
      _sending: true,
    };
    setMessages((prev) => [...prev, optimisticMsg]);
    setDraft("");
    setSending(true);
    try {
      await api.post(
        `/whatsapp/accounts/${activeSid}/chats/${encodeURIComponent(activeJid)}/messages`,
        { text }
      );
      // Mark as 'sent to server' — real persisted message will replace this via delta polling
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === optimisticId ? { ...m, _sending: false } : m
        )
      );
    } catch (err) {
      // Mark as failed (keep visible so user knows it didn't go through)
      setMessages((prev) =>
        prev.map((m) =>
          m.message_id === optimisticId ? { ...m, _sending: false, _failed: true } : m
        )
      );
      setDraft(text);
      toast.error(formatApiError(err));
    }
    finally { setSending(false); }
  };

  const retrySend = async (msg) => {
    // Remove the failed optimistic and re-send via handleSend
    setMessages((prev) => prev.filter((m) => m.message_id !== msg.message_id));
    setDraft(msg.text);
    // Defer to next tick so draft state updates first
    setTimeout(() => handleSend(), 0);
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
      // Delta polling will fetch the real persisted media message shortly.
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

      {backendSupport.patch === false && (
        <div
          className="mb-4 rounded-lg border-2 border-amber-300 bg-amber-50 p-4"
          data-testid="wa-outdated-backend-banner"
        >
          <div className="flex items-start gap-3">
            <Warning size={22} weight="fill" className="text-amber-600 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-bold text-amber-900 mb-1">
                Backend VPS belum mendukung fitur Setting Koneksi & Assign Chat
              </div>
              <div className="text-sm text-amber-800 mb-2">
                Anda sudah deploy frontend baru, tapi process <b>hunter-backend</b> di VPS
                masih pakai kode lama (belum restart). Endpoint <code className="bg-amber-100 px-1 rounded">PATCH /api/whatsapp/accounts/&#123;sid&#125;</code> belum aktif.
              </div>
              <details className="text-xs text-amber-800">
                <summary className="cursor-pointer font-semibold">📖 Cara fix di VPS (klik untuk expand)</summary>
                <div className="mt-2 space-y-2 pl-3">
                  <div className="font-semibold text-amber-900">SSH ke VPS, jalankan SATU perintah ini:</div>
                  <pre className="bg-slate-900 text-emerald-300 p-3 rounded text-[11px] overflow-x-auto font-mono">
{`cd /var/www/hunter.elexart.com
git pull
sudo supervisorctl restart hunter-backend hunter-wa-service
# verify:
curl -X PATCH https://hunter.elexart.com/api/whatsapp/accounts/x \\
  -H "Authorization: Bearer YOUR_TOKEN" -H "Content-Type: application/json" -d '{}'
# should return 404 (not 405). 404 = endpoint exists tapi sid salah.`}
                  </pre>
                  <div className="text-amber-700 mt-1">
                    Setelah restart, refresh halaman ini — banner ini akan hilang dan tombol Simpan/Assign akan berfungsi.
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>
      )}

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
        <div className="grid grid-cols-1 lg:grid-cols-[280px,320px,1fr] gap-3">
          {/* Account list (left rail) */}
          <Card className="!p-2 lg:max-h-[78vh] lg:overflow-y-auto">
            {/* Tabs: Koneksi Saya vs Inbox Tim */}
            <div className="flex border-b border-slate-200 mb-2" data-testid="wa-tabs">
              <button
                onClick={() => setTab("own")}
                className={`flex-1 px-2 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
                  tab === "own"
                    ? "text-emerald-600 border-b-2 border-emerald-500"
                    : "text-slate-500 hover:text-slate-700 border-b-2 border-transparent"
                }`}
                data-testid="wa-tab-own"
              >
                <WhatsappLogo size={12} weight="bold" className="inline mr-1" />
                Koneksi Saya
                {ownAccounts.length > 0 && <span className="ml-1 text-[10px] opacity-60">({ownAccounts.length})</span>}
              </button>
              <button
                onClick={() => setTab("inbox")}
                className={`flex-1 px-2 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
                  tab === "inbox"
                    ? "text-indigo-600 border-b-2 border-indigo-500"
                    : "text-slate-500 hover:text-slate-700 border-b-2 border-transparent"
                }`}
                data-testid="wa-tab-inbox"
              >
                <Users size={12} weight="bold" className="inline mr-1" />
                Inbox Tim
                {inboxAccounts.length > 0 && (
                  <span className="ml-1 text-[10px] bg-indigo-500 text-white rounded-full px-1.5 py-0.5">
                    {inboxAccounts.length}
                  </span>
                )}
              </button>
            </div>
            {visibleAccounts.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-slate-400">
                {tab === "own"
                  ? "Belum ada koneksi WA milik Anda"
                  : "Belum ada chat yang di-assign Admin ke Anda"}
              </div>
            ) : visibleAccounts.map((acc) => {
              const sb = statusBadge(acc.live_status || acc.status);
              const isOther = acc.user_id !== user?.id;
              // Fallback: if backend doesn't return is_own field (old backend), derive from user_id
              const isOwn = acc.is_own !== undefined ? acc.is_own : (acc.user_id === user?.id);
              // Owner can edit any account in tenant; others only their own
              const canEdit = isOwn || user?.role === "Owner";
              return (
                <div
                  key={acc.session_id}
                  className={`group rounded-lg p-2 mb-1 cursor-pointer flex items-start gap-2 transition-all ${
                    activeSid === acc.session_id
                      ? (acc.is_assigned_inbox ? "bg-indigo-50 border border-indigo-200" : "bg-emerald-50 border border-emerald-200")
                      : "hover:bg-slate-50 border border-transparent"
                  }`}
                  onClick={() => { setActiveSid(acc.session_id); setActiveJid(""); }}
                  data-testid={`wa-account-${acc.session_id}`}
                >
                  <WhatsappLogo size={20} weight="fill" className={`${acc.is_assigned_inbox ? "text-indigo-500" : "text-emerald-500"} mt-0.5 shrink-0`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      <div className="text-sm font-semibold text-slate-900 truncate">
                        {acc.label || (acc.phone ? `+${acc.phone}` : "Pending")}
                      </div>
                      {acc.is_assigned_inbox && (
                        <Badge tone="info" className="!text-[9px]" data-testid={`wa-badge-inbox-${acc.session_id}`}>
                          <Tag size={9} weight="bold" /> Assign
                        </Badge>
                      )}
                      {!acc.is_assigned_inbox && isOther && (
                        <Badge tone="warning" className="!text-[9px]">
                          <Eye size={9} weight="bold" /> {acc.user_id?.slice(0, 4)}
                        </Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate font-mono">
                      {acc.phone ? `+${acc.phone}` : "—"}
                    </div>
                    <div className="mt-1 flex items-center gap-1 flex-wrap">
                      <Badge tone={sb.tone} className="!text-[10px]">{sb.label}</Badge>
                      {acc.is_assigned_inbox && acc.assigned_chat_count > 0 && (
                        <span className="text-[9px] text-indigo-600 font-semibold">
                          {acc.assigned_chat_count} chat di-assign
                        </span>
                      )}
                    </div>
                    {isOwn && acc.default_assigned_user_name && (
                      <div className="mt-1 text-[10px] text-indigo-700 bg-indigo-50 rounded px-1.5 py-0.5 inline-flex items-center gap-1 max-w-full">
                        <UserPlus size={9} weight="bold" />
                        <span className="truncate">Auto → {acc.default_assigned_user_name}</span>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {(acc.live_status === "qr" || acc.live_status === "logged_out") && isOwn && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleScanAgain(acc); }}
                        className="p-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-600 border border-emerald-200"
                        title="Scan QR"
                        data-testid={`wa-rescan-${acc.session_id}`}
                      >
                        <Phone size={14} weight="bold" />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setRenameAccount(acc); setRenameOpen(true); }}
                        className="p-1.5 rounded-lg bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border border-indigo-200"
                        title="Setting / Rename koneksi"
                        data-testid={`wa-gear-${acc.session_id}`}
                      >
                        <Gear size={14} weight="bold" />
                      </button>
                    )}
                    {!isOther && (
                      <button
                        onClick={(e) => { e.stopPropagation(); askDelete(acc); }}
                        className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-500 border border-rose-200"
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
              {isMonitorView && <Badge tone="warning" className="!text-[9px]"><ShieldCheck size={9} weight="bold" /> Monitoring</Badge>}
              {isAssignedInbox && <Badge tone="info" className="!text-[9px]"><Users size={9} weight="bold" /> Inbox Tim</Badge>}
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
                    className={`group w-full text-left p-3 hover:bg-slate-50 flex items-start gap-2 transition-colors border-b border-slate-100 ${
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
                      {c.assignment && (
                        <div
                          className={`text-[10px] mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-semibold ${
                            c.assignment.is_mine
                              ? "bg-indigo-100 text-indigo-700"
                              : "bg-amber-100 text-amber-700"
                          }`}
                          data-testid={`wa-chat-assignment-${c.jid}`}
                        >
                          <Tag size={9} weight="bold" />
                          {c.assignment.is_mine
                            ? "Di-assign ke saya"
                            : `→ ${c.assignment.assigned_user_name}`}
                        </div>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
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
                    {isAdmin && isAccountOwner && (
                      <button
                        onClick={(e) => { e.stopPropagation(); setAssignJid(c.jid); setAssignOpen(true); }}
                        className="opacity-0 group-hover:opacity-100 transition p-1 rounded hover:bg-indigo-100 text-indigo-600 shrink-0"
                        title={c.assignment ? "Edit assignment" : "Assign chat ke user"}
                        data-testid={`wa-assign-btn-${c.jid}`}
                      >
                        <UserPlus size={14} weight="bold" />
                      </button>
                    )}
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
                  {isMonitorView && <Badge tone="warning" className="!text-[9px]">View-only</Badge>}
                  {isAdmin && isAccountOwner && (
                    <button
                      onClick={() => { setAssignJid(activeJid); setAssignOpen(true); }}
                      className="text-[10px] px-2 py-1 rounded-md bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold flex items-center gap-1"
                      title="Assign chat ini ke user"
                      data-testid="wa-assign-btn-header"
                    >
                      <UserPlus size={11} weight="bold" /> Assign
                    </button>
                  )}
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
                            <div className={`text-[9px] mt-0.5 text-right flex items-center justify-end gap-1 ${m.from_me ? "text-emerald-100" : "text-slate-400"}`}>
                              {fmtTime(m.timestamp)}
                              {m._optimistic && m._sending && (
                                <span className="inline-flex items-center gap-0.5" title="Mengirim…">
                                  <ArrowsClockwise size={9} weight="bold" className="animate-spin" />
                                </span>
                              )}
                              {m._optimistic && !m._sending && !m._failed && (
                                <span title="Terkirim ke server, menunggu konfirmasi">✓</span>
                              )}
                              {m._failed && (
                                <button
                                  onClick={() => retrySend(m)}
                                  className="text-rose-200 hover:text-white underline ml-1"
                                  title="Klik untuk kirim ulang"
                                >
                                  ✗ Gagal — kirim ulang
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEnd} />
                </div>
                {!isMonitorView ? (
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

      <ConnectionSettingsModal
        open={renameOpen}
        account={renameAccount}
        teamMembers={teamMembers}
        onClose={() => setRenameOpen(false)}
        onSaved={loadAccounts}
      />

      <AssignChatModal
        open={assignOpen}
        sessionId={activeSid}
        jid={assignJid}
        currentAssignment={chats.find((c) => c.jid === assignJid)?.assignment || null}
        teamMembers={teamMembers}
        onClose={() => setAssignOpen(false)}
        onSaved={() => {
          // Reload chats so new/updated assignment shows up immediately
          if (activeSid) loadChats(activeSid);
          loadAccounts();
        }}
      />

      <ConfirmDeleteModal
        open={deleteOpen}
        account={deleteAccount}
        onClose={() => { setDeleteOpen(false); setDeleteAccount(null); }}
        onConfirm={handleDelete}
      />
    </div>
  );
}
