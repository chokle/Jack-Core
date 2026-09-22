# Bounded Jack to Daz tasks

The admin runtime page can explicitly create one supported task: a Jack service health report. The report checks public Jack service liveness and runtime connectivity. It does not establish login, conversation quality, database health, or overall product acceptance.

`POST /api/daz-runtime/tasks` accepts only a UUID `task_id` and `kind: jack_health_report`. The server derives the requester from the resolved Clerk admin user ID, never a display name or request payload. `GET /api/daz-runtime/tasks/:id` retrieves only that requester's task. Both require existing admin authorization; the runtime service credential remains on the server. Redirects are rejected and requests have finite timeouts.

The browser saves the task ID under the current Clerk user before submitting. Retrying uses the same ID. Reopening retrieves the saved task and never submits automatically. Only a verified completed task exposes the option to create another report. A timeout leaves the outcome unknown; retrieve or retry the existing ID instead of generating a replacement. Browser storage holds only an ID, not private report contents. Clearing site data removes this local recovery pointer but does not delete the runtime task.

The runtime owns dispatch, execution, independent verification, immutable report storage, and durable receipts. The page displays PROPOSED, EXECUTED, VERIFIED, COMPLETED, or BLOCKED without converting a recommendation or timeout into a success. Completed responses require the matching task/requester, SHA256, completion timestamp, no outstanding action, and verification referencing the execution receipt. Reports and provenance can be inspected on the page; an internal artifact reference is not a public download URL.

Acceptance requires a real signed-in admin to explicitly create a report, observe COMPLETED with receipt, reopen and retrieve the same task, and verify a repeated submission returns the same task and artifact. CI fixtures establish protocol behavior, not live user acceptance.
