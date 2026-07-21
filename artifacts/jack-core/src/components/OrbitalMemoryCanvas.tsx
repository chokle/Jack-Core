import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls, Stars } from "@react-three/drei";
import * as THREE from "three";
import type { MemoryGraphHandle } from "./MemoryGraphCanvas";
import { CORE_ID, type GraphDelta, type GraphModel, type MemoryNode } from "../lib/memory-graph";

type PositionMap = Map<string, THREE.Vector3>;
type OrbitControlsHandle = React.ElementRef<typeof OrbitControls>;

interface Props {
  model: GraphModel;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onHover?: (id: string | null) => void;
  onTogglePin?: (id: string) => void;
  pinnedIds?: Set<string>;
  search: string;
  activeMatchId?: string | null;
  locked: boolean;
  delta?: GraphDelta | null;
  onZoomChange: (pct: number) => void;
  viewMode?: string;
}

interface SceneApi {
  camera: THREE.PerspectiveCamera;
  element: HTMLCanvasElement;
  controls: OrbitControlsHandle | null;
}

function hash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function nodeSize(node: MemoryNode, degree: number) {
  if (node.id === CORE_ID || node.kind === "core") return 1.35;
  if (node.kind === "topic") return 0.62 + Math.min(0.35, degree * 0.012);
  return 0.19 + Math.min(0.25, degree * 0.018);
}

function nodeColor(node: MemoryNode) {
  const [r, g, b] = node.color;
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function buildPositions(model: GraphModel): PositionMap {
  const positions: PositionMap = new Map([[CORE_ID, new THREE.Vector3(0, 0, 0)]]);
  const topicIds = new Set(model.topics.map((topic) => topic.id));
  const topicIndex = new Map(model.topics.map((topic, index) => [topic.id, index]));
  const topicCount = Math.max(1, model.topics.length);

  model.topics.forEach((topic, index) => {
    const angle = (index / topicCount) * Math.PI * 2;
    const band = index % 3;
    const radius = 5.2 + band * 1.15;
    positions.set(topic.id, new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle * 2.1) * (1.2 + band * 0.3),
      Math.sin(angle) * radius,
    ));
  });

  const membersByTopic = new Map<string, MemoryNode[]>();
  for (const node of model.nodes) {
    if (node.id === CORE_ID || topicIds.has(node.id)) continue;
    const topicId = node.topicId && topicIds.has(node.topicId) ? node.topicId : model.topics[0]?.id;
    if (!topicId) continue;
    const members = membersByTopic.get(topicId) ?? [];
    members.push(node);
    membersByTopic.set(topicId, members);
  }

  for (const [topicId, members] of membersByTopic) {
    const center = positions.get(topicId) ?? new THREE.Vector3();
    members.forEach((node, index) => {
      const seed = hash(node.id);
      const shell = 1.05 + (index % 4) * 0.32;
      const angle = seed * Math.PI * 2 + index * 2.399;
      const elevation = Math.asin(Math.max(-0.9, Math.min(0.9, (hash(`${node.id}:y`) - 0.5) * 1.8)));
      positions.set(node.id, center.clone().add(new THREE.Vector3(
        Math.cos(angle) * Math.cos(elevation) * shell,
        Math.sin(elevation) * shell,
        Math.sin(angle) * Math.cos(elevation) * shell,
      )));
    });
  }

  for (const node of model.nodes) {
    if (positions.has(node.id)) continue;
    const angle = hash(node.id) * Math.PI * 2;
    positions.set(node.id, new THREE.Vector3(Math.cos(angle) * 8, (hash(`${node.id}:y`) - 0.5) * 4, Math.sin(angle) * 8));
  }
  return positions;
}

function CameraBridge({ apiRef, controlsRef, onZoomChange }: { apiRef: React.MutableRefObject<SceneApi | null>; controlsRef: React.MutableRefObject<OrbitControlsHandle | null>; onZoomChange: (pct: number) => void }) {
  const { camera, gl } = useThree();
  useEffect(() => {
    apiRef.current = { camera: camera as THREE.PerspectiveCamera, element: gl.domElement, controls: controlsRef.current };
    const controls = controlsRef.current;
    const update = () => onZoomChange(Math.round((18 / camera.position.distanceTo(controls?.target ?? new THREE.Vector3())) * 100));
    controls?.addEventListener("change", update);
    return () => controls?.removeEventListener("change", update);
  }, [apiRef, camera, controlsRef, gl, onZoomChange]);
  return null;
}

function EdgeCloud({ model, positions }: { model: GraphModel; positions: PositionMap }) {
  const geometry = useMemo(() => {
    const points: number[] = [];
    for (const edge of model.edges) {
      const a = positions.get(edge.a);
      const b = positions.get(edge.b);
      if (!a || !b) continue;
      points.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    return g;
  }, [model.edges, positions]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <lineSegments geometry={geometry}><lineBasicMaterial color="#ff6b35" transparent opacity={0.16} blending={THREE.AdditiveBlending} /></lineSegments>;
}

function MemoryNodeMesh({ node, position, degree, selected, matched, pinned, onSelect, onHover, onTogglePin }: {
  node: MemoryNode; position: THREE.Vector3; degree: number; selected: boolean; matched: boolean; pinned: boolean;
  onSelect: () => void; onHover: (hovered: boolean) => void; onTogglePin: () => void;
}) {
  const mesh = useRef<THREE.Mesh>(null);
  const color = useMemo(() => nodeColor(node), [node]);
  const size = nodeSize(node, degree);
  useFrame(({ clock }) => {
    if (!mesh.current) return;
    const pulse = selected ? 1.12 + Math.sin(clock.elapsedTime * 4) * 0.08 : 1;
    mesh.current.scale.setScalar(pulse);
  });
  const showLabel = selected || matched || node.kind === "topic" || node.kind === "core";
  return (
    <group position={position}>
      <mesh
        ref={mesh}
        onClick={(event) => { event.stopPropagation(); onSelect(); }}
        onDoubleClick={(event) => { event.stopPropagation(); onTogglePin(); }}
        onPointerOver={(event) => { event.stopPropagation(); document.body.style.cursor = "pointer"; onHover(true); }}
        onPointerOut={() => { document.body.style.cursor = "default"; onHover(false); }}
      >
        <sphereGeometry args={[size, node.kind === "core" ? 32 : 18, node.kind === "core" ? 32 : 18]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={selected ? 2.4 : node.kind === "topic" ? 1.35 : 0.75} roughness={0.3} metalness={0.15} />
      </mesh>
      {(selected || pinned) && <mesh><ringGeometry args={[size * 1.35, size * 1.5, 40]} /><meshBasicMaterial color={selected ? "#ffffff" : "#ff6b35"} transparent opacity={0.72} side={THREE.DoubleSide} /></mesh>}
      {showLabel && (
        <Html center distanceFactor={12} style={{ pointerEvents: "none" }}>
          <span className={`whitespace-nowrap rounded-full border px-2 py-1 font-mono text-[10px] font-semibold backdrop-blur ${selected ? "border-primary/70 bg-primary/20 text-white" : "border-white/10 bg-black/55 text-white/75"}`}>{node.label}</span>
        </Html>
      )}
    </group>
  );
}

function OrbitalScene({ props, positions, apiRef }: { props: Props; positions: PositionMap; apiRef: React.MutableRefObject<SceneApi | null> }) {
  const group = useRef<THREE.Group>(null);
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const query = props.search.trim().toLowerCase();
  useFrame((_, delta) => {
    if (group.current && !props.locked) group.current.rotation.y += delta * 0.025;
  });
  return (
    <>
      <color attach="background" args={["#050711"]} />
      <fog attach="fog" args={["#050711", 18, 38]} />
      <ambientLight intensity={0.4} />
      <pointLight position={[0, 0, 0]} color="#ff6b35" intensity={18} distance={24} />
      <Stars radius={45} depth={35} count={1400} factor={2.2} saturation={0.2} fade speed={0.35} />
      <group ref={group}>
        <EdgeCloud model={props.model} positions={positions} />
        {props.model.nodes.map((node) => (
          <MemoryNodeMesh
            key={node.id}
            node={node}
            position={positions.get(node.id) ?? new THREE.Vector3()}
            degree={props.model.degree[node.id] ?? 0}
            selected={props.selectedId === node.id}
            matched={props.activeMatchId === node.id || (!!query && node.label.toLowerCase().includes(query))}
            pinned={props.pinnedIds?.has(node.id) ?? false}
            onSelect={() => props.onSelect(node.id)}
            onHover={(hovered) => props.onHover?.(hovered ? node.id : null)}
            onTogglePin={() => props.onTogglePin?.(node.id)}
          />
        ))}
      </group>
      <OrbitControls ref={controlsRef} enabled={!props.locked} enableDamping dampingFactor={0.075} minDistance={8} maxDistance={34} rotateSpeed={0.55} zoomSpeed={0.8} panSpeed={0.5} />
      <CameraBridge apiRef={apiRef} controlsRef={controlsRef} onZoomChange={props.onZoomChange} />
    </>
  );
}

export const OrbitalMemoryCanvas = forwardRef<MemoryGraphHandle, Props>(function OrbitalMemoryCanvas(props, ref) {
  const positions = useMemo(() => buildPositions(props.model), [props.model]);
  const apiRef = useRef<SceneApi | null>(null);
  const focus = (id: string, ensureOnly = false) => {
    const api = apiRef.current;
    const point = positions.get(id);
    if (!api || !point) return;
    const controls = api.controls;
    if (ensureOnly) {
      const projected = point.clone().project(api.camera);
      if (Math.abs(projected.x) < 0.62 && Math.abs(projected.y) < 0.58 && projected.z < 1) return;
    }
    controls?.target.copy(point);
    api.camera.position.copy(point.clone().add(new THREE.Vector3(0, 2.5, 7.5)));
    controls?.update();
  };
  useImperativeHandle(ref, () => ({
    zoomIn: () => { const api = apiRef.current; if (!api) return; api.camera.position.lerp(api.controls?.target ?? new THREE.Vector3(), 0.18); api.controls?.update(); },
    zoomOut: () => { const api = apiRef.current; if (!api) return; const target = api.controls?.target ?? new THREE.Vector3(); api.camera.position.copy(target.clone().add(api.camera.position.clone().sub(target).multiplyScalar(1.2))); api.controls?.update(); },
    reset: () => { const api = apiRef.current; if (!api) return; api.camera.position.set(0, 4.5, 18); api.controls?.target.set(0, 0, 0); api.controls?.update(); props.onZoomChange(100); },
    focusNode: (id) => focus(id),
    ensureVisible: (id) => focus(id, true),
    getScreenPos: (id) => {
      const api = apiRef.current;
      const point = positions.get(id);
      if (!api || !point) return null;
      const projected = point.clone().project(api.camera);
      const rect = api.element.getBoundingClientRect();
      return { x: (projected.x * 0.5 + 0.5) * rect.width, y: (-projected.y * 0.5 + 0.5) * rect.height, r: 12 };
    },
  }), [positions, props]);
  return (
    <Canvas camera={{ position: [0, 4.5, 18], fov: 48, near: 0.1, far: 100 }} dpr={[1, 1.6]} gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }} onPointerMissed={() => props.onSelect(null)}>
      <OrbitalScene props={props} positions={positions} apiRef={apiRef} />
    </Canvas>
  );
});
