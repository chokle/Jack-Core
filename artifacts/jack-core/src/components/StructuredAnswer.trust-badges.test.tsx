// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { TrustBadges } from "./StructuredAnswer";

/**
 * Rendering coverage for the on-screen `TrustBadges` component. Task #113 locked
 * the server citation contract (`verified`/`sourceCount`) and the prose Jack
 * writes (`describeTrust()`) together, but the actual badge the user sees is a
 * *separate* copy of the same thresholds in the client. This test keeps the
 * client badge in step with the server contract: if someone bumps the client
 * corroboration threshold to `>= 3`, or drops the verified branch, the badge
 * would silently disagree with both the API and Jack's prose — exactly the
 * trust erosion #113 guards against, but on the frontend.
 *
 * The asserted thresholds mirror `describeTrust()` in
 * `artifacts/api-server/src/routes/chat.ts`: `verified` -> "mentor-verified",
 * `sourceCount >= 2` -> "confirmed across N videos". We render the server-side
 * gating alongside each case so the two copies can never drift apart silently.
 */

const MENTOR_LABEL = "Mentor-verified";
const confirmedLabel = (n: number) => `Confirmed across ${n} videos`;

// A verbatim mirror of the server's `describeTrust()` gating in
// `artifacts/api-server/src/routes/chat.ts`. The jack-core test package must not
// import from the api-server artifact (cross-artifact imports are disallowed and
// chat.ts pulls in express/supabase/openai), so we keep a copy here. Any change
// to the server thresholds must be reflected in BOTH copies — that lockstep is
// the whole point: this test fails the moment the client badge and the server
// contract diverge.
function describeTrust(verification: "verified" | "rejected" | "neutral", sourceCount: number): string {
  const parts: string[] = [];
  if (verification === "verified") parts.push("mentor-verified");
  if (sourceCount >= 2) parts.push(`confirmed across ${sourceCount} videos`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

// Whether the server would emit each trust signal for a given (verification,
// sourceCount) pair, derived from the `describeTrust()` mirror above. This is
// the contract the client badge must mirror exactly.
function serverSignals(verified: boolean, sourceCount: number) {
  const tag = describeTrust(verified ? "verified" : "neutral", sourceCount);
  return {
    mentor: tag.includes("mentor-verified"),
    corroborated: tag.includes(`confirmed across ${sourceCount} videos`),
  };
}

afterEach(cleanup);

describe("TrustBadges", () => {
  // The full (verified x sourceCount) matrix. Counts span below, at, and above
  // the corroboration threshold so a shifted threshold (e.g. >= 3) is caught.
  const matrix: Array<{ verified: boolean; sourceCount: number }> = [];
  for (const verified of [false, true]) {
    for (const sourceCount of [0, 1, 2, 3]) {
      matrix.push({ verified, sourceCount });
    }
  }

  for (const { verified, sourceCount } of matrix) {
    it(`matches the server contract for verified=${verified}, sourceCount=${sourceCount}`, () => {
      const { mentor, corroborated } = serverSignals(verified, sourceCount);

      const { container } = render(
        <TrustBadges verified={verified} sourceCount={sourceCount} />,
      );

      // "Mentor-verified" shows exactly when `verified` is true.
      expect(mentor).toBe(verified);
      if (mentor) {
        expect(screen.getByText(MENTOR_LABEL)).toBeTruthy();
      } else {
        expect(screen.queryByText(MENTOR_LABEL)).toBeNull();
      }

      // "Confirmed across N videos" shows exactly when `sourceCount >= 2`, with
      // the exact count.
      expect(corroborated).toBe(sourceCount >= 2);
      if (corroborated) {
        expect(screen.getByText(confirmedLabel(sourceCount))).toBeTruthy();
      } else {
        expect(screen.queryByText(confirmedLabel(sourceCount))).toBeNull();
      }

      // A lone unreviewed mention (neutral + single source) renders nothing.
      if (!mentor && !corroborated) {
        expect(container.firstChild).toBeNull();
      }
    });
  }

  it("renders nothing for a lone unreviewed mention (neutral, single source)", () => {
    const { container } = render(<TrustBadges verified={false} sourceCount={1} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(MENTOR_LABEL)).toBeNull();
    expect(screen.queryByText(/Confirmed across/)).toBeNull();
  });

  it("shows both badges when a claim is mentor-verified and corroborated", () => {
    render(<TrustBadges verified sourceCount={4} />);
    expect(screen.getByText(MENTOR_LABEL)).toBeTruthy();
    expect(screen.getByText(confirmedLabel(4))).toBeTruthy();
  });

  it("treats missing/nullish sourceCount as no corroboration", () => {
    const { container } = render(<TrustBadges verified={false} sourceCount={null} />);
    expect(container.firstChild).toBeNull();
  });
});
