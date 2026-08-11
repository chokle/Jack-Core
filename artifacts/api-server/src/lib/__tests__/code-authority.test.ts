import { describe, expect, it } from "vitest";
import {
  INITIAL_AUTHORITY_SOURCES,
  classifyCodeSensitiveQuestion,
  evaluateCodeSafetyGate,
  markRevisionFeedObservation,
  resolveJurisdiction,
  selectAuthoritySnapshot,
  sourceAllowsUse,
  type AuthoritativeSource,
  type PhotoCodeContext,
} from "../code-authority.js";

const bcContext = {
  province: "BC",
  municipality: "Burnaby",
  permitApplicationDate: "2026-08-11",
  measurements: [{ name: "trap arm", value: "1200", unit: "mm" }],
};

describe("code-sensitive question detector", () => {
  it.each([
    "Is this venting to code?",
    "What slope is required for this drain pipe?",
    "What is the minimum pipe diameter?",
    "Does this plumbing work need a permit?",
    "What clearance is required?",
  ])("classifies %s", (question) => {
    expect(classifyCodeSensitiveQuestion(question).isCodeSensitive).toBe(true);
  });

  it("leaves an ordinary technique question on the existing path", () => {
    expect(
      classifyCodeSensitiveQuestion("How do I keep a consistent torch angle?"),
    ).toEqual({
      isCodeSensitive: false,
      topics: [],
      requiresMeasurements: false,
    });
  });
});

describe("jurisdiction and edition resolution", () => {
  it("routes general BC and Vancouver separately", () => {
    expect(resolveJurisdiction(bcContext)).toMatchObject({
      status: "resolved",
      jurisdiction: "BC_GENERAL",
      applicableEdition: "2024",
    });
    expect(
      resolveJurisdiction({ ...bcContext, municipality: "City of Vancouver" }),
    ).toMatchObject({
      status: "resolved",
      jurisdiction: "VANCOUVER",
      applicableEdition: "2025",
    });
  });

  it("refuses an unknown municipality or AHJ", () => {
    expect(
      resolveJurisdiction({
        province: "BC",
        permitApplicationDate: "2026-08-11",
      }),
    ).toMatchObject({
      status: "missing_context",
      jurisdiction: "UNKNOWN_SPECIAL_AUTHORITY",
    });
  });

  it("does not silently use current code for a historical permit", () => {
    expect(
      resolveJurisdiction({
        ...bcContext,
        permitApplicationDate: "2023-12-01",
      }),
    ).toMatchObject({
      status: "historical_source_required",
      applicableEdition: null,
    });
  });

  it("blocks an explicit edition conflict", () => {
    expect(
      resolveJurisdiction({ ...bcContext, explicitCodeEdition: "2018" }),
    ).toMatchObject({ status: "edition_conflict" });
  });
});

describe("authority snapshot and supersession", () => {
  it("selects superseded material only for its historical effective window", () => {
    const historical = selectAuthoritySnapshot(
      resolveJurisdiction({
        province: "BC",
        municipality: "Vancouver",
        permitApplicationDate: "2025-10-01",
      }),
      INITIAL_AUTHORITY_SOURCES,
    );
    expect(historical?.sources[0]).toMatchObject({
      sourceId: "vancouver-plumbing-bylaw-2025-original",
      status: "superseded",
    });

    const current = selectAuthoritySnapshot(
      resolveJurisdiction({
        province: "BC",
        municipality: "Vancouver",
        permitApplicationDate: "2026-01-01",
      }),
      INITIAL_AUTHORITY_SOURCES,
    );
    expect(current?.sources[0]?.sourceId).toBe(
      "vancouver-plumbing-bylaw-2025-current",
    );
    expect(
      current?.sources.some(
        ({ sourceId }) => sourceId === "vancouver-plumbing-bylaw-2025-original",
      ),
    ).toBe(false);
  });

  it("marks a changed revision feed for review", () => {
    const feed = INITIAL_AUTHORITY_SOURCES.find(
      ({ sourceType }) => sourceType === "revision_feed",
    )!;
    expect(markRevisionFeedObservation(feed, "new-fingerprint").status).toBe(
      "requires_review",
    );
  });

  it("blocks the authority snapshot until a changed revision feed is reconciled", () => {
    const sources = INITIAL_AUTHORITY_SOURCES.map((item) =>
      item.sourceType === "revision_feed"
        ? markRevisionFeedObservation(item, "new-fingerprint")
        : item,
    );
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.missing).toContain(
      "Reconciliation of the changed official revision feed",
    );
  });
});

describe("licensing and code safety gate", () => {
  it("keeps every restricted source metadata-only", () => {
    for (const item of INITIAL_AUTHORITY_SOURCES.filter(
      ({ licenseAccessClassification }) =>
        licenseAccessClassification === "restricted_metadata_only",
    )) {
      expect(sourceAllowsUse(item, "metadata")).toBe(true);
      expect(sourceAllowsUse(item, "section_retrieval")).toBe(false);
      expect(sourceAllowsUse(item, "model_context")).toBe(false);
      expect(sourceAllowsUse(item, "embedding")).toBe(false);
    }
  });

  it("blocks generic knowledge when authoritative text is unavailable", () => {
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources: INITIAL_AUTHORITY_SOURCES,
    });
    expect(result.outcome).toBe("blocked");
    expect(result.missing).toContain(
      "Licensed section-level authoritative evidence",
    );
    expect(result.citations[0]).toMatchObject({
      jurisdiction: "BC_GENERAL",
      document: "British Columbia Plumbing Code 2024",
      edition: "2024",
      section: null,
      effectiveDateBasis: "2026-08-11",
      sourceStatus: "current",
      amendmentIndicator: "bc_amendment",
      contentAvailability: "metadata_only",
    });
  });

  it("requires measurements for dimensional questions", () => {
    const result = evaluateCodeSafetyGate({
      question: "What slope is required for this drain pipe?",
      context: { ...bcContext, measurements: [] },
      sources: INITIAL_AUTHORITY_SOURCES,
    });
    expect(result.missing).toContain(
      "Relevant field measurements and configuration details",
    );
  });

  it("never falls from Vancouver into BC general", () => {
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: { ...bcContext, municipality: "Vancouver" },
      sources: INITIAL_AUTHORITY_SOURCES,
    });
    expect(result.jurisdiction).toBe("VANCOUVER");
    expect(result.citations[0]?.authority).toBe("City of Vancouver");
    expect(
      result.citations.some(
        ({ document }) => document === "British Columbia Plumbing Code 2024",
      ),
    ).toBe(false);
  });

  it("rejects evidence from another authority snapshot", () => {
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources: INITIAL_AUTHORITY_SOURCES,
      evidence: [
        {
          sourceId: "vancouver-plumbing-bylaw-2025-current",
          section: "2.x",
          content: "Synthetic test evidence only.",
        },
      ],
    });
    expect(result.missing).toContain(
      "Evidence limited to the selected authority snapshot",
    );
  });

  it("allows only a resolved snapshot with explicitly licensed evidence", () => {
    const licensed = INITIAL_AUTHORITY_SOURCES.map((item) =>
      item.sourceId === "bc-plumbing-code-2024"
        ? ({
            ...item,
            licenseAccessClassification: "open_legislation",
            permittedUses: [
              ...item.permittedUses,
              "section_retrieval",
              "model_context",
            ],
          } satisfies AuthoritativeSource)
        : item,
    );
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources: licensed,
      evidence: [
        {
          sourceId: "bc-plumbing-code-2024",
          section: "synthetic-section",
          content: "Synthetic test evidence only.",
        },
      ],
    });
    expect(result.outcome).toBe("allowed");
    expect(result.authoritySnapshotId).toContain("BC_GENERAL:2024");
    expect(result.citations[0]?.section).toBe("synthetic-section");
  });
});

it("defines the photo contract without a jurisdiction field", () => {
  const photoContext: PhotoCodeContext = {
    trade_topic: "plumbing",
    observed_components: ["vent pipe"],
    visible_measurements: [],
    missing_measurements: ["trap arm length"],
    uncertainties: ["concealed connection"],
    immediate_hazards: [],
    code_questions: ["venting applicability"],
    retrieval_terms: ["venting trap arm"],
  };
  expect("jurisdiction" in photoContext).toBe(false);
});
