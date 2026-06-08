import { NavLink, useNavigate } from "react-router-dom";
import {
  Crosshair,
  ChartLineUp,
  Database,
  EnvelopeSimple,
  Gear,
  SignOut,
  Terminal,
  Buildings,
} from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";

const NAV = [
  { to: "/",         label: "Dashboard",       icon: ChartLineUp,    perm: "dashboard",       testid: "nav-dashboard" },
  { to: "/hunter",   label: "Hunter",          icon: Crosshair,      perm: "hunter",          testid: "nav-hunter" },
  { to: "/database", label: "Database",        icon: Database,       perm: "database",        testid: "nav-database" },
  { to: "/email",    label: "Email Marketing", icon: EnvelopeSimple, perm: "email_marketing", testid: "nav-email" },
  { to: "/settings", label: "Settings",        icon: Gear,           perm: "settings",        testid: "nav-settings" },
];

export default function AppShell({ children }) {
  const { user, tenant, logout, hasPermission } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  const visibleNav = NAV.filter((n) => hasPermission(n.perm));

  return (
    <div className="min-h-screen flex bg-background text-foreground">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-zinc-200 bg-white flex flex-col">
        <div className="px-5 py-5 border-b border-zinc-200 flex items-center gap-2">
          <Terminal size={22} weight="bold" className="text-green-500" />
          <div>
            <div className="font-display font-bold text-base tracking-tight">
              LEAD<span className="text-green-500">HUNTER</span>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
              v1.0 · terminal mode
            </div>
          </div>
        </div>

        <nav className="flex-1 py-4 space-y-1 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              data-testid={item.testid}
              className={({ isActive }) =>
                `group flex items-center gap-3 px-3 py-2 text-sm font-medium transition-all border-l-2 ${
                  isActive
                    ? "border-green-500 bg-green-500/10 text-green-400"
                    : "border-transparent text-zinc-500 hover:text-green-400 hover:bg-zinc-50"
                }`
              }
            >
              <item.icon size={18} weight="bold" />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="px-3 py-3 border-t border-zinc-200 space-y-2">
          <div className="px-2">
            <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono uppercase tracking-widest mb-1">
              <Buildings size={12} weight="bold" />
              Tenant
            </div>
            <div className="text-sm text-zinc-900 truncate" data-testid="tenant-name">
              {tenant?.company_name || "—"}
            </div>
          </div>
          <div className="px-2">
            <div className="text-[11px] font-mono uppercase tracking-widest text-zinc-500">User</div>
            <div className="text-sm text-zinc-900 truncate" data-testid="user-name">{user?.name}</div>
            <div className="text-xs text-zinc-500 truncate">{user?.email}</div>
            <div className="mt-1 inline-block text-[10px] font-mono uppercase border border-green-500/30 bg-green-500/10 text-green-400 px-1.5 py-0.5">
              {user?.role}
            </div>
          </div>
          <button
            onClick={handleLogout}
            data-testid="logout-btn"
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors border border-zinc-200 hover:border-red-500/30"
          >
            <SignOut size={16} weight="bold" /> Logout
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 min-w-0 overflow-x-auto">{children}</main>
    </div>
  );
}
