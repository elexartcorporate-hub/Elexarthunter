import { useEffect, useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermSelect, PrimaryButton, GhostButton, Badge, ConfidenceBadge, StatusBadge, EmptyState } from "@/components/term";
import { Buildings, UsersThree, Trash, MagnifyingGlass, ArrowsClockwise, DownloadSimple } from "@phosphor-icons/react";
import { toast } from "sonner";

export default function Database() {
  const [tab, setTab] = useState("companies");
  const [companies, setCompanies] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    q: "",
    industry: "",
    country: "",
    source: "",
    status: "",
    min_score: "",
  });

  const load = async () => {
    setLoading(true);
    try {
      if (tab === "companies") {
        const params = {};
        if (filters.q) params.q = filters.q;
        if (filters.industry) params.industry = filters.industry;
        if (filters.country) params.country = filters.country;
        const { data } = await api.get("/companies", { params });
        setCompanies(data);
      } else {
        const params = {};
        if (filters.q) params.q = filters.q;
        if (filters.industry) params.industry = filters.industry;
        if (filters.country) params.country = filters.country;
        if (filters.source) params.source = filters.source;
        if (filters.status) params.status = filters.status;
        if (filters.min_score) params.min_score = filters.min_score;
        const { data } = await api.get("/contacts", { params });
        setContacts(data);
      }
    } catch (err) {
      toast.error(formatApiError(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [tab]);

  const delCompany = async (id) => {
    if (!window.confirm("Delete company and all its contacts?")) return;
    try {
      await api.delete(`/companies/${id}`);
      toast.success("Deleted");
      load();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const delContact = async (id) => {
    if (!window.confirm("Delete contact?")) return;
    try {
      await api.delete(`/contacts/${id}`);
      toast.success("Deleted");
      load();
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const exportCsv = () => {
    const rows = tab === "companies" ? companies : contacts;
    if (!rows.length) return toast.error("Nothing to export");
    const headers = tab === "companies"
      ? ["company_name", "domain", "industry", "country", "phone", "linkedin", "contacts_count"]
      : ["email", "name", "job_title", "company_name", "company_domain", "industry", "source", "confidence_score", "status"];
    const csv = [
      headers.join(","),
      ...rows.map((r) => headers.map((h) => `"${(r[h] ?? "").toString().replace(/"/g, '""')}"`).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${tab}-${Date.now()}.csv`;
    a.click();
  };

  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader
        title="Database"
        subtitle="$ db --master-leads"
        action={
          <div className="flex gap-2">
            <GhostButton onClick={exportCsv} data-testid="export-csv-btn"><DownloadSimple size={14} weight="bold" /> Export CSV</GhostButton>
            <GhostButton onClick={load} disabled={loading} data-testid="refresh-btn"><ArrowsClockwise size={14} weight="bold" /> Reload</GhostButton>
          </div>
        }
      />

      <div className="flex border border-zinc-200 rounded-sm overflow-hidden w-fit mb-5">
        <TabBtn active={tab === "companies"} onClick={() => setTab("companies")} icon={Buildings} label={`Companies (${companies.length})`} testid="tab-companies" />
        <TabBtn active={tab === "contacts"} onClick={() => setTab("contacts")} icon={UsersThree} label={`Contacts (${contacts.length})`} testid="tab-contacts" />
      </div>

      <Card className="p-4 mb-4">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="md:col-span-2 relative">
            <TermInput
              label="Search"
              placeholder={tab === "companies" ? "company.com / name" : "email / name"}
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              data-testid="filter-q"
            />
          </div>
          <TermInput label="Industry" value={filters.industry} onChange={(e) => setFilters({ ...filters, industry: e.target.value })} data-testid="filter-industry" />
          <TermInput label="Country" value={filters.country} onChange={(e) => setFilters({ ...filters, country: e.target.value })} data-testid="filter-country" />
          {tab === "contacts" && (
            <>
              <TermSelect label="Source" value={filters.source} onChange={(e) => setFilters({ ...filters, source: e.target.value })} data-testid="filter-source">
                <option value="">all</option>
                <option value="website">website</option>
                <option value="hunter">hunter</option>
                <option value="manual">manual</option>
              </TermSelect>
              <TermInput label="Min Score" type="number" value={filters.min_score} onChange={(e) => setFilters({ ...filters, min_score: e.target.value })} data-testid="filter-min-score" />
            </>
          )}
        </div>
        <div className="mt-3">
          <PrimaryButton onClick={load} data-testid="apply-filters-btn"><MagnifyingGlass size={14} weight="bold" /> Apply</PrimaryButton>
        </div>
      </Card>

      {tab === "companies" ? (
        companies.length === 0 ? (
          <EmptyState title="No companies yet" description="Run a Hunter search to populate your database." />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="companies-table">
                <thead className="bg-zinc-50 text-zinc-500 text-[10px] uppercase tracking-widest font-mono">
                  <tr>
                    <th className="text-left p-3">Company</th>
                    <th className="text-left p-3">Domain</th>
                    <th className="text-left p-3">Industry</th>
                    <th className="text-left p-3">Country</th>
                    <th className="text-left p-3">Phone</th>
                    <th className="text-right p-3">Contacts</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {companies.map((c) => (
                    <tr key={c.id} className="border-t border-zinc-200/60 hover:bg-zinc-50/40">
                      <td className="p-3 text-zinc-900">{c.company_name || "—"}</td>
                      <td className="p-3 font-mono text-xs text-green-400">{c.domain}</td>
                      <td className="p-3 text-zinc-500">{c.industry || "—"}</td>
                      <td className="p-3 text-zinc-500">{c.country || "—"}</td>
                      <td className="p-3 font-mono text-xs text-zinc-500">{c.phone || "—"}</td>
                      <td className="p-3 text-right"><Badge tone="success">{c.contacts_count}</Badge></td>
                      <td className="p-3 text-right">
                        <button onClick={() => delCompany(c.id)} className="text-zinc-500 hover:text-red-400" data-testid={`del-company-${c.id}`}>
                          <Trash size={14} weight="bold" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      ) : contacts.length === 0 ? (
        <EmptyState title="No contacts yet" description="Discover emails through Hunter to fill your database." />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="contacts-table">
              <thead className="bg-zinc-50 text-zinc-500 text-[10px] uppercase tracking-widest font-mono">
                <tr>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Title</th>
                  <th className="text-left p-3">Company</th>
                  <th className="text-left p-3">Source</th>
                  <th className="text-left p-3">Score</th>
                  <th className="text-left p-3">Status</th>
                  <th className="text-right p-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id} className="border-t border-zinc-200/60 hover:bg-zinc-50/40">
                    <td className="p-3 font-mono text-xs text-zinc-900">{c.email}</td>
                    <td className="p-3 text-zinc-700">{c.name || "—"}</td>
                    <td className="p-3 text-zinc-500">{c.job_title || "—"}</td>
                    <td className="p-3 text-zinc-500">{c.company_name || c.company_domain || "—"}</td>
                    <td className="p-3"><Badge tone={c.source === "website" ? "success" : c.source === "hunter" ? "info" : "neutral"}>{c.source}</Badge></td>
                    <td className="p-3"><ConfidenceBadge score={c.confidence_score} /></td>
                    <td className="p-3"><StatusBadge status={c.status} /></td>
                    <td className="p-3 text-right">
                      <button onClick={() => delContact(c.id)} className="text-zinc-500 hover:text-red-400" data-testid={`del-contact-${c.id}`}>
                        <Trash size={14} weight="bold" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2 text-xs font-mono uppercase tracking-widest flex items-center gap-2 transition-colors border-r border-zinc-200 last:border-r-0 ${
        active ? "bg-green-500/10 text-green-400" : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-50"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}
