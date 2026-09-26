import { describe, expect, it, vi } from "vitest";
import { addCapturePoints, capturePly, saveCaptureFile } from "./radar-capture";
import type { ArPoint } from "./radar-ar";

const point = (x: number, y = 0, z = -2): ArPoint => ({ x, y, z, seenAt: 1 });

describe("local AR depth capture", () => {
  it("keeps separate 5 cm voxels and rejects invalid coordinates", () => {
    const captured = new Map<string, ArPoint>();
    addCapturePoints(captured, [point(0), point(0.01), point(0.1), point(NaN)]);
    expect([...captured.values()]).toEqual([point(0), point(0.1)]);
  });

  it("exports a binary PLY of local coordinates", async () => {
    const blob = capturePly([point(1, 2, 3)]);
    const bytes = await blob.arrayBuffer();
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("element vertex 1\n");
    expect(text).toContain("not surveyed or for navigation");
    const offset = text.indexOf("end_header\n") + "end_header\n".length;
    const coordinates = new DataView(bytes, offset);
    expect(coordinates.getFloat32(0, true)).toBe(1);
    expect(coordinates.getFloat32(4, true)).toBe(2);
    expect(coordinates.getFloat32(8, true)).toBe(3);
  });

  it("reports saved only after the selected file finishes writing", async () => {
    const file = capturePly([point(1)]);
    let finishClose = () => {};
    const write = vi.fn(async () => {});
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const picker = vi.fn(async () => ({
      createWritable: async () => ({
        write,
        close,
        abort: vi.fn(async () => {}),
      }),
    }));
    const save = saveCaptureFile(file, "radar-depth.ply", picker);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    let finished = false;
    void save.then(() => {
      finished = true;
    });
    expect(finished).toBe(false);
    finishClose();
    expect(await save).toBe("saved");
    expect(picker).toHaveBeenCalledWith({ suggestedName: "radar-depth.ply" });
    expect(write).toHaveBeenCalledWith(file);
  });

  it("does not report a cancelled save as complete", async () => {
    const picker = vi.fn(async () => {
      throw new DOMException("Cancelled", "AbortError");
    });
    await expect(
      saveCaptureFile(capturePly([]), "radar-depth.ply", picker),
    ).resolves.toBe("cancelled");
  });

  it("reports a failed write after file selection even when it is an AbortError", async () => {
    const error = new DOMException("Write failed", "AbortError");
    const abort = vi.fn(async () => {});
    const picker = vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw error;
        },
        close: vi.fn(async () => {}),
        abort,
      }),
    }));
    await expect(
      saveCaptureFile(capturePly([point(1)]), "radar-depth.ply", picker),
    ).rejects.toBe(error);
    expect(abort).toHaveBeenCalledOnce();
  });
});
