import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { CameraHint } from "../../../shared/plan";

interface Props {
  /** Bounds of the whole product; framing never jumps around between steps. */
  bounds: THREE.Box3;
  /** Point the camera should favour (centre of the current step's parts). */
  focus: THREE.Vector3 | null;
  view: CameraHint | null;
  /** Any change retriggers the fly-to even when `view` is the same. */
  nonce: number;
  controlsRef: React.RefObject<{ target: THREE.Vector3; update: () => void } | null>;
}

/** Azimuth (from +Z, counter-clockwise seen from above) and polar angle, degrees. */
const PRESETS: Record<Exclude<CameraHint, "auto">, [number, number]> = {
  front: [0, 72],
  back: [180, 72],
  left: [-90, 70],
  right: [90, 70],
  top: [10, 18],
  iso: [38, 60],
  "iso-back": [218, 60],
};

export function CameraRig({ bounds, focus, view, nonce, controlsRef }: Props) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; t: number } | null>(null);
  const tmp = useMemo(() => ({ pos: new THREE.Vector3(), target: new THREE.Vector3() }), []);

  const center = useMemo(() => bounds.getCenter(new THREE.Vector3()), [bounds]);
  const radius = useMemo(() => Math.max(20, bounds.getSize(new THREE.Vector3()).length() / 2), [bounds]);

  useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const fitH = radius / Math.sin(fov / 2);
    const fitW = radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect));
    // Extra room: the step card covers the bottom ~35% of the viewport and the
    // view controls the top-left, so frame generously and keep the model high.
    const distance = Math.max(fitH, fitW) * 1.55;

    const target = center.clone();
    if (focus) target.lerp(focus, 0.35);
    target.y -= radius * 0.38;

    let az: number;
    let pol: number;
    if (view && view !== "auto") {
      [az, pol] = PRESETS[view];
    } else {
      // Keep the current angle, just re-frame.
      const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controlsRef.current?.target ?? center));
      az = THREE.MathUtils.radToDeg(sph.theta);
      pol = THREE.MathUtils.radToDeg(sph.phi);
    }
    const sph = new THREE.Spherical(distance, THREE.MathUtils.degToRad(pol), THREE.MathUtils.degToRad(az));
    const pos = new THREE.Vector3().setFromSpherical(sph).add(target);
    goal.current = { pos, target, t: 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, nonce, bounds, focus?.x, focus?.y, focus?.z, size.width, size.height]);

  useFrame((_, dt) => {
    const g = goal.current;
    const controls = controlsRef.current;
    if (!g || !controls) return;
    g.t = Math.min(1, g.t + dt / 1.1);
    const k = 1 - Math.pow(1 - g.t, 3);
    const lerp = Math.min(1, 0.08 + k * 0.12);
    tmp.pos.copy(camera.position).lerp(g.pos, lerp);
    tmp.target.copy(controls.target).lerp(g.target, lerp);
    camera.position.copy(tmp.pos);
    controls.target.copy(tmp.target);
    controls.update();
    // Time-based completion: with autoRotate on, the camera never settles exactly on the goal.
    if (g.t >= 1) goal.current = null;
  });

  return null;
}
