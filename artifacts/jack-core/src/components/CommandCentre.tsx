import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  Clock,
  Download,
  FileText,
  FlaskConical,
  HeartPulse,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  TrendingUp,
  UserCheck,
  Users,
  Wrench,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

/* ──────────────────────────────────────────────────────────────────────────────
   Types
   ──────────────────────────────────────────────────────────────────────────── */

interface ReportScope {
  organizationId: string;
  pilotId: string;
  organizationName?: string;
  pilotName?: string;
  authority?: string;
}

interface MonitorSnapshot {
  status: string;
  timestamp: string;
  stats: {
    activeSessions: number;
    totalQuestions: number;
    avgConfidence: number;
    errorRate: number;
    totalSites: number;
    activeTrades: number;
  };
  recentQuestions: Array<{
    id: string;
    question: string;
    status: string;
    confidence: number;
    askedAt: string;
    site: string;
    trade: string;
    role: string;
  }>;
  siteBreakdown: Array<{ name: string; count: number; active: number }>;
  tradeBreakdown: Array<{ name: string; count: number; active: number }>;
  roleBreakdown: Array<{ name: string; count: number; active: number }>;
}

interface HealthAlert {
  id: string;
  title: string;
  description: string;
  severity: "critical" | "warning" | "info";
  status: "open" | "acknowledged" | "resolved" | "dismissed";
  source: string;
  createdAt: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  acknowledgedBy?: string;
  resolvedBy?: string;
}

interface EvidenceItem {
  id: string;
  type: string;
  summary: string;
  validationStatus: "pending" | "validated" | "invalid" | "needs_review";
  confidence: number;
  sourceQuestionId: string;
  sourceAnswerId: string;
  createdAt: string;
  validatedAt?: string;
  validatedBy?: string;
}

interface KnowledgeContribution {
  id: string;
  title: string;
  status: "pending" | "approved" | "rejected" | "merged";
  contributor: string;
  category: string;
  createdAt: string;
  updatedAt: string;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────────────────────────────────── */

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error || `GET ${url} failed`);
  return body;
}

async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `POST ${url} failed`);
  return data;
}

async function apiPatch<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `PATCH ${url} failed`);
  return data;
}

async function apiDelete<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    method: "DELETE",
    credentials: "include",
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `DELETE ${url} failed`);
  return data;
}

function severityBadge(severity: string) {
  const map: Record<string, { variant: "destructive" | "secondary" | "outline"; label: string }> = {
    critical: { variant: "destructive", label: "Critical" },
    warning: { variant: "secondary", label: "Warning" },
    info: { variant: "outline", label: "Info" },
  };
  const m = map[severity] ?? map.info;
  return <Badge variant={m.variant}>{m.label}</Badge>;
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    open: "bg-red-500/15 text-red-400 border-red-500/30",
    acknowledged: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    resolved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    dismissed: "bg-muted text-muted-foreground border-border",
  };
  return (
    <Badge variant="outline" className={map[status] ?? map.dismissed}>
      {status}
    </Badge>
  );
}

function validationBadge(status: string) {
  const map: Record<string, string> = {
    pending: "bg-muted text-muted-foreground border-border",
    validated: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    invalid: "bg-red-500/15 text-red-400 border-red-500/30",
    needs_review: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  };
  return (
    <Badge variant="outline" className={map[status] ?? map.pending}>
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function confidencePct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/* ──────────────────────────────────────────────────────────────────────────────
   Stat card mini-component
   ──────────────────────────────────────────────────────────────────────────── */

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <Card className="border-border/60">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className={`h-5 w-5 ${tone ?? "text-muted-foreground"}`} />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-xl font-bold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────────────────────────────────────────────────────────
   Main Component
   ──────────────────────────────────────────────────────────────────────────── */

export function CommandCentre() {
  const { toast } = useToast();

  /* scope */
  const [scopes, setScopes] = useState<ReportScope[]>([]);
  const [selectedKey, setSelectedKey] = useState("");

  const selected = useMemo(
    () => scopes.find((s) => `${s.organizationId}:${s.pilotId}` === selectedKey),
    [scopes, selectedKey],
  );

  const scopeQuery = useMemo(() => {
    if (!selected) return "";
    return `organizationId=${encodeURIComponent(selected.organizationId)}&pilotId=${encodeURIComponent(selected.pilotId)}`;
  }, [selected]);

  /* active tab */
  const [activeTab, setActiveTab] = useState("monitor");

  /* loading / error (shared) */
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /* ── Live Monitor ──────────────────────────────────────────────────────── */
  const [monitor, setMonitor] = useState<MonitorSnapshot | null>(null);
  const [monitorLoading, setMonitorLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchMonitor = useCallback(async () => {
    if (!scopeQuery) return;
    setMonitorLoading(true);
    try {
      const data = await apiGet<MonitorSnapshot>(
        `/api/pilots/command-centre/monitor?${scopeQuery}`,
      );
      setMonitor(data);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Monitor fetch failed");
    } finally {
      setMonitorLoading(false);
      setLoading(false);
    }
  }, [scopeQuery]);

  /* auto-refresh every 30s */
  useEffect(() => {
    if (!autoRefresh || !scopeQuery) return;
    fetchMonitor();
    const interval = setInterval(fetchMonitor, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, scopeQuery, fetchMonitor]);

  /* ── Health Alerts ─────────────────────────────────────────────────────── */
  const [alerts, setAlerts] = useState<HealthAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(false);
  const [alertFilter, setAlertFilter] = useState<{
    severity: string;
    status: string;
  }>({ severity: "all", status: "all" });

  const [alertDialogOpen, setAlertDialogOpen] = useState(false);
  const [alertForm, setAlertForm] = useState({
    title: "",
    description: "",
    severity: "warning" as HealthAlert["severity"],
  });
  const [alertSubmitting, setAlertSubmitting] = useState(false);

  const fetchAlerts = useCallback(async () => {
    if (!scopeQuery) return;
    setAlertsLoading(true);
    try {
      const params = new URLSearchParams(scopeQuery);
      if (alertFilter.severity !== "all") params.set("severity", alertFilter.severity);
      if (alertFilter.status !== "all") params.set("status", alertFilter.status);
      const data = await apiGet<{ alerts: HealthAlert[] }>(
        `/api/pilots/command-centre/alerts?${params.toString()}`,
      );
      setAlerts(data.alerts);
    } catch {
      // silent
    } finally {
      setAlertsLoading(false);
    }
  }, [scopeQuery, alertFilter]);

  useEffect(() => {
    if (scopeQuery) fetchAlerts();
  }, [scopeQuery, fetchAlerts]);

  const acknowledgeAlert = useCallback(
    async (id: string) => {
      try {
        await apiPatch(`/api/pilots/command-centre/alerts/${id}/acknowledge`);
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === id
              ? { ...a, status: "acknowledged" as const, acknowledgedAt: new Date().toISOString() }
              : a,
          ),
        );
        toast({ title: "Alert acknowledged" });
      } catch {
        toast({ title: "Failed to acknowledge", variant: "destructive" });
      }
    },
    [toast],
  );

  const resolveAlert = useCallback(
    async (id: string) => {
      try {
        await apiPatch(`/api/pilots/command-centre/alerts/${id}/resolve`);
        setAlerts((prev) =>
          prev.map((a) =>
            a.id === id
              ? { ...a, status: "resolved" as const, resolvedAt: new Date().toISOString() }
              : a,
          ),
        );
        toast({ title: "Alert resolved" });
      } catch {
        toast({ title: "Failed to resolve", variant: "destructive" });
      }
    },
    [toast],
  );

  const dismissAlert = useCallback(
    async (id: string) => {
      try {
        await apiPatch(`/api/pilots/command-centre/alerts/${id}/dismiss`);
        setAlerts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, status: "dismissed" as const } : a)),
        );
        toast({ title: "Alert dismissed" });
      } catch {
        toast({ title: "Failed to dismiss", variant: "destructive" });
      }
    },
    [toast],
  );

  const createAlert = useCallback(async () => {
    if (!alertForm.title.trim()) return;
    setAlertSubmitting(true);
    try {
      const data = await apiPost<{ alert: HealthAlert }>(
        `/api/pilots/command-centre/alerts?${scopeQuery}`,
        alertForm,
      );
      setAlerts((prev) => [data.alert, ...prev]);
      setAlertDialogOpen(false);
      setAlertForm({ title: "", description: "", severity: "warning" });
      toast({ title: "Alert created" });
    } catch {
      toast({ title: "Failed to create alert", variant: "destructive" });
    } finally {
      setAlertSubmitting(false);
    }
  }, [alertForm, scopeQuery, toast]);

  const autoDetectAlerts = useCallback(async () => {
    try {
      const data = await apiPost<{ created: number; alerts: HealthAlert[] }>(
        `/api/pilots/command-centre/alerts/auto-detect?${scopeQuery}`,
      );
      if (data.created > 0) {
        setAlerts((prev) => [...data.alerts, ...prev]);
        toast({ title: `Auto-detected ${data.created} alert(s)` });
      } else {
        toast({ title: "No new alerts detected" });
      }
    } catch {
      toast({ title: "Auto-detect failed", variant: "destructive" });
    }
  }, [scopeQuery, toast]);

  /* ── Evidence ──────────────────────────────────────────────────────────── */
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceFilter, setEvidenceFilter] = useState<{
    type: string;
    validation: string;
  }>({ type: "all", validation: "all" });

  const [evidenceDialogOpen, setEvidenceDialogOpen] = useState(false);
  const [evidenceForm, setEvidenceForm] = useState({
    type: "observation",
    summary: "",
    sourceQuestionId: "",
    sourceAnswerId: "",
  });
  const [evidenceSubmitting, setEvidenceSubmitting] = useState(false);

  const fetchEvidence = useCallback(async () => {
    if (!scopeQuery) return;
    setEvidenceLoading(true);
    try {
      const params = new URLSearchParams(scopeQuery);
      if (evidenceFilter.type !== "all") params.set("type", evidenceFilter.type);
      if (evidenceFilter.validation !== "all") params.set("validation", evidenceFilter.validation);
      const data = await apiGet<{ evidence: EvidenceItem[] }>(
        `/api/pilots/command-centre/evidence?${params.toString()}`,
      );
      setEvidence(data.evidence);
    } catch {
      // silent
    } finally {
      setEvidenceLoading(false);
    }
  }, [scopeQuery, evidenceFilter]);

  useEffect(() => {
    if (scopeQuery) fetchEvidence();
  }, [scopeQuery, fetchEvidence]);

  const createEvidence = useCallback(async () => {
    if (!evidenceForm.summary.trim()) return;
    setEvidenceSubmitting(true);
    try {
      const data = await apiPost<{ evidence: EvidenceItem }>(
        `/api/pilots/command-centre/evidence?${scopeQuery}`,
        evidenceForm,
      );
      setEvidence((prev) => [data.evidence, ...prev]);
      setEvidenceDialogOpen(false);
      setEvidenceForm({
        type: "observation",
        summary: "",
        sourceQuestionId: "",
        sourceAnswerId: "",
      });
      toast({ title: "Evidence created" });
    } catch {
      toast({ title: "Failed to create evidence", variant: "destructive" });
    } finally {
      setEvidenceSubmitting(false);
    }
  }, [evidenceForm, scopeQuery, toast]);

  const validateEvidence = useCallback(
    async (id: string, status: "validated" | "invalid") => {
      try {
        await apiPatch(`/api/pilots/command-centre/evidence/${id}/validate`, { status });
        setEvidence((prev) =>
          prev.map((e) =>
            e.id === id
              ? { ...e, validationStatus: status, validatedAt: new Date().toISOString() }
              : e,
          ),
        );
        toast({ title: `Evidence ${status}` });
      } catch {
        toast({ title: "Validation failed", variant: "destructive" });
      }
    },
    [toast],
  );

  /* ── Knowledge Contributions ───────────────────────────────────────────── */
  const [knowledge, setKnowledge] = useState<KnowledgeContribution[]>([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [knowledgeFilter, setKnowledgeFilter] = useState("all");

  const fetchKnowledge = useCallback(async () => {
    if (!scopeQuery) return;
    setKnowledgeLoading(true);
    try {
      const params = new URLSearchParams(scopeQuery);
      if (knowledgeFilter !== "all") params.set("status", knowledgeFilter);
      const data = await apiGet<{ contributions: KnowledgeContribution[] }>(
        `/api/pilots/command-centre/knowledge?${params.toString()}`,
      );
      setKnowledge(data.contributions);
    } catch {
      // silent
    } finally {
      setKnowledgeLoading(false);
    }
  }, [scopeQuery, knowledgeFilter]);

  useEffect(() => {
    if (scopeQuery) fetchKnowledge();
  }, [scopeQuery, fetchKnowledge]);

  /* ── Export ─────────────────────────────────────────────────────────────── */
  const [exporting, setExporting] = useState<string | null>(null);

  const downloadExport = useCallback(
    async (format: "json" | "csv") => {
      if (!scopeQuery) return;
      setExporting(format);
      try {
        const res = await fetch(
          `/api/pilots/command-centre/export?${scopeQuery}&format=${format}`,
          { credentials: "include" },
        );
        if (!res.ok) throw new Error("Export failed");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `command-centre-export.${format}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        toast({ title: `Export downloaded as ${format.toUpperCase()}` });
      } catch {
        toast({ title: "Export failed", variant: "destructive" });
      } finally {
        setExporting(null);
      }
    },
    [scopeQuery, toast],
  );

  /* ── Init ───────────────────────────────────────────────────────────────── */
  useEffect(() => {
    apiGet<{ scopes: ReportScope[] }>("/api/testing/reports/scopes")
      .then((body) => {
        setScopes(body.scopes);
        const first = body.scopes[0];
        if (first) setSelectedKey(`${first.organizationId}:${first.pilotId}`);
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : "Scopes unavailable");
        setLoading(false);
      });
  }, []);

  /* ── Health status derived from monitor ────────────────────────────────── */
  const healthStatus = useMemo(() => {
    if (!monitor) {
      return {
        label: "Unknown",
        color: "text-muted-foreground",
        dot: "bg-muted-foreground",
      };
    }
    const s = monitor.status;
    if (s === "healthy" || s === "listening" || s === "searching")
      return { label: s, color: "text-emerald-400", dot: "bg-emerald-400" };
    if (s === "reasoning")
      return { label: s, color: "text-purple-400", dot: "bg-purple-400" };
    if (s === "writing" || s === "ingesting")
      return { label: s, color: "text-orange-400", dot: "bg-orange-400" };
    return { label: s || "warning", color: "text-red-400", dot: "bg-red-400" };
  }, [monitor]);

  /* ──────────────────────────────────────────────────────────────────────────
     Render
     ──────────────────────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  if (error && scopes.length === 0) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <AlertCircle className="h-6 w-6" />
            </EmptyMedia>
            <EmptyTitle>Command Centre Unavailable</EmptyTitle>
            <EmptyDescription>{error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Command Centre</h1>
            <p className="text-sm text-muted-foreground">
              Pilot 001 &middot; Telemetry &amp; Operations Dashboard
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Scope selector */}
          <Select value={selectedKey} onValueChange={setSelectedKey}>
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select scope&hellip;" />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((scope) => {
                const key = `${scope.organizationId}:${scope.pilotId}`;
                return (
                  <SelectItem key={key} value={key}>
                    {scope.organizationName ?? scope.organizationId} /{" "}
                    {scope.pilotName ?? scope.pilotId}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>

          {/* Health indicator */}
          <div className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5">
            <span className={`h-2 w-2 rounded-full ${healthStatus.dot}`} />
            <span className={`text-xs font-semibold ${healthStatus.color}`}>
              {healthStatus.label}
            </span>
          </div>

          {/* Refresh */}
          <Button
            variant="outline"
            size="icon"
            onClick={fetchMonitor}
            title="Refresh now"
          >
            <RefreshCw className={`h-4 w-4 ${monitorLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </header>


      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="monitor">Live Monitor</TabsTrigger>
          <TabsTrigger value="alerts">Health Alerts</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
        </TabsList>

        {/* ═══════ Live Monitor Tab ══════════════════════════════════════ */}
        <TabsContent value="monitor" className="space-y-6">
          {/* Auto-refresh toggle */}
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {monitor?.timestamp
                ? `Last updated ${relTime(monitor.timestamp)}`
                : "No data yet"}
            </p>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              Auto-refresh (30s)
            </label>
          </div>

          {/* Stats cards */}
          {monitor && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              <StatCard
                icon={Users}
                label="Active Sessions"
                value={monitor.stats.activeSessions}
                tone="text-sky-400"
              />
              <StatCard
                icon={MessageSquare}
                label="Total Questions"
                value={monitor.stats.totalQuestions}
                tone="text-violet-400"
              />
              <StatCard
                icon={BrainCircuit}
                label="Avg Confidence"
                value={confidencePct(monitor.stats.avgConfidence)}
                tone="text-emerald-400"
              />
              <StatCard
                icon={Activity}
                label="Error Rate"
                value={`${(monitor.stats.errorRate * 100).toFixed(1)}%`}
                tone={
                  monitor.stats.errorRate > 0.1
                    ? "text-red-400"
                    : "text-emerald-400"
                }
              />
              <StatCard
                icon={FlaskConical}
                label="Sites"
                value={monitor.stats.totalSites}
              />
              <StatCard
                icon={Wrench}
                label="Active Trades"
                value={monitor.stats.activeTrades}
              />
              <StatCard
                icon={UserCheck}
                label="Roles Active"
                value={monitor.roleBreakdown.filter((r) => r.active > 0).length}
              />
              <StatCard
                icon={TrendingUp}
                label="Questions/hr"
                value={
                  monitor.recentQuestions.length > 0
                    ? Math.round(
                        monitor.recentQuestions.length /
                          Math.max(
                            1,
                            (Date.now() -
                              new Date(
                                monitor.recentQuestions[
                                  monitor.recentQuestions.length - 1
                                ].askedAt,
                              ).getTime()) /
                              3600000,
                          ),
                      )
                    : 0
                }
                tone="text-amber-400"
              />
            </div>
          )}

          {!monitor && !monitorLoading && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <HeartPulse className="h-6 w-6" />
                </EmptyMedia>
                <EmptyTitle>No telemetry yet</EmptyTitle>
                <EmptyDescription>
                  Select a scope above and wait for the first data snapshot.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          {monitorLoading && !monitor && (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Card key={i} className="border-border/60">
                  <CardContent className="flex items-center gap-3 p-4">
                    <Skeleton className="h-10 w-10 rounded-lg" />
                    <div className="space-y-1.5">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="h-5 w-12" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Recent questions */}
          {monitor && monitor.recentQuestions.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Recent Questions</CardTitle>
                <CardDescription>
                  The latest questions asked across all sites
                </CardDescription>
              </CardHeader>
              <CardContent className="max-h-80 space-y-2 overflow-y-auto">
                {monitor.recentQuestions.map((q) => (
                  <div
                    key={q.id}
                    className="flex items-start justify-between rounded-lg border border-border/50 bg-card/50 p-3 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{q.question}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {q.site} &middot; {q.trade} &middot; {q.role} &middot;{" "}
                        {relTime(q.askedAt)}
                      </p>
                    </div>
                    <div className="ml-3 flex shrink-0 items-center gap-2">
                      <span
                        className={`text-xs font-semibold ${
                          q.confidence > 0.8
                            ? "text-emerald-400"
                            : q.confidence > 0.5
                              ? "text-amber-400"
                              : "text-red-400"
                        }`}
                      >
                        {confidencePct(q.confidence)}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {q.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Breakdowns */}
          {monitor && (
            <div className="grid gap-6 md:grid-cols-3">
              {/* Site breakdown */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By Site</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {monitor.siteBreakdown.map((s) => (
                    <div
                      key={s.name}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate">{s.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {s.active}/{s.count}
                      </span>
                    </div>
                  ))}
                  {monitor.siteBreakdown.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No site data
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Trade breakdown */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By Trade</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {monitor.tradeBreakdown.map((t) => (
                    <div
                      key={t.name}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate">{t.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {t.active}/{t.count}
                      </span>
                    </div>
                  ))}
                  {monitor.tradeBreakdown.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No trade data
                    </p>
                  )}
                </CardContent>
              </Card>

              {/* Role breakdown */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By Role</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {monitor.roleBreakdown.map((r) => (
                    <div
                      key={r.name}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate">{r.name}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {r.active}/{r.count}
                      </span>
                    </div>
                  ))}
                  {monitor.roleBreakdown.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      No role data
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ═══════ Health Alerts Tab ══════════════════════════════════════ */}
        <TabsContent value="alerts" className="space-y-6">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={alertFilter.severity}
                onValueChange={(v) =>
                  setAlertFilter((f) => ({ ...f, severity: v }))
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Severities</SelectItem>
                  <SelectItem value="critical">Critical</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={alertFilter.status}
                onValueChange={(v) =>
                  setAlertFilter((f) => ({ ...f, status: v }))
                }
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                  <SelectItem value="resolved">Resolved</SelectItem>
                  <SelectItem value="dismissed">Dismissed</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={autoDetectAlerts}
              >
                <Search className="mr-1.5 h-4 w-4" />
                Auto-detect
              </Button>

              <Dialog
                open={alertDialogOpen}
                onOpenChange={setAlertDialogOpen}
              >
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="mr-1.5 h-4 w-4" />
                    Create Alert
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Create Health Alert</DialogTitle>
                    <DialogDescription>
                      Manually create a health alert for this pilot scope.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="alert-title">Title</Label>
                      <Input
                        id="alert-title"
                        value={alertForm.title}
                        onChange={(e) =>
                          setAlertForm((f) => ({
                            ...f,
                            title: e.target.value,
                          }))
                        }
                        placeholder="Brief alert title"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="alert-desc">Description</Label>
                      <Textarea
                        id="alert-desc"
                        value={alertForm.description}
                        onChange={(e) =>
                          setAlertForm((f) => ({
                            ...f,
                            description: e.target.value,
                          }))
                        }
                        placeholder="Detailed description"
                        rows={3}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="alert-severity">Severity</Label>
                      <Select
                        value={alertForm.severity}
                        onValueChange={(v) =>
                          setAlertForm((f) => ({
                            ...f,
                            severity: v as HealthAlert["severity"],
                          }))
                        }
                      >
                        <SelectTrigger id="alert-severity">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="critical">Critical</SelectItem>
                          <SelectItem value="warning">Warning</SelectItem>
                          <SelectItem value="info">Info</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <DialogFooter>
                    <Button
                      variant="outline"
                      onClick={() => setAlertDialogOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={createAlert}
                      disabled={
                        alertSubmitting || !alertForm.title.trim()
                      }
                    >
                      {alertSubmitting ? (
                        <Spinner className="mr-1.5 h-4 w-4" />
                      ) : null}
                      Create
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {/* Alert list */}
          {alertsLoading && alerts.length === 0 && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="border-border/60">
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-4 w-48" />
                    <Skeleton className="h-3 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!alertsLoading && alerts.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldAlert className="h-6 w-6" />
                </EmptyMedia>
                <EmptyTitle>No alerts</EmptyTitle>
                <EmptyDescription>
                  No health alerts match the current filters. Try adjusting
                  filters or run auto-detect.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          <div className="space-y-3">
            {alerts.map((alert) => (
              <Card key={alert.id} className="border-border/60">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {severityBadge(alert.severity)}
                        {statusBadge(alert.status)}
                        <span className="text-xs text-muted-foreground">
                          {relTime(alert.createdAt)}
                        </span>
                      </div>
                      <CardTitle className="mt-1 text-base">
                        {alert.title}
                      </CardTitle>
                    </div>
                  </div>
                </CardHeader>
                {alert.description && (
                  <CardContent className="pb-3 text-sm text-muted-foreground">
                    {alert.description}
                  </CardContent>
                )}
                <CardFooter className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
                  {alert.status === "open" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => acknowledgeAlert(alert.id)}
                      >
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                        Acknowledge
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => resolveAlert(alert.id)}
                      >
                        <CheckCircle2 className="mr-1 h-3.5 w-3.5 text-emerald-400" />
                        Resolve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => dismissAlert(alert.id)}
                      >
                        <Trash2 className="mr-1 h-3.5 w-3.5" />
                        Dismiss
                      </Button>
                    </>
                  )}
                  {alert.status === "acknowledged" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveAlert(alert.id)}
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5 text-emerald-400" />
                      Resolve
                    </Button>
                  )}
                  {alert.acknowledgedAt && (
                    <span className="text-xs text-muted-foreground">
                      Acknowledged {relTime(alert.acknowledgedAt)}
                    </span>
                  )}
                  {alert.resolvedAt && (
                    <span className="text-xs text-muted-foreground">
                      Resolved {relTime(alert.resolvedAt)}
                    </span>
                  )}
                </CardFooter>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ═══════ Evidence Tab ════════════════════════════════════════════ */}
        <TabsContent value="evidence" className="space-y-6">
          {/* Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={evidenceFilter.type}
                onValueChange={(v) =>
                  setEvidenceFilter((f) => ({ ...f, type: v }))
                }
              >
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="observation">Observation</SelectItem>
                  <SelectItem value="measurement">Measurement</SelectItem>
                  <SelectItem value="test_result">Test Result</SelectItem>
                  <SelectItem value="user_feedback">User Feedback</SelectItem>
                  <SelectItem value="system_event">System Event</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={evidenceFilter.validation}
                onValueChange={(v) =>
                  setEvidenceFilter((f) => ({ ...f, validation: v }))
                }
              >
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Validation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="validated">Validated</SelectItem>
                  <SelectItem value="invalid">Invalid</SelectItem>
                  <SelectItem value="needs_review">Needs Review</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Dialog
              open={evidenceDialogOpen}
              onOpenChange={setEvidenceDialogOpen}
            >
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="mr-1.5 h-4 w-4" />
                  Add Evidence
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Evidence</DialogTitle>
                  <DialogDescription>
                    Record a new piece of evidence for this pilot scope.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label htmlFor="ev-type">Type</Label>
                    <Select
                      value={evidenceForm.type}
                      onValueChange={(v) =>
                        setEvidenceForm((f) => ({ ...f, type: v }))
                      }
                    >
                      <SelectTrigger id="ev-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="observation">
                          Observation
                        </SelectItem>
                        <SelectItem value="measurement">
                          Measurement
                        </SelectItem>
                        <SelectItem value="test_result">
                          Test Result
                        </SelectItem>
                        <SelectItem value="user_feedback">
                          User Feedback
                        </SelectItem>
                        <SelectItem value="system_event">
                          System Event
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="ev-summary">Summary</Label>
                    <Textarea
                      id="ev-summary"
                      value={evidenceForm.summary}
                      onChange={(e) =>
                        setEvidenceForm((f) => ({
                          ...f,
                          summary: e.target.value,
                        }))
                      }
                      placeholder="Describe the evidence"
                      rows={3}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="ev-question">
                        Question ID (optional)
                      </Label>
                      <Input
                        id="ev-question"
                        value={evidenceForm.sourceQuestionId}
                        onChange={(e) =>
                          setEvidenceForm((f) => ({
                            ...f,
                            sourceQuestionId: e.target.value,
                          }))
                        }
                        placeholder="q-&hellip;"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ev-answer">
                        Answer ID (optional)
                      </Label>
                      <Input
                        id="ev-answer"
                        value={evidenceForm.sourceAnswerId}
                        onChange={(e) =>
                          setEvidenceForm((f) => ({
                            ...f,
                            sourceAnswerId: e.target.value,
                          }))
                        }
                        placeholder="a-&hellip;"
                      />
                    </div>
                  </div>
                </div>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setEvidenceDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={createEvidence}
                    disabled={
                      evidenceSubmitting || !evidenceForm.summary.trim()
                    }
                  >
                    {evidenceSubmitting ? (
                      <Spinner className="mr-1.5 h-4 w-4" />
                    ) : null}
                    Save
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          {/* Evidence list */}
          {evidenceLoading && evidence.length === 0 && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="border-border/60">
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-4 w-48" />
                    <Skeleton className="h-3 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!evidenceLoading && evidence.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FileText className="h-6 w-6" />
                </EmptyMedia>
                <EmptyTitle>No evidence recorded</EmptyTitle>
                <EmptyDescription>
                  No evidence items match the current filters. Add evidence
                  using the button above.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          <div className="space-y-3">
            {evidence.map((item) => (
              <Card key={item.id} className="border-border/60">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className="text-[10px]"
                        >
                          {item.type.replace(/_/g, " ")}
                        </Badge>
                        {validationBadge(item.validationStatus)}
                        <span className="text-xs text-muted-foreground">
                          {relTime(item.createdAt)}
                        </span>
                      </div>
                      <CardTitle className="mt-1 text-sm font-medium">
                        {item.summary}
                      </CardTitle>
                    </div>
                    <span
                      className={`shrink-0 text-xs font-semibold ${
                        item.confidence > 0.8
                          ? "text-emerald-400"
                          : item.confidence > 0.5
                            ? "text-amber-400"
                            : "text-red-400"
                      }`}
                    >
                      {confidencePct(item.confidence)}
                    </span>
                  </div>
                </CardHeader>
                {item.validationStatus === "pending" && (
                  <CardFooter className="gap-2 border-t border-border/40 pt-3">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        validateEvidence(item.id, "validated")
                      }
                      className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                    >
                      <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
                      Validate
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => validateEvidence(item.id, "invalid")}
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10"
                    >
                      <XCircle className="mr-1 h-3.5 w-3.5" />
                      Reject
                    </Button>
                  </CardFooter>
                )}
                {item.validatedAt && (
                  <CardFooter className="border-t border-border/40 pt-3">
                    <span className="text-xs text-muted-foreground">
                      Validated {relTime(item.validatedAt)}
                    </span>
                  </CardFooter>
                )}
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ═══════ Knowledge Tab ════════════════════════════════════════════ */}
        <TabsContent value="knowledge" className="space-y-6">
          {/* Filter */}
          <div className="flex items-center gap-2">
            <Select
              value={knowledgeFilter}
              onValueChange={setKnowledgeFilter}
            >
              <SelectTrigger className="w-40">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Contributions</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="approved">Approved</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
                <SelectItem value="merged">Merged</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* List */}
          {knowledgeLoading && knowledge.length === 0 && (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="border-border/60">
                  <CardContent className="p-4">
                    <Skeleton className="mb-2 h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {!knowledgeLoading && knowledge.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BrainCircuit className="h-6 w-6" />
                </EmptyMedia>
                <EmptyTitle>No contributions</EmptyTitle>
                <EmptyDescription>
                  No knowledge contributions match the current filter.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}

          <div className="space-y-3">
            {knowledge.map((kc) => (
              <Card key={kc.id} className="border-border/60">
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            kc.status === "approved" ||
                            kc.status === "merged"
                              ? "border-emerald-500/30 text-emerald-400"
                              : kc.status === "rejected"
                                ? "border-red-500/30 text-red-400"
                                : ""
                          }
                        >
                          {kc.status}
                        </Badge>
                        <span className="rounded-full border border-border/40 px-2 py-0.5 text-[10px] text-muted-foreground">
                          {kc.category}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {relTime(kc.updatedAt)}
                        </span>
                      </div>
                      <CardTitle className="mt-1 text-sm font-medium">
                        {kc.title}
                      </CardTitle>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        by {kc.contributor}
                      </p>
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ═══════ Export Tab ════════════════════════════════════════════════ */}
        <TabsContent value="export" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Export Data</CardTitle>
              <CardDescription>
                Download telemetry, alerts, evidence, and knowledge
                contributions for the selected scope as JSON or CSV.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              <Button
                variant="default"
                disabled={exporting !== null || !scopeQuery}
                onClick={() => downloadExport("json")}
              >
                {exporting === "json" ? (
                  <Spinner className="mr-2 h-4 w-4" />
                ) : (
                  <Download className="mr-2 h-4 w-4" />
                )}
                Download JSON
              </Button>
              <Button
                variant="outline"
                disabled={exporting !== null || !scopeQuery}
                onClick={() => downloadExport("csv")}
              >
                {exporting === "csv" ? (
                  <Spinner className="mr-2 h-4 w-4" />
                ) : (
                  <FileText className="mr-2 h-4 w-4" />
                )}
                Download CSV
              </Button>
            </CardContent>
            <CardFooter>
              <p className="text-xs text-muted-foreground">
                Exports include all monitor data, alerts, evidence, and
                knowledge contributions for the selected scope.
              </p>
            </CardFooter>
          </Card>

          {error && (
            <Card className="border-red-500/30">
              <CardContent className="p-4 text-sm text-red-400">
                {error}
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
