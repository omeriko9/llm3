// Streaming generation for the scene tests, with degeneracy detection.
//
// The tests used to POST with stream:false. Nothing at all was observable
// until the model finished, so a model that fell into a repetition loop looked
// exactly like a model doing careful work -- for as long as it took to reach
// the 65536-token cap, which is over an hour at 15 tok/s. The only artefact
// left behind was a truncated file and an hour of wall clock.
//
// Streaming buys three things the buffered path could not:
//   - a live transcript on disk while the run is still in flight;
//   - reasoning tokens counted separately from answer tokens, so "it thought
//     for 40k tokens" and "it wrote 40k tokens of HTML" stop looking alike;
//   - a loop detector that ends a degenerate run in seconds instead of an hour.
const http = require("http");

// Below this, a repeat is not evidence of anything: real HTML legitimately
// repeats short runs of markup while it is getting started.
const LOOP_MIN_TOKENS = 6_000;
// How much of the tail to examine. Long enough to hold several iterations of a
// realistic degenerate cycle, short enough that the check stays cheap when it
// runs every few hundred tokens.
const LOOP_WINDOW_CHARS = 6_000;
// Reasoning this long is not thinking about a pixel-art scene any more.
// Qwen3.5-4B completed the entire task -- reasoning and finished HTML -- in
// 6043 tokens. Set above the 8192 budget the GGUF slots now impose, so this
// only ever fires for runtimes that have no budget mechanism of their own:
// llama.cpp takes --reasoning-budget, MLX does not, and an MLX model that
// dithers would otherwise burn the entire token cap in silence.
const REASONING_RUNAWAY_TOKENS = 12_000;
// Run the (cheap, but not free) degeneracy checks this often rather than on
// every one of tens of thousands of deltas.
const CHECK_EVERY_TOKENS = 500;
// No bytes at all for this long means the backend has wedged; distinct from
// the overall budget, which a legitimately long run may need all of.
const STALL_TIMEOUT_MS = 180_000;

// A tail made of N consecutive copies of one block is the shape a stuck
// sampler produces. Checked across a range of periods because the cycle may be
// a few characters, a line, or a whole repeated element.
function tailRepeats(text) {
  const window = text.slice(-LOOP_WINDOW_CHARS);
  for (let period = 12; period <= 400; period += 1) {
    if (window.length < period * 4) {
      break;
    }
    const block = window.slice(-period);
    let copies = 1;
    for (let k = 2; k <= 8; k += 1) {
      const start = window.length - period * k;
      if (start < 0) {
        break;
      }
      if (window.slice(start, start + period) === block) {
        copies = k;
      } else {
        break;
      }
    }
    if (copies >= 4) {
      return { period, copies, block };
    }
  }
  return null;
}

// Exact-duplicate line ratio. Procedurally generated markup produces lines that
// differ in their arguments, so a tail that is mostly byte-identical lines is
// padding or a loop, not a dense scene.
function lineDiversity(text) {
  const lines = text.slice(-LOOP_WINDOW_CHARS)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 40) {
    return null;
  }
  const unique = new Set(lines).size;
  return { lines: lines.length, unique, ratio: unique / lines.length };
}

function detectDegenerate(state) {
  if (state.reasoningTokens >= REASONING_RUNAWAY_TOKENS) {
    return `reasoning ran to ${state.reasoningTokens} tokens without producing an answer`;
  }
  if (state.answerTokens < LOOP_MIN_TOKENS) {
    return "";
  }
  const answer = state.answer.join("");
  const repeat = tailRepeats(answer);
  if (repeat) {
    return `output repeated a ${repeat.period}-character block ${repeat.copies} times in a row`;
  }
  const diversity = lineDiversity(answer);
  if (diversity && diversity.ratio < 0.2) {
    return `only ${diversity.unique} distinct lines among the last ${diversity.lines} lines of output`;
  }
  return "";
}

function textOf(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(textOf).join("");
  }
  if (typeof value === "object") {
    if ("text" in value) {
      return textOf(value.text);
    }
    if ("content" in value) {
      return textOf(value.content);
    }
  }
  return String(value);
}

// Resolves rather than rejects when a run is cut short, so the caller can
// record *why* alongside everything that was captured before the cut.
function postSseLong(url, requestBody, timeoutMs, hooks = {}) {
  const { onRequest, onProgress } = hooks;
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const body = { ...requestBody, stream: true, stream_options: { include_usage: true } };
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    const startedAt = Date.now();
    const state = {
      answer: [],
      reasoning: [],
      answerTokens: 0,
      reasoningTokens: 0,
      finishReason: "",
      usage: null,
      abortReason: "",
      firstTokenMs: 0,
      deltas: 0,
    };
    let settled = false;
    let lastCheckAt = 0;
    let budgetTimer = null;
    let request = null;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (budgetTimer) {
        clearTimeout(budgetTimer);
      }
      resolve(result);
    };

    const summarise = (extra = {}) => {
      const content = state.answer.join("");
      const reasoning = state.reasoning.join("");
      const completionTokens = state.usage && Number(state.usage.completion_tokens)
        ? Number(state.usage.completion_tokens)
        : state.answerTokens + state.reasoningTokens;
      return {
        ok: true,
        status: 200,
        body: {
          choices: [{ message: { content }, finish_reason: state.finishReason }],
          usage: state.usage || { completion_tokens: completionTokens },
        },
        text: content,
        stream: {
          reasoning,
          answerTokens: state.answerTokens,
          reasoningTokens: state.reasoningTokens,
          completionTokens,
          finishReason: state.finishReason,
          abortReason: state.abortReason,
          firstTokenMs: state.firstTokenMs,
          elapsedMs: Date.now() - startedAt,
          ...extra,
        },
      };
    };

    const abortWith = (reason) => {
      if (settled || state.abortReason) {
        return;
      }
      state.abortReason = reason;
      // destroy() ends the socket; the 'close' handler resolves with whatever
      // was captured, so the transcript up to the cut is preserved.
      if (request) {
        request.destroy();
      }
    };

    const handleDelta = (kind, text) => {
      if (!text) {
        return;
      }
      if (!state.firstTokenMs) {
        state.firstTokenMs = Date.now() - startedAt;
      }
      if (kind === "reasoning") {
        state.reasoning.push(text);
        state.reasoningTokens += 1;
      } else {
        state.answer.push(text);
        state.answerTokens += 1;
      }
      state.deltas += 1;
      const total = state.answerTokens + state.reasoningTokens;
      if (typeof onProgress === "function") {
        onProgress({ kind, text, ...state, total });
      }
      if (total - lastCheckAt >= CHECK_EVERY_TOKENS) {
        lastCheckAt = total;
        const reason = detectDegenerate(state);
        if (reason) {
          abortWith(reason);
        }
      }
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) {
        return;
      }
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") {
        return;
      }
      let node;
      try {
        node = JSON.parse(data);
      } catch (_error) {
        return;
      }
      if (node && node.usage) {
        state.usage = node.usage;
      }
      const choices = Array.isArray(node && node.choices) ? node.choices : [];
      for (const choice of choices) {
        if (!choice || typeof choice !== "object") {
          continue;
        }
        if (choice.finish_reason) {
          state.finishReason = String(choice.finish_reason);
        }
        const delta = choice.delta || choice.message;
        if (!delta || typeof delta !== "object") {
          continue;
        }
        const reasoning = textOf(delta.reasoning_content) || textOf(delta.reasoning);
        if (reasoning) {
          handleDelta("reasoning", reasoning);
        }
        const content = textOf(delta.content);
        if (content) {
          handleDelta("answer", content);
        }
      }
    };

    request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": payload.length,
        },
      },
      (response) => {
        const contentType = String(response.headers["content-type"] || "");
        const streaming = /text\/event-stream/i.test(contentType);
        if (!streaming) {
          // A backend that ignored stream:true sends one JSON body. Keep the
          // buffered behaviour rather than failing the model over it.
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
            finish({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode,
              body: parsed,
              text,
              stream: { unsupported: true, elapsedMs: Date.now() - startedAt },
            });
          });
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => finish({
            ok: false,
            status: response.statusCode,
            body: null,
            text: Buffer.concat(chunks).toString("utf8"),
            stream: { elapsedMs: Date.now() - startedAt },
          }));
          return;
        }
        let buffer = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            handleLine(buffer.slice(0, index));
            buffer = buffer.slice(index + 1);
          }
        });
        response.on("end", () => {
          if (buffer) {
            handleLine(buffer);
          }
          finish(summarise());
        });
        response.on("close", () => finish(summarise()));
        response.on("error", () => finish(summarise()));
      },
    );

    // Idle-socket timeout is a stall detector here, not the budget: a healthy
    // stream delivers bytes continuously.
    request.setTimeout(STALL_TIMEOUT_MS, () => {
      abortWith(`no output for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`);
    });
    budgetTimer = setTimeout(() => {
      abortWith(`generation exceeded ${Math.round(timeoutMs / 1000)}s`);
    }, timeoutMs);

    request.on("error", (error) => {
      // A destroy() we asked for surfaces here; the captured transcript is the
      // useful result, so report it instead of the socket error.
      if (state.abortReason) {
        finish(summarise());
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      if (budgetTimer) {
        clearTimeout(budgetTimer);
      }
      reject(error);
    });
    if (typeof onRequest === "function") {
      onRequest(request);
    }
    request.write(payload);
    request.end();
  });
}

module.exports = {
  postSseLong,
  detectDegenerate,
  tailRepeats,
  lineDiversity,
  LOOP_MIN_TOKENS,
  REASONING_RUNAWAY_TOKENS,
};
