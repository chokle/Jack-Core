# Pilot001 telemetry snapshot — 2026-08-24

Canonical goal: #49

## Window and source

- Pilot: `Rob Plumbing Pilot - August 2026`
- Pilot window covered by this snapshot: August 10, 2026 through August 24, 2026 at 20:36 PDT.
- Source of truth: production Supabase pilot membership, canonical test-session/event, Ask Jack persistence, interview, feedback, recording, ingest-failure, and report-run tables.
- A detailed participant-level export was generated and retained outside this public repository. This file intentionally contains aggregate evidence only.

## Verified aggregate evidence

| Measure | Verified value |
| --- | ---: |
| Active assigned pilot memberships | 6 |
| Participants with canonical test sessions | 3 |
| Canonical test sessions | 4 |
| Canonical test events | 54 |
| Ask Jack completed telemetry events | 17 |
| Persisted cohort user chat messages | 11 |
| Completed interview sessions | 1 |
| Interview questions | 7 |
| Feedback submissions | 1 |
| Persisted test recordings | 0 |
| Recorded ingest failures | 0 |
| Activity report runs | 0 |
| Activity heartbeat events | 0 |

Canonical test-event activity was observed on August 10 and August 11 PDT. No canonical test events were observed from August 12 through the snapshot time.

## Integrity verdict

**INCOMPLETE_TELEMETRY**

Verified active engagement duration cannot be reconstructed for the historical window because no `activity_heartbeat` events exist in production for that period. Duration must therefore remain unknown rather than being reported as zero.

Three of the six assigned memberships have canonical test-session telemetry. The other three cannot be classified as `VERIFIED_ZERO_ACTIVITY` from Supabase absence alone because authentication/sign-in evidence must be reconciled with the identity provider first.

There is also a measurement discrepancy between 17 Ask Jack completion events/session questions and 11 persisted cohort user chat messages. The two values represent different evidence paths and must not be silently treated as equivalent counts.

Three recording-start telemetry events were observed, while zero persisted test-recording rows exist for the pilot. Recording coverage is therefore not claimed.

## Pilot deadline correction

Production originally stored the pilot and all six active memberships as expiring at **August 25, 2026 23:59:59 PDT**, which contradicted the canonical 15-working-day pilot end date of **Friday, August 28, 2026**.

The production pilot end and all six active membership expiries were corrected atomically to **August 28, 2026 23:59:59 PDT**. A post-update query verified the pilot deadline and all six membership expiries.

## Methodology / confidence

- Cohort membership: `pilot_memberships`, scoped to Pilot001 and `active=true`.
- Canonical usage: `test_sessions` and `test_events`, scoped to the pilot window.
- Ask Jack persistence cross-check: `chat_messages`, scoped to cohort user IDs and the pilot window. Message contents were not needed for this aggregate snapshot.
- Interview cross-check: `interview_sessions`.
- Feedback cross-check: `test_feedback`.
- Recording cross-check: `test_recordings`.
- Telemetry integrity cross-check: `activity_ingest_failures` and `activity_report_runs`.
- Active-time confidence rule: without production heartbeat events, no verified duration claim is made.

## Remaining reconciliation

1. Verify the current production deployment contains the merged Pilot001 EOD/heartbeat path from #48 and the semantic correction from #50.
2. Reconcile the six assigned membership IDs against the six intended identity-provider accounts and sign-in evidence.
3. Run the deterministic EOD report against production after deployment verification and confirm that incomplete historical coverage remains explicit instead of becoming a false zero-activity conclusion.
