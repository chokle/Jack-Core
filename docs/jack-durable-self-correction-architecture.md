# Jack durable self-correction architecture

## Purpose

Jack must distinguish durable memory from conversation context. It must never
claim a correction was retained unless a durable write succeeded, and ordinary
conversation must never rewrite Jack's global identity or shared verified
knowledge.

## Memory layers

| Layer              | Contents                                                                                          | Write authority                                            | Retrieval rule                                         |
| ------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| Core Memory        | Jack's identity and behavioural rules                                                             | Authorized, versioned server configuration only            | Always precedes conversation and retrieval             |
| Verified Knowledge | Approved field claims with trade, provenance, revision, contributor, confidence, and review state | Existing Knowledge Review workflow                         | Reject rejected/superseded claims; preserve citations  |
| Learned Candidates | Corrections and contributions awaiting a decision                                                 | Authenticated capture; authorized review                   | Never treated as canonical while pending               |
| Episodic Memory    | User-owned chats and interviews                                                                   | The authenticated owner and narrowly scoped system workers | Isolated by owner; never promoted automatically        |
| Ephemeral Context  | Current request, retrieved snippets, and model working context                                    | Request runtime                                            | Discarded after the request; never described as memory |

No layer stores hidden chain of thought, psychological profiles, or autonomous
model self-modification.

The product-level candidate states are `pending`, `approved`, `rejected`, and
`superseded`. The current database predates that language: `accepted` and
`merged` are approved outcomes, while a replacement is represented by merging
the correction into the surviving canonical node and rejecting the conflicting
claim. An explicit `superseded` lifecycle state belongs in the future reviewed
schema revision described below.

## Correction flow

1. Detect explicit correction intent before answer generation.
2. Identify whether the correction targets Core Memory or field knowledge.
3. Attribute it to the server-authenticated user and preserve its source message.
4. If it exactly matches current Core Memory, report the existing version as
   durable. A different Core proposal is queued but cannot be published through
   conversation review; it requires an authorized configuration change.
5. Queue field corrections as pending candidates outside Living Memory.
6. A reviewer compares the candidate with current evidence and resolves the
   conflict. Pending candidates never enter answer retrieval.
7. Approved replacement knowledge must record provenance and prevent the
   rejected/superseded claim from ranking in retrieval.
8. Verify the result in a request with no prior conversational context.
9. Tell the user the actual state: durable Core Memory, pending review, or write
   failure.

Tonight's implementation establishes versioned Core identity, deterministic
identity answers, pending correction capture, honest persistence responses, and
rejected-claim filtering. A future schema revision should add explicit source
versions and `supersedes_source_id` to Verified Knowledge rather than encoding
all claim evolution in graph verification metadata.

## Answer verification contract

Before returning a technical answer, Jack must ensure:

- retrieved evidence supports the claim;
- citations refer to that evidence;
- rejected or superseded knowledge is not preferred;
- account, organization, and tenant boundaries remain intact;
- unfinished capabilities are not claimed;
- uncertainty is stated instead of invented.

These checks do not permit the model to reveal private evidence, bypass review,
or write global truth autonomously.

## Current source audit

The production Ask Jack runtime identity came from
`artifacts/api-server/src/lib/jurisdiction.ts`. Its prompt called Jack an
"AI Trade Intelligence Engine" and claimed Red Seal preparation. That prompt is
the direct source of the stale production answer and unsupported capability
language.

Other occurrences of the retired phrase exist in product-history documents,
repository descriptions, generated API banners, fixtures, and older
architecture copy. They are not Ask Jack's runtime identity authority.
User-facing landing and search metadata were updated with the hotfix; historical
and generated developer descriptions should be handled in a separate narrow
content pass rather than regenerating unrelated clients here.

The prior Ask learning path sent every useful-looking user message through
mentor distillation, which could reinforce or create Living Memory immediately.
The generated answer did not depend on the durable-write result, so it could
acknowledge a correction conversationally even when no durable correction
record existed. Explicit corrections now bypass automatic graph publication,
and their response is derived from the actual candidate-write result.

## Authorization and privacy

- Core Memory is code/configuration controlled and versioned in review.
- Ordinary users can propose but cannot publish a Core change.
- Correction candidates retain authenticated contributor provenance.
- Conversation-sourced corrections are excluded from the public pending panel;
  authorized reviewers can access them.
- `presentation-demo` content and private chat/interview content are not
  reassigned or promoted by this flow.
- Candidate writes use the existing server-only Supabase client; no new browser
  data surface or schema is introduced.

## Follow-up design work

- Add explicit canonical source version, effective date, content hash, and
  supersession columns through the reviewed authorization migration sequence.
- Require dual-control approval for global safety-critical corrections.
- Add a dedicated Core Memory proposal/audit store rather than sharing the
  general candidate queue.
- Validate citation-to-claim entailment mechanically for safety-critical
  answers.
- Add tenant-aware candidate review once organization/site isolation is
  production-ready.
