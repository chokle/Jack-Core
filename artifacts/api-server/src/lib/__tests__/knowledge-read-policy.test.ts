import { beforeEach, describe, expect, it, vi } from "vitest";
const membership = vi.hoisted(() => vi.fn());
vi.mock("../activity-telemetry.js", () => ({
  resolveActiveTesterScope: membership,
}));
import {
  knowledgeEntryScopeAllowed,
  resolveKnowledgeScope,
} from "../knowledge-read-policy.js";

const scope = { organizationId: "org-a", pilotId: "pilot-a" };
beforeEach(() => {
  membership.mockReset();
});
describe("shared Ask Jack knowledge read policy", () => {
  it("preserves globally unscoped entry behavior including callers with no tester scope", () => {
    expect(knowledgeEntryScopeAllowed({}, null)).toBe(true);
    expect(knowledgeEntryScopeAllowed({ origin: "canonical" }, scope)).toBe(
      true,
    );
    expect(knowledgeEntryScopeAllowed(undefined, scope)).toBe(false);
  });
  it("requires complete exact pilot and organization equality", () => {
    expect(knowledgeEntryScopeAllowed(scope, scope)).toBe(true);
    expect(knowledgeEntryScopeAllowed(scope, null)).toBe(false);
    expect(knowledgeEntryScopeAllowed({ pilotId: scope.pilotId }, scope)).toBe(
      false,
    );
    expect(
      knowledgeEntryScopeAllowed(
        { organizationId: scope.organizationId },
        scope,
      ),
    ).toBe(false);
    expect(
      knowledgeEntryScopeAllowed({ ...scope, organizationId: "org-b" }, scope),
    ).toBe(false);
    expect(
      knowledgeEntryScopeAllowed({ ...scope, pilotId: "pilot-b" }, scope),
    ).toBe(false);
  });
  it("uses only canonical membership IDs", async () => {
    membership.mockResolvedValue({ scope: { ...scope, authority: "tester" } });
    expect(await resolveKnowledgeScope("canonical-user")).toEqual(scope);
    expect(membership).toHaveBeenCalledWith("canonical-user");
  });
  it("fails closed for ambiguous membership and resolution failures", async () => {
    membership.mockResolvedValue({ scope: null, reason: "ambiguous_pilot" });
    expect(await resolveKnowledgeScope("canonical-user")).toBeNull();
    membership.mockRejectedValue(new Error("unavailable"));
    expect(await resolveKnowledgeScope("canonical-user")).toBeNull();
  });
});
