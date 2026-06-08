import { createContext, useContext, useState, useEffect } from "react";
import { api } from "@/lib/api";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem("lh_token");
    if (!t) {
      setLoading(false);
      return;
    }
    api
      .get("/auth/me")
      .then((r) => {
        setUser(r.data.user);
        setTenant(r.data.tenant);
      })
      .catch(() => {
        localStorage.removeItem("lh_token");
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email, password) => {
    const { data } = await api.post("/auth/login", { email, password });
    localStorage.setItem("lh_token", data.token);
    setUser(data.user);
    setTenant(data.tenant);
    return data;
  };

  const register = async (payload) => {
    const { data } = await api.post("/auth/register", payload);
    localStorage.setItem("lh_token", data.token);
    setUser(data.user);
    setTenant(data.tenant);
    return data;
  };

  const logout = async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* ignore */
    }
    localStorage.removeItem("lh_token");
    setUser(null);
    setTenant(null);
  };

  const refreshTenant = async () => {
    const { data } = await api.get("/auth/me");
    setTenant(data.tenant);
  };

  return (
    <AuthCtx.Provider value={{ user, tenant, loading, login, register, logout, refreshTenant }}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
