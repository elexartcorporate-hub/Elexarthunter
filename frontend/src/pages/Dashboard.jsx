import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PageHeader, Card, Badge } from "@/components/term";
import {
  Buildings, UsersThree, EnvelopeOpen, TrendUp, PaperPlaneTilt,
  ChartLineUp, ChatTeardropDots, Warning, ArrowUpRight,
} from "@phosphor-icons/react";
import {
  LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from "recharts";

const KPI_CONFIG = [
  { key: "total_companies",   label: "Total Companies",   icon: Buildings,       color: "indigo",  suffix: "" },
  { key: "total_contacts",    label: "Total Contacts",    icon: UsersThree,      color: "purple",  suffix: "" },
  { key: "total_emails_found",label: "Emails Found",      icon: EnvelopeOpen,    color: "teal",    suffix: "" },
  { key: "new_leads_today",   label: "New Leads Today",   icon: TrendUp,         color: "emerald", suffix: "" },
  { key: "emails_sent_today", label: "Emails Sent Today", icon: PaperPlaneTilt,  color: "sky",     suffix: "" },
  { key: "open_rate",         label: "Open Rate",         icon: ChartLineUp,     color: "emerald", suffix: "%" },
  { key: "reply_rate",        label: "Reply Rate",        icon: ChatTeardropDots,color: "indigo",  suffix: "%" },
  { key: "bounce_rate",       label: "Bounce Rate",       icon: Warning,         color: "red",     suffix: "%" },
];

const COLOR_STYLES = {
  indigo:  { iconBg: "bg-indigo-50",  iconText: "text-indigo-600",  ring: "ring-indigo-100" },
  purple:  { iconBg: "bg-purple-50",  iconText: "text-purple-600",  ring: "ring-purple-100" },
  teal:    { iconBg: "bg-teal-50",    iconText: "text-teal-600",    ring: "ring-teal-100" },
  emerald: { iconBg: "bg-emerald-50", iconText: "text-emerald-600", ring: "ring-emerald-100" },
  sky:     { iconBg: "bg-sky-50",     iconText: "text-sky-600",     ring: "ring-sky-100" },
  red:     { iconBg: "bg-red-50",     iconText: "text-red-600",     ring: "ring-red-100" },
};

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/dashboard/overview").then((r) => setData(r.data)).finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="p-10 text-sm text-slate-500">Loading dashboard...</div>
    );
  }

  return (
    <div className="p-8 max-w-[1600px] mx-auto fade-up">
      <PageHeader
        title="Dashboard"
        subtitle="Overview of your lead generation and email marketing performance"
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6" data-testid="kpi-grid">
        {KPI_CONFIG.map((k) => {
          const v = data.cards[k.key];
          const c = COLOR_STYLES[k.color];
          return (
            <Card key={k.key} hoverable className="p-5">
              <div className="flex items-start justify-between mb-3">
                <span className="text-xs font-medium text-slate-500">{k.label}</span>
                <div className={`w-9 h-9 rounded-lg ${c.iconBg} ${c.iconText} flex items-center justify-center`}>
                  <k.icon size={18} weight="bold" />
                </div>
              </div>
              <div className="font-display text-3xl font-bold text-slate-900 tracking-tight">
                {v}{k.suffix}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <div className="font-display text-base font-semibold text-slate-900">Leads Growth</div>
              <div className="text-xs text-slate-500 mt-0.5">New contacts discovered · last 14 days</div>
            </div>
            <Badge tone="success">● Live</Badge>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={data.trends} margin={{ left: -20 }}>
              <defs>
                <linearGradient id="leadsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="0" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: "0 4px 12px rgb(15 23 42 / 0.06)",
                }}
              />
              <Area type="monotone" dataKey="leads" stroke="#6366f1" strokeWidth={2.5} fill="url(#leadsGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div>
              <div className="font-display text-base font-semibold text-slate-900">Emails Sent</div>
              <div className="text-xs text-slate-500 mt-0.5">Delivered emails · last 14 days</div>
            </div>
            <Badge tone="info">14d</Badge>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={data.trends} margin={{ left: -20 }}>
              <CartesianGrid strokeDasharray="0" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="label" stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
              <YAxis stroke="#94a3b8" fontSize={11} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{
                  background: "#fff",
                  border: "1px solid #e2e8f0",
                  borderRadius: 8,
                  fontSize: 12,
                  boxShadow: "0 4px 12px rgb(15 23 42 / 0.06)",
                }}
              />
              <Line type="monotone" dataKey="sent" stroke="#14b8a6" strokeWidth={2.5} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <RecentList
          title="Recent Searches"
          rows={data.recent_searches}
          renderItem={(r) => (
            <div className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-b-0" key={r.id}>
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{r.domain}</div>
                <div className="text-xs text-slate-500 mt-0.5">{r.company_name || "—"}</div>
              </div>
              <Badge tone={r.from_cache ? "info" : "success"}>{r.contacts_found || 0} contacts</Badge>
            </div>
          )}
          empty="No searches yet"
        />
        <RecentList
          title="Recent Leads"
          rows={data.recent_leads}
          renderItem={(r) => (
            <div className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-b-0 gap-2" key={r.id}>
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">{r.email}</div>
                <div className="text-xs text-slate-500 mt-0.5 truncate">{r.name || r.job_title || "—"}</div>
              </div>
              <Badge tone={r.confidence_score >= 80 ? "success" : r.confidence_score >= 50 ? "warning" : "error"}>
                {r.confidence_score}
              </Badge>
            </div>
          )}
          empty="No leads yet · run a Hunter search"
        />
        <RecentList
          title="Recent Campaigns"
          rows={data.recent_campaigns}
          renderItem={(r) => (
            <div className="flex items-center justify-between py-2.5 border-b border-slate-100 last:border-b-0 gap-2" key={r.id}>
              <div className="text-sm font-medium text-slate-900 truncate">{r.name}</div>
              <Badge tone={r.status === "sent" ? "success" : r.status === "sending" ? "warning" : "neutral"}>
                {r.status}
              </Badge>
            </div>
          )}
          empty="No campaigns yet"
        />
      </div>
    </div>
  );
}

function RecentList({ title, rows, renderItem, empty }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="font-display text-sm font-semibold text-slate-900">{title}</div>
        <ArrowUpRight size={14} className="text-slate-300" />
      </div>
      <div>
        {rows && rows.length > 0 ? rows.map(renderItem) : (
          <div className="text-sm text-slate-400 py-4 text-center">{empty}</div>
        )}
      </div>
    </Card>
  );
}
