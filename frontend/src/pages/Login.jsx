import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lightning } from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";
import { TermInput, PrimaryButton } from "@/components/term";
import { formatApiError } from "@/lib/api";
import { toast } from "sonner";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { login } = useAuth();
  const navigate = useNavigate();

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      toast.success("Welcome back");
      navigate("/");
    } catch (err) {
      const msg = formatApiError(err);
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 relative overflow-hidden p-4">
      <div className="absolute inset-0 gradient-blob-1" />
      <div className="absolute inset-0 dot-bg opacity-50" />

      <div className="relative w-full max-w-md fade-up">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-lg shadow-indigo-200 mb-3">
            <Lightning size={24} weight="fill" className="text-white" />
          </div>
          <h1 className="font-display text-2xl font-bold text-slate-900">Welcome back</h1>
          <p className="text-sm text-slate-500 mt-1">Sign in to your LeadHunter workspace</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
          <form onSubmit={onSubmit} className="space-y-4">
            <TermInput
              label="Email"
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="login-email"
            />
            <TermInput
              label="Password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              data-testid="login-password"
            />
            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 px-3 py-2.5 rounded-lg">
                {error}
              </div>
            )}
            <PrimaryButton
              type="submit"
              disabled={loading}
              className="w-full"
              data-testid="login-submit"
            >
              {loading ? "Signing in..." : "Sign in"}
            </PrimaryButton>
          </form>

          <div className="mt-6 text-center text-sm text-slate-500">
            Don't have an account?{" "}
            <Link to="/register" className="text-indigo-600 hover:text-indigo-700 font-medium" data-testid="link-register">
              Create one
            </Link>
          </div>
        </div>

        <div className="text-center text-xs text-slate-400 mt-6">
          Multi-tenant SaaS · Encrypted · Privacy-first
        </div>
      </div>
    </div>
  );
}
