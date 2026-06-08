import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { PageHeader, Card, Badge } from "@/components/term";
import {
  Buildings,
  UsersThree,
  EnvelopeOpen,
  TrendUp,
  PaperPlaneTilt,
  ChartLineUp,
  ChatTeardropDots,
  Warning,
} from "@phosphor-icons/react";
import {
  LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area,
} from "recharts";

const KPIS = [
  { key: "total_companies",   label: "Total Companies",    icon: Buildings,      tone: "text-green-400",  suffix: "" },
  { key: "total_contacts",    label: "Total Contacts",     icon: UsersThree,     tone: "text-green-400",  suffix: "" },
  { key: "total_emails_found",label: "Emails Found",       icon: EnvelopeOpen,   tone: "text-cyan-400",   suffix: "" },
  { key: "new_leads_today",   label: "New Leads Today",    icon: TrendUp,        tone: "text-green-300",  suffix: "" },
  { key: "emails_sent_today", label: "Emails Sent Today",  icon: PaperPlaneTilt, tone: "text-cyan-300",   suffix: "" },
  { key: "open_rate",         label: "Open Rate",          icon: ChartLineUp,    tone: "text-green-400",  suffix: "%" },
  { key: "reply_rate",        label: "Reply Rate",         icon: ChatTeardropDots,tone: "text-green-400", suffix: "%" },
  { key: "bounce_rate",       label: "Bounce Rate",        icon: Warning,        tone: "text-red-400",    suffix: "%" },
];

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/dashboard/overview").then((r) => setData(r.data)).finally(() => setLoading(false));
  }, []);

  if (loading)
    return (
      <div className="p-10 font-mono text-green-500 text-sm">Loading dashboard... [||||  ]</div>
    );

  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader
        title="Dashboard"
        subtitle="$ overview --period 14d"
      />

      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" data-testid="kpi-grid">
        {KPIS.map((k) => {
          const v = data.cards[k.key];
          return (
            <Card key={k.key} className="p-4 hover:border-zinc-300 transition-colors">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">{k.label}</span>
                <k.icon size={16} weight="bold" className={k.tone} />
              </div>
              <div className={`font-mono text-2xl font-bold ${k.tone}`}>
                {v}{k.suffix}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-6">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-xs uppercase tracking-widest text-zinc-500">Leads Growth · 14d</div>
            <Badge tone="success">live</Badge>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={data.trends}>
              <defs>
                <linearGradient id="leadsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="label" stroke="#71717a" fontSize={10} />
              <YAxis stroke="#71717a" fontSize={10} />
              <Tooltip contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", fontSize: 12 }} />
              <Area type="monotone" dataKey="leads" stroke="#22c55e" strokeWidth={2} fill="url(#leadsGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-mono text-xs uppercase tracking-widest text-zinc-500">Emails Sent Trend · 14d</div>
            <Badge tone="info">14d</Badge>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={data.trends}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="label" stroke="#71717a" fontSize={10} />
              <YAxis stroke="#71717a" fontSize={10} />
              <Tooltip contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", fontSize: 12 }} />
              <Line type="monotone" dataKey="sent" stroke="#06b6d4" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      {/* Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <RecentList
          title="Recent Searches"
          rows={data.recent_searches}
          renderItem={(r) => (
            <div className="flex items-center justify-between" key={r.id}>
              <span className="font-mono text-xs text-zinc-700 truncate">{r.domain}</span>
              <Badge tone={r.from_cache ? "info" : "success"}>{r.contacts_found || 0}</Badge>
            </div>
          )}
          empty="No searches yet."
        />
        <RecentList
          title="Recent Leads"
          rows={data.recent_leads}
          renderItem={(r) => (
            <div className="flex items-center justify-between gap-2" key={r.id}>
              <div className="min-w-0">
                <div className="font-mono text-xs text-zinc-900 truncate">{r.email}</div>
                <div className="text-[10px] text-zinc-500 truncate">{r.name || r.job_title || "—"}</div>
              </div>
              <Badge tone={r.confidence_score >= 80 ? "success" : r.confidence_score >= 50 ? "warning" : "error"}>
                {r.confidence_score}
              </Badge>
            </div>
          )}
          empty="No leads yet. Run a Hunter search!"
        />
        <RecentList
          title="Recent Campaigns"
          rows={data.recent_campaigns}
          renderItem={(r) => (
            <div className="flex items-center justify-between gap-2" key={r.id}>
              <span className="text-xs text-zinc-900 truncate">{r.name}</span>
              <Badge tone={r.status === "sent" ? "success" : r.status === "sending" ? "warning" : "neutral"}>
                {r.status}
              </Badge>
            </div>
          )}
          empty="No campaigns yet."
        />
      </div>
    </div>
  );
}

function RecentList({ title, rows, renderItem, empty }) {
  return (
    <Card className="p-4">
      <div className="font-mono text-xs uppercase tracking-widest text-zinc-500 mb-3">{title}</div>
      <div className="space-y-2">
        {rows && rows.length > 0 ? rows.map(renderItem) : (
          <div className="text-xs text-zinc-400 font-mono py-3">{empty}</div>
        )}
      </div>
    </Card>
  );
}
