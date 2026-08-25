# Company Systems Review Skill

## Purpose

Prevent founder babysitting by continuously reviewing Torch/Jack as an operating system, not just a software repo.

This skill exists to identify what should happen next, what is slowing the company down, and what tools, automations, agents, integrations, services, or process changes can remove that drag.

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

3. Find leverage
   For every material friction point, ask:
   - Can an existing tool already solve this?
   - Can we connect two existing tools instead of creating a new workflow?
   - Can an agent or scheduled runner own it?
   - Can CI, webhooks, queues, cron, or event triggers remove human polling?
   - Can a reusable script or service replace repeated manual work?
   - Can data be made self-reporting instead of manually checked?
   - Can we buy/acquire a cheap service that saves more founder time than it costs?

4. Search before inventing
   Prefer proven public tools, GitHub projects, agent skills, APIs, SaaS, plugins, and infrastructure patterns when they fit. Do not build custom machinery when a reliable existing solution is materially faster.

5. Produce the next operating sequence
   Return only:
   - top 3–5 company moves in priority order;
   - what Daz/Foreman/Dex can execute without Derek;
   - any real founder decision or irreversible gate;
   - any tool/service/integration worth acquiring now;
   - what can be deleted, consolidated, or stopped.

6. Execute reversible leverage immediately
   If a recommended improvement is low-risk, reversible, within existing approved access/budget/credits, and does not require a founder-only decision, route it into the execution queue without asking Derek first.

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

Prefer tools that integrate with the existing stack and can be owned by Daz/Foreman rather than Derek.

## Anti-patterns

Do not:
- ask Derek to choose between routine technical options when one is clearly adequate;
- surface long lists of possible tools without ranking and acting;
- create another dashboard when an existing source can be automated;
- stop at a recommendation when the next reversible implementation step is available;
- rely on chat memory as the only persistence layer for an operating rule;
- confuse caution with progress.

## Completion standard

A review is successful when it results in fewer founder touchpoints and a clearer autonomous execution path, not when it merely produces a document.
