export const ACTIVE_INTERVIEW_SESSION_KEY = "jack.interview.activeSessionId";

/**
 * Stores the server-selected session ID used to hand off into Interview Mode.
 * The server remains the source of truth; a failed browser write must not open
 * Interview Mode and accidentally create a replacement session.
 */
function storeInterviewResumeSession(sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    sessionStorage.setItem(ACTIVE_INTERVIEW_SESSION_KEY, sessionId);
    localStorage.removeItem(ACTIVE_INTERVIEW_SESSION_KEY);
    return sessionStorage.getItem(ACTIVE_INTERVIEW_SESSION_KEY) === sessionId;
  } catch {
    return false;
  }
}

export function handoffInterviewResume(
  sessionId: string,
  openInterview: () => void,
): boolean {
  if (!storeInterviewResumeSession(sessionId)) return false;
  openInterview();
  return true;
}
