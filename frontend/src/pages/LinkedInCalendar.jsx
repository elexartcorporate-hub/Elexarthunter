import { useEffect, useMemo, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { Card } from "@/components/term";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { toast } from "sonner";

const DOW = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];
const MONTHS_ID = ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function isoFor(y, m, d) { return `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`; }

export default function LinkedInCalendar({ onPickDate }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [data, setData] = useState({ days: {}, target: 15 });
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data: d } = await api.get("/linkedin/calendar", { params: { year, month: month + 1 } });
      setData(d || { days: {}, target: 15 });
    } catch (err) {
      if (err?.response?.status !== 404) toast.error(formatApiError(err));
      setData({ days: {}, target: 15 });
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, month]);

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const lastDate = new Date(year, month + 1, 0).getDate();
    const firstDow = (first.getDay() + 6) % 7; // Mon=0..Sun=6
    const out = [];
    for (let i = 0; i < firstDow; i++) out.push(null);
    for (let d = 1; d <= lastDate; d++) out.push(d);
    while (out.length % 7 !== 0) out.push(null);
    return out;
  }, [year, month]);

  const prev = () => { if (month === 0) { setYear(year - 1); setMonth(11); } else setMonth(month - 1); };
  const next = () => { if (month === 11) { setYear(year + 1); setMonth(0); } else setMonth(month + 1); };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); };

  const target = data.target || 15;
  const todayStr = todayISO();

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button onClick={prev} className="p-1.5 rounded hover:bg-slate-100 border border-slate-200" data-testid="li-cal-prev"><CaretLeft size={14}/></button>
          <div className="font-semibold text-slate-900 min-w-[140px] text-center">{MONTHS_ID[month]} {year}</div>
          <button onClick={next} className="p-1.5 rounded hover:bg-slate-100 border border-slate-200" data-testid="li-cal-next"><CaretRight size={14}/></button>
          <button onClick={goToday} className="ml-2 text-xs px-2 py-1 rounded hover:bg-slate-100 border border-slate-200">Hari ini</button>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-emerald-300 inline-block"/> Target ✓</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-amber-300 inline-block"/> Berjalan</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-rose-200 inline-block"/> Terlewat</span>
          <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded bg-slate-200 inline-block"/> Libur</span>
        </div>
      </div>
      <Card className="p-3">
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DOW.map((d) => <div key={d} className="text-center text-[11px] font-semibold text-slate-500 py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => {
            if (!d) return <div key={i} className="aspect-square"/>;
            const iso = isoFor(year, month, d);
            const stats = data.days[iso];
            const total = stats?.total || 0;
            const accepted = stats?.accepted || 0;
            const isToday = iso === todayStr;
            const isFuture = iso > todayStr;
            let bg = "bg-white border-slate-200 hover:bg-slate-50";
            let dotColor = "text-rose-600"; // missed default
            if (total >= target) { bg = "bg-emerald-50 border-emerald-200 hover:bg-emerald-100"; dotColor = "text-emerald-700"; }
            else if (total > 0) { bg = "bg-amber-50 border-amber-200 hover:bg-amber-100"; dotColor = "text-amber-700"; }
            else if (isFuture) { bg = "bg-slate-50 border-slate-200 hover:bg-slate-100"; dotColor = "text-slate-500"; }
            return (
              <button
                key={i}
                onClick={() => onPickDate?.(iso)}
                data-testid={`li-cal-day-${iso}`}
                className={`aspect-square rounded-lg border ${bg} ${isToday ? "ring-2 ring-[#0A66C2]" : ""} text-left p-1.5 flex flex-col`}
              >
                <div className={`text-sm font-bold ${dotColor}`}>{d}</div>
                {total > 0 && (
                  <div className="mt-auto text-[10px] text-slate-600 flex items-center gap-1">
                    <span className="font-mono font-bold">{total}/{target}</span>
                    {accepted > 0 && <span className="text-emerald-700">✓{accepted}</span>}
                  </div>
                )}
              </button>
            );
          })}
        </div>
        {loading && <div className="text-center text-xs text-slate-500 mt-2">Loading…</div>}
      </Card>
    </div>
  );
}
