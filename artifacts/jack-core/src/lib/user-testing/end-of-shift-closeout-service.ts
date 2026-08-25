interface CloseoutQuestionErrorMap {
  [key: string]: string;
}

export type CloseoutShift = "day" | "swing" | "night";
export type CloseoutState = "not_started" | "draft" | "submitted";

export interface CloseoutScope {
  actorUserId: string;
  organizationId: string;
  pilotId: string;
}

export interface CloseoutRecord {
  id: string;
  actorUserId: string;
  organizationId: string;
  pilotId: string;
  workDate: string;
  shift: CloseoutShift;
  crew: string | null;
  trade: string | null;
  answers: CloseoutQuestionErrorMap;
  status: "draft" | "submitted";
  submittedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GetCloseoutResponse {
  scope: CloseoutScope;
  workDate: string;
  shift: CloseoutShift;
  state: CloseoutState;
  closeout: CloseoutRecord | null;
  crew: string | null;
  trade: string | null;
  availableQuestions: string[];
}

export interface CloseoutPayload {
  workDate: string;
  shift: CloseoutShift;
  status: "draft" | "submitted";
  answers: CloseoutQuestionErrorMap;
}

export interface SaveCloseoutResponse {
  state: CloseoutState;
  closeout: CloseoutRecord;
}

interface ErrorPayload {
  error?: string;
}

async function parseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & ErrorPayload;
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

export async function loadCloseout(payload: {
  workDate?: string;
  shift: CloseoutShift;
}): Promise<GetCloseoutResponse> {
  const query = new URLSearchParams();
  query.set("shift", payload.shift);
  if (payload.workDate) query.set("workDate", payload.workDate);
  const response = await fetch(`/api/testing/closeouts?${query.toString()}`, {
    credentials: "include",
  });
  return parseJson<GetCloseoutResponse>(response);
}

export async function saveCloseout(
  payload: CloseoutPayload,
): Promise<SaveCloseoutResponse> {
  const response = await fetch("/api/testing/closeouts", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return parseJson<SaveCloseoutResponse>(response);
}
