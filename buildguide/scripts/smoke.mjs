/**
 * Headless smoke test: drives the built app in Chromium, screenshots the 3D
 * viewer at several steps and exercises the chat.
 *
 *   npm run build && MOCK_CLAUDE=1 npm start &   # in one terminal
 *   npm run smoke                                 # in another
 *
 * Requires `playwright` to be resolvable (npm i -D playwright && npx playwright install chromium).
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const BASE = process.env.SMOKE_BASE ?? "http://localhost:8787";
const OUT = process.env.SMOKE_OUT ?? path.resolve("scripts/out");
const LINK = process.env.SMOKE_LINK ?? ""; // optional: a real URL to push through the (mock) pipeline

let chromium;
try {
  // require() also honours NODE_PATH, so a globally installed playwright works.
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch {
  console.error("playwright is not installed. Run: npm i -D playwright && npx playwright install chromium");
  process.exit(2);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

const shot = async (name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log("  📸", file);
};

console.log("1. Home");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("text=Try a sample");
await shot("01-home");

console.log("2. Open the bookcase sample");
await page.click("text=Flat-pack bookcase");
await page.waitForSelector(".step-card", { timeout: 20000 });
await page.waitForTimeout(1800);
await shot("02-step1");

console.log("3. Step through");
const steps = await page.$$eval(".step-item", (els) => els.length);
console.log(`  ${steps} steps in the sidebar`);
for (const n of [2, 3, 6, 9]) {
  await page.click(`.step-item:nth-child(${n})`);
  await page.waitForTimeout(1500);
  await shot(`03-step${n}`);
}
const title = await page.textContent(".step-card h2");
console.log("  current step title:", title);

console.log("4. Exploded view + highlight from the parts tab");
await page.click(".step-item:last-child");
await page.waitForTimeout(1200);
await page.click(".explode .btn");
await page.waitForTimeout(1200);
await shot("04-exploded");
await page.click(".explode .btn");
await page.click(".tab >> text=Parts");
await page.click(".part-item >> nth=1");
await page.waitForTimeout(800);
await shot("05-highlight");

console.log("5. Chat (demo assistant)");
await page.fill(".chat-input textarea", "where does the back panel go?");
await page.press(".chat-input textarea", "Enter");
await page.waitForFunction(() => {
  const msgs = document.querySelectorAll(".msg.assistant");
  const last = msgs[msgs.length - 1];
  return last && !last.classList.contains("streaming") && last.textContent.length > 20;
}, null, { timeout: 20000 });
const reply = await page.$$eval(".msg.assistant", (els) => els[els.length - 1].textContent);
console.log("  reply:", reply.slice(0, 140).replace(/\s+/g, " "));
await page.waitForTimeout(800);
await shot("06-chat");

console.log("6. Dome tent sample (arc/dome/cone primitives)");
await page.goto(BASE, { waitUntil: "networkidle" });
await page.click("text=2-person dome tent");
await page.waitForSelector(".step-card", { timeout: 20000 });
await page.click(".step-item:last-child");
await page.waitForTimeout(1800);
await shot("07-tent");

if (LINK) {
  console.log(`7. Pipeline with ${LINK}`);
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.fill("input[type=url]", LINK);
  await page.click("text=Build my guide");
  await page.waitForSelector(".progress-card", { timeout: 15000 });
  await shot("08-progress");
  await page.waitForSelector(".step-card, [data-testid=pipeline-error]", { timeout: 120000 });
  const failed = await page.$("[data-testid=pipeline-error]");
  if (failed) {
    console.log("  pipeline error:", await failed.textContent());
    await shot("09-pipeline-error");
  } else {
    await page.waitForTimeout(1500);
    await shot("09-pipeline-ready");
    console.log("  pipeline produced:", await page.textContent(".topbar .title"));
  }
}

await browser.close();
const relevant = errors.filter((e) => !/favicon|Download the React DevTools|THREE\.WebGLRenderer: Context Lost|speechSynthesis/i.test(e));
if (relevant.length) {
  console.log("\nBrowser errors:");
  for (const e of relevant) console.log(" -", e);
  process.exit(1);
}
console.log("\nSmoke test passed with no browser errors.");
