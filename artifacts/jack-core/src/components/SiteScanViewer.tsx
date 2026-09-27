import { useEffect, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { BufferAttribute, BufferGeometry } from "three";
import { PLYLoader } from "three/addons/loaders/PLYLoader.js";
import {
  downloadSiteMappingScan,
  type SiteMappingScan,
} from "@workspace/api-client-react";

const MAX_DISPLAY_POINTS = 50_000;

/** The private PLY remains the source of truth; this is only a bounded view of it. */
export function parseSiteScan(buffer: ArrayBuffer): {
  geometry: BufferGeometry;
  pointCount: number;
  displayedPoints: number;
  radius: number;
} {
  const source = new PLYLoader().parse(buffer);
  const position = source.getAttribute("position");
  if (!position || position.itemSize !== 3 || position.count === 0) {
    source.dispose();
    throw new Error("The scan has no usable depth points.");
  }
  const stride = Math.max(1, Math.ceil(position.count / MAX_DISPLAY_POINTS));
  const pointCount = position.count;
  const displayedPoints = Math.ceil(position.count / stride);
  const points = new Float32Array(displayedPoints * 3);
  for (let index = 0; index < displayedPoints; index++) {
    const from = index * stride;
    const offset = index * 3;
    points[offset] = position.getX(from);
    points[offset + 1] = position.getY(from);
    points[offset + 2] = position.getZ(from);
    if (
      !Number.isFinite(points[offset]) ||
      !Number.isFinite(points[offset + 1]) ||
      !Number.isFinite(points[offset + 2])
    ) {
      source.dispose();
      throw new Error("The scan contains invalid depth points.");
    }
  }
  source.dispose();
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
  return (
    <div className="site-scan-viewer" aria-label={`3D scan ${scan.id}`}>
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
        <points geometry={view.geometry}>
          <pointsMaterial color="#67e8f9" size={0.035} sizeAttenuation />
        </points>
        <OrbitControls makeDefault enableDamping />
      </Canvas>
      <p>
        {view.displayedPoints.toLocaleString()} of{" "}
        {scan.point_count.toLocaleString()} measured points shown. Drag to
        rotate; pinch or scroll to zoom.
      </p>
    </div>
  );
}
