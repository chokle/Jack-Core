---
name: Citation field reuse for non-video sources
description: Ask Jack citations reuse the video-shaped fields for non-video Knowledge Entries; any new consumer must branch on sourceType.
---

Ask Jack citations are a single flat shape shared by two source kinds, discriminated by an optional `sourceType` (`"video" | "knowledge"`; absent = video, for pre-existing stored rows).

For a `"knowledge"` citation (a non-video Knowledge Entry), the video-shaped fields are REUSED rather than a bespoke object:
- `videoTitle` = entry title
- `text` = snippet
- `thumbnailUrl` = entry's first image url
- `startTime`/`endTime` = 0
- `videoId` = `""` (empty)
- `entryId` = the entry id

**Why:** keeps the Citation contract additive/backward-compatible (video fields stay required in OpenAPI, so old stored citations still parse and old clients ignore the new fields) and lets the frontend reuse one citation renderer instead of a parallel shape/table. Chat retrieval merges video + knowledge hits into the same `citations` array; history persists and replays them verbatim.

**How to apply:** any NEW consumer of a Citation must branch on `sourceType === "knowledge"` and must NOT treat `videoId` as always a real video — for knowledge it is `""` and there is no clip to jump to (don't call the jump/navigate handler). The video branch is unchanged.
