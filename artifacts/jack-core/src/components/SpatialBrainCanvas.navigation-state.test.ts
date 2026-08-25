import { describe, expect, it } from "vitest";
import { CORE_ID, type NodeKind } from "../lib/memory-graph";
import { resolveHydratedBranchCenter } from "./SpatialBrainCanvas";

const node = (id: string, kind: NodeKind) => ({ id, kind });

describe("SpatialBrainCanvas branch hydration", () => {
  it("reapplies a durable branch when it arrives after the empty model", () => {
    const branchId = "topic:Welder";

    expect(resolveHydratedBranchCenter([], CORE_ID, branchId, "branches")).toBe(
      CORE_ID,
    );

    const hydrated = [node(CORE_ID, "core"), node(branchId, "topic")];
    expect(
      resolveHydratedBranchCenter(hydrated, CORE_ID, branchId, "branches"),
    ).toBe(branchId);

    // Later polls keep the already-restored branch stable.
    expect(
      resolveHydratedBranchCenter(hydrated, branchId, branchId, "branches"),
    ).toBe(branchId);
  });
});
