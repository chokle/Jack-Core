---
name: Client graph meta is whitelisted, not spread
description: Why new server node.meta fields silently vanish on the client unless the mapper + types are extended.
---

# Client graph `meta` is whitelisted, not spread

`KnowledgeNode.meta` in the OpenAPI spec is `additionalProperties: true`, so new
server-computed meta fields flow through codegen with **no** OpenAPI/Orval change.
But the jack-core client mapper (`buildGraphModelFromServer` in
`artifacts/jack-core/src/lib/memory-graph.ts`) does **not** spread server `meta`
onto the client `MemoryNode.meta`. It explicitly reads/parses each field via
dedicated `read*` helpers and assigns them one by one.

**Why:** the client `MemoryNode.meta` is a typed, curated shape (not `any`), and the
mapper coerces/normalizes each field. A field present in the server payload but not
read by the mapper is dropped on the floor — the UI never sees it, with no type error.

**How to apply:** whenever the server starts emitting a new `node.meta.<field>`,
you must, in the client, (1) add the field to the `MemoryNode.meta` interface, (2)
add a parser/read step in `buildGraphModelFromServer`, and (3) default it (e.g. `[]`)
so consumers don't branch on `undefined`. Verify with a unit test in
`memory-graph.test.ts` that feeds a server node and asserts the field survives.
