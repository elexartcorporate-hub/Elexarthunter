import { useState } from "react";
import { api, formatApiError } from "@/lib/api";
import { PageHeader, Card, TermInput, TermTextarea, PrimaryButton, GhostButton, Badge, ConfidenceBadge } from "@/components/term";
import { Crosshair, Lightning, Files, CheckCircle, XCircle, Spinner, ArrowsCounterClockwise } from "@phosphor-icons/react";
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
      <PageHeader title="Hunter" subtitle="$ hunter --discover company-emails" />

      {/* Tabs */}
      <div className="flex border border-zinc-800 rounded-sm overflow-hidden w-fit mb-6">
        <TabBtn active={tab === "single"} onClick={() => setTab("single")} icon={Crosshair} label="Single Search" testid="tab-single" />
        <TabBtn active={tab === "bulk"} onClick={() => setTab("bulk")} icon={Files} label="Bulk Search" testid="tab-bulk" />
        <TabBtn active={tab === "csv"} onClick={() => setTab("csv")} icon={Files} label="CSV Import" testid="tab-csv" />
      </div>

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
          <div className="mt-2 text-[11px] font-mono text-zinc-600">
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
          <div className="font-mono text-xs uppercase tracking-widest text-zinc-400 mb-2">Upload CSV</div>
          <input
            type="file"
            accept=".csv,.txt"
            onChange={onCsvUpload}
            data-testid="csv-upload-input"
            className="block text-sm text-zinc-300 file:mr-3 file:py-2 file:px-4 file:rounded-sm file:border-0 file:text-xs file:font-mono file:uppercase file:tracking-widest file:bg-green-500 file:text-black hover:file:bg-green-400"
          />
          <div className="mt-2 text-[11px] font-mono text-zinc-600">
            CSV format: one domain per line, or any column containing dotted hostnames.
          </div>
        </Card>
      )}

      {/* Pipeline visualizer */}
      {(loading || Object.keys(stepStatus).length > 0) && (
        <Card className="p-5 mb-6">
          <div className="font-mono text-xs uppercase tracking-widest text-zinc-400 mb-3">Pipeline</div>
          <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
            {PIPELINE.map((s, i) => (
              <StepBox key={s} idx={i + 1} name={s} status={stepStatus[s] || (loading && i === 0 ? "running" : "pending")} />
            ))}
          </div>
          {/* Terminal log */}
          <div className="mt-5 bg-black border border-zinc-800 rounded-sm p-3 max-h-64 overflow-y-auto font-mono text-[11px] text-green-400" data-testid="terminal-log">
            {logs.length === 0 && <div className="text-zinc-600">Awaiting input...</div>}
            {logs.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">{l}</div>
            ))}
            {loading && <div className="text-green-500 blinking-cursor">_</div>}
          </div>
        </Card>
      )}

      {/* Result */}
      {result && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Discovered</div>
              <div className="font-display text-xl text-zinc-100">{result.company.company_name}</div>
              <div className="font-mono text-xs text-zinc-500">{result.company.domain}</div>
            </div>
            <div className="flex gap-2">
              <Badge tone="success">{result.contacts.length} contacts</Badge>
              <Badge tone="info">+{result.save?.contacts_created || 0} new</Badge>
              <Badge tone="warning">{result.save?.contacts_updated || 0} updated</Badge>
            </div>
          </div>

          <div className="overflow-x-auto border border-zinc-800 rounded-sm">
            <table className="w-full text-sm" data-testid="hunter-results-table">
              <thead className="bg-zinc-900 text-zinc-500 text-[10px] uppercase tracking-widest font-mono">
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
                  <tr key={i} className="border-t border-zinc-800/60 hover:bg-zinc-900/40">
                    <td className="p-3 font-mono text-xs text-zinc-200">{c.email}</td>
                    <td className="p-3 text-xs text-zinc-300">{c.name || "—"}</td>
                    <td className="p-3 text-xs text-zinc-400">{c.job_title || c.department || "—"}</td>
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
            <div className="font-mono text-xs uppercase tracking-widest text-zinc-400">Bulk Job</div>
            <Badge tone={bulkJob.status === "done" ? "success" : "warning"}>{bulkJob.status}</Badge>
          </div>
          <div className="font-mono text-sm text-zinc-300 mb-3">
            {bulkJob.completed}/{bulkJob.total} processed
          </div>
          <div className="w-full bg-zinc-900 rounded-sm h-2 overflow-hidden">
            <div className="h-2 bg-green-500 transition-all" style={{ width: `${(bulkJob.completed / bulkJob.total) * 100}%` }} />
          </div>
          {bulkJob.results?.length > 0 && (
            <div className="mt-4 max-h-48 overflow-y-auto font-mono text-[11px] space-y-1">
              {bulkJob.results.map((r, i) => (
                <div key={i} className="flex justify-between border-b border-zinc-900 pb-1">
                  <span className="text-zinc-300">{r.domain}</span>
                  <span className={r.ok ? "text-green-400" : "text-red-400"}>
                    {r.ok ? `${r.contacts} contacts` : `error: ${r.error?.slice(0, 30)}`}
                  </span>
                </div>
              ))}
            </div>
          )}
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
      className={`px-4 py-2 text-xs font-mono uppercase tracking-widest flex items-center gap-2 transition-colors border-r border-zinc-800 last:border-r-0 ${
        active ? "bg-green-500/10 text-green-400" : "text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900"
      }`}
    >
      <Icon size={14} weight="bold" />
      {label}
    </button>
  );
}

function StepBox({ idx, name, status }) {
  const styles = {
    pending: "border-zinc-800 text-zinc-600 border-dashed",
    running: "border-green-500 text-green-400 step-active",
    ok:      "border-green-500/40 bg-green-500/5 text-green-400",
    hit:     "border-cyan-500/40 bg-cyan-500/5 text-cyan-400",
    miss:    "border-yellow-500/40 bg-yellow-500/5 text-yellow-400",
    skip:    "border-zinc-700 text-zinc-500 opacity-60",
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
