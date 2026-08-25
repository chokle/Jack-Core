# Company Systems Review Skill

## Purpose

Prevent founder babysitting by continuously reviewing Torch/Jack as an operating system, not just a software repo.

This skill exists to identify what should happen next, what must be true before the next company move can succeed, what is slowing the company down, and what tools, automations, agents, integrations, services, or process changes can remove that drag.

## Trigger conditions

Run this review when any of the following is true:
- a major build phase, pilot phase, funding phase, or launch phase is nearing completion;
- Derek says momentum is slowing, he is babysitting execution, or too many routine decisions are escalating to him;
- the queue has multiple completed components but no clear next operating sequence;
- a recurring manual task appears more than once;
- a blocker is caused by tooling, access, coordination, monitoring, deployment, data movement, reporting, or handoff friction;
- a new product/company stage creates new operational needs.

## Operating principle

Derek defines outcomes and founder-level constraints. Daz owns the route. Routine reversible decisions do not go back to Derek for permission.

The review must optimize for founder leverage: reduce Derek's coordination load, context switching, status chasing, manual data movement, and repeated approval loops.

## Stage prerequisite map

Before moving Torch into a new stage, build a prerequisite map for that destination.

For the intended next move, identify:
- what must already exist;
- what evidence must be available;
- what access, rights, data, infrastructure, people, funding, or integrations are required;
- what dependencies can run in parallel;
- what dependency has the longest lead time;
- what can be deferred without blocking the move;
- what failure would make the move premature.

Treat prerequisites like construction readiness: do not mobilize a downstream crew while a critical upstream dependency is still unknown. Start long-lead prerequisites early and keep independent work moving in parallel.

Typical prerequisite categories include:
- product readiness;
- production reliability;
- pilot/customer evidence;
- telemetry and reporting;
- legal/licensing/consent;
- funding/grant eligibility and documents;
- sales collateral and proof points;
- infrastructure and credits;
- account/credential access;
- operational ownership;
- monitoring and rollback;
- next-customer onboarding readiness.

Every major objective should have a short readiness state:
- READY — prerequisites satisfied;
- AT RISK — objective can proceed, but one or more non-fatal prerequisites need active mitigation;
- BLOCKED — a prerequisite must be resolved first.

## Jack internal operating role

Jack is part of Torch's operating system, not only the customer-facing product.

Where Jack's existing knowledge, memory, retrieval, provenance, or reasoning capabilities can help internal execution, include him in the loop. Examples:
- maintain a living map of Torch product/company knowledge that is appropriate for internal use;
- surface relevant prior decisions, pilot evidence, product constraints, and provenance when Daz/Foreman are planning work;
- identify contradictions or stale assumptions between current plans and recorded evidence;
- help assemble prerequisite/readiness briefs from approved internal sources;
- help answer internal product/domain questions using the same citation discipline expected in the field;
- flag gaps where the team is repeatedly reconstructing context Jack could retain or retrieve.

Do not make Jack a ceremonial participant. Give him bounded internal jobs where his participation reduces context reconstruction or improves decision quality. Keep customer, pilot, confidential, and authority boundaries intact.

## Review loop

1. Inspect current company state
   - active pilots and deadlines
   - production/deployment status
   - open PRs/issues and blocked work
   - licensing/rights dependencies
   - funding/grant pipeline
   - outreach/sales pipeline
   - telemetry/reporting quality
   - recurring founder-admin burden

2. Identify friction
   Classify each item as one of:
   - execution bottleneck
   - missing automation
   - missing monitoring
   - missing integration
   - missing source of truth
   - duplicated manual work
   - unnecessary founder gate
   - tooling gap
   - process gap
   - external dependency
   - missing prerequisite

3. Build the prerequisite map
   For each top company move:
   - define the acceptance condition;
   - enumerate prerequisite dependencies;
   - identify long-lead dependencies first;
   - mark each READY, AT RISK, or BLOCKED;
   - route every reversible prerequisite into execution immediately;
   - do not wait for one dependency when independent prerequisites can proceed in parallel.

4. Find leverage
   For every material friction point, ask:
   - Can an existing tool already solve this?
   - Can we connect two existing tools instead of creating a new workflow?
   - Can Jack own or assist with the context/retrieval portion?
   - Can an agent or scheduled runner own it?
   - Can CI, webhooks, queues, cron, or event triggers remove human polling?
   - Can a reusable script or service replace repeated manual work?
   - Can data be made self-reporting instead of manually checked?
   - Can we buy/acquire a cheap service that saves more founder time than it costs?

5. Search before inventing
   Prefer proven public tools, GitHub projects, agent skills, APIs, SaaS, plugins, and infrastructure patterns when they fit. Do not build custom machinery when a reliable existing solution is materially faster.

6. Produce the next operating sequence
   Return only:
   - top 3–5 company moves in priority order;
   - readiness status and critical prerequisites for each;
   - what Daz/Foreman/Dex/Jack can execute without Derek;
   - any real founder decision or irreversible gate;
   - any tool/service/integration worth acquiring now;
   - what can be deleted, consolidated, or stopped.

7. Execute reversible leverage immediately
   If a recommended improvement or prerequisite is low-risk, reversible, within existing approved access/budget/credits, and does not require a founder-only decision, route it into the execution queue without asking Derek first.

## Tool-acquisition rule

A tool is worth adding when it clearly reduces one or more of:
- founder time;
- execution latency;
- missed follow-up;
- coordination overhead;
- deployment risk;
- manual monitoring;
- repeated context reconstruction;
- duplicate data entry.

Prefer tools that integrate with the existing stack and can be owned by Daz/Foreman/Jack rather than Derek.

## Anti-patterns

Do not:
- ask Derek to choose between routine technical options when one is clearly adequate;
- surface long lists of possible tools without ranking and acting;
- create another dashboard when an existing source can be automated;
- stop at a recommendation when the next reversible implementation step is available;
- rely on chat memory as the only persistence layer for an operating rule;
- start a major company move without identifying its critical prerequisites;
- leave Jack out of internal work where his existing capabilities can materially reduce context reconstruction;
- confuse caution with progress.

## Completion standard

A review is successful when it results in fewer founder touchpoints, visible readiness for the next company stage, and a clearer autonomous execution path — not when it merely produces a document.
