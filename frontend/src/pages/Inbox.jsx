import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, PrimaryButton, GhostButton, Badge, EmptyState } from "@/components/term";
import {
  Tray, ArrowsClockwise, Buildings, EnvelopeSimple, EnvelopeOpen, Funnel, Warning,
} from "@phosphor-icons/react";
import { toast } from "sonner";

export default function Inbox() {
  const [companies, setCompanies] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [data, setData] = useState(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const loadCompanies = async () => {
    try {
      const { data } = await api.get("/inbox/companies");
      setCompanies(data);
      if (data.length > 0 && !activeId) setActiveId(data[0].id);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { loadCompanies(); }, []);

  const loadInbox = async () => {
    if (!activeId) return;
    setLoading(true); setError(null);
    try {
      const { data } = await api.get(`/inbox/${activeId}`, { params: { limit: 30, unread_only: unreadOnly } });
      setData(data);
    } catch (err) {
      setError(formatApiError(err));
      setData(null);
    } finally { setLoading(false); }
  };
  useEffect(() => { if (activeId) loadInbox(); }, [activeId, unreadOnly]);

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1400px] mx-auto">
      <PageHeader
        title="Inbox"
        subtitle="Email masuk dari IMAP — hanya company yang sudah di-set IMAP & Anda punya akses"
        action={<PrimaryButton onClick={loadInbox} disabled={loading || !activeId} data-testid="refresh-inbox">
          <ArrowsClockwise size={14} weight="bold" className={loading ? "animate-spin" : ""} /> Refresh
        </PrimaryButton>}
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
          <div className="flex flex-wrap items-center gap-2 mb-4">
            {companies.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveId(c.id)}
                data-testid={`pick-company-${c.id}`}
                className={`px-3 py-2 rounded-lg text-sm font-medium border flex items-center gap-2 transition-all ${
                  activeId === c.id ? "bg-indigo-600 text-white border-indigo-600" : "bg-white border-slate-200 text-slate-700 hover:border-slate-300"
                }`}
              >
                <Buildings size={14} weight="bold" />
                <span>{c.name}</span>
                {c.email && <span className={`text-[11px] ${activeId === c.id ? "opacity-80" : "text-slate-500"}`}>· {c.email}</span>}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" className="accent-indigo-600" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} data-testid="unread-only" />
                <Funnel size={12} weight="bold" /> Unread only
              </label>
            </div>
          </div>

          <Card className="p-0 overflow-hidden">
            {error ? (
              <div className="p-8 text-center">
                <Warning size={32} weight="duotone" className="text-rose-500 mx-auto mb-2" />
                <div className="text-sm font-medium text-rose-700">{error}</div>
                <div className="text-xs text-slate-500 mt-2">Periksa setting IMAP di Settings → Companies → Test IMAP</div>
              </div>
            ) : loading ? (
              <div className="p-12 text-center text-slate-500">Memuat email...</div>
            ) : !data || data.messages.length === 0 ? (
              <div className="p-12 text-center">
                <Tray size={40} weight="duotone" className="text-slate-300 mx-auto mb-2" />
                <div className="text-sm text-slate-500">{unreadOnly ? "Tidak ada email belum dibaca" : "Inbox kosong"}</div>
              </div>
            ) : (
              <>
                <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 text-xs text-slate-600 flex items-center justify-between">
                  <span>{data.sub_company_name} · {data.count} pesan{unreadOnly ? " (unread)" : ""}</span>
                  <Badge tone="info">IMAP</Badge>
                </div>
                <div className="divide-y divide-slate-100">
                  {data.messages.map((m) => (
                    <div key={m.uid} className={`p-3 hover:bg-slate-50 flex items-start gap-3 ${m.unread ? "bg-indigo-50/30" : ""}`} data-testid={`mail-${m.uid}`}>
                      <div className="mt-1">
                        {m.unread
                          ? <EnvelopeSimple size={18} weight="fill" className="text-indigo-600" />
                          : <EnvelopeOpen size={18} weight="bold" className="text-slate-400" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <div className={`text-sm truncate ${m.unread ? "font-bold text-slate-900" : "font-medium text-slate-700"}`}>{m.from}</div>
                          {m.unread && <Badge tone="info">UNREAD</Badge>}
                        </div>
                        <div className={`text-sm truncate ${m.unread ? "text-slate-900 font-medium" : "text-slate-600"}`}>{m.subject}</div>
                      </div>
                      <div className="text-[11px] text-slate-500 whitespace-nowrap shrink-0">{fmtDate(m.date)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </>
      )}
    </div>
  );
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
