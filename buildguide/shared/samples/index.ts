import type { AssemblyPlan } from "../plan.js";
import { bookcasePlan } from "./bookcase.js";
import { domeTentPlan } from "./dome-tent.js";

export interface SamplePlan {
  id: string;
  title: string;
  blurb: string;
  url: string;
  plan: AssemblyPlan;
}

export const SAMPLE_PLANS: SamplePlan[] = [
  {
    id: "sample-bookcase",
    title: "Flat-pack bookcase",
    blurb: "Cam locks, dowels, a nailed-on back panel and wall anchoring. 10 steps.",
    url: "sample://bookcase",
    plan: bookcasePlan,
  },
  {
    id: "sample-dome-tent",
    title: "2-person dome tent",
    blurb: "Crossed arc poles, inner tent, fly and guy lines. 8 steps.",
    url: "sample://dome-tent",
    plan: domeTentPlan,
  },
];

export function findSample(id: string): SamplePlan | undefined {
  return SAMPLE_PLANS.find((s) => s.id === id);
}
