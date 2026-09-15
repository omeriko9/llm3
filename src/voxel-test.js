// Voxel Test: load each model into one slot in turn, ask it to produce a
// standalone voxel-art scene as HTML, and keep the rendered result.
//
// The model has no tools on this path -- it is a plain chat completion -- so it
// cannot write a file itself. The prompt still names the destination path
// because that reliably pushes models to emit one complete standalone document
// instead of a fragment wrapped in commentary, but the write happens here.
//
// State lives in this module and is mirrored to disk after every transition, so
// the run survives a browser refresh and is recoverable if llm3 restarts
// mid-run. Slot loading goes through llm3's own /api/start so the run uses
// exactly the same launcher path as a manual load.
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { postSseLong } = require("./voxel-stream");

const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_OUTPUT_ROOT = path.join(repoRoot, "benchmarks", "voxel-results");
const outputRoot = process.env.LLM3_VOXEL_ROOT || DEFAULT_OUTPUT_ROOT;
// Transcripts and reasoning dumps live under the results root but out of the
// way, so the modal's glob over *.html does not pick them up.
const debugRoot = path.join(outputRoot, "_debug");

const LOCAL_PORT = Number(process.env.PORT || 7075);
const LOCAL_BASE = `http://127.0.0.1:${LOCAL_PORT}`;
// A model that is still loading answers nothing useful; give the slot time to
// come up before the first request rather than failing the model.
const SLOT_READY_TIMEOUT_MS = 240_000;
const SLOT_POLL_INTERVAL_MS = 2_000;
// Per model, not for the whole run. Kept just under the slot proxy's own 3600s
// ceiling (bin/qwen_llama), which used to fire first and return a bare 502
// after an hour -- the harness budget was 80 minutes and could never be reached.
const GENERATION_TIMEOUT_MS = 3_400_000;
// 32768 output tokens is ~90KB of HTML, far more than any of these scenes has
// needed: the whole field lands under 10k. The old 65536 was unreachable anyway
// -- at 15 tok/s it needs 70 minutes and the proxy cuts the socket at 60.
const MAX_TOKENS = 32_768;
// Thinking is worth having on a design task, but it has to terminate. Qwen3.5-4B
// completes this entire test -- reasoning and finished HTML -- in ~6000 tokens,
// so 8192 for the reasoning phase alone is generous rather than tight.
const SCENE_REASONING_BUDGET = 8_192;
// Scene runs are a benchmark, so every model has to generate under the same
// sampling. They used to inherit whatever the active profile held for the slot,
// which meant a model measured under one profile was compared against a model
// measured under another, and a re-run of the same model could differ from
// itself. These are applied over the slot's values and recorded on the result.
//
// Not temperature 0. Greedy decoding is reproducible but it walks small models
// straight into a repetition loop: Qwen3.8-9B at 0 emitted
// `OCEAN_819: '#00ffff', OCEAN_820: '#00ffff', ...` for 37 kB and never
// reached the closing tag. What a benchmark needs here is that every model
// generates under the *same* settings, not the *lowest* ones, so this is a
// normal sampling profile with a light repetition penalty. Override with
// LLM3_SCENE_TEMPERATURE if a particular fleet wants something else.
const SCENE_SAMPLING = Object.freeze({
  temperature: Number.isFinite(Number(process.env.LLM3_SCENE_TEMPERATURE))
    ? Number(process.env.LLM3_SCENE_TEMPERATURE)
    : 0.7,
  topP: 0.95,
  topK: 20,
  minP: 0,
  presencePenalty: 0,
  repetitionPenalty: 1.05,
});
// The prompt is ~60 tokens and the answer is capped at MAX_TOKENS, so a large
// context buys nothing here and costs a great deal of KV cache. Inheriting a
// slot configured at 262144 made a 4B model OOM the GPU while other slots held
// 80GB of weights. Sampling is pinned above; this sizes the resources.
// Must hold prompt + MAX_TOKENS with room to spare. For a 27B this is roughly
// 8GB of KV cache, which is fine once the other slots are stopped.
const VOXEL_CTX_SIZE = 131_072;

// Each test is one prompt run against every model in turn. They share the slot,
// so only one may run at a time, but each keeps its own results and its own
// state file so you can switch between them and still see past runs.
// Observed failure modes these requirements target, all seen in real runs:
//  - a canvas left at its intrinsic 320x180 because the container was never
//    given dimensions, so "width:100%" resolved against nothing;
//  - a scene drawn with 14 primitives and 18 colours;
//  - an InstancedMesh capped at 10000 per colour that the model's own scene
//    generator overflowed, silently dropping geometry.
// They constrain the output contract, not the artistic choices, so the test
// still measures the model rather than dictating the picture.
const OUTPUT_REQUIREMENTS =
  "\n\nRequirements for the file you produce:\n"
  + "- One self-contained HTML file that renders immediately on load, with no build step. "
  + "Do not leave placeholder or TODO comments - draw the whole scene.\n"
  + "- The artwork must fill the browser window and resize with it. Give every wrapping element "
  + "explicit dimensions so the scene actually scales up; do not leave it rendering at a small "
  + "fixed intrinsic size in the middle of the page.\n"
  + "- Use a generous internal resolution. If you cap anything - canvas resolution, instance "
  + "counts, buffer or array sizes - set the cap far above what your scene needs, so nothing is "
  + "ever silently dropped.\n"
  + "- Fill the whole frame with content. No large empty or flat regions, no tiny sparse sketch: "
  + "aim for a dense, detailed composition with many distinct elements and a wide colour palette.\n"
  + "- Do not repeat near-identical lines to pad the output; generate varied content procedurally "
  + "instead of enumerating hundreds of similar entries.\n\n"
  // Naming a path made some models believe they had file-writing tools: they
  // replied with prose describing the file and claiming to have written it,
  // emitting no HTML at all. The path is now stated as information only, and
  // the lack of tools is spelled out.
  + "You have no file-writing tools. Reply with the complete contents of the HTML file and nothing "
  + "else - no explanation before or after, no prose description of what you built. Your reply is "
  + "saved verbatim, so anything that is not HTML corrupts the file.";

// Every model that produced a small picture had hard-coded a 320-wide canvas:
// they treat "pixel art" as meaning a small buffer. Chunky pixels come from the
// block size you draw with, not from starving the canvas, so say that outright.
const PIXEL_RESOLUTION_REQUIREMENT =
  "\n\nResolution, specifically: the internal canvas must be at least 1280x720 - do NOT use a "
  + "320-wide or 640-wide buffer. Pixel-art chunkiness must come from the size of the blocks you "
  + "draw (draw each art pixel as an NxN rect of real pixels), never from shrinking the canvas. "
  + "Then upscale to fill the viewport with image-rendering: pixelated. A larger buffer is what "
  + "gives you room for the crowd, the palms, the umbrellas and the surf detail asked for above.";

// Unlike the two still-image tests, this one is judged on motion: a particle
// system, a four-phase timeline and a seamless loop. It shares OUTPUT_REQUIREMENTS
// so the output contract (one self-contained document, no prose, no tools) is
// identical across every test.
//
// The brief as supplied ended with "You MUST write the result directly into a
// file named index.html". That is the exact instruction the comment on
// OUTPUT_REQUIREMENTS warns about -- models given a path believe they have
// file-writing tools and reply with prose claiming the file is written, emitting
// no HTML. It is dropped here; the closing contract states the path is
// informational and the reply must be the document itself. The two title
// instructions are kept as given.
const ROCKET_BRIEF =
  `<instructions>
Generate a single, self-contained HTML file. No external dependencies, no separate JS files, no frameworks, no libraries. One \`.html\` file that works when opened directly in a browser.
Create a cinematic rocket launch animation set on a tropical island. The rocket must launch, leave the viewport, and after 5 seconds smoothly return to its initial position - then the cycle repeats.
</instructions>

<scene>
**Setting: Tropical Launch Island**
- A small tropical island in the lower portion of the screen: palm trees, sandy beach, green vegetation
- Ocean water surrounding the island with gentle waves
- A launch pad on the island with metal structure / scaffolding / support tower
- Sky background: gradient from warm horizon (orange/pink) to deep blue/dark sky at the top, with stars visible in the upper portion
- A few clouds scattered across the sky

The Rocket (ultra-detailed)
Tall, slender multi-stage rocket (inspired by SpaceX Falcon 9 or Saturn V proportions)
Distinct rocket stages: first stage (largest, bottom), second stage (middle), payload fairing / nose cone (top)
Surface details: panel lines, rivets/segments drawn with subtle lines, an access hatch, small painted flag or logo
Color scheme: primarily white body with black/dark gray accent stripes, a colored logo band, and the nose cone in a contrasting shade
Fins at the base of the first stage (3-4 stabilizer fins)
Engine nozzles visible at the very bottom (cluster of small circles/bells)
The rocket should be the visual centerpiece - spend time on its geometry
</scene>

<animation-sequence>
**Phase 1 - Pre-launch (0s to 1.5s)**
- Rocket sits on the pad, engines ignite
- A growing orange/yellow glow appears beneath the rocket
- Initial smoke/steam clouds billow outward from the base - thick, white/gray, expanding horizontally along the island surface
- Subtle camera shake / screen vibration effect
- Engine flames flicker with randomized intensity

Phase 2 - Liftoff (1.5s to 4s)
Rocket slowly lifts off the pad with realistic acceleration (starts very slow, gradually speeds up)
Massive exhaust plume: bright white-yellow core flame, surrounded by orange glow, transitioning to thick gray/white smoke trail
Smoke trail expands and lingers behind the rocket as it rises
The smoke at the base continues spreading across the island and over the water
As the rocket gains altitude, the flame elongates and the smoke trail stretches
Subtle particle effects: sparks, embers flying outward from the exhaust

Phase 3 - Ascent & Exit (4s to 7s)
Rocket accelerates rapidly, moving faster and faster upward
The exhaust trail thins as the rocket reaches higher altitude
Rocket becomes smaller as it gains distance (slight scale reduction)
The rocket exits the top of the viewport
The lingering smoke trail on screen slowly fades and disperses

Phase 4 - Calm & Reset (7s to 12s)
Scene is peaceful: smoke fully dissipates, island sits quietly
At the 5-second mark after exit (~12s), the rocket gently descends back into frame
It returns slowly, smoothly, almost floating - no engines firing, no drama
It softly settles back onto the launch pad in its exact original position
Brief pause, then the entire cycle restarts seamlessly
</animation-sequence>

<smoke-and-effects>
- Smoke is critical to the visual quality. Use a particle system or layered animated shapes:
- Dozens of individual smoke "puffs" that expand, fade in opacity, and drift slightly with a breeze
- Smoke color: starts white/light gray near the flame, darkens to medium gray as it cools
- Smoke expands in a mushroom-cloud-like pattern at the base during liftoff
- Each puff has slight random drift (wind effect), rotation, and independent fade timing
- Exhaust flame: layered shapes (inner bright yellow/white, outer orange, outermost faint red) with flickering animation
- Heat haze effect near the exhaust: subtle wavy distortion of the background behind the flame
- Water ripple effect on the ocean surface near the island during launch
- Stars in the upper sky should faintly twinkle
</smoke-and-effects>

<visual>
- Background: gradient sky - warm sunset tones at horizon fading to deep navy/black at top
- Ocean: dark blue with animated wave motion (simple sine-wave surface)
- Island: lush greens, sandy tan, 2-3 palm trees with gentle sway
- Canvas: fullscreen, responsive
- Animation: 60fps via requestAnimationFrame
- All rendering via HTML5 Canvas 2D context - no WebGL required
- Color palette: rich, cinematic - warm launch glow contrasting against cool sky
</visual>

<constraints>
- Output ONLY a complete HTML file - nothing else
- Everything must be drawn programmatically on a \`<canvas>\` - no images, no SVGs, no external assets
- The animation must loop seamlessly: launch -> exit -> calm return -> repeat
- The rocket must be visually impressive and detailed - not a simple triangle
- Smoke must look volumetric and organic, not like static shapes
- Performance must stay smooth at 60fps despite the particle count
- The return descent must feel gentle and peaceful - stark contrast to the violent launch
</constraints>

<thinking>
Before coding, reason through:
1. How to construct the rocket from canvas drawing primitives (rectangles, arcs, lines) with enough detail to be visually impressive
2. Particle system architecture: how to manage hundreds of smoke/ember particles efficiently (object pooling, lifecycle management)
3. The acceleration curve for realistic launch physics (slow start, exponential ramp-up)
4. How to layer the drawing order: background sky -> stars -> clouds -> smoke trail -> rocket -> exhaust flame -> foreground island -> base smoke
5. Timing system: how to manage the 4 animation phases with smooth transitions between them
6. How to make the return descent feel physically different from the launch (no exhaust, gentle easing, floating quality)
7. How to make smoke look organic: randomized spawn positions, varied sizes, Perlin-like drift, opacity curves
</thinking>

<important>
* Title of the page is your model name. For example "GPT 5" or "Opus 5"
* Title inside the page shows your model name.
</important>`;

const TESTS = {
  voxel: {
    id: "voxel",
    label: "Voxel scene (pagoda garden)",
    prompt: (targetPath) =>
      "Design and create a very creative, elaborate, and detailed voxel art scene of a pagoda in a "
      + "beautiful garden with trees, including some cherry blossoms. Make the scene impressive and "
      + "varied and use colorful voxels. Use whatever libraries to get this done. The result will be saved as "
      + targetPath + "."
      + OUTPUT_REQUIREMENTS,
  },
  pixel: {
    id: "pixel",
    label: "Pixel art (California sunset)",
    prompt: (targetPath) =>
      "Design and create a very creative, elaborate, and detailed pixel art scene: a full-image view of a "
      + "California beach promenade at sunset. Capture golden hour properly - warm oranges, pinks and "
      + "purples in the sky, the low sun near the horizon, and its light reflecting across the ocean. "
      + "Include the promenade itself with palm trees, people walking and cycling, silhouettes against the "
      + "light, beach umbrellas, and the surf rolling in. Make the scene impressive and varied, with a rich "
      + "colourful palette and a real sense of depth and layering from foreground to horizon. "
      + "Use whatever libraries to get this done. The result will be saved as "
      + targetPath + "."
      + OUTPUT_REQUIREMENTS + PIXEL_RESOLUTION_REQUIREMENT,
  },
  rocket: {
    id: "rocket",
    label: "Rocket launch (tropical island)",
    prompt: (targetPath) => ROCKET_BRIEF
      + "\n\nThe result will be saved as " + targetPath + "."
      + OUTPUT_REQUIREMENTS,
  },
};
const DEFAULT_TEST = "voxel";

function resolveTest(testId) {
  return TESTS[String(testId || "").trim()] || TESTS[DEFAULT_TEST];
}

function stateFileFor(testId) {
  return path.join(outputRoot, `run-state-${resolveTest(testId).id}.json`);
}

const sessions = Object.create(null);

function nowMs() {
  return Date.now();
}

function slugify(value) {
  return String(value || "model")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "model";
}

function stamp(ms) {
  return new Date(ms).toISOString().replace(/[:.]/g, "-").replace("Z", "");
}

async function ensureOutputRoot() {
  await fs.mkdir(outputRoot, { recursive: true });
}

function publicState(testId = DEFAULT_TEST) {
  const test = resolveTest(testId);
  const session = sessions[test.id];
  if (!session) {
    return { test: test.id, label: test.label, running: false, models: [], startedAt: null, endedAt: null, slotId: "", error: "" };
  }
  return {
    test: test.id,
    label: test.label,
    running: Boolean(session.running),
    skipped: Array.isArray(session.skipped) ? session.skipped : [],
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    slotId: session.slotId,
    thinking: typeof session.thinking === "boolean" ? session.thinking : null,
    error: session.error || "",
    cancelRequested: Boolean(session.cancelRequested),
    models: session.models.map((entry) => ({
      model: entry.model,
      modelKey: entry.modelKey,
      status: entry.status,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      elapsedMs: entry.elapsedMs,
      file: entry.file ? path.basename(entry.file) : "",
      rawFile: entry.rawFile ? path.basename(entry.rawFile) : "",
      bytes: entry.bytes || 0,
      finishReason: entry.finishReason || "",
      completionTokens: entry.completionTokens || 0,
      // Split out so "it thought for 40k tokens" and "it wrote 40k tokens of
      // HTML" stop looking the same in the UI and in the state mirror.
      reasoningTokens: entry.reasoningTokens || 0,
      answerTokens: entry.answerTokens || 0,
      streamLog: entry.streamLog ? path.basename(entry.streamLog) : "",
      recovered: Boolean(entry.recovered),
      error: entry.error || "",
    })),
  };
}

async function persist(testId) {
  try {
    await ensureOutputRoot();
    await fs.writeFile(stateFileFor(testId), JSON.stringify(publicState(testId), null, 2) + "\n", "utf8");
  } catch (_error) {
    // Best effort: losing the mirror must not abort a long run.
  }
  await foldIntoSceneIndex(testId);
}

// ---- Scene results index -------------------------------------------------
// A session only ever holds the LAST run of a test, so starting the pixel test
// again wipes the previous grid even though the pages it produced are still on
// disk. The benchmarks table needs a stable per-model cell that survives the
// next run, and it needs the thinking and non-thinking runs kept apart -- the
// same split the benchmark runner applies to the Hebrew translation, where a
// reasoning model and its no-think twin are simply not the same result.
//
// Terminal entries are folded in here after every state transition. Sessions
// stay the source of truth for what is running right now.
const sceneIndexPath = path.join(outputRoot, "results-index.json");
let sceneIndexQueue = Promise.resolve();

function sceneBucket(thinking) {
  return thinking ? "think" : "no-think";
}

function sceneEntrySnapshot(entry, thinking) {
  return {
    model: entry.model,
    modelKey: entry.modelKey,
    status: entry.status,
    thinking: Boolean(thinking),
    startedAt: entry.startedAt || null,
    endedAt: entry.endedAt || null,
    elapsedMs: entry.elapsedMs || 0,
    file: entry.file ? path.basename(entry.file) : "",
    rawFile: entry.rawFile ? path.basename(entry.rawFile) : "",
    bytes: entry.bytes || 0,
    finishReason: entry.finishReason || "",
    completionTokens: entry.completionTokens || 0,
    reasoningTokens: entry.reasoningTokens || 0,
    answerTokens: entry.answerTokens || 0,
    // What the scene was generated with, so an old row stays interpretable
    // after the defaults change.
    sampling: entry.sampling || null,
    error: entry.error || "",
    runtimeErrors: [],
  };
}

async function loadSceneIndexFile() {
  try {
    const raw = await fs.readFile(sceneIndexPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

async function writeSceneIndexFile(index) {
  await ensureOutputRoot();
  const tmp = `${sceneIndexPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(index, null, 2) + "\n", "utf8");
  await fs.rename(tmp, sceneIndexPath);
}

// Serialized: two models finishing close together would otherwise read the same
// index and the second write would drop the first one's entry.
function mutateSceneIndex(mutator) {
  sceneIndexQueue = sceneIndexQueue.then(async () => {
    const index = await loadSceneIndexFile();
    const changed = await mutator(index);
    if (changed) {
      await writeSceneIndexFile(index).catch(() => {});
    }
    return index;
  }).catch(() => {});
  return sceneIndexQueue;
}

const TERMINAL_SCENE_STATUSES = new Set(["done", "failed", "cancelled", "interrupted"]);

async function foldIntoSceneIndex(testId) {
  const test = resolveTest(testId);
  const session = sessions[test.id];
  if (!session || !Array.isArray(session.models)) {
    return;
  }
  const thinking = typeof session.thinking === "boolean" ? session.thinking : false;
  const bucket = sceneBucket(thinking);
  await mutateSceneIndex((index) => {
    let changed = false;
    const perTest = index[test.id] && typeof index[test.id] === "object" ? index[test.id] : {};
    for (const entry of session.models) {
      if (!entry || !TERMINAL_SCENE_STATUSES.has(String(entry.status))) {
        continue;
      }
      const label = String(entry.model || "");
      if (!label) {
        continue;
      }
      const perModel = perTest[label] && typeof perTest[label] === "object" ? perTest[label] : {};
      const previous = perModel[bucket];
      const next = sceneEntrySnapshot(entry, thinking);
      // A re-run of the same model in the same bucket replaces the old entry,
      // but a cancelled retry must not erase a good result from before it.
      if (previous && previous.status === "done" && next.status !== "done"
        && String(previous.file || "") !== String(next.file || "")) {
        continue;
      }
      if (previous && previous.runtimeErrors && String(previous.file || "") === String(next.file || "")) {
        next.runtimeErrors = previous.runtimeErrors;
      }
      if (JSON.stringify(previous || null) === JSON.stringify(next)) {
        continue;
      }
      perModel[bucket] = next;
      perTest[label] = perModel;
      changed = true;
    }
    if (changed) {
      index[test.id] = perTest;
    }
    return changed;
  });
}

// Results that predate the index (everything already on disk) are folded in the
// first time it is read, so the table is populated without re-running anything.
let sceneIndexBackfilled = false;

async function backfillSceneIndex() {
  if (sceneIndexBackfilled) {
    return;
  }
  sceneIndexBackfilled = true;
  for (const testId of Object.keys(TESTS)) {
    await foldIntoSceneIndex(testId);
  }
}

async function readSceneIndex() {
  await backfillSceneIndex();
  return loadSceneIndexFile();
}

// The scene pages are model-written and a fair number of them throw once they
// actually run. The preview iframes already report that back through the error
// shim; recording it here turns a transient console message into a signal the
// scene score can use.
const SCENE_ERROR_KINDS = new Set(["error", "rejection", "resource"]);

async function noteSceneRuntimeError({ file, kind, message, detail }) {
  const name = path.basename(String(file || ""));
  // The shim also posts a "poster" frame once a scene has painted, which is the
  // opposite of a failure. Only real error kinds, carrying an actual message,
  // may cost a scene its renders signal.
  if (!name || !SCENE_ERROR_KINDS.has(String(kind)) || !String(message || "").trim()) {
    return false;
  }
  let recorded = false;
  await mutateSceneIndex((index) => {
    let changed = false;
    for (const testId of Object.keys(index)) {
      const perTest = index[testId];
      if (!perTest || typeof perTest !== "object") {
        continue;
      }
      for (const label of Object.keys(perTest)) {
        for (const bucket of Object.keys(perTest[label] || {})) {
          const entry = perTest[label][bucket];
          if (!entry || String(entry.file || "") !== name) {
            continue;
          }
          const errors = Array.isArray(entry.runtimeErrors) ? entry.runtimeErrors : [];
          const text = String(message || "").slice(0, 300);
          if (errors.some((item) => item && item.message === text)) {
            continue;
          }
          errors.push({
            kind: String(kind || "error").slice(0, 32),
            message: text,
            detail: String(detail || "").slice(0, 200),
            seenAt: new Date().toISOString(),
          });
          entry.runtimeErrors = errors.slice(0, 5);
          changed = true;
          recorded = true;
        }
      }
    }
    return changed;
  });
  return recorded;
}

// Restore a previous run so a browser refresh (or an llm3 restart) still shows
// the grid. Anything left "running" was interrupted and is reported as such
// rather than pretending it is still in flight.
function restoreOne(testId) {
  try {
    const raw = fsSync.readFileSync(stateFileFor(testId), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.models)) {
      return;
    }
    sessions[testId] = {
      running: false,
      skipped: Array.isArray(parsed.skipped) ? parsed.skipped : [],
      // Restored so a reloaded run still reports which mode produced it.
      thinking: typeof parsed.thinking === "boolean" ? parsed.thinking : null,
      startedAt: parsed.startedAt || null,
      endedAt: parsed.endedAt || null,
      slotId: parsed.slotId || "",
      error: parsed.error || "",
      cancelRequested: false,
      models: parsed.models.map((entry) => ({
        ...entry,
        status: entry.status === "running" ? "interrupted" : entry.status,
        file: entry.file ? path.join(outputRoot, entry.file) : "",
        rawFile: entry.rawFile ? path.join(outputRoot, entry.rawFile) : "",
      })),
    };
  } catch (_error) {
    sessions[testId] = null;
  }
}

// A run that is killed mid-flight (llm3 restart, crash) leaves finished HTML on
// disk with no reference to it in the state, because the state is written
// before the next model starts. Re-attach those files by filename so completed
// work is not silently lost.
function reattachOrphanedFiles(testId) {
  const session = sessions[testId];
  if (!session) {
    return;
  }
  let names = [];
  try {
    names = fsSync.readdirSync(outputRoot);
  } catch (_error) {
    return;
  }
  const claimed = new Set(session.models.map((m) => (m.file ? path.basename(m.file) : "")).filter(Boolean));
  // Only files produced by THIS run may be re-attached. Without this, a rerun
  // inherits every result from previous sweeps and reports them as done at 0s.
  const runStartedAt = Number(session.startedAt || 0);
  for (const entry of session.models) {
    if (entry.file || (entry.status !== "pending" && entry.status !== "interrupted" && entry.status !== "cancelled")) {
      continue;
    }
    const prefix = `${slugify(entry.model)}-`;
    const match = names
      .filter((n) => n.startsWith(prefix) && n.endsWith(`-${testId}.html`) && !claimed.has(n))
      .filter((n) => {
        if (!runStartedAt) {
          return false;
        }
        try {
          return fsSync.statSync(path.join(outputRoot, n)).mtimeMs >= runStartedAt;
        } catch (_error) {
          return false;
        }
      })
      .sort()
      .pop();
    if (!match) {
      continue;
    }
    claimed.add(match);
    entry.file = path.join(outputRoot, match);
    entry.status = "done";
    // The run did not get to record a duration, so do not invent one.
    entry.recovered = true;
    try {
      entry.bytes = fsSync.statSync(entry.file).size;
    } catch (_error) {
      entry.bytes = 0;
    }
  }
}

function restore() {
  for (const id of Object.keys(TESTS)) {
    restoreOne(id);
    reattachOrphanedFiles(id);
  }
}

// Node's fetch is undici, whose default headersTimeout/bodyTimeout is 300s. A
// non-streaming completion sends nothing until it is finished, so any
// generation over five minutes died with a bare "fetch failed" no matter what
// AbortController deadline we set -- and it killed exactly the models that
// produce the most elaborate scenes. node:http gives us the timeout control
// that fetch does not expose, without adding undici as a dependency.
function postJsonLong(url, body, timeoutMs, onRequest) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch (_error) {
            parsed = null;
          }
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            body: parsed,
            text,
          });
        });
      },
    );
    // Idle-socket timeout: generation is one long silence, so this must be the
    // whole budget rather than a per-chunk gap.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`generation exceeded ${Math.round(timeoutMs / 1000)}s`));
    });
    request.on("error", reject);
    if (typeof onRequest === "function") {
      onRequest(request);
    }
    request.write(payload);
    request.end();
  });
}

async function postJson(url, body, timeoutMs = 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
const dashboardConfigPath = process.env.LLM3_STATE_DIR
  ? path.join(process.env.LLM3_STATE_DIR, "dashboard-config.json")
  : path.join(stateHome, "llm3", "dashboard-config.json");

// /api/start requires a positive ctxSize and parallel -- it will not fall back
// to the launcher defaults on its own. Use the slot's configured values so a
// voxel run loads each model exactly as a manual launch would, rather than
// imposing a context size of our own.
// `thinkingOverride` is what the Scene Tests modal sets. Without it a run
// silently inherited whatever the active profile had for this slot — which is
// thinking OFF here, so every reasoning-first model was generating its scene
// with its reasoning phase suppressed, and the result said more about the flag
// than about the model.
async function resolveSlotParams(slotId, thinkingOverride) {
  const applyOverride = (params) => {
    const next = typeof thinkingOverride === "boolean"
      ? { ...params, thinking: thinkingOverride }
      : { ...params };
    // Slots default to an unrestricted reasoning budget (-1), which is fine for
    // chat but not for a scene test. Observed on Qwen3.8-27B: the model spends
    // its whole budget re-deciding the canvas resolution in coherent prose
    // ("let's do 320x180... actually 400x225... hmm, keep it simple") and never
    // reaches the HTML. It is not a repetition loop -- no sampler penalty
    // catches it -- so the only reliable brake is a finite budget, after which
    // llama.cpp closes the think block and the model writes the file.
    if (next.thinking === true && (!Number.isInteger(next.reasoningBudget) || next.reasoningBudget < 0)) {
      next.reasoningBudget = SCENE_REASONING_BUDGET;
    }
    return { ...next, ...SCENE_SAMPLING };
  };
  const fallback = { ctxSize: VOXEL_CTX_SIZE, parallel: 1 };
  try {
    const raw = await fs.readFile(dashboardConfigPath, "utf8");
    const config = JSON.parse(raw);
    const profiles = Array.isArray(config.profiles) ? config.profiles : [];
    const active = profiles.find((p) => p && p.id === config.activeProfileId) || profiles[0];
    const slot = active && active.slots ? active.slots[slotId] : null;
    if (slot) {
      const configured = Number(slot.ctxSize) > 0 ? Number(slot.ctxSize) : VOXEL_CTX_SIZE;
      return applyOverride({
        ctxSize: Math.min(configured, VOXEL_CTX_SIZE),
        parallel: 1,
        thinking: Boolean(slot.thinking),
        reasoningBudget: slot.reasoningBudget ?? null,
        enableDry: Boolean(slot.enableDry),
        mtpDraftMax: slot.mtpDraftMax ?? null,
        enableTinyGrammar: Boolean(slot.enableTinyGrammar),
        enableStructuredGbnf: Boolean(slot.enableStructuredGbnf),
        temperature: slot.temperature,
        topP: slot.topP,
        topK: slot.topK,
        minP: slot.minP,
        presencePenalty: slot.presencePenalty,
        repetitionPenalty: slot.repetitionPenalty,
      });
    }
  } catch (_error) {
    // Fall through to the conservative default below.
  }
  return applyOverride(fallback);
}

// llm3 serialises slot actions and 409s while one is in flight; a stop or a
// previous start may still be settling when the next model comes round.
async function startModelInSlot(slotId, modelKey, params) {
  const deadline = nowMs() + 120_000;
  let last = null;
  while (nowMs() < deadline) {
    last = await postJson(`${LOCAL_BASE}/api/start`, { ...params, slotId, modelKey }, 300_000);
    if (last.ok) {
      return;
    }
    if (last.status !== 409) {
      break;
    }
    await sleep(3_000);
  }
  const detail = last && last.body && last.body.error ? last.body.error : (last ? `HTTP ${last.status}` : "no response");
  throw new Error(`could not load model into ${slotId}: ${detail}`);
}

async function waitForSlotReady(baseUrl) {
  const deadline = nowMs() + SLOT_READY_TIMEOUT_MS;
  while (nowMs() < deadline) {
    const models = await getJson(`${baseUrl}/v1/models`, 5_000);
    if (models && Array.isArray(models.data) && models.data.length) {
      return String(models.data[0].id || "");
    }
    await sleep(SLOT_POLL_INTERVAL_MS);
  }
  throw new Error("slot did not become ready in time");
}

// Models wrap HTML in prose or fences even when told not to. Pull out the
// document rather than failing an otherwise good generation.
function extractHtml(text) {
  const source = String(text || "");
  const fenced = source.match(/```(?:html)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : source;
  const docType = candidate.search(/<!DOCTYPE\s+html/i);
  if (docType >= 0) {
    return candidate.slice(docType).trim();
  }
  const htmlTag = candidate.search(/<html[\s>]/i);
  if (htmlTag >= 0) {
    return candidate.slice(htmlTag).trim();
  }
  return "";
}

function looksLikeScene(html) {
  // A usable result has to at least be a document with a body; a stub with no
  // script and no canvas will never render a voxel scene.
  if (!/<\/html>/i.test(html)) {
    return false;
  }
  return /<script|<canvas|<svg/i.test(html);
}

// Which other slots are holding a model, for a useful out-of-memory message.
async function describeOtherLoadedSlots(slotId) {
  try {
    const { execFile } = require("child_process");
    const out = await new Promise((resolve) => {
      execFile("/bin/ps", ["-ww", "-ax", "-o", "command="], { maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? "" : stdout));
    });
    const mine = 18036 + (Number(String(slotId).replace(/\D/g, "")) || 1) - 1;
    const others = out.split("\n")
      .filter((line) => line.includes("llama-server --model"))
      .map((line) => {
        const port = (line.match(/--port\s+(\d+)/) || [])[1];
        const model = (line.match(/\/([^/\s]+\.gguf)/) || [])[1];
        return { port: Number(port || 0), model: model || "model" };
      })
      .filter((entry) => entry.port && entry.port !== mine);
    if (!others.length) {
      return "";
    }
    return `${others.length} other slot${others.length === 1 ? "" : "s"} (${others.map((o) => o.model).join(", ")})`;
  } catch (_error) {
    return "";
  }
}

async function runOne(entry, slotId, publicBase, slotParams, test) {
  entry.status = "running";
  entry.startedAt = nowMs();
  entry.elapsedMs = 0;
  // Recorded on the row: the scene score compares models against each other,
  // so what they generated under has to travel with the result.
  entry.sampling = {
    temperature: slotParams.temperature,
    topP: slotParams.topP,
    topK: slotParams.topK,
    minP: slotParams.minP,
    presencePenalty: slotParams.presencePenalty,
    repetitionPenalty: slotParams.repetitionPenalty,
    thinking: Boolean(slotParams.thinking),
    reasoningBudget: slotParams.reasoningBudget ?? null,
  };
  await persist(test.id);

  const fileBase = `${slugify(entry.model)}-${stamp(entry.startedAt)}-${test.id}`;
  const target = path.join(outputRoot, `${fileBase}.html`);

  await startModelInSlot(slotId, entry.modelKey, slotParams);
  const modelId = await waitForSlotReady(publicBase);

  const session = sessions[test.id];

  // Live transcript. Written while the run is in flight so a stuck model can be
  // diagnosed by tailing a file, instead of waiting out the token cap to see
  // what it was doing.
  await fs.mkdir(debugRoot, { recursive: true });
  const streamLogPath = path.join(debugRoot, `${fileBase}.stream.txt`);
  const streamLog = fsSync.createWriteStream(streamLogPath, { flags: "w" });
  entry.streamLog = streamLogPath;
  let lastKind = "";
  streamLog.write(`# ${entry.model} | ${test.id} | thinking=${slotParams.thinking === true}\n`);
  streamLog.write(`# started ${new Date().toISOString()}\n\n`);

  const response = await postSseLong(
    `${publicBase}/v1/chat/completions`,
    {
      model: modelId || "voxel",
      messages: [{ role: "user", content: test.prompt(target) }],
      max_tokens: MAX_TOKENS,
    },
    GENERATION_TIMEOUT_MS,
    {
      onRequest: (request) => {
        if (session) {
          session.activeRequest = request;
          session.activeModel = entry.model;
        }
      },
      onProgress: (progress) => {
        if (progress.kind !== lastKind) {
          streamLog.write(`\n\n===== ${progress.kind.toUpperCase()} @ ${progress.total} tokens =====\n`);
          lastKind = progress.kind;
        }
        streamLog.write(progress.text);
        // Surfaced in the modal so a run that is thinking and a run that is
        // writing can be told apart without opening the log.
        entry.answerTokens = progress.answerTokens;
        entry.reasoningTokens = progress.reasoningTokens;
      },
    },
  );
  if (session) {
    session.activeRequest = null;
    session.activeModel = "";
  }
  const diag = response.stream || {};
  streamLog.write(`\n\n# finish_reason=${diag.finishReason || ""} answer=${diag.answerTokens || 0}`
    + ` reasoning=${diag.reasoningTokens || 0} elapsedMs=${diag.elapsedMs || 0}`
    + (diag.abortReason ? ` aborted=${diag.abortReason}` : "") + "\n");
  await new Promise((done) => streamLog.end(done));
  entry.answerTokens = Number(diag.answerTokens || 0);
  entry.reasoningTokens = Number(diag.reasoningTokens || 0);
  entry.firstTokenMs = Number(diag.firstTokenMs || 0);

  // A run cut short for degeneracy has a diagnosis attached; report that rather
  // than the generic "no HTML in the response" it would otherwise fall through
  // to, which says nothing about why.
  if (diag.abortReason) {
    const rawPath = path.join(outputRoot, `${fileBase}.raw.txt`);
    await fs.writeFile(rawPath, String(response.body?.choices?.[0]?.message?.content || ""), "utf8");
    if (diag.reasoning) {
      await fs.writeFile(path.join(debugRoot, `${fileBase}.reasoning.txt`), diag.reasoning, "utf8");
    }
    entry.rawFile = rawPath;
    entry.endedAt = nowMs();
    entry.elapsedMs = entry.endedAt - entry.startedAt;
    entry.status = "failed";
    entry.error = `stopped after ${entry.reasoningTokens} reasoning + ${entry.answerTokens} answer tokens: ${diag.abortReason}`;
    await persist(test.id);
    return;
  }

  entry.endedAt = nowMs();
  entry.elapsedMs = entry.endedAt - entry.startedAt;

  if (!response.ok || !response.body) {
    const detail = String(response.text || "").slice(0, 200);
    // "Compute error" is what llama.cpp returns for a Metal out-of-memory, and
    // on its own it says nothing useful. The usual cause here is other slots
    // still holding models: this test loads one model at a time and needs the
    // GPU largely to itself.
    if (/Compute error/i.test(detail)) {
      const busy = await describeOtherLoadedSlots(slotId);
      throw new Error(
        "GPU out of memory while generating"
        + (busy ? ` -- ${busy} still loaded. Stop the other slots and re-run.` : ".")
      );
    }
    throw new Error(`generation failed: ${response.status} ${detail}`);
  }
  const choice = response.body?.choices?.[0] || {};
  const content = String(choice?.message?.content || "");
  // Without this, "the model stopped early" and "it hit the token cap" looked
  // identical in the UI and had to be inferred from character counts.
  entry.finishReason = String(choice?.finish_reason || "");
  entry.completionTokens = Number(response.body?.usage?.completion_tokens || 0);
  const truncated = entry.finishReason === "length";
  const html = extractHtml(content);

  if (truncated && !/<\/html>/i.test(html)) {
    const rawPath = path.join(outputRoot, `${fileBase}.raw.txt`);
    await fs.writeFile(rawPath, content, "utf8");
    entry.rawFile = rawPath;
    entry.status = "failed";
    entry.error = `truncated at the ${MAX_TOKENS}-token cap after ${entry.completionTokens} tokens`;
    await persist(test.id);
    return;
  }

  if (!html || !looksLikeScene(html)) {
    // Keep what it actually said so a refusal or a ramble can be told apart
    // from a harness failure.
    const rawPath = path.join(outputRoot, `${fileBase}.raw.txt`);
    await fs.writeFile(rawPath, content, "utf8");
    entry.rawFile = rawPath;
    entry.status = "failed";
    entry.error = truncated
      ? `truncated at the ${MAX_TOKENS}-token cap after ${entry.completionTokens} tokens`
      : (html ? "returned HTML with no script/canvas to render" : "no HTML document in the response");
    await persist(test.id);
    return;
  }

  await fs.writeFile(target, html, "utf8");
  entry.file = target;
  entry.bytes = Buffer.byteLength(html, "utf8");
  entry.status = "done";
  entry.error = "";
  await persist(test.id);
}

async function runAll(slotId, publicBase, test, thinking) {
  const session = sessions[test.id];
  const slotParams = await resolveSlotParams(slotId, thinking);
  let anySucceeded = false;
  for (const entry of session.models) {
    if (session.cancelRequested) {
      entry.status = entry.status === "pending" ? "cancelled" : entry.status;
      continue;
    }
    try {
      await runOne(entry, slotId, publicBase, slotParams, test);
      if (entry.status === "done") {
        anySucceeded = true;
      }
    } catch (error) {
      const message = String(error && error.message ? error.message : error).slice(0, 400);
      if (entry.cancelRequested) {
        entry.cancelRequested = false;
        entry.status = "cancelled";
        entry.error = "cancelled";
        entry.endedAt = nowMs();
        entry.elapsedMs = entry.startedAt ? entry.endedAt - entry.startedAt : 0;
        await persist(test.id);
        continue;
      }
      entry.status = "failed";
      entry.error = message;
      entry.endedAt = nowMs();
      entry.elapsedMs = entry.startedAt ? entry.endedAt - entry.startedAt : 0;
      await persist(test.id);
      // A load failure before anything has succeeded is systemic (bad launch
      // params, slot busy, launcher broken) -- it will hit every model
      // identically. Stop rather than marking all of them failed in seconds,
      // which buries the one error that matters.
      if (!anySucceeded && /could not load model into/.test(message)) {
        session.error = "Aborted: the first model could not be loaded, so the rest were not attempted. " + message;
        for (const rest of session.models) {
          if (rest.status === "pending") {
            rest.status = "cancelled";
          }
        }
        break;
      }
    }
  }
  session.running = false;
  session.endedAt = nowMs();
  await persist(test.id);
}

async function startVoxelTest({ slotId, models, publicBase, skipped = [], test: testId = DEFAULT_TEST, thinking }) {
  const test = resolveTest(testId);
  // Every test drives the same slot, so only one may be in flight.
  for (const id of Object.keys(TESTS)) {
    if (sessions[id] && sessions[id].running) {
      const error = new Error(id === test.id
        ? `The ${TESTS[id].label} test is already running.`
        : `The ${TESTS[id].label} test is running - it uses the same slot. Wait for it or cancel it first.`);
      error.statusCode = 409;
      throw error;
    }
  }
  const list = Array.isArray(models) ? models.filter((m) => m && m.modelKey) : [];
  if (!list.length) {
    // Distinguish "nothing is loadable" from "everything you ticked is stale",
    // which happens when a results row outlives the weights on disk.
    const error = new Error(skipped.length
      ? `None of the selected models are loadable any more (missing weights): ${skipped.join(", ")}`
      : "No models to test.");
    error.statusCode = 400;
    throw error;
  }
  await ensureOutputRoot();
  sessions[test.id] = {
    running: true,
    startedAt: nowMs(),
    endedAt: null,
    slotId,
    error: "",
    cancelRequested: false,
    skipped,
    thinking: typeof thinking === "boolean" ? thinking : null,
    models: list.map((m) => ({
      model: String(m.label || m.modelKey),
      modelKey: String(m.modelKey),
      status: "pending",
      startedAt: null,
      endedAt: null,
      elapsedMs: 0,
      file: "",
      rawFile: "",
      bytes: 0,
      error: "",
    })),
  };
  await persist(test.id);
  // Deliberately not awaited: the HTTP response returns immediately and the
  // run continues in the background, which is what lets it survive a refresh.
  runAll(slotId, publicBase, test, thinking).catch(async (error) => {
    const session = sessions[test.id];
    session.running = false;
    session.error = String(error && error.message ? error.message : error);
    session.endedAt = nowMs();
    await persist(test.id);
  });
  return publicState(test.id);
}

// Re-run one model in place, leaving every other tile's result untouched. Also
// how a model that was never run (a fresh download) gets a single tile without
// restarting the whole serial sweep.
async function rerunModel({ slotId, model, modelKey, publicBase, test: testId = DEFAULT_TEST, thinking }) {
  const test = resolveTest(testId);
  for (const id of Object.keys(TESTS)) {
    if (sessions[id] && sessions[id].running) {
      const error = new Error(`The ${TESTS[id].label} test is running - it uses the same slot. Wait for it or cancel it first.`);
      error.statusCode = 409;
      throw error;
    }
  }
  const label = String(model || "").trim();
  const key = String(modelKey || "").trim();
  if (!label || !key) {
    const error = new Error("model and modelKey are required.");
    error.statusCode = 400;
    throw error;
  }
  await ensureOutputRoot();
  if (!sessions[test.id]) {
    sessions[test.id] = {
      running: false, startedAt: nowMs(), endedAt: null, slotId,
      error: "", cancelRequested: false, skipped: [], models: [],
    };
  }
  const session = sessions[test.id];
  session.slotId = slotId;
  session.error = "";
  session.cancelRequested = false;
  if (typeof thinking === "boolean") {
    session.thinking = thinking;
  }
  let entry = session.models.find((m) => m.model === label);
  if (!entry) {
    entry = { model: label, modelKey: key, status: "pending" };
    session.models.push(entry);
  }
  // Clear the previous outcome so a retry cannot show stale artefacts.
  Object.assign(entry, {
    modelKey: key, status: "pending", startedAt: null, endedAt: null,
    elapsedMs: 0, file: "", rawFile: "", bytes: 0, error: "", recovered: false,
  });
  session.running = true;
  session.endedAt = null;
  await persist(test.id);

  (async () => {
    try {
      const slotParams = await resolveSlotParams(slotId, thinking);
      await runOne(entry, slotId, publicBase, slotParams, test);
    } catch (error) {
      entry.status = "failed";
      entry.error = String(error && error.message ? error.message : error).slice(0, 400);
      entry.endedAt = nowMs();
      entry.elapsedMs = entry.startedAt ? entry.endedAt - entry.startedAt : 0;
    } finally {
      session.running = false;
      session.endedAt = nowMs();
      await persist(test.id);
    }
  })();

  return publicState(test.id);
}

// Cancel one model without stopping the sweep. A running model has its HTTP
// request destroyed, which makes llama.cpp drop the task immediately; a pending
// one is simply marked so runAll skips it when it gets there.
async function cancelOneModel(testId = DEFAULT_TEST, modelLabel = "") {
  const test = resolveTest(testId);
  const session = sessions[test.id];
  const label = String(modelLabel || "").trim();
  if (!session || !label) {
    const error = new Error("No such run or model.");
    error.statusCode = 400;
    throw error;
  }
  const entry = session.models.find((m) => m.model === label);
  if (!entry) {
    const error = new Error(`${label} is not part of this run.`);
    error.statusCode = 400;
    throw error;
  }
  if (entry.status === "running") {
    // Flag first so the catch in runAll reports it as cancelled, not failed.
    entry.cancelRequested = true;
    if (session.activeRequest && session.activeModel === entry.model) {
      try {
        session.activeRequest.destroy(new Error("cancelled by user"));
      } catch (_error) {
        // Already gone; the run loop will still see the flag.
      }
      session.activeRequest = null;
      session.activeModel = "";
    }
  } else if (entry.status === "pending") {
    entry.status = "cancelled";
    entry.error = "skipped before it started";
    await persist(test.id);
  } else {
    const error = new Error(`${label} is ${entry.status}; nothing to cancel.`);
    error.statusCode = 409;
    throw error;
  }
  return publicState(test.id);
}

// Cancel used to only set a flag that runAll checks between models, so it
// waited for the current generation to finish -- up to the full per-model
// budget. Abort the in-flight request too so it stops within a second.
function cancelVoxelTest(testId = DEFAULT_TEST) {
  const test = resolveTest(testId);
  const session = sessions[test.id];
  if (session && session.running) {
    session.cancelRequested = true;
    const current = session.models.find((m) => m.status === "running");
    if (current) {
      current.cancelRequested = true;
    }
    if (session.activeRequest) {
      try {
        session.activeRequest.destroy(new Error("cancelled by user"));
      } catch (_error) {
        // Already closed; the loop will still stop on the flag.
      }
      session.activeRequest = null;
      session.activeModel = "";
    }
  }
  return publicState(test.id);
}

function listTests() {
  return Object.values(TESTS).map((t) => ({
    id: t.id,
    label: t.label,
    running: Boolean(sessions[t.id] && sessions[t.id].running),
  }));
}

// Cheap enough for the main tab to poll alongside everything else.
function anyTestRunning() {
  return Object.keys(TESTS).some((id) => sessions[id] && sessions[id].running);
}

// Which models are being worked on right now, across every scene test. A scene
// started on its own -- from a row menu or an empty cell -- has no benchmark
// session behind it, so this is the only place that knows the model is busy.
function activeSceneWork() {
  const active = [];
  for (const id of Object.keys(TESTS)) {
    const session = sessions[id];
    if (!session || !session.running) {
      continue;
    }
    for (const entry of session.models || []) {
      if (entry.status === "running") {
        active.push({
          test: id,
          label: TESTS[id].label,
          model: entry.model,
          thinking: typeof session.thinking === "boolean" ? session.thinking : null,
          startedAt: entry.startedAt || session.startedAt || null,
        });
      }
    }
  }
  return active;
}

restore();

module.exports = {
  startVoxelTest,
  cancelVoxelTest,
  rerunModel,
  cancelOneModel,
  listTests,
  anyTestRunning,
  activeSceneWork,
  getVoxelState: publicState,
  readSceneIndex,
  noteSceneRuntimeError,
  sceneBucket,
  outputRoot,
  _test: { extractHtml, looksLikeScene, slugify, TESTS, sceneEntrySnapshot },
};
