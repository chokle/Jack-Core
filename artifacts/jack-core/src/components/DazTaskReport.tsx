import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/react";
import { z } from "zod";
import { authenticatedFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";

interface Task {
  task_id: string;
  status: "PROPOSED" | "EXECUTED" | "VERIFIED" | "COMPLETED" | "BLOCKED";
  result: Record<string, unknown> | null;
  receipt: Record<string, unknown> | null;
  error: string | null;
}
const terminal = (task: Task) =>
  task.status === "COMPLETED" || task.status === "BLOCKED";

export function DazTaskReport() {
  const { userId } = useAuth();
  // Only a non-secret identifier is cached; reports and receipts remain server-side.
  const key = userId ? `jack:daz:health-task:${userId}` : null;
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const epoch = useRef(0);

  async function retrieve(id: string, signal: AbortSignal) {
    const response = await authenticatedFetch(`/api/daz-runtime/tasks/${id}`, {
      cache: "no-store",
      signal,
    });
    const body = await response.json();
    if (!response.ok || !body.ok || body.task?.task_id !== id)
      throw new Error(body.error || "Task result unavailable.");
    if (
      body.task.status === "COMPLETED" &&
      (!body.task.receipt || !body.task.result)
    )
      throw new Error("Completion evidence is missing.");
    return body.task as Task;
  }

  async function run(create: boolean, newTask = false) {
    if (!key || running.current) return;
    running.current = true;
    const current = epoch.current;
    setBusy(true);
    setError(null);
    try {
      const id = newTask ? crypto.randomUUID() : taskId || crypto.randomUUID();
      // Persist BEFORE POST. Storage failure prevents a submission we cannot safely resume.
      localStorage.setItem(key, id);
      setTaskId(id);
      if (newTask) setTask(null);
      let result: Task;
      if (create) {
        const response = await authenticatedFetch("/api/daz-runtime/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task_id: id, kind: "jack_health_report" }),
          signal: AbortSignal.timeout(30000),
        });
        const body = await response.json();
        if (!response.ok || !body.ok || body.task?.task_id !== id)
          throw new Error(
            body.error ||
              "Submission unconfirmed. Retry uses the same task ID.",
          );
        result = body.task;
      } else result = await retrieve(id, AbortSignal.timeout(30000));
      for (let poll = 0; current === epoch.current; poll++) {
        if (
          result.status === "COMPLETED" &&
          (!result.receipt || !result.result)
        )
          throw new Error("Completion evidence is missing.");
        setTask(result);
        if (terminal(result)) break;
        if (poll >= 10)
          throw new Error(
            "Task is still pending. Retrieve its receipt to check progress.",
          );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (current !== epoch.current) break;
        result = await retrieve(id, AbortSignal.timeout(30000));
      }
    } catch (failure) {
      if (current === epoch.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Task outcome unknown. Retrieve or retry the same ID.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    epoch.current++;
    running.current = false;
    setBusy(false);
    setTask(null);
    setError(null);
    setTaskId(null);
    const current = epoch.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (key) {
      try {
        const storedId = localStorage.getItem(key);
        const parsedId = z.string().uuid().safeParse(storedId);
        if (storedId !== null && !parsedId.success)
          localStorage.removeItem(key);
        if (parsedId.success) {
          const id = parsedId.data.toLowerCase();
          if (id !== storedId) localStorage.setItem(key, id);
          setTaskId(id);
          setBusy(true);
          timer = setTimeout(() => controller.abort(), 30000);
          // Mount only reconciles an existing task. It NEVER submits work.
          void retrieve(id, controller.signal)
            .then((result) => {
              if (epoch.current === current) setTask(result);
            })
            .catch(() => {
              if (epoch.current === current)
                setError(
                  "Saved task outcome unavailable. Retrieve or retry the same task ID.",
                );
            })
            .finally(() => {
              if (epoch.current === current) setBusy(false);
              clearTimeout(timer);
            });
        }
      } catch {
        setError(
          "Browser storage is unavailable; task submission is disabled until it can be saved.",
        );
      }
    }
    return () => {
      epoch.current++;
      controller.abort();
      clearTimeout(timer);
    };
  }, [key]);

  return (
    <section
      className="rounded-lg border border-slate-800 bg-slate-900/60 p-5"
      aria-label="Daz task execution"
    >
      <h2 className="font-semibold">Create a Jack service health report</h2>
      <p className="mt-2 text-sm text-slate-400">
        Daz checks Jack service liveness and runtime connectivity, saves the
        report, and independently verifies its receipt. This does not test every
        Jack feature.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          disabled={!key || busy || (!!task && terminal(task))}
          onClick={() => void run(true)}
        >
          {busy ? "Working..." : taskId ? "Retry same task" : "Create report"}
        </Button>
        {taskId && (
          <Button disabled={busy} onClick={() => void run(false)}>
            Retrieve receipt
          </Button>
        )}
        {task?.status === "COMPLETED" && task.receipt && (
          <Button disabled={busy} onClick={() => void run(true, true)}>
            Create another report
          </Button>
        )}
      </div>
      {busy && (
        <p role="status" className="mt-3 text-sm">
          Checking task progress...
        </p>
      )}
      {taskId && <p className="mt-3 break-all text-sm">Task ID: {taskId}</p>}
      {task && <p className="mt-2 text-sm">Task state: {task.status}</p>}
      {(error || task?.error) && (
        <p role="alert" className="mt-3 text-sm text-orange-300">
          {error || task?.error}
        </p>
      )}
      {task?.result && (
        <details className="mt-4" open>
          <summary>Report</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(task.result, null, 2)}
          </pre>
        </details>
      )}
      {task?.receipt && (
        <details className="mt-4">
          <summary>Durable receipt and provenance</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(task.receipt, null, 2)}
          </pre>
        </details>
      )}
    </section>
  );
}
