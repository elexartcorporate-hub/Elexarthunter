import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { useEffect, useState, useRef } from "react";
import {
  ChartLineUp,
  UsersFour,
  ListChecks,
  Gear,
  SignOut,
  Buildings,
  Lightning,
  Tray,
  WhatsappLogo,
  LinkedinLogo,
  CaretDown,
  CaretRight,
} from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";

// Sub-items under WhatsApp accordion. `filter` value maps to WhatsApp.jsx pipelineFilter.
const WA_SUB = [
  { filter: "follow_up", label: "Follow Up", emoji: "⏰", testid: "nav-wa-followup" },
  { filter: "hot",       label: "Hot",       emoji: "🔥", testid: "nav-wa-hot" },
  { filter: "warm",      label: "Warm",      emoji: "☀️", testid: "nav-wa-warm" },
  { filter: "cold",      label: "Cold",      emoji: "❄️", testid: "nav-wa-cold" },
  { filter: "deal",      label: "Deal",      emoji: "✅", testid: "nav-wa-deal" },
  { filter: "lost",      label: "Lost",      emoji: "✗",  testid: "nav-wa-lost" },
];

const NAV = [
  { to: "/",           label: "Dashboard", icon: ChartLineUp,  perm: "dashboard", testid: "nav-dashboard" },
  { type: "wa-accordion", perm: "inbox" }, // custom accordion
  { to: "/prospects",  label: "Prospects", icon: UsersFour,    perm: "prospects", testid: "nav-prospects" },
  { to: "/linkedin",   label: "LinkedIn",  icon: LinkedinLogo, perm: "prospects", testid: "nav-linkedin" },
  { to: "/inbox",      label: "Inbox",     icon: Tray,         perm: "inbox",     testid: "nav-inbox" },
  { to: "/templates",  label: "Templates", icon: ListChecks,   perm: "templates", testid: "nav-templates" },
  { to: "/settings",   label: "Settings",  icon: Gear,         perm: "settings",  testid: "nav-settings" },
];

// Badge component — pill w/ count. Compact for sidebar.
function Badge({ count, tone = "rose" }) {
  if (!count || count <= 0) return null;
  const toneCls = {
    rose:    "bg-rose-500 text-white",
    amber:   "bg-amber-500 text-white",
    emerald: "bg-emerald-500 text-white",
    slate:   "bg-slate-200 text-slate-700",
  }[tone] || "bg-rose-500 text-white";
  return (
    <span className={`ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[10px] font-bold ${toneCls}`}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

export default function AppShell({ children }) {
  const { user, tenant, logout, hasPermission } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  // WA accordion — open state persisted in localStorage
  const [waOpen, setWaOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("nav_wa_open") === "1" || location.pathname.startsWith("/whatsapp");
  });
  useEffect(() => {
    try { localStorage.setItem("nav_wa_open", waOpen ? "1" : "0"); } catch (_) { /* noop */ }
  }, [waOpen]);
  // Auto-open when navigating to /whatsapp
  useEffect(() => {
    if (location.pathname.startsWith("/whatsapp")) setWaOpen(true);
  }, [location.pathname]);

  // WA counts — poll pipeline/counts every 20s for badge freshness
  const [waCounts, setWaCounts] = useState({ unread: 0, follow_up: 0, hot: 0, warm: 0, cold: 0, deal: 0, lost: 0 });
  const pollRef = useRef(null);
  useEffect(() => {
    if (!hasPermission("inbox")) return;
    let cancelled = false;
    const fetchCounts = async () => {
      try {
        const { data } = await api.get("/whatsapp/pipeline/counts");
        if (!cancelled) setWaCounts((prev) => ({ ...prev, ...data }));
      } catch (_) { /* silent — sidebar badges are best-effort */ }
    };
    fetchCounts();
    pollRef.current = setInterval(fetchCounts, 20000);
    return () => { cancelled = true; if (pollRef.current) clearInterval(pollRef.current); };
  }, [hasPermission]);

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const visibleNav = NAV.filter((n) => hasPermission(n.perm));
  const initials = (user?.name || "U").split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

  const currentWaFilter = (() => {
    try {
      const url = new URL(window.location.href);
      return url.searchParams.get("filter") || "";
    } catch (_) { return ""; }
  })();
  const isWaActive = location.pathname.startsWith("/whatsapp");

  return (
    <div className="min-h-screen flex bg-slate-50/60 text-slate-900">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        {/* Brand */}
        <div className="px-5 py-5 border-b border-slate-100 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-sm">
            <Lightning size={18} weight="fill" className="text-white" />
          </div>
          <div>
            <div className="font-display font-bold text-base text-slate-900 leading-tight">LeadHunter</div>
            <div className="text-[11px] text-slate-500 leading-tight">Email discovery suite</div>
          </div>
        </div>

        {/* Tenant pill */}
        <div className="px-3 pt-4 pb-2">
          <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-slate-50 border border-slate-100">
            <div className="w-7 h-7 rounded-md bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold">
              <Buildings size={14} weight="bold" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">Workspace</div>
              <div className="text-sm font-medium text-slate-900 truncate" data-testid="tenant-name">
                {tenant?.company_name || "—"}
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {visibleNav.map((item, idx) => {
            // ── WhatsApp Accordion ──
            if (item.type === "wa-accordion") {
              return (
                <div key="wa-accordion" data-testid="nav-whatsapp-accordion">
                  <button
                    type="button"
                    onClick={() => {
                      setWaOpen((o) => !o);
                      // If not on /whatsapp yet, navigate on open
                      if (!waOpen && !isWaActive) navigate("/whatsapp");
                    }}
                    data-testid="nav-whatsapp"
                    className={`w-full group flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-all ${
                      isWaActive
                        ? "bg-indigo-50 text-indigo-700"
                        : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                    }`}
                  >
                    <WhatsappLogo size={18} weight={isWaActive ? "fill" : "regular"} />
                    <span>WhatsApp</span>
                    <Badge count={waCounts.unread} tone="rose" />
                    <span className={`${waCounts.unread > 0 ? "" : "ml-auto"} text-slate-400`}>
                      {waOpen ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
                    </span>
                  </button>
                  {waOpen && (
                    <div className="ml-3 mt-0.5 pl-3 border-l border-slate-200 space-y-0.5" data-testid="nav-whatsapp-submenu">
                      {WA_SUB.map((s) => {
                        const active = isWaActive && currentWaFilter === s.filter;
                        const count = waCounts[s.filter] || 0;
                        return (
                          <button
                            key={s.filter}
                            type="button"
                            data-testid={s.testid}
                            onClick={() => navigate(`/whatsapp?filter=${s.filter}`)}
                            className={`w-full flex items-center gap-2 px-3 py-2 text-xs font-medium rounded-lg transition-all ${
                              active
                                ? "bg-indigo-50 text-indigo-700"
                                : "text-slate-500 hover:text-slate-900 hover:bg-slate-50"
                            }`}
                          >
                            <span className="text-sm">{s.emoji}</span>
                            <span>{s.label}</span>
                            <Badge count={count} tone={s.filter === "follow_up" ? "amber" : "slate"} />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }
            // ── Standard NavLink ──
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === "/"}
                data-testid={item.testid}
                className={({ isActive }) =>
                  `group flex items-center gap-3 px-3 py-2.5 text-sm font-medium rounded-lg transition-all ${
                    isActive
                      ? "bg-indigo-50 text-indigo-700"
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <item.icon size={18} weight={isActive ? "fill" : "regular"} />
                    <span>{item.label}</span>
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* User footer */}
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-slate-50 transition-colors mb-1">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-500 text-white flex items-center justify-center text-xs font-semibold shadow-sm">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-900 truncate" data-testid="user-name">{user?.name}</div>
              <div className="text-[11px] text-slate-500 truncate">{user?.email}</div>
            </div>
            <span className="text-[10px] uppercase tracking-wider font-bold bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded">
              {user?.role}
            </span>
          </div>
          <button
            onClick={handleLogout}
            data-testid="logout-btn"
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
          >
            <SignOut size={16} weight="regular" /> Sign out
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-x-auto">{children}</main>
    </div>
  );
}
