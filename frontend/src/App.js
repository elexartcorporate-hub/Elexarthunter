import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import AppShell from "@/components/layout/AppShell";

import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Dashboard from "@/pages/Dashboard";
import Prospects from "@/pages/Prospects";
import ProspectDetail from "@/pages/ProspectDetail";
import EmailActivity from "@/pages/EmailActivity";
import Templates from "@/pages/Templates";
import Settings from "@/pages/Settings";
import "@/index.css";

function Protected() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="font-mono text-green-600">Loading... [|||      ]</div>
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function PermRoute({ perm, children }) {
  const { user, hasPermission } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (!hasPermission(perm)) return <Navigate to="/" replace />;
  return children;
}

function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return children;
}

/**
 * Auto-detect new deploys: fetch /build-info.json every page-load + every 60s.
 * If version differs from localStorage, clear EVERYTHING (token, cache) and
 * hard-reload. This guarantees that every user sees the latest UI immediately
 * after `deploy` is run on the server.
 */
function useVersionCheck() {
  useEffect(() => {
    let mounted = true;
    const check = async () => {
      try {
        const r = await fetch("/build-info.json?t=" + Date.now(), { cache: "no-store" });
        if (!r.ok) return;
        const info = await r.json();
        const current = info.version;
        const stored = localStorage.getItem("lh_build_version");
        if (!stored) {
          localStorage.setItem("lh_build_version", current);
          return;
        }
        if (stored !== current && mounted) {
          // New deploy detected → clear everything and hard reload
          const keys = Object.keys(localStorage);
          keys.forEach((k) => localStorage.removeItem(k));
          sessionStorage.clear();
          // Clear cookies as well
          document.cookie.split(";").forEach((c) => {
            const eq = c.indexOf("=");
            const name = eq > -1 ? c.substr(0, eq).trim() : c.trim();
            document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/";
          });
          localStorage.setItem("lh_build_version", current);
          window.location.reload(true);
        }
      } catch {
        /* ignore */
      }
    };
    check();
    const t = setInterval(check, 60_000); // every minute
    return () => {
      mounted = false;
      clearInterval(t);
    };
  }, []);
}

export default function App() {
  useVersionCheck();
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

          <Route element={<Protected />}>
            <Route path="/" element={<PermRoute perm="dashboard"><Dashboard /></PermRoute>} />
            <Route path="/prospects" element={<PermRoute perm="prospects"><Prospects /></PermRoute>} />
            <Route path="/prospects/:id" element={<PermRoute perm="prospects"><ProspectDetail /></PermRoute>} />
            <Route path="/activity" element={<PermRoute perm="email_activity"><EmailActivity /></PermRoute>} />
            <Route path="/templates" element={<PermRoute perm="templates"><Templates /></PermRoute>} />
            <Route path="/settings" element={<PermRoute perm="settings"><Settings /></PermRoute>} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster theme="light" richColors position="top-right" />
      </BrowserRouter>
    </AuthProvider>
  );
}
