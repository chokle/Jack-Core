---
name: MemoryGraphView inspector render-tests
description: How to unit-test the node inspector (NodeDetailBody) without booting the whole graph view.
---

Render-test the inspector by mounting the exported `NodeDetailBody` directly (not `MemoryGraphView`), the same way the provenance test does. Build node fixtures through the real `buildGraphModelFromServer` mapper so they can't drift from the mapped `MemoryNode` shape.

**Why:** the full `MemoryGraphView` pulls in the spatial canvas + polling query hooks, so it's impractical to mount in jsdom. `NodeDetailBody` is the render surface for the whole inspector and is exported specifically so it can be tested in isolation.

**How to apply:**
- Inspector `Section`s are **collapsed by default** (except `Review`, which is `defaultOpen`). To assert their contents you must first click the header: `fireEvent.click(screen.getByRole("button", { name: /Captured Knowledge|Transcript|Source Videos|Competencies|Related Nodes/i }))`.
- The Captured-Content sections (`AnalysisContent` for video analysis+keyPoints, `TranscriptContent` for segments/cited passages) are the only children that fire a query hook — `useGetVideo`. Mock **only** that hook via `vi.mock(..., async importOriginal => ({ ...await importOriginal(), useGetVideo: () => ({ data, isLoading }) }))` so the real query-key helpers stay intact; then **no `QueryClientProvider` is needed**.
- Avoid **mentor** nodes unless you also mock `useGetMentorActiveSession` (fires from `MentorResumeAction`).
- Rebuild the `adjacency` / `knowledgeByVideoId` indexes in-test (the inspector receives them as props). This guards `NodeDetailBody`'s rendering, NOT the parent's index derivation — that plumbing stays uncovered by design.
- The transcript "Captured Content" never reads `video.transcript`; passages are derived from `video.segments` (matched to a concept's source `timestamps`).
