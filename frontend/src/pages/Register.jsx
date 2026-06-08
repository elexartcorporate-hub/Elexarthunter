import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lightning } from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";
import { TermInput, PrimaryButton } from "@/components/term";
import { formatApiError } from "@/lib/api";
import { toast } from "sonner";

export default function Register() {
  const [form, setForm] = useState({ name: "", email: "", password: "", company_name: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { register } = useAuth();
  const navigate = useNavigate();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const onSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register(form);
      toast.success("Workspace created — welcome!");
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
          <h1 className="font-display text-2xl font-bold text-slate-900">Create your workspace</h1>
          <p className="text-sm text-slate-500 mt-1">You'll be the Owner with full access</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-8">
          <form onSubmit={onSubmit} className="space-y-4">
            <TermInput label="Your Name" placeholder="Jane Doe" value={form.name} onChange={set("name")} required data-testid="register-name" />
            <TermInput label="Company / Workspace Name" placeholder="Acme Inc" value={form.company_name} onChange={set("company_name")} required data-testid="register-company" />
            <TermInput label="Work Email" type="email" placeholder="you@company.com" value={form.email} onChange={set("email")} required data-testid="register-email" />
            <TermInput label="Password" type="password" placeholder="Min 6 characters" value={form.password} onChange={set("password")} required minLength={6} data-testid="register-password" />
            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 px-3 py-2.5 rounded-lg">{error}</div>
            )}
            <PrimaryButton type="submit" disabled={loading} className="w-full" data-testid="register-submit">
              {loading ? "Creating workspace..." : "Create workspace"}
            </PrimaryButton>
          </form>

          <div className="mt-6 text-center text-sm text-slate-500">
            Already have an account?{" "}
            <Link to="/login" className="text-indigo-600 hover:text-indigo-700 font-medium" data-testid="link-login">
              Sign in
            </Link>
          </div>
        </div>

        <div className="text-center text-xs text-slate-400 mt-6">
          Your data is isolated by workspace — never shared across tenants
        </div>
      </div>
    </div>
  );
}
