export const RESOLVED_JURISDICTIONS = ["BC_GENERAL", "VANCOUVER"] as const;
export type ResolvedJurisdiction = (typeof RESOLVED_JURISDICTIONS)[number];
export type JurisdictionResolutionCode =
  | ResolvedJurisdiction
  | "UNKNOWN_SPECIAL_AUTHORITY";
export type SourceStatus = "current" | "superseded" | "requires_review";
export type LicenseAccessClassification =
  | "open_legislation"
  | "restricted_metadata_only";
export type PermittedUse =
  | "metadata"
  | "official_link"
  | "citation"
  | "section_retrieval"
  | "model_context"
  | "embedding";

export interface AuthoritativeSource {
  sourceId: string;
  authority: string;
  jurisdiction: ResolvedJurisdiction | "CANADA_MODEL";
  documentTitle: string;
  edition: string | null;
  revisionId: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceUrl: string;
  sourceType:
    | "legislation"
    | "regulation"
    | "adopted_code"
    | "model_code"
    | "revision_feed"
    | "bulletin_index"
    | "municipal_bylaw";
  supersedes: string | null;
  supersededBy: string | null;
  citationLabel: string;
  retrievalPriority: number;
  status: SourceStatus;
  licenseAccessClassification: LicenseAccessClassification;
  permittedUses: PermittedUse[];
  authorizedSectionLocators: string[];
  verifiedAt: string;
  contentFingerprint: string | null;
}

export interface AuthorityMeasurement {
  name: string;
  value: string;
  unit?: string;
}

export interface AuthorityContext {
  province?: string;
  municipality?: string;
  permitApplicationDate?: string;
  explicitCodeEdition?: string;
  authorityHavingJurisdiction?: string;
  specialAuthority?: boolean;
  mineRelated?: boolean;
  projectType?: string;
  measurements?: AuthorityMeasurement[];
  knownConditions?: string[];
}

/** Future photo-stage output. Jurisdiction is intentionally not image-derived. */
export interface PhotoCodeContext {
  trade_topic: string;
  observed_components: string[];
  visible_measurements: AuthorityMeasurement[];
  missing_measurements: string[];
  uncertainties: string[];
  immediate_hazards: string[];
  code_questions: string[];
  retrieval_terms: string[];
}

export interface CodeSensitivityResult {
  isCodeSensitive: boolean;
  topics: string[];
  requiresMeasurements: boolean;
}

export interface JurisdictionResolution {
  status:
    | "resolved"
    | "missing_context"
    | "historical_source_required"
    | "edition_conflict"
    | "transition_context_required"
    | "unknown_special_authority";
  jurisdiction: JurisdictionResolutionCode;
  applicableEdition: string | null;
  effectiveDateBasis: string | null;
  known: string[];
  missing: string[];
}

export interface AuthoritySnapshot {
  snapshotId: string;
  jurisdiction: ResolvedJurisdiction;
  edition: string;
  effectiveDateBasis: string;
  sources: AuthoritativeSource[];
  requiresReview: boolean;
}

export interface AuthoritativeEvidence {
  sourceId: string;
  section: string;
  subsection?: string;
  content: string;
}

export interface AuthorityCitation {
  sourceId: string;
  jurisdiction: JurisdictionResolutionCode;
  authority: string;
  document: string;
  edition: string | null;
  revision: string | null;
  section: string | null;
  subsection: string | null;
  effectiveDateBasis: string | null;
  sourceStatus: SourceStatus;
  officialSourceUrl: string;
  amendmentIndicator: "bc_amendment" | "vancouver_specific" | "none";
  contentAvailability: "metadata_only" | "licensed_section";
  citationLabel: string;
}

export interface CodeSafetyDecision {
  outcome: "bypass" | "blocked" | "allowed";
  sensitivity: CodeSensitivityResult;
  jurisdiction: JurisdictionResolutionCode;
  applicableEdition: string | null;
  authoritySnapshotId: string | null;
  known: string[];
  missing: string[];
  reason: string;
  nextSteps: string[];
  citations: AuthorityCitation[];
}

const LINK_ONLY: PermittedUse[] = ["metadata", "official_link", "citation"];
const VERIFIED_AT = "2026-08-11T00:00:00.000Z";
const SUPPORTED_BC_GENERAL_AUTHORITIES = new Set([
  "abbotsford",
  "burnaby",
  "campbell river",
  "chilliwack",
  "coquitlam",
  "delta",
  "kamloops",
  "kelowna",
  "langley",
  "maple ridge",
  "nanaimo",
  "new westminster",
  "north vancouver",
  "penticton",
  "port coquitlam",
  "port moody",
  "prince george",
  "richmond",
  "saanich",
  "surrey",
  "victoria",
  "west vancouver",
  "whistler",
]);
const SPECIAL_AUTHORITY_PATTERN =
  /\b(?:first nation|treaty|indigenous|reserve|nisga'?a|special authority|mining authority|mines act)\b/i;
const MINE_AUTHORITY_CONDITION_PATTERNS = [
  /\bmine[-\s]+related\s+(?:jurisdiction|project|authority)\b/i,
  /\bmining\s+(?:jurisdiction|project|authority)\b/i,
  /\b(?:jurisdiction|project|authority)\s+(?:is|falls|operates|regulated)\s+(?:under|within)\s+(?:a\s+)?(?:mine|mining|mines act)\b/i,
  /\b(?:regulated|permitted)\s+under\s+(?:the\s+)?mines act\b/i,
];
const CONFIRMED_APPLICABILITY_PATTERN =
  /\b(?:new permit application|not an in-stream project|no delayed provisions apply|applicability confirmed by (?:the )?(?:ahj|authority having jurisdiction))\b/i;
const UNRESOLVED_TRANSITION_PATTERN =
  /\b(?:existing permit|in-stream project|transition rule unresolved|delayed provision applies|phased permit|prior permit)\b/i;

/** Mirrors the migration's metadata-only seed rows for pure policy tests. */
export const INITIAL_AUTHORITY_SOURCES: AuthoritativeSource[] = [
  source({
    sourceId: "bc-building-act-current",
    authority: "Province of British Columbia, King's Printer",
    jurisdiction: "BC_GENERAL",
    documentTitle: "Building Act",
    edition: "Current consolidation",
    sourceUrl:
      "https://www.bclaws.gov.bc.ca/civix/document/id/consol41/consol41/15002",
    sourceType: "legislation",
    citationLabel: "Building Act, British Columbia",
    retrievalPriority: 100,
    licenseAccessClassification: "open_legislation",
  }),
  source({
    sourceId: "bc-building-act-general-regulation-current",
    authority: "Province of British Columbia, King's Printer",
    jurisdiction: "BC_GENERAL",
    documentTitle: "Building Act General Regulation",
    edition: "Current consolidation",
    sourceUrl:
      "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/131_2016",
    sourceType: "regulation",
    citationLabel: "Building Act General Regulation, British Columbia",
    retrievalPriority: 100,
    licenseAccessClassification: "open_legislation",
  }),
  source({
    sourceId: "bc-plumbing-code-2024",
    authority: "Province of British Columbia",
    jurisdiction: "BC_GENERAL",
    documentTitle: "British Columbia Plumbing Code 2024",
    edition: "2024",
    effectiveFrom: "2024-03-08",
    sourceUrl:
      "https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/2024-bc-codes",
    sourceType: "adopted_code",
    citationLabel: "BC Plumbing Code 2024",
    retrievalPriority: 95,
  }),
  source({
    sourceId: "npc-2020",
    authority: "National Research Council Canada",
    jurisdiction: "CANADA_MODEL",
    documentTitle: "National Plumbing Code of Canada 2020",
    edition: "2020",
    sourceUrl:
      "https://nrc.canada.ca/en/certifications-evaluations-standards/codes-canada/codes-canada-publications/national-plumbing-code-canada-2020",
    sourceType: "model_code",
    citationLabel: "National Plumbing Code of Canada 2020",
    retrievalPriority: 70,
  }),
  source({
    sourceId: "bc-code-revisions-feed",
    authority: "Province of British Columbia",
    jurisdiction: "BC_GENERAL",
    documentTitle: "BC Building, Plumbing and Fire Code revisions",
    edition: "2024",
    revisionId: "revision-feed",
    effectiveFrom: "2024-03-08",
    sourceUrl:
      "https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/errata-and-revisions",
    sourceType: "revision_feed",
    citationLabel: "BC code revisions and errata",
    retrievalPriority: 90,
  }),
  source({
    sourceId: "bc-code-bulletin-index",
    authority: "Province of British Columbia",
    jurisdiction: "BC_GENERAL",
    documentTitle: "BC Building, Plumbing and Fire Code bulletins",
    edition: "2024",
    effectiveFrom: "2024-03-08",
    sourceUrl:
      "https://www2.gov.bc.ca/gov/content/industry/construction-industry/building-codes-standards/bc-codes/bulletins",
    sourceType: "bulletin_index",
    citationLabel: "BC code bulletin index",
    retrievalPriority: 60,
  }),
  source({
    sourceId: "vancouver-plumbing-bylaw-2025-original",
    authority: "City of Vancouver",
    jurisdiction: "VANCOUVER",
    documentTitle: "Vancouver Building By-law 2025, Book II (Plumbing Systems)",
    edition: "2025",
    revisionId: "By-law 14343",
    effectiveFrom: "2025-09-15",
    effectiveTo: "2025-12-31",
    sourceUrl:
      "https://vancouver.ca/your-government/vancouver-building-bylaw.aspx",
    sourceType: "municipal_bylaw",
    supersededBy: "vancouver-plumbing-bylaw-2025-current",
    citationLabel: "Vancouver Building By-law 2025, Book II",
    retrievalPriority: 100,
    status: "superseded",
  }),
  source({
    sourceId: "vancouver-plumbing-bylaw-2025-current",
    authority: "City of Vancouver",
    jurisdiction: "VANCOUVER",
    documentTitle: "Vancouver Building By-law 2025, Book II (Plumbing Systems)",
    edition: "2025",
    revisionId: "By-law 14488",
    effectiveFrom: "2026-01-01",
    sourceUrl:
      "https://vancouver.ca/your-government/vancouver-building-bylaw.aspx",
    sourceType: "municipal_bylaw",
    supersedes: "vancouver-plumbing-bylaw-2025-original",
    citationLabel: "Vancouver Building By-law 2025, Book II, amended",
    retrievalPriority: 100,
  }),
];

const DETECTOR_RULES: Array<{
  topic: string;
  pattern: RegExp;
  measurements?: boolean;
}> = [
  {
    topic: "code_compliance",
    pattern:
      /\b(?:to code|meet(?:s|ing)? (?:the )?code|code[- ]compliant|code compliance|according to (?:the )?code|regulatory minimum|code requirement|what size does (?:the )?code require|is (?:this|that|it|these|those) legal|can (?:i|we|you) install (?:this|that|it|these|those)|does (?:this|that|it) pass(?: inspection| code)?)\b/i,
  },
  {
    topic: "required_dimensions",
    pattern:
      /\b(?:required|minimum|maximum|dimension|distance)\b.{0,40}\b(?:size|diameter|height|length|distance|spacing|measurement|mm|cm|metres?|meters?|inches?|feet|ft)\b/i,
    measurements: true,
  },
  {
    topic: "clearance",
    pattern:
      /\b(?:(?:required|minimum|maximum|code)\b.{0,32}\bclearances?|clearances?\b.{0,32}\b(?:required|minimum|maximum|by code))\b/i,
    measurements: true,
  },
  {
    topic: "slope",
    pattern:
      /\b(?:(?:required|minimum|maximum|code|drain|pipe|plumbing)\b.{0,32}\b(?:slope|grade|fall per foot|fall per metre|fall per meter)|(?:slope|grade|fall per foot|fall per metre|fall per meter)\b.{0,32}\b(?:required|minimum|maximum|code|drain|pipe|plumbing))\b/i,
    measurements: true,
  },
  {
    topic: "venting",
    pattern: /\b(?:venting|vent stack|wet vent|dry vent|trap arm)\b/i,
    measurements: true,
  },
  {
    topic: "drainage",
    pattern:
      /\b(?:sanitary drain|storm drain|drain pipe|(?:plumbing|code|required)\b.{0,24}\bdrainage|drainage\b.{0,24}\b(?:requirement|code|system))\b/i,
    measurements: true,
  },
  {
    topic: "fixture_requirements",
    pattern:
      /\b(?:fixture requirement|fixture unit|number of fixtures|required fixtures?)\b/i,
    measurements: true,
  },
  {
    topic: "pipe_sizing",
    pattern:
      /\b(?:pipe sizing|pipe size|required diameter|minimum diameter)\b/i,
    measurements: true,
  },
  {
    topic: "inspection",
    pattern:
      /\b(?:inspection requirement|required inspection|needs? inspection)\b/i,
  },
  {
    topic: "permit",
    pattern:
      /\b(?:plumbing permit|building permit|permit requirement|needs? a permit|required permit)\b/i,
  },
];

export function classifyCodeSensitiveQuestion(
  question: string,
): CodeSensitivityResult {
  const matches = DETECTOR_RULES.filter(({ pattern }) =>
    pattern.test(question),
  );
  return {
    isCodeSensitive: matches.length > 0,
    topics: [...new Set(matches.map(({ topic }) => topic))],
    requiresMeasurements: matches.some(({ measurements }) => measurements),
  };
}

export function resolveJurisdiction(
  context: AuthorityContext | undefined,
): JurisdictionResolution {
  const known = suppliedContextProvenance(context);
  const province = normalizePlace(context?.province);
  const municipality = normalizePlace(context?.municipality);
  const ahj = normalizePlace(context?.authorityHavingJurisdiction);
  const canonicalMunicipality = canonicalAuthority(municipality);
  const canonicalAhj = canonicalAuthority(ahj);
  const suppliedAuthority = [municipality, ahj].filter(Boolean).join(" ");
  const suppliedProjectAuthority = [
    context?.projectType,
    ...(context?.knownConditions ?? []),
  ].filter((value): value is string => Boolean(value?.trim()));
  const hasStructuredMineAuthority = suppliedProjectAuthority.some((value) =>
    MINE_AUTHORITY_CONDITION_PATTERNS.some((pattern) => pattern.test(value)),
  );

  if (
    context?.specialAuthority ||
    context?.mineRelated ||
    SPECIAL_AUTHORITY_PATTERN.test(suppliedAuthority) ||
    hasStructuredMineAuthority
  ) {
    return resolution(
      "unknown_special_authority",
      "UNKNOWN_SPECIAL_AUTHORITY",
      null,
      null,
      known,
      ["Confirmation from the authority having jurisdiction"],
    );
  }
  if (
    canonicalMunicipality &&
    canonicalAhj &&
    canonicalMunicipality !== canonicalAhj
  ) {
    return resolution(
      "unknown_special_authority",
      "UNKNOWN_SPECIAL_AUTHORITY",
      null,
      null,
      known,
      ["Resolve conflicting municipality and authority context values"],
    );
  }
  if (province !== "bc" && province !== "british columbia") {
    return resolution(
      province ? "unknown_special_authority" : "missing_context",
      "UNKNOWN_SPECIAL_AUTHORITY",
      null,
      null,
      known,
      province
        ? ["Supported British Columbia authority context"]
        : ["Province"],
    );
  }
  if (!municipality && !ahj) {
    return resolution(
      "missing_context",
      "UNKNOWN_SPECIAL_AUTHORITY",
      null,
      null,
      known,
      ["Municipality or authority having jurisdiction"],
    );
  }

  const authority = canonicalMunicipality || canonicalAhj;
  const isVancouver = authority === "vancouver";
  const isSupportedBcGeneral = SUPPORTED_BC_GENERAL_AUTHORITIES.has(authority);
  if (!isVancouver && !isSupportedBcGeneral) {
    return resolution(
      "unknown_special_authority",
      "UNKNOWN_SPECIAL_AUTHORITY",
      null,
      null,
      known,
      ["Positive confirmation that the supplied authority uses BC_GENERAL"],
    );
  }
  const jurisdiction: ResolvedJurisdiction = isVancouver
    ? "VANCOUVER"
    : "BC_GENERAL";

  const permitDate = parseDateOnly(context?.permitApplicationDate);
  if (!permitDate) {
    return resolution("missing_context", jurisdiction, null, null, known, [
      context?.permitApplicationDate
        ? "Valid permit/application date in YYYY-MM-DD format"
        : "Permit/application date",
    ]);
  }
  const threshold = jurisdiction === "VANCOUVER" ? "2025-09-15" : "2024-03-08";
  if (permitDate < threshold) {
    return resolution(
      "historical_source_required",
      jurisdiction,
      null,
      permitDate,
      known,
      [`Licensed historical authority source applicable on ${permitDate}`],
    );
  }

  const edition = jurisdiction === "VANCOUVER" ? "2025" : "2024";
  if (
    context?.explicitCodeEdition &&
    !new RegExp(`(?:^|\\D)${edition}(?:\\D|$)`).test(
      context.explicitCodeEdition.trim(),
    )
  ) {
    return resolution(
      "edition_conflict",
      jurisdiction,
      edition,
      permitDate,
      known,
      [
        `Resolve conflict between permit-date edition ${edition} and explicitly supplied edition ${context.explicitCodeEdition}`,
      ],
    );
  }
  const conditions = context?.knownConditions ?? [];
  const hasConfirmedApplicability = conditions.some((condition) =>
    CONFIRMED_APPLICABILITY_PATTERN.test(condition),
  );
  const hasUnresolvedTransition = conditions.some(
    (condition) =>
      UNRESOLVED_TRANSITION_PATTERN.test(condition) &&
      !/\b(?:not an in-stream project|no delayed provisions apply)\b/i.test(
        condition,
      ),
  );
  const transitionMissing: string[] = [];
  if (!context?.projectType?.trim()) transitionMissing.push("Project type");
  if (!hasConfirmedApplicability)
    transitionMissing.push(
      "Confirmed transition/applicability basis from project conditions or the AHJ",
    );
  if (hasUnresolvedTransition)
    transitionMissing.push(
      "Resolution of in-stream or delayed-provision rules",
    );
  if (transitionMissing.length > 0) {
    return resolution(
      "transition_context_required",
      jurisdiction,
      null,
      permitDate,
      known,
      transitionMissing,
    );
  }
  return resolution("resolved", jurisdiction, edition, permitDate, known, []);
}

export function selectAuthoritySnapshot(
  resolved: JurisdictionResolution,
  sources: AuthoritativeSource[],
): AuthoritySnapshot | null {
  if (
    resolved.status !== "resolved" ||
    !RESOLVED_JURISDICTIONS.includes(
      resolved.jurisdiction as ResolvedJurisdiction,
    ) ||
    !resolved.applicableEdition ||
    !resolved.effectiveDateBasis
  ) {
    return null;
  }
  const jurisdiction = resolved.jurisdiction as ResolvedJurisdiction;
  const primaryType =
    jurisdiction === "VANCOUVER" ? "municipal_bylaw" : "adopted_code";
  const primary = sources.filter(
    (item) =>
      item.jurisdiction === jurisdiction &&
      item.sourceType === primaryType &&
      item.edition === resolved.applicableEdition &&
      isEffectiveOn(item, resolved.effectiveDateBasis!),
  );
  if (primary.length !== 1) return null;
  const model = sources.filter(
    (item) =>
      item.jurisdiction === "CANADA_MODEL" &&
      item.sourceType === "model_code" &&
      item.edition === "2020",
  );
  const revisionFeeds = applicableRevisionFeeds(resolved, sources);
  const hasExactlyOneCurrentRevisionFeed =
    revisionFeeds.length === 1 && revisionFeeds[0]?.status !== "superseded";
  const selected = [...primary, ...revisionFeeds, ...model].sort(
    (left, right) => right.retrievalPriority - left.retrievalPriority,
  );
  const lead = selected[0]!;
  return {
    snapshotId: [
      jurisdiction,
      resolved.applicableEdition,
      lead.revisionId ?? "base",
      resolved.effectiveDateBasis,
    ].join(":"),
    jurisdiction,
    edition: resolved.applicableEdition,
    effectiveDateBasis: resolved.effectiveDateBasis,
    sources: selected,
    requiresReview:
      !hasExactlyOneCurrentRevisionFeed ||
      selected.some(sourceNeedsReconciliation),
  };
}

/**
 * Returns only revision feeds applicable to the already-resolved authority
 * snapshot. Callers must not observe or persist feeds outside this set.
 */
export function applicableRevisionFeeds(
  resolved: JurisdictionResolution,
  sources: AuthoritativeSource[],
): AuthoritativeSource[] {
  if (
    resolved.status !== "resolved" ||
    !RESOLVED_JURISDICTIONS.includes(
      resolved.jurisdiction as ResolvedJurisdiction,
    ) ||
    !resolved.applicableEdition ||
    !resolved.effectiveDateBasis
  ) {
    return [];
  }
  return sources.filter(
    (item) =>
      item.jurisdiction === resolved.jurisdiction &&
      item.sourceType === "revision_feed" &&
      item.edition === resolved.applicableEdition &&
      isEffectiveOn(item, resolved.effectiveDateBasis!),
  );
}

/**
 * Restricts gate inputs to the resolved jurisdiction plus the shared model
 * source. Unknown authority contexts receive no jurisdictional source state.
 */
export function scopeSourcesToResolvedJurisdiction(
  resolved: JurisdictionResolution,
  sources: AuthoritativeSource[],
): AuthoritativeSource[] {
  if (
    !RESOLVED_JURISDICTIONS.includes(
      resolved.jurisdiction as ResolvedJurisdiction,
    )
  ) {
    return [];
  }
  return sources.filter(
    (item) =>
      item.jurisdiction === resolved.jurisdiction ||
      item.jurisdiction === "CANADA_MODEL",
  );
}

export function sourceAllowsUse(
  source: AuthoritativeSource,
  use: PermittedUse,
): boolean {
  if (
    source.licenseAccessClassification === "restricted_metadata_only" &&
    ["section_retrieval", "model_context", "embedding"].includes(use)
  ) {
    return false;
  }
  return source.permittedUses.includes(use);
}

export function markRevisionFeedObservation(
  item: AuthoritativeSource,
  observedFingerprint: string,
): AuthoritativeSource {
  if (item.sourceType !== "revision_feed") return item;
  if (item.contentFingerprint === observedFingerprint) return item;
  return { ...item, status: "requires_review" };
}

export interface RevisionFeedReconciliationDependencies {
  observeFingerprint: (source: AuthoritativeSource) => Promise<string | null>;
  persistRequiresReview: (sourceId: string) => Promise<void>;
  onError?: (error: unknown, source: AuthoritativeSource) => void;
}

/**
 * Reconciles trusted upstream revision observations before authority selection.
 * Any missing, changed, or unreadable fingerprint fails closed in memory. The
 * review-required state is also persisted when possible so later requests and
 * operators see the same gate state; a persistence failure never restores the
 * source to an answerable state for the current request.
 */
export async function reconcileRevisionFeedObservations(
  sources: AuthoritativeSource[],
  dependencies: RevisionFeedReconciliationDependencies,
): Promise<AuthoritativeSource[]> {
  return Promise.all(
    sources.map(async (source) => {
      if (
        source.sourceType !== "revision_feed" ||
        source.status === "requires_review"
      ) {
        return source;
      }

      const storedFingerprint = source.contentFingerprint?.trim() || null;
      if (!storedFingerprint) {
        const reviewRequired = {
          ...source,
          status: "requires_review" as const,
        };
        try {
          await dependencies.persistRequiresReview(source.sourceId);
        } catch (error) {
          dependencies.onError?.(error, source);
        }
        return reviewRequired;
      }

      let observedFingerprint: string | null = null;
      try {
        observedFingerprint =
          (await dependencies.observeFingerprint(source))?.trim() || null;
      } catch (error) {
        dependencies.onError?.(error, source);
      }

      if (observedFingerprint && storedFingerprint === observedFingerprint) {
        return source;
      }

      const reviewRequired = observedFingerprint
        ? markRevisionFeedObservation(source, observedFingerprint)
        : { ...source, status: "requires_review" as const };
      try {
        await dependencies.persistRequiresReview(source.sourceId);
      } catch (error) {
        dependencies.onError?.(error, source);
      }
      return reviewRequired;
    }),
  );
}

function sourceNeedsReconciliation(item: AuthoritativeSource): boolean {
  return (
    item.status === "requires_review" ||
    (item.sourceType === "revision_feed" &&
      (item.status === "superseded" || !item.contentFingerprint?.trim()))
  );
}

function evidenceIsAuthorized(
  evidence: AuthoritativeEvidence,
  source: AuthoritativeSource,
  effectiveDateBasis: string | undefined,
): boolean {
  const locator = normalizeLocator(evidence.section);
  return Boolean(
    locator &&
    evidence.content.trim() &&
    source.status !== "requires_review" &&
    effectiveDateBasis &&
    isEffectiveOn(source, effectiveDateBasis) &&
    sourceAllowsUse(source, "section_retrieval") &&
    sourceAllowsUse(source, "model_context") &&
    source.authorizedSectionLocators.some(
      (authorized) => normalizeLocator(authorized) === locator,
    ),
  );
}

export function evaluateCodeSafetyGate(input: {
  question: string;
  context?: AuthorityContext;
  sources: AuthoritativeSource[];
  evidence?: AuthoritativeEvidence[];
}): CodeSafetyDecision {
  const sensitivity = classifyCodeSensitiveQuestion(input.question);
  if (!sensitivity.isCodeSensitive) {
    return decision(
      "bypass",
      sensitivity,
      "UNKNOWN_SPECIAL_AUTHORITY",
      null,
      null,
      [],
      [],
      "The question is not classified as code-sensitive.",
      [],
      [],
    );
  }

  const resolved = resolveJurisdiction(input.context);
  const snapshot = selectAuthoritySnapshot(resolved, input.sources);
  const missing = [...resolved.missing];
  if (sensitivity.requiresMeasurements && !hasMeasurements(input.context)) {
    missing.push("Relevant field measurements and configuration details");
  }
  if (!snapshot) missing.push("Applicable authoritative source snapshot");
  else if (snapshot.requiresReview)
    missing.push("Current revision-feed fingerprint reconciliation");

  const evidence = input.evidence ?? [];
  const snapshotIds = new Set(
    snapshot?.sources.map((item) => item.sourceId) ?? [],
  );
  if (evidence.some((item) => !snapshotIds.has(item.sourceId))) {
    missing.push("Evidence limited to the selected authority snapshot");
  }
  const licensedEvidence = evidence.filter((item) => {
    const registered = snapshot?.sources.find(
      (sourceItem) => sourceItem.sourceId === item.sourceId,
    );
    return Boolean(
      registered &&
      evidenceIsAuthorized(item, registered, snapshot?.effectiveDateBasis),
    );
  });
  if (licensedEvidence.length === 0) {
    missing.push("Licensed section-level authoritative evidence");
  }
  const governingType =
    snapshot?.jurisdiction === "VANCOUVER" ? "municipal_bylaw" : "adopted_code";
  const governingSource = snapshot?.sources.find(
    (item) =>
      item.jurisdiction === snapshot.jurisdiction &&
      item.sourceType === governingType,
  );
  const governingEvidence = licensedEvidence.filter(
    (item) => item.sourceId === governingSource?.sourceId,
  );
  if (snapshot && governingEvidence.length === 0) {
    missing.push("Governing primary-source section evidence");
  }

  const citationSources = snapshot?.sources.length
    ? snapshot.sources
    : candidateSources(resolved, input.sources);
  const citations = citationSources.map((item) =>
    buildCitation(
      item,
      resolved,
      licensedEvidence.find(
        (evidenceItem) => evidenceItem.sourceId === item.sourceId,
      ),
    ),
  );
  const uniqueMissing = [...new Set(missing)];
  const allowed = uniqueMissing.length === 0 && governingEvidence.length > 0;
  return decision(
    allowed ? "allowed" : "blocked",
    sensitivity,
    resolved.jurisdiction,
    resolved.applicableEdition,
    snapshot?.snapshotId ?? null,
    resolved.known,
    uniqueMissing,
    allowed
      ? "The answer is constrained to one resolved, licensed authority snapshot."
      : "Jack cannot issue a code ruling without resolved applicability, sufficient field context, and licensed section-level authoritative evidence.",
    buildNextSteps(resolved, sensitivity, licensedEvidence.length),
    citations,
  );
}

export function formatCodeSafetyRefusal(result: CodeSafetyDecision): string {
  const known = result.known.length
    ? result.known.map((item) => `- ${item}`).join("\n")
    : "- No governing authority has been confirmed.";
  const sources = result.citations.length
    ? result.citations
        .map(
          (item) =>
            `- [${item.citationLabel}](${item.officialSourceUrl}) (${item.contentAvailability === "metadata_only" ? "metadata-only; no licensed section text is indexed" : "licensed section available"})`,
        )
        .join("\n")
    : "- The authoritative source registry is unavailable or no applicable source snapshot could be selected.";
  return `## Code check status

**I cannot issue a code-compliance ruling from generic model knowledge or Jack's general trade memory.**

### What is known
${known}

### What is still required
${result.missing.map((item) => `- ${item}`).join("\n")}

### Applicable official sources
${sources}

### What to verify next
${result.nextSteps.map((item) => `- ${item}`).join("\n")}

This is not a finding of compliance or non-compliance. No code section number or requirement has been inferred.`;
}

export function authoritativeSourceFromRow(
  row: Record<string, unknown>,
): AuthoritativeSource | null {
  const required = [
    "source_id",
    "authority",
    "jurisdiction",
    "document_title",
    "source_url",
    "source_type",
    "citation_label",
    "status",
    "license_access_classification",
    "verified_at",
  ];
  if (required.some((key) => typeof row[key] !== "string")) return null;
  if (!Array.isArray(row["permitted_uses"])) return null;
  if (
    !["BC_GENERAL", "VANCOUVER", "CANADA_MODEL"].includes(
      row["jurisdiction"] as string,
    ) ||
    !["current", "superseded", "requires_review"].includes(
      row["status"] as string,
    ) ||
    ![
      "legislation",
      "regulation",
      "adopted_code",
      "model_code",
      "revision_feed",
      "bulletin_index",
      "municipal_bylaw",
    ].includes(row["source_type"] as string) ||
    !["open_legislation", "restricted_metadata_only"].includes(
      row["license_access_classification"] as string,
    ) ||
    (row["permitted_uses"] as unknown[]).some(
      (value) =>
        typeof value !== "string" ||
        ![
          "metadata",
          "official_link",
          "citation",
          "section_retrieval",
          "model_context",
          "embedding",
        ].includes(value),
    )
  ) {
    return null;
  }
  return {
    sourceId: row["source_id"] as string,
    authority: row["authority"] as string,
    jurisdiction: row["jurisdiction"] as AuthoritativeSource["jurisdiction"],
    documentTitle: row["document_title"] as string,
    edition: nullableString(row["edition"]),
    revisionId: nullableString(row["revision_id"]),
    effectiveFrom: nullableString(row["effective_from"]),
    effectiveTo: nullableString(row["effective_to"]),
    sourceUrl: row["source_url"] as string,
    sourceType: row["source_type"] as AuthoritativeSource["sourceType"],
    supersedes: nullableString(row["supersedes"]),
    supersededBy: nullableString(row["superseded_by"]),
    citationLabel: row["citation_label"] as string,
    retrievalPriority:
      typeof row["retrieval_priority"] === "number"
        ? (row["retrieval_priority"] as number)
        : 0,
    status: row["status"] as SourceStatus,
    licenseAccessClassification: row[
      "license_access_classification"
    ] as LicenseAccessClassification,
    permittedUses: (row["permitted_uses"] as unknown[]).filter(
      (value): value is PermittedUse => typeof value === "string",
    ),
    authorizedSectionLocators: Array.isArray(row["authorized_section_locators"])
      ? (row["authorized_section_locators"] as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    verifiedAt: row["verified_at"] as string,
    contentFingerprint: nullableString(row["content_fingerprint"]),
  };
}

export function authoritativeSourceToRow(
  item: AuthoritativeSource,
): Record<string, unknown> {
  return {
    source_id: item.sourceId,
    authority: item.authority,
    jurisdiction: item.jurisdiction,
    document_title: item.documentTitle,
    edition: item.edition,
    revision_id: item.revisionId,
    effective_from: item.effectiveFrom,
    effective_to: item.effectiveTo,
    source_url: item.sourceUrl,
    source_type: item.sourceType,
    supersedes: item.supersedes,
    superseded_by: item.supersededBy,
    citation_label: item.citationLabel,
    retrieval_priority: item.retrievalPriority,
    status: item.status,
    license_access_classification: item.licenseAccessClassification,
    permitted_uses: item.permittedUses,
    authorized_section_locators: item.authorizedSectionLocators,
    verified_at: item.verifiedAt,
    content_fingerprint: item.contentFingerprint,
  };
}

function source(
  input: Omit<
    AuthoritativeSource,
    | "revisionId"
    | "effectiveFrom"
    | "effectiveTo"
    | "supersedes"
    | "supersededBy"
    | "status"
    | "licenseAccessClassification"
    | "permittedUses"
    | "verifiedAt"
    | "contentFingerprint"
    | "authorizedSectionLocators"
  > &
    Partial<
      Pick<
        AuthoritativeSource,
        | "revisionId"
        | "effectiveFrom"
        | "effectiveTo"
        | "supersedes"
        | "supersededBy"
        | "status"
        | "licenseAccessClassification"
      >
    >,
): AuthoritativeSource {
  return {
    revisionId: null,
    effectiveFrom: null,
    effectiveTo: null,
    supersedes: null,
    supersededBy: null,
    status: "current",
    licenseAccessClassification: "restricted_metadata_only",
    ...input,
    permittedUses: [...LINK_ONLY],
    authorizedSectionLocators: [],
    verifiedAt: VERIFIED_AT,
    contentFingerprint: null,
  };
}

function buildCitation(
  item: AuthoritativeSource,
  resolved: JurisdictionResolution,
  evidence?: AuthoritativeEvidence,
): AuthorityCitation {
  return {
    sourceId: item.sourceId,
    jurisdiction: resolved.jurisdiction,
    authority: item.authority,
    document: item.documentTitle,
    edition: item.edition,
    revision: item.revisionId,
    section: evidence?.section ?? null,
    subsection: evidence?.subsection ?? null,
    effectiveDateBasis: resolved.effectiveDateBasis,
    sourceStatus: item.status,
    officialSourceUrl: item.sourceUrl,
    amendmentIndicator:
      item.jurisdiction === "VANCOUVER"
        ? "vancouver_specific"
        : item.sourceType === "adopted_code"
          ? "bc_amendment"
          : "none",
    contentAvailability: evidence ? "licensed_section" : "metadata_only",
    citationLabel: item.citationLabel,
  };
}

function candidateSources(
  resolved: JurisdictionResolution,
  sources: AuthoritativeSource[],
): AuthoritativeSource[] {
  if (
    resolved.jurisdiction !== "BC_GENERAL" &&
    resolved.jurisdiction !== "VANCOUVER"
  ) {
    return [];
  }
  const type =
    resolved.jurisdiction === "VANCOUVER" ? "municipal_bylaw" : "adopted_code";
  return sources
    .filter(
      (item) =>
        item.jurisdiction === resolved.jurisdiction &&
        item.sourceType === type &&
        item.status === "current",
    )
    .slice(0, 1);
}

function buildNextSteps(
  resolved: JurisdictionResolution,
  sensitivity: CodeSensitivityResult,
  licensedEvidenceCount: number,
): string[] {
  const steps: string[] = [];
  if (resolved.jurisdiction === "UNKNOWN_SPECIAL_AUTHORITY")
    steps.push("Provide the municipality and authority having jurisdiction.");
  if (!resolved.effectiveDateBasis)
    steps.push("Provide the permit or application date in YYYY-MM-DD format.");
  if (resolved.status === "transition_context_required")
    steps.push(
      "Provide the project type and an AHJ-confirmed transition/applicability basis, including any in-stream or delayed provisions.",
    );
  if (sensitivity.requiresMeasurements)
    steps.push(
      "Provide the relevant pipe sizes, distances, slope, connection layout, and other field measurements.",
    );
  if (licensedEvidenceCount === 0)
    steps.push(
      "Verify the requirement in the linked official source or with the authority having jurisdiction; Jack has no licensed section text indexed.",
    );
  return [...new Set(steps)];
}

function hasMeasurements(context: AuthorityContext | undefined): boolean {
  return Boolean(
    context?.measurements?.some(
      (item) => item.name.trim().length > 0 && item.value.trim().length > 0,
    ),
  );
}

function isEffectiveOn(item: AuthoritativeSource, date: string): boolean {
  return (
    (!item.effectiveFrom || item.effectiveFrom <= date) &&
    (!item.effectiveTo || item.effectiveTo >= date)
  );
}

function resolution(
  status: JurisdictionResolution["status"],
  jurisdiction: JurisdictionResolutionCode,
  applicableEdition: string | null,
  effectiveDateBasis: string | null,
  known: string[],
  missing: string[],
): JurisdictionResolution {
  return {
    status,
    jurisdiction,
    applicableEdition,
    effectiveDateBasis,
    known,
    missing,
  };
}

function decision(
  outcome: CodeSafetyDecision["outcome"],
  sensitivity: CodeSensitivityResult,
  jurisdiction: JurisdictionResolutionCode,
  applicableEdition: string | null,
  authoritySnapshotId: string | null,
  known: string[],
  missing: string[],
  reason: string,
  nextSteps: string[],
  citations: AuthorityCitation[],
): CodeSafetyDecision {
  return {
    outcome,
    sensitivity,
    jurisdiction,
    applicableEdition,
    authoritySnapshotId,
    known,
    missing,
    reason,
    nextSteps,
    citations,
  };
}

function parseDateOnly(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function suppliedContextProvenance(
  context: AuthorityContext | undefined,
): string[] {
  if (!context) return [];
  const known: string[] = [];
  if (context.province?.trim())
    known.push(`Province (supplied context): ${context.province}`);
  if (
    context.municipality?.trim() &&
    context.authorityHavingJurisdiction?.trim()
  ) {
    known.push(`Municipality (supplied context): ${context.municipality}`);
    known.push(
      `Authority having jurisdiction (supplied context): ${context.authorityHavingJurisdiction}`,
    );
  } else if (
    context.municipality?.trim() ||
    context.authorityHavingJurisdiction?.trim()
  ) {
    known.push(
      `Municipality/AHJ (supplied context): ${context.municipality ?? context.authorityHavingJurisdiction}`,
    );
  }
  if (context.permitApplicationDate?.trim())
    known.push(
      `Permit/application date (supplied context): ${context.permitApplicationDate}`,
    );
  if (context.explicitCodeEdition?.trim())
    known.push(
      `Explicit code edition (supplied context): ${context.explicitCodeEdition}`,
    );
  if (context.projectType?.trim())
    known.push(`Project type (supplied context): ${context.projectType}`);
  for (const condition of context.knownConditions ?? []) {
    if (condition.trim())
      known.push(`Known condition (supplied context): ${condition}`);
  }
  if (context.specialAuthority !== undefined)
    known.push(
      `Special-authority flag (supplied context): ${String(context.specialAuthority)}`,
    );
  if (context.mineRelated !== undefined)
    known.push(
      `Mine-related flag (supplied context): ${String(context.mineRelated)}`,
    );
  return known;
}

function canonicalAuthority(value: string): string {
  return value
    .replace(
      /^(?:city|district|town|village|township|municipality) of (?:the )?/,
      "",
    )
    .replace(/^corporation of (?:the )?/, "")
    .trim();
}

function normalizeLocator(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").replace(/[–—]/g, "-");
}

function normalizePlace(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
