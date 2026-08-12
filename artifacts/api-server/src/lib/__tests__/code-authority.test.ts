import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_AUTHORITY_SOURCES,
  classifyCodeSensitiveQuestion,
  evaluateCodeSafetyGate,
  markRevisionFeedObservation,
  reconcileRevisionFeedObservations,
  resolveJurisdiction,
  selectAuthoritySnapshot,
  sourceAllowsUse,
  type AuthoritativeSource,
  type AuthorityContext,
  type PhotoCodeContext,
} from "../code-authority.js";

const bcContext = {
  province: "BC",
  municipality: "Burnaby",
  permitApplicationDate: "2026-08-11",
  projectType: "new construction",
  knownConditions: ["New permit application; no delayed provisions apply"],
  measurements: [{ name: "trap arm", value: "1200", unit: "mm" }],
};

describe("code-sensitive question detector", () => {
  it.each([
    "is this legal?",
    "can I install this?",
    "does this pass?",
    "what size does code require?",
    "inspection requirement",
    "minimum slope",
    "required clearance",
  ])("classifies %s", (question) => {
    expect(classifyCodeSensitiveQuestion(question).isCodeSensitive).toBe(true);
  });

  it.each([
    "How do I keep a consistent torch angle?",
    "How do I level a welding table slope?",
    "How can we improve workplace drainage?",
    "Where did I put the clearance wrench?",
  ])("leaves ordinary-use phrasing on the existing path: %s", (question) => {
    expect(classifyCodeSensitiveQuestion(question)).toEqual({
      isCodeSensitive: false,
      topics: [],
      requiresMeasurements: false,
    });
  });
});

describe("authority context provenance", () => {
  it("identifies municipality and permit date as supplied context", () => {
    const result = resolveJurisdiction({
      province: "BC",
      municipality: "Burnaby",
      permitApplicationDate: "2026-08-11",
    });

    expect(result.known).toContain(
      "Municipality/AHJ (supplied context): Burnaby",
    );
    expect(result.known).toContain(
      "Permit/application date (supplied context): 2026-08-11",
    );
  });

  it("fails closed when an explicit edition conflicts with effective-date rules", () => {
    const result = resolveJurisdiction({
      province: "BC",
      municipality: "Vancouver",
      permitApplicationDate: "2025-10-01",
      explicitCodeEdition: "2024",
    });

    expect(result.status).toBe("edition_conflict");
    expect(result.applicableEdition).toBe("2025");
    expect(result.known).toContain(
      "Explicit code edition (supplied context): 2024",
    );
  });

  it("fails closed when municipality and supplied AHJ conflict", () => {
    const result = resolveJurisdiction({
      province: "BC",
      municipality: "Vancouver",
      authorityHavingJurisdiction: "Burnaby",
      permitApplicationDate: "2026-08-11",
    });

    expect(result.status).toBe("unknown_special_authority");
    expect(result.jurisdiction).toBe("UNKNOWN_SPECIAL_AUTHORITY");
    expect(result.missing).toContain(
      "Resolve conflicting municipality and authority context values",
    );
    expect(result.known).toEqual(
      expect.arrayContaining([
        "Permit/application date (supplied context): 2026-08-11",
        "Municipality (supplied context): Vancouver",
        "Authority having jurisdiction (supplied context): Burnaby",
      ]),
    );
  });

  it.each([
    {
      label: "special authority",
      context: { ...bcContext, specialAuthority: true },
    },
    { label: "mine-related", context: { ...bcContext, mineRelated: true } },
    {
      label: "Treaty First Nation",
      context: { ...bcContext, municipality: "Example Treaty First Nation" },
    },
    {
      label: "non-BC",
      context: { ...bcContext, province: "Alberta" },
    },
  ])(
    "preserves all supplied provenance on the $label refusal path",
    ({ context }) => {
      const result = resolveJurisdiction(context);
      expect(result.status).toBe("unknown_special_authority");
      expect(result.known).toEqual(
        expect.arrayContaining([
          `Province (supplied context): ${context.province}`,
          `Municipality/AHJ (supplied context): ${context.municipality}`,
          "Permit/application date (supplied context): 2026-08-11",
          "Project type (supplied context): new construction",
          "Known condition (supplied context): New permit application; no delayed provisions apply",
        ]),
      );
    },
  );

  it("does not infer missing trusted project context", () => {
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      sources: INITIAL_AUTHORITY_SOURCES,
    });

    expect(result.outcome).toBe("blocked");
    expect(result.jurisdiction).toBe("UNKNOWN_SPECIAL_AUTHORITY");
    expect(result.known).toEqual([]);
  });

  it("preserves supplied provenance when authority context is incomplete", () => {
    const result = resolveJurisdiction({
      province: "BC",
      permitApplicationDate: "2026-08-11",
      explicitCodeEdition: "2024",
      projectType: "new construction",
      knownConditions: ["New permit application"],
    });
    expect(result.status).toBe("missing_context");
    expect(result.known).toEqual(
      expect.arrayContaining([
        "Province (supplied context): BC",
        "Permit/application date (supplied context): 2026-08-11",
        "Explicit code edition (supplied context): 2024",
        "Project type (supplied context): new construction",
        "Known condition (supplied context): New permit application",
      ]),
    );
  });

  it("does not accept photo content or EXIF as jurisdiction context", () => {
    const photoDerivedContext = {
      province: "BC",
      permitApplicationDate: "2026-08-11",
      photoExif: { municipality: "Vancouver" },
      observedMunicipality: "Vancouver",
    } as AuthorityContext;
    const result = resolveJurisdiction(photoDerivedContext);

    expect(result.status).toBe("missing_context");
    expect(result.jurisdiction).toBe("UNKNOWN_SPECIAL_AUTHORITY");
    expect(result.missing).toContain(
      "Municipality or authority having jurisdiction",
    );
  });

  it("does not treat an incidental standalone mine word as special authority", () => {
    const result = resolveJurisdiction({
      ...bcContext,
      knownConditions: [
        "New permit application; no delayed provisions apply; the tool is mine.",
      ],
    });

    expect(result).toMatchObject({
      status: "resolved",
      jurisdiction: "BC_GENERAL",
    });
  });

  it.each([
    {
      label: "known condition",
      context: {
        ...bcContext,
        knownConditions: [
          "New permit application; no delayed provisions apply; mine-related project authority applies.",
        ],
      },
    },
    {
      label: "project type",
      context: { ...bcContext, projectType: "mining project" },
    },
  ])("recognizes structured mine authority from $label", ({ context }) => {
    expect(resolveJurisdiction(context)).toMatchObject({
      status: "unknown_special_authority",
      jurisdiction: "UNKNOWN_SPECIAL_AUTHORITY",
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
        ...bcContext,
        municipality: "Unsupported Regional Authority",
      }),
    ).toMatchObject({
      status: "unknown_special_authority",
      jurisdiction: "UNKNOWN_SPECIAL_AUTHORITY",
    });
  });

  it("fails closed when project transition applicability is unresolved", () => {
    const result = resolveJurisdiction({
      province: "BC",
      municipality: "Burnaby",
      permitApplicationDate: "2026-08-11",
      projectType: "renovation",
      knownConditions: ["Existing permit; transition rule unresolved"],
    });
    expect(result).toMatchObject({
      status: "transition_context_required",
      applicableEdition: null,
    });
    expect(result.missing).toContain(
      "Resolution of in-stream or delayed-provision rules",
    );
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

  it("accepts one normalized explicit edition token", () => {
    expect(
      resolveJurisdiction({ ...bcContext, explicitCodeEdition: " 2024 " }),
    ).toMatchObject({ status: "resolved", applicableEdition: "2024" });
  });

  it.each([
    "2020-2024",
    "2018 and 2024",
    "2020 / 2024",
    "2020, 2024",
    "2020 or 2024",
  ])("blocks an ambiguous explicit edition: %s", (explicitCodeEdition) => {
    expect(
      resolveJurisdiction({ ...bcContext, explicitCodeEdition }),
    ).toMatchObject({
      status: "edition_conflict",
      applicableEdition: "2024",
    });
  });
});

describe("authority snapshot and supersession", () => {
  it("selects superseded material only for its historical effective window", () => {
    const historical = selectAuthoritySnapshot(
      resolveJurisdiction({
        province: "BC",
        municipality: "Vancouver",
        permitApplicationDate: "2025-10-01",
        projectType: "new construction",
        knownConditions: [
          "New permit application; no delayed provisions apply",
        ],
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
        projectType: "new construction",
        knownConditions: [
          "New permit application; no delayed provisions apply",
        ],
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

  it("rejects overlapping governing primary windows", () => {
    const duplicate = {
      ...INITIAL_AUTHORITY_SOURCES.find(
        ({ sourceId }) => sourceId === "bc-plumbing-code-2024",
      )!,
      sourceId: "bc-plumbing-code-2024-overlap",
      revisionId: "overlap",
    };
    expect(
      selectAuthoritySnapshot(resolveJurisdiction(bcContext), [
        ...INITIAL_AUTHORITY_SOURCES,
        duplicate,
      ]),
    ).toBeNull();
  });

  it("fails closed when the revision feed has never been fingerprinted", () => {
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources: INITIAL_AUTHORITY_SOURCES,
    });
    expect(result.missing).toContain(
      "Current revision-feed fingerprint reconciliation",
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
      "Current revision-feed fingerprint reconciliation",
    );
  });

  it.each([
    {
      label: "absent",
      sources: reconciledSources().filter(
        ({ sourceType }) => sourceType !== "revision_feed",
      ),
    },
    {
      label: "superseded",
      sources: reconciledSources().map((item) =>
        item.sourceType === "revision_feed"
          ? { ...item, status: "superseded" as const }
          : item,
      ),
    },
    {
      label: "duplicated",
      sources: [
        ...reconciledSources(),
        {
          ...reconciledSources().find(
            ({ sourceType }) => sourceType === "revision_feed",
          )!,
          sourceId: "bc-code-revisions-feed-overlap",
        },
      ],
    },
  ])(
    "cannot allow licensed evidence when the applicable revision feed is $label",
    ({ sources }) => {
      const licensed = licenseSource(
        sources,
        "bc-plumbing-code-2024",
        "2.5.2.1",
      );
      const result = evaluateCodeSafetyGate({
        question: "Is this venting to code?",
        context: bcContext,
        sources: licensed,
        evidence: [
          {
            sourceId: "bc-plumbing-code-2024",
            section: "2.5.2.1",
            content: "Synthetic test evidence only.",
          },
        ],
      });

      expect(result.outcome).toBe("blocked");
      expect(result.missing).toContain(
        "Current revision-feed fingerprint reconciliation",
      );
    },
  );
});

describe("revision-feed runtime reconciliation", () => {
  function revisionFeed(contentFingerprint: string | null) {
    return {
      ...INITIAL_AUTHORITY_SOURCES.find(
        ({ sourceType }) => sourceType === "revision_feed",
      )!,
      contentFingerprint,
    };
  }

  it("keeps an unchanged observed fingerprint answerable", async () => {
    const persistRequiresReview = vi.fn(async () => undefined);
    const [result] = await reconcileRevisionFeedObservations(
      [revisionFeed("etag:stable|last-modified:stable")],
      {
        observeFingerprint: async () => "etag:stable|last-modified:stable",
        persistRequiresReview,
      },
    );

    expect(result?.status).toBe("current");
    expect(persistRequiresReview).not.toHaveBeenCalled();
  });

  it("persists requires_review when the observed fingerprint changes", async () => {
    const persistRequiresReview = vi.fn(async () => undefined);
    const [result] = await reconcileRevisionFeedObservations(
      [revisionFeed("etag:stored|last-modified:stored")],
      {
        observeFingerprint: async () => "etag:changed|last-modified:changed",
        persistRequiresReview,
      },
    );

    expect(result?.status).toBe("requires_review");
    expect(persistRequiresReview).toHaveBeenCalledWith(
      "bc-code-revisions-feed",
    );
  });

  it.each([
    { label: "stored", stored: null, observed: "etag:current" },
    { label: "observed", stored: "etag:stored", observed: null },
  ])(
    "fails closed when the $label fingerprint is missing",
    async ({ stored, observed }) => {
      const persistRequiresReview = vi.fn(async () => undefined);
      const [result] = await reconcileRevisionFeedObservations(
        [revisionFeed(stored)],
        {
          observeFingerprint: async () => observed,
          persistRequiresReview,
        },
      );

      expect(result?.status).toBe("requires_review");
      expect(persistRequiresReview).toHaveBeenCalledWith(
        "bc-code-revisions-feed",
      );
    },
  );

  it("remains fail-closed when requires_review persistence fails", async () => {
    const persistenceFailure = new Error("synthetic persistence failure");
    const onError = vi.fn();
    const [result] = await reconcileRevisionFeedObservations(
      [revisionFeed("etag:stored")],
      {
        observeFingerprint: async () => "etag:changed",
        persistRequiresReview: async () => {
          throw persistenceFailure;
        },
        onError,
      },
    );

    expect(result?.status).toBe("requires_review");
    expect(onError).toHaveBeenCalledWith(
      persistenceFailure,
      expect.objectContaining({ sourceId: "bc-code-revisions-feed" }),
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

  it.each([
    {
      label: "historical BC/Burnaby applicability",
      context: { ...bcContext, permitApplicationDate: "2023-12-01" },
      expectedStatus: "historical_source_required",
      expectedEdition: null,
    },
    {
      label: "unresolved transition applicability",
      context: {
        ...bcContext,
        projectType: "renovation",
        knownConditions: ["Existing permit; transition rule unresolved"],
      },
      expectedStatus: "transition_context_required",
      expectedEdition: null,
    },
    {
      label: "missing date context",
      context: { ...bcContext, permitApplicationDate: undefined },
      expectedStatus: "missing_context",
      expectedEdition: null,
    },
    {
      label: "explicit edition conflict",
      context: { ...bcContext, explicitCodeEdition: "2018" },
      expectedStatus: "edition_conflict",
      expectedEdition: "2024",
    },
    {
      label: "unknown special authority",
      context: { ...bcContext, specialAuthority: true },
      expectedStatus: "unknown_special_authority",
      expectedEdition: null,
    },
  ])(
    "does not cite a current primary for $label",
    ({ context, expectedStatus, expectedEdition }) => {
      expect(resolveJurisdiction(context).status).toBe(expectedStatus);
      const result = evaluateCodeSafetyGate({
        question: "Is this venting to code?",
        context,
        sources: INITIAL_AUTHORITY_SOURCES,
      });

      expect(result.outcome).toBe("blocked");
      expect(result.applicableEdition).toBe(expectedEdition);
      expect(result.authoritySnapshotId).toBeNull();
      expect(result.citations).toEqual([]);
    },
  );

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

  it("rejects licensed model-code evidence without governing BC evidence", () => {
    const sources = licenseSource(reconciledSources(), "npc-2020", "2.5.2.1");
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources,
      evidence: [
        {
          sourceId: "npc-2020",
          section: "2.5.2.1",
          content: "Synthetic model-code evidence only.",
        },
      ],
    });
    expect(result.outcome).toBe("blocked");
    expect(result.missing).toContain(
      "Governing primary-source section evidence",
    );
  });

  it("rejects BC evidence for a Vancouver ruling", () => {
    const sources = licenseSource(
      reconciledSources(),
      "bc-plumbing-code-2024",
      "2.5.2.1",
    );
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: { ...bcContext, municipality: "Vancouver" },
      sources,
      evidence: [
        {
          sourceId: "bc-plumbing-code-2024",
          section: "2.5.2.1",
          content: "Synthetic BC evidence only.",
        },
      ],
    });
    expect(result.outcome).toBe("blocked");
    expect(result.missing).toContain(
      "Evidence limited to the selected authority snapshot",
    );
  });

  it("rejects a fabricated section locator", () => {
    const sources = licenseSource(
      reconciledSources(),
      "bc-plumbing-code-2024",
      "2.5.2.1",
    );
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources,
      evidence: [
        {
          sourceId: "bc-plumbing-code-2024",
          section: "fabricated-section",
          content: "Synthetic test evidence.",
        },
      ],
    });
    expect(result.outcome).toBe("blocked");
    expect(result.missing).toContain(
      "Licensed section-level authoritative evidence",
    );
  });

  it("rejects restricted metadata-only evidence despite malformed permissions", () => {
    const sources = reconciledSources().map((item) =>
      item.sourceId === "bc-plumbing-code-2024"
        ? {
            ...item,
            permittedUses: [
              ...item.permittedUses,
              "section_retrieval" as const,
              "model_context" as const,
            ],
            authorizedSectionLocators: ["2.5.2.1"],
          }
        : item,
    );
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources,
      evidence: [
        {
          sourceId: "bc-plumbing-code-2024",
          section: "2.5.2.1",
          content: "Synthetic test evidence.",
        },
      ],
    });
    expect(result.outcome).toBe("blocked");
  });

  it("allows only a resolved snapshot with explicitly licensed evidence", () => {
    const licensed = licenseSource(
      reconciledSources(),
      "bc-plumbing-code-2024",
      "2.5.2.1",
    );
    const result = evaluateCodeSafetyGate({
      question: "Is this venting to code?",
      context: bcContext,
      sources: licensed,
      evidence: [
        {
          sourceId: "bc-plumbing-code-2024",
          section: "2.5.2.1",
          content: "Synthetic test evidence only.",
        },
      ],
    });
    expect(result.outcome).toBe("allowed");
    expect(result.authoritySnapshotId).toContain("BC_GENERAL:2024");
    expect(result.citations[0]?.section).toBe("2.5.2.1");
  });

  it.each([
    "2020-2024",
    "2018 and 2024",
    "2020 / 2024",
    "2020, 2024",
    "2020 or 2024",
  ])(
    "cannot allow licensed evidence with ambiguous explicit edition %s",
    (explicitCodeEdition) => {
      const licensed = licenseSource(
        reconciledSources(),
        "bc-plumbing-code-2024",
        "2.5.2.1",
      );
      const result = evaluateCodeSafetyGate({
        question: "Is this venting to code?",
        context: { ...bcContext, explicitCodeEdition },
        sources: licensed,
        evidence: [
          {
            sourceId: "bc-plumbing-code-2024",
            section: "2.5.2.1",
            content: "Synthetic test evidence only.",
          },
        ],
      });

      expect(result.outcome).toBe("blocked");
      expect(result.authoritySnapshotId).toBeNull();
      expect(result.missing).toContain(
        "Applicable authoritative source snapshot",
      );
    },
  );
});

function reconciledSources(): AuthoritativeSource[] {
  return INITIAL_AUTHORITY_SOURCES.map((item) =>
    item.sourceType === "revision_feed"
      ? { ...item, contentFingerprint: "verified-test-fingerprint" }
      : item,
  );
}

function licenseSource(
  sources: AuthoritativeSource[],
  sourceId: string,
  locator: string,
): AuthoritativeSource[] {
  return sources.map((item) =>
    item.sourceId === sourceId
      ? {
          ...item,
          licenseAccessClassification: "open_legislation",
          permittedUses: [
            ...item.permittedUses,
            "section_retrieval" as const,
            "model_context" as const,
          ],
          authorizedSectionLocators: [locator],
        }
      : item,
  );
}

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
