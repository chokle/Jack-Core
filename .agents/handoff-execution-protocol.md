# Handoff Execution Protocol

When Dee hands off a task, acceptance of the task is not completion and a written work order is not execution.

## Required sequence
1. Capture the goal and success condition.
2. Create or update persistent task state (issue, branch, artifact, workflow, or equivalent) when useful.
3. Start real execution in the same turn using available tools.
4. Leave a resumable checkpoint containing:
   - task
   - current state
   - last completed action
   - next executable action
   - blocker, if any
5. Report only verified movement. Never describe assignment or scoping as active implementation.

## Definition of "started"
A task is started only after a tool/action has materially changed the execution state: code written, account provisioned, workflow launched, application submitted, deployment triggered, test run started, artifact created, etc.

## Continuity rule
Leaving the chat/thread must not be treated as a reason for work state to disappear. Persistent state must be sufficient to resume without asking Dee to reconstruct the task.

## Hard boundaries
Stop only for genuinely required founder action or irreversible/high-risk boundaries such as spend, credentials/2FA, destructive production-data changes, legal/medical consent, or platform-required personal confirmation.

## Reporting rule
Use: outcome -> blocker (if any) -> next owned action. Avoid status theatre and permission-seeking for reversible work.
