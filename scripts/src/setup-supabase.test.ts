import { beforeEach, describe, expect, it } from "vitest";
import {
  collectMigrationFiles,
  buildMigrationPlan,
  getMigrationVersion,
} from "./setup-supabase.js";

const MIGRATION_TO_APPLY = "20260801002756_restrict_match_rpc_execution.sql";
const MIGRATION_TO_APPLY_VERSION = "20260801002756";

describe("setup-supabase migration planning", () => {
  it("collects versioned sql migrations from the migrations directory", () => {
    const migrations = collectMigrationFiles();
    expect(migrations.length).toBeGreaterThanOrEqual(2);
    expect(migrations.every((migration) => migration.version === getMigrationVersion(migration.fileName))).toBe(true);
    expect(migrations.map((migration) => migration.fileName)).toContain(MIGRATION_TO_APPLY);
  });

  it("builds a full fresh-bootstrap plan when no foundation is present", () => {
    const migrations = collectMigrationFiles();
    const plan = buildMigrationPlan({
      migrations,
      includeBaseline: true,
      appliedVersions: new Set(),
    });
    expect(plan[0]?.fileName).toBe("20260701000000_jack_schema_baseline.sql");
    expect(plan).toContainEqual(
      expect.objectContaining({
        fileName: MIGRATION_TO_APPLY,
        version: MIGRATION_TO_APPLY_VERSION,
      }),
    );
  });

  it("builds the expected nine-version repair plan for a partial PR #17 schema", () => {
    const migrations = collectMigrationFiles();
    const plannedTarget = new Set(
      migrations
        .filter((migration) => migration.fileName !== MIGRATION_TO_APPLY)
        .map((migration) => migration.version),
    );
    const plan = buildMigrationPlan({
      migrations,
      includeBaseline: false,
      appliedVersions: plannedTarget,
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toEqual(
      expect.objectContaining({
        fileName: MIGRATION_TO_APPLY,
        version: MIGRATION_TO_APPLY_VERSION,
      }),
    );
  });
});
