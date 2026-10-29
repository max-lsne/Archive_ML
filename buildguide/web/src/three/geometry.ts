import * as THREE from "three";
import type { Component, Shape } from "../../../shared/plan";

const cache = new Map<string, THREE.BufferGeometry>();

/** Dispose every cached geometry; call when the plan changes so GPU memory does not grow across projects. */
export function disposeGeometryCache(): void {
  for (const g of cache.values()) g.dispose();
  cache.clear();
}

/**
 * Build (and memoise) a geometry for a component. Every geometry is centred on
 * its bounding box so that instance.position can be used directly.
 */
export function geometryFor(component: Pick<Component, "shape" | "size">): THREE.BufferGeometry {
  const [x, y, z] = component.size.map((n) => Math.max(0.05, n));
  const key = `${component.shape}:${x.toFixed(2)}:${y.toFixed(2)}:${z.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const geo = build(component.shape, x, y, z);
  geo.computeBoundingBox();
  cache.set(key, geo);
  return geo;
}

function build(shape: Shape, x: number, y: number, z: number): THREE.BufferGeometry {
  switch (shape) {
    case "box":
      return new THREE.BoxGeometry(x, y, z);
    case "cylinder": {
      const g = new THREE.CylinderGeometry(x / 2, x / 2, y, 32);
      if (Math.abs(z - x) > 1e-3) g.scale(1, 1, z / x);
      return g;
    }
    case "tube": {
      const outer = x / 2;
      const inner = Math.max(0.01, outer - Math.min(z, outer * 0.95));
      const shape2 = new THREE.Shape();
      shape2.absarc(0, 0, outer, 0, Math.PI * 2, false);
      const hole = new THREE.Path();
      hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
      shape2.holes.push(hole);
      const g = new THREE.ExtrudeGeometry(shape2, { depth: y, bevelEnabled: false, curveSegments: 32 });
      g.rotateX(-Math.PI / 2);
      g.translate(0, -y / 2, 0);
      return g;
    }
    case "sphere": {
      const g = new THREE.SphereGeometry(0.5, 32, 20);
      g.scale(x, y, z);
      return g;
    }
    case "dome": {
      const g = new THREE.SphereGeometry(1, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2);
      g.translate(0, -0.5, 0);
      g.scale(x / 2, y, z / 2);
      return g;
    }
    case "cone": {
      const g = new THREE.ConeGeometry(x / 2, y, 32);
      if (Math.abs(z - x) > 1e-3) g.scale(1, 1, z / x);
      return g;
    }
    case "wedge": {
      const tri = new THREE.Shape();
      tri.moveTo(-x / 2, -y / 2);
      tri.lineTo(x / 2, -y / 2);
      tri.lineTo(0, y / 2);
      tri.closePath();
      const g = new THREE.ExtrudeGeometry(tri, { depth: z, bevelEnabled: false });
      g.translate(0, 0, -z / 2);
      return g;
    }
    case "arc": {
      // Chord x along X, rise y along +Y, pole diameter z. Ends at y = -rise/2, apex at +rise/2.
      const chord = x;
      const rise = y;
      const tube = Math.max(0.05, z / 2);
      if (rise < 0.5) {
        const g = new THREE.CylinderGeometry(tube, tube, chord, 16);
        g.rotateZ(Math.PI / 2);
        return g;
      }
      const half = chord / 2;
      const R = (half * half + rise * rise) / (2 * rise);
      let theta = Math.asin(Math.min(1, half / R));
      if (rise > R) theta = Math.PI - theta;
      const g = new THREE.TorusGeometry(R, tube, 12, Math.max(24, Math.round(theta * 40)), 2 * theta);
      g.rotateZ(Math.PI / 2 - theta);
      g.translate(0, rise / 2 - R, 0);
      return g;
    }
    default:
      return new THREE.BoxGeometry(x, y, z);
  }
}

/** Tight world-space bounds of a set of instances (oriented boxes, not spheres). */
export function tightBounds(instances: { position: number[]; rotation: number[]; size: number[] }[]): THREE.Box3 {
  const box = new THREE.Box3();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const corner = new THREE.Vector3();
  for (const inst of instances) {
    e.set(THREE.MathUtils.degToRad(inst.rotation[0] ?? 0), THREE.MathUtils.degToRad(inst.rotation[1] ?? 0), THREE.MathUtils.degToRad(inst.rotation[2] ?? 0), "XYZ");
    q.setFromEuler(e);
    m.compose(new THREE.Vector3(inst.position[0] ?? 0, inst.position[1] ?? 0, inst.position[2] ?? 0), q, new THREE.Vector3(1, 1, 1));
    const [sx = 1, sy = 1, sz = 1] = inst.size;
    for (const dx of [-0.5, 0.5]) for (const dy of [-0.5, 0.5]) for (const dz of [-0.5, 0.5]) {
      corner.set(dx * sx, dy * sy, dz * sz).applyMatrix4(m);
      box.expandByPoint(corner);
    }
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-50, 0, -50), new THREE.Vector3(50, 100, 50));
  return box;
}
