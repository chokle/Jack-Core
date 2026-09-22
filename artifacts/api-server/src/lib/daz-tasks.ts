import { CreateDazTaskBody, CreateDazTaskResponse } from "@workspace/api-zod";
export const taskRequest = CreateDazTaskBody.strict();
export const taskEnvelope = CreateDazTaskResponse;

export class RuntimeTaskError extends Error {
  constructor(public status: number) {
    super("Daz task request failed.");
  }
}

export async function requestDazTask(
  taskId: string,
  requester: string,
  create: boolean,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10000,
) {
  const token = process.env["DAZ_RUNTIME_TOKEN"]?.trim();
  const base = new URL(process.env["DAZ_RUNTIME_URL"] ?? "");
  if (
    !token ||
    (base.protocol !== "https:" && base.hostname !== "localhost") ||
    base.username ||
    base.password
  )
    throw new Error("Runtime configuration unavailable.");
  const url = new URL(
    create ? "/tasks" : `/tasks/${encodeURIComponent(taskId)}`,
    base,
  );
  if (!create) url.searchParams.set("requested_by", requester);
  const response = await fetchImpl(url, {
    method: create ? "POST" : "GET",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(create
      ? {
          body: JSON.stringify({
            task_id: taskId,
            kind: "jack_health_report",
            requested_by: requester,
          }),
        }
      : {}),
  });
  if (!response.ok)
    throw new RuntimeTaskError(
      [404, 409, 429].includes(response.status) ? response.status : 503,
    );
  const body = taskEnvelope.parse(await response.json());
  if (body.task.task_id !== taskId || body.task.requested_by !== requester)
    throw new Error("Invalid task provenance.");
  if (body.task.status === "COMPLETED") {
    const receipt = body.task.receipt;
    const verification = receipt?.["verification"] as
      | Record<string, unknown>
      | undefined;
    const execution = receipt?.["execution"] as
      | Record<string, unknown>
      | undefined;
    if (
      !body.task.result ||
      body.task.result["task_id"] !== taskId ||
      body.task.result["requested_by"] !== requester ||
      !receipt ||
      receipt["task_id"] !== taskId ||
      receipt["status"] !== "COMPLETED" ||
      receipt["outstanding_action"] !== null ||
      !receipt["completed_at"] ||
      !/^[a-f0-9]{64}$/i.test(String(receipt["result"])) ||
      verification?.["result"] !== "PASS" ||
      !execution?.["id"] ||
      verification?.["execution_receipt_id"] !== execution["id"]
    )
      throw new Error("Invalid task provenance.");
  }
  return body;
}
