import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CheckCircle2,
  Inbox,
  Loader2,
  MailWarning,
  MessageSquareText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

type FeedbackStatus = "new" | "reviewed" | "actioned" | "archived";
type Usefulness = "yes" | "partly" | "no";
type NotificationStatus = "pending" | "sent" | "failed" | "retrying";

interface FeedbackRecord {
  id: string;
  testerEmail: string | null;
  testerName: string | null;
  testerProfileId: string | null;
  trade: string | null;
  featuresUsed: string[];
  deviceCategory: string;
  trigger: string;
  goal: string;
  usefulness: Usefulness;
  shortfall: string;
  adoptionNeed: string;
  additional: string | null;
  status: FeedbackStatus;
  adminNotes: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notificationStatus: NotificationStatus;
  notificationAttempts: number;
  notificationLastError: string | null;
  notificationSentAt: string | null;
  createdAt: string;
}

interface FeedbackListResponse {
  feedback: FeedbackRecord[];
  unreadCount: number;
  trades: string[];
}

const STATUS_OPTIONS: FeedbackStatus[] = ["new", "reviewed", "actioned", "archived"];
const USEFULNESS_OPTIONS: Usefulness[] = ["yes", "partly", "no"];

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function usefulnessClass(value: Usefulness): string {
  if (value === "yes") return "border-emerald-400/30 bg-emerald-400/10 text-emerald-300";
  if (value === "partly") return "border-amber-400/30 bg-amber-400/10 text-amber-300";
  return "border-red-400/30 bg-red-400/10 text-red-300";
}

function notificationClass(value: NotificationStatus): string {
  if (value === "sent") return "text-emerald-300";
  if (value === "failed") return "text-red-300";
  if (value === "retrying") return "text-amber-300";
  return "text-muted-foreground";
}

export function UserTestFeedbackReview() {
  const initialFeedbackId = useMemo(
    () => new URLSearchParams(window.location.search).get("feedback"),
    [],
  );
  const openedInitialFeedback = useRef(false);
  const [records, setRecords] = useState<FeedbackRecord[]>([]);
  const [trades, setTrades] = useState<string[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [trade, setTrade] = useState("");
  const [status, setStatus] = useState("");
  const [usefulness, setUsefulness] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FeedbackRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draftStatus, setDraftStatus] = useState<FeedbackStatus>("new");
  const [adminNotes, setAdminNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (trade) params.set("trade", trade);
    if (status) params.set("status", status);
    if (usefulness) params.set("usefulness", usefulness);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    try {
      const response = await fetch(`/api/testing/feedback?${params}`, {
        credentials: "include",
        signal,
      });
      if (!response.ok) throw new Error(`Feedback list failed (${response.status})`);
      const body = (await response.json()) as FeedbackListResponse;
      setRecords(body.feedback);
      setUnreadCount(body.unreadCount);
      setTrades((current) => [...new Set([...current, ...body.trades])].sort());
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        setError("Could not load user-test feedback.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [dateFrom, dateTo, status, trade, usefulness]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const openRecord = useCallback(async (id: string) => {
    const local = records.find((record) => record.id === id);
    if (local) {
      setSelected(local);
      setDraftStatus(local.status);
      setAdminNotes(local.adminNotes ?? "");
      return;
    }
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/testing/feedback/${encodeURIComponent(id)}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`Feedback detail failed (${response.status})`);
      const record = (await response.json()) as FeedbackRecord;
      setSelected(record);
      setDraftStatus(record.status);
      setAdminNotes(record.adminNotes ?? "");
    } catch {
      toast({
        variant: "destructive",
        title: "Could not open feedback",
        description: "The record may no longer be available.",
      });
    } finally {
      setDetailLoading(false);
    }
  }, [records, toast]);

  useEffect(() => {
    if (!initialFeedbackId || openedInitialFeedback.current) return;
    openedInitialFeedback.current = true;
    void openRecord(initialFeedbackId);
  }, [initialFeedbackId, openRecord]);

  const save = async () => {
    if (!selected || saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/testing/feedback/${encodeURIComponent(selected.id)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: draftStatus, adminNotes }),
      });
      if (!response.ok) throw new Error(`Feedback update failed (${response.status})`);
      const updated = (await response.json()) as FeedbackRecord;
      setSelected(updated);
      setRecords((current) =>
        current.map((record) => (record.id === updated.id ? updated : record)),
      );
      await load();
      toast({ title: "Feedback updated", description: "Review status and notes were saved." });
    } catch {
      toast({
        variant: "destructive",
        title: "Could not update feedback",
        description: "Nothing was changed. Try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="mb-8 rounded-2xl border border-primary/20 bg-card/55 p-4 md:p-5"
      data-testid="user-test-feedback-review"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">User-Test Feedback</h2>
            {unreadCount > 0 && (
              <span
                className="rounded-full bg-primary px-2 py-0.5 text-xs font-bold text-primary-foreground"
                aria-label={`${unreadCount} new feedback records`}
              >
                {unreadCount}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Tester feedback is the authoritative record; email is delivery status only.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Inbox className="mr-2 h-4 w-4" />}
          Refresh
        </Button>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <label className="space-y-1 text-xs text-muted-foreground">
          Trade
          <select
            aria-label="Filter feedback by trade"
            value={trade}
            onChange={(event) => setTrade(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">All trades</option>
            {trades.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Status
          <select
            aria-label="Filter feedback by status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Response
          <select
            aria-label="Filter feedback by response"
            value={usefulness}
            onChange={(event) => setUsefulness(event.target.value)}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="">All responses</option>
            {USEFULNESS_OPTIONS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          From
          <Input
            aria-label="Filter feedback from date"
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          To
          <Input
            aria-label="Filter feedback to date"
            type="date"
            value={dateTo}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </label>
      </div>

      {error ? (
        <div className="mt-5 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : loading && records.length === 0 ? (
        <div className="flex justify-center py-10 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading feedback…
        </div>
      ) : records.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No feedback matches these filters.
        </div>
      ) : (
        <div className="mt-5 space-y-2">
          {records.map((record) => (
            <button
              key={record.id}
              type="button"
              onClick={() => void openRecord(record.id)}
              className="grid w-full gap-2 rounded-xl border border-border bg-background/40 p-4 text-left transition-colors hover:border-primary/40 hover:bg-muted/30 md:grid-cols-[1.2fr_.7fr_.6fr_.7fr]"
            >
              <div>
                <div className="font-semibold">
                  {record.testerName || record.testerEmail || "Signed-in tester"}
                </div>
                <div className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                  {record.goal}
                </div>
              </div>
              <div className="text-sm">
                <div>{record.trade || "Trade not provided"}</div>
                <div className="text-xs text-muted-foreground">{formatDate(record.createdAt)}</div>
              </div>
              <div>
                <span className={`inline-flex rounded-full border px-2 py-1 text-xs font-semibold ${usefulnessClass(record.usefulness)}`}>
                  {titleCase(record.usefulness)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">{titleCase(record.status)}</span>
                <span className={`flex items-center gap-1 text-xs ${notificationClass(record.notificationStatus)}`}>
                  {record.notificationStatus === "failed" ? <MailWarning className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
                  {titleCase(record.notificationStatus)}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      {detailLoading && (
        <div className="mt-4 flex items-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening feedback…
        </div>
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle>User-Test Feedback</DialogTitle>
                <DialogDescription>
                  {selected.testerName || "Signed-in tester"} · {selected.trade || "Trade not provided"} · {formatDate(selected.createdAt)}
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-3 rounded-xl border border-border bg-background/40 p-4 text-sm sm:grid-cols-2">
                <Detail label="Profile" value={selected.testerName || selected.testerEmail || "Signed-in tester"} />
                <Detail label="Trade" value={selected.trade || "Not provided"} />
                <Detail label="Usefulness" value={titleCase(selected.usefulness)} />
                <Detail label="Device" value={titleCase(selected.deviceCategory)} />
                <Detail label="Trigger" value={titleCase(selected.trigger)} />
                <Detail label="Features used" value={selected.featuresUsed.map(titleCase).join(", ")} />
              </div>

              <div className="space-y-4 text-sm">
                <Answer label="Goal" value={selected.goal} />
                <Answer label="Where Jack fell short" value={selected.shortfall} />
                <Answer label="What would drive adoption" value={selected.adoptionNeed} />
                <Answer label="Additional feedback" value={selected.additional || "No additional comment."} />
              </div>

              <div className="rounded-xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-semibold">Email delivery</div>
                  <span className={`flex items-center gap-1 text-sm ${notificationClass(selected.notificationStatus)}`}>
                    {selected.notificationStatus === "sent" ? <CheckCircle2 className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                    {titleCase(selected.notificationStatus)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Attempts: {selected.notificationAttempts}
                  {selected.notificationSentAt ? ` · Sent ${formatDate(selected.notificationSentAt)}` : ""}
                  {selected.notificationLastError ? ` · ${titleCase(selected.notificationLastError)}` : ""}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
                <label className="space-y-1 text-sm font-semibold">
                  Status
                  <select
                    aria-label="Feedback review status"
                    value={draftStatus}
                    onChange={(event) => setDraftStatus(event.target.value as FeedbackStatus)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm font-normal text-foreground"
                  >
                    {STATUS_OPTIONS.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-sm font-semibold">
                  Admin notes
                  <Textarea
                    aria-label="Feedback admin notes"
                    value={adminNotes}
                    onChange={(event) => setAdminNotes(event.target.value)}
                    maxLength={4_000}
                    rows={4}
                    placeholder="Internal follow-up, decision, or action taken"
                  />
                </label>
              </div>

              <DialogFooter>
                <Button variant="ghost" onClick={() => setSelected(null)}>Close</Button>
                <Button onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save review
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1">{value}</div>
    </div>
  );
}

function Answer({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-semibold">{label}</div>
      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{value}</p>
    </div>
  );
}
