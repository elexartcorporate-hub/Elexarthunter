import { useState, useEffect } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermTextarea, TermSelect, PrimaryButton, GhostButton, Badge, ConfidenceBadge, EmptyState } from "@/components/term";
import { Crosshair, Lightning, Files, CheckCircle, XCircle, Spinner, ArrowsCounterClockwise, BookmarkSimple, Clock, Plus, Trash, X, Tag, MapPin } from "@phosphor-icons/react";
import { toast } from "sonner";

const PIPELINE = [
  "Check Global Database",
  "Playwright Deep Crawl",
  "Hunter.io Domain Search [MOCK]",
  "Data Merge",
  "Confidence Scoring",
  "Database Validation",
  "Save to Database",
];

export default function Hunter() {
  const [tab, setTab] = useState("single");
  const [domain, setDomain] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [logs, setLogs] = useState([]);
  const [stepStatus, setStepStatus] = useState({});
  const [bulkJob, setBulkJob] = useState(null);
  const [bulkPolling, setBulkPolling] = useState(false);
  // New states for history + my leads + modal
  const [history, setHistory] = useState([]);
  const [myLeads, setMyLeads] = useState([]);
  const [addModal, setAddModal] = useState(null); // { company, contacts }
  const [categories, setCategories] = useState([]);
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    api.get("/hunter-settings/categories").then((r) => setCategories(r.data)).catch(() => {});
    api.get("/hunter-settings/locations").then((r) => setLocations(r.data)).catch(() => {});
  }, []);

  const loadSearchHistory = async () => {
    try {
      const { data } = await api.get("/hunter/searches", { params: { limit: 100 } });
      setHistory(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };
  const loadMyLeads = async () => {
    try {
      const { data } = await api.get("/my-leads");
      setMyLeads(data);
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const openAddModal = async (companyDomain) => {
    try {
      // Find company by domain in companies list
      const { data: comps } = await api.get("/companies", { params: { q: companyDomain } });
      const comp = comps.find((c) => c.domain === companyDomain) || comps[0];
      if (!comp) return toast.error("Company not found");
      const { data: detail } = await api.get(`/companies/${comp.id}`);
      setAddModal({ company: detail.company, contacts: detail.contacts });
    } catch (err) { toast.error(formatApiError(err)); }
  };

  const openAddModalFromResult = () => {
    if (!result) return;
    api.get("/companies", { params: { q: result.company.domain } }).then(({ data: comps }) => {
      const comp = comps.find((c) => c.domain === result.company.domain) || comps[0];
      if (!comp) return toast.error("Company not yet saved");
      setAddModal({ company: comp, contacts: result.contacts.map((c, i) => ({ ...c, id: c.id || `tmp-${i}` })) });
      // Refetch contacts with real DB ids
      api.get(`/companies/${comp.id}`).then(({ data }) => {
        setAddModal({ company: data.company, contacts: data.contacts });
      });
    });
  };

  const deleteLead = async (id) => {
    if (!window.confirm("Remove this lead from your list?")) return;
    try { await api.delete(`/my-leads/${id}`); toast.success("Removed"); loadMyLeads(); }
    catch (err) { toast.error(formatApiError(err)); }
  };

  const handleSingle = async (force = false) => {
    if (!domain.trim()) return toast.error("Enter a domain");
    setLoading(true);
    setLogs(["> Initiating hunter pipeline...", `> Target: ${domain.trim()}`]);
    setStepStatus(Object.fromEntries(PIPELINE.map((s) => [s, "pending"])));
    setStepStatus((p) => ({ ...p, [PIPELINE[0]]: "running" }));
    setResult(null);
    try {
      const { data } = await api.post("/hunter/search", { domain: domain.trim(), force_refresh: force });
      setResult(data);
      setLogs(data.logs);
      const finalStatus = {};
      // map backend step results
      data.steps.forEach((s) => {
        const k = PIPELINE.find((p) => p.toLowerCase().startsWith(s.name.toLowerCase().split(" ")[0]))
              || PIPELINE.find((p) => p === s.name)
              || s.name;
        finalStatus[k] = s.status === "ok" || s.status === "hit" || s.status === "miss" ? "ok" : s.status;
      });
      PIPELINE.forEach((p) => {
        if (!finalStatus[p]) finalStatus[p] = "ok";
      });
      setStepStatus(finalStatus);
      toast.success(`Found ${data.contacts.length} contacts`);
    } catch (err) {
      toast.error(formatApiError(err));
      setLogs((p) => [...p, `> ERROR: ${formatApiError(err)}`]);
    } finally {
      setLoading(false);
    }
  };

  const handleBulk = async () => {
    const domains = bulkText.split(/[\n,]/).map((d) => d.trim()).filter(Boolean);
    if (!domains.length) return toast.error("Add at least 1 domain");
    setBulkJob(null);
    try {
      const { data } = await api.post("/hunter/bulk", { domains });
      setBulkJob({ id: data.job_id, total: data.total, completed: 0, results: [], status: "running" });
      setBulkPolling(true);
      toast.success(`Queued ${data.total} domains`);
      const poll = setInterval(async () => {
        try {
          const { data: job } = await api.get(`/hunter/bulk/${data.job_id}`);
          setBulkJob(job);
          if (job.status === "done") {
            clearInterval(poll);
            setBulkPolling(false);
            toast.success(`Bulk job complete: ${job.completed}/${job.total}`);
          }
        } catch (e) {
          clearInterval(poll);
          setBulkPolling(false);
        }
      }, 2000);
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  const onCsvUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      const domains = text.split(/[\n,]/).map((s) => s.replace(/["']/g, "").trim()).filter((s) => s && !s.startsWith("domain") && s.includes("."));
      setBulkText(domains.join("\n"));
      setTab("bulk");
      toast.success(`Loaded ${domains.length} domains from CSV`);
    };
    reader.readAsText(file);
  };

  return (
    <div className="p-6 md:p-8 fade-up">
      <PageHeader title="Hunter" subtitle="Discover company emails by domain — single, bulk or CSV import" />

      {/* Tabs */}
      <div className="flex border border-slate-200 rounded-lg overflow-hidden w-fit mb-6 bg-white">
        <TabBtn active={tab === "single"} onClick={() => setTab("single")} icon={Crosshair} label="Single Search" testid="tab-single" />
        <TabBtn active={tab === "bulk"} onClick={() => setTab("bulk")} icon={Files} label="Bulk Search" testid="tab-bulk" />
        <TabBtn active={tab === "csv"} onClick={() => setTab("csv")} icon={Files} label="CSV Import" testid="tab-csv" />
        <TabBtn active={tab === "history"} onClick={() => { setTab("history"); loadSearchHistory(); }} icon={Clock} label="Search History" testid="tab-history" />
        <TabBtn active={tab === "myleads"} onClick={() => { setTab("myleads"); loadMyLeads(); }} icon={BookmarkSimple} label="My Saved Leads" testid="tab-myleads" />
      </div>

      {tab === "history" && (
        <Card className="overflow-hidden">
          {history.length === 0 ? (
            <EmptyState title="No searches yet" description="Your past Hunter searches will appear here." />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                <tr>
                  <th className="text-left p-3">Domain</th>
                  <th className="text-left p-3">Company</th>
                  <th className="text-left p-3">Contacts</th>
                  <th className="text-left p-3">Searched at</th>
                  <th className="text-right p-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="p-3 text-sm text-indigo-600 font-medium">{h.domain}</td>
                    <td className="p-3 text-sm text-slate-700">{h.company_name || "—"}</td>
                    <td className="p-3"><Badge tone="success">{h.contacts_found}</Badge></td>
                    <td className="p-3 text-xs text-slate-500">{h.created_at?.slice(0, 19).replace("T", " ")}</td>
                    <td className="p-3 text-right">
                      <PrimaryButton onClick={() => openAddModal(h.domain)} data-testid={`add-from-history-${h.id}`}>
                        <Plus size={14} weight="bold" /> Add
                      </PrimaryButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "myleads" && (
        <Card className="overflow-hidden">
          {myLeads.length === 0 ? (
            <EmptyState title="No saved leads yet" description="Click 'Add' on a search result to save leads to your private list." />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                <tr>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Company</th>
                  <th className="text-left p-3">Category</th>
                  <th className="text-left p-3">Location</th>
                  <th className="text-left p-3">Score</th>
                  <th className="text-right p-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {myLeads.map((l) => (
                  <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                    <td className="p-3 text-sm font-medium text-slate-900">{l.email}</td>
                    <td className="p-3 text-sm text-slate-700">{l.contact_name || "—"}</td>
                    <td className="p-3 text-sm text-slate-700">{l.company_name || l.company_domain}</td>
                    <td className="p-3">{l.category_name ? <Badge tone="info">{l.category_name}</Badge> : <span className="text-slate-400 text-xs">—</span>}</td>
                    <td className="p-3">{l.location_name ? <Badge tone="purple">{l.location_name}</Badge> : <span className="text-slate-400 text-xs">—</span>}</td>
                    <td className="p-3"><ConfidenceBadge score={l.confidence_score || 0} /></td>
                    <td className="p-3 text-right">
                      <button onClick={() => deleteLead(l.id)} className="text-slate-400 hover:text-red-500" data-testid={`del-lead-${l.id}`}><Trash size={16} weight="bold" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "single" && (
        <Card className="p-5 mb-6">
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <TermInput
                label="Domain"
                placeholder="company.com"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                data-testid="single-domain-input"
                onKeyDown={(e) => e.key === "Enter" && handleSingle(false)}
              />
            </div>
            <PrimaryButton onClick={() => handleSingle(false)} disabled={loading} data-testid="single-search-btn">
              <Lightning size={14} weight="bold" />
              {loading ? "Hunting..." : "Start Search"}
            </PrimaryButton>
            <GhostButton onClick={() => handleSingle(true)} disabled={loading} data-testid="single-refresh-btn">
              <ArrowsCounterClockwise size={14} weight="bold" /> Force refresh
            </GhostButton>
          </div>
          <div className="mt-2 text-[11px] font-mono text-slate-400">
            Tip: domains are auto-normalized. Cached results &lt; 30 days are reused (saves Hunter.io quota).
          </div>
        </Card>
      )}

      {tab === "bulk" && (
        <Card className="p-5 mb-6">
          <TermTextarea
            label="Domains (one per line, or comma-separated)"
            placeholder={"company1.com\ncompany2.com\ncompany3.com"}
            rows={6}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            data-testid="bulk-domains-input"
          />
          <div className="mt-3 flex gap-2">
            <PrimaryButton onClick={handleBulk} disabled={bulkPolling} data-testid="bulk-search-btn">
              <Lightning size={14} weight="bold" />
              {bulkPolling ? "Processing..." : "Start Bulk Search"}
            </PrimaryButton>
            <GhostButton onClick={() => setBulkText("")} disabled={bulkPolling}>Clear</GhostButton>
          </div>
        </Card>
      )}

      {tab === "csv" && (
        <Card className="p-5 mb-6">
          <div className="text-sm font-medium text-slate-500 mb-2">Upload CSV</div>
          <input
            type="file"
            accept=".csv,.txt"
            onChange={onCsvUpload}
            data-testid="csv-upload-input"
            className="block text-sm text-slate-700 file:mr-3 file:py-2 file:px-4 file:rounded-sm file:border-0 file:text-xs file:font-mono file:uppercase file:tracking-widest file:bg-indigo-500 file:text-black hover:file:bg-green-400"
          />
          <div className="mt-2 text-[11px] font-mono text-slate-400">
            CSV format: one domain per line, or any column containing dotted hostnames.
          </div>
        </Card>
      )}

      {/* Pipeline visualizer */}
      {(loading || Object.keys(stepStatus).length > 0) && (
        <Card className="p-5 mb-6">
          <div className="text-sm font-medium text-slate-500 mb-3">Pipeline</div>
          <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
            {PIPELINE.map((s, i) => (
              <StepBox key={s} idx={i + 1} name={s} status={stepStatus[s] || (loading && i === 0 ? "running" : "pending")} />
            ))}
          </div>
          {/* Terminal log */}
          <div className="mt-5 bg-zinc-950 border border-slate-800 rounded-sm p-3 max-h-64 overflow-y-auto font-mono text-[11px] text-emerald-500" data-testid="terminal-log">
            {logs.length === 0 && <div className="text-slate-500">Awaiting input...</div>}
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">{l}</div>
            ))}
            {loading && <div className="text-emerald-600 blinking-cursor">_</div>}
          </div>
        </Card>
      )}

      {/* Result */}
      {result && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wide">Discovered</div>
              <div className="font-display text-xl text-slate-900">{result.company.company_name}</div>
              <div className="text-xs text-slate-500">{result.company.domain}</div>
            </div>
            <div className="flex gap-2 items-center">
              <Badge tone="success">{result.contacts.length} contacts</Badge>
              <Badge tone="info">+{result.save?.contacts_created || 0} new</Badge>
              <Badge tone="warning">{result.save?.contacts_updated || 0} updated</Badge>
              <PrimaryButton onClick={openAddModalFromResult} data-testid="add-from-result-btn">
                <Plus size={14} weight="bold" /> Add to my list
              </PrimaryButton>
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-sm">
            <table className="w-full text-sm" data-testid="hunter-results-table">
              <thead className="bg-slate-50 text-slate-500 text-[11px] font-medium">
                <tr>
                  <th className="text-left p-3">Email</th>
                  <th className="text-left p-3">Name</th>
                  <th className="text-left p-3">Title</th>
                  <th className="text-left p-3">Source</th>
                  <th className="text-left p-3">Score</th>
                </tr>
              </thead>
              <tbody>
                {result.contacts.map((c, i) => (
                  <tr key={i} className="border-t border-slate-200/60 hover:bg-slate-50/40">
                    <td className="p-3 font-mono text-xs text-slate-900">{c.email}</td>
                    <td className="p-3 text-xs text-slate-700">{c.name || "—"}</td>
                    <td className="p-3 text-xs text-slate-500">{c.job_title || c.department || "—"}</td>
                    <td className="p-3"><Badge tone={c.source === "website" ? "success" : "info"}>{c.source}</Badge></td>
                    <td className="p-3"><ConfidenceBadge score={c.confidence_score} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Bulk job status */}
      {bulkJob && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-medium text-slate-500">Bulk Job</div>
            <Badge tone={bulkJob.status === "done" ? "success" : "warning"}>{bulkJob.status}</Badge>
          </div>
          <div className="font-mono text-sm text-slate-700 mb-3">
            {bulkJob.completed}/{bulkJob.total} processed
          </div>
          <div className="w-full bg-slate-50 rounded-sm h-2 overflow-hidden">
            <div className="h-2 bg-indigo-500 transition-all" style={{ width: `${(bulkJob.completed / bulkJob.total) * 100}%` }} />
          </div>
          {bulkJob.results?.length > 0 && (
            <div className="mt-4 max-h-48 overflow-y-auto font-mono text-[11px] space-y-1">
              {bulkJob.results.map((r, i) => (
                <div key={i} className="flex justify-between border-b border-slate-900 pb-1">
                  <span className="text-slate-700">{r.domain}</span>
                  <span className={r.ok ? "text-emerald-500" : "text-red-400"}>
                    {r.ok ? `${r.contacts} contacts` : `error: ${r.error?.slice(0, 30)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {addModal && (
        <AddToListModal
          company={addModal.company}
          contacts={addModal.contacts}
          categories={categories}
          locations={locations}
          onClose={() => setAddModal(null)}
          onSaved={() => { if (tab === "myleads") loadMyLeads(); }}
        />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon: Icon, label, testid }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      className={`px-4 py-2 text-[12px] font-medium flex items-center gap-2 transition-colors border-r border-slate-200 last:border-r-0 ${
        active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:text-slate-900 hover:bg-slate-50"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}

function AddToListModal({ company, contacts, categories, locations, onClose, onSaved }) {
  const [selected, setSelected] = useState(new Set());
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const toggle = (id) => {
    const s = new Set(selected);
    s.has(id) ? s.delete(id) : s.add(id);
    setSelected(s);
  };

  const selectAll = () => {
    if (selected.size === contacts.length) setSelected(new Set());
    else setSelected(new Set(contacts.map((c) => c.id)));
  };

  const save = async () => {
    if (selected.size === 0) return toast.error("Pick at least 1 email");
    setSaving(true);
    try {
      const res = await api.post("/my-leads", {
        company_id: company.id,
        contact_ids: Array.from(selected),
        category_id: categoryId || null,
        location_id: locationId || null,
        notes,
      });
      toast.success(`Added ${res.data.added} to your list${res.data.skipped_duplicates ? ` (skipped ${res.data.skipped_duplicates} duplicates)` : ""}`);
      onSaved();
      onClose();
    } catch (err) { toast.error(formatApiError(err)); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 fade-up grid place-items-center p-4 overflow-y-auto">
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl mx-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wide">Add to my list</div>
            <h2 className="font-display text-lg text-slate-900">{company.company_name}</h2>
            <div className="text-xs text-slate-500">{company.domain}</div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-red-500"><X size={20} weight="bold" /></button>
        </div>

        <div className="p-6 space-y-5">
          {/* Email picker */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-slate-700">Pick potential emails ({selected.size}/{contacts.length})</div>
              <button onClick={selectAll} className="text-xs text-indigo-600 hover:text-indigo-700 font-medium">
                {selected.size === contacts.length ? "Deselect all" : "Select all"}
              </button>
            </div>
            <div className="border border-slate-200 rounded-lg max-h-72 overflow-y-auto">
              {contacts.map((c) => (
                <label key={c.id} className={`flex items-center gap-3 px-3 py-2 border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-slate-50 ${selected.has(c.id) ? "bg-indigo-50" : ""}`}>
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} className="accent-indigo-600" data-testid={`pick-contact-${c.id}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-900">{c.email}</div>
                    <div className="text-xs text-slate-500">{c.name || "—"} · {c.job_title || c.department || "—"}</div>
                  </div>
                  <Badge tone={c.source === "website" ? "success" : "info"}>{c.source}</Badge>
                  <ConfidenceBadge score={c.confidence_score} />
                </label>
              ))}
            </div>
          </div>

          {/* Category + location */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-1.5">
                <Tag size={14} weight="bold" className="text-indigo-600" /> Category
              </label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full bg-white border border-slate-200 text-slate-900 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                data-testid="modal-category"
              >
                <option value="">— Select category —</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {categories.length === 0 && (
                <div className="text-[11px] text-amber-600 mt-1">No categories yet. Add some in Settings → Hunter Settings.</div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5 flex items-center gap-1.5">
                <MapPin size={14} weight="bold" className="text-indigo-600" /> Location
              </label>
              <select
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                className="w-full bg-white border border-slate-200 text-slate-900 rounded-lg px-3 py-2 text-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                data-testid="modal-location"
              >
                <option value="">— Select location —</option>
                {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          <TermTextarea
            label="Notes (optional)"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal notes about this lead..."
          />
        </div>

        <div className="px-6 py-4 border-t border-slate-200 flex justify-end gap-2">
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <PrimaryButton onClick={save} disabled={saving || selected.size === 0} data-testid="save-to-mylist-btn">
            {saving ? "Saving..." : `Save ${selected.size} to my list`}
          </PrimaryButton>
        </div>
      </Card>
    </div>
  );
}

function StepBox({ idx, name, status }) {
  const styles = {
    pending: "border-slate-200 text-slate-400 border-dashed",
    running: "border-indigo-500 text-emerald-500 step-active",
    ok:      "border-indigo-500/40 bg-indigo-500/5 text-emerald-500",
    hit:     "border-cyan-500/40 bg-cyan-500/5 text-cyan-400",
    miss:    "border-yellow-500/40 bg-yellow-500/5 text-yellow-400",
    skip:    "border-slate-300 text-slate-500 opacity-60",
    error:   "border-red-500/40 bg-red-500/5 text-red-400",
  };
  const IconMap = { ok: CheckCircle, hit: CheckCircle, miss: CheckCircle, error: XCircle, running: Spinner, pending: null, skip: null };
  const Icon = IconMap[status];
  return (
    <div className={`border rounded-sm p-2 transition-all ${styles[status] || styles.pending}`}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-mono text-[10px] opacity-70">STEP {idx}</span>
        {Icon && <Icon size={12} weight="bold" className={status === "running" ? "animate-spin" : ""} />}
      </div>
      <div className="font-mono text-[11px] leading-tight">{name}</div>
    </div>
  );
}
