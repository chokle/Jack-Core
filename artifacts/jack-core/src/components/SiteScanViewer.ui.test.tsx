// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SiteScanViewer } from "./SiteScanViewer";
import type { SiteMappingScan } from "@workspace/api-client-react";

vi.mock("@react-three/fiber", () => ({
  Canvas: () => <div data-testid="scan-canvas" />,
}));
vi.mock("@react-three/drei", () => ({ OrbitControls: () => null }));

const scan: SiteMappingScan = {
  id: "scan-1",
  capture_format: "radar_ply_points_v1",
  status: "uploaded",
  byte_size: 150,
  point_count: 1,
  created_at: "2026-09-26T00:00:00Z",
  uploaded_at: "2026-09-26T00:00:00Z",
};

function ply(): Uint8Array {
  const header = new TextEncoder().encode(
    "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n",
  );
  const bytes = new Uint8Array(header.length + 12);
  bytes.set(header);
  new DataView(bytes.buffer, header.length).setFloat32(0, 1, true);
  return bytes;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("authorized 3D scan", () => {
  it("aborts a private download when the viewer closes", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, options?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<SiteScanViewer siteId="site-1" scan={scan} />);
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("loads the private PLY and renders its measured point after a page load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(ply() as BodyInit, {
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
    );
    render(<SiteScanViewer siteId="site-1" scan={scan} />);
    expect(screen.getByRole("status").textContent).toContain("Loading 3D scan");
    expect(await screen.findByTestId("scan-canvas")).toBeTruthy();
    expect(screen.getByText(/1 of 1 measured points shown/)).toBeTruthy();
  });

  it("opens the same private scan full screen and closes without another download", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(ply() as BodyInit, {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SiteScanViewer siteId="site-1" scan={scan} />);
    const open = await screen.findByRole("button", {
      name: "Open 3D scan full screen",
    });
    fireEvent.click(open);
    expect(
      screen.getByRole("dialog", { name: /Full-screen 3D scan/ }),
    ).toBeTruthy();
    expect(screen.getByTestId("scan-canvas")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open 3D scan full screen" }),
    ).toBeTruthy();
  });

  it("shows a clear error when the private file cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "Denied" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    render(<SiteScanViewer siteId="site-1" scan={scan} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load this private scan",
    );
    expect(screen.queryByTestId("scan-canvas")).toBeNull();
  });
});
