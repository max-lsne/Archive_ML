import type { AssemblyPlan } from "../plan.js";

/**
 * Hand-written sample: a classic 80 × 202 × 28 cm flat-pack bookcase.
 * Used for demo mode and for the mock planner.
 */
const LAM = "#ebe3d6";

const shelfPins: AssemblyPlan["instances"] = [];
const shelfYs = [40, 70, 135, 168];
for (const [i, y] of shelfYs.entries()) {
  for (const x of [-38.6, 38.6]) {
    for (const z of [-9, 9]) {
      shelfPins.push({
        id: `shelf_pin_${i + 1}_${x < 0 ? "l" : "r"}_${z < 0 ? "b" : "f"}`,
        componentId: "shelf_pin",
        position: [x, y - 1.1, z],
        rotation: [0, 0, 90],
        label: "",
      });
    }
  }
}

const camBolts: AssemblyPlan["instances"] = [];
const camLocks: AssemblyPlan["instances"] = [];
for (const [j, y] of [7, 101].entries()) {
  for (const x of [-37.4, 37.4]) {
    for (const z of [-8, 8]) {
      const suffix = `${j === 0 ? "bottom" : "mid"}_${x < 0 ? "l" : "r"}_${z < 0 ? "b" : "f"}`;
      camBolts.push({
        id: `cam_bolt_${suffix}`,
        componentId: "cam_bolt",
        position: [x, y, z],
        rotation: [0, 0, 90],
        label: "",
      });
      camLocks.push({
        id: `cam_lock_${suffix}`,
        componentId: "cam_lock",
        position: [x < 0 ? -34 : 34, y, z],
        rotation: [0, 0, 0],
        label: "",
      });
    }
  }
}

export const bookcasePlan: AssemblyPlan = {
  product: {
    name: "Nordic 5-shelf bookcase",
    brand: "Sample",
    category: "bookcase",
    summary:
      "A tall flat-pack bookcase with two fixed and four adjustable shelves. Assembly is mostly cam-lock joints plus a nailed-on back panel, and finishes with anchoring the unit to the wall.",
    difficulty: "easy",
    estimatedMinutes: 45,
    peopleNeeded: 2,
    assembledSize: [80, 202, 28],
  },
  sourceQuality: "generic",
  sourceNotes:
    "Built-in sample plan. Dimensions and hardware follow a typical 80 cm flat-pack bookcase; your product may differ.",
  beforeYouStart: [
    "Clear a floor area of about 2 × 2.5 m and lay down the cardboard packaging to protect the panels.",
    "Count every part against the list before you start.",
    "Keep hardware sorted in small bowls or the compartments of the packaging.",
    "Have a second person ready for standing the bookcase upright.",
  ],
  safety: [
    "This bookcase must be anchored to the wall with the supplied bracket to prevent tipping.",
    "Lift with a partner when standing the assembled frame up; it is tall and top-heavy before shelves are loaded.",
  ],
  tools: [
    { name: "Phillips screwdriver", required: true, note: "For cam locks and the wall bracket" },
    { name: "Hammer", required: true, note: "For the back-panel nails" },
    { name: "Tape measure", required: false, note: "To check the frame is square" },
    { name: "Pencil", required: false, note: "To mark the wall bracket position" },
  ],
  components: [
    { id: "side_panel", label: "A", name: "Side panel", description: "Tall panel with rows of small holes on the inside face. The holes face inward.", qty: 2, shape: "box", size: [2, 202, 28], color: LAM, material: "laminate", isHardware: false },
    { id: "top_panel", label: "B", name: "Top panel", description: "Panel with two dowel holes on each end; finished edge faces the front.", qty: 1, shape: "box", size: [76, 2, 28], color: LAM, material: "laminate", isHardware: false },
    { id: "bottom_panel", label: "C", name: "Bottom panel", description: "Panel with four cam-lock holes on the underside.", qty: 1, shape: "box", size: [76, 2, 28], color: LAM, material: "laminate", isHardware: false },
    { id: "fixed_shelf", label: "D", name: "Fixed middle shelf", description: "Slightly shallower than the bottom panel, with cam-lock holes on the underside.", qty: 1, shape: "box", size: [76, 2, 26], color: LAM, material: "laminate", isHardware: false },
    { id: "adjustable_shelf", label: "E", name: "Adjustable shelf", description: "Thinner shelf that rests on four shelf pins.", qty: 4, shape: "box", size: [76, 1.6, 26], color: LAM, material: "laminate", isHardware: false },
    { id: "plinth", label: "F", name: "Front plinth rail", description: "Short rail that sits under the front edge of the bottom panel.", qty: 1, shape: "box", size: [76, 6, 2], color: LAM, material: "laminate", isHardware: false },
    { id: "back_panel", label: "G", name: "Back panel", description: "Thin hardboard sheet; the white finished side faces into the bookcase.", qty: 1, shape: "box", size: [78, 196, 0.3], color: "#f4efe6", material: "laminate", isHardware: false },
    { id: "cam_bolt", label: "101345", name: "Cam bolt", description: "Metal pin with a threaded end that screws into the side panels.", qty: 8, shape: "cylinder", size: [0.7, 3.4, 0.7], color: "#b8bec7", material: "metal", isHardware: true },
    { id: "cam_lock", label: "100383", name: "Cam lock", description: "Round metal fitting with an arrow; the arrow points toward the bolt before turning.", qty: 8, shape: "cylinder", size: [1.5, 1.2, 1.5], color: "#9aa3ad", material: "metal", isHardware: true },
    { id: "wood_dowel", label: "101350", name: "Wooden dowel", description: "Fluted wooden peg.", qty: 4, shape: "cylinder", size: [0.8, 3, 0.8], color: "#c9a66b", material: "wood", isHardware: true },
    { id: "shelf_pin", label: "101532", name: "Shelf pin", description: "Small metal pin with a flat lip that supports the adjustable shelves.", qty: 16, shape: "cylinder", size: [0.5, 1.6, 0.5], color: "#b8bec7", material: "metal", isHardware: true },
    { id: "back_nail", label: "101354", name: "Back-panel nail", description: "Small nail, 1.5 cm long.", qty: 30, shape: "cylinder", size: [0.15, 1.5, 0.15], color: "#8a9099", material: "metal", isHardware: true },
    { id: "wall_bracket", label: "118331", name: "Wall anchoring bracket", description: "Steel bracket with two screws and a strap.", qty: 1, shape: "box", size: [4, 2, 1], color: "#8a9099", material: "metal", isHardware: true },
  ],
  instances: [
    { id: "side_left", componentId: "side_panel", position: [-39, 101, 0], rotation: [0, 0, 0], label: "left side" },
    { id: "side_right", componentId: "side_panel", position: [39, 101, 0], rotation: [0, 0, 0], label: "right side" },
    ...camBolts,
    { id: "bottom", componentId: "bottom_panel", position: [0, 7, 0], rotation: [0, 0, 0], label: "bottom" },
    { id: "fixed_mid", componentId: "fixed_shelf", position: [0, 101, 1], rotation: [0, 0, 0], label: "fixed middle shelf" },
    ...camLocks,
    { id: "plinth_front", componentId: "plinth", position: [0, 3, 13], rotation: [0, 0, 0], label: "front plinth" },
    { id: "dowel_l_b", componentId: "wood_dowel", position: [-39, 202, -8], rotation: [0, 0, 0], label: "" },
    { id: "dowel_l_f", componentId: "wood_dowel", position: [-39, 202, 8], rotation: [0, 0, 0], label: "" },
    { id: "dowel_r_b", componentId: "wood_dowel", position: [39, 202, -8], rotation: [0, 0, 0], label: "" },
    { id: "dowel_r_f", componentId: "wood_dowel", position: [39, 202, 8], rotation: [0, 0, 0], label: "" },
    { id: "top", componentId: "top_panel", position: [0, 201, 0], rotation: [0, 0, 0], label: "top" },
    { id: "back", componentId: "back_panel", position: [0, 104, -13.85], rotation: [0, 0, 0], label: "back panel" },
    ...shelfPins,
    { id: "shelf_1", componentId: "adjustable_shelf", position: [0, 40, 1], rotation: [0, 0, 0], label: "lower shelf 1" },
    { id: "shelf_2", componentId: "adjustable_shelf", position: [0, 70, 1], rotation: [0, 0, 0], label: "lower shelf 2" },
    { id: "shelf_3", componentId: "adjustable_shelf", position: [0, 135, 1], rotation: [0, 0, 0], label: "upper shelf 1" },
    { id: "shelf_4", componentId: "adjustable_shelf", position: [0, 168, 1], rotation: [0, 0, 0], label: "upper shelf 2" },
  ],
  steps: [
    {
      id: 1,
      title: "Check the parts and clear a workspace",
      instruction:
        "Unpack everything and lay the panels flat on the cardboard. Check the two side panels (A), top (B), bottom (C), fixed shelf (D), four adjustable shelves (E), plinth rail (F) and back panel (G) against the list, then sort the hardware.",
      voiceScript:
        "Let's start by unpacking. Lay the panels flat on the cardboard and check you have two side panels, a top, a bottom, the fixed middle shelf, four adjustable shelves, the plinth rail and the thin back panel. Sort the hardware into little piles. Tell me when you're ready for the next step.",
      addInstances: [],
      focusInstanceIds: [],
      hardware: [],
      tools: [],
      insertDirection: [0, 0, 0],
      cameraHint: "iso",
      tips: ["Keep the laminate panels on cardboard so the edges don't get scuffed on the floor."],
      warnings: [],
      checkpoint: "Every part on the list is present and undamaged.",
      manualPages: [],
      durationMinutes: 5,
    },
    {
      id: 2,
      title: "Screw the cam bolts into the side panels",
      instruction:
        "Lay both side panels (A) with the rows of small holes facing up. Screw a cam bolt (101345) into each of the four larger holes on each panel: two near the bottom, two at the middle. Tighten by hand until the shoulder sits flush.",
      voiceScript:
        "Lay both side panels down with the rows of small holes facing up. Screw a cam bolt into each of the four larger holes on each panel, two near the bottom and two in the middle. Hand-tight is enough, just until the shoulder sits flush.",
      addInstances: ["side_left", "side_right", ...camBolts.map((b) => b.id)],
      focusInstanceIds: ["side_left", "side_right"],
      hardware: [{ componentId: "cam_bolt", qty: 8 }],
      tools: ["Phillips screwdriver"],
      insertDirection: [0, 1, 0],
      cameraHint: "iso",
      tips: ["The side panels are identical; the finished edge goes to the front."],
      warnings: ["Do not over-tighten the cam bolts or the laminate will crack."],
      checkpoint: "Eight cam bolts stand straight out, four per side panel.",
      manualPages: [],
      durationMinutes: 5,
    },
    {
      id: 3,
      title: "Fit the bottom panel, fixed shelf and plinth",
      instruction:
        "Push a cam lock (100383) into each hole on the underside of the bottom panel (C) and the fixed shelf (D), arrows pointing toward the panel edge. With the left side panel lying flat, slide the bottom panel and fixed shelf onto its cam bolts and turn each cam clockwise to lock. Hook the plinth rail (F) under the front edge of the bottom panel, then lower the right side panel onto the other ends and lock those cams too.",
      voiceScript:
        "Press a cam lock into each hole on the underside of the bottom panel and the fixed shelf, with the arrows pointing toward the edge. Lay the left side panel flat, slide the bottom panel and the fixed shelf onto its bolts, and turn each cam clockwise to lock. Hook the plinth rail under the front of the bottom panel, then lower the right side panel on and lock its cams as well.",
      addInstances: ["bottom", "fixed_mid", ...camLocks.map((c) => c.id), "plinth_front"],
      focusInstanceIds: ["bottom", "fixed_mid", "plinth_front"],
      hardware: [{ componentId: "cam_lock", qty: 8 }],
      tools: ["Phillips screwdriver"],
      insertDirection: [1, 0, 0],
      cameraHint: "iso",
      tips: ["The fixed shelf is 2 cm shallower than the bottom panel: its back edge leaves room for the back panel."],
      warnings: ["Make sure the cam-lock holes face down on both panels before locking them."],
      checkpoint: "The frame is a rigid H shape: two sides joined by the bottom and the middle shelf.",
      manualPages: [],
      durationMinutes: 10,
    },
    {
      id: 4,
      title: "Insert the dowels into the side panels",
      instruction: "Tap a wooden dowel (101350) into each of the two holes on the top end of both side panels. Half of each dowel should remain exposed.",
      voiceScript: "Tap a wooden dowel into each of the two holes at the top end of both side panels. About half of each dowel should stay sticking out.",
      addInstances: ["dowel_l_b", "dowel_l_f", "dowel_r_b", "dowel_r_f"],
      focusInstanceIds: ["dowel_l_b", "dowel_l_f", "dowel_r_b", "dowel_r_f"],
      hardware: [{ componentId: "wood_dowel", qty: 4 }],
      tools: [],
      insertDirection: [0, 1, 0],
      cameraHint: "top",
      tips: ["If a dowel is tight, tap it with the palm of your hand rather than the hammer."],
      warnings: [],
      checkpoint: "Four dowels stick up about 1.5 cm.",
      manualPages: [],
      durationMinutes: 2,
    },
    {
      id: 5,
      title: "Fit the top panel",
      instruction: "Line the top panel (B) up so its dowel holes sit over the four dowels, finished edge to the front, and press it down firmly until it sits flush on both side panels.",
      voiceScript: "Now line up the top panel so its holes sit over the four dowels, with the finished edge facing the front, and press it down firmly until it's flush on both sides.",
      addInstances: ["top"],
      focusInstanceIds: ["top", "dowel_l_f", "dowel_r_f"],
      hardware: [],
      tools: [],
      insertDirection: [0, 1, 0],
      cameraHint: "iso",
      tips: ["Push down near each corner in turn rather than in the middle."],
      warnings: [],
      checkpoint: "No gap is visible between the top panel and the side panels.",
      manualPages: [],
      durationMinutes: 3,
    },
    {
      id: 6,
      title: "Square the frame and nail on the back panel",
      instruction:
        "With the frame face down, lay the back panel (G) over the back, white side facing in. Measure both diagonals of the frame and nudge it until they match, then nail the back panel every 15 cm around the edge and along the fixed shelf using the small nails (101354).",
      voiceScript:
        "Turn the frame face down and lay the back panel over it, white side facing in. Measure both diagonals and nudge the frame until they're equal, then nail the back panel on every fifteen centimetres around the edge and along the middle shelf.",
      addInstances: ["back"],
      focusInstanceIds: ["back"],
      hardware: [{ componentId: "back_nail", qty: 30 }],
      tools: ["Hammer", "Tape measure"],
      insertDirection: [0, 0, -1],
      cameraHint: "iso-back",
      tips: ["Start with one nail in each corner so the panel can't drift while you add the rest."],
      warnings: ["Nail into the centre of the panel edges; nails too close to the edge will split the laminate."],
      checkpoint: "Both diagonals measure the same and the back panel is flat with no bulge.",
      manualPages: [],
      durationMinutes: 10,
    },
    {
      id: 7,
      title: "Stand the bookcase upright",
      instruction: "With a second person, lift the bookcase upright and move it to its final position against the wall. Lift from the sides, not from the top panel.",
      voiceScript: "Time for a second pair of hands. Together, lift the bookcase upright and walk it to its final spot against the wall. Hold the sides, not the top.",
      addInstances: [],
      focusInstanceIds: ["side_left", "side_right"],
      hardware: [],
      tools: [],
      insertDirection: [0, 0, 0],
      cameraHint: "front",
      tips: [],
      warnings: ["Two-person lift. The frame is tall and can twist if lifted alone."],
      checkpoint: "The bookcase stands plumb against the wall.",
      manualPages: [],
      durationMinutes: 3,
    },
    {
      id: 8,
      title: "Insert the shelf pins",
      instruction: "Choose the heights for the four adjustable shelves and push a shelf pin (101532) into the matching hole on each side, front and back: four pins per shelf, sixteen in total.",
      voiceScript: "Choose where you want the four adjustable shelves and push a shelf pin into the matching hole on each side, front and back. That's four pins per shelf, sixteen in all.",
      addInstances: shelfPins.map((p) => p.id),
      focusInstanceIds: shelfPins.slice(0, 4).map((p) => p.id),
      hardware: [{ componentId: "shelf_pin", qty: 16 }],
      tools: [],
      insertDirection: [0, 0, 1],
      cameraHint: "front",
      tips: ["Count holes from the bottom on both sides so each shelf is level."],
      warnings: [],
      checkpoint: "Each set of four pins is at the same hole count on the left and right.",
      manualPages: [],
      durationMinutes: 3,
    },
    {
      id: 9,
      title: "Place the adjustable shelves",
      instruction: "Tilt each adjustable shelf (E) into the bookcase and lower it onto its four pins, finished edge facing the front.",
      voiceScript: "Tilt each adjustable shelf into the bookcase and lower it onto its four pins, finished edge to the front.",
      addInstances: ["shelf_1", "shelf_2", "shelf_3", "shelf_4"],
      focusInstanceIds: ["shelf_1", "shelf_2", "shelf_3", "shelf_4"],
      hardware: [],
      tools: [],
      insertDirection: [0, 0, 1],
      cameraHint: "front",
      tips: [],
      warnings: [],
      checkpoint: "All four shelves sit flat and do not rock.",
      manualPages: [],
      durationMinutes: 2,
    },
    {
      id: 10,
      title: "Anchor the bookcase to the wall",
      instruction:
        "Screw the wall bracket (118331) to the top panel near the back edge, then fix the other end to the wall with a fastener suitable for your wall type. Slide the bookcase back so the strap is taut.",
      voiceScript:
        "Last step, and the most important one for safety. Screw the wall bracket to the top panel near the back edge, then fix the other end to the wall with a fastener that suits your wall. Slide the bookcase back until the strap is snug.",
      addInstances: [],
      focusInstanceIds: ["top", "back"],
      hardware: [{ componentId: "wall_bracket", qty: 1 }],
      tools: ["Phillips screwdriver", "Pencil"],
      insertDirection: [0, 0, 0],
      cameraHint: "iso-back",
      tips: ["Wall plugs and screws for the wall are usually not included; pick them for plasterboard, brick or concrete."],
      warnings: ["Unanchored tall furniture can tip over. Do not skip this step, especially around children."],
      checkpoint: "Pushing the top of the bookcase forward produces no movement.",
      manualPages: [],
      durationMinutes: 5,
    },
  ],
};
