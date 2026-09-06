import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const workflow = readFileSync(
  new URL("../workflows/jack-identity-founder-lock.yml", import.meta.url),
  "utf8",
);
const script = workflow
  .split("          script: |")[1]
  .split(/\r?\n/)
  .map((line) => line.slice(12))
  .join("\n");
const run = new (Object.getPrototypeOf(async function () {}).constructor)(
  "github",
  "context",
  "core",
  script,
);
const sha = "a".repeat(40);
const locked = [{ filename: "artifacts/api-server/src/lib/constitution.ts" }];
async function evaluate({
  files = locked,
  reviews = [],
  comments = [],
  timeline = [],
} = {}) {
  const states = [];
  const failures = [];
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { head: { sha } } }),
        listFiles: "files",
        listReviews: "reviews",
      },
      issues: { listComments: "comments", listEventsForTimeline: "timeline" },
      repos: { createCommitStatus: async (value) => states.push(value) },
    },
    paginate: async (key) => ({ files, reviews, comments, timeline })[key],
  };
  await run(
    github,
    {
      repo: { owner: "test", repo: "test" },
      payload: { issue: { number: 143 } },
    },
    {
      info() {},
      setFailed(message) {
        failures.push(message);
      },
    },
  );
  assert.ok(
    states.every(
      (state) =>
        state.sha === sha && state.context === "Jack Identity Founder Lock",
    ),
  );
  return { state: states.at(-1).state, failures };
}
const review = (state, id = 1, commit_id = sha) => ({
  id,
  state,
  commit_id,
  user: { login: "chokle" },
  submitted_at: `2026-09-06T01:0${id}:00Z`,
});
const comment = (
  body = `FOUNDER-APPROVED-JACK-IDENTITY ${sha}`,
  updated_at = "2026-09-06T01:00:00Z",
) => ({ body, user: { login: "chokle" }, updated_at });
test("unlocked changes publish success on PR head", async () =>
  assert.equal(
    (await evaluate({ files: [{ filename: "README.md" }] })).state,
    "success",
  ));
test("locked files fail closed without approval", async () =>
  assert.equal((await evaluate()).state, "failure"));
test("rename outside locked paths still requires approval", async () =>
  assert.equal(
    (
      await evaluate({
        files: [
          { filename: "elsewhere.ts", previous_filename: locked[0].filename },
        ],
      })
    ).state,
    "failure",
  ));
test("current-head approval succeeds", async () =>
  assert.equal(
    (await evaluate({ reviews: [review("APPROVED")] })).state,
    "success",
  ));
test("old-head approval fails", async () =>
  assert.equal(
    (await evaluate({ reviews: [review("APPROVED", 1, "b".repeat(40))] }))
      .state,
    "failure",
  ));
test("newer changes requested supersede approval and older comment", async () =>
  assert.equal(
    (
      await evaluate({
        reviews: [review("APPROVED"), review("CHANGES_REQUESTED", 2)],
        comments: [comment()],
      })
    ).state,
    "failure",
  ));
test("dismissed review invalidates approval", async () =>
  assert.equal(
    (await evaluate({ reviews: [review("DISMISSED")] })).state,
    "failure",
  ));
test("exact founder comment approves current head", async () =>
  assert.equal((await evaluate({ comments: [comment()] })).state, "success"));
test("quoted marker is not affirmative approval", async () =>
  assert.equal(
    (
      await evaluate({
        comments: [
          comment(`Do not approve FOUNDER-APPROVED-JACK-IDENTITY ${sha}`),
        ],
      })
    ).state,
    "failure",
  ));
test("deleted marker reruns and fails closed", async () => {
  assert.match(workflow, /types: \[created, edited, deleted\]/);
  assert.equal((await evaluate({ comments: [] })).state, "failure");
});
test("later affirmative comment can supersede requested changes", async () =>
  assert.equal(
    (
      await evaluate({
        reviews: [review("CHANGES_REQUESTED")],
        comments: [comment(undefined, "2026-09-06T02:00:00Z")],
      })
    ).state,
    "success",
  ));

test("comment before dismissal cannot keep approval alive", async () => {
  const result = await evaluate({
    reviews: [review("DISMISSED")],
    comments: [comment(undefined, "2026-09-06T02:00:00Z")],
    timeline: [
      {
        event: "review_dismissed",
        dismissed_review: { review_id: 1 },
        created_at: "2026-09-06T03:00:00Z",
      },
    ],
  });
  assert.equal(result.state, "failure");
});
test("comment after authoritative dismissal can approve", async () => {
  const result = await evaluate({
    reviews: [review("DISMISSED")],
    comments: [comment(undefined, "2026-09-06T04:00:00Z")],
    timeline: [
      {
        event: "review_dismissed",
        dismissed_review: { review_id: 1 },
        created_at: "2026-09-06T03:00:00Z",
      },
    ],
  });
  assert.equal(result.state, "success");
});
test("unknown dismissal time fails closed", async () => {
  assert.equal(
    (
      await evaluate({
        reviews: [review("DISMISSED")],
        comments: [comment(undefined, "2026-09-06T04:00:00Z")],
      })
    ).state,
    "failure",
  );
});
test("privileged workflow does not execute on untrusted review revision", () => {
  assert.doesNotMatch(workflow, /  pull_request_review:/);
  assert.match(workflow, /workflows: \[Founder Lock Review Signal\]/);
  assert.doesNotMatch(workflow, /actions\/checkout/);
});
