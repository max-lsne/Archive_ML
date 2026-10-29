import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { AssemblyPlan } from "../../../shared/plan";
import { componentMap, instanceStepIndex } from "../../../shared/plan";
import { PartMesh, type PartState } from "./PartMesh";
import { tightBounds } from "./geometry";

interface Props {
  plan: AssemblyPlan;
  stepIndex: number;
  highlighted: string[];
  hovered: string | null;
  exploded: number;
  ghostFuture: boolean;
  showLabels: boolean;
  onHover: (id: string | null) => void;
  onClick: (id: string) => void;
}

/**
 * Renders every instance of the plan in the state implied by the current step:
 * placed (added earlier), entering (added this step, animates in), future
 * (ghosted or hidden).
 */
export function Assembly({ plan, stepIndex, highlighted, hovered, exploded, ghostFuture, showLabels, onHover, onClick }: Props) {
  const components = useMemo(() => componentMap(plan), [plan]);
  const stepOf = useMemo(() => instanceStepIndex(plan), [plan]);
  const bounds = useMemo(() => {
    const full = plan.instances
      .map((i) => ({ ...i, size: components.get(i.componentId)?.size ?? [10, 10, 10] }))
      .filter((i) => !(components.get(i.componentId)?.isHardware ?? false));
    return tightBounds(full.length ? full : plan.instances.map((i) => ({ ...i, size: components.get(i.componentId)?.size ?? [10, 10, 10] })));
  }, [plan, components]);
  const center = useMemo(() => bounds.getCenter(new THREE.Vector3()), [bounds]);
  const radius = useMemo(() => bounds.getSize(new THREE.Vector3()).length() / 2, [bounds]);

  // Remember when the current step started so entering parts can animate.
  const introStartedAt = useRef(performance.now());
  const lastStep = useRef(stepIndex);
  if (lastStep.current !== stepIndex) {
    lastStep.current = stepIndex;
    introStartedAt.current = performance.now();
  }
  useEffect(() => {
    introStartedAt.current = performance.now();
  }, [plan]);

  const step = plan.steps[stepIndex];
  const insertDir = useMemo(() => {
    const v = new THREE.Vector3(...(step?.insertDirection ?? [0, 0, 0]));
    return v.lengthSq() > 1e-6 ? v.normalize() : null;
  }, [step]);

  const highlightedSet = useMemo(() => new Set(highlighted), [highlighted]);
  const anyHighlight = highlightedSet.size > 0;

  // Per-instance derived vectors, memoised on the inputs that change them.
  const derived = useMemo(() => {
    return plan.instances.map((inst) => {
      const comp = components.get(inst.componentId);
      const pos = new THREE.Vector3(...inst.position);
      const out = pos.clone().sub(center);
      out.y *= 0.6; // explode mostly sideways so tall stacks stay readable
      if (out.lengthSq() < 1e-4) out.set(0, 1, 0);
      const explodeDir = out.clone().normalize();
      const explodeDist = Math.min(radius * 0.9, out.length() * 0.9 + (comp?.isHardware ? 6 : 14));
      const dir = insertDir ?? explodeDir;
      const introDistance = Math.max(25, radius * 0.5);
      return { inst, comp, explodeDir, explodeDist, dir, introDistance };
    });
  }, [plan, components, center, radius, insertDir]);

  return (
    <group>
      {derived.map(({ inst, comp, explodeDir, explodeDist, dir, introDistance }) => {
        if (!comp) return null;
        const addedAt = stepOf.get(inst.id);
        let state: PartState;
        if (addedAt === undefined || addedAt < stepIndex) state = "placed";
        else if (addedAt === stepIndex) state = "entering";
        else state = ghostFuture && !comp.isHardware ? "future" : "hidden";
        const explodeOffset = explodeDir.clone().multiplyScalar(explodeDist * exploded);
        return (
          <PartMesh
            key={inst.id}
            instance={inst}
            component={comp}
            state={state}
            highlighted={highlightedSet.has(inst.id)}
            dimmed={anyHighlight && !highlightedSet.has(inst.id) && state !== "future"}
            hovered={hovered === inst.id}
            showLabel={showLabels && !comp.isHardware}
            explodeOffset={explodeOffset}
            introDir={dir}
            introDistance={introDistance}
            introStartedAt={introStartedAt.current}
            onHover={onHover}
            onClick={onClick}
          />
        );
      })}
    </group>
  );
}
