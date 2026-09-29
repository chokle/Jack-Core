import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("account settings Site Radar alias", () => {
  it("keeps the signed-in radar command available while routing it to Dashboard", () => {
    expect(source).toContain('...(isSignedIn ? [["radar", "Site radar"]] : []),');
    expect(source).toContain('const destination: JackView = next === "radar" ? "dashboard" : next;');
  });
});
