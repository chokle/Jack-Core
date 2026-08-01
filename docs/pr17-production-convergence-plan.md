# PR #17 Production Convergence Plan

Status: rehearsal complete; production execution is not authorized.

Target branch and verified head:

- `agent/phase-2-user-activity-telemetry`
- `f31efeefc45934601a8013d94e40c3c0f2483a6b`

Recovery evidence:

- Latest physical backup: `2026-07-29 10:25:36 UTC`
  (`2026-07-29 03:25:36 PDT`)
- Daily physical restore points are visible for July 22–29.
- PITR is disabled and must remain disabled.
- Supabase Storage objects are not included in physical database backups.

## Safety invariants

- Stop if the target project reference is not the approved production project.
- Never use `--include-all`.
- Never record either historical baseline migration until its required
  postconditions pass.
- Keep `TELEMETRY_RETENTION_ENABLED` absent or set to a value other than the
  exact string `true`.
- Keep all pilot memberships inactive or absent until telemetry collection is
  separately approved.
- Do not proceed if any video row has a retired or unknown status.
- Do not proceed if any migration, integrity test, lint, or ledger check fails.

## Reconciliation delta

Execute
[`supabase/reconciliation/pr17_production_baseline_delta.sql`](../supabase/reconciliation/pr17_production_baseline_delta.sql)
with `psql -v ON_ERROR_STOP=1`.

The transaction:

1. Refuses to run when baseline tables are missing, when videos contain
   non-current status values, or when knowledge edges contain unknown kinds.
2. Creates the private `test_feedback` table, indexes, RLS state, and grants.
3. Changes only the `videos.status` default to `queued`; it does not transform
   existing video rows.
4. installs the current `videos_status_check`.
5. Replaces `match_videos` so only `completed` videos are eligible.
6. Replaces `match_transcript_segments` with `hnsw.ef_search = 100`.
7. Adds `contributor` to the accepted knowledge-edge kinds.
8. Asserts every expected definition and privilege before commit.

The status and edge constraints are installed `NOT VALID` and then validated.
This minimizes the initial lock but validation still scans each affected table.
The script uses a 10-second lock timeout and a five-minute statement timeout.

## Encrypted pre-migration logical dump

Prerequisites:

- PostgreSQL 17 client tools
- GnuPG 2.x
- an approved recovery public key
- a local destination on an encrypted, access-controlled volume outside Git

PowerShell procedure:

```powershell
$releaseRoot = $env:PR17_BACKUP_ROOT
if ([string]::IsNullOrWhiteSpace($releaseRoot)) {
  throw 'PR17_BACKUP_ROOT must name the approved encrypted local destination'
}
$dumpPath = Join-Path $releaseRoot 'jack-pr17-pre-migration.dump'
$encryptedPath = "$dumpPath.gpg"
$checksumPath = "$encryptedPath.sha256"

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
icacls $releaseRoot /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"

pg_dump --version
gpg --version
pg_dump --format=custom --no-owner --file=$dumpPath $env:PR17_PROD_DB_URL
gpg --batch --yes --recipient $env:PR17_BACKUP_GPG_RECIPIENT `
  --output $encryptedPath --encrypt $dumpPath
Get-FileHash -Algorithm SHA256 $encryptedPath |
  Format-List Algorithm,Hash,Path |
  Out-File -Encoding ascii $checksumPath

gpg --batch --decrypt --output "$dumpPath.verify" $encryptedPath
pg_restore --list "$dumpPath.verify" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Encrypted dump verification failed' }
Remove-Item -LiteralPath $dumpPath,"$dumpPath.verify"
```

The production database URL and GPG recipient are supplied through the process
environment and must never be printed or written to Git. Restore validation
must recreate a disposable PostgreSQL 17 database and run `pg_restore` against
it before migration authorization. Keep the encrypted dump and checksum for
the approved release-retention window. Its deletion requires a separate,
logged retention action. Storage objects require a separate inventory and
backup procedure.

## Ordered production procedure

All target-display steps must show only the project reference and redacted
host, never credentials.

1. Confirm the PR head, production project reference, physical backup, health,
   and previous known-good Railway deployment.
2. Create and restore-validate the encrypted logical dump above.
3. Record video-status counts and abort unless every row uses a current status:

   ```sql
   select status, count(*) from public.videos group by status order by status;
   ```

4. Run the reviewed reconciliation transaction:

   ```powershell
   psql $env:PR17_PROD_DB_URL -v ON_ERROR_STOP=1 `
     -f supabase/reconciliation/pr17_production_baseline_delta.sql
   ```

5. Re-run the delta postconditions independently, compare schema definitions
   with `20260701000000`, and only then record the baseline:

   ```powershell
   pnpm exec supabase migration repair 20260701000000 `
     --status applied --linked
   if ($LASTEXITCODE -ne 0) { throw 'First baseline ledger repair failed' }
   ```

6. Execute the second baseline migration and verify grants:

   ```powershell
   psql $env:PR17_PROD_DB_URL -v ON_ERROR_STOP=1 `
     -f supabase/migrations/20260701010000_command_centre_prerequisites.sql
   ```

   Required result: RLS stays enabled, `anon` and `authenticated` have no table
   privileges, `service_role` retains full table access, and all tables,
   constraints, indexes, and rows remain intact.

7. Only after those checks pass, record the second baseline:

   ```powershell
   pnpm exec supabase migration repair 20260701010000 `
     --status applied --linked
   if ($LASTEXITCODE -ne 0) { throw 'Second baseline ledger repair failed' }
   ```

8. Preview the pending set. It must contain exactly four versions:

   ```powershell
   pnpm exec supabase db push --linked --dry-run
   ```

   Expected:

   - `20260724091752_add_test_feedback.sql`
   - `20260724143000_add_user_test_sessions.sql`
   - `20260727042325_secure_public_api_surface.sql`
   - `20260727123000_preserve_report_snapshots_on_account_delete.sql`

9. Apply only that set in timestamp order:

   ```powershell
   pnpm exec supabase db push --linked
   ```

10. Run both integrity suites against the approved production connection:

    ```powershell
    psql $env:PR17_PROD_DB_URL -v ON_ERROR_STOP=1 `
      -f supabase/tests/telemetry_scope_integrity.sql
    psql $env:PR17_PROD_DB_URL -v ON_ERROR_STOP=1 `
      -f supabase/tests/report_account_deletion_integrity.sql
    ```

11. Run lint and ledger verification:

    ```powershell
    pnpm exec supabase db lint --linked --schema public,private `
      --level error --fail-on error
    pnpm exec supabase migration list --linked
    ```

    The ledger must contain all nine versions with no local-only entry.

## Pending-migration risk

| Version | Effect | Lock/data risk | Repeatability and verification |
| --- | --- | --- | --- |
| `20260724091752` | Creates private `test_feedback`, indexes, RLS, and service-role-only grants. | Brief catalog/table locks; index builds are non-concurrent. No data rewrite. | `IF NOT EXISTS`; reconciliation already creates the equivalent table. Verify RLS and grants. |
| `20260724143000` | Creates organization/pilot/consent/session/event/report/audit structures; extends recordings and feedback; adds constraints, triggers, indexes, RLS, and grants. | Highest-risk migration. Multiple non-concurrent indexes and validated foreign keys can scan existing `test_recordings` and `test_feedback`. No intended deletion. | Rehearsed twice. Verify constraints, triggers, empty new tables, tenant tests, and fixture cleanup. |
| `20260727042325` | Revokes browser access to server-only product tables/RPCs, pins function search paths, grants service-role access, and adds one index. | Brief ACL/catalog locks and one index build. No row rewrite. | Idempotent privilege/function operations. Verify browser denial and service-role access. |
| `20260727123000` | Makes report requester attribution nullable. | Brief `ACCESS EXCLUSIVE` metadata lock on `activity_report_runs`; no table rewrite expected on PostgreSQL 17. | Idempotent. Verify nullability and account-deletion integrity. |

## Telemetry collection and retention

`TELEMETRY_RETENTION_ENABLED` controls only the destructive retention worker:

- absent or any value other than exact `true`: worker does not run;
- `true`: an immediate sweep runs, then repeats every six hours.

There is no independent environment kill switch for canonical event collection.
Collection requires all of the following server-validated state:

- a trusted, non-presentation identity;
- an active tester membership in an active pilot;
- current telemetry consent;
- one active test session whose telemetry status is `granted`.

The migration creates none of those memberships, consents, or sessions.
Therefore the UI/API can be deployed while canonical collection remains
disabled only if production has no active tester memberships and none are
created. This database-state gate must be checked immediately before and after
deployment. Adding a dedicated server-side collection kill switch is the
recommended defense-in-depth follow-up before enrolling production testers.

## Rollback

| Stage | Trigger | Action |
| --- | --- | --- |
| Dump | Dump, encryption, checksum, or restore validation fails | Stop before database mutation. |
| Delta transaction | Any precondition, lock timeout, or postcondition fails | PostgreSQL rolls back the entire delta. Preserve output and investigate. |
| Delta committed, baseline not repaired | Application/schema smoke check fails | Stop; use reviewed reverse DDL or restore the verified logical/physical backup. Do not repair the ledger. |
| First ledger repair | Equivalence evidence changes | Stop. Repair back to `reverted` only under explicit approval, then restore schema if needed. |
| Second baseline execution | Grant/RLS/service-role check fails | Stop before repair. Transactionally restore captured grants or restore backup. |
| Pending migrations | Any migration or integrity test fails | Stop deployment. Prefer restore to the pre-migration physical/logical backup because later DDL is not wholly reversible. |
| Application deployment | Health, auth, telemetry, or report smoke test fails | Roll Railway back to the recorded known-good deployment. Database rollback remains a separate approved recovery decision. |
| Unauthorized collection | Any event is recorded without all required gates | Disable pilot memberships, roll application back, preserve audit evidence, and begin the approved privacy incident procedure. |

Do not assume an application rollback reverses database changes. A physical
restore is project-wide and can lose writes after the restore point. A logical
restore is slower and object-order/ownership differences require validation.
