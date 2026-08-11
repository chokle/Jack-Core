import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../supabase/migrations/20260811120000_authoritative_source_registry.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

describe("authoritative source registry migration", () => {
  it("preserves reconciliation state when seed rows are replayed", () => {
    const replayUpdate = migration.slice(
      migration.indexOf("on conflict (source_id)"),
    );
    expect(replayUpdate).not.toMatch(/\bstatus\s*=\s*excluded\.status/i);
    expect(replayUpdate).not.toMatch(
      /\bverified_at\s*=\s*excluded\.verified_at/i,
    );
    expect(replayUpdate).not.toMatch(
      /\bcontent_fingerprint\s*=\s*excluded\.content_fingerprint/i,
    );
  });

  it("rejects overlapping active governing-primary windows", () => {
    expect(migration).toContain(
      "authoritative_sources_no_overlapping_active_primary",
    );
    expect(migration).toMatch(
      /exclude using gist[\s\S]*daterange\([\s\S]*with &&/i,
    );
    expect(migration).toMatch(
      /jurisdiction with =[\s\S]*authority with =[\s\S]*document_title with =[\s\S]*edition with =/i,
    );
    expect(migration).toMatch(
      /source_type in \('adopted_code', 'municipal_bylaw'\)[\s\S]*status in \('current', 'requires_review'\)/i,
    );
  });

  it("keeps restricted sources free of authorized section locators", () => {
    expect(migration).toMatch(
      /license_access_classification <> 'restricted_metadata_only'[\s\S]*cardinality\(authorized_section_locators\) = 0/i,
    );
  });
});
