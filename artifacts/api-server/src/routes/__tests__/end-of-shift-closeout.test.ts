import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const identity = vi.hoisted(() => ({
  userId: "participant-1",
  email: "participant@example.test",
  name: "Pilot Participant",
  isAdmin: false,
  isPresentation: false,
  classification: "resolved",
}));

vi.mock("../../lib/supabase.js", async () => {
  const mocks = await import("../../lib/__tests__/mocks.js");
  return { supabase: { from: mocks.fake.from.bind(mocks.fake) } };
});
vi.mock("../../lib/admin-auth.js", () => ({
  resolveIdentity: vi.fn(async () => ({ ...identity })),
}));

import { fake, resetMocks } from "../../lib/__tests__/mocks.js";
import endOfShiftCloseoutRouter from "../end-of-shift-closeout.js";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const PILOT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PILOT_ID = "33333333-3333-4333-8333-333333333333";
const WORK_DATE = "2026-07-25";

function app(): Express {
  const value = express();
  value.use((req, _res, next) => {
    (req as never as { log: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } }).log =
      { error: vi.fn(), warn: vi.fn() };
    next();
  });
  value.use(express.json());
  value.use("/api", endOfShiftCloseoutRouter);
  return value;
}

function seedMemberships() {
  fake.tables.pilots = [{ id: PILOT_ID, organization_id: ORGANIZATION_ID }];
  fake.tables.pilot_memberships = [{
    id: "tester-membership",
    user_id: identity.userId,
    organization_id: ORGANIZATION_ID,
    pilot_id: PILOT_ID,
    role: "tester",
    active: true,
    valid_from: "2026-01-01T00:00:00.000Z",
    valid_until: null,
  }];
}

function validDraft(answers?: Record<string, string>) {
  return {
    workDate: WORK_DATE,
    shift: "day",
    status: "draft",
    answers: answers ?? {
      tasksCompleted: "All tasks wrapped up",
      safetyConcerns: "No active incidents",
      handoverReadiness: "Crew knows remaining tasks",
      teamCoordination: "Shift handover sent to lead",
      materialAndTools: "No missing tools",
      nextShiftPriorities: "Hydraulic checks",
    },
  };
}

function validSubmit(answers?: Record<string, string>) {
  return {
    ...validDraft(answers),
    status: "submitted",
  };
}

beforeEach(() => {
  resetMocks();
  Object.assign(identity, {
    userId: "participant-1",
    isAdmin: false,
    isPresentation: false,
    classification: "resolved",
  });
  fake.tables.pilot_memberships = [];
  fake.tables.pilots = [{ id: PILOT_ID, organization_id: ORGANIZATION_ID }];
  fake.tables.organizations = [{ id: ORGANIZATION_ID, name: "Pilot Org", status: "active" }];
  fake.tables.mentor_profiles = [{
    id: "mentor-profile-1",
    contributor_user_id: "participant-1",
    trade: "Electrical",
    updated_at: "2026-07-01T00:00:00.000Z",
  }];
});

describe("end-of-shift closeout", () => {
  it("supports draft save, resume, and full submit flow", async () => {
    seedMemberships();
    const initial = await request(app()).get(`/api/testing/closeouts?workDate=${WORK_DATE}&shift=day`);
    expect(initial.status).toBe(200);
    expect(initial.body.state).toBe("not_started");
    expect(initial.body.scope.actorUserId).toBe("participant-1");
    expect(initial.body.trade).toBe("Electrical");

    const draft = await request(app()).post("/api/testing/closeouts").send(validDraft());
    expect(draft.status).toBe(201);
    expect(draft.body.state).toBe("draft");
    expect(draft.body.closeout.answers.tasksCompleted).toBe("All tasks wrapped up");

    const revision = await request(app())
      .post("/api/testing/closeouts")
      .send({
        ...validDraft(),
        answers: {
          ...validDraft().answers,
          teamCoordination: "Updated with new note",
        },
      });
    expect(revision.status).toBe(200);
    expect(revision.body.closeout.answers.teamCoordination).toBe("Updated with new note");

    const submit = await request(app()).post("/api/testing/closeouts").send(validSubmit());
    expect(submit.status).toBe(200);
    expect(submit.body.state).toBe("submitted");

    const submitted = await request(app())
      .post("/api/testing/closeouts")
      .send(validSubmit(revision.body.closeout.answers));
    expect(submitted.status).toBe(200);
    expect(submitted.body.state).toBe("submitted");
  });

  it("prevents incomplete submissions and overwriting a submitted closeout", async () => {
    seedMemberships();
    const incomplete = await request(app())
      .post("/api/testing/closeouts")
      .send({
        ...validDraft(),
        status: "submitted",
        answers: { tasksCompleted: "some", safetyConcerns: "none" },
      });
    expect(incomplete.status).toBe(400);

    const draft = await request(app()).post("/api/testing/closeouts").send(validDraft());
    expect(draft.status).toBe(201);

    const submitted = await request(app()).post("/api/testing/closeouts").send(validSubmit());
    expect(submitted.status).toBe(200);

    const overwrite = await request(app()).post("/api/testing/closeouts").send(validDraft());
    expect(overwrite.status).toBe(409);
  });

  it("supports strict payload validation for date and answer schema", async () => {
    seedMemberships();
    const invalidDate = await request(app())
      .post("/api/testing/closeouts")
      .send({ ...validDraft(), workDate: "2026-7-5" });
    expect(invalidDate.status).toBe(400);

    const invalidAnswer = await request(app())
      .post("/api/testing/closeouts")
      .send({
        ...validDraft(),
        answers: {
          tasksCompleted: "ok",
          safetyConcerns: "ok",
          handoverReadiness: "ok",
          teamCoordination: "ok",
          materialAndTools: "ok",
          nextShiftPriorities: "ok",
          unauthorized: "x",
        },
      });
    expect(invalidAnswer.status).toBe(400);
  });

  it("denies presentation users and admins", async () => {
    seedMemberships();
    Object.assign(identity, { isPresentation: true, isAdmin: false, classification: "restricted" });
    const response = await request(app()).post("/api/testing/closeouts").send(validDraft());
    expect(response.status).toBe(403);

    Object.assign(identity, {
      isPresentation: false,
      isAdmin: true,
      classification: "resolved",
    });
    const denied = await request(app()).get("/api/testing/closeouts");
    expect(denied.status).toBe(403);
  });

  it("requires an active tester scope and rejects ambiguous memberships", async () => {
    fake.tables.pilot_memberships = [
      {
        id: "tester-membership-a",
        user_id: identity.userId,
        organization_id: ORGANIZATION_ID,
        pilot_id: PILOT_ID,
        role: "tester",
        active: true,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      },
      {
        id: "tester-membership-b",
        user_id: identity.userId,
        organization_id: ORGANIZATION_ID,
        pilot_id: OTHER_PILOT_ID,
        role: "tester",
        active: true,
        valid_from: "2026-01-01T00:00:00.000Z",
        valid_until: null,
      },
    ];
    fake.tables.pilots = [
      { id: PILOT_ID, organization_id: ORGANIZATION_ID },
      { id: OTHER_PILOT_ID, organization_id: ORGANIZATION_ID },
    ];
    const response = await request(app()).get("/api/testing/closeouts");
    expect(response.status).toBe(409);
  });

  it("keeps one closeout per participant/work-date/shift through overwriting draft", async () => {
    seedMemberships();
    const first = await request(app()).post("/api/testing/closeouts").send(validDraft());
    expect(first.status).toBe(201);
    const draft = await request(app()).post("/api/testing/closeouts").send(validDraft({
      ...validDraft().answers,
      teamCoordination: "Second pass check",
    }));
    expect(draft.status).toBe(200);
    expect(fake.tables.end_of_shift_closeouts).toHaveLength(1);
    const list = await request(app()).get(`/api/testing/closeouts?workDate=${WORK_DATE}&shift=day`);
    expect(list.status).toBe(200);
    expect(list.body.closeout.answers.teamCoordination).toBe("Second pass check");

    const shifted = await request(app())
      .post("/api/testing/closeouts")
      .send({ ...validDraft(), shift: "night" });
    expect(shifted.status).toBe(201);
    expect(fake.tables.end_of_shift_closeouts).toHaveLength(2);
  });

  it("returns 409 when trying to overwrite a submitted closeout from a different date/shift draft state", async () => {
    seedMemberships();
    const submitted = await request(app()).post("/api/testing/closeouts").send(validSubmit());
    expect(submitted.status).toBe(200);
    const same = await request(app())
      .post("/api/testing/closeouts")
      .send({ ...validSubmit(), workDate: WORK_DATE, shift: "day" });
    expect(same.status).toBe(200);
    const blocked = await request(app())
      .post("/api/testing/closeouts")
      .send({ ...validDraft(), status: "draft", shift: "day" });
    expect(blocked.status).toBe(409);
  });
});
