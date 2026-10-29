import { Suspense, useCallback, useMemo, useRef } from "react";
import { Canvas } from "@react-three/fiber";
import { ContactShadows, Grid, OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { componentMap, type CameraHint, type Component } from "../../../shared/plan";
import { useStore } from "../store";
import { Assembly } from "./Assembly";
import { CameraRig } from "./CameraRig";
import { tightBounds } from "./geometry";

const VIEWS: { id: CameraHint; label: string }[] = [
  { id: "iso", label: "Iso" },
  { id: "front", label: "Front" },
  { id: "back", label: "Back" },
  { id: "left", label: "Left" },
  { id: "right", label: "Right" },
  { id: "top", label: "Top" },
];

export function Viewer3D() {
  const plan = useStore((s) => s.plan);
  const stepIndex = useStore((s) => s.stepIndex);
  const highlighted = useStore((s) => s.highlighted);
  const hovered = useStore((s) => s.hovered);
  const selected = useStore((s) => s.selected);
  const view = useStore((s) => s.view);
  const viewNonce = useStore((s) => s.viewNonce);
  const exploded = useStore((s) => s.exploded);
  const ghostFuture = useStore((s) => s.ghostFuture);
  const autoRotate = useStore((s) => s.autoRotate);
  const showLabels = useStore((s) => s.showLabels);
  const setHovered = useStore((s) => s.setHovered);
  const setSelected = useStore((s) => s.setSelected);
  const setHighlighted = useStore((s) => s.setHighlighted);
  const setView = useStore((s) => s.setView);
  const setExploded = useStore((s) => s.setExploded);
  const toggle = useStore((s) => s.toggle);
  const controlsRef = useRef<{ target: THREE.Vector3; update: () => void } | null>(null);
  // Stable handler (reads the latest selection from the store) so memoised parts don't re-render on every click.
  const onPartClick = useCallback(
    (id: string) => {
      const already = useStore.getState().selected === id;
      setSelected(already ? null : id);
      setHighlighted(already ? [] : [id]);
    },
    [setSelected, setHighlighted],
  );

  const components = useMemo(() => (plan ? componentMap(plan) : new Map<string, Component>()), [plan]);
  const bounds = useMemo(() => {
    if (!plan) return new THREE.Box3(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 100, 50));
    const structural = plan.instances
      .filter((i) => !(components.get(i.componentId)?.isHardware ?? false))
      .map((i) => ({ ...i, size: components.get(i.componentId)?.size ?? [10, 10, 10] }));
    return tightBounds(structural.length ? structural : plan.instances.map((i) => ({ ...i, size: components.get(i.componentId)?.size ?? [10, 10, 10] })));
  }, [plan, components]);
  const radius = useMemo(() => Math.max(30, bounds.getSize(new THREE.Vector3()).length() / 2), [bounds]);
  const focus = useMemo(() => {
    if (!plan) return null;
    const step = plan.steps[stepIndex];
    const ids = new Set(step?.focusInstanceIds?.length ? step.focusInstanceIds : step?.addInstances ?? []);
    const pts = plan.instances.filter((i) => ids.has(i.id)).map((i) => new THREE.Vector3(...i.position));
    if (!pts.length) return null;
    const c = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(pts.length);
    return c;
  }, [plan, stepIndex]);

  const tipId = hovered ?? selected;
  const tipInstance = tipId ? plan?.instances.find((i) => i.id === tipId) : undefined;
  const tipComponent = tipInstance ? components.get(tipInstance.componentId) : undefined;
  const tipStep = tipInstance ? plan?.steps.find((s) => s.addInstances.includes(tipInstance.id)) : undefined;

  if (!plan) return <div className="viewer-empty">No plan loaded</div>;

  return (
    <>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ fov: 38, near: 1, far: 20000, position: [radius * 2.2, radius * 1.6, radius * 2.6] }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        onPointerMissed={() => {
          setSelected(null);
          setHighlighted([]);
        }}
      >
        <color attach="background" args={["#11141a"]} />
        <hemisphereLight args={["#dfe8ff", "#2a2420", 0.75]} />
        <ambientLight intensity={0.25} />
        <directionalLight
          position={[radius * 1.2, radius * 2.2, radius * 1.5]}
          intensity={2.2}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0004}
          shadow-camera-left={-radius * 1.5}
          shadow-camera-right={radius * 1.5}
          shadow-camera-top={radius * 1.5}
          shadow-camera-bottom={-radius * 1.5}
          shadow-camera-near={1}
          shadow-camera-far={radius * 8}
        />
        <directionalLight position={[-radius * 1.5, radius, -radius]} intensity={0.6} />
        <Suspense fallback={null}>
          <Assembly
            plan={plan}
            stepIndex={stepIndex}
            highlighted={highlighted}
            hovered={hovered}
            exploded={exploded}
            ghostFuture={ghostFuture}
            showLabels={showLabels}
            onHover={setHovered}
            onClick={onPartClick}
          />
        </Suspense>
        <Grid
          position={[0, -0.05, 0]}
          args={[radius * 12, radius * 12]}
          cellSize={10}
          cellThickness={0.6}
          cellColor="#2a313d"
          sectionSize={50}
          sectionThickness={1}
          sectionColor="#3a4454"
          fadeDistance={radius * 7}
          fadeStrength={1.5}
          infiniteGrid
        />
        <ContactShadows position={[0, 0, 0]} opacity={0.55} scale={radius * 4} blur={2.2} far={radius} resolution={1024} color="#000000" />
        <OrbitControls
          ref={controlsRef as never}
          makeDefault
          enableDamping
          dampingFactor={0.1}
          autoRotate={autoRotate}
          autoRotateSpeed={0.8}
          maxPolarAngle={Math.PI / 2 - 0.02}
          minDistance={radius * 0.3}
          maxDistance={radius * 8}
        />
        <CameraRig bounds={bounds} focus={focus} view={view} nonce={viewNonce} controlsRef={controlsRef} />
      </Canvas>

      <div className="viewer-overlay">
        <div className="view-controls">
          <div className="group" role="group" aria-label="Camera presets">
            {VIEWS.map((v) => (
              <button key={v.id} className={`btn sm ${view === v.id ? "active" : ""}`} onClick={() => setView(v.id)} title={`View from the ${v.label.toLowerCase()}`}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="group" role="group" aria-label="Display options">
            <button className={`btn sm ${ghostFuture ? "active" : ""}`} onClick={() => toggle("ghostFuture")} title="Show parts from later steps as ghosts">
              Ghost upcoming
            </button>
            <button className={`btn sm ${showLabels ? "active" : ""}`} onClick={() => toggle("showLabels")} title="Label every part">
              Labels
            </button>
            <button className={`btn sm ${autoRotate ? "active" : ""}`} onClick={() => toggle("autoRotate")} title="Slowly orbit the model">
              Orbit
            </button>
          </div>
        </div>
        <label className="explode" title="Pull the parts apart to see how they fit">
          Exploded
          <input type="range" min={0} max={1} step={0.01} value={exploded} onChange={(e) => setExploded(Number(e.target.value))} aria-label="Exploded view amount" />
          <button className="btn sm ghost" onClick={() => setExploded(exploded > 0 ? 0 : 0.8)}>
            {exploded > 0 ? "Reset" : "Explode"}
          </button>
        </label>
        {tipInstance && tipComponent && (
          <div className="part-tip">
            <b>
              {tipComponent.name} {tipComponent.label && <span className="label-chip">{tipComponent.label}</span>}
            </b>
            <div className="dim" style={{ fontSize: 12 }}>
              {tipInstance.label ? `${tipInstance.label} · ` : ""}
              {tipComponent.size.map((n) => Math.round(n * 10) / 10).join(" × ")} cm · {tipComponent.material}
              {tipStep ? ` · added in step ${tipStep.id}` : ""}
            </div>
            {tipComponent.description && <div className="pd">{tipComponent.description}</div>}
          </div>
        )}
      </div>
    </>
  );
}
