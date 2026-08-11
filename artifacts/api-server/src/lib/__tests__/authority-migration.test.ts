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
    const conflictMarker = "on conflict (source_id)";
    const conflictIndex = migration.indexOf(conflictMarker);
    expect(
      conflictIndex,
      `Migration is missing the required ${conflictMarker} clause`,
    ).toBeGreaterThanOrEqual(0);
    const replayUpdate = migration.slice(conflictIndex);
    expect(replayUpdate).not.toMatch(/\bstatus\s*=\s*excluded\.status/i);
    expect(replayUpdate).not.toMatch(
      /\bverified_at\s*=\s*excluded\.verified_at/i,
    );
    expect(replayUpdate).not.toMatch(
      /\bcontent_fingerprint\s*=\s*excluded\.content_fingerprint/i,
    );
    expect(replayUpdate).not.toMatch(
      /\blicense_access_classification\s*=\s*excluded\.license_access_classification/i,
    );
    expect(replayUpdate).not.toMatch(
      /\bpermitted_uses\s*=\s*excluded\.permitted_uses/i,
    );
  });

  function governingPrimaryConstraint(): string {
    const marker =
      "add constraint authoritative_sources_no_overlapping_active_primary";
    const markerIndex = migration.indexOf(marker);
    expect(
      markerIndex,
      `Migration is missing the required ${marker} clause`,
    ).toBeGreaterThanOrEqual(0);
    const terminatorIndex = migration.indexOf(";", markerIndex);
    expect(
      terminatorIndex,
      "Governing-primary exclusion constraint is missing its terminator",
    ).toBeGreaterThan(markerIndex);
    return migration.slice(markerIndex, terminatorIndex + 1);
  }

  it("rejects overlapping active governing-primary windows", () => {
    const constraint = governingPrimaryConstraint();
    expect(migration).toContain(
      "authoritative_sources_no_overlapping_active_primary",
    );
    expect(constraint).toMatch(
      /exclude using gist[\s\S]*daterange\([\s\S]*with &&/i,
    );
    expect(constraint).toMatch(
      /jurisdiction with =[\s\S]*source_type with =[\s\S]*edition with =/i,
    );
    expect(constraint).toMatch(
      /source_type in \('adopted_code', 'municipal_bylaw'\)[\s\S]*status in \('current', 'requires_review'\)/i,
    );
  });

  it("rejects competing active primaries with different document titles", () => {
    const constraint = governingPrimaryConstraint();
    expect(constraint).not.toMatch(/document_title\s+with\s+=/i);
    expect(constraint).toMatch(
      /jurisdiction with =[\s\S]*source_type with =[\s\S]*edition with =/i,
    );
  });

  it("rejects competing active primaries with different authorities", () => {
    const constraint = governingPrimaryConstraint();
    expect(constraint).not.toMatch(/authority\s+with\s+=/i);
    expect(constraint).toMatch(
      /jurisdiction with =[\s\S]*source_type with =[\s\S]*edition with =/i,
    );
  });

  it("keeps restricted sources free of authorized section locators", () => {
    expect(migration).toMatch(
      /license_access_classification <> 'restricted_metadata_only'[\s\S]*cardinality\(authorized_section_locators\) = 0/i,
    );
  });
});
