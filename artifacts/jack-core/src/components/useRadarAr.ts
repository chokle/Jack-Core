import { useEffect, useRef, useState } from "react";
import { Quaternion } from "three";
import {
  arYawDegrees,
  mergeObservedPoints,
  observedDepthPoint,
  type ArPoint,
  type ArPose,
} from "../lib/radar-ar";

type Depth = { getDepthInMeters(x: number, y: number): number };
type View = {
  projectionMatrix: readonly number[];
  transform: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
};
type Frame = {
  getViewerPose(space: unknown): { views: View[] } | null;
  getDepthInformation(view: View): Depth | null;
};
type Session = {
  requestReferenceSpace(name: string): Promise<unknown>;
  updateRenderState(state: { baseLayer: unknown }): Promise<void> | void;
  requestAnimationFrame(callback: (time: number, frame: Frame) => void): void;
  addEventListener(name: string, callback: () => void): void;
  removeEventListener(name: string, callback: () => void): void;
  end(): Promise<void>;
};
type XR = { requestSession(name: string, options: object): Promise<Session> };

export type RadarArState =
  | { kind: "idle" | "starting" | "error"; message?: string }
  | {
      kind: "running" | "paused";
      points: ArPoint[];
      pose: ArPose | null;
      depthAvailable: boolean;
      heading: number | null;
    };

export function useRadarAr(overlayRoot: React.RefObject<HTMLElement | null>) {
  const [state, setState] = useState<RadarArState>({ kind: "idle" });
  const sessionRef = useRef<Session | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const generation = useRef(0);

  useEffect(
    () => () => {
      generation.current++;
      void sessionRef.current?.end().catch(() => undefined);
      sessionRef.current = null;
      canvasRef.current?.remove();
      canvasRef.current = null;
    },
    [],
  );

  async function start() {
    const generationAtStart = ++generation.current;
    const xr = (navigator as unknown as { xr?: XR }).xr;
    const Layer = (
      window as Window & {
        XRWebGLLayer?: new (
          session: Session,
          gl: WebGLRenderingContext,
        ) => { framebuffer: WebGLFramebuffer | null };
      }
    ).XRWebGLLayer;
    if (!window.isSecureContext || !xr || !Layer || !overlayRoot.current) {
      setState({
        kind: "error",
        message: "AR depth is unavailable on this device and browser.",
      });
      return;
    }
    setState({ kind: "starting" });
    let session: Session | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
      const scanCanvas = canvas;
      scanCanvas.setAttribute("aria-hidden", "true");
      scanCanvas.style.cssText =
        "position:fixed;width:1px;height:1px;pointer-events:none";
      document.body.appendChild(scanCanvas);
      const gl = scanCanvas.getContext("webgl", {
        alpha: true,
        antialias: false,
        xrCompatible: true,
      });
      if (!gl) {
        scanCanvas.remove();
        throw new Error("WebGL XR unavailable");
      }
      const activeSession = await xr.requestSession("immersive-ar", {
        requiredFeatures: ["local", "dom-overlay", "depth-sensing"],
        domOverlay: { root: overlayRoot.current },
        depthSensing: {
          usagePreference: ["cpu-optimized"],
          dataFormatPreference: ["luminance-alpha"],
        },
      });
      session = activeSession;
      if (generationAtStart !== generation.current) {
        await activeSession.end();
        return;
      }
      sessionRef.current = activeSession;
      const layer = new Layer(activeSession, gl);
      await activeSession.updateRenderState({ baseLayer: layer });
      const space = await activeSession.requestReferenceSpace("local");
      if (generationAtStart !== generation.current) {
        await activeSession.end();
        return;
      }
      setState({
        kind: "running",
        points: [],
        pose: null,
        depthAvailable: false,
        heading: null,
      });
      let points: ArPoint[] = [];
      let previousSample = 0;
      let startYaw: number | null = null;
      const ended = () => {
        scanCanvas.remove();
        if (canvasRef.current === scanCanvas) canvasRef.current = null;
        if (generationAtStart !== generation.current) return;
        sessionRef.current = null;
        setState((previous) =>
          previous.kind === "running"
            ? { ...previous, kind: "paused" }
            : { kind: "idle" },
        );
      };
      activeSession.addEventListener("end", ended);
      const tick = (time: number, frame: Frame) => {
        if (generationAtStart !== generation.current) return;
        try {
          activeSession.requestAnimationFrame(tick);
          gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          if (time - previousSample < 250) return;
          previousSample = time;
          const view = frame.getViewerPose(space)?.views[0];
          if (!view) return;
          const { position, orientation } = view.transform;
          const pose = {
            x: position.x,
            y: position.y,
            z: position.z,
            orientation: new Quaternion(
              orientation.x,
              orientation.y,
              orientation.z,
              orientation.w,
            ),
          };
          const yaw = arYawDegrees(pose.orientation);
          if (yaw !== null && startYaw === null) startYaw = yaw;
          const heading =
            yaw !== null && startYaw !== null
              ? (yaw - startYaw + 360) % 360
              : null;
          const depth = frame.getDepthInformation(view);
          const samples: ArPoint[] = [];
          if (depth) {
            for (const v of [0.3, 0.5, 0.7])
              for (const u of [0.2, 0.35, 0.5, 0.65, 0.8]) {
                const point = observedDepthPoint(
                  u,
                  v,
                  depth.getDepthInMeters(u, v),
                  view.projectionMatrix,
                  position,
                  orientation,
                  time,
                );
                if (point) samples.push(point);
              }
          }
          points = mergeObservedPoints(points, samples, time);
          setState({
            kind: "running",
            points,
            pose,
            depthAvailable: !!depth,
            heading,
          });
        } catch {
          stop();
          setState({
            kind: "error",
            message: "AR tracking stopped. Try scanning again.",
          });
        }
      };
      activeSession.requestAnimationFrame(tick);
    } catch {
      canvas?.remove();
      if (canvasRef.current === canvas) canvasRef.current = null;
      if (session) await session.end().catch(() => undefined);
      if (generationAtStart === generation.current) {
        sessionRef.current = null;
        setState({
          kind: "error",
          message:
            "AR depth could not start. Check camera permission and AR support.",
        });
      }
    }
  }

  function stop() {
    generation.current++;
    const session = sessionRef.current;
    sessionRef.current = null;
    canvasRef.current?.remove();
    canvasRef.current = null;
    setState((previous) =>
      previous.kind === "running"
        ? { ...previous, kind: "paused" }
        : { kind: "idle" },
    );
    void session?.end().catch(() => undefined);
  }

  function clear() {
    generation.current++;
    const session = sessionRef.current;
    sessionRef.current = null;
    canvasRef.current?.remove();
    canvasRef.current = null;
    setState({ kind: "idle" });
    void session?.end().catch(() => undefined);
  }

  return { state, start, stop, clear };
}
