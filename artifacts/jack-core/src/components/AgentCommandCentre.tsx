import { useEffect, useRef, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import type { CommandCentreSnapshot } from "@workspace/api-zod";

/** UI gate is defense in depth; every request also requires backend admin authorization. */
export function AgentCommandCentre({
  userId,
  isAdmin,
}: {
  userId: string;
  isAdmin: boolean;
}) {
  if (!isAdmin) return null;
  return <AuthorizedCentre key={userId} />;
}
function AuthorizedCentre() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<CommandCentreSnapshot | null>(null);
  const state = snapshot?.state;
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");
  const command = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [permission, setPermission] = useState("agent.command.run");
  useEffect(() => () => command.current?.abort(), []);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null);
    setNotice("");
    async function refresh() {
      try {
        const result = await customFetch<CommandCentreSnapshot>(
          `/api/admin/agents/state${query ? `?${query}` : ""}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setSnapshot(result);
      } catch {
        if (!controller.signal.aborted) {
          setSnapshot(null);
          setNotice(
            "Operational history unavailable. Check scope, consent and event ingestion.",
          );
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 3000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, revision, query]);
  async function submit() {
    command.current?.abort();
    const controller = new AbortController();
    command.current = controller;
    setPending(true);
    setNotice("");
    try {
      await customFetch("/api/admin/agents/commands", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          permission,
          agentId: agentId.trim(),
          channel: "command-centre",
        }),
      });
      if (!controller.signal.aborted) setNotice("Command accepted.");
    } catch (error) {
      if (!controller.signal.aborted)
        setNotice(
          typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 501
            ? "No internal agent executor is configured. Command was not executed."
            : "Command was not accepted. Check your administrator access and try again.",
        );
    } finally {
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <section
      aria-label="Admin Command Centre"
      className="shrink-0 border-b border-sidebar-border px-4 py-2 text-xs"
    >
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
        Command Centre
      </button>
      {open && (
        <div className="mt-2 max-h-[60vh] space-y-2 overflow-auto">
          <p>Internal agents · Administrator access</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(
                new URLSearchParams(
                  Object.entries(filters)
                    .filter(([, value]) => value.trim())
                    .map(([key, value]) => [key, value.trim()]),
                ).toString(),
              );
            }}
            className="flex flex-wrap gap-2"
          >
            {(
              [
                ["organizationId", "Organization"],
                ["pilotId", "Pilot"],
                ["siteId", "Site"],
                ["crewId", "Crew"],
                ["userId", "User"],
                ["sessionId", "Session"],
                ["agentId", "Agent"],
                ["eventType", "Event type"],
                ["severity", "Severity"],
                ["taskStatus", "Task status"],
                ["connectivity", "Connectivity"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label} filter{" "}
                <input
                  className="block w-32 rounded border bg-background px-1"
                  maxLength={128}
                  value={filters[key] ?? ""}
                  onChange={(e) =>
                    setFilters({ ...filters, [key]: e.target.value })
                  }
                />
              </label>
            ))}
            <button type="submit">Apply scoped filters</button>
          </form>
          {state && (
            <p>
              Jack: {state.lifecycle} · Connection:{" "}
              {state.connectivityObserved
                ? state.connectivity
                : "no observation"}{" "}
              · Crew:{" "}
              {state.crewObserved ? state.crewAwareness : "no observation"} ·
              Authority: {state.authority} · Confidence: {state.confidence} ·
              Priority: {state.priority}
            </p>
          )}
          {snapshot && (
            <p>
              {snapshot.durability === "durable"
                ? "Durable history · live mirror"
                : snapshot.durability === "not_consented"
                  ? "Session-only state: current consented pilot session required for durable history."
                  : "Event ingestion failed: history may be incomplete."}
            </p>
          )}
          {snapshot?.alerts.map((alert, i) => (
            <p role="alert" key={`${alert.code}:${alert.subjectId}:${i}`}>
              {alert.code.replaceAll("_", " ")}
              {alert.subjectId ? `: ${alert.subjectId}` : ""}
            </p>
          ))}
          {state &&
            (Object.keys(state.internalAgents).length ? (
              <ul>
                {Object.entries(state.internalAgents).map(([name, agent]) => (
                  <li key={name}>
                    {name}: {agent.status}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No internal agent activity in this scope.</p>
            ))}
          {state && (
            <>
              <p>Jack tasks</p>
              <ul>
                {Object.entries(state.tasks).map(([id, task]) => (
                  <li key={id}>
                    {id}: {task.status} · recoveries {task.recoveries}
                  </li>
                ))}
              </ul>
              <p>Internal task flow</p>
              <ul>
                {Object.entries(state.internalTasks).map(([id, task]) => (
                  <li key={id}>
                    {id}: {task.status} · {task.agentId} · owner {task.ownerId}{" "}
                    · handoff {task.handoffTo ?? "none"} · model{" "}
                    {task.modelRoute ?? "unassigned"} · recoveries{" "}
                    {task.recoveries}
                  </li>
                ))}
              </ul>
              <p>Agent health</p>
              <ul>
                {Object.entries(state.agentHealth).map(([id, health]) => (
                  <li key={id}>
                    {id}: {health}
                  </li>
                ))}
              </ul>
            </>
          )}
          {snapshot && (
            <details>
              <summary>
                Operational history ({snapshot.history.length}
                {snapshot.historyTruncated ? "+" : ""})
              </summary>
              <ol>
                {snapshot.history.map((event) => (
                  <li key={event.id}>
                    <time>{event.occurredAt}</time> · {event.type} ·{" "}
                    {event.severity} · {event.source}
                    {"taskId" in event ? ` · task ${event.taskId}` : ""}
                    {"agentId" in event.payload
                      ? ` · ${event.payload.agentId}`
                      : ""}
                  </li>
                ))}
              </ol>
            </details>
          )}
          <button
            type="button"
            onClick={() => setRevision((value) => value + 1)}
          >
            Refresh agent status
          </button>
          {snapshot && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="flex flex-wrap items-center gap-2"
            >
              <label>
                Internal agent{" "}
                <input
                  className="rounded border bg-background px-2 py-1"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value)}
                  required
                  maxLength={80}
                  pattern="[a-zA-Z][a-zA-Z0-9_-]{0,79}"
                />
              </label>
              <label>
                Command{" "}
                <select
                  className="rounded border bg-background px-2 py-1"
                  value={permission}
                  onChange={(event) => setPermission(event.target.value)}
                >
                  <option value="agent.command.run">Run</option>
                  <option value="agent.command.reprioritize">
                    Reprioritize
                  </option>
                  <option value="agent.interrupt.stop">Interrupt</option>
                  <option value="agent.dispatch.run">Dispatch</option>
                  <option value="agent.model.route">Route model</option>
                </select>
              </label>
              <button type="submit" disabled={pending || !agentId.trim()}>
                {pending ? "Submitting..." : "Submit command"}
              </button>
            </form>
          )}
          <p>Internal agent execution is not configured.</p>
          {notice && <p role="status">{notice}</p>}
        </div>
      )}
    </section>
  );
}
