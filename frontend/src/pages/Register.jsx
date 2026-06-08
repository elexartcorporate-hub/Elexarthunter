import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Terminal } from "@phosphor-icons/react";
import { useAuth } from "@/contexts/AuthContext";
import { TermInput, PrimaryButton } from "@/components/term";
import { formatApiError } from "@/lib/api";
import { toast } from "sonner";

export default function Register() {
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    company_name: "",
  });
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
      toast.success("Tenant created. Welcome!");
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
    <div className="min-h-screen flex items-center justify-center bg-background relative overflow-hidden p-4">
      <div className="absolute inset-0 grid-bg opacity-40" />
      <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-transparent to-green-500/5" />

      <div className="relative w-full max-w-md fade-up">
        <div className="flex items-center gap-2 mb-6 justify-center">
          <Terminal size={28} weight="bold" className="text-green-500" />
          <span className="font-display text-2xl font-bold tracking-tight">
            LEAD<span className="text-green-500">HUNTER</span>
          </span>
        </div>

        <div className="bg-zinc-950/80 backdrop-blur border border-zinc-800 rounded-sm p-7">
          <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500 mb-1">
            $ tenant/create
          </div>
          <h1 className="font-display text-xl text-zinc-100 mb-6 blinking-cursor">New tenant</h1>

          <form onSubmit={onSubmit} className="space-y-4">
            <TermInput label="Your Name" placeholder="Jane Doe" value={form.name} onChange={set("name")} required data-testid="register-name" />
            <TermInput label="Company / Tenant Name" placeholder="Acme Inc" value={form.company_name} onChange={set("company_name")} required data-testid="register-company" />
            <TermInput label="Email" type="email" placeholder="you@company.com" value={form.email} onChange={set("email")} required data-testid="register-email" />
            <TermInput label="Password" type="password" placeholder="min 6 chars" value={form.password} onChange={set("password")} required minLength={6} data-testid="register-password" />
            {error && (
              <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 px-3 py-2 rounded-sm">
                {error}
              </div>
            )}
            <PrimaryButton type="submit" disabled={loading} className="w-full" data-testid="register-submit">
              {loading ? "Provisioning..." : "Create tenant →"}
            </PrimaryButton>
          </form>

          <div className="mt-5 text-center text-xs text-zinc-500 font-mono">
            Already have access?{" "}
            <Link to="/login" className="text-green-400 hover:text-green-300" data-testid="link-login">
              sign_in()
            </Link>
          </div>
        </div>

        <div className="text-center text-[10px] font-mono text-zinc-600 mt-4 uppercase tracking-widest">
          You become Owner. Data isolated by tenant_id.
        </div>
      </div>
    </div>
  );
}
