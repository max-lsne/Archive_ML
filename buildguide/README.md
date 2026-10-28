# BuildGuide

**Paste a link to any piece of furniture (or a tent, a gazebo, a kit…). BuildGuide fetches the documentation, asks Claude to compute an interactive 3D assembly plan, and walks you through it step by step with voice — and you can talk back.**

<p align="center"><em>Workspace: steps on the left, the computed 3D model in the middle (parts fly in as you advance), the assistant on the right.</em></p>

## What it does

1. **Fetches the documentation behind the link.** A product page (e.g. an IKEA listing) is parsed for its assembly-instruction PDFs, product photos and text; a direct PDF link is used as-is. The PDFs are downloaded and their text extracted.
2. **Claude computes the plan.** The manual pages (mostly diagrams) are handed to **Claude Opus 5.5** as PDF documents together with the page text and photos. Using structured outputs, Claude returns one JSON `AssemblyPlan`: every component with its manual label, shape primitive, dimensions and colour; every instance placed in its final 3D pose; and the ordered steps with written instructions, a spoken script, hardware and tools, warnings, tips, a checkpoint and the manual pages they refer to.
3. **Interactive 3D walkthrough.** The browser renders the plan with Three.js: parts added in the current step slide into place, upcoming parts are ghosted, you can explode the model, orbit, highlight any part, and jump to camera presets. The step card shows instructions, hardware chips (click to highlight), warnings and a "check" line.
4. **Voice.** Each step is read aloud (Web Speech API, no extra service). Hands-free mode listens continuously: say *"next"*, *"back"*, *"repeat"*, *"go to step 7"*, *"what parts do I need?"*, *"exploded view"*, or ask any question.
5. **Discuss it.** The chat is grounded in the plan and (optionally, cached) the original manual PDF. The assistant can drive the view through tools — `go_to_step`, `highlight_parts`, `set_view`, `set_exploded` — so "where does part C go?" lights up part C.

Works without an API key in **demo mode** (two bundled samples: a flat-pack bookcase and a dome tent, with a rule-based assistant), so you can try the UI immediately.

## Quick start

```bash
cd buildguide
npm install
cp .env.example .env        # add ANTHROPIC_API_KEY=sk-ant-... to analyse real links
npm run dev                 # server on :8787, Vite client on :5173
```

Open http://localhost:5173, paste a product-page or manual-PDF link and click **Build my guide**.

Production build:

```bash
npm run build
npm start                   # serves API + built client on http://localhost:8787
```

### Modes

| Mode | How | What works |
|---|---|---|
| **Live** | `ANTHROPIC_API_KEY` set | Everything: fetch → Claude plan → 3D/voice → Claude chat |
| **Demo** | no key | Sample projects, 3D/voice, rule-based assistant |
| **Mock** | `MOCK_CLAUDE=1` | Full pipeline with a canned plan instead of a Claude call (UI development, smoke tests) |

Credentials resolve the way the Anthropic SDK does: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile.

## Configuration

All optional, see `.env.example`:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Enables live generation and chat |
| `BUILDGUIDE_MODEL` | `claude-opus-5-5` | Model for plan generation and chat |
| `BUILDGUIDE_EFFORT` | `high` | Effort for plan generation (`low`…`max`) |
| `BUILDGUIDE_CHAT_EFFORT` | `low` | Effort for chat replies |
| `BUILDGUIDE_CHAT_MANUAL` | `1` | Attach the manual PDF to chat (prompt-cached) |
| `BUILDGUIDE_DATA_DIR` | `./data` | Where plans and downloaded manuals are stored |
| `PORT` | `8787` | Server port |
| `MOCK_CLAUDE` | – | `1` = canned plans, no API calls |
| `BUILDGUIDE_ALLOW_PRIVATE_URLS` | – | `1` = allow localhost/private links (testing only) |
| `NODE_USE_ENV_PROXY` | – | `1` makes Node's fetch honour `HTTPS_PROXY` |

## How the Claude integration works

- **Plan generation** (`server/src/planner.ts`): one streamed `client.beta.messages.stream` call with `output_config.format` set from the Zod schema in `shared/plan.ts` (`betaZodOutputFormat`), `output_config.effort` (default `high`), and `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`) so a rare safety decline is re-run on Anthropic's recommended substitute model. PDFs go in as `document` blocks (vision over the diagrams), product photos as `image` blocks. The result is run through a tolerant normaliser so the renderer never sees dangling references.
- **Chat** (`server/src/chat.ts`): a streaming manual tool loop. The system prompt (stable instructions + compact plan JSON) and the manual PDF carry `cache_control` breakpoints; the current step is appended as a mid-conversation `system` message after the user turn so the cached prefix survives. UI tools are `strict` JSON-schema tools; the server validates each call, forwards it to the browser over SSE as an `action`, and returns a `tool_result`.
- **Geometry contract**: centimetres, Y up, +Z to the front, origin at the centre of the footprint on the floor; eight primitives (`box`, `cylinder`, `tube`, `sphere`, `dome`, `cone`, `wedge`, `arc`), each instance positioned by its bounding-box centre with an XYZ Euler rotation. The prompt in `server/src/prompts.ts` spells this out; `web/src/three/geometry.ts` builds the meshes.

## Project layout

```
buildguide/
├── shared/            # plan schema + normaliser, voice-command parser, project types, sample plans
├── server/src/        # Express API: fetcher, planner (Claude / mock), chat, project store, SSE
├── web/src/           # React + react-three-fiber client: viewer, steps, chat, voice
├── tests/             # vitest unit tests (schema, normaliser, voice, fetcher)
└── scripts/smoke.mjs  # headless Playwright smoke test against a running server
```

API: `POST /api/projects {url, notes}` → `{id}`; `GET /api/projects/:id/events` (SSE progress); `GET /api/projects/:id`; `POST /api/projects/:id/chat` (SSE); `POST /api/projects/sample {sampleId}`; `GET /api/projects/:id/manual/:n` (the downloaded PDF).

## Testing

```bash
npm run typecheck
npm test                                   # 35 unit tests
npm run build && MOCK_CLAUDE=1 npm start   # then, in another terminal:
npm run smoke                              # needs playwright (npm i -D playwright && npx playwright install chromium)
```

The smoke test opens both samples, steps through them, explodes the model, highlights parts, exercises the chat and saves screenshots to `scripts/out/`.

## Notes and limits

- Browser support for voice: speech synthesis works in all major browsers; speech **recognition** (hands-free mode and the mic button) needs Chrome, Edge or Safari.
- Some retailers block automated access. If a product page fails, paste a direct link to the instructions PDF.
- Plans are AI-generated from the documentation you provide; dimensions are approximate and the manufacturer's safety instructions always take precedence.
- A full plan is typically 20–80 KB of JSON; generation for a long manual can take a few minutes. Progress streams to the UI.
