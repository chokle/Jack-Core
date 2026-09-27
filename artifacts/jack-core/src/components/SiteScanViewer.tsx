import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { BufferAttribute, BufferGeometry } from "three";
import {
  downloadSiteMappingScan,
  type SiteMappingScan,
} from "@workspace/api-client-react";

const MAX_DISPLAY_POINTS = 50_000;
const MAX_SCAN_BYTES = 25 * 1024 * 1024;

/** The private PLY remains the source of truth; this is only a bounded view of it. */
export function parseSiteScan(buffer: ArrayBuffer): {
  geometry: BufferGeometry;
  pointCount: number;
  displayedPoints: number;
  radius: number;
} {
  if (buffer.byteLength > MAX_SCAN_BYTES)
    throw new Error("The scan exceeds the supported file size.");
  const preview = new TextDecoder("ascii").decode(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 8192)),
  );
  const match = /(?:^|\n)end_header\r?\n/.exec(preview);
  if (!match) throw new Error("The scan has no usable depth points.");
  const headerBytes = match.index + match[0].length;
  const lines = preview
    .slice(0, headerBytes)
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n");
  if (
    lines[0] !== "ply" ||
    !lines.includes("format binary_little_endian 1.0") ||
    lines.some(
      (line) =>
        line.startsWith("element ") && !line.startsWith("element vertex "),
    ) ||
    lines.filter((line) => line.startsWith("property ")).join("|") !==
      "property float x|property float y|property float z"
  )
    throw new Error("The scan has an unsupported depth format.");
  const vertexLine = lines.find((line) => line.startsWith("element vertex "));
  const pointCount = vertexLine
    ? Number(vertexLine.slice("element vertex ".length))
    : NaN;
  if (
    !Number.isInteger(pointCount) ||
    pointCount < 1 ||
    pointCount > 2_000_000 ||
    buffer.byteLength !== headerBytes + pointCount * 12
  )
    throw new Error("The scan has no usable depth points.");
  const stride = Math.max(1, Math.ceil(pointCount / MAX_DISPLAY_POINTS));
  const displayedPoints = Math.ceil(pointCount / stride);
  const points = new Float32Array(displayedPoints * 3);
  const source = new DataView(buffer, headerBytes, pointCount * 12);
  for (let index = 0; index < displayedPoints; index++) {
    const from = index * stride * 12;
    const offset = index * 3;
    points[offset] = source.getFloat32(from, true);
    points[offset + 1] = source.getFloat32(from + 4, true);
    points[offset + 2] = source.getFloat32(from + 8, true);
    if (
      !Number.isFinite(points[offset]) ||
      !Number.isFinite(points[offset + 1]) ||
      !Number.isFinite(points[offset + 2])
    ) {
      throw new Error("The scan contains invalid depth points.");
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(points, 3));
  geometry.computeBoundingSphere();
  const radius = Math.max(0.5, geometry.boundingSphere?.radius ?? 0.5);
  geometry.center();
  return { geometry, pointCount, displayedPoints, radius };
}

export function SiteScanViewer({
  siteId,
  scan,
}: {
  siteId: string;
  scan: SiteMappingScan;
}) {
  const [view, setView] = useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | {
        kind: "ready";
        geometry: BufferGeometry;
        pointCount: number;
        displayedPoints: number;
        radius: number;
      }
  >({ kind: "loading" });
  const [expanded, setExpanded] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    if (!expanded && openedRef.current) {
      openButtonRef.current?.focus();
      openedRef.current = false;
    }
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const oldOverflow = document.body.style.overflow;
    const overlay = closeButtonRef.current?.parentElement;
    const background = Array.from(document.body.children)
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== overlay,
      )
      .map((element) => ({ element, wasInert: element.inert }));
    background.forEach(({ element }) => {
      element.inert = true;
    });
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "Tab") {
        event.preventDefault();
        closeButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      background.forEach(({ element, wasInert }) => {
        element.inert = wasInert;
      });
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [expanded]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setView({ kind: "loading" });
    downloadSiteMappingScan(siteId, scan.id, { signal: controller.signal })
      .then(async (blob) => {
        const buffer = await blob.arrayBuffer();
        if (!active || controller.signal.aborted) return;
        const parsed = parseSiteScan(buffer);
        if (parsed.pointCount !== scan.point_count) {
          parsed.geometry.dispose();
          throw new Error("Scan metadata does not match the file.");
        }
        if (active) setView({ kind: "ready", ...parsed });
        else parsed.geometry.dispose();
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setView({
            kind: "error",
            message: "Could not load this private scan.",
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [siteId, scan.id, scan.point_count]);

  useEffect(() => {
    return () => {
      if (view.kind === "ready") view.geometry.dispose();
    };
  }, [view]);

  if (view.kind === "loading") return <p role="status">Loading 3D scan…</p>;
  if (view.kind === "error") return <p role="alert">{view.message}</p>;
  const viewer = (
    <div
      className={`site-scan-viewer${expanded ? " site-scan-viewer--expanded" : ""}`}
      aria-label={
        expanded ? `Full-screen 3D scan ${scan.id}` : `3D scan ${scan.id}`
      }
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
    >
      {expanded && (
        <button
          ref={closeButtonRef}
          type="button"
          className="site-scan-viewer__close"
          onClick={() => setExpanded(false)}
        >
          Close full-screen 3D view
        </button>
      )}
      <div className="site-scan-viewer__canvas">
        <Canvas
          key={scan.id}
          camera={{
            position: [view.radius, view.radius * 0.6, view.radius * 2.5],
            near: 0.01,
            far: Math.max(100, view.radius * 10),
          }}
          dpr={[1, 2]}
        >
          <color attach="background" args={["#07131b"]} />
          <points geometry={view.geometry} dispose={null}>
            <pointsMaterial color="#67e8f9" size={0.035} sizeAttenuation />
          </points>
          <OrbitControls makeDefault enableDamping />
        </Canvas>
        {!expanded && (
          <button
            ref={openButtonRef}
            type="button"
            className="site-scan-viewer__open"
            aria-label="Open 3D scan full screen"
            onClick={() => {
              openedRef.current = true;
              setExpanded(true);
            }}
          >
            <span>Open full screen</span>
          </button>
        )}
      </div>
      <p>
        {view.displayedPoints.toLocaleString()} of{" "}
        {scan.point_count.toLocaleString()} measured points shown.{" "}
        {expanded
          ? "Drag to rotate; pinch or scroll to zoom."
          : "Tap the model to open it full screen."}
      </p>
    </div>
  );
  return expanded ? createPortal(viewer, document.body) : viewer;
}
