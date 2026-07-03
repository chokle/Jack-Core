---
name: Orval useQuery requires explicit queryKey
description: This repo's generated React Query hooks make queryKey a REQUIRED field when you pass a query options object, or tsc fails TS2741.
---

# Orval useQuery requires an explicit `queryKey`

When calling a generated hook (e.g. `useGetVideo(id, { query: { ... } })`) with a
`query` options object, TypeScript fails with `TS2741: Property 'queryKey' is
missing in type ... but required in type 'UseQueryOptions<...>'`.

**Fix:** always include a `queryKey` in the `query` object. Prefer the generated
key helper for cache consistency:
`useGetVideo(id, { query: { enabled, queryKey: getGetVideoQueryKey(id) } })`.
The `getGet<Operation>QueryKey` helpers are exported from
`@workspace/api-client-react` alongside each hook.

**Why:** this repo's Orval config surfaces `queryKey` as a required property on
the query options type (it is not silently defaulted when you supply your own
`query` object). Omitting it type-errors even though the underlying default key
would have worked at runtime.

**How to apply:** any time you add or edit a generated-hook call with custom
query options (`enabled`, `refetchInterval`, etc.), add the matching
`getGet<Operation>QueryKey(...)`. If two call sites want to share cache, they
must use the SAME key (e.g. VideoDetail uses a hand-written `['video', id]` while
other sites use `getGetVideoQueryKey(id)` — those two do NOT share cache, causing
one extra fetch; harmless but worth knowing).
