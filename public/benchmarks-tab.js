// Benchmarks tab.
//
// This used to be a standalone app bolted into a custom element: it mounted a
// shadow root, restyled itself green inside a purple dashboard, drew its own
// topbar inside llm3's topbar, and stacked nine cards with the results table
// fifth. It also read SUMMARY.md and parsed the markdown tables back into
// objects, which meant every number arrived as a string and the per-task detail
// behind a score was lost on the way out.
//
// Now: light DOM on llm3's own stylesheet, one structured feed
// (/api/perf-dashboard/results), results first, everything else folded into
// details sections underneath.
const BENCHMARKS_TEMPLATE = String.raw`
<div class="bm-tab">
  <div class="bm-toolbar">
    <label class="bm-slot-picker" for="bmSlotSelect">
      <span>Slot</span>
      <select id="bmSlotSelect">
        <option value="slot1">LLM 1</option>
        <option value="slot2">LLM 2</option>
        <option value="slot3" selected>LLM 3</option>
        <option value="slot4">LLM 4</option>
      </select>
    </label>
    <span class="bm-slot-model" id="bmSlotModel" title="Model currently answering on this slot"></span>
    <button id="bmRunBtn" class="btn btn-primary" type="button">Run benchmark</button>
    <button id="bmCancelBtn" class="btn btn-danger hidden" type="button">Cancel run</button>
    <input id="bmSearch" class="bm-search" type="search" placeholder="Filter models…" spellcheck="false" />
    <div class="bm-toolbar-right">
      <span class="bm-counts" id="bmCounts"></span>
      <button id="bmRefreshBtn" class="btn btn-icon" type="button" title="Refresh" aria-label="Refresh">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
      </button>
      <div class="bm-menu-wrap">
        <button id="bmMenuBtn" class="btn btn-icon" type="button" aria-haspopup="true" aria-expanded="false" title="More" aria-label="More actions">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>
        </button>
        <div class="bm-menu hidden" id="bmMenu" role="menu">
          <button type="button" role="menuitem" data-bm-menu="options">Table options…</button>
          <button type="button" role="menuitem" data-bm-menu="import">Load results JSON…</button>
          <button type="button" role="menuitem" data-bm-menu="export">Save results JSON</button>
          <button type="button" role="menuitem" data-bm-menu="summary">Open SUMMARY.md</button>
          <button type="button" role="menuitem" data-bm-menu="clear" class="is-danger">Clear all results</button>
        </div>
      </div>
      <input id="bmImportInput" class="hidden" type="file" accept=".json,application/json" />
    </div>
  </div>

  <div class="bm-filter-chips" id="bmFilterChips"></div>

  <div class="bm-imported-banner hidden" id="bmImportedBanner">
    <span id="bmImportedLabel"></span>
    <button type="button" class="btn btn-sm btn-secondary" id="bmImportedExitBtn">Back to live results</button>
  </div>

  <div class="bm-run-strip" id="bmRunStrip">
    <div class="bm-run-head">
      <span class="bm-run-dot" id="bmRunDot"></span>
      <span class="bm-run-title" id="bmRunTitle">Idle</span>
      <span class="bm-run-meta" id="bmRunMeta"></span>
      <button type="button" class="bm-run-toggle" id="bmRunToggle" aria-expanded="false">log</button>
    </div>
    <div class="bm-run-track hidden" id="bmRunTrack"><span class="bm-run-fill" id="bmRunFill"></span></div>
    <pre class="bm-run-log hidden" id="bmRunLog"></pre>
  </div>

  <div class="bm-panel-tabs" id="bmPanelTabs" role="tablist"></div>

  <div class="bm-panel" id="bmPanelResults">
    <div class="table-shell bm-table-shell">
      <div class="table-scroll" id="bmTableScroll">
        <table class="data-table bm-table" id="bmTable"></table>
      </div>
    </div>
  </div>

  <div class="bm-panel table-shell bm-detail-panel hidden" id="bmPanelDetail"></div>
</div>

<div class="bm-tooltip hidden" id="bmTooltip" role="tooltip"></div>

<div class="bm-row-menu hidden" id="bmRowMenu" role="menu"></div>

<div class="modal-shell hidden" id="bmLaunchModal">
  <div class="modal-backdrop" data-bm-close="launch"></div>
  <div class="modal-dialog bm-launch-dialog" role="dialog" aria-modal="true" aria-labelledby="bmLaunchTitle">
    <div class="modal-header">
      <div class="modal-header-main">
        <h3 id="bmLaunchTitle">Run benchmark</h3>
        <p class="modal-subtitle" id="bmLaunchSubtitle">Pick what to measure and which models to measure it on.</p>
      </div>
      <button class="btn btn-icon" type="button" id="bmLaunchCloseBtn" aria-label="Close">×</button>
    </div>
    <div class="modal-body bm-launch-body">
      <section class="bm-launch-section">
        <h4>What to run</h4>
        <div id="bmBenchmarkOptions"></div>
        <div class="bm-launch-row">
          <div class="bm-field">
            <span>Thinking</span>
            <div class="bm-view-toggle bm-variant-toggle" role="group" aria-label="Which thinking variants to run">
              <button type="button" class="bm-view-btn active" data-bm-variant-mode="both" title="Run each model twice and compare">Both</button>
              <button type="button" class="bm-view-btn" data-bm-variant-mode="no-think" title="Only the no-think variant — half the rows, and the fast one">No-think only</button>
              <button type="button" class="bm-view-btn" data-bm-variant-mode="think" title="Only the thinking variant">Think only</button>
            </div>
            <input type="hidden" id="bmVariantSelect" value="both" />
          </div>
          <label class="bm-field">
            <span>Questions per metric</span>
            <span class="bm-limit-row">
              <input id="bmQualityLimit" type="number" min="5" max="500" step="5" value="200" />
              <span class="bm-limit-presets">
                <button type="button" data-bm-limit="20">20</button>
                <button type="button" data-bm-limit="60">60</button>
                <button type="button" data-bm-limit="200">200</button>
                <button type="button" data-bm-limit="500">500</button>
              </span>
            </span>
          </label>
          <p class="bm-field-note" id="bmSampleNote"></p>
        </div>
      </section>

      <section class="bm-launch-section">
        <div class="bm-launch-section-head">
          <h4>Models</h4>
          <div class="bm-model-actions">
            <input id="bmModelSearch" class="bm-search" type="search" placeholder="Search models…" spellcheck="false" />
            <button type="button" class="btn btn-sm btn-secondary" data-bm-models="all">All</button>
            <button type="button" class="btn btn-sm btn-secondary" data-bm-models="none">None</button>
            <button type="button" class="btn btn-sm btn-secondary" data-bm-models="new">Not benchmarked</button>
          </div>
        </div>
        <div class="bm-model-list" id="bmModelList">Loading models…</div>
      </section>

      <details class="bm-advanced">
        <summary>Advanced</summary>
        <div class="bm-check-grid bm-advanced-grid">
          <label class="bm-field"><span>Context size</span><input id="bmContextSize" type="number" min="1" value="128000" /></label>
          <label class="bm-field"><span>Parallel</span><input id="bmParallel" type="number" min="1" value="1" /></label>
          <label class="bm-field"><span>Load timeout (s)</span><input id="bmLoadTimeout" type="number" min="1" value="300" /></label>
          <label class="bm-field"><span>Global timeout (s)</span><input id="bmGlobalTimeout" type="number" min="1" value="300" /></label>
          <label class="bm-field"><span>Throughput window (s)</span><input id="bmThroughputWindow" type="number" min="1" value="60" /></label>
          <label class="bm-field"><span>Stall timeout (s)</span><input id="bmStallTimeout" type="number" min="1" value="10" /></label>
          <label class="bm-field"><span>Slot count</span><input id="bmSlotCount" type="number" min="1" value="3" /></label>
          <label class="bm-field"><span>Exclude (comma separated)</span><input id="bmExclude" type="text" placeholder="e.g. DeepSeek-V4-Flash" /></label>
        </div>
        <label class="bm-check">
          <input type="checkbox" id="bmGrammarVariants" />
          <span><strong>Grammar variants (4-way)</strong><small>Also run think+Tiny Grammar and think+Structured GBNF. Throughput experiments; quadruples the run.</small></span>
        </label>
      </details>

      <div class="bm-launch-error hidden" id="bmLaunchError"></div>
    </div>
    <div class="modal-footer bm-launch-footer">
      <span class="bm-plan-summary" id="bmPlanSummary">Resolving…</span>
      <div class="bm-launch-actions">
        <button type="button" class="btn btn-secondary" id="bmLaunchCancelBtn">Cancel</button>
        <button type="button" class="btn btn-primary" id="bmLaunchSubmitBtn">Start</button>
      </div>
    </div>
  </div>
</div>

<div class="modal-shell hidden" id="bmConfirmModal">
  <div class="modal-backdrop" data-bm-close="confirm"></div>
  <div class="modal-dialog bm-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="bmConfirmTitle">
    <div class="modal-header">
      <div class="modal-header-main">
        <h3 id="bmConfirmTitle">Overwrite existing results?</h3>
      </div>
    </div>
    <div class="modal-body">
      <p id="bmConfirmBody"></p>
      <ul class="bm-confirm-list" id="bmConfirmList"></ul>
    </div>
    <div class="modal-footer bm-confirm-footer">
      <button type="button" class="btn btn-secondary" id="bmConfirmNoBtn">No</button>
      <button type="button" class="btn btn-primary" id="bmConfirmYesBtn">Yes, overwrite</button>
    </div>
  </div>
</div>

<div class="modal-shell hidden" id="bmTranslationModal">
  <div class="modal-backdrop" data-bm-close="translation"></div>
  <div class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="bmTranslationTitle">
    <div class="modal-header">
      <div class="modal-header-main">
        <h3 id="bmTranslationTitle">Hebrew translation</h3>
        <p class="modal-subtitle" id="bmTranslationSubtitle"></p>
      </div>
      <button class="btn btn-icon" type="button" id="bmTranslationCloseBtn" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <button type="button" class="btn btn-sm btn-secondary" id="bmTranslationSourceBtn">Show English source</button>
      <pre class="bm-translation-pane hidden" id="bmTranslationSource" dir="ltr"></pre>
      <div class="bm-translation-grid">
        <section>
          <h4>Reference <span class="badge">human</span></h4>
          <pre class="bm-translation-pane" id="bmTranslationReference" dir="rtl" lang="he"></pre>
        </section>
        <section>
          <h4 id="bmTranslationModelHeading">Model</h4>
          <pre class="bm-translation-pane" id="bmTranslationModel" dir="rtl" lang="he"></pre>
        </section>
      </div>
      <p class="bm-note">chrF is similarity against the reference, not a correctness score. Judge it by reading both panes.</p>
    </div>
  </div>
</div>
`;

function esc(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- LaTeX ---------------------------------------------------------------
// MATH-500 questions are LaTeX: 47 of a 60-question sample carry $…$ math, and
// raw source is genuinely hard to read at a glance. There is no build step
// here and no vendored KaTeX, so this converts the notation that actually
// shows up in this dataset -- fractions, roots, powers, Greek, the common
// operators -- and leaves anything it does not understand alone rather than
// mangling it.
const MATH_SYMBOLS = {
  cdot: "·", times: "×", div: "÷", pm: "±", mp: "∓",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡",
  infty: "∞", sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", theta: "θ",
  lambda: "λ", mu: "μ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ",
  omega: "ω", Delta: "Δ", Sigma: "Σ", Omega: "Ω", Gamma: "Γ", Theta: "Θ",
  circ: "°", degree: "°", cdots: "⋯", ldots: "…", dots: "…", dotsm: "⋯", dotsb: "⋯",
  rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", mapsto: "↦",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩",
  emptyset: "∅", forall: "∀", exists: "∃", angle: "∠", triangle: "△",
  sqrt: "√", overline: "‾", prime: "′", ast: "∗", star: "⋆",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", perp: "⊥", parallel: "∥",
};

// Upright operator names: \sin stays "sin" rather than becoming the italic
// variables s·i·n. After the array environments these are the biggest source of
// leftover source in this dataset.
const MATH_FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh",
  "arcsin", "arccos", "arctan", "log", "ln", "lg", "exp",
  "gcd", "lcm", "min", "max", "det", "dim", "deg", "arg", "ker", "mod",
]);

// LaTeX arguments are not always braced: \frac 1{137} and \sqrt 2 are both
// legal, and both appear in this dataset. Read a brace group when there is one,
// otherwise take a single token.
function readArg(text, start) {
  const group = readGroup(text, start);
  if (group) {
    return group;
  }
  const rest = text.slice(start);
  const token = /^\s*(\\[a-zA-Z]+|[0-9]|[a-zA-Z])/.exec(rest);
  if (token) {
    return { body: token[1], end: start + token[0].length };
  }
  return null;
}

// Skip an optional [..] argument, as in \begin{tabular}[t]{|l|c|}.
function skipOptional(text, start) {
  if (text[start] !== "[") {
    return start;
  }
  const close = text.indexOf("]", start);
  return close === -1 ? start : close + 1;
}

// Pull one {...} group, respecting nesting, starting at an opening brace.
function readGroup(text, start) {
  if (text[start] !== "{") {
    return null;
  }
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return { body: text.slice(start + 1, index), end: index + 1 };
      }
    }
  }
  return null;
}

// `scripts: false` disables ^ and _ handling. Outside real math delimiters a
// run of underscores is a fill-in-the-blank, not a subscript -- MMLU-Pro is
// full of "encourage _________" -- so the loose pass must leave them alone.
function renderMathSegment(source, { scripts = true } = {}) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      const name = /^[a-zA-Z]+/.exec(source.slice(i + 1));
      if (!name) {
        // \\ is a line break in LaTeX; the container is pre-wrap so a newline
        // renders as one.
        out += source[i + 1] === "\\" ? "\n" : "";
        i += 2;
        continue;
      }
      const command = name[0];
      let cursor = i + 1 + command.length;
      if (command === "frac" || command === "dfrac" || command === "tfrac") {
        const top = readArg(source, cursor);
        const bottom = top ? readArg(source, top.end) : null;
        if (top && bottom) {
          out += `<span class="bm-frac"><sup>${renderMathSegment(top.body, { scripts })}</sup><span>⁄</span><sub>${renderMathSegment(bottom.body, { scripts })}</sub></span>`;
          i = bottom.end;
          continue;
        }
      }
      if (command === "sqrt") {
        const body = readArg(source, skipOptional(source, cursor));
        if (body) {
          out += `√<span class="bm-radicand">${renderMathSegment(body.body, { scripts })}</span>`;
          i = body.end;
          continue;
        }
      }
      if (["binom", "dbinom", "tbinom"].includes(command)) {
        const top = readGroup(source, cursor);
        const bottom = top ? readGroup(source, top.end) : null;
        if (top && bottom) {
          out += `C(${renderMathSegment(top.body, { scripts })}, ${renderMathSegment(bottom.body, { scripts })})`;
          i = bottom.end;
          continue;
        }
      }
      if (command === "overrightarrow" || command === "vec") {
        const body = readGroup(source, cursor);
        if (body) {
          out += `${renderMathSegment(body.body, { scripts })}\u20d7`;
          i = body.end;
          continue;
        }
      }
      if (command === "not") {
        out += "¬";
        i = cursor;
        continue;
      }
      if (command === "multicolumn") {
        const span = readGroup(source, cursor);
        const align = span ? readGroup(source, span.end) : null;
        const body = align ? readGroup(source, align.end) : null;
        if (body) {
          out += renderMathSegment(body.body, { scripts });
          i = body.end;
          continue;
        }
      }
      if (["text", "mathrm", "mbox", "operatorname", "mathop"].includes(command)) {
        const body = readGroup(source, cursor);
        if (body) {
          out += `<span class="bm-mathtext">${renderMathSegment(body.body, { scripts })}</span>`;
          i = body.end;
          continue;
        }
      }
      if (["mathbf", "textbf", "bold", "boldsymbol"].includes(command)) {
        const body = readGroup(source, cursor);
        if (body) {
          out += `<strong>${renderMathSegment(body.body, { scripts })}</strong>`;
          i = body.end;
          continue;
        }
      }
      if (command === "boxed") {
        const body = readGroup(source, cursor);
        if (body) {
          out += `<span class="bm-boxed">${renderMathSegment(body.body, { scripts })}</span>`;
          i = body.end;
          continue;
        }
      }
      if (["left", "right", "displaystyle", "limits", "quad", "qquad"].includes(command)) {
        i = cursor;
        continue;
      }
      if (MATH_FUNCTIONS.has(command)) {
        out += `<span class="bm-mathtext">${command}</span>`;
        i = cursor;
        continue;
      }
      if (command === "pmod") {
        const body = readGroup(source, cursor);
        if (body) {
          out += ` (mod ${renderMathSegment(body.body, { scripts })})`;
          i = body.end;
          continue;
        }
      }
      // Array and tabular environments: keep the contents, drop the scaffolding.
      // Laying the grid out properly is a different job; showing the reader
      // \begin{array}{c|c} is not.
      if (command === "begin" || command === "end") {
        const name = readGroup(source, cursor);
        let next = name ? name.end : cursor;
        if (command === "begin" && name) {
          next = skipOptional(source, next);
          const columns = readGroup(source, next);
          if (columns) {
            next = columns.end;
          }
        }
        out += "\n";
        i = next;
        continue;
      }
      if (command === "hline") {
        i = cursor;
        continue;
      }
      if (MATH_SYMBOLS[command]) {
        out += MATH_SYMBOLS[command];
        i = cursor;
        continue;
      }
      // Unknown command: show it as written rather than inventing something.
      out += `\\${command}`;
      i = cursor;
      continue;
    }
    if (scripts && (char === "^" || char === "_")) {
      const tag = char === "^" ? "sup" : "sub";
      const group = readGroup(source, i + 1);
      if (group) {
        out += `<${tag}>${renderMathSegment(group.body, { scripts })}</${tag}>`;
        i = group.end;
        continue;
      }
      // A script can apply to a whole command with no braces -- \sum_{k=1}^\infty
      // is the common one -- so take the command, not just the backslash.
      const command = /^\\[a-zA-Z]+/.exec(source.slice(i + 1));
      if (command) {
        // Take the command's arguments with it, or 256^\frac{1}{2} renders the
        // superscript as a bare "\frac" and leaves {1}{2} loose in the text.
        let end = i + 1 + command[0].length;
        for (;;) {
          const group = readGroup(source, end);
          if (!group) {
            break;
          }
          end = group.end;
        }
        out += `<${tag}>${renderMathSegment(source.slice(i + 1, end), { scripts })}</${tag}>`;
        i = end;
        continue;
      }
      const single = source[i + 1];
      if (single && /[^\s]/.test(single)) {
        out += `<${tag}>${single}</${tag}>`;
        i += 2;
        continue;
      }
    }
    if (char === "~") {
      out += " ";
      i += 1;
      continue;
    }
    // Column separator inside an array. The text is HTML-escaped before it gets
    // here, so the ampersand arrives as the entity, not as "&".
    if (source.startsWith("&amp;", i)) {
      out += "   ";
      i += 5;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

// Math arrives in four delimiters, not one. Measured over 200 MATH-500
// questions: 139 use $…$, 32 use \[…\] display math, 5 use $$…$$, and 3 put
// commands in bare prose with no delimiter at all.
const MATH_DELIMITERS = /\$\$([\s\S]*?)\$\$|\\\[([\s\S]*?)\\\]|\\\(([\s\S]*?)\\\)|\$([^$\n]*?)\$/g;

function renderProse(text) {
  // Only worth a pass if there is actually a command in there; ordinary prose
  // goes through untouched.
  return /\\[a-zA-Z]/.test(text) ? renderMathSegment(text, { scripts: false }) : text;
}

function renderMath(text) {
  const escaped = esc(text);
  let out = "";
  let last = 0;
  let match;
  MATH_DELIMITERS.lastIndex = 0;
  while ((match = MATH_DELIMITERS.exec(escaped)) !== null) {
    out += renderProse(escaped.slice(last, match.index));
    const display = match[1] != null || match[2] != null;
    const body = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    out += `<span class="bm-math${display ? " is-display" : ""}">${renderMathSegment(body)}</span>`;
    last = match.index + match[0].length;
  }
  out += renderProse(escaped.slice(last));
  return out;
}


function initBenchmarksTab(root) {
  const q = (id) => root.querySelector(`#${id}`);
  const on = (id, event, handler) => {
    const element = q(id);
    if (element) {
      element.addEventListener(event, handler);
    }
  };

  const SLOT_KEY = "llm3BenchmarkSlotV1";
  const SORT_KEY = "llm3BenchmarkSortV1";
  const VIEW_KEY = "llm3BenchmarkViewV1";

  function readStored(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (_error) {
      return fallback;
    }
  }

  const state = {
    slot: readStoredSlot(),
    results: null,
    status: null,
    imported: null,
    search: "",
    panel: "results",
    view: readStored(VIEW_KEY, "model"),
    variantFilter: "all",
    statusFilter: "all",
    compareOnly: false,
    slotModel: null,
    pendingTableHtml: null,
    live: null,
    liveWrongOnly: true,
    sort: readStoredSort(),
    selected: new Set(),
    isolated: null,
    planTimer: null,
    plan: null,
    inventory: [],
    launchSelection: new Set(),
    modelSearch: "",
    translations: null,
    pollTimer: null,
    refreshSeq: 0,
    resultsSlot: "",
    lastSeenRunEnd: null,
  };

  function readStoredSlot() {
    try {
      return localStorage.getItem(SLOT_KEY) || "slot3";
    } catch (_error) {
      return "slot3";
    }
  }

  function readStoredSort() {
    try {
      const raw = JSON.parse(localStorage.getItem(SORT_KEY) || "null");
      if (raw && raw.key) {
        return { key: String(raw.key), dir: raw.dir === "asc" ? "asc" : "desc" };
      }
    } catch (_error) { /* fall through */ }
    return { key: "score", dir: "desc" };
  }

  // The two layouts do not share a column set, so a sort key from one is
  // meaningless in the other; fall back rather than silently sorting by nothing.
  function activeSortKey() {
    const accessors = state.view === "model" ? MODEL_SORT_ACCESSORS : VARIANT_SORT_ACCESSORS;
    return accessors[state.sort.key] ? state.sort.key : (state.view === "model" ? "scoreNoThink" : "score");
  }

  function persist(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_error) { /* private mode */ }
  }

  // ---- formatting ---------------------------------------------------------

  function num(value, digits = 1) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "—";
    }
    return value.toFixed(digits).replace(/\.0+$/, "");
  }

  function clock(ms) {
    if (!ms || !Number.isFinite(ms)) {
      return "—";
    }
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
  }

  function duration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "—";
    }
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.round((seconds % 3600) / 60);
    return hours ? `${hours}h ${minutes}m` : `${Math.max(1, minutes)}m`;
  }

  async function getJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch (_error) {
      payload = null;
    }
    if (!response.ok) {
      throw new Error((payload && payload.error) || `${response.status} ${response.statusText}`);
    }
    return payload;
  }

  function postJson(url, body) {
    return getJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  // ---- data ---------------------------------------------------------------

  // The host page defines toast(); the tab loads first, so look it up lazily.
  function notify(message) {
    if (typeof window.toast === "function") {
      window.toast(message, { type: "error" });
    } else {
      notify(message);
    }
  }

  function activeResults() {
    return state.imported ? state.imported.payload : state.results;
  }

  // `poll: true` is the timer's variant: it fetches /results only when a run is
  // active, when a run has just ended, or when the slot changed, because that
  // endpoint runs model discovery and re-reads every result file. Every other
  // caller (user actions) gets a full refresh.
  async function refresh({ poll = false } = {}) {
    const seq = ++state.refreshSeq;
    const slot = state.slot;
    const status = await getJson(`/api/perf-dashboard/status`).catch(() => null);
    if (seq !== state.refreshSeq) {
      return;
    }
    const running = Boolean(status && status.running);
    const runEnd = status && status.lastRun ? status.lastRun.endedAt || null : null;
    const wantResults = !state.imported && (
      !poll || !state.results || running || state.resultsSlot !== slot || runEnd !== state.lastSeenRunEnd
    );
    const tasks = [
      getJson(`/api/perf-dashboard/slot-model?slot=${encodeURIComponent(slot)}`).catch(() => null),
      wantResults
        ? getJson(`/api/perf-dashboard/results?slot=${encodeURIComponent(slot)}`).catch((error) => {
          console.error("benchmarks: failed to load results", error);
          return null;
        })
        : Promise.resolve(null),
      // Only fetched while the Running tab is open: it reads the whole live feed
      // off disk and nobody is watching it otherwise.
      state.panel === "running"
        ? getJson("/api/perf-dashboard/live-questions?limit=200").catch(() => null)
        : Promise.resolve(undefined),
    ];
    const [slotModel, results, live] = await Promise.all(tasks);
    // A slower response for the previous slot must not land on top of this one.
    if (seq !== state.refreshSeq) {
      return;
    }
    state.status = status;
    state.slotModel = slotModel;
    if (live !== undefined) {
      state.live = live;
    }
    if (results) {
      state.results = results;
      state.resultsSlot = slot;
    }
    state.lastSeenRunEnd = runEnd;
    render();
  }

  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    const running = Boolean(state.status && state.status.running);
    const watchingLive = running && state.panel === "running";
    state.pollTimer = window.setTimeout(async () => {
      // Building the results payload runs model discovery, so an unattended tab
      // should not keep it spinning. Poll only while this section is on screen.
      if (isTabVisible()) {
        await refresh({ poll: true });
      }
      schedulePoll();
    }, watchingLive ? 1500 : running ? 2000 : 10000);
  }

  // Coming back to the tab (or the window) should not wait out the idle poll
  // before showing what happened while you were away.
  function refreshNow() {
    if (isTabVisible()) {
      refresh().then(schedulePoll);
    }
  }

  function isTabVisible() {
    const section = document.getElementById("sec-benchmarks");
    return Boolean(section && section.classList.contains("active") && !document.hidden);
  }

  // ---- rows ---------------------------------------------------------------

  // Rows are easier to scan in family bands than as one undifferentiated wall.
  const MODEL_FAMILIES = [
    { id: "qwen35", test: /qwen\s*3\.5/i },
    { id: "qwen36", test: /qwen\s*3\.6/i },
    { id: "qwen38", test: /qwen\s*3\.8|qwythos/i },
    { id: "deepseek", test: /deepseek/i },
    { id: "gemma", test: /gemma/i },
  ];

  function familyClass(model) {
    const family = MODEL_FAMILIES.find((entry) => entry.test.test(String(model || "")));
    return family ? ` bm-family-${family.id}` : "";
  }

  // A vision companion, not a model that can be loaded on its own: llama.cpp
  // rejects it with "CLIP cannot be used as main model, use it with --mmproj".
  // It only ever produced two failed rows.
  const UNBENCHMARKABLE = [/-vision-f16$/i, /\bmmproj\b/i];

  function isBenchmarkable(model) {
    return !UNBENCHMARKABLE.some((pattern) => pattern.test(String(model || "")));
  }

  function matchesFilters(row) {
    if (!isBenchmarkable(row.model)) {
      return false;
    }
    // Every word must match somewhere in the row, so "mlx q8" narrows to a
    // quantization on a runtime. Matching the model name alone meant a launcher
    // or a quant could not be filtered at all.
    const search = state.search.trim().toLowerCase();
    if (search) {
      const haystack = [row.model, row.launcher, row.runtime, row.variant, row.sizeLabel, row.status]
        .join(" ")
        .toLowerCase();
      if (!search.split(/\s+/).every((term) => haystack.includes(term))) {
        return false;
      }
    }
    if (state.statusFilter !== "all" && row.status !== state.statusFilter) {
      return false;
    }
    return true;
  }

  function filteredRows() {
    const results = activeResults();
    if (!results || !Array.isArray(results.rows)) {
      return [];
    }
    let rows = results.rows.filter(matchesFilters);
    // Ticking a box marks a model; it does not hide the others, or you could
    // never tick the second one. Narrowing to the selection is a separate,
    // explicit act.
    if (state.compareOnly && state.selected.size) {
      rows = rows.filter((row) => state.selected.has(row.model));
    }
    return rows;
  }

  // Rows as they appear in the "By variant" layout: every variant is its own
  // top-level row, so a sort orders the whole table rather than reordering
  // children inside model groups.
  function variantRows() {
    let rows = filteredRows();
    if (state.variantFilter !== "all") {
      rows = rows.filter((row) => row.thinkingBucket === state.variantFilter);
    }
    return sortRows(rows, VARIANT_SORT_ACCESSORS);
  }

  // Rows as they appear in the "By model" layout: one row per model, with the
  // thinking variants folded into it side by side. This is the layout that
  // answers "which models actually gain from thinking", because the gain is a
  // column you can sort by rather than a subtraction you do by eye.
  function modelRows() {
    const groups = new Map();
    for (const row of filteredRows()) {
      if (!groups.has(row.model)) {
        groups.set(row.model, {
          model: row.model,
          runtime: row.runtime,
          launcher: row.launcher,
          sizeLabel: row.sizeLabel,
          sizeBytes: row.sizeBytes,
          stale: row.stale,
          pending: true,
          variants: {},
          statuses: [],
        });
      }
      const group = groups.get(row.model);
      // A model can have several rows in one bucket (think, think-tiny); the
      // plain variant wins, otherwise the first one seen.
      const bucket = row.thinkingBucket;
      if (!group.variants[bucket] || row.variant === bucket) {
        group.variants[bucket] = row;
      }
      group.statuses.push(row.status);
      if (!row.pending) {
        group.pending = false;
      }
    }
    const merged = [...groups.values()].map((group) => {
      const noThink = group.variants["no-think"] || null;
      const think = group.variants.think || null;
      const scoreOf = (row) => (row && row.score ? row.score.value : null);
      const noThinkScore = scoreOf(noThink);
      const thinkScore = scoreOf(think);
      // A delta is only a delta if both sides were measured in their own mode.
      // Rows whose thinking score was copied from the no-think run would
      // otherwise report a confident 0 — "thinking changes nothing" — which is
      // exactly the false conclusion the copied measurement used to produce.
      const bothMeasured = Boolean(noThink && think)
        && noThink.score?.measuredOwnVariant !== false
        && think.score?.measuredOwnVariant !== false;
      return {
        ...group,
        noThink,
        think,
        noThinkScore,
        thinkScore,
        deltaUnmeasured: Boolean(noThink && think) && !bothMeasured,
        delta: !bothMeasured || noThinkScore == null || thinkScore == null ? null : thinkScore - noThinkScore,
        status: group.statuses.includes("fail")
          ? "fail"
          : (group.statuses.find((value) => value !== "pass") || group.statuses[0] || "pending"),
      };
    });
    return sortRows(merged, MODEL_SORT_ACCESSORS);
  }

  const VARIANT_SORT_ACCESSORS = {
    model: (row) => row.model.toLowerCase(),
    variant: (row) => row.variant,
    size: (row) => row.sizeBytes || 0,
    score: (row) => (row.score ? row.score.value : null),
    speed: (row) => row.perf.answerTps,
    load: (row) => row.perf.loadS,
    status: (row) => row.status,
    ran: (row) => (row.startedAt ? Date.parse(row.startedAt) : null),
  };

  const MODEL_SORT_ACCESSORS = {
    model: (row) => row.model.toLowerCase(),
    size: (row) => row.sizeBytes || 0,
    scoreNoThink: (row) => row.noThinkScore,
    scoreThink: (row) => row.thinkScore,
    delta: (row) => row.delta,
    speedNoThink: (row) => (row.noThink ? row.noThink.perf.answerTps : null),
    speedThink: (row) => (row.think ? row.think.perf.answerTps : null),
    load: (row) => (row.noThink || row.think || {}).perf?.loadS ?? null,
    status: (row) => row.status,
    ran: (row) => {
      const source = row.noThink || row.think;
      return source && source.startedAt ? Date.parse(source.startedAt) : null;
    },
  };

  function sortRows(rows, accessors) {
    const key = activeSortKey();
    const accessor = accessors[key] || ((row) => sceneValue(row, key));
    const direction = state.sort.dir === "asc" ? 1 : -1;
    const sorted = rows.slice().sort((left, right) => {
      const a = accessor(left);
      const b = accessor(right);
      // Rows with nothing measured always sink, whichever way the column sorts.
      if (a == null && b == null) return left.model.localeCompare(right.model);
      if (a == null) return 1;
      if (b == null) return -1;
      if (typeof a === "string" || typeof b === "string") {
        return String(a).localeCompare(String(b)) * direction;
      }
      return (a - b) * direction;
    });
    // A row being worked on right now is the one row you want in front of you,
    // and it is usually the one a numeric sort buries: mid-run it has no score
    // yet, and a model chosen for a scene may sit anywhere in the ranking.
    const busy = sorted.filter((row) => isLiveRow(row.model));
    return busy.length ? [...busy, ...sorted.filter((row) => !isLiveRow(row.model))] : sorted;
  }

  function sceneValue(row, key) {
    const id = key.startsWith("scene:") ? key.slice(6) : null;
    if (!id) {
      return null;
    }
    // In the merged layout a scene column holds two runs; sort by the one that
    // exists, preferring no-think so the column stays comparable.
    const source = row.scenes ? row : (row.noThink || row.think || {});
    const entry = source.scenes && source.scenes[id];
    return entry && entry.elapsedMs ? entry.elapsedMs : null;
  }

  // The gallery follows whatever the table is showing.
  function visibleRows() {
    return state.view === "model"
      ? modelRows().flatMap((row) => [row.noThink, row.think].filter(Boolean))
      : variantRows();
  }

  // ---- render -------------------------------------------------------------

  // The detail views were accordions stacked under the table, which meant each
  // of them got whatever height was left over -- and none of them are worth
  // reading next to the results anyway. They are panels now: one at a time,
  // full height.
  const PANELS = [
    { id: "results", label: "Results" },
    { id: "running", label: "Running", liveOnly: true },
    { id: "runtime", label: "Runtime averages" },
    { id: "failures", label: "Failures" },
    { id: "quality", label: "Data quality" },
    { id: "agentic", label: "Agentic" },
    { id: "gallery", label: "Scene gallery" },
  ];

  function panelCount(id) {
    const results = activeResults();
    if (!results) {
      return null;
    }
    if (id === "results") {
      return results.rows.length;
    }
    if (id === "running") {
      return state.live && state.live.counts ? state.live.counts.wrong : null;
    }
    if (id === "failures") {
      return results.rows.reduce((total, row) => total + row.errors.length, 0);
    }
    if (id === "quality") {
      return results.dataQuality.length;
    }
    if (id === "runtime") {
      return results.runtimeAverages.length;
    }
    if (id === "agentic") {
      return results.rows.filter((row) => row.agentic && row.agentic.result).length;
    }
    if (id === "gallery") {
      return results.rows.reduce(
        (total, row) => total + Object.values(row.scenes || {}).filter((scene) => scene && scene.status === "done").length,
        0,
      );
    }
    return null;
  }

  function renderPanelTabs() {
    const host = q("bmPanelTabs");
    // The Running tab lists questions, and a scene run produces none, so it
    // follows the benchmark phase rather than "is anything happening".
    const running = Boolean(state.status && state.status.running && state.status.phase !== "scenes");
    // Disabled rather than hidden: a tab that appears and vanishes is harder to
    // find than one that is simply greyed out.
    if (!running && state.panel === "running") {
      state.panel = "results";
    }
    setHtmlIfChanged(host, PANELS.map((panel) => {
      const disabled = panel.liveOnly && !running;
      const count = disabled ? null : panelCount(panel.id);
      return `<button type="button" role="tab" aria-selected="${state.panel === panel.id}"
        class="model-surface-tab ${state.panel === panel.id ? "active" : ""}${disabled ? " is-disabled" : ""}"
        ${disabled ? "disabled" : ""}
        ${panel.liveOnly && running ? 'title="Questions this model is getting wrong, as they happen"' : ""}
        data-bm-panel="${esc(panel.id)}">
        ${panel.liveOnly && running ? '<span class="bm-tab-dot"></span>' : ""}${esc(panel.label)}${count == null ? "" : `<span>${count}</span>`}
      </button>`;
    }).join(""));
  }

  function renderActivePanel() {
    const isResults = state.panel === "results";
    q("bmPanelResults").classList.toggle("hidden", !isResults);
    q("bmPanelDetail").classList.toggle("hidden", isResults);
    // The filter only acts on the table, so it goes away with the table.
    q("bmSearch").classList.toggle("hidden", !isResults);
    if (state.panel !== "gallery") {
      teardownGallery();
    }
    if (isResults) {
      renderTable();
    } else {
      renderDetail();
    }
  }

  const VARIANT_FILTERS = [
    { id: "all", label: "All variants" },
    { id: "no-think", label: "No-think" },
    { id: "think", label: "Think" },
  ];
  const STATUS_FILTERS = [
    { id: "all", label: "Any status" },
    { id: "pass", label: "Pass" },
    { id: "partial", label: "Partial" },
    { id: "fail", label: "Fail" },
    { id: "not benchmarked", label: "Not benchmarked" },
  ];

  // The layout switch, both filters and compare-only used to live only on the
  // right-click menu, which a touch screen cannot reach and nothing advertised.
  // They are visible controls now; the menu still sets the same state.
  function renderFilterChips() {
    const host = q("bmFilterChips");
    if (!host) {
      return;
    }
    host.classList.toggle("hidden", state.panel !== "results");
    const chip = (active, action, label, title) =>
      `<button type="button" class="btn btn-sm filter-chip ${active ? "is-on" : ""}"${title ? ` title="${esc(title)}"` : ""}${active ? ' aria-pressed="true"' : ' aria-pressed="false"'} data-bm-filter="${esc(action)}">${esc(label)}</button>`;

    const parts = [`<span class="bm-filter-label">View</span>`];
    parts.push(chip(state.view === "model", "view:model", "By model", "One row per model, thinking variants side by side."));
    parts.push(chip(state.view === "variant", "view:variant", "By variant", "Every variant as its own row."));
    if (state.view === "variant") {
      parts.push(`<span class="bm-filter-label">Variant</span>`);
      for (const option of VARIANT_FILTERS) {
        parts.push(chip(state.variantFilter === option.id, `variant:${option.id}`, option.label));
      }
    }
    parts.push(`<span class="bm-filter-label">Status</span>`);
    for (const option of STATUS_FILTERS) {
      parts.push(chip(state.statusFilter === option.id, `status:${option.id}`, option.label));
    }
    if (state.selected.size) {
      parts.push(chip(state.compareOnly, "compare", `Compare ${state.selected.size}`, "Show only the ticked models."));
    }
    const filtered = state.statusFilter !== "all" || state.variantFilter !== "all" || state.compareOnly || state.search.trim();
    if (filtered) {
      parts.push(`<button type="button" class="btn btn-sm filter-chip bm-filter-clear" data-bm-filter="clear">Clear filters</button>`);
    }
    setHtmlIfChanged(host, parts.join(""));
  }

  function renderSlotModel() {
    const host = q("bmSlotModel");
    const info = state.slotModel;
    if (!info) {
      host.textContent = "";
      host.className = "bm-slot-model";
      return;
    }
    host.className = `bm-slot-model ${info.loaded ? "is-loaded" : "is-empty"}`;
    host.textContent = info.loaded ? info.id : "no model loaded";
  }

  function render() {
    renderToolbar();
    renderSlotModel();
    renderFilterChips();
    renderRunStrip();
    renderPanelTabs();
    renderActivePanel();
  }

  function renderToolbar() {
    const results = activeResults();
    const counts = results ? results.counts : null;
    const countsEl = q("bmCounts");
    if (countsEl) {
      const host = results && results.host;
      const hostText = host && (host.chip || host.memoryBytes)
        ? ` · ${[host.chip, host.memoryBytes ? `${Math.round(host.memoryBytes / 1024 ** 3)} GB` : "", host.osVersion ? `macOS ${host.osVersion}` : ""].filter(Boolean).join(", ")}`
        : "";
      countsEl.textContent = counts
        ? `${counts.models} models · ${counts.rows} rows · ${counts.pass} pass · ${counts.fail} fail${hostText}`
        : "";
    }
    const running = Boolean(state.status && state.status.running);
    q("bmCancelBtn").classList.toggle("hidden", !running);
    q("bmRunBtn").disabled = running || Boolean(state.imported);
    q("bmSlotSelect").value = state.slot;
  }

  function renderRunStrip() {
    const status = state.status;
    const strip = q("bmRunStrip");
    const dot = q("bmRunDot");
    const title = q("bmRunTitle");
    const meta = q("bmRunMeta");
    const track = q("bmRunTrack");
    const fill = q("bmRunFill");
    const log = q("bmRunLog");
    const running = Boolean(status && status.running);

    strip.classList.toggle("is-running", running);
    dot.className = `bm-run-dot ${running ? "is-running" : "is-idle"}`;
    track.classList.toggle("hidden", !running);

    if (!running) {
      const last = status && status.lastRun;
      title.textContent = "Idle";
      meta.textContent = last && last.endedAt
        ? `last run finished ${new Date(last.endedAt).toLocaleString()}${last.exitCode ? ` · exit ${last.exitCode}` : ""}`
        : "no run recorded in this session";
      log.textContent = (last && last.recentLog) || "";
      return;
    }

    if (status.phase === "scenes") {
      title.textContent = `Scenes · ${status.sceneLabel || status.sceneTest}`;
      meta.textContent = `${status.completedModels || 0} / ${status.totalModels || 0} models`
        + (status.currentModel ? ` · ${status.currentModel}` : "")
        + (status.sceneThinking ? " · thinking" : "")
        + ((status.queuedScenes || []).length ? ` · ${status.queuedScenes.length} more queued` : "");
    } else {
      title.textContent = "Benchmarking";
      meta.textContent = `${status.completedModels || 0} / ${status.totalModels || 0} models`
        + (status.currentModel ? ` · ${status.currentModel}` : "")
        + (status.currentStage ? ` · ${status.currentStage}` : "");
    }
    fill.style.width = `${Math.max(2, Number(status.progressPercent) || 0)}%`;
    log.textContent = status.currentLog || status.recentLog || "";
  }

  function scoreInline(row) {
    if (!row || !row.score) {
      return '<span class="bm-muted">—</span>';
    }
    const score = row.score;
    const caveat = score.measuredOwnVariant === false
      ? '<span class="bm-score-caveat" title="Measured in the other thinking mode and copied onto this row.">*</span>'
      : "";
    const unreliable = score.unreliable
      ? '<span class="bm-score-warning" title="A metric was excluded: too much of its sample was lost to token caps or timeouts.">!</span>'
      : "";
    return `<button type="button" class="bm-score" data-bm-score="${esc(row.id)}">
      <span class="bm-score-value">${num(score.value, 0)}</span>
      <span class="bm-score-margin"${score.margin == null ? ' title="No confidence interval: no accuracy metric with a sample size behind this score."' : ""}>±${score.margin == null ? "?" : num(score.margin, 0)}</span>
      <span class="bm-tier bm-tier-${esc(score.tier || "A")}">${esc(score.tier || "?")}</span>
      ${caveat}${unreliable}
    </button>`;
  }

  // Answer tok/s is the headline; the hover carries what it was made of: the
  // decode median with its spread over the repeats, and the prompt-processing
  // rate. A tilde marks a row whose token count was estimated from characters.
  function speedCell(col, row) {
    const perf = row && row.perf;
    if (!perf) {
      return `<td data-bm-col="${esc(col)}">${num(null)}</td>`;
    }
    const parts = [];
    if (perf.probeTps != null) {
      // The comparable one: every model is asked for the same token count.
      parts.push(`decode probe ${num(perf.probeTps)} tok/s over ${perf.probeTokens || "?"} fixed tokens${perf.probeHitCap ? "" : " (stopped early, weaker comparison)"}`);
    }
    if (perf.decodeTps != null) {
      let decode = `scenario decode ${num(perf.decodeTps)} tok/s`;
      if (perf.decodeRepeats > 1) {
        decode += ` (median of ${perf.decodeRepeats}, ${num(perf.decodeMin)}–${num(perf.decodeMax)}, ±${num(perf.decodeSpreadPct)}%)`;
      } else {
        decode += " (single sample)";
      }
      if (perf.warmups > 0) {
        decode += `, after ${perf.warmups} warm-up`;
      }
      parts.push(decode);
    }
    if (perf.promptTps != null) {
      parts.push(`prompt processing ${num(perf.promptTps, 0)} tok/s over ${perf.promptTokens || "?"} tokens, cold cache`);
    }
    if (perf.tokenCountMethod === "estimate") {
      parts.push("token count estimated from characters");
    }
    const marker = perf.tokenCountMethod === "estimate" ? '<span class="bm-muted" aria-hidden="true">~</span>' : "";
    return `<td data-bm-col="${esc(col)}"${parts.length ? ` title="${esc(parts.join(" · "))}"` : ""}>${num(perf.answerTps)}${marker}</td>`;
  }

  function deltaCell(delta, unmeasured) {
    if (delta == null) {
      const title = unmeasured
        ? "No delta to show: the thinking row's quality was copied from the no-think run, not measured with thinking on."
        : "Only one variant has been benchmarked.";
      return `<td class="bm-delta" data-bm-col="delta"><span class="bm-muted" title="${esc(title)}">${unmeasured ? "n/m" : "—"}</span></td>`;
    }
    const rounded = Math.round(delta);
    const tone = rounded > 0 ? "is-up" : rounded < 0 ? "is-down" : "";
    return `<td class="bm-delta" data-bm-col="delta"><span class="${tone}" title="Thinking minus no-think, in score points">${rounded > 0 ? "+" : ""}${rounded}</span></td>`;
  }

  function sceneCellFor(row, test) {
    const entry = row && row.scenes ? row.scenes[test.id] : null;
    if (!row) {
      return '<span class="bm-muted">—</span>';
    }
    if (!entry) {
      return `<button type="button" class="bm-scene-run" data-bm-scene-run="${esc(test.id)}" data-bm-label="${esc(row.model)}" data-bm-bucket="${esc(row.thinkingBucket)}" title="Run the ${esc(test.label)} test for this model">+</button>`;
    }
    if (entry.status === "done" && entry.file) {
      const flag = entry.runtimeErrors
        ? `<span class="bm-scene-flag" title="${entry.runtimeErrors} runtime error(s) when previewed">!</span>`
        : "";
      return `<a class="bm-scene-link" target="_blank" rel="noopener"
        href="/api/perf-dashboard/voxel/file/${encodeURIComponent(entry.file)}"
        title="${esc(test.label)} · ${Math.round((entry.bytes || 0) / 1024)} KB — opens in a new tab">${clock(entry.elapsedMs)}</a>${flag}`;
    }
    return `<span class="bm-scene-failed" title="${esc(entry.error || entry.status)}">${esc(entry.status === "failed" ? "failed" : entry.status)}</span>`;
  }

  function statusBadge(status) {
    const map = { pass: "badge-live", fail: "badge-danger", partial: "badge-new", running: "badge-live", interrupted: "badge-danger" };
    const title = status === "interrupted"
      ? ' title="The run stopped before this row finished (no runner is alive). Re-run the model to replace it."'
      : "";
    return `<span class="badge ${map[status] || ""}"${title}>${esc(status)}</span>`;
  }

  function sortArrow(key) {
    if (activeSortKey() !== key) {
      return '<span class="bm-sort">↕</span>';
    }
    return `<span class="bm-sort is-active">${state.sort.dir === "asc" ? "↑" : "↓"}</span>`;
  }

  function head(key, label, title) {
    // The model column carries the longest strings in the table, so it is the
    // one worth being able to squeeze when you want everything else on screen.
    const grip = key === "model" ? '<span class="bm-col-grip" data-bm-resize="model" title="Drag to resize"></span>' : "";
    return `<th data-bm-col="${esc(key)}" data-bm-sort="${esc(key)}"${title ? ` title="${esc(title)}"` : ""}>${esc(label)} ${sortArrow(key)}${grip}</th>`;
  }

  const MODEL_WIDTH_KEY = "llm3BenchmarkModelWidthV1";

  function applyModelWidth() {
    const width = Number(readStored(MODEL_WIDTH_KEY, "")) || 0;
    q("bmTable").style.setProperty("--bm-model-col", width ? `${width}px` : "");
    q("bmTable").classList.toggle("bm-model-sized", Boolean(width));
  }

  function startModelResize(event, grip) {
    event.preventDefault();
    event.stopPropagation();
    const cell = grip.closest("th");
    const startX = event.clientX;
    const startWidth = cell.getBoundingClientRect().width;
    document.body.classList.add("bm-resizing");
    const onMove = (moveEvent) => {
      const next = Math.max(120, Math.min(720, startWidth + (moveEvent.clientX - startX)));
      q("bmTable").style.setProperty("--bm-model-col", `${Math.round(next)}px`);
      q("bmTable").classList.add("bm-model-sized");
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.classList.remove("bm-resizing");
      const width = q("bmTable").style.getPropertyValue("--bm-model-col").replace("px", "");
      persist(MODEL_WIDTH_KEY, String(Math.round(Number(width) || 0)));
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // Any model the machine is working on, whatever kind of work it is: a
  // benchmark row, a scene inside a run, or a scene someone kicked off on its
  // own from a row menu. The last of those has no benchmark session behind it,
  // which is why matching on "the current benchmark model" left it unmarked.
  function isLiveRow(model) {
    const status = state.status;
    if (!status || !status.running) {
      return false;
    }
    if (Array.isArray(status.activeModels) && status.activeModels.length) {
      return status.activeModels.includes(model);
    }
    return status.currentModel === model;
  }

  function liveSpinner(model) {
    if (!isLiveRow(model)) {
      return "";
    }
    const status = state.status;
    const stage = status.phase === "scenes"
      ? `${status.sceneLabel || status.sceneTest || "scene"}${status.sceneThinking ? " · thinking" : ""}`
      : (status.currentStage || "running");
    return `<span class="bm-row-spinner" title="Working now — ${esc(stage)}" aria-label="running"></span>`;
  }

  function runStamp(row) {
    const iso = row && row.startedAt;
    if (!iso) {
      return '<span class="bm-muted">—</span>';
    }
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) {
      return '<span class="bm-muted">—</span>';
    }
    const days = Math.floor((Date.now() - when.getTime()) / 86400000);
    const ago = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
    return `<span title="${esc(when.toLocaleString())}">${esc(when.toLocaleDateString(undefined, { month: "short", day: "numeric" }))}
      <small class="bm-muted">${esc(ago)}</small></span>`;
  }

  // The runtime/launcher badges sit on the model's own line, pushed right, so
  // the name column reads as one row per model instead of two stacked lines.
  function modelNameCell(row, extra = "") {
    return `<td class="bm-model-cell" data-bm-col="model">
      <div class="bm-model-line">
        <span class="bm-model-name">${esc(row.model)}</span>
        ${liveSpinner(row.model)}
        <span class="bm-model-badges">
          ${extra}
          ${loadedBadge(row.model)}
          ${row.stale ? '<span class="badge badge-danger" title="No longer on disk">stale</span>' : ""}
          <span class="badge badge-runtime">${esc(row.runtime)}</span>
        </span>
      </div>
    </td>`;
  }

  function loadedBadge(model) {
    const loaded = state.slotModel && state.slotModel.loaded && state.slotModel.id;
    // The slot reports the model id it serves, which is the label for GGUF and
    // a path-ish id for some runtimes; match loosely on both.
    if (!loaded) {
      return "";
    }
    const id = String(state.slotModel.id);
    if (id === model || id.includes(model) || model.includes(id)) {
      return '<span class="badge badge-live" title="Currently loaded on the selected slot">loaded</span>';
    }
    return "";
  }

  // A poll lands every couple of seconds. Rewriting the table's innerHTML then
  // destroys any text the user has selected inside it -- you cannot copy a model
  // name because the selection evaporates mid-drag. So: never write markup that
  // is identical to what is already there, and never write at all while a
  // selection is live inside the table. The poll keeps running; only the DOM
  // write waits, and it is flushed the moment the selection goes away.
  function selectionInsideTable() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      return false;
    }
    const container = q("bmTable");
    const node = selection.getRangeAt(0).commonAncestorContainer;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element && container.contains(element));
  }

  // The last markup written into each host, so a poll that produces the same
  // HTML leaves the DOM alone (and with it selection, focus, and any iframe).
  const renderedHtml = new WeakMap();

  function setHtmlIfChanged(host, html) {
    if (!host) {
      return false;
    }
    if (renderedHtml.get(host) === html) {
      return false;
    }
    host.innerHTML = html;
    renderedHtml.set(host, html);
    return true;
  }

  function applyTableHtml(html) {
    const table = q("bmTable");
    if (renderedHtml.get(table) === html) {
      return;
    }
    if (selectionInsideTable()) {
      state.pendingTableHtml = html;
      return;
    }
    state.pendingTableHtml = null;
    setHtmlIfChanged(table, html);
    applyModelWidth();
  }

  function flushPendingTable() {
    if (state.pendingTableHtml && !selectionInsideTable()) {
      const html = state.pendingTableHtml;
      state.pendingTableHtml = null;
      setHtmlIfChanged(q("bmTable"), html);
      applyModelWidth();
    }
  }

  function renderTable() {
    const results = activeResults();
    const table = q("bmTable");
    // A poll lands every couple of seconds during a run. Re-rendering the table
    // is fine; stealing focus from a control the user is holding is not.
    const active = document.activeElement;
    const restoreScroll = q("bmTableScroll") ? q("bmTableScroll").scrollTop : 0;
    queueMicrotask(() => {
      if (q("bmTableScroll") && restoreScroll) {
        q("bmTableScroll").scrollTop = restoreScroll;
      }
      if (active && active.isConnected && document.activeElement !== active) {
        try { active.focus({ preventScroll: true }); } catch (_error) { /* gone */ }
      }
    });
    if (!results) {
      applyTableHtml('<tbody><tr><td class="bm-empty">Loading benchmark results…</td></tr></tbody>');
      return;
    }
    const sceneTests = results.sceneTests || [];
    if (state.view === "model") {
      renderModelView(table, modelRows(), sceneTests);
    } else {
      renderVariantView(table, variantRows(), sceneTests);
    }
  }

  function emptyBody(columns) {
    return `<tbody><tr><td class="bm-empty" colspan="${columns}">Nothing matches the current filters.</td></tr></tbody>`;
  }

  function renderModelView(table, rows, sceneTests) {
    const header = `<thead><tr>
      <th class="bm-check-col"></th>
      ${head("model", "Model")}
      ${head("size", "Size")}
      ${head("scoreNoThink", "Score no-think", "Weighted smartness measured with thinking off.")}
      ${head("scoreThink", "Score think", "Weighted smartness measured with thinking on.")}
      ${head("delta", "Δ", "How many points thinking is worth on this model. Sort by it to see which models actually gain.")}
      ${head("speedNoThink", "tok/s no-think", "Answer tokens per second with thinking off.")}
      ${head("speedThink", "tok/s think", "Answer tokens per second with thinking on — reasoning time counts against it.")}
      ${head("load", "Load")}
      ${sceneTests.map((test) => head(`scene:${test.id}`, test.id, `${test.label} — no-think / think`)).join("")}
      ${head("ran", "Run", "When this model was last benchmarked.")}
      ${head("status", "Status")}
      <th class="bm-actions-col"></th>
    </tr></thead>`;

    if (!rows.length) {
      applyTableHtml(header + emptyBody(10 + sceneTests.length));
      return;
    }

    applyTableHtml(header + `<tbody>${rows.map((row) => `
      <tr data-bm-label="${esc(row.model)}" class="${isLiveRow(row.model) ? "active-model" : ""}${row.pending ? " bm-pending" : ""}${familyClass(row.model)}">
        <td class="bm-check-col"><input type="checkbox" data-bm-select="${esc(row.model)}" ${state.selected.has(row.model) ? "checked" : ""} aria-label="Compare ${esc(row.model)}" /></td>
        ${modelNameCell(row)}
        <td class="bm-size" data-bm-col="size">${esc(row.sizeLabel)}</td>
        <td class="bm-score-cell" data-bm-col="scoreNoThink">${scoreInline(row.noThink)}</td>
        <td class="bm-score-cell" data-bm-col="scoreThink">${scoreInline(row.think)}</td>
        ${deltaCell(row.delta, row.deltaUnmeasured)}
        ${speedCell("speedNoThink", row.noThink)}
        ${speedCell("speedThink", row.think)}
        <td data-bm-col="load">${num((row.noThink || row.think || { perf: {} }).perf.loadS)}</td>
        ${sceneTests.map((test) => `<td class="bm-scene-cell bm-scene-pair" data-bm-col="scene:${esc(test.id)}">
          ${sceneCellFor(row.noThink, test)}<span class="bm-scene-sep">/</span>${sceneCellFor(row.think, test)}
        </td>`).join("")}
        <td class="bm-stamp" data-bm-col="ran">${runStamp(row.noThink || row.think)}</td>
        <td data-bm-col="status">${statusBadge(row.status)}</td>
        <td class="bm-actions-col">
          <button type="button" class="bm-row-btn" data-bm-row-menu="${esc(row.model)}" data-bm-bucket="no-think"
            title="Run something for this model" aria-haspopup="menu">▶<span class="bm-caret">▾</span></button>
        </td>
      </tr>`).join("")}</tbody>`);
  }

  function renderVariantView(table, rows, sceneTests) {
    const header = `<thead><tr>
      <th class="bm-check-col"></th>
      ${head("model", "Model")}
      ${head("variant", "Variant")}
      ${head("size", "Size")}
      ${head("score", "Score", "Weighted smartness score with its 95% interval. Hover a value for the breakdown.")}
      ${head("speed", "tok/s", "Answer tokens per second — thinking time counts against it.")}
      ${head("load", "Load")}
      ${sceneTests.map((test) => head(`scene:${test.id}`, test.id, `${test.label} — time to generate.`)).join("")}
      ${head("ran", "Run", "When this row was benchmarked.")}
      ${head("status", "Status")}
      <th class="bm-actions-col"></th>
    </tr></thead>`;

    if (!rows.length) {
      applyTableHtml(header + emptyBody(9 + sceneTests.length));
      return;
    }

    applyTableHtml(header + `<tbody>${rows.map((row) => `
      <tr data-bm-label="${esc(row.model)}" data-bm-row="${esc(row.id)}" class="${isLiveRow(row.model) ? "active-model" : ""}${row.pending ? " bm-pending" : ""}${familyClass(row.model)}">
        <td class="bm-check-col"><input type="checkbox" data-bm-select="${esc(row.model)}" ${state.selected.has(row.model) ? "checked" : ""} aria-label="Compare ${esc(row.model)}" /></td>
        ${modelNameCell(row)}
        <td class="bm-variant" data-bm-col="variant">${esc(row.variant)}</td>
        <td class="bm-size" data-bm-col="size">${esc(row.sizeLabel)}</td>
        <td class="bm-score-cell" data-bm-col="score">${scoreInline(row)}</td>
        ${speedCell("speed", row)}
        <td data-bm-col="load">${num(row.perf.loadS)}</td>
        ${sceneTests.map((test) => `<td class="bm-scene-cell" data-bm-col="scene:${esc(test.id)}">${sceneCellFor(row, test)}</td>`).join("")}
        <td class="bm-stamp" data-bm-col="ran">${runStamp(row)}</td>
        <td data-bm-col="status">${statusBadge(row.status)}</td>
        <td class="bm-actions-col">
          <button type="button" class="bm-row-btn" data-bm-row-menu="${esc(row.model)}" data-bm-bucket="${esc(row.thinkingBucket)}"
            title="Run something for this model" aria-haspopup="menu">▶<span class="bm-caret">▾</span></button>
          ${row.hasTranslation ? `<button type="button" class="bm-row-btn" data-bm-translation="${esc(row.model)}" data-bm-variant="${esc(row.variant)}" title="Read the Hebrew translation">א</button>` : ""}
        </td>
      </tr>`).join("")}</tbody>`);
  }

  function renderDetail() {
    const results = activeResults();
    const host = q("bmPanelDetail");
    if (!results) {
      setHtmlIfChanged(host, '<p class="bm-panel-empty">Loading…</p>');
      return;
    }

    if (state.panel === "runtime") {
      setHtmlIfChanged(host, `<table class="data-table bm-sub-table">
        <thead><tr><th>Runtime</th><th>Rows</th><th>Load (s)</th><th>TTFT (s)</th><th>Decode tok/s</th><th>Answer tok/s</th></tr></thead>
        <tbody>${(results.runtimeAverages || []).map((entry) => `<tr>
          <td>${esc(entry.runtime)}</td><td>${entry.models}</td><td>${num(entry.loadS, 2)}</td>
          <td>${num(entry.ttftS, 3)}</td><td>${num(entry.decodeTps, 2)}</td><td>${num(entry.answerTps, 2)}</td>
        </tr>`).join("") || '<tr><td colspan="6" class="bm-muted">No runs yet.</td></tr>'}</tbody>
      </table>`);
      return;
    }

    if (state.panel === "failures") {
      const errorRows = (results.rows || []).flatMap((row) => (row.errors || []).map((error) => ({ ...error, model: row.model, variant: row.variant })));
      setHtmlIfChanged(host, `<table class="data-table bm-sub-table">
        <thead><tr><th>Model</th><th>Variant</th><th>Stage</th><th>Code</th><th>Message</th></tr></thead>
        <tbody>${errorRows.map((error) => `<tr>
          <td>${esc(error.model)}</td><td class="bm-variant">${esc(error.variant)}</td><td>${esc(error.stage)}</td>
          <td>${esc(error.code)}</td><td class="bm-error-message">${esc(String(error.message).slice(0, 2000))}</td>
        </tr>`).join("") || '<tr><td colspan="5" class="bm-muted">No failures recorded.</td></tr>'}</tbody>
      </table>`);
      return;
    }

    if (state.panel === "quality") {
      setHtmlIfChanged(host, `<p class="bm-note">What a run could not measure. A score renormalized over a hole is not comparable to a complete one, and one built mostly from replies that hit the token cap measured the budget rather than the model.</p>
        <ul class="bm-note-list">${(results.dataQuality || []).map((entry) => `<li>
          <strong>${esc(entry.model)}</strong>${entry.variant ? ` <span class="bm-variant">${esc(entry.variant)}</span>` : ""} — ${esc(entry.notes.join("; "))}
        </li>`).join("") || '<li class="bm-muted">Every row measured its full sample.</li>'}</ul>`);
      return;
    }

    if (state.panel === "agentic") {
      const agenticRows = (results.rows || []).filter((row) => row.agentic && row.agentic.result);
      setHtmlIfChanged(host, `<table class="data-table bm-sub-table">
        <thead><tr><th>Model</th><th>Variant</th><th>Result</th><th>Tool calls</th><th>Support</th></tr></thead>
        <tbody>${agenticRows.map((row) => `<tr>
          <td>${esc(row.model)}</td><td class="bm-variant">${esc(row.variant)}</td><td>${esc(row.agentic.result)}</td>
          <td>${row.agentic.toolCalls == null ? "—" : row.agentic.toolCalls}</td><td>${esc(row.agentic.toolSupport)}</td>
        </tr>`).join("") || '<tr><td colspan="5" class="bm-muted">No agentic results yet.</td></tr>'}</tbody>
      </table>`);
      return;
    }

    if (state.panel === "running") {
      renderRunningPanel(host);
      return;
    }

    if (state.panel === "gallery") {
      setHtmlIfChanged(host, `<p class="bm-note">Every scene in the table, rendered. Loading one also reports whether it throws at runtime, which feeds the scene score.</p>
        <div class="bm-gallery" id="bmGallery"></div>`);
      renderGallery(host.querySelector("#bmGallery"), results);
    }
  }

  // Scene pages are live documents -- canvas loops, WebGL, animation frames --
  // and mounting a dozen at once locks the tab up. Tiles start as posters and
  // only become iframes while they are on screen, with a hard cap on how many
  // run at a time. (The previous implementation learned this the same way.)
  const GALLERY_LIVE_LIMIT = 6;
  let galleryObserver = null;
  const galleryLive = [];

  function mountGalleryFrame(tile) {
    if (tile.querySelector("iframe")) {
      return;
    }
    const frame = document.createElement("iframe");
    frame.src = tile.dataset.bmSrc;
    frame.loading = "lazy";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.title = tile.dataset.bmTitle || "scene";
    tile.querySelector(".bm-gallery-frame").appendChild(frame);
    galleryLive.push(tile);
    while (galleryLive.length > GALLERY_LIVE_LIMIT) {
      unmountGalleryFrame(galleryLive.shift());
    }
  }

  function unmountGalleryFrame(tile) {
    if (!tile) {
      return;
    }
    const frame = tile.querySelector("iframe");
    if (frame) {
      frame.remove();
    }
    const index = galleryLive.indexOf(tile);
    if (index !== -1) {
      galleryLive.splice(index, 1);
    }
  }

  function teardownGallery() {
    if (galleryObserver) {
      galleryObserver.disconnect();
      galleryObserver = null;
    }
    galleryLive.splice(0).forEach(unmountGalleryFrame);
  }

  // What the model is getting wrong, as it happens. Wrong answers first,
  // because a list of everything it got right is a list nobody reads.
  function liveItemHtml(entry) {
    // "no answer" has three quite different causes and they need different
    // responses: give it longer, give it more tokens, or go and find out why the
    // slot stopped answering.
    const FLAGS = {
      length: ["truncated", "Cut off at the token cap before it answered"],
      timeout: ["timed out", "Hit its per-question time limit while still generating"],
      "no-response": ["no reply", "The request came back empty"],
      unreachable: ["slot unreachable", "The endpoint refused the connection — the model was not loaded or the slot was taken"],
      error: ["request failed", "The request errored"],
    };
    const flag = FLAGS[entry.finishReason];
    const why = flag ? `<span class="bm-live-flag" title="${esc(flag[1])}">${esc(flag[0])}</span>` : "";
    // Everything you need to judge the row goes above the question: the verdict,
    // what it should have said versus what it did, and how fast it got there.
    // The question is the long part and belongs last.
    const stats = [
      entry.elapsedSeconds == null ? "" : `${entry.elapsedSeconds}s`,
      entry.tokensPerSecond ? `${entry.tokensPerSecond} tok/s` : "",
      entry.completionTokens ? `${entry.completionTokens} tok` : "",
    ].filter(Boolean).join(" · ");
    return `<header>
        <span class="bm-live-task">${esc(entry.task)}</span>
        <span class="bm-muted">#${entry.index}/${entry.total}</span>
        ${why}
        <span class="bm-live-stats">${esc(stats)}</span>
        <span class="bm-live-verdict">${entry.correct ? "correct" : "wrong"}</span>
      </header>
      <div class="bm-live-answers">
        <span><em>expected</em> <code>${renderMath(entry.expected)}</code></span>
        <span><em>answered</em> <code>${entry.answer == null ? "—" : renderMath(entry.answer)}</code></span>
      </div>
      <div class="bm-live-question">${renderMath(entry.question)}</div>
      ${entry.reply ? `<details class="bm-live-reply"><summary>reply</summary><div>${renderMath(entry.reply)}</div></details>` : ""}`;
  }

  function renderRunningPanel(host) {
    const live = state.live;
    const status = state.status;
    if (!status || !status.running) {
      host.innerHTML = '<p class="bm-panel-empty">Nothing is running.</p>';
      return;
    }
    if (!live || !Array.isArray(live.entries)) {
      host.innerHTML = '<p class="bm-panel-empty">Waiting for the first scored question…</p>';
      return;
    }

    const entries = state.liveWrongOnly ? live.entries.filter((entry) => !entry.correct) : live.entries;
    const counts = live.counts || { scored: 0, wrong: 0 };
    // Rebuild only when the shape of the list changes. A poll lands every 1.5s,
    // and re-rendering wholesale threw away the scroll position inside whatever
    // question was being read.
    const signature = `${state.liveWrongOnly}|${live.model}|${status.activeVariant || ""}`;
    if (host.dataset.bmLiveSig !== signature) {
      host.dataset.bmLiveSig = signature;
      host.innerHTML = `<div class="bm-live-head">
          <div>
            <strong>${esc(live.model || status.currentModel || "")}</strong>
            <span class="bm-muted">${esc(status.activeVariant || "")} · <span id="bmLiveStage"></span></span>
          </div>
          <div class="bm-live-counts" id="bmLiveCounts"></div>
          <label class="bm-live-toggle">
            <input type="checkbox" id="bmLiveWrongOnly" ${state.liveWrongOnly ? "checked" : ""} />
            <span>Only what it got wrong</span>
          </label>
        </div>
        <div class="bm-live-list" id="bmLiveList"></div>
        <p class="bm-panel-empty ${entries.length ? "hidden" : ""}" id="bmLiveEmpty"></p>`;
    }

    const stage = host.querySelector("#bmLiveStage");
    if (stage) {
      stage.textContent = live.stage || status.currentStage || "";
    }
    const countsEl = host.querySelector("#bmLiveCounts");
    if (countsEl) {
      countsEl.innerHTML = `<span>${counts.scored} answered</span>
        <span class="bm-live-wrong">${counts.wrong} wrong</span>
        <span>${counts.scored ? Math.round(((counts.scored - counts.wrong) / counts.scored) * 100) : 0}% so far</span>`;
    }
    const empty = host.querySelector("#bmLiveEmpty");
    if (empty) {
      empty.textContent = state.liveWrongOnly ? "Nothing wrong yet." : "No questions scored yet.";
      empty.classList.toggle("hidden", Boolean(entries.length));
    }

    const list = host.querySelector("#bmLiveList");
    if (!list) {
      return;
    }
    // Append in order, the way a log does. Inserting at the top pushed whatever
    // you were reading down the page every couple of seconds; appending only
    // moves things if you are already at the bottom watching them arrive.
    const stickToBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
    for (const entry of entries.slice().sort((left, right) => (left.ts || 0) - (right.ts || 0))) {
      const key = `${entry.task}:${entry.index}`;
      if (list.querySelector(`[data-bm-live-key="${CSS.escape(key)}"]`)) {
        continue;
      }
      const item = document.createElement("article");
      item.className = `bm-live-item ${entry.correct ? "is-correct" : "is-wrong"}`;
      item.dataset.bmLiveKey = key;
      item.innerHTML = liveItemHtml(entry);
      list.append(item);
    }
    if (stickToBottom) {
      host.scrollTop = host.scrollHeight;
    }
  }

  let galleryHtmlSig = "";

  function renderGallery(host, results) {
    if (!host) {
      return;
    }
    const tiles = [];
    for (const row of visibleRows()) {
      for (const test of results.sceneTests || []) {
        const entry = row.scenes && row.scenes[test.id];
        if (!entry || entry.status !== "done" || !entry.file) {
          continue;
        }
        const src = `/api/perf-dashboard/voxel/file/${encodeURIComponent(entry.file)}`;
        tiles.push(`<figure class="bm-gallery-tile" data-bm-src="${esc(src)}" data-bm-title="${esc(row.model)} ${esc(test.id)}">
          <div class="bm-gallery-frame"></div>
          <figcaption>
            <a href="${esc(src)}" target="_blank" rel="noopener">${esc(row.model)}</a>
            <span>${esc(test.id)} · ${esc(row.thinkingBucket)} · ${clock(entry.elapsedMs)} · ${Math.round((entry.bytes || 0) / 1024)} KB</span>
          </figcaption>
        </figure>`);
      }
    }
    const html = tiles.join("") || '<p class="bm-muted">No completed scenes yet.</p>';
    // A poll lands every few seconds; rebuilding the tiles reloads every live
    // iframe and restarts its animation. Only do it when the tile list changed.
    if (galleryObserver && galleryHtmlSig === html && host.childElementCount) {
      return;
    }
    teardownGallery();
    galleryHtmlSig = html;
    host.innerHTML = html;

    galleryObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          mountGalleryFrame(entry.target);
        } else if (Math.abs(entry.boundingClientRect.top) > window.innerHeight * 1.5) {
          unmountGalleryFrame(entry.target);
        }
      }
    }, { root: q("bmPanelDetail"), rootMargin: "150px" });
    host.querySelectorAll(".bm-gallery-tile").forEach((tile) => galleryObserver.observe(tile));
  }

  // ---- score tooltip ------------------------------------------------------
  // One reused panel, positioned against the viewport rather than anchored to
  // the cell: the table scrolls in both axes, so a CSS-only tooltip pinned to
  // its row would be clipped by the scroll container on the right-hand columns
  // and the last rows.
  function tooltipHtml(row) {
    const results = activeResults();
    const catalog = new Map((results.benchmarks || []).map((entry) => [entry.id, entry]));
    const score = row.score;
    const lines = (score.components || []).map((component) => {
      const meta = catalog.get(component.id) || {};
      const detail = [];
      if (component.correct != null && component.n != null) {
        detail.push(`${component.correct}/${component.n}`);
      } else if (component.n != null) {
        detail.push(`n=${component.n}`);
      }
      if (component.margin != null) {
        detail.push(`±${(component.margin * 100).toFixed(1)}`);
      }
      detail.push(...(component.notes || []));
      return `<tr title="${esc(meta.blurb || "")}" class="${component.unreliable ? "is-unreliable" : ""}">
        <td>${esc(component.label)}${component.unreliable ? ' <span class="bm-score-warning">!</span>' : ""}</td>
        <td class="bm-tt-num">${num(component.raw, 3)}</td>
        <td class="bm-tt-weight">× ${num(component.weight, 2)}</td>
        <td class="bm-tt-num">→ ${num(component.contribution, 1)}</td>
        <td class="bm-tt-detail">${esc(detail.join(" · "))}</td>
      </tr>`;
    }).join("");

    const notRun = (score.notRun || []).length
      ? `<p class="bm-tt-foot">not run: ${esc(score.notRun.map((entry) => entry.label).join(", "))} — weights renormalized over Σw ${num(score.totalWeight, 2)}</p>`
      : "";
    const sample = [];
    if (score.sampleLimit) {
      sample.push(`${score.sampleLimit} questions per metric`);
    }
    sample.push(score.measuredOwnVariant === false
      ? `measured on the ${score.measuredBucket} variant and copied onto this row`
      : `measured on the ${row.thinkingBucket} variant`);

    return `<div class="bm-tt-head">
        <strong>${num(score.value, 0)} <span class="bm-tt-margin">±${score.margin == null ? "?" : num(score.margin, 0)}</span></strong>
        <span class="bm-tier bm-tier-${esc(score.tier || "A")}">tier ${esc(score.tier || "?")}</span>
        <span class="bm-tt-model">${esc(row.model)} · ${esc(row.variant)}</span>
      </div>
      <table class="bm-tt-table"><tbody>${lines}</tbody></table>
      ${notRun}
      <p class="bm-tt-foot">${esc(sample.join(" · "))}</p>`;
  }

  let tooltipAnchor = null;
  let tooltipPinned = false;
  let longPressFired = false;

  function showTooltip(anchor, row, pinned = false) {
    const tooltip = q("bmTooltip");
    tooltipAnchor = anchor;
    tooltipPinned = pinned;
    tooltip.innerHTML = tooltipHtml(row);
    tooltip.classList.remove("hidden");
    const rect = anchor.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const margin = 10;
    let left = rect.left;
    let top = rect.bottom + 8;
    if (left + box.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - box.width - margin);
    }
    if (top + box.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - box.height - 8);
    }
    tooltip.style.left = `${Math.max(margin, left)}px`;
    tooltip.style.top = `${top}px`;
  }

  // Per-row actions. The play button used to do exactly one thing; the scenes
  // were only reachable from an empty cell in their own column, which is not
  // where you look when you want to generate one.
  let rowMenuAnchor = null;

  function positionRowMenu() {
    const menu = q("bmRowMenu");
    if (menu.classList.contains("hidden") || !rowMenuAnchor || !rowMenuAnchor.isConnected) {
      return;
    }
    const rect = rowMenuAnchor.getBoundingClientRect();
    const scroller = q("bmTableScroll").getBoundingClientRect();
    // Anchor scrolled out of its own container: nothing left to point at.
    if (rect.bottom < scroller.top || rect.top > scroller.bottom) {
      hideRowMenu();
      return;
    }
    const box = menu.getBoundingClientRect();
    const margin = 10;
    let left = Math.max(margin, rect.right - box.width);
    let top = rect.bottom + 6;
    if (left + box.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - box.width - margin);
    }
    if (top + box.height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - box.height - 6);
    }
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  function openRowMenu(anchor, model, bucket) {
    const menu = q("bmRowMenu");
    const results = activeResults();
    const sceneTests = (results && results.sceneTests) || [];
    const busy = Boolean(state.status && state.status.running);
    const busyNote = busy ? ' title="A run is in progress; scenes drive the same slot"' : "";

    menu.innerHTML = `<div class="bm-row-menu-head">${esc(model)}<span>${esc(bucket)}</span></div>
      <button type="button" role="menuitem" data-bm-menu-action="benchmark">Run benchmark…</button>
      <div class="bm-row-menu-sep">Generate scene</div>
      ${sceneTests.map((test) => `<button type="button" role="menuitem"
        data-bm-menu-action="scene:${esc(test.id)}" ${busy ? "disabled" : ""}${busyNote}>${esc(test.label)}</button>`).join("")}`;
    menu.dataset.bmModel = model;
    menu.dataset.bmBucket = bucket;
    menu.classList.remove("hidden");
    rowMenuAnchor = anchor;
    positionRowMenu();
  }

  function hideRowMenu() {
    const menu = q("bmRowMenu");
    const hadFocus = menu.contains(document.activeElement);
    menu.classList.add("hidden");
    rowMenuAnchor = null;
    if (hadFocus && menuReturnFocus && menuReturnFocus.isConnected) {
      menuReturnFocus.focus();
    }
    menuReturnFocus = null;
  }

  q("bmRowMenu").addEventListener("keydown", (event) => {
    const menu = q("bmRowMenu");
    const items = [...menu.querySelectorAll("button:not([disabled])")];
    const current = items.indexOf(document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusMenuItem(menu, current + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusMenuItem(menu, current - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusMenuItem(menu, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusMenuItem(menu, items.length - 1);
    } else if (event.key === "Tab") {
      hideRowMenu();
    }
  });

  function hideTooltip() {
    tooltipAnchor = null;
    tooltipPinned = false;
    q("bmTooltip").classList.add("hidden");
  }

  function rowById(id) {
    const results = activeResults();
    return results ? results.rows.find((row) => row.id === id) || null : null;
  }

  // Stored rows are the ones with a directory on disk; inventory-only rows for
  // models that were never benchmarked have nothing to delete.
  function storedRowsForModel(label) {
    const results = activeResults();
    if (!results || !label) {
      return [];
    }
    return results.rows.filter((row) => row.model === label && row.resultDir);
  }

  function storedRowsById(id) {
    const row = rowById(id);
    return row && row.resultDir ? [row] : [];
  }

  // ---- launcher -----------------------------------------------------------

  function benchmarkOptionsHtml() {
    const results = activeResults();
    const catalog = (results && results.benchmarks) || [];
    const sceneTests = (results && results.sceneTests) || [];
    const quality = catalog.filter((entry) => entry.id !== "scenes").map((entry) => {
      const disabled = entry.available ? "" : "disabled";
      // Cost per question varies by an order of magnitude between metrics, and
      // it is the thing worth knowing before ticking a box, not after.
      const cost = entry.secondsPerQuestion
        ? ` · ~${entry.secondsPerQuestion}s/question`
        : (entry.fixedSeconds ? ` · ~${entry.fixedSeconds}s flat` : "");
      const note = entry.available
        ? `weight ${entry.weight.toFixed(2)}${cost}${entry.taskCount > 1 ? ` · ${entry.taskCount} subsets` : ""}`
        : "not available in the runner yet";
      return `<label class="bm-check ${entry.available ? "" : "is-disabled"}">
        <input type="checkbox" name="bmBenchmark" value="${esc(entry.id)}" ${entry.defaultOn && entry.available ? "checked" : ""} ${disabled} />
        <span><strong>${esc(entry.label)}</strong><small>${esc(entry.blurb)}${entry.warning ? ` ⚠ ${esc(entry.warning)}` : ""}</small><em>${esc(note)}</em></span>
      </label>`;
    }).join("");
    const scenes = sceneTests.map((test) => `<label class="bm-check">
      <input type="checkbox" name="bmBenchmark" value="scene:${esc(test.id)}" />
      <span><strong>${esc(test.label)}</strong><small>Generates a standalone page and times it. Runs after the measured benchmarks, on the same slot.</small></span>
    </label>`).join("");
    return `<div class="bm-check-grid">${quality}</div>
      <p class="bm-group-label">Scenes — timed, opened from the results table, and scored on whether the page renders rather than on how it looks.</p>
      <div class="bm-check-grid">${scenes}</div>`;
  }

  function collectLaunchConfig() {
    const benchmarks = Array.from(root.querySelectorAll('input[name="bmBenchmark"]:checked')).map((input) => input.value);
    const excludeRaw = q("bmExclude").value || "";
    return {
      models: Array.from(state.launchSelection),
      benchmarks,
      variants: q("bmVariantSelect").value,
      qualityLimit: Number(q("bmQualityLimit").value) || 200,
      selectedSlot: state.slot,
      contextSize: Number(q("bmContextSize").value) || 128000,
      parallel: Number(q("bmParallel").value) || 1,
      loadTimeout: Number(q("bmLoadTimeout").value) || 300,
      globalTimeout: Number(q("bmGlobalTimeout").value) || 300,
      throughputWindow: Number(q("bmThroughputWindow").value) || 60,
      throughputStallTimeout: Number(q("bmStallTimeout").value) || 10,
      slotCount: Number(q("bmSlotCount").value) || 3,
      excludeModelFilters: excludeRaw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
      thinkingVariants: q("bmGrammarVariants").checked,
    };
  }

  function renderModelList() {
    const host = q("bmModelList");
    const search = state.modelSearch.trim().toLowerCase();
    const benchmarked = new Set((activeResults()?.rows || []).filter((row) => !row.pending).map((row) => row.model));
    const items = state.inventory.filter((item) => !search || item.label.toLowerCase().includes(search));
    if (!items.length) {
      host.innerHTML = '<p class="bm-muted">No models discovered for this slot.</p>';
      return;
    }
    host.innerHTML = items.map((item) => `<label class="bm-model-row">
      <input type="checkbox" data-bm-model="${esc(item.label)}" ${state.launchSelection.has(item.label) ? "checked" : ""} />
      <span class="bm-model-row-name">${esc(item.label)}</span>
      <span class="bm-model-row-meta">${esc(item.sizeLabel)} · ${esc(item.runtime)}</span>
      <span class="bm-model-row-state">${benchmarked.has(item.label) ? "has results" : "—"}</span>
    </label>`).join("");
  }

  async function openLauncher(scopedModel) {
    q("bmBenchmarkOptions").innerHTML = benchmarkOptionsHtml();
    q("bmLaunchError").classList.add("hidden");
    state.modelSearch = "";
    q("bmModelSearch").value = "";
    q("bmLaunchModal").classList.remove("hidden");
    q("bmModelList").textContent = "Loading models…";

    try {
      const inventory = await getJson(`/api/perf-dashboard/inventory?slot=${encodeURIComponent(state.slot)}`);
      // Discovery lists one entry per variant; the picker is per model.
      const seen = new Set();
      state.inventory = (inventory.models || []).filter((item) => {
        if (seen.has(item.label) || !isBenchmarkable(item.label)) {
          return false;
        }
        seen.add(item.label);
        return true;
      });
    } catch (error) {
      state.inventory = [];
      showLaunchError(error.message || "Failed to list models.");
    }

    state.launchSelection = new Set();
    if (scopedModel) {
      state.launchSelection.add(scopedModel);
    } else if (state.selected.size) {
      for (const label of state.selected) {
        state.launchSelection.add(label);
      }
    }
    renderModelList();
    schedulePlan();
  }

  function closeLauncher() {
    q("bmLaunchModal").classList.add("hidden");
    window.clearTimeout(state.planTimer);
  }

  function showLaunchError(message) {
    const element = q("bmLaunchError");
    element.textContent = message;
    element.classList.remove("hidden");
  }

  function schedulePlan() {
    window.clearTimeout(state.planTimer);
    q("bmPlanSummary").textContent = "Resolving…";
    state.planTimer = window.setTimeout(async () => {
      const config = collectLaunchConfig();
      if (!config.models.length) {
        state.plan = null;
        q("bmPlanSummary").textContent = "Pick at least one model.";
        return;
      }
      try {
        const plan = await postJson("/api/perf-dashboard/plan", config);
        state.plan = plan;
        const variants = plan.variants.length;
        q("bmPlanSummary").textContent =
          `${plan.models} model${plan.models === 1 ? "" : "s"} × ${variants} variant${variants === 1 ? "" : "s"}`
          + ` ≈ ${duration(plan.estimateSeconds)}`
          + (plan.existing.length ? ` · ${plan.existing.length} row${plan.existing.length === 1 ? "" : "s"} already measured` : "");
      } catch (error) {
        state.plan = null;
        q("bmPlanSummary").textContent = error.message || "Could not resolve the plan.";
      }
    }, 250);
  }

  function updateSampleNote() {
    const limit = Math.max(1, Number(q("bmQualityLimit").value) || 200);
    const metrics = root.querySelectorAll('input[name="bmBenchmark"]:checked').length || 1;
    const margin = 1.96 * Math.sqrt(0.21 / limit) * 100;
    // The interval is the point of the number, so quote it rather than leaving
    // the choice to feel arbitrary.
    const verdict = margin > 10
      ? "wide enough that most of this fleet will look tied"
      : margin > 7
        ? "enough to separate the ends of the fleet, not the middle"
        : "tight enough to rank neighbours";
    q("bmSampleNote").textContent =
      `${limit} questions puts the 95% interval at about ±${margin.toFixed(1)} points — ${verdict}.`
      + ` Thinking rows run half the sample and generate several times more tokens, so they dominate the estimate.`
      + ` ${metrics} benchmark${metrics === 1 ? "" : "s"} selected.`;
  }

  async function submitLaunch() {
    const config = collectLaunchConfig();
    if (!config.models.length) {
      showLaunchError("Pick at least one model.");
      return;
    }
    if (!config.benchmarks.length) {
      showLaunchError("Pick at least one benchmark.");
      return;
    }
    const plan = state.plan;
    if (plan && plan.existing.length) {
      const confirmed = await confirmOverwrite(plan);
      if (!confirmed) {
        return;
      }
    }
    try {
      await postJson("/api/perf-dashboard/start", { ...config, force: true });
      closeLauncher();
      await refresh();
    } catch (error) {
      showLaunchError(error.message || "Failed to start the benchmark.");
    }
  }

  // One question, asked once, at the moment it matters — instead of a "force
  // re-run" checkbox that had to be understood before anything was chosen.
  function confirmOverwrite(plan) {
    return new Promise((resolve) => {
      const modal = q("bmConfirmModal");
      const models = plan.existingModels || [];
      q("bmConfirmBody").textContent =
        `${plan.existing.length} of the ${plan.rows.length} rows this run would produce already have results. `
        + `Running again overwrites them.`;
      q("bmConfirmList").innerHTML = models.slice(0, 12).map((label) => `<li>${esc(label)}</li>`).join("")
        + (models.length > 12 ? `<li class="bm-muted">and ${models.length - 12} more</li>` : "");
      modal.classList.remove("hidden");

      const finish = (value) => {
        modal.classList.add("hidden");
        q("bmConfirmYesBtn").removeEventListener("click", onYes);
        q("bmConfirmNoBtn").removeEventListener("click", onNo);
        resolve(value);
      };
      const onYes = () => finish(true);
      const onNo = () => finish(false);
      q("bmConfirmYesBtn").addEventListener("click", onYes);
      q("bmConfirmNoBtn").addEventListener("click", onNo);
    });
  }

  // ---- translation viewer -------------------------------------------------

  async function openTranslation(model, variant) {
    if (!state.translations) {
      state.translations = await getJson("/api/perf-dashboard/translations").catch(() => null);
    }
    if (!state.translations) {
      return;
    }
    const entry = (state.translations.entries || []).find((item) => item.model === model && item.variant === variant)
      || (state.translations.entries || []).find((item) => item.model === model);
    if (!entry) {
      return;
    }
    q("bmTranslationSubtitle").textContent = `${model} · ${entry.variant} · chrF ${num(entry.chrF, 3)}`;
    q("bmTranslationModelHeading").textContent = `${model} (${entry.variant})`;
    q("bmTranslationReference").textContent = state.translations.reference || "";
    q("bmTranslationModel").textContent = entry.translation || "";
    q("bmTranslationSource").textContent = state.translations.source || "";
    q("bmTranslationModal").classList.remove("hidden");
  }

  // ---- import / export ----------------------------------------------------

  function exportResults() {
    const results = activeResults();
    if (!results) {
      return;
    }
    const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `benchmark-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function enterImportedMode(payload, fileName) {
    state.imported = { payload, fileName };
    q("bmImportedBanner").classList.remove("hidden");
    q("bmImportedLabel").textContent = `Showing imported results from ${fileName} — nothing here is live.`;
    render();
  }

  function exitImportedMode() {
    state.imported = null;
    q("bmImportedBanner").classList.add("hidden");
    refresh();
  }

  // ---- events -------------------------------------------------------------

  on("bmSlotSelect", "change", (event) => {
    state.slot = event.target.value;
    persist(SLOT_KEY, state.slot);
    // Rows of the previous slot must not sit under the new slot's label while
    // the request is in flight.
    state.results = null;
    render();
    refresh();
  });

  q("bmFilterChips").addEventListener("click", (event) => {
    const button = event.target.closest("[data-bm-filter]");
    if (!button) {
      return;
    }
    const action = button.dataset.bmFilter;
    if (action === "clear") {
      state.statusFilter = "all";
      state.variantFilter = "all";
      state.compareOnly = false;
      state.search = "";
      q("bmSearch").value = "";
    } else if (action === "compare") {
      state.compareOnly = !state.compareOnly;
    } else if (action.startsWith("view:")) {
      state.view = action.slice(5);
      persist(VIEW_KEY, state.view);
    } else if (action.startsWith("variant:")) {
      state.variantFilter = action.slice(8);
    } else if (action.startsWith("status:")) {
      state.statusFilter = action.slice(7);
    }
    render();
  });

  on("bmSearch", "input", (event) => {
    state.search = event.target.value;
    renderTable();
  });

  on("bmRefreshBtn", "click", () => refresh());
  on("bmRunBtn", "click", () => openLauncher(null));

  on("bmCancelBtn", "click", async () => {
    try {
      await postJson("/api/perf-dashboard/cancel", {});
    } catch (error) {
      console.error("benchmarks: cancel failed", error);
    }
    refresh();
  });

  on("bmMenuBtn", "click", (event) => {
    event.stopPropagation();
    const menu = q("bmMenu");
    const open = menu.classList.toggle("hidden");
    q("bmMenuBtn").setAttribute("aria-expanded", String(!open));
  });

  on("bmMenu", "click", async (event) => {
    const action = event.target.closest("[data-bm-menu]");
    if (!action) {
      return;
    }
    q("bmMenu").classList.add("hidden");
    const kind = action.dataset.bmMenu;
    if (kind === "options") {
      // Same menu the table's right-click (or long-press) opens, anchored to
      // the button so it is reachable without a mouse. The click must stop
      // here: the document-level dismiss handler would otherwise close the
      // menu in the same gesture that opened it.
      event.stopPropagation();
      const rect = action.getBoundingClientRect();
      openContextMenu({
        target: q("bmTable"),
        clientX: rect.left,
        clientY: rect.bottom + 4,
      });
    } else if (kind === "import") {
      q("bmImportInput").click();
    } else if (kind === "export") {
      exportResults();
    } else if (kind === "summary") {
      window.open("/api/perf-dashboard/summary", "_blank", "noopener");
    } else if (kind === "clear") {
      if (!window.confirm("Delete every stored benchmark result? This cannot be undone.")) {
        return;
      }
      try {
        await postJson("/api/perf-dashboard/results/clear", {});
      } catch (error) {
        notify(error.message || "Failed to clear results.");
      }
      refresh();
    }
  });

  on("bmImportInput", "change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || !Array.isArray(payload.rows)) {
        throw new Error("That file is not a benchmark results export.");
      }
      enterImportedMode(payload, file.name);
    } catch (error) {
      notify(error.message || "Could not read that file.");
    }
    event.target.value = "";
  });

  on("bmImportedExitBtn", "click", exitImportedMode);

  on("bmRunToggle", "click", () => {
    const log = q("bmRunLog");
    const hidden = log.classList.toggle("hidden");
    q("bmRunToggle").setAttribute("aria-expanded", String(!hidden));
  });

  // Table interactions: sorting, comparison ticks, isolation, per-row actions.
  q("bmTable").addEventListener("mousedown", (event) => {
    const grip = event.target.closest("[data-bm-resize]");
    if (grip) {
      startModelResize(event, grip);
    }
  });

  q("bmTable").addEventListener("click", async (event) => {
    if (event.target.closest("[data-bm-resize]")) {
      return;
    }
    if (longPressFired) {
      // The tap that ends a long press must not also act on the row.
      longPressFired = false;
      event.stopPropagation();
      return;
    }

    // A phone has no hover, so the breakdown -- the whole point of the score
    // column -- would be unreachable there. Tap toggles it; on a mouse this is
    // a way to pin the panel open instead of chasing it with the pointer.
    const scoreBtn = event.target.closest(".bm-score");
    if (scoreBtn) {
      event.stopPropagation();
      const row = rowById(scoreBtn.dataset.bmScore);
      if (!row || !row.score) {
        return;
      }
      if (tooltipPinned && tooltipAnchor === scoreBtn) {
        hideTooltip();
      } else {
        showTooltip(scoreBtn, row, true);
      }
      return;
    }
    const sortHeader = event.target.closest("th[data-bm-sort]");
    if (sortHeader) {
      const key = sortHeader.dataset.bmSort;
      const numeric = key !== "model" && key !== "status";
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = { key, dir: numeric ? "desc" : "asc" };
      }
      persist(SORT_KEY, JSON.stringify(state.sort));
      renderTable();
      return;
    }

    const sceneRun = event.target.closest("[data-bm-scene-run]");
    if (sceneRun) {
      event.stopPropagation();
      sceneRun.disabled = true;
      try {
        await postJson("/api/perf-dashboard/voxel/rerun", {
          slotId: state.slot,
          model: sceneRun.dataset.bmLabel,
          test: sceneRun.dataset.bmSceneRun,
          thinking: sceneRun.dataset.bmBucket === "think",
        });
      } catch (error) {
        notify(error.message || "Failed to start that scene.");
        sceneRun.disabled = false;
      }
      refresh();
      return;
    }

    const rowMenu = event.target.closest("[data-bm-row-menu]");
    if (rowMenu) {
      event.stopPropagation();
      const same = q("bmRowMenu").dataset.bmModel === rowMenu.dataset.bmRowMenu
        && !q("bmRowMenu").classList.contains("hidden");
      if (same) {
        hideRowMenu();
      } else {
        openRowMenu(rowMenu, rowMenu.dataset.bmRowMenu, rowMenu.dataset.bmBucket || "no-think");
      }
      return;
    }

    const translation = event.target.closest("[data-bm-translation]");
    if (translation) {
      event.stopPropagation();
      openTranslation(translation.dataset.bmTranslation, translation.dataset.bmVariant);
      return;
    }

  });

  q("bmTable").addEventListener("change", (event) => {
    const select = event.target.closest("[data-bm-select]");
    if (!select) {
      return;
    }
    const label = select.dataset.bmSelect;
    if (select.checked) {
      state.selected.add(label);
    } else {
      state.selected.delete(label);
    }
    // Only re-render the table when the selection actually changes what is
    // shown. Otherwise ticking a box would rebuild every row -- swapping the
    // checkbox out from under the pointer mid-click.
    if (state.compareOnly) {
      renderTable();
    }
  });

  // Score breakdown on hover and on keyboard focus.
  q("bmTable").addEventListener("mouseover", (event) => {
    const anchor = event.target.closest(".bm-score");
    if (!anchor) {
      return;
    }
    const row = rowById(anchor.dataset.bmScore);
    if (row && row.score) {
      showTooltip(anchor, row);
    }
  });
  q("bmTable").addEventListener("mouseout", (event) => {
    // Leaving a score closes the panel only when the pointer is what opened
    // it. A tapped or clicked score stays up until it is dismissed.
    if (event.target.closest(".bm-score") && !tooltipPinned) {
      hideTooltip();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".bm-score") && !event.target.closest("#bmTooltip")) {
      hideTooltip();
    }
  }, true);
  q("bmTable").addEventListener("focusin", (event) => {
    const anchor = event.target.closest(".bm-score");
    if (anchor) {
      const row = rowById(anchor.dataset.bmScore);
      if (row && row.score) {
        showTooltip(anchor, row);
      }
    }
  });
  q("bmTable").addEventListener("focusout", hideTooltip);
  q("bmTableScroll").addEventListener("scroll", () => {
    hideTooltip();
    // Not hidden: clicking a button at the far right scrolls the table to bring
    // it into view, which used to close the menu in the same gesture that
    // opened it. Follow the row instead.
    positionRowMenu();
  }, { passive: true });

  q("bmPanelDetail").addEventListener("change", (event) => {
    if (event.target.id === "bmLiveWrongOnly") {
      state.liveWrongOnly = event.target.checked;
      renderDetail();
    }
  });

  // The view toggle and filter chips used to occupy a whole row above the table
  // for controls that are touched rarely. They live on the table's own context
  // menu now, alongside a re-run for whichever scene cell was right-clicked --
  // the "+" only ever appeared on empty cells, so a finished or failed scene had
  // no way back.
  function buildContextMenu(target) {
    const results = activeResults();
    const sceneTests = (results && results.sceneTests) || [];
    const parts = [];

    const sceneCell = target.closest(".bm-scene-cell");
    const row = target.closest("tr[data-bm-label]");
    if (sceneCell && row) {
      const index = [...sceneCell.parentElement.querySelectorAll(".bm-scene-cell")].indexOf(sceneCell);
      const test = sceneTests[index];
      if (test) {
        const link = target.closest(".bm-scene-link") || sceneCell.querySelector(".bm-scene-link");
        const bucketButton = sceneCell.querySelector("[data-bm-bucket]");
        const bucket = bucketButton ? bucketButton.dataset.bmBucket : (row.dataset.bmBucket || "no-think");
        parts.push(`<div class="bm-row-menu-head">${esc(test.label)}<span>${esc(row.dataset.bmLabel)}</span></div>`);
        parts.push(`<button type="button" data-bm-ctx="scene:${esc(test.id)}" data-bm-ctx-model="${esc(row.dataset.bmLabel)}" data-bm-ctx-bucket="${esc(bucket)}">Re-run this scene</button>`);
        if (link) {
          parts.push(`<button type="button" data-bm-ctx="open" data-bm-ctx-href="${esc(link.getAttribute("href"))}">Open the result</button>`);
        }
        parts.push('<div class="bm-row-menu-sep">Table</div>');
      }
    }

    parts.push(`<div class="bm-row-menu-sep">Layout</div>
      <button type="button" data-bm-ctx="view:model" class="${state.view === "model" ? "is-on" : ""}">By model</button>
      <button type="button" data-bm-ctx="view:variant" class="${state.view === "variant" ? "is-on" : ""}">By variant</button>`);
    if (state.view === "variant") {
      parts.push('<div class="bm-row-menu-sep">Variant</div>');
      for (const option of VARIANT_FILTERS) {
        parts.push(`<button type="button" data-bm-ctx="variant:${esc(option.id)}" class="${state.variantFilter === option.id ? "is-on" : ""}">${esc(option.label)}</button>`);
      }
    }
    parts.push('<div class="bm-row-menu-sep">Status</div>');
    for (const option of STATUS_FILTERS) {
      parts.push(`<button type="button" data-bm-ctx="status:${esc(option.id)}" class="${state.statusFilter === option.id ? "is-on" : ""}">${esc(option.label)}</button>`);
    }
    if (state.selected.size) {
      parts.push(`<div class="bm-row-menu-sep">Selection</div>
        <button type="button" data-bm-ctx="compare" class="${state.compareOnly ? "is-on" : ""}">${state.compareOnly ? "Show all models" : `Compare ${state.selected.size} selected`}</button>
        <button type="button" data-bm-ctx="clear">Clear selection and filters</button>`);
    }

    // Deleting stored results used to be all-or-nothing. These remove just the
    // rows you point at -- a smoke run, a model you deleted, a result you know
    // is garbage -- and say how many stored rows that is before doing it.
    const deletable = [];
    if (row) {
      const target = row.dataset.bmRow
        ? storedRowsById(row.dataset.bmRow)
        : storedRowsForModel(row.dataset.bmLabel);
      if (target.length) {
        deletable.push(`<button type="button" class="is-danger" data-bm-ctx="delete-row"
          data-bm-ctx-model="${esc(row.dataset.bmLabel)}" data-bm-ctx-row="${esc(row.dataset.bmRow || "")}"
          >Delete ${target.length === 1 ? "this result" : `these ${target.length} results`}</button>`);
      }
    }
    if (state.selected.size) {
      const selectedRows = [...state.selected].flatMap((label) => storedRowsForModel(label));
      if (selectedRows.length) {
        deletable.push(`<button type="button" class="is-danger" data-bm-ctx="delete-selected"
          >Delete results for ${state.selected.size} selected model${state.selected.size === 1 ? "" : "s"} (${selectedRows.length} row${selectedRows.length === 1 ? "" : "s"})</button>`);
      }
    }
    if (deletable.length) {
      parts.push('<div class="bm-row-menu-sep">Stored results</div>');
      parts.push(...deletable);
    }
    return parts.join("");
  }

  let menuReturnFocus = null;

  function focusMenuItem(menu, index) {
    const items = [...menu.querySelectorAll("button:not([disabled])")];
    if (!items.length) {
      return;
    }
    const next = ((index % items.length) + items.length) % items.length;
    items[next].focus();
  }

  function openContextMenu(event) {
    const menu = q("bmRowMenu");
    menuReturnFocus = document.activeElement;
    menu.innerHTML = buildContextMenu(event.target);
    menu.classList.remove("hidden");
    rowMenuAnchor = null;
    // Keyboard path: the first item takes focus, arrows move, Escape returns.
    focusMenuItem(menu, 0);
    const box = menu.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(event.clientX, window.innerWidth - box.width - margin);
    const top = Math.min(event.clientY, window.innerHeight - box.height - margin);
    menu.style.left = `${Math.max(margin, left)}px`;
    menu.style.top = `${Math.max(margin, top)}px`;
  }

  q("bmTable").addEventListener("contextmenu", (event) => {
    // Let the browser's own menu through on a live text selection; copying is
    // the more likely intent there.
    if (selectionInsideTable()) {
      return;
    }
    event.preventDefault();
    openContextMenu(event);
  });

  // The view switch, the variant/status filters and compare-only live on that
  // context menu, and a touch screen has no right-click to reach it with --
  // iOS in particular never fires contextmenu on a table cell. Long-press is
  // the equivalent gesture; "Table options" in the overflow menu is the
  // discoverable way to find it.
  (() => {
    let timer = null;
    let origin = null;
    const cancel = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      origin = null;
    };
    const table = q("bmTable");
    table.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || event.target.closest("button, input, a")) {
        return;
      }
      origin = { x: event.clientX, y: event.clientY, target: event.target };
      timer = setTimeout(() => {
        timer = null;
        if (!origin || selectionInsideTable()) {
          return;
        }
        longPressFired = true;
        openContextMenu({ target: origin.target, clientX: origin.x, clientY: origin.y });
      }, 500);
    }, { passive: true });
    table.addEventListener("pointermove", (event) => {
      // A scroll is not a long press.
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) {
        cancel();
      }
    }, { passive: true });
    table.addEventListener("pointerup", cancel, { passive: true });
    table.addEventListener("pointercancel", cancel, { passive: true });
    table.addEventListener("scroll", cancel, { passive: true, capture: true });
  })();

  q("bmRowMenu").addEventListener("click", async (event) => {
    const ctx = event.target.closest("[data-bm-ctx]");
    if (ctx) {
      const action = ctx.dataset.bmCtx;
      hideRowMenu();
      if (action.startsWith("view:")) {
        state.view = action.slice(5);
        persist(VIEW_KEY, state.view);
      } else if (action.startsWith("variant:")) {
        state.variantFilter = action.slice(8);
      } else if (action.startsWith("status:")) {
        state.statusFilter = action.slice(7);
      } else if (action === "compare") {
        state.compareOnly = !state.compareOnly;
      } else if (action === "clear") {
        state.compareOnly = false;
        state.selected.clear();
        state.variantFilter = "all";
        state.statusFilter = "all";
        state.search = "";
        q("bmSearch").value = "";
      } else if (action === "open") {
        window.open(ctx.dataset.bmCtxHref, "_blank", "noopener");
        return;
      } else if (action === "delete-row" || action === "delete-selected") {
        const targets = action === "delete-row"
          ? (ctx.dataset.bmCtxRow
            ? storedRowsById(ctx.dataset.bmCtxRow)
            : storedRowsForModel(ctx.dataset.bmCtxModel))
          : [...state.selected].flatMap((label) => storedRowsForModel(label));
        if (!targets.length) {
          return;
        }
        const names = [...new Set(targets.map((row) => `${row.model} · ${row.variant}`))];
        const preview = names.slice(0, 6).join("\n");
        const more = names.length > 6 ? `\n…and ${names.length - 6} more` : "";
        if (!window.confirm(`Delete ${targets.length} stored benchmark result${targets.length === 1 ? "" : "s"}?\n\n${preview}${more}\n\nThis removes the saved run from disk and cannot be undone.`)) {
          return;
        }
        try {
          await postJson("/api/perf-dashboard/results/delete", {
            dirs: targets.map((row) => row.resultDir),
          });
        } catch (error) {
          notify(error.message || "Failed to delete those results.");
          return;
        }
        if (action === "delete-selected") {
          state.selected.clear();
          state.compareOnly = false;
        }
        refreshNow();
        return;
      } else if (action.startsWith("scene:")) {
        try {
          await postJson("/api/perf-dashboard/voxel/rerun", {
            slotId: state.slot,
            model: ctx.dataset.bmCtxModel,
            test: action.slice(6),
            thinking: ctx.dataset.bmCtxBucket === "think",
          });
        } catch (error) {
          notify(error.message || "Failed to start that scene.");
        }
        refreshNow();
        return;
      }
      renderTable();
      return;
    }

    const item = event.target.closest("[data-bm-menu-action]");
    if (!item || item.disabled) {
      return;
    }
    const menu = q("bmRowMenu");
    const model = menu.dataset.bmModel;
    const bucket = menu.dataset.bmBucket || "no-think";
    const action = item.dataset.bmMenuAction;
    hideRowMenu();
    if (action === "benchmark") {
      openLauncher(model);
      return;
    }
    const test = action.slice("scene:".length);
    try {
      await postJson("/api/perf-dashboard/voxel/rerun", {
        slotId: state.slot,
        model,
        test,
        thinking: bucket === "think",
      });
    } catch (error) {
      notify(error.message || "Failed to start that scene.");
    }
    refreshNow();
  });

  q("bmPanelTabs").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-bm-panel]");
    if (!tab) {
      return;
    }
    state.panel = tab.dataset.bmPanel;
    hideTooltip();
    renderPanelTabs();
    renderActivePanel();
    if (state.panel === "running") {
      refreshNow();
    }
  });

  // Launcher wiring.
  on("bmLaunchCloseBtn", "click", closeLauncher);
  on("bmLaunchCancelBtn", "click", closeLauncher);
  on("bmLaunchSubmitBtn", "click", submitLaunch);
  root.querySelectorAll("[data-bm-variant-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      q("bmVariantSelect").value = button.dataset.bmVariantMode;
      root.querySelectorAll("[data-bm-variant-mode]").forEach((other) => {
        other.classList.toggle("active", other === button);
      });
      schedulePlan();
      updateSampleNote();
    });
  });
  on("bmQualityLimit", "input", () => { schedulePlan(); updateSampleNote(); });
  root.querySelectorAll("[data-bm-limit]").forEach((button) => {
    button.addEventListener("click", () => {
      q("bmQualityLimit").value = button.dataset.bmLimit;
      schedulePlan();
      updateSampleNote();
    });
  });
  on("bmGrammarVariants", "change", schedulePlan);
  on("bmModelSearch", "input", (event) => {
    state.modelSearch = event.target.value;
    renderModelList();
  });

  on("bmBenchmarkOptions", "change", () => {
    schedulePlan();
    updateSampleNote();
  });

  on("bmModelList", "change", (event) => {
    const input = event.target.closest("[data-bm-model]");
    if (!input) {
      return;
    }
    const label = input.dataset.bmModel;
    if (input.checked) {
      state.launchSelection.add(label);
    } else {
      state.launchSelection.delete(label);
    }
    schedulePlan();
  });

  root.querySelectorAll("[data-bm-models]").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.bmModels;
      const benchmarked = new Set((activeResults()?.rows || []).filter((row) => !row.pending).map((row) => row.model));
      state.launchSelection = new Set();
      if (mode === "all") {
        state.inventory.forEach((item) => state.launchSelection.add(item.label));
      } else if (mode === "new") {
        state.inventory.filter((item) => !benchmarked.has(item.label)).forEach((item) => state.launchSelection.add(item.label));
      }
      renderModelList();
      schedulePlan();
    });
  });

  root.querySelectorAll("[data-bm-close]").forEach((backdrop) => {
    backdrop.addEventListener("click", () => {
      const kind = backdrop.dataset.bmClose;
      if (kind === "launch") closeLauncher();
      if (kind === "translation") q("bmTranslationModal").classList.add("hidden");
    });
  });

  on("bmTranslationCloseBtn", "click", () => q("bmTranslationModal").classList.add("hidden"));
  on("bmTranslationSourceBtn", "click", () => {
    const pane = q("bmTranslationSource");
    const hidden = pane.classList.toggle("hidden");
    q("bmTranslationSourceBtn").textContent = hidden ? "Show English source" : "Hide English source";
  });

  const onDocumentClick = (event) => {
    if (!event.target.closest("#bmMenuBtn")) {
      q("bmMenu").classList.add("hidden");
    }
    if (!event.target.closest("#bmRowMenu") && !event.target.closest("[data-bm-row-menu]")) {
      hideRowMenu();
    }
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape") {
      return;
    }
    hideTooltip();
    hideRowMenu();
    q("bmMenu").classList.add("hidden");
    q("bmTranslationModal").classList.add("hidden");
    if (!q("bmConfirmModal").classList.contains("hidden")) {
      q("bmConfirmNoBtn").click();
      return;
    }
    closeLauncher();
  };
  // Scene previews report their own runtime failures through the shim injected
  // when the page is served; record them so the scene score can use them.
  // The shim posts more than failures -- it also sends a "poster" frame once the
  // scene has painted. Recording those as runtime errors zeroed the renders
  // signal for scenes that work perfectly.
  const SCENE_ERROR_KINDS = new Set(["error", "rejection", "resource"]);
  const onSceneMessage = (event) => {
    const data = event.data;
    if (!data || !data.__voxelScene || !SCENE_ERROR_KINDS.has(String(data.kind)) || !String(data.message || "").trim()) {
      return;
    }
    const frame = Array.from(root.querySelectorAll(".bm-gallery iframe"))
      .find((candidate) => candidate.contentWindow === event.source);
    if (!frame) {
      return;
    }
    const file = decodeURIComponent(String(frame.getAttribute("src") || "").split("/").pop() || "");
    postJson("/api/perf-dashboard/scene-error", {
      file,
      kind: data.kind,
      message: data.message,
      detail: data.detail,
    }).catch(() => { /* recording a preview error must never break the page */ });
  };

  const onVisibility = () => refreshNow();
  document.addEventListener("visibilitychange", onVisibility);
  // The host switches sections by toggling .active on the panes, which fires no
  // event of its own; watch the class instead so arriving on the tab refreshes.
  const sectionEl = document.getElementById("sec-benchmarks");
  const sectionObserver = sectionEl
    ? new MutationObserver(() => {
        if (sectionEl.classList.contains("active")) {
          refreshNow();
        }
      })
    : null;
  if (sectionObserver && sectionEl) {
    sectionObserver.observe(sectionEl, { attributes: true, attributeFilter: ["class"] });
  }

  const onSelectionChange = () => flushPendingTable();
  document.addEventListener("selectionchange", onSelectionChange);
  document.addEventListener("mouseup", onSelectionChange);

  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("message", onSceneMessage);

  q("bmSlotSelect").value = state.slot;
  updateSampleNote();
  refresh();
  schedulePoll();

  return function cleanup() {
    teardownGallery();
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("selectionchange", onSelectionChange);
    document.removeEventListener("mouseup", onSelectionChange);
    if (sectionObserver) {
      sectionObserver.disconnect();
    }
    window.clearTimeout(state.pollTimer);
    window.clearTimeout(state.planTimer);
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("message", onSceneMessage);
  };
}

class Llm3BenchmarksTab extends HTMLElement {
  connectedCallback() {
    if (this._mounted) {
      return;
    }
    this._mounted = true;
    // Light DOM on purpose: the tab is part of llm3, so it uses llm3's
    // stylesheet. Every id in here is bm-prefixed because the host page owns
    // the same document (it already has a #refreshBtn and a #launchModal).
    this.innerHTML = BENCHMARKS_TEMPLATE;
    this._cleanup = initBenchmarksTab(this);
  }

  disconnectedCallback() {
    if (typeof this._cleanup === "function") {
      this._cleanup();
      this._cleanup = null;
    }
    this._mounted = false;
  }
}

// The maths renderer is pure and has no DOM dependency, so it is exposed for
// testing rather than being reachable only through a mounted, running panel.
Llm3BenchmarksTab.renderMath = renderMath;

if (!customElements.get("llm3-benchmarks-tab")) {
  customElements.define("llm3-benchmarks-tab", Llm3BenchmarksTab);
}
