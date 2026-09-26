# Learnings

## [LRN-20260926-001] best_practice

**Logged**: 2026-09-26T12:59:00Z
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary

Align a migration file's version with the version recorded by Supabase after applying it through the connector.

### Details

The Supabase `apply_migration` tool assigned version `20260926125213` to the Radar site mapping migration, while the draft file was named with version `20260926000000`. Leaving both versions would make a later `db push` attempt to replay the trigger definitions.

### Suggested Action

After connector-driven DDL, read the remote migration ledger and rename the matching repository migration file before merging.

### Metadata

- Source: conversation
- Related Files: supabase/migrations/20260926125213_site_mapping_workspaces.sql
- Tags: supabase, migration, release
- Pattern-Key: infra.connector_migration_version
- Recurrence-Count: 1
- First-Seen: 2026-09-26
- Last-Seen: 2026-09-26

### Resolution

- **Resolved**: 2026-09-26T12:53:00Z
- **Commit/PR**: a08c593, #191
- **Notes**: Renamed the file to the remote migration version; direct SQL verified the private tables and RLS.

---
