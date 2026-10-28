import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Edges, Html } from "@react-three/drei";
import * as THREE from "three";
import type { Component, Instance, Material } from "../../../shared/plan";
import { geometryFor } from "./geometry";

export type PartState = "placed" | "entering" | "future" | "hidden";

interface Props {
  instance: Instance;
  component: Component;
  state: PartState;
  highlighted: boolean;
  dimmed: boolean;
  hovered: boolean;
  showLabel: boolean;
  /** World-space offset applied for the exploded view (already scaled by the slider). */
  explodeOffset: THREE.Vector3;
  /** Direction (unit vector) + distance the part slides in from while entering. */
  introDir: THREE.Vector3;
  introDistance: number;
  introStartedAt: number;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

const MATERIAL_PROPS: Record<Material, { roughness: number; metalness: number; opacity?: number }> = {
  wood: { roughness: 0.75, metalness: 0 },
  laminate: { roughness: 0.45, metalness: 0.02 },
  metal: { roughness: 0.35, metalness: 0.85 },
  plastic: { roughness: 0.4, metalness: 0.05 },
  fabric: { roughness: 0.95, metalness: 0, opacity: 0.88 },
  glass: { roughness: 0.1, metalness: 0.1, opacity: 0.35 },
  foam: { roughness: 0.9, metalness: 0 },
  rope: { roughness: 0.9, metalness: 0 },
  other: { roughness: 0.6, metalness: 0.05 },
};

const ACCENT = new THREE.Color("#f5a524");
const BLACK = new THREE.Color("#000000");
const DEG = Math.PI / 180;
const INTRO_MS = 950;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function PartMesh(props: Props) {
  const { instance, component, state, highlighted, dimmed, hovered, showLabel, explodeOffset, introDir, introDistance, introStartedAt, onHover, onClick } = props;
  const mesh = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const geometry = useMemo(() => geometryFor(component), [component]);
  const base = useMemo(() => new THREE.Color(component.color), [component.color]);
  const mp = MATERIAL_PROPS[component.material] ?? MATERIAL_PROPS.other;
  const finalPos = useMemo(() => new THREE.Vector3(...instance.position), [instance.position]);
  const rotation = useMemo(
    () => new THREE.Euler(instance.rotation[0] * DEG, instance.rotation[1] * DEG, instance.rotation[2] * DEG, "XYZ"),
    [instance.rotation],
  );
  const tmp = useMemo(() => new THREE.Vector3(), []);

  const isFuture = state === "future";
  const transparentBase = mp.opacity !== undefined && mp.opacity < 1;
  const targetOpacity = isFuture ? 0.12 : dimmed ? 0.3 : (mp.opacity ?? 1);
  const isBig = Math.max(...component.size) > 8;

  useFrame(({ clock }) => {
    const m = mesh.current;
    const mat = matRef.current;
    if (!m || !mat) return;
    // Position: final + explode offset, plus the slide-in while entering.
    tmp.copy(finalPos).add(explodeOffset);
    let intro = 1;
    if (state === "entering") {
      const t = Math.min(1, (performance.now() - introStartedAt) / INTRO_MS);
      intro = easeOutCubic(t);
      tmp.addScaledVector(introDir, introDistance * (1 - intro));
    }
    m.position.lerp(tmp, 0.35);
    // Opacity eases toward its target; entering parts fade in.
    const wanted = state === "entering" ? targetOpacity * (0.25 + 0.75 * intro) : targetOpacity;
    mat.opacity += (wanted - mat.opacity) * 0.25;
    mat.transparent = mat.opacity < 0.995 || transparentBase;
    mat.depthWrite = !isFuture;
    // Highlight pulse
    if (highlighted || hovered) {
      const pulse = highlighted ? 0.35 + 0.25 * Math.sin(clock.elapsedTime * 5) : 0.2;
      mat.emissive.copy(ACCENT);
      mat.emissiveIntensity += (pulse - mat.emissiveIntensity) * 0.3;
    } else if (mat.emissiveIntensity > 0.001) {
      mat.emissiveIntensity *= 0.8;
      if (mat.emissiveIntensity < 0.002) {
        mat.emissiveIntensity = 0;
        mat.emissive.copy(BLACK);
      }
    }
  });

  if (state === "hidden") return null;

  const labelText = `${component.name}${component.label ? ` (${component.label})` : ""}${instance.label ? ` · ${instance.label}` : ""}`;

  return (
    <mesh
      ref={mesh}
      geometry={geometry}
      position={finalPos}
      rotation={rotation}
      castShadow={!isFuture}
      receiveShadow={!isFuture}
      onPointerOver={(e) => {
        if (isFuture) return;
        e.stopPropagation();
        onHover(instance.id);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        if (isFuture) return;
        e.stopPropagation();
        onClick(instance.id);
      }}
    >
      <meshStandardMaterial
        ref={matRef}
        color={base}
        roughness={mp.roughness}
        metalness={mp.metalness}
        transparent={transparentBase || isFuture}
        opacity={isFuture ? 0.12 : (mp.opacity ?? 1)}
        side={component.shape === "dome" || component.material === "fabric" ? THREE.DoubleSide : THREE.FrontSide}
      />
      {!isFuture && isBig && component.shape !== "arc" && (
        <Edges threshold={20} color={highlighted ? "#ffd27a" : "#000000"} linewidth={1} />
      )}
      {(showLabel || hovered || (highlighted && isBig)) && !isFuture && (
        <Html center distanceFactor={260} zIndexRange={[10, 0]} style={{ pointerEvents: "none" }}>
          <div
            style={{
              padding: "3px 8px",
              borderRadius: 6,
              background: highlighted ? "rgba(245,165,36,0.95)" : "rgba(15,17,21,0.85)",
              color: highlighted ? "#1b1300" : "#e8ebf0",
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: "nowrap",
              border: "1px solid rgba(255,255,255,0.15)",
              transform: "translateY(-18px)",
            }}
          >
            {labelText}
          </div>
        </Html>
      )}
    </mesh>
  );
}
