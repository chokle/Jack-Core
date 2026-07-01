---
name: OpenAPI request-body schema naming vs operationId
description: Orval codegen collides when a request-body component schema shares the "<OperationId>Body" name.
---

# OpenAPI request-body schema naming collision

In this repo (`lib/api-spec/openapi.yaml`, Orval codegen), Orval auto-generates a
type named `<OperationId>Body` for an inline/referenced request body. If you also
define a `components.schemas` entry literally named `<OperationId>Body`, the two
collide and codegen emits duplicate/ambiguous types.

**Rule:** name request-body component schemas with an intent-based noun
(e.g. `StartInterviewInput`, `SubmitAnswerInput`), never `<OperationId>Body`.

**Why:** the generated-hook filename and body-type name are derived from
`info.title` + operationId; a same-named component schema shadows them. Cost us a
codegen failure that looked like a spec error but was purely a naming clash.

**How to apply:** whenever adding a POST/PUT/PATCH path, pick a distinct schema
name for the body, then run `pnpm --filter @workspace/api-spec run codegen` and
confirm both `lib/api-client-react` and `lib/api-zod` regenerate cleanly.
