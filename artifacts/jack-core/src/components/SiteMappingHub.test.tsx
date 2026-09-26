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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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
          return json({
            sites: [
              {
                id: "site-1",
                organization_id: "org-1",
                name: "Test site",
                status: "active",
                role: "contributor",
              },
            ],
          });
        if (path.endsWith("/organizations")) return json({ organizations: [] });
        if (path.endsWith("/sites/site-1/scans")) return json({ scans: [] });
        if (path.endsWith("/sites/site-1/scans/upload"))
          return json({ scanId: "scan-1" }, 201);
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

  it("does not show an uploaded scan under a different site after switching during upload", async () => {
    let finishUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => {
      finishUpload = resolve;
    });
    const sites = [
      {
        id: "site-1",
        organization_id: "org-1",
        name: "First site",
        status: "active",
        role: "contributor",
      },
      {
        id: "site-2",
        organization_id: "org-1",
        name: "Second site",
        status: "active",
        role: "contributor",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith("/sites")) return json({ sites });
        if (path.endsWith("/organizations")) return json({ organizations: [] });
        if (path.endsWith("/sites/site-1/scans/upload")) return uploadResponse;
        if (path.endsWith("/sites/site-1/scans"))
          return json({
            scans: [
              {
                id: "scan-first",
                point_count: 7391,
                byte_size: 90000,
                uploaded_at: "2026-09-26T00:00:00Z",
              },
            ],
          });
        if (path.endsWith("/sites/site-2/scans")) return json({ scans: [] });
        throw new Error(`Unexpected request ${path}`);
      }),
    );
    render(
      <SiteMappingHub
        capturedCount={3}
        captureBlob={() => new Blob(["ply"])}
      />,
    );
    const selector = (await screen.findByRole("combobox", {
      name: "Site",
    })) as HTMLSelectElement;
    fireEvent.click(
      screen.getByRole("button", { name: /Upload this scan to First site/ }),
    );
    fireEvent.change(selector, { target: { value: "site-2" } });
    expect(selector.value).toBe("site-2");
    finishUpload(json({ scanId: "scan-first" }, 201));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: /Upload this scan to Second site/,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(screen.queryByText(/7,391 points/)).toBeNull();
    expect(screen.queryByRole("link", { name: "Download PLY" })).toBeNull();
  });

  it("shows an honest no-site state and disables upload without a capture", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        json(
          String(input).endsWith("/sites")
            ? { sites: [], recoverableSites: [] }
            : { organizations: [] },
        ),
      ),
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
      vi.fn(async () => json({ error: "Site mapping is unavailable." }, 503)),
    );
    render(<SiteMappingHub capturedCount={0} captureBlob={() => null} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Site mapping is unavailable.",
    );
    expect(
      screen.queryByText("No site is connected to your account."),
    ).toBeNull();
  });

  it("does not offer an upload to an archived site", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _options?: RequestInit) =>
        json(
          String(input).endsWith("/sites")
            ? {
                sites: [
                  {
                    id: "site-1",
                    organization_id: "org-1",
                    name: "Archived site",
                    status: "archived",
                    role: "contributor",
                  },
                ],
              }
            : String(input).endsWith("/organizations")
              ? { organizations: [] }
              : { scans: [] },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const captureBlob = vi.fn(() => new Blob(["ply"]));
    render(<SiteMappingHub capturedCount={3} captureBlob={captureBlob} />);
    expect(
      await screen.findByText(
        "This site is archived and cannot accept new scans.",
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Upload this scan/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(captureBlob).not.toHaveBeenCalled();
    expect(
      fetchMock.mock.calls.every(([, options]) => options?.method !== "POST"),
    ).toBe(true);
  });

  it("lets an organization admin explicitly restore an orphaned site's manager access", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      const site = {
        id: "site-1",
        organization_id: "org-1",
        name: "Field site",
        status: "active",
      };
      return json(
        path.endsWith("/sites")
          ? { sites: [], recoverableSites: [site] }
          : path.endsWith("/organizations")
            ? { organizations: [{ id: "org-1", name: "Field org" }] }
            : path.endsWith("/recover-manager")
              ? { site: { ...site, role: "manager" } }
              : { scans: [] },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<SiteMappingHub capturedCount={0} captureBlob={() => null} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore manager access" }),
    );
    expect(
      await screen.findByText("Manager access restored for Field site."),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).endsWith("/sites/site-1/recover-manager"),
      ),
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Restore manager access" }),
    ).toBeNull();
  });

  it("replaces an existing viewer site when manager access is restored", async () => {
    const site = {
      id: "site-1",
      organization_id: "org-1",
      name: "Field site",
      status: "active",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        return json(
          path.endsWith("/sites")
            ? {
                sites: [{ ...site, role: "viewer" }],
                recoverableSites: [site],
              }
            : path.endsWith("/organizations")
              ? { organizations: [] }
              : path.endsWith("/recover-manager")
                ? { site: { ...site, role: "manager" } }
                : { scans: [] },
        );
      }),
    );
    render(<SiteMappingHub capturedCount={0} captureBlob={() => null} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Restore manager access" }),
    );
    expect(
      await screen.findByText("Manager access restored for Field site."),
    ).toBeTruthy();
    expect(screen.getAllByRole("option", { name: "Field site" })).toHaveLength(
      1,
    );
    expect(screen.getByText(/Access: manager/)).toBeTruthy();
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
                  status: "active",
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
        return json(body);
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
