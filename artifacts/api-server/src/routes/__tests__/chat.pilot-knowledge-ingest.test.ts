import { vi, describe, it, expect, beforeEach } from "vitest";
import express, { type Express, type Request } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

vi.mock("../../lib/supabase.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return { supabase: m.fake };
});

vi.mock("../../lib/openai.js", async () => {
  const m = await import("../../lib/__tests__/mocks.js");
  return {
    createEmbedding: m.createEmbedding,
    chatCompletion: vi.fn(async () => ({
      choices: [
        {
          message: {
            content:
              "Working with these details first avoids the rework pattern we want to avoid.",
          },
        },
      ],
    })),
    MODELS: m.MODELS,
    openai: m.openai,
  };
});

vi.mock("../../lib/ask-learning.js", () => ({
  learnFromAskInteraction: vi.fn(async () => ({
    status: "discarded",
    extractedCount: 0,
  })),
}));

import chatRouter from "../chat.js";
import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import { chatCompletion } from "../../lib/openai.js";

const DEFAULT_USER_ID = "user-test-001";
const OTHER_PILOT_USER_ID = "user-test-002";
const UNAFFILIATED_USER_ID = "user-test-003";
const PILOT_ID_001 = "11111111-1111-4111-8111-111111111111";
const PILOT_ID_002 = "22222222-2222-4222-8222-222222222222";
const ORGANIZATION_ID_001 = "33333333-3333-4333-8333-333333333333";
const ORGANIZATION_ID_002 = "44444444-4444-4444-8444-444444444444";

interface PilotKnowledgeEntry {
  id: string;
  title: string;
  description: string;
  body: string;
  metadata: Record<string, unknown>;
}

const ROB_PILOT_ENTRIES: PilotKnowledgeEntry[] = [
  {
    id: "e1e1e1e1-0006-4001-8001-000000000006",
    title: "Plumbing layout: install square, level, and plumb",
    description:
      "Field note on how to confirm square, level, and plumb before committing to install.",
    body: "Measure twice, check square, level, then plumb before install.",
    metadata: {
      sourceType: "supervisor field notes",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "direct",
      issueId: 39,
    },
  },
  {
    id: "e1e1e1e1-0007-4001-8001-000000000007",
    title: "Keeping connections truly watertight",
    description:
      "Field note on confirming seal and preventing false confidence before a leak shows up.",
    body: "Inspect surfaces and gasket condition before tightening each connection.",
    metadata: {
      sourceType: "supervisor field notes",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "direct",
      issueId: 39,
    },
  },
  {
    id: "e1e1e1e1-0008-4001-8001-000000000008",
    title: "Work safely without scraping knuckles",
    description:
      "Field note on avoiding common hand injuries while handling pipe and fittings.",
    body: "Use controlled leverage and stable bracing; move carefully instead of forcing.",
    metadata: {
      sourceType: "supervisor field notes",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "direct",
      issueId: 39,
    },
  },
  {
    id: "e1e1e1e1-0009-4001-8001-000000000009",
    title: "Diagnosing backed up drains and plugged lines",
    description:
      "Field note on how to confirm the actual block points before choosing a fix.",
    body: "Verify broader drainage behavior and check the basin drain before opening a line.",
    metadata: {
      sourceType: "supervisor field notes",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "direct",
      issueId: 39,
    },
  },
  {
    id: "e1e1e1e1-0010-4001-8001-000000000010",
    title: "Pre-pour sequencing for slab and mechanical penetrations",
    description:
      "Field note on pre-pour coordination to avoid stoppages and operational exposure.",
    body: "Review drawings and coordinate slab/penetrations before pour.",
    metadata: {
      sourceType: "supervisor field notes",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "direct",
      issueId: 39,
    },
  },
  {
    id: "e1e1e1e1-0011-4001-8001-000000000011",
    title: "Cut length verification and recheck discipline",
    description:
      "Field note on avoiding wrong cuts, dimension mistakes, and avoidable waste.",
    body: "Recheck dimensions before forcing a wrong cut into final geometry.",
    metadata: {
      sourceType: "supervisor field notes",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "direct",
      issueId: 39,
      failureCost:
        "Rob noted approximately $50K/day in bank financing and line-of-credit capacity for day-to-day operations.",
    },
  },
  {
    id: "e1e1e1e1-0012-4001-8001-000000000012",
    title: "Question-first approach for difficult plumbing work",
    description: "Inferred pattern from repeated field notes.",
    body: "Ask, clarify, and understand scope before choosing an approach.",
    metadata: {
      sourceType: "inferred reasoning pattern",
      pilotId: "001",
      pilotName: "Pilot 001",
      contributor: "Rob",
      knowledgeNature: "inferred",
      issueId: 39,
    },
  },
];

const GLOBAL_KNOWLEDGE_ENTRY: PilotKnowledgeEntry = {
  id: "e1e1e1e1-0001-4001-8001-000000000001",
  title: "General plumbing safety checklist",
  description: "Global safety reminder for all plumbing tasks.",
  body: "Review the workspace, check tool setup, and confirm a safe work plan.",
  metadata: {
    sourceType: "global knowledge",
    contributor: "Torch Platform",
    knowledgeNature: "direct",
  },
};

function seedPilotScope(
  userId: string,
  pilotId: string,
  organizationId: string,
  pilotName: string,
): void {
  fake.tables.pilot_memberships = [
    {
      user_id: userId,
      pilot_id: pilotId,
      organization_id: organizationId,
      role: "tester",
      active: true,
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_until: null,
    },
  ];
  fake.tables.pilots = [
    {
      id: pilotId,
      organization_id: organizationId,
      name: pilotName,
      status: "active",
    },
  ];
}

function seedEntries(): void {
  fake.tables["knowledge_entries"] = [
    ...ROB_PILOT_ENTRIES,
    GLOBAL_KNOWLEDGE_ENTRY,
  ].map((entry) => ({
    id: entry.id,
    title: entry.title,
    trade: "Plumber",
    category: "Plumbing",
    tags:
      entry.metadata.sourceType === "global knowledge"
        ? ["plumbing", "global", "knowledge"]
        : ["plumbing", "pilot-001", "rob"],
    description: entry.description,
    body: entry.body,
    images: [],
    metadata: {
      origin: "manual-seed",
      sourceTrade: "Plumber",
      ...entry.metadata,
      entryNumber: Number(entry.id.slice(13, 16)),
    },
  }));
}

function withKnowledgeMetadataLookupFailure(): () => void {
  const originalFrom = fake.from;
  const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
    if (table !== "knowledge_entries") return originalFrom.call(fake, table);

    return {
      select: () => ({
        in: () =>
          Promise.resolve({
            data: null,
            error: { message: "metadata unavailable" },
          }),
      }),
    } as unknown as ReturnType<typeof fake.from>;
  });

  return () => spy.mockRestore();
}

function withKnowledgeMetadataRows(
  rows: Array<{ id: string; metadata: unknown }>,
): () => void {
  const originalFrom = fake.from;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const spy = vi.spyOn(fake, "from").mockImplementation((table: string) => {
    if (table !== "knowledge_entries") return originalFrom.call(fake, table);

    return {
      select: () => ({
        in: (_column: string, ids: unknown[]) => {
          const filtered = (ids ?? [])
            .filter((id): id is string => typeof id === "string")
            .map((id) => rowsById.get(id))
            .filter((row): row is { id: string; metadata: unknown } => !!row)
            .map((row) => ({ id: row.id, metadata: row.metadata }));

          return Promise.resolve({ data: filtered, error: null });
        },
      }),
    } as unknown as ReturnType<typeof fake.from>;
  });

  return () => spy.mockRestore();
}

function makeApp(): Express {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    const noop = () => {};
    (req as unknown as { log: Record<string, () => void> }).log = {
      warn: noop,
      error: noop,
      info: noop,
      debug: noop,
    };
    const header = req.headers["x-test-user"];
    (req as unknown as { userId: string }).userId =
      typeof header === "string" && header.length > 0
        ? header
        : DEFAULT_USER_ID;
    next();
  });
  app.use("/api", chatRouter);
  return app;
}

const app = makeApp();

interface PromptFixture {
  prompt: string;
  expectedEntryId: string;
  expectedSystemSnippet: string;
}

beforeEach(() => {
  resetMocks();
  seedEntries();
  seedPilotScope(
    DEFAULT_USER_ID,
    PILOT_ID_001,
    ORGANIZATION_ID_001,
    "Pilot 001",
  );
});

describe("POST /api/chat — Pilot 001 plumbing retrieval coverage", () => {
  const fixtures: PromptFixture[] = [
    {
      prompt: "How do I make sure this install is square and level?",
      expectedEntryId: "e1e1e1e1-0006-4001-8001-000000000006",
      expectedSystemSnippet: "Measure twice, check square, level, then plumb",
    },
    {
      prompt: "How do I know this connection is actually watertight?",
      expectedEntryId: "e1e1e1e1-0007-4001-8001-000000000007",
      expectedSystemSnippet: "Inspect surfaces and gasket",
    },
    {
      prompt: "How do I stop scraping my knuckles doing this?",
      expectedEntryId: "e1e1e1e1-0008-4001-8001-000000000008",
      expectedSystemSnippet: "controlled leverage and stable bracing",
    },
    {
      prompt: "The drain is backing up. Is the line plugged?",
      expectedEntryId: "e1e1e1e1-0009-4001-8001-000000000009",
      expectedSystemSnippet: "Verify broader drainage behavior",
    },
    {
      prompt:
        "We have slab penetrations before the pour. What should I be checking?",
      expectedEntryId: "e1e1e1e1-0010-4001-8001-000000000010",
      expectedSystemSnippet: "Review drawings and coordinate slab",
    },
    {
      prompt: "I already cut it but the measurement is wrong.",
      expectedEntryId: "e1e1e1e1-0011-4001-8001-000000000011",
      expectedSystemSnippet: "Recheck dimensions",
    },
  ];

  it.each(fixtures)(
    "returns the expected Pilot 001 knowledge for: $prompt",
    async ({ prompt, expectedEntryId, expectedSystemSnippet }) => {
      const res = await request(app)
        .post("/api/chat")
        .send({ message: prompt });
      expect(res.status).toBe(200);
      expect(res.body.usedInternalKnowledge).toBe(true);

      const knowledgeCitations = (
        res.body.citations as Array<{
          sourceType: "video" | "knowledge";
          entryId?: string;
        }>
      ).filter((c) => c.sourceType === "knowledge");
      expect(
        knowledgeCitations.some((c) => c.entryId === expectedEntryId),
      ).toBe(true);

      const lastCall = vi.mocked(chatCompletion).mock.calls.at(-1)?.[0];
      const systemMessage =
        lastCall?.messages?.find((message) => message.role === "system")
          ?.content ?? "";
      expect(systemMessage).toContain(expectedSystemSnippet);
    },
  );

  it("serves inferred Rob reasoning patterns for ambiguous diagnostic framing", async () => {
    const res = await request(app).post("/api/chat").send({
      message:
        "I am seeing an odd symptom and I am not sure what to fix first.",
    });
    expect(res.status).toBe(200);
    expect(res.body.usedInternalKnowledge).toBe(true);

    const knowledgeCitations = (
      res.body.citations as Array<{
        sourceType: "video" | "knowledge";
        entryId?: string;
      }>
    ).filter((c) => c.sourceType === "knowledge");
    expect(
      knowledgeCitations.some(
        (c) => c.entryId === "e1e1e1e1-0012-4001-8001-000000000012",
      ),
    ).toBe(true);

    const lastCall = vi.mocked(chatCompletion).mock.calls.at(-1)?.[0];
    const systemMessage =
      lastCall?.messages?.find((message) => message.role === "system")
        ?.content ?? "";
    expect(systemMessage).toContain("Ask, clarify, and understand scope");
  });

  it("returns Pilot 001 global entries for unaffiliated users but blocks Pilot 001 entries", async () => {
    const res = await request(app)
      .post("/api/chat")
      .set("x-test-user", UNAFFILIATED_USER_ID)
      .send({ message: "What should I check before I start this task?" });
    expect(res.status).toBe(200);
    expect(res.body.usedInternalKnowledge).toBe(true);

    const knowledgeCitations = (
      res.body.citations as Array<{
        sourceType: "video" | "knowledge";
        entryId?: string;
      }>
    ).filter((c) => c.sourceType === "knowledge");
    expect(
      knowledgeCitations.some(
        (c) => c.entryId === "e1e1e1e1-0006-4001-8001-000000000006",
      ),
    ).toBe(false);
    expect(
      knowledgeCitations.some((c) => c.entryId === GLOBAL_KNOWLEDGE_ENTRY.id),
    ).toBe(true);
  });

  it("does not return Pilot 001 entries for an active different pilot user", async () => {
    seedPilotScope(
      OTHER_PILOT_USER_ID,
      PILOT_ID_002,
      ORGANIZATION_ID_002,
      "Pilot 002",
    );

    const res = await request(app)
      .post("/api/chat")
      .set("x-test-user", OTHER_PILOT_USER_ID)
      .send({
        message: "How do I know this connection is actually watertight?",
      });
    expect(res.status).toBe(200);
    expect(res.body.usedInternalKnowledge).toBe(true);

    const knowledgeCitations = (
      res.body.citations as Array<{
        sourceType: "video" | "knowledge";
        entryId?: string;
      }>
    ).filter((c) => c.sourceType === "knowledge");
    expect(
      knowledgeCitations.some(
        (c) => c.entryId === "e1e1e1e1-0007-4001-8001-000000000007",
      ),
    ).toBe(false);
    expect(
      knowledgeCitations.some((c) => c.entryId === GLOBAL_KNOWLEDGE_ENTRY.id),
    ).toBe(true);
  });

  it("keeps inferred Rob patterns pilot-scoped and blocks them outside Pilot 001", async () => {
    seedPilotScope(
      OTHER_PILOT_USER_ID,
      PILOT_ID_002,
      ORGANIZATION_ID_002,
      "Pilot 002",
    );
    const res = await request(app)
      .post("/api/chat")
      .set("x-test-user", OTHER_PILOT_USER_ID)
      .send({ message: "I am not sure what to do first." });
    expect(res.status).toBe(200);
    expect(res.body.usedInternalKnowledge).toBe(true);

    const knowledgeCitations = (
      res.body.citations as Array<{
        sourceType: "video" | "knowledge";
        entryId?: string;
      }>
    ).filter((c) => c.sourceType === "knowledge");
    expect(
      knowledgeCitations.some(
        (c) => c.entryId === "e1e1e1e1-0012-4001-8001-000000000012",
      ),
    ).toBe(false);
    expect(
      knowledgeCitations.some((c) => c.entryId === GLOBAL_KNOWLEDGE_ENTRY.id),
    ).toBe(true);
  });

  it("does not expose Pilot 001 knowledge when metadata lookup fails", async () => {
    const restore = withKnowledgeMetadataLookupFailure();
    try {
      const res = await request(app).post("/api/chat").send({
        message: "How do I make sure this install is square and level?",
      });
      expect(res.status).toBe(200);
      expect(res.body.usedInternalKnowledge).toBe(false);

      const knowledgeCitations = (
        res.body.citations as Array<{
          sourceType: "video" | "knowledge";
          entryId?: string;
        }>
      ).filter((c) => c.sourceType === "knowledge");
      expect(
        knowledgeCitations.some(
          (c) =>
            c.entryId === "e1e1e1e1-0006-4001-8001-000000000006" ||
            c.entryId === "e1e1e1e1-0012-4001-8001-000000000012",
        ),
      ).toBe(false);
    } finally {
      restore();
    }
  });

  it("treats missing per-entry metadata as unknown and excludes it while allowing proven global rows", async () => {
    const restore = withKnowledgeMetadataRows([
      {
        id: GLOBAL_KNOWLEDGE_ENTRY.id,
        metadata: GLOBAL_KNOWLEDGE_ENTRY.metadata,
      },
    ]);
    try {
      const res = await request(app).post("/api/chat").send({
        message: "How do I make sure this install is square and level?",
      });
      expect(res.status).toBe(200);

      const knowledgeCitations = (
        res.body.citations as Array<{
          sourceType: "video" | "knowledge";
          entryId?: string;
        }>
      ).filter((c) => c.sourceType === "knowledge");
      expect(
        knowledgeCitations.some(
          (c) => c.entryId === "e1e1e1e1-0006-4001-8001-000000000006",
        ),
      ).toBe(false);
      expect(
        knowledgeCitations.some((c) => c.entryId === GLOBAL_KNOWLEDGE_ENTRY.id),
      ).toBe(true);
    } finally {
      restore();
    }
  });

  it("retains Pilot 001 provenance metadata on all seeded entries", () => {
    const rows = fake.tables["knowledge_entries"] as Array<{
      id: string;
      metadata: Record<string, unknown>;
    }>;
    const pilotRows = rows.filter(
      (row) => row.id !== GLOBAL_KNOWLEDGE_ENTRY.id,
    );
    expect(pilotRows.every((row) => row.metadata.pilotId === "001")).toBe(true);
    expect(pilotRows.every((row) => row.metadata.contributor === "Rob")).toBe(
      true,
    );
    expect(
      rows.some((row) => row.metadata.knowledgeNature === "inferred"),
    ).toBe(true);
  });

  it("does not include raw inference placeholder IDs outside seeded rows", () => {
    expect(
      fake.tables["knowledge_entries"]
        .map((entry) => entry["id"])
        .every((id) => typeof id === "string" && id.startsWith("e1e1e1e1-")),
    ).toBe(true);
  });
});
