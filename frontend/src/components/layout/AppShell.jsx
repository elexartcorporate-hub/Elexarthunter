import { NavLink, useNavigate } from "react-router-dom";
import {
  ChartLineUp,
  UsersFour,
  EnvelopeOpen,
  ListChecks,
  Gear,
  SignOut,
  Buildings,
  Lightning,
  Tray,
} from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";

const NAV = [
  { to: "/",           label: "Dashboard",       icon: ChartLineUp,  perm: "dashboard",      testid: "nav-dashboard" },
  { to: "/prospects",  label: "Prospects",       icon: UsersFour,    perm: "prospects",      testid: "nav-prospects" },
  { to: "/inbox",      label: "Inbox",           icon: Tray,         perm: "inbox",          testid: "nav-inbox" },
  { to: "/activity",   label: "Email Activity",  icon: EnvelopeOpen, perm: "email_activity", testid: "nav-activity" },
  { to: "/templates",  label: "Templates",       icon: ListChecks,   perm: "templates",      testid: "nav-templates" },
  { to: "/settings",   label: "Settings",        icon: Gear,         perm: "settings",       testid: "nav-settings" },
];

export default function AppShell({ children }) {
  const { user, tenant, logout, hasPermission } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const visibleNav = NAV.filter((n) => hasPermission(n.perm));
  const initials = (user?.name || "U").split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();

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
        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {visibleNav.map((item) => (
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
          ))}
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
