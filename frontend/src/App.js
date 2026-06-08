import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import AppShell from "@/components/layout/AppShell";

import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Dashboard from "@/pages/Dashboard";
import Hunter from "@/pages/Hunter";
import Database from "@/pages/Database";
import EmailMarketing from "@/pages/EmailMarketing";
import Settings from "@/pages/Settings";
import "@/index.css";

function Protected() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="font-mono text-green-500">Loading... [|||      ]</div>
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

          <Route element={<Protected />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/hunter" element={<Hunter />} />
            <Route path="/database" element={<Database />} />
            <Route path="/email" element={<EmailMarketing />} />
            <Route path="/settings" element={<Settings />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <Toaster theme="dark" richColors position="top-right" />
      </BrowserRouter>
    </AuthProvider>
  );
}
