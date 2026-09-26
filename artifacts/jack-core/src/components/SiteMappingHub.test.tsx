// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SiteMappingHub } from "./SiteMappingHub";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("shared site mapping", () => {
  it("keeps a phone capture local until an authorized site upload is tapped", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/sites"))
          return {
            ok: true,
            json: async () => ({
              sites: [
                {
                  id: "site-1",
                  organization_id: "org-1",
                  name: "Test site",
                  role: "contributor",
                },
              ],
            }),
          };
        if (path.endsWith("/organizations"))
          return { ok: true, json: async () => ({ organizations: [] }) };
        if (path.endsWith("/sites/site-1/scans"))
          return { ok: true, json: async () => ({ scans: [] }) };
        if (path.endsWith("/sites/site-1/scans/upload"))
          return { ok: true, json: async () => ({ scanId: "scan-1" }) };
        throw new Error(`Unexpected request ${path}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const captureBlob = vi.fn(
      () => new Blob(["ply"], { type: "application/octet-stream" }),
    );
    render(<SiteMappingHub capturedCount={3} captureBlob={captureBlob} />);
    await screen.findByRole("button", {
      name: /Upload this scan to Test site/,
    });
    expect(captureBlob).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(([, options]) => options?.method !== "POST"),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: /Upload this scan to Test site/ }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([path, options]) =>
            String(path).endsWith("/sites/site-1/scans/upload") &&
            options?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(captureBlob).toHaveBeenCalledOnce();
  });

  it("shows an honest no-site state and disables upload without a capture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => ({
        ok: true,
        json: async () =>
          String(input).endsWith("/sites")
            ? { sites: [] }
            : { organizations: [] },
      })),
    );
    render(<SiteMappingHub capturedCount={0} captureBlob={() => null} />);
    expect(
      await screen.findByText("No site is connected to your account."),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Upload this scan/ }),
    ).toBeNull();
  });

  it("shows a load failure without calling it an empty site", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "Site mapping is unavailable." }),
      })),
    );
    render(<SiteMappingHub capturedCount={0} captureBlob={() => null} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Site mapping is unavailable.",
    );
    expect(
      screen.queryByText("No site is connected to your account."),
    ).toBeNull();
  });

  it("lists an authorized site's uploaded capture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        const body = path.endsWith("/sites")
          ? {
              sites: [
                {
                  id: "site-1",
                  organization_id: "org-1",
                  name: "Test site",
                  role: "viewer",
                },
              ],
            }
          : path.endsWith("/organizations")
            ? { organizations: [] }
            : {
                scans: [
                  {
                    id: "scan-1",
                    point_count: 7391,
                    byte_size: 90000,
                    uploaded_at: "2026-09-26T00:00:00Z",
                  },
                ],
              };
        return { ok: true, json: async () => body };
      }),
    );
    render(<SiteMappingHub capturedCount={0} captureBlob={() => null} />);
    expect(await screen.findByText(/7,391 points/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Download PLY" }).getAttribute("href"),
    ).toBe("/api/site-mapping/sites/site-1/scans/scan-1/download");
    expect(
      screen
        .getByRole("button", { name: /Upload this scan/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });
});
