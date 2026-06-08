import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, Badge, PrimaryButton } from "@/components/term";
import {
  Target, UsersFour, PaperPlaneTilt, ChatTeardropDots, Star, Crown,
  CheckCircle, Circle, ArrowUpRight, Spinner,
} from "@phosphor-icons/react";
import {
  AreaChart, Area, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { toast } from "sonner";
import { useAuth } from "@/contexts/AuthContext";

const TASKS = [
  { key: "add_prospects",   label: "Add New Prospects",          condition: (d) => (d.cards?.prospects_today || 0) > 0 },
  { key: "send_emails",     label: "Send Emails",                condition: (d) => (d.cards?.emails_sent_today || 0) > 0 },
  { key: "check_replies",   label: "Check Email Replies",        condition: (d) => (d.cards?.replies_today || 0) > 0, optional: true },
  { key: "review_interest", label: "Review Interested Leads",    condition: (d) => (d.cards?.interested_count || 0) > 0, optional: true },
  { key: "update_notes",    label: "Update CRM Notes",           condition: () => false, manual: true },
];

export default function Dashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [manualDone, setManualDone] = useState(() => {
    try { return JSON.parse(localStorage.getItem("lh_manual_tasks") || "{}"); }
    catch { return {}; }
  });

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/dashboard/daily");
      setData(data);
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const toggleManual = (key) => {
    const today = new Date().toISOString().slice(0, 10);
    const next = { ...manualDone };
    next[`${today}__${key}`] = !next[`${today}__${key}`];
    setManualDone(next);
    localStorage.setItem("lh_manual_tasks", JSON.stringify(next));
  };
  const isDone = (t) => {
    if (t.manual) {
      const today = new Date().toISOString().slice(0, 10);
      return !!manualDone[`${today}__${t.key}`];
    }
    return t.condition(data || {});
  };

  if (loading || !data) {
    return <div className="p-8 text-slate-500"><Spinner size={20} weight="bold" className="animate-spin inline" /> Loading dashboard...</div>;
  }

  const added  = data.cards.prospects_today || 0;
  const sentToday = data.cards.emails_sent_today || 0;

  return (
    <div className="p-6 md:p-8 fade-up max-w-[1600px] mx-auto">
      <PageHeader
        title={`Good ${greet()}, ${user?.name?.split(" ")[0] || "there"}`}
        subtitle="Your daily prospecting summary"
        action={<PrimaryButton onClick={() => navigate("/prospects")} data-testid="dashboard-add-btn">
          <UsersFour size={14} weight="bold" /> Add Prospect
        </PrimaryButton>}
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <Kpi label="Prospects Today" value={added}                              icon={UsersFour}        tone="indigo"  testid="kpi-prospects" onClick={() => navigate("/prospects")} />
        <Kpi label="Emails Sent"     value={sentToday}                          icon={PaperPlaneTilt}   tone="emerald" testid="kpi-sent"      onClick={() => navigate("/activity")} />
        <Kpi label="Team Emails"     value={data.cards.team_emails_today || 0}  icon={PaperPlaneTilt}   tone="sky"     testid="kpi-team-sent" onClick={() => navigate("/activity")} />
        <Kpi label="Replies Today"   value={data.cards.replies_today || 0}      icon={ChatTeardropDots} tone="purple"  testid="kpi-replies" />
        <Kpi label="Interested"      value={data.cards.interested_count || 0}   icon={Star}             tone="amber"   testid="kpi-interested" onClick={() => navigate("/prospects")} />
        <Kpi label="Customers Won"   value={data.cards.customers_won || 0}      icon={Crown}            tone="success" testid="kpi-customers" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Trend chart */}
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900">14-day activity</h3>
              <p className="text-xs text-slate-500">Your prospects added &amp; emails sent</p>
            </div>
            <Badge tone="success">Live</Badge>
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={data.trend}>
              <defs>
                <linearGradient id="addedGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="sentGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#64748b" }} />
              <YAxis tick={{ fontSize: 10, fill: "#64748b" }} allowDecimals={false} />
              <Tooltip />
              <Area type="monotone" dataKey="added" stroke="#6366f1" fillOpacity={1} fill="url(#addedGrad)" strokeWidth={2} />
              <Area type="monotone" dataKey="sent"  stroke="#10b981" fillOpacity={1} fill="url(#sentGrad)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        {/* Today's Task Checklist */}
        <Card className="p-5">
          <h3 className="font-display text-base font-semibold text-slate-900 mb-1">Today&apos;s Tasks</h3>
          <p className="text-xs text-slate-500 mb-3">Tick items off as you progress</p>
          <div className="space-y-2">
            {TASKS.map((t) => {
              const done = isDone(t);
              return (
                <button
                  key={t.key}
                  onClick={() => t.manual && toggleManual(t.key)}
                  data-testid={`task-${t.key}`}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-all text-left ${
                    done ? "bg-emerald-50 border-emerald-200" : "bg-slate-50 border-slate-200 hover:border-slate-300"
                  }`}
                >
                  {done ? <CheckCircle size={18} weight="fill" className="text-emerald-600 shrink-0" /> : <Circle size={18} weight="regular" className="text-slate-300 shrink-0" />}
                  <span className={`text-sm flex-1 ${done ? "text-emerald-700 line-through" : "text-slate-700"}`}>{t.label}</span>
                  {t.manual && <span className="text-[10px] text-slate-400">tap</span>}
                </button>
              );
            })}
          </div>
        </Card>

        {/* Recent prospects */}
        <Card className="p-5 lg:col-span-3">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-display text-base font-semibold text-slate-900">Recent Prospects</h3>
              <p className="text-xs text-slate-500">Latest prospects you added</p>
            </div>
            <button onClick={() => navigate("/prospects")} className="text-xs text-indigo-600 hover:underline flex items-center gap-1" data-testid="view-all-prospects">
              View all <ArrowUpRight size={12} weight="bold" />
            </button>
          </div>
          {(data.recent_prospects || []).length === 0 ? (
            <div className="text-sm text-slate-400 py-6 text-center">No prospects yet · <a className="text-indigo-600 cursor-pointer underline" onClick={() => navigate("/prospects")}>add your first one</a></div>
          ) : (
            <div className="divide-y divide-slate-100">
              {data.recent_prospects.map((p) => {
                const primary = (p.emails || []).find((e) => e.is_primary) || (p.emails || [])[0];
                return (
                  <button
                    key={p.id}
                    onClick={() => navigate(`/prospects/${p.id}`)}
                    className="w-full text-left py-2.5 hover:bg-slate-50 px-2 rounded-lg flex items-center gap-3"
                    data-testid={`recent-${p.id}`}
                  >
                    <div className="w-8 h-8 bg-indigo-50 text-indigo-600 rounded-lg grid place-items-center font-medium text-xs">
                      {(p.company_name || "?").charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{p.company_name}</div>
                      <div className="text-xs text-slate-500 truncate">{primary?.email || p.domain || "—"}</div>
                    </div>
                    <Badge tone={p.status === "Customer" ? "success" : p.status === "Lost" ? "error" : p.status === "Interested" ? "warning" : "neutral"}>{p.status}</Badge>
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function Kpi({ label, value, icon: Icon, tone, testid, onClick }) {
  const tones = {
    indigo:  "bg-indigo-50 text-indigo-600",
    emerald: "bg-emerald-50 text-emerald-600",
    sky:     "bg-sky-50 text-sky-600",
    purple:  "bg-purple-50 text-purple-600",
    amber:   "bg-amber-50 text-amber-600",
    success: "bg-emerald-50 text-emerald-700",
  };
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`text-left p-4 bg-white border border-slate-200 rounded-xl hover:border-slate-300 hover:shadow-sm transition-all ${onClick ? "cursor-pointer" : "cursor-default"}`}
    >
      <div className={`w-8 h-8 rounded-lg ${tones[tone] || tones.indigo} grid place-items-center mb-2`}>
        <Icon size={16} weight="bold" />
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-medium">{label}</div>
      <div className="text-2xl font-bold text-slate-900">{value}</div>
    </button>
  );
}

function greet() {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}
