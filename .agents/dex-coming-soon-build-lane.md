# Dex Build Lane — Jack Side Drawer Coming Soon

Owner: Dex
Priority: Active build lane

Goal: Replace every current `soon` placeholder in `artifacts/jack-core/src/components/JackShell.tsx` with a working, production-safe Jack surface.

Current placeholders, in execution order:
1. Dashboard
2. Competencies
3. Insights

Definition of done for each surface:
- real `JackView`/route or equivalent navigation state; no dead placeholder
- useful first-load content using existing Jack data/APIs where available
- loading, empty, error, and unauthorized states
- responsive mobile + desktop side-drawer navigation
- no regression to Ask Jack, Living Memory, Library, Interview, Review, Pilot Reports, or Closeout
- emits/propagates Jack UI context so persistent Ask Jack/voice awareness knows the current surface and relevant selected records
- safe telemetry hooks consistent with existing participant/testing conventions
- focused regression coverage, typecheck, production build, and CI green
- only remove the `soon` badge for that item after acceptance passes

Product intent:
- Dashboard: user-facing operational/home overview for Jack, not Command Centre admin duplication. Surface useful personal/session/memory/activity signals and clear next actions.
- Competencies: browse/search trade competency structure and connect competencies to Jack's existing Living Memory, sources, and relevant knowledge.
- Insights: derived, evidence-backed takeaways from Jack's captured memory/activity. Avoid fabricated intelligence; every insight should be traceable to existing data or explicitly marked as insufficient-data.

Execution rule: build sequentially and keep each surface independently shippable. Do not wait for all three before opening/merging a completed surface.
