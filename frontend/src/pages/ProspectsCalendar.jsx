import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { Card, TermInput, TermSelect, TermTextarea, PrimaryButton, GhostButton, Badge } from "@/components/term";
import {
  CaretLeft, CaretRight, CalendarCheck, Plus, X, PaperPlaneTilt,
  Clock, CheckCircle, XCircle, Lock, ArrowsClockwise, Trash,
} from "@phosphor-icons/react";
import { toast } from "sonner";

const MONTH_ID = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];
const DOW_LABEL = { mon: "Sen", tue: "Sel", wed: "Rab", thu: "Kam", fri: "Jum", sat: "Sab", sun: "Min" };
const DOW_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const STATUS_CONFIG = {
  hit:     { bg: "bg-emerald-50 border-emerald-200 hover:border-emerald-300",   text: "text-emerald-700", label: "Target ✓" },
  partial: { bg: "bg-amber-50 border-amber-200 hover:border-amber-300",          text: "text-amber-700",   label: "Berjalan" },
  open:    { bg: "bg-white border-slate-200 hover:border-indigo-300",             text: "text-slate-700",   label: "Tersedia" },
  missed:  { bg: "bg-rose-50/40 border-rose-100 hover:border-rose-200",           text: "text-rose-700",    label: "Terlewat" },
  off:     { bg: "bg-slate-50 border-slate-100",                                   text: "text-slate-400",   label: "Libur" },
};

export default function Calendar({ quota, onChanged, onTaskCreated }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [data, setData] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get("/prospects/calendar", { params: { year, month } });
      setData(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  useEffect(() => { load(); }, [year, month]);

  const goPrev = () => {
    if (month === 1) { setYear(year - 1); setMonth(12); }
    else setMonth(month - 1);
  };
  const goNext = () => {
    if (month === 12) { setYear(year + 1); setMonth(1); }
    else setMonth(month + 1);
  };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth() + 1); };

  // Build weeks grid (start each week on Monday)
  const grid = useMemo(() => {
    if (!data) return [];
    const days = data.days;
    const first = days[0];
    if (!first) return [];
    const firstDow = DOW_ORDER.indexOf(first.dow); // 0=Mon
    const cells = Array(firstDow).fill(null).concat(days);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }, [data]);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <GhostButton onClick={goPrev} data-testid="cal-prev"><CaretLeft size={14} weight="bold" /></GhostButton>
          <div className="font-display text-lg font-bold text-slate-900 min-w-[160px] text-center" data-testid="cal-title">
            {MONTH_ID[month - 1]} {year}
          </div>
          <GhostButton onClick={goNext} data-testid="cal-next"><CaretRight size={14} weight="bold" /></GhostButton>
          <GhostButton onClick={goToday} data-testid="cal-today">Hari ini</GhostButton>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-600">
          <LegendDot color="bg-emerald-200" label="Target ✓" />
          <LegendDot color="bg-amber-200" label="Berjalan" />
          <LegendDot color="bg-rose-100" label="Terlewat" />
          <LegendDot color="bg-slate-200" label="Libur" />
        </div>
      </div>

      <Card className="p-2 sm:p-4">
        {/* Weekday header */}
        <div className="grid grid-cols-7 gap-1.5 sm:gap-2 mb-2">
          {DOW_ORDER.map((d) => (
            <div key={d} className="text-center text-[10px] sm:text-xs font-semibold text-slate-500 py-1">
              {DOW_LABEL[d]}
            </div>
          ))}
        </div>

        {/* Days grid */}
        {!data ? (
          <div className="text-center py-12 text-slate-400 text-sm">Loading...</div>
        ) : (
          <div className="space-y-1.5 sm:space-y-2">
            {grid.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7 gap-1.5 sm:gap-2">
                {week.map((day, di) => {
                  if (!day) return <div key={di} className="aspect-[4/5] sm:aspect-square" />;
                  const cfg = STATUS_CONFIG[day.status] || STATUS_CONFIG.open;
                  const isToday = day.is_today;
                  return (
                    <button
                      key={day.date}
                      onClick={() => setSelectedDate(day.date)}
                      data-testid={`cal-day-${day.date}`}
                      className={`relative text-left aspect-[4/5] sm:aspect-square min-h-[80px] rounded-lg border p-1.5 sm:p-2 transition-all flex flex-col ${cfg.bg} ${
                        isToday ? "ring-2 ring-indigo-500 ring-offset-1" : ""
                      } ${day.status === "off" ? "cursor-default" : "hover:shadow-sm cursor-pointer"}`}
                      disabled={day.status === "off"}
                    >
                      <div className="flex items-start justify-between gap-1">
                        <div className={`text-sm sm:text-base font-bold ${isToday ? "text-indigo-700" : cfg.text}`}>
                          {day.day}
                        </div>
                        {day.is_holiday && <div className="text-[9px] text-amber-600">🌴</div>}
                      </div>
                      {/* Badges */}
                      <div className="mt-auto flex flex-wrap gap-0.5 sm:gap-1">
                        {day.prospects_added > 0 && (
                          <span className="text-[9px] sm:text-[10px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium flex items-center gap-0.5" title={`${day.prospects_added} prospects added`}>
                            <CheckCircle size={9} weight="fill" />{day.prospects_added}
                          </span>
                        )}
                        {day.emails_sent > 0 && (
                          <span className="text-[9px] sm:text-[10px] px-1 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium flex items-center gap-0.5" title={`${day.emails_sent} emails sent`}>
                            <PaperPlaneTilt size={9} weight="fill" />{day.emails_sent}
                          </span>
                        )}
                        {day.emails_scheduled > 0 && (
                          <span className="text-[9px] sm:text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700 font-medium flex items-center gap-0.5" title={`${day.emails_scheduled} emails scheduled`}>
                            <Clock size={9} weight="fill" />{day.emails_scheduled}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </Card>

      {selectedDate && (
        <DayDrawer
          date={selectedDate}
          calendarTarget={data?.daily_target}
          onClose={() => setSelectedDate(null)}
          onScheduled={() => { load(); onChanged?.(); }}
          onTaskCreated={(t) => { setSelectedDate(null); onTaskCreated?.(t); load(); }}
        />
      )}
    </div>
  );
}

function LegendDot({ color, label }) {
  return <span className="flex items-center gap-1"><span className={`w-2.5 h-2.5 rounded ${color}`} />{label}</span>;
}

/* ─────────────── Day Drawer ─────────────── */
function DayDrawer({ date, calendarTarget, onClose, onScheduled, onTaskCreated }) {
  const [detail, setDetail] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [showSchedule, setShowSchedule] = useState(false);
  const [showNewTask, setShowNewTask] = useState(false);

  const load = async () => {
    try { const { data } = await api.get(`/prospects/calendar/day/${date}`); setDetail(data); }
    catch (err) { toast.error(formatApiError(err)); }
    try { const { data } = await api.get("/tasks", { params: { date } }); setTasks(data); }
    catch (err) { /* ignore */ }
  };
  useEffect(() => { load(); }, [date]);

  const cancelScheduled = async (sid) => {
    if (!window.confirm("Batalkan jadwal email ini?")) return;
    try {
      await api.post(`/scheduled-emails/${sid}/cancel`);
      toast.success("Dibatalkan");
      load();
      onScheduled?.();
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const d = new Date(date + "T00:00:00");
  const isPast   = new Date().toISOString().slice(0,10) > date;
  const isFuture = new Date().toISOString().slice(0,10) < date;
  const isToday  = new Date().toISOString().slice(0,10) === date;

  return (
    <div className="fixed inset-0 z-40 bg-black/30 fade-up" onClick={onClose}>
      <div className="absolute right-0 top-0 bottom-0 w-full max-w-md bg-white border-l border-slate-200 shadow-2xl overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-200 px-5 py-4 flex items-center justify-between">
          <div>
            <div className="font-display text-lg font-bold text-slate-900">
              {d.toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            </div>
            <div className="text-xs text-slate-500">
              {isToday && <Badge tone="info">Hari ini</Badge>}
              {isPast && <Badge tone="neutral">Lampau</Badge>}
              {isFuture && <Badge tone="purple">Masa depan</Badge>}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700" data-testid="drawer-close"><X size={20} weight="bold" /></button>
        </div>

        <div className="p-5 space-y-5">
          {/* New Task action — for today & future */}
          {!isPast && (
            <Card className="p-4 bg-gradient-to-br from-indigo-50 to-purple-50 border-indigo-200">
              <div className="flex items-start gap-3">
                <CalendarCheck size={24} weight="duotone" className="text-indigo-600 shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold text-slate-900 text-sm">Tambah Tugas Baru</div>
                  <div className="text-xs text-slate-600 mt-0.5 mb-3">Buat tugas outreach untuk tanggal ini dengan target prospect.</div>
                  <PrimaryButton onClick={() => setShowNewTask(true)} data-testid="new-task-btn">
                    <Plus size={14} weight="bold" /> Tugas Baru
                  </PrimaryButton>
                </div>
              </div>
            </Card>
          )}

          {/* Existing tasks for this date */}
          {tasks.length > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-indigo-600 font-semibold mb-2 flex items-center gap-2">
                <CalendarCheck size={12} weight="bold" /> Tugas tanggal ini ({tasks.length})
              </h3>
              <div className="space-y-1.5">
                {tasks.map((t) => (
                  <div key={t.id} className="border border-indigo-200 bg-indigo-50/50 rounded-lg p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 truncate">{t.name}</div>
                        <div className="text-[11px] text-slate-600">{t.prospect_count} / {t.target} prospect · {t.status}</div>
                      </div>
                      <Badge tone={t.status === "completed" ? "success" : t.status === "scheduled" ? "purple" : t.status === "draft" ? "neutral" : "info"}>{t.status}</Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Schedule outreach (older flow, still available) */}
          {isFuture && (
            <Card className="p-4 bg-gradient-to-br from-purple-50 to-pink-50 border-purple-200">
              <div className="flex items-start gap-3">
                <Clock size={24} weight="duotone" className="text-purple-600 shrink-0" />
                <div className="flex-1">
                  <div className="font-semibold text-slate-900 text-sm">Quick Schedule Outreach</div>
                  <div className="text-xs text-slate-600 mt-0.5 mb-3">Jadwalkan email tanpa membuat tugas — langsung pilih prospect existing.</div>
                  <PrimaryButton onClick={() => setShowSchedule(true)} data-testid="schedule-btn">
                    <Plus size={14} weight="bold" /> Jadwal Outreach
                  </PrimaryButton>
                </div>
              </div>
            </Card>
          )}

          {/* Prospects added */}
          <div>
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2 flex items-center gap-2">
              <CheckCircle size={12} weight="bold" /> Prospects ditambah ({detail?.prospects?.length || 0})
            </h3>
            {detail?.prospects?.length ? (
              <div className="space-y-1.5">
                {detail.prospects.map((p) => {
                  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                  return (
                    <div key={p.id} className="border border-slate-200 rounded-lg p-2.5">
                      <div className="text-sm font-medium text-slate-900 truncate">{p.company_name}</div>
                      <div className="text-xs text-slate-500 truncate font-mono">{primary?.email || p.domain}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-slate-400 text-center py-4 border border-dashed border-slate-200 rounded-lg">Belum ada prospect</div>
            )}
          </div>

          {/* Scheduled emails */}
          {(detail?.scheduled_emails?.length || 0) > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-purple-600 font-semibold mb-2 flex items-center gap-2">
                <Clock size={12} weight="bold" /> Email terjadwal ({detail.scheduled_emails.length})
              </h3>
              <div className="space-y-1.5">
                {detail.scheduled_emails.map((s) => (
                  <div key={s.id} className="border border-purple-200 bg-purple-50/50 rounded-lg p-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-slate-900 truncate">{s.subject}</div>
                        <div className="text-[11px] text-slate-500 truncate font-mono">→ {s.to_email}</div>
                        <div className="text-[10px] text-purple-600 mt-0.5">
                          {new Date(s.scheduled_at).toLocaleString("id-ID", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}
                          {s.prospect_name && ` · ${s.prospect_name}`}
                        </div>
                      </div>
                      <button onClick={() => cancelScheduled(s.id)} className="text-slate-400 hover:text-rose-600" data-testid={`cancel-${s.id}`}>
                        <Trash size={14} weight="bold" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sent emails */}
          {(detail?.sent_emails?.length || 0) > 0 && (
            <div>
              <h3 className="text-[10px] uppercase tracking-widest text-emerald-600 font-semibold mb-2 flex items-center gap-2">
                <PaperPlaneTilt size={12} weight="bold" /> Email terkirim ({detail.sent_emails.length})
              </h3>
              <div className="space-y-1.5">
                {detail.sent_emails.map((s) => (
                  <div key={s.id} className="border border-emerald-200 bg-emerald-50/50 rounded-lg p-2.5">
                    <div className="text-xs font-medium text-slate-900 truncate">{s.subject}</div>
                    <div className="text-[11px] text-slate-500 truncate font-mono">→ {s.to_email}</div>
                    {s.prospect_name && <div className="text-[10px] text-slate-500 mt-0.5">{s.prospect_name}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {showSchedule && (
        <ScheduleModal date={date} onClose={() => setShowSchedule(false)} onSaved={() => { setShowSchedule(false); load(); onScheduled?.(); }} />
      )}
      {showNewTask && (
        <NewTaskModal date={date} defaultTarget={calendarTarget} onClose={() => setShowNewTask(false)} onCreated={(t) => { setShowNewTask(false); onTaskCreated?.(t); }} />
      )}
    </div>
  );
}

/* ─────────────── New Task Modal ─────────────── */
function NewTaskModal({ date, defaultTarget, onClose, onCreated }) {
  const [form, setForm] = useState({
    name: `Outreach ${date}`,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const targetFromSettings = defaultTarget || 0;
  const save = async () => {
    if (!targetFromSettings || targetFromSettings < 1) {
      return toast.error("Target harian belum di-set. Atur di Settings → Target Harian dulu.");
    }
    setSaving(true);
    try {
      const { data } = await api.post("/tasks", { date, name: form.name, notes: form.notes || null });
      toast.success(`Tugas dibuat: ${data.name} (target ${data.target})`);
      onCreated(data);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card className="w-full max-w-md shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between rounded-t-xl">
            <div>
              <h2 className="font-display text-lg text-slate-900 flex items-center gap-2"><CalendarCheck size={18} weight="bold" className="text-indigo-600" /> Tugas Baru</h2>
              <div className="text-xs text-slate-500">untuk tanggal <b>{date}</b></div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500"><X size={20} weight="bold" /></button>
          </div>
          <div className="p-6 space-y-3">
            <TermInput label="Nama tugas" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-testid="new-task-name" />
            <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-indigo-600 text-white grid place-items-center font-bold text-base">{targetFromSettings || "—"}</div>
              <div className="text-xs">
                <div className="text-slate-900 font-semibold">Target prospect: {targetFromSettings || "belum di-set"}</div>
                <div className="text-slate-500">Diambil dari Settings → Target Harian. Untuk ubah, buka Settings.</div>
              </div>
            </div>
            <TermTextarea label="Catatan (opsional)" rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            <div className="text-[11px] text-slate-500">
              💡 Setelah tugas dibuat, Anda akan otomatis diarahkan ke tab Add Prospect.
            </div>
          </div>
          <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2 rounded-b-xl">
            <GhostButton onClick={onClose}>Cancel</GhostButton>
            <PrimaryButton onClick={save} disabled={saving || !targetFromSettings} data-testid="new-task-save">
              <Plus size={14} weight="bold" /> {saving ? "Membuat..." : "Buat Tugas"}
            </PrimaryButton>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ─────────────── Schedule Modal ─────────────── */
function ScheduleModal({ date, onClose, onSaved }) {
  const [templates, setTemplates] = useState([]);
  const [prospects, setProspects] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [time, setTime] = useState("09:00");
  const [form, setForm] = useState({
    template_id: "",
    subject: "Hi {{name}}, quick question about {{company}}",
    body_html: "<p>Hi {{name}},</p>\n<p>I came across {{company}} and wanted to reach out.</p>\n<p>Best,<br/>Your Name</p>",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/templates").then(({ data }) => setTemplates(data)).catch(() => {});
    api.get("/prospects").then(({ data }) => setProspects(data)).catch(() => {});
  }, []);

  const pickTemplate = (tid) => {
    setForm((f) => ({ ...f, template_id: tid }));
    if (!tid) return;
    const t = templates.find((x) => x.id === tid);
    if (t) setForm((f) => ({ ...f, subject: t.subject, body_html: t.body_html }));
  };

  const toggle = (id) => {
    const s = new Set(selectedIds);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelectedIds(s);
  };

  const save = async () => {
    if (selectedIds.size === 0) return toast.error("Pilih minimal 1 prospect");
    const scheduledLocal = new Date(`${date}T${time}:00`);
    if (scheduledLocal <= new Date()) return toast.error("Waktu jadwal harus di masa depan");
    setSaving(true);
    try {
      const { data } = await api.post("/prospects/bulk-send-email", {
        prospect_ids: Array.from(selectedIds),
        subject: form.subject,
        body_html: form.body_html,
        template_id: form.template_id || null,
        scheduled_at: scheduledLocal.toISOString(),
      });
      toast.success(`✓ ${data.queued} email terjadwal pada ${date} ${time}`);
      onSaved();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up overflow-y-auto" onClick={onClose}>
      <div className="min-h-full flex items-start sm:items-center justify-center p-4 py-8">
        <Card className="w-full max-w-4xl shadow-2xl my-auto" onClick={(e) => e.stopPropagation()}>
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between rounded-t-xl">
            <div>
              <h2 className="font-display text-lg text-slate-900 flex items-center gap-2"><Clock size={18} weight="bold" className="text-purple-600" /> Jadwalkan Outreach</h2>
              <div className="text-xs text-slate-500">Email akan otomatis terkirim pada <b>{date}</b></div>
            </div>
            <button onClick={onClose} className="text-slate-500 hover:text-red-500"><X size={20} weight="bold" /></button>
          </div>
          <div className="p-6 grid grid-cols-1 lg:grid-cols-2 gap-5">
            <div className="space-y-3">
              <TermSelect label="Template" value={form.template_id} onChange={(e) => pickTemplate(e.target.value)}>
                <option value="">— blank —</option>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </TermSelect>
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-1">Waktu kirim (HH:MM, UTC)</label>
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20"
                  data-testid="schedule-time"
                />
              </div>
              <TermInput label="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} data-testid="schedule-subject" />
              <TermTextarea label="Body (HTML, supports {{name}} {{company}})" rows={8} value={form.body_html} onChange={(e) => setForm({ ...form, body_html: e.target.value })} data-testid="schedule-body" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-medium mb-2">Pilih prospect ({selectedIds.size})</div>
              <div className="border border-slate-200 rounded-xl overflow-hidden max-h-[420px] overflow-y-auto">
                {prospects.length === 0 ? (
                  <div className="text-xs text-slate-400 p-4 text-center">Belum ada prospect</div>
                ) : prospects.map((p) => {
                  const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                  if (!primary?.email) return null;
                  return (
                    <label key={p.id} className={`flex items-center gap-2 p-2 border-b border-slate-100 last:border-b-0 cursor-pointer ${selectedIds.has(p.id) ? "bg-purple-50/50" : "bg-white"}`}>
                      <input type="checkbox" className="accent-purple-600" checked={selectedIds.has(p.id)} onChange={() => toggle(p.id)} data-testid={`schedule-pick-${p.id}`} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-900 truncate">{p.company_name}</div>
                        <div className="text-xs text-slate-500 truncate font-mono">{primary.email}</div>
                      </div>
                      <Badge tone={p.status === "New" ? "neutral" : "info"}>{p.status}</Badge>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-between rounded-b-xl">
            <div className="text-xs text-slate-500"><Clock size={11} weight="bold" className="inline mr-1" /> Scheduler poll setiap 60 detik</div>
            <div className="flex gap-2">
              <GhostButton onClick={onClose}>Cancel</GhostButton>
              <PrimaryButton onClick={save} disabled={saving || selectedIds.size === 0} data-testid="schedule-save-btn">
                <Clock size={14} weight="bold" /> {saving ? "Menjadwalkan..." : `Jadwalkan ${selectedIds.size} email`}
              </PrimaryButton>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
