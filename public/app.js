/* ===================================================================
   llm3 -- Modal Launch Frontend
   =================================================================== */

const ALL_APPLICATION_DEFINITIONS = [
  {
    key: "hermes",
    label: "Hermes Agent",
    badgeLabel: "Hermes",
    description: "Updates the Hermes Agent on the remote machine.",
    slotKind: "llm",
  },
  {
    key: "hermesm4",
    label: "Hermes M4",
    badgeLabel: "Hermes M4",
    description: "Updates local ~/.hermes/config.yaml with selected model and base_url.",
    slotKind: "llm",
  },
  {
    key: "compaction",
    label: "Compaction",
    badgeLabel: "Compaction",
    description: "Points the remote Hermes compaction model at the selected slot.",
    slotKind: "llm",
  },
  {
    key: "compactionm4",
    label: "Compaction M4",
    badgeLabel: "Compaction M4",
    description: "Points the local Hermes compaction model at the selected slot.",
    slotKind: "llm",
  },
  {
    key: "remotejsonapp",
    label: "Remote JSON app",
    badgeLabel: "Remote JSON app",
    description: "Rewrites the app's llm_config.json over SSH and restarts its PM2 apps.",
    slotKind: "llm",
  },
  {
    key: "sqliteapp",
    label: "SQLite app",
    badgeLabel: "SQLite app",
    description: "Writes the LLM endpoint into the app's SQLite settings and restarts its PM2 app.",
    slotKind: "llm",
  },
  {
    key: "librechat",
    label: "LibreChat",
    badgeLabel: "LibreChat",
    description: "Rewrites librechat.yaml and restarts the LibreChat container.",
    slotKind: "llm",
  },
  {
     key: "claudecode",
     label: "Claude Code",
     badgeLabel: "Claude Code",
     description: "Updates the local Claude proxy and restarts it.",
     slotKind: "llm",
   },
   {
     key: "voiceapp",
     label: "Voice app",
     badgeLabel: "Voice app",
     description: "Restarts the app's PM2 process with the selected LLM endpoint.",
     slotKind: "llm",
   },
   {
     key: "podcastg",
     label: "PodG",
     badgeLabel: "PodG",
     description: "Updates the dedicated local podG Hermes profile with the selected LLM endpoint.",
     slotKind: "llm",
   },
   {
     key: "podgag",
     label: "PodG-AG",
     badgeLabel: "PodG-AG",
     description: "Updates the dedicated local podG AutoGen Hermes profile used for subject selection and accept/reject decisions.",
     slotKind: "llm",
   },
   {
     key: "hermespc",
     label: "Hermes PC",
     badgeLabel: "Hermes PC",
     description: "Updates Hermes on the Gaming PC (AppData\\Local\\hermes\\config.yaml).",
     slotKind: "llm",
     machine: "gaming",
   },
   {
     key: "opencodepc",
     label: "OpenCode PC",
     badgeLabel: "OpenCode PC",
     description: "Updates OpenCode on the Gaming PC (.config\\opencode\\opencode.jsonc).",
     slotKind: "llm",
     machine: "gaming",
   },
   {
     key: "omppc",
     label: "OMP PC",
     badgeLabel: "OMP PC",
     description: "Updates OMP on the Gaming PC (.omp\\agent\\models.yaml).",
     slotKind: "llm",
     machine: "gaming",
   },
   {
     key: "pipc",
     label: "PI PC",
     badgeLabel: "PI PC",
     description: "Updates PI on the Gaming PC (.pi\\agent\\models.json).",
     slotKind: "llm",
     machine: "gaming",
   },
   {
     key: "voicetts",
     label: "Voice (TTS)",
     badgeLabel: "Voice TTS",
     description: "Sets Hermes TTS to the selected voice TTS slot.",
     slotKind: "voice",
     visibleInApplications: false,
   },
   {
     key: "voicestt",
     label: "Voice (STT)",
     badgeLabel: "Voice STT",
     description: "Sets Hermes STT to the selected voice STT slot.",
     slotKind: "voice",
     visibleInApplications: false,
   },
 ];
const APPLICATION_DEFINITIONS = ALL_APPLICATION_DEFINITIONS.filter((application) => application.visibleInApplications !== false);
const VOICE_APPLICATION_DEFINITIONS = ALL_APPLICATION_DEFINITIONS.filter((application) => application.slotKind === "voice");
// `machine` mirrors APPLICATION_DEFINITIONS in src/server.js -- it is the box
// whose config file the launch actually rewrites, and the launch modal groups
// the routing toggles by it.
const LLM_APPLICATION_FLAGS = [
  { appKey: "hermes", field: "setHermes", label: "Hermes Agent", machine: "inuc" },
  { appKey: "compaction", field: "setCompaction", label: "Compaction", machine: "inuc" },
  { appKey: "remotejsonapp", field: "setRemoteJsonApp", label: "Remote JSON app", machine: "inuc" },
  { appKey: "librechat", field: "setLibreChat", legacyField: "setChat", label: "LibreChat", machine: "inuc" },
  { appKey: "hermesm4", field: "setHermesM4", label: "Hermes M4", machine: "m4" },
  { appKey: "compactionm4", field: "setCompactionM4", label: "Compaction M4", machine: "m4" },
  { appKey: "sqliteapp", field: "setSqliteApp", label: "SQLite app", machine: "m4" },
  { appKey: "claudecode", field: "setClaudeCode", legacyField: "setOpenClaude", label: "Claude Code", machine: "m4" },
  { appKey: "voiceapp", field: "setVoiceApp", label: "Voice app", machine: "m4" },
  { appKey: "podcastg", field: "setPodcastG", label: "PodG", machine: "m4" },
  { appKey: "podgag", field: "setPodGAutoGen", label: "PodG-AG", machine: "m4" },
  { appKey: "hermespc", field: "setHermesPc", label: "Hermes", machine: "gaming" },
  { appKey: "opencodepc", field: "setOpenCodePc", label: "OpenCode", machine: "gaming" },
  { appKey: "omppc", field: "setOmpPc", label: "OMP", machine: "gaming" },
  { appKey: "pipc", field: "setPiPc", label: "PI", machine: "gaming" },
];
// Only the fallback for a first paint before /api/overview lands. The real
// labels come from the server, which reads LLM3_LOCAL_LABEL / LLM3_REMOTE_LABEL,
// so a machine's name is configured in one place rather than written twice.
const LLM_APPLICATION_MACHINES = [
  { key: "inuc", label: "Remote", host: "" },
  { key: "m4", label: "Local", host: "this machine" },
  { key: "gaming", label: "Gaming PC", host: "" },
];
const MODEL_COLOR_WHEEL_SIZE = 180;
const SAMPLING_DEFAULTS = Object.freeze({
  temperature: 0.6,
  topP: 0.95,
  topK: 20,
  minP: 0.0,
  presencePenalty: 0.0,
  repetitionPenalty: 1.0,
});
const VOICE_TTS_TUNING_FIELDS = Object.freeze([
  { field: "exaggeration", label: "Exaggeration", min: 0, max: 2, step: 0.05, defaultValue: 0.5, help: "Controls prosody intensity." },
  { field: "cfgWeight", label: "CFG weight", min: 0, max: 1, step: 0.05, defaultValue: 0.5, help: "Higher values follow the prompt more strictly." },
  { field: "temperature", label: "Temperature", min: 0.1, max: 2, step: 0.05, defaultValue: 0.8, help: "Higher values add more variation." },
  { field: "repetitionPenalty", label: "Repetition penalty", min: 1, max: 5, step: 0.05, defaultValue: 2, help: "Discourages repetitive phrasing." },
  { field: "minP", label: "Min-P", min: 0, max: 1, step: 0.01, defaultValue: 0.05, help: "Trims very low-probability tokens." },
  { field: "topP", label: "Top-P", min: 0, max: 1, step: 0.01, defaultValue: 1, help: "Nucleus sampling cutoff." },
  { field: "seed", label: "Seed", min: -1, max: 2147483647, step: 1, defaultValue: 1234, help: "Fixes the sampler so output is reproducible. Same number = same delivery; change it for a different but still-consistent take; -1 = random each request." },
  { field: "ttsChunkSize", label: "Podcast chunk size", min: 10, max: 1000, step: 10, defaultValue: 400, help: "Max spoken characters per podG TTS request.", inputType: "range", valueSuffix: " chars" },
]);
const VOICE_TTS_TUNING_FIELD_NAMES = new Set(VOICE_TTS_TUNING_FIELDS.map((entry) => entry.field));
const VOICE_TTS_TUNING_MODEL_KEYS = new Set([
  "chatterbox",
  "chatterbox-resemble",
  "chatterbox-multilingual",
  "phonikud-chatterbox",
  "phonikud-upstream",
]);
const PRESENCE_PENALTY_BY_THINKING = Object.freeze({
  enabled: 0.0,
  disabled: 1.5,
});

// Sampling presets for different thinking modes (Qwen3.6 recommended values)
const SAMPLING_PRESETS = Object.freeze({
  nonThinking: {
    label: "Non-thinking (Instruct)",
    thinking: false,
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    minP: 0.0,
    presencePenalty: 1.5,
    repetitionPenalty: 1.0,
  },
  thinking: {
    label: "Thinking (Standard)",
    thinking: true,
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    minP: 0.0,
    presencePenalty: 0.0,
    repetitionPenalty: 1.0,
  },
  thinkingPrecise: {
    label: "Thinking (Precise Code)",
    thinking: true,
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
    minP: 0.0,
    presencePenalty: 0.0,
    repetitionPenalty: 1.0,
  },
});

const state = {
  models: [],
  slots: [],
  voiceModels: [],
  voiceSlots: [],
  system: null,
  modelColors: loadPersistedModelColors(),
  profiles: [],
  defaultProfileId: "",
  activeProfileId: "",
  preferredLaunchers: {},
  selectedProfileId: "",
  applications: [],
  applicationTargets: { hermes: "slot1", hermesm4: "slot1", compaction: "slot1", compactionm4: "slot1", remotejsonapp: "slot1", sqliteapp: "slot1", librechat: "slot1", claudecode: "slot1", voiceapp: "slot1", podcastg: "slot1", podgag: "slot1" },
  applicationMachines: [],
  applicationFeedback: {},
  applicationDrafts: {},
  applicationDirty: {},
  integrationTargets: { hermes: "slot1", openclaude: "slot1", chat: "slot1" },
  logs: {},
  // slotId -> { busy, source }; filled by refreshSlotActivity from /api/slots/activity.
  slotActivity: {},
  thinkingClearOffsets: loadPersistedThinkingClearOffsets(),
  activeFilter: "all",
  modelSearch: "",
  modelSort: { field: "runtime", direction: "asc" },
  modelView: "table",
  modelViewTouched: false,
  modelsPane: getPersistedModelsPane(),
  activeSection: "models",
  activeLogSlotId: "slot1",
  activeLogKind: "thinking",
  activeVoiceFilter: "all",
  voiceLaunchDrafts: loadPersistedVoiceLaunchDrafts(),
  activeVoiceLogSlotId: "voice-tts-1",
  activeVoiceLogKind: "server",
  logsPaused: false,
  actionInFlight: false,
  hermesStatus: {
    remote: null,
    local: null,
    updatedAt: "",
    loading: false,
  },
  benchmarkStartInFlight: {},
  voiceBenchmark: {
    text: loadPersistedVoiceBenchmarkText(),
    slotId: "voice-tts-1",
    audioFormat: "wav",
    sampleRate: 24000,
    selectedModelKeys: loadPersistedVoiceBenchmarkModelKeys(),
    selectedVoices: loadPersistedVoiceBenchmarkVoices(),
    selectedTunings: loadPersistedVoiceBenchmarkTunings(),
    queue: loadPersistedVoiceBenchmarkQueue(),
    serverState: null,
    loading: false,
  },
  voiceTuningModal: {
    open: false,
    scope: "voice",
    modelKey: "",
    values: {},
    disabled: false,
    voiceLibrary: {
      loading: false,
      busy: false,
      error: "",
      statusMessage: "",
      statusTone: "",
      defaultVoice: "",
      voices: [],
      draftName: "",
      selectedFileName: "",
      selectedFileDataUrl: "",
      selectedFileSize: 0,
    },
  },
  connected: false,
  editingApplications: false,
  applicationEditTimeout: null,
  refreshPausedUntil: 0,
  hf: {
    query: "",
    sort: "downloads",
    direction: "desc",
    results: [],
    favoriteIds: loadPersistedHfFavorites(),
    favoriteEntries: loadPersistedHfFavoriteEntries(),
    favoritesOnly: getPersistedHfFavoritesOnly(),
    appliedFavoritesQuery: "",
    hydratingFavorites: false,
    mobilePane: "results",
    mobilePaneTouched: false,
    splitRatio: 0.68,
    downloads: [],
    downloadsCollapsed: false,
    downloadsCollapseTouched: false,
    loading: false,
    error: "",
    hasLoaded: false,
    convertModalOpen: false,
    convertCandidate: null,
    convertSubmitting: false,
  },
  diagnostics: {
    entries: [],
    updatedAt: "",
    error: "",
    loading: false,
  },
  hermesFeedModal: {
    open: false,
    runtime: "",
    label: "",
    hostLabel: "",
    state: "offline",
    online: false,
    working: false,
    serviceState: "",
    sessionId: "",
    updatedAt: "",
    entries: [],
    loading: false,
    error: "",
    autoScroll: true,
  },
  launchersModal: {
    open: false,
    loading: false,
    error: "",
    launchers: [],
    updatingKey: "",
  },
  // Inline rename of one slot title in the Models tab strip.
  slotRename: { slotId: "", value: "" },
  // The caret next to the Profiles subtab.
  profileMenuOpen: false,
  // Right-click on the Profiles subtab: save what is loaded right now.
  saveLayoutModal: {
    open: false,
    targetProfileId: "",
    name: "",
  },
  launcherCommandPreview: {
    open: false,
    launcherKey: "",
    title: "",
    command: "",
  },
  actionResultModal: {
    open: false,
    status: "success",
    title: "",
    subtitle: "",
    summary: "",
    output: "",
    error: "",
    syncEntries: [],
  },
  profileModal: {
    open: false,
    profileId: "",
    name: "",
    color: "",
    colorPickerOpen: false,
    colorDraft: "",
    isDefault: false,
    activeSlotId: "slot1",
    slots: {},
    voiceSlots: {},
  },
  modal: {
    open: false,
    modelKey: null,
    slotId: "slot1",
    entryPoint: "model",
    form: null,
    colorPickerOpen: false,
    colorDraft: "",
    // null = show the stored name; a string = the user is editing it.
    slotNameDraft: null,
  },
  modelApplicationPreferences: {},
  slotApplicationPreferences: {},
  websites: [],
  websiteContext: { id: null, x: 0, y: 0 },
  websiteView: "boxes", // boxes or table
  websiteSearch: "",
  websiteSettingsId: null,
  pm2Category: "All",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// Tab persistence
const VALID_SECTIONS = ["models", "huggingface-models", "voice", "status", "system", "logs", "diagnostics", "applications", "benchmarks", "voice-benchmark", "websites", "pm2"];
const SECTION_TITLES = {
  models: "Models",
  "huggingface-models": "Huggingface Models",
  status: "Status",
  system: "System",
  logs: "Logs",
  diagnostics: "Diagnostics",
  applications: "Applications",
  benchmarks: "Benchmarks",
  "voice-benchmark": "Voice Benchmark",
  voice: "Voice",
  websites: "Websites",
  pm2: "PM2",
};
const PRESERVED_SCROLL_SELECTORS = [
  ".section.active",
  "#modelGrid .table-scroll",
  "#hfResults",
  "#hfResults .table-scroll",
  "#hfDownloads",
  "#applicationsContent .table-scroll",
  "#trafficLog",
  "#serverLog",
  "#proxyLog",
  "#diagnosticsFeed",
  "#hermesFeedModal .modal-body",
  "#actionResultModal .modal-body",
  "#launchModal .modal-body",
  "#profileModal .modal-body",
  "#voiceTuningModal .modal-body",
];
const WHEEL_SCROLL_CONTAINER_SELECTOR = [
  ".table-scroll",
  ".log-content",
  ".section",
  ".sidebar",
  ".modal-body",
  "#hfDownloads",
  ".log-tabs",
].join(", ");
const THINKING_CLEAR_OFFSETS_KEY = "llm3.thinkingClearOffsets";

function getPersistedSection() {
  // A hash like #voice-benchmark deep-links to a tab and wins over the saved one.
  const fromHash = String(window.location.hash || "").replace(/^#/, "").trim();
  if (VALID_SECTIONS.includes(fromHash)) {
    return fromHash;
  }
  try {
    const saved = localStorage.getItem("activeSection");
    return VALID_SECTIONS.includes(saved) ? saved : "models";
  } catch (e) {
    // localStorage unavailable (private mode, quota exceeded, etc.)
    return "models";
  }
}

function persistSection(section) {
  try {
    if (VALID_SECTIONS.includes(section)) {
      localStorage.setItem("activeSection", section);
    }
  } catch (e) {
    // Silently fail - localStorage unavailable
  }
}

function getPersistedModelsPane() {
  try {
    const saved = localStorage.getItem("modelsPane");
    return saved === "profiles" ? "profiles" : "models";
  } catch (_error) {
    return "models";
  }
}

function persistModelsPane(pane) {
  try {
    localStorage.setItem("modelsPane", pane === "profiles" ? "profiles" : "models");
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function loadPersistedThinkingClearOffsets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THINKING_CLEAR_OFFSETS_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([slotId, value]) => [String(slotId || "").trim(), Number(value)])
        .filter(([slotId, value]) => slotId && Number.isFinite(value) && value >= 0)
    );
  } catch (_error) {
    return {};
  }
}

function persistThinkingClearOffsets() {
  try {
    localStorage.setItem(THINKING_CLEAR_OFFSETS_KEY, JSON.stringify(state.thinkingClearOffsets || {}));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function downloadTextFile(fileName, text, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([String(text || "")], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function loadPersistedVoiceBenchmarkText() {
  try {
    return String(localStorage.getItem("voiceBenchmark.text") || "").trim();
  } catch (_error) {
    return "";
  }
}

function persistVoiceBenchmarkText(value) {
  try {
    localStorage.setItem("voiceBenchmark.text", String(value || ""));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function loadPersistedVoiceBenchmarkModelKeys() {
  try {
    const parsed = JSON.parse(localStorage.getItem("voiceBenchmark.modelKeys") || "[]");
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
  } catch (_error) {
    return [];
  }
}

function persistVoiceBenchmarkModelKeys(values) {
  try {
    const normalized = Array.isArray(values)
      ? [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    localStorage.setItem("voiceBenchmark.modelKeys", JSON.stringify(normalized));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function loadPersistedVoiceBenchmarkVoices() {
  try {
    const parsed = JSON.parse(localStorage.getItem("voiceBenchmark.voices") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [String(key || "").trim(), String(value || "").trim()])
        .filter(([key, value]) => key && value)
    );
  } catch (_error) {
    return {};
  }
}

function persistVoiceBenchmarkVoices(value) {
  try {
    const normalized = value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
        Object.entries(value)
          .map(([key, voice]) => [String(key || "").trim(), String(voice || "").trim()])
          .filter(([key, voice]) => key && voice)
      )
      : {};
    localStorage.setItem("voiceBenchmark.voices", JSON.stringify(normalized));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function loadPersistedVoiceBenchmarkQueue() {
  try {
    const parsed = JSON.parse(localStorage.getItem("voiceBenchmark.queue") || "[]");
    return Array.isArray(parsed)
      ? parsed
        .map((entry) => ({ modelKey: String(entry?.modelKey || "").trim(), voiceName: String(entry?.voiceName || "").trim() }))
        .filter((entry) => entry.modelKey)
      : [];
  } catch (_error) {
    return [];
  }
}

function persistVoiceBenchmarkQueue(queue) {
  try {
    localStorage.setItem("voiceBenchmark.queue", JSON.stringify(Array.isArray(queue) ? queue : []));
  } catch (_error) {
    // ignore
  }
}

function loadPersistedVoiceBenchmarkTunings() {
  try {
    const parsed = JSON.parse(localStorage.getItem("voiceBenchmark.tunings") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => {
          const modelKey = String(key || "").trim();
          if (!modelKey || !value || typeof value !== "object" || Array.isArray(value) || !voiceModelSupportsTuning(modelKey)) {
            return null;
          }
          return [modelKey, normalizeVoiceTtsTuningDraft(value, modelKey)];
        })
        .filter(Boolean)
    );
  } catch (_error) {
    return {};
  }
}

function persistVoiceBenchmarkTunings(value) {
  try {
    const normalized = value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .map(([key, tuning]) => {
              const modelKey = String(key || "").trim();
              if (!modelKey || !tuning || typeof tuning !== "object" || Array.isArray(tuning) || !voiceModelSupportsTuning(modelKey)) {
                return null;
              }
              return [modelKey, normalizeVoiceTtsTuningDraft(tuning, modelKey)];
            })
            .filter(Boolean)
        )
      : {};
    localStorage.setItem("voiceBenchmark.tunings", JSON.stringify(normalized));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function loadPersistedVoiceLaunchDrafts() {
  try {
    const parsed = JSON.parse(localStorage.getItem("voiceLaunchDrafts") || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { tts: {}, stt: {} };
    }
    const ttsDraft = parsed.tts && typeof parsed.tts === "object" && !Array.isArray(parsed.tts)
      ? parsed.tts
      : {};
    const sttDraft = parsed.stt && typeof parsed.stt === "object" && !Array.isArray(parsed.stt)
      ? parsed.stt
      : {};
    return {
      tts: normalizeVoiceTtsTuningDraft(ttsDraft, ttsDraft.modelKey || "chatterbox-multilingual")
        ? { ...ttsDraft, ...normalizeVoiceTtsTuningDraft(ttsDraft, ttsDraft.modelKey || "chatterbox-multilingual") }
        : ttsDraft,
      stt: sttDraft,
    };
  } catch (_error) {
    return { tts: {}, stt: {} };
  }
}

function persistVoiceLaunchDrafts() {
  try {
    localStorage.setItem("voiceLaunchDrafts", JSON.stringify(state.voiceLaunchDrafts || { tts: {}, stt: {} }));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function loadPersistedHfFavorites() {
  try {
    const saved = JSON.parse(localStorage.getItem("hfFavorites") || "[]");
    return Array.isArray(saved)
      ? [...new Set(saved.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
  } catch (_error) {
    return [];
  }
}

function loadPersistedHfFavoriteEntries() {
  try {
    const saved = JSON.parse(localStorage.getItem("hfFavoriteEntries") || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(saved)
        .map(([key, value]) => [String(key || "").trim(), normalizeHfFavoriteEntry(value)])
        .filter(([key, value]) => key && value)
    );
  } catch (_error) {
    return {};
  }
}

function persistHfFavorites() {
  try {
    localStorage.setItem("hfFavorites", JSON.stringify(state.hf.favoriteIds || []));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function persistHfFavoriteEntries() {
  try {
    localStorage.setItem("hfFavoriteEntries", JSON.stringify(state.hf.favoriteEntries || {}));
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

function getPersistedHfFavoritesOnly() {
  try {
    return localStorage.getItem("hfFavoritesOnly") === "true";
  } catch (_error) {
    return false;
  }
}

function persistHfFavoritesOnly() {
  try {
    localStorage.setItem("hfFavoritesOnly", state.hf.favoritesOnly ? "true" : "false");
  } catch (_error) {
    // Silently fail when storage is unavailable.
  }
}

const els = {
  pageTitle: $("#pageTitle"),
  launchersBtn: $("#launchersBtn"),
  restartLlm3Btn: $("#restartLlm3Btn"),
  refreshBtn: $("#refreshBtn"),
  refreshBtnMobile: $("#refreshBtnMobile"),
  profileManageBtn: $("#profileManageBtn"),
  profileManageBtnMobile: $("#profileManageBtnMobile"),
  restartTargetSelect: $("#restartTargetSelect"),
  restartTargetBtn: $("#restartTargetBtn"),
  restartHermesBtnMobile: $("#restartHermesBtnMobile"),
  restartVoiceBtnMobile: $("#restartVoiceBtnMobile"),
  stopBtn: $("#stopBtn"),
  stopBtnMobile: $("#stopBtnMobile"),
  toast: $("#toast"),
  modelsSection: $("#sec-models"),
  modelsSurfaceTabs: $("#modelsSurfaceTabs"),
  modelsSlotStrip: $("#modelsSlotStrip"),
  modelFilterBar: $("#modelFilterBar"),
  filterChips: $("#filterChips"),
  modelSearchInput: $("#modelSearchInput"),
  modelViewToggles: $("#modelViewToggles"),
  modelGrid: $("#modelGrid"),
  topbarRamPct: $("#topbarRamPct"),
  topbarRamBar: $("#topbarRamBar"),
  topbarCpuPct: $("#topbarCpuPct"),
  topbarCpuBar: $("#topbarCpuBar"),
  topbarGpuPct: $("#topbarGpuPct"),
  topbarGpuBar: $("#topbarGpuBar"),
  topbarDiskPct: $("#topbarDiskPct"),
  topbarDiskBar: $("#topbarDiskBar"),
  topbarUptime: $("#topbarUptime"),
  hermesRemoteIndicator: $("#hermesRemoteIndicator"),
  hermesLocalIndicator: $("#hermesLocalIndicator"),
  topbarBusyIndicator: $("#topbarBusyIndicator"),
  hermesRemoteIndicatorMobile: $("#hermesRemoteIndicatorMobile"),
  hermesLocalIndicatorMobile: $("#hermesLocalIndicatorMobile"),
  topbarBusyIndicatorMobile: $("#topbarBusyIndicatorMobile"),
  hermesRemoteIndicatorFloating: $("#hermesRemoteIndicatorFloating"),
  hermesLocalIndicatorFloating: $("#hermesLocalIndicatorFloating"),
  topbarBusyIndicatorFloating: $("#topbarBusyIndicatorFloating"),
  hermesFeedModal: $("#hermesFeedModal"),
  hermesFeedModalContent: $("#hermesFeedModalContent"),
  hermesFeedModalTitle: $("#hermesFeedModalTitle"),
  hermesFeedModalSubtitle: $("#hermesFeedModalSubtitle"),
  hermesFeedModalHeaderActions: $("#hermesFeedModalHeaderActions"),
  hermesFeedModalCloseBtn: $("#hermesFeedModalCloseBtn"),
  hermesFeedAutoScrollInput: $("#hermesFeedAutoScrollInput"),
  saveLayoutModal: $("#saveLayoutModal"),
  saveLayoutModalContent: $("#saveLayoutModalContent"),
  saveLayoutModalCloseBtn: $("#saveLayoutModalCloseBtn"),
  launchersModal: $("#launchersModal"),
  launchersModalContent: $("#launchersModalContent"),
  launchersModalCloseBtn: $("#launchersModalCloseBtn"),
  launcherCommandPreview: $("#launcherCommandPreview"),
  hfLayout: $("#hfLayout"),
  hfMobilePaneToggles: $("#hfMobilePaneToggles"),
  hfSearchInput: $("#hfSearchInput"),
  hfFavoritesToggleBtn: $("#hfFavoritesToggleBtn"),
  hfSearchBtn: $("#hfSearchBtn"),
  hfSummaryBar: $("#hfSummaryBar"),
  hfResults: $("#hfResults"),
  hfDownloadsPanel: $(".hf-downloads-panel"),
  hfResultsPanel: $(".hf-results-panel"),
  hfDownloads: $("#hfDownloads"),
  hfSplitter: $("#hfSplitter"),
  hfDownloadsToggleBtn: $("#hfDownloadsToggleBtn"),
  hfClearFinishedBtn: $("#hfClearFinishedBtn"),
  hfDeleteFailedBtn: $("#hfDeleteFailedBtn"),
  hfCompanionForm: $("#hfCompanionForm"),
  hfCompanionTarget: $("#hfCompanionTarget"),
  hfCompanionStatus: $("#hfCompanionStatus"),
  statusContent: $("#statusContent"),
  ramPct: $("#ramPct"),
  ramBar: $("#ramBar"),
  ramDetail: $("#ramDetail"),
  cpuPct: $("#cpuPct"),
  cpuBar: $("#cpuBar"),
  cpuDetail: $("#cpuDetail"),
  gpuPct: $("#gpuPct"),
  gpuBar: $("#gpuBar"),
  gpuDetail: $("#gpuDetail"),
  diskPct: $("#diskPct"),
  diskBar: $("#diskBar"),
  diskDetail: $("#diskDetail"),
  uptimeValue: $("#uptimeValue"),
  uptimeBar: $("#uptimeBar"),
  uptimeDetail: $("#uptimeDetail"),
  processGrid: $("#processGrid"),
  pauseLogsBtn: $("#pauseLogsBtn"),
  downloadLogsBtn: $("#downloadLogsBtn"),
  clearLogsBtn: $("#clearLogsBtn"),
  autoScrollInput: $("#autoScrollInput"),
  logSlotTabs: $("#logSlotTabs"),
  logKindTabs: $("#logKindTabs"),
  trafficPanel: $("#trafficPanel"),
  serverPanel: $("#serverPanel"),
  proxyPanel: $("#proxyPanel"),
  thinkingPanel: $("#thinkingPanel"),
  trafficLog: $("#trafficLog"),
  trafficStatus: $("#trafficStatus"),
  serverLog: $("#serverLog"),
  llm3Panel: $("#llm3Panel"),
  llm3Status: $("#llm3Status"),
  llm3Log: $("#llm3Log"),
  serverStatus: $("#serverStatus"),
  proxyLog: $("#proxyLog"),
  proxyStatus: $("#proxyStatus"),
  thinkingLog: $("#thinkingLog"),
  thinkingStatus: $("#thinkingStatus"),
  diagnosticsStatus: $("#diagnosticsStatus"),
  diagnosticsFeed: $("#diagnosticsFeed"),
  applicationsContent: $("#applicationsContent"),
  voiceFilterChips: $("#voiceFilterChips"),
  voiceModelGrid: $("#voiceModelGrid"),
  voiceStatusSection: $("#voiceStatusSection"),
  voiceBenchmarkContent: $("#voiceBenchmarkContent"),
  connectionStatus: $("#connectionStatus"),
  sidebar: $(".sidebar"),
  profileModal: $("#profileModal"),
  profileModalContent: $("#profileModalContent"),
  profileModalTitle: $("#profileModalTitle"),
  profileModalSubtitle: $("#profileModalSubtitle"),
  profileModalHeaderActions: $("#profileModalHeaderActions"),
  profileModalCloseBtn: $("#profileModalCloseBtn"),
  launchModal: $("#launchModal"),
  launchModalContent: $("#launchModalContent"),
  launchModalTitle: $("#launchModalTitle"),
  launchModalSubtitle: $("#launchModalSubtitle"),
  launchModalHeaderActions: $("#launchModalHeaderActions"),
  launchModalCloseBtn: $("#launchModalCloseBtn"),
  actionResultModal: $("#actionResultModal"),
  actionResultModalContent: $("#actionResultModalContent"),
  actionResultModalTitle: $("#actionResultModalTitle"),
  actionResultModalSubtitle: $("#actionResultModalSubtitle"),
  actionResultModalCloseBtn: $("#actionResultModalCloseBtn"),
  hfConvertModal: $("#hfConvertModal"),
  hfConvertModalSubtitle: $("#hfConvertModalSubtitle"),
  hfConvertModalCloseBtn: $("#hfConvertModalCloseBtn"),
  hfConvertQuantSelect: $("#hfConvertQuantSelect"),
  hfConvertQuantHint: $("#hfConvertQuantHint"),
  hfConvertSourceNote: $("#hfConvertSourceNote"),
  hfConvertConfirmBtn: $("#hfConvertConfirmBtn"),
  hfConvertCancelBtn: $("#hfConvertCancelBtn"),
  voiceTuningModal: $("#voiceTuningModal"),
  voiceTuningModalContent: $("#voiceTuningModalContent"),
  voiceTuningModalTitle: $("#voiceTuningModalTitle"),
  voiceTuningModalSubtitle: $("#voiceTuningModalSubtitle"),
  voiceTuningModalHeaderActions: $("#voiceTuningModalHeaderActions"),
  voiceTuningModalCloseBtn: $("#voiceTuningModalCloseBtn"),
  websitesCategories: $("#websitesCategories"),
  websitesGrid: $("#websitesGrid"),
  websitesTable: $("#websitesTable"),
  websitesToolbar: $("#websitesToolbar"),
  websitesViewControls: $("#websitesViewControls"),
  websitesSearchInput: $("#websitesSearchInput"),
  viewToggleBoxes: $("#viewToggleBoxes"),
  viewToggleTable: $("#viewToggleTable"),
  pm2Categories: $("#pm2Categories"),
  pm2Table: $("#pm2Table"),
  websiteContextMenu: $("#websiteContextMenu"),
  embedOverlay: $("#embedOverlay"),
  embedOverlayClose: $("#embedOverlayClose"),
  ctxRename: $("#ctxRename"),
  ctxInternal: $("#ctxInternal"),
  ctxExternal: $("#ctxExternal"),
  ctxEmbed: $("#ctxEmbed"),
  ctxDelete: $("#ctxDelete"),
  ctxControl: $("#ctxControl"),
  ctxControlText: $("#ctxControlText"),
  ctxSettings: $("#ctxSettings"),
  ctxStart: $("#ctxStart"),
  ctxStop: $("#ctxStop"),
  ctxAdd: $("#ctxAdd"),
  addWebsiteModal: $("#addWebsiteModal"),
  addWebsiteModalCloseBtn: $("#addWebsiteModalCloseBtn"),
  addWebsiteName: $("#addWebsiteName"),
  addWebsiteInternal: $("#addWebsiteInternal"),
  addWebsiteExternal: $("#addWebsiteExternal"),
  addWebsiteCategory: $("#addWebsiteCategory"),
  addWebsiteSubmit: $("#addWebsiteSubmit"),
  addWebsiteCancel: $("#addWebsiteCancel"),
  websiteSettingsModal: $("#websiteSettingsModal"),
  websiteSettingsModalCloseBtn: $("#websiteSettingsModalCloseBtn"),
  websiteSettingsModalTitle: $("#websiteSettingsModalTitle"),
  websiteSettingsContent: $("#websiteSettingsContent"),
  websiteSettingsPort: $("#websiteSettingsPort"),
  websiteSettingsApply: $("#websiteSettingsApply"),
  websiteSettingsStart: $("#websiteSettingsStart"),
  websiteSettingsStop: $("#websiteSettingsStop"),
  websiteSettingsRestart: $("#websiteSettingsRestart"),
};

document.addEventListener("DOMContentLoaded", () => {
  updateVisualViewportVars();
  wireEvents();
  initDiagnosticsChat();
  bindWheelScrollContainers();
  syncHfDownloadsPanel({ force: true });
  setActiveSection(getPersistedSection());
  refreshAll();
  refreshDiagnostics();
  refreshHermesStatus();
  refreshHfDownloads();
  refreshHfSearch({ silent: true });
  fetchWebsites();
  if (state.hf.favoritesOnly) {
    ensureHfFavoriteEntriesHydrated();
  }
  if (els.hermesFeedAutoScrollInput) {
    els.hermesFeedAutoScrollInput.checked = state.hermesFeedModal.autoScroll;
  }
  startPolling();
});

// Every periodic refresh in one place. A hidden tab polls nothing: the
// browser throttles timers anyway, and the dashboard used to keep four
// requests per tick going in a background tab for hours. When the tab comes
// back, the slow pollers run once immediately so the view is current.
const POLLERS = [
  [refreshOverview, 5000],
  [refreshDiagnostics, 5000],
  [refreshHermesStatus, 5000],
  [() => state.hermesFeedModal.open && refreshHermesFeed(), 4000],
  [refreshActiveBenchmarks, 1000],
  [refreshVoiceBenchmarkState, 1000],
  [refreshLogs, 2500],
  // 2s, not 1s: each poll costs the backend a queued metrics task (see
  // SLOT_ACTIVITY_PROBE_TIMEOUT_MS in src/server.js), and a spinner does not need
  // sub-second resolution.
  [refreshSlotActivity, 2000],
  [refreshHfDownloads, 2500],
];
const pollerHandles = [];

function startPolling() {
  if (pollerHandles.length) return;
  for (const [fn, intervalMs] of POLLERS) {
    pollerHandles.push(setInterval(() => {
      if (document.hidden) return;
      fn();
    }, intervalMs));
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    refreshOverview();
    refreshLogs();
    refreshHfDownloads();
    refreshDiagnostics();
  });
}

function stopPolling() {
  while (pollerHandles.length) clearInterval(pollerHandles.pop());
}

// The website card/table/pm2 markup is rebuilt on every render, so the row
// buttons carry data-website-action and one listener per container handles
// them. This keeps the handler functions module-private.
function handleWebsiteAction(event) {
  const button = event.target.closest("[data-website-action]");
  if (!button || button.disabled) return;
  const id = Number(button.dataset.id);
  if (!Number.isFinite(id)) return;
  switch (button.dataset.websiteAction) {
    case "control":
      controlWebsite(id, button.dataset.control);
      break;
    case "settings":
      openWebsiteSettings(id);
      break;
    case "rename":
      renameWebsite(id);
      break;
    case "delete":
      deleteWebsite(id);
      break;
    case "pm2-memory":
      updateWebsitePm2Memory(id);
      break;
    default:
      break;
  }
}

function wireEvents() {
  els.websitesTable?.addEventListener("click", handleWebsiteAction);
  els.pm2Table?.addEventListener("click", handleWebsiteAction);
  $$(".nav-item").forEach((button) => {
    button.addEventListener("click", () => {
      setActiveSection(button.dataset.section);
      els.sidebar?.classList.remove("open");
    });
  });
  // Website context menu
  els.ctxRename?.addEventListener("click", () => renameWebsite(state.websiteContext.id));
  els.embedOverlayClose?.addEventListener("click", closeEmbedOverlay);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.embedOverlay && !els.embedOverlay.hidden) closeEmbedOverlay();
  });
  els.ctxInternal?.addEventListener("click", () => openInternalUrl(state.websiteContext.id));
  els.ctxExternal?.addEventListener("click", () => openExternalUrl(state.websiteContext.id));
  els.ctxEmbed?.addEventListener("click", () => {
    const w = state.websites.find((we) => we.id === state.websiteContext.id);
    hideWebsiteContextMenu();
    if (w?.embedPath) openEmbedOverlay(w.embedPath, w.name);
  });
  els.ctxControl?.addEventListener("click", () => controlWebsite(state.websiteContext.id));
  els.ctxDelete?.addEventListener("click", () => deleteWebsite(state.websiteContext.id));
  els.ctxAdd?.addEventListener("click", () => openAddWebsiteModal());
  els.ctxSettings?.addEventListener("click", () => openWebsiteSettings(state.websiteContext.id));
  els.ctxStart?.addEventListener("click", () => controlWebsite(state.websiteContext.id, "start"));
  els.ctxStop?.addEventListener("click", () => controlWebsite(state.websiteContext.id, "stop"));
   els.viewToggleBoxes?.addEventListener("click", () => {
    state.websiteView = "boxes";
    els.viewToggleBoxes?.classList.add("active");
    els.viewToggleTable?.classList.remove("active");
    els.websitesGrid?.classList.remove("hidden");
    els.websitesTable?.classList.add("hidden");
  });
  els.viewToggleTable?.addEventListener("click", () => {
    state.websiteView = "table";
    els.viewToggleTable?.classList.add("active");
    els.viewToggleBoxes?.classList.remove("active");
    els.websitesGrid?.classList.add("hidden");
    els.websitesTable?.classList.remove("hidden");
    renderWebsitesTable();
  });
  els.websiteSettingsRestart?.addEventListener("click", () => controlWebsite(state.websiteSettingsId, "restart"));
  els.websiteSettingsApply?.addEventListener("click", () => updateWebsitePort(state.websiteSettingsId));
  els.websiteSettingsStart?.addEventListener("click", () => controlWebsite(state.websiteSettingsId, "start"));
  els.websiteSettingsStop?.addEventListener("click", () => controlWebsite(state.websiteSettingsId, "stop"));
  els.websiteSettingsModalCloseBtn?.addEventListener("click", closeWebsiteSettingsModal);
  els.addWebsiteModalCloseBtn?.addEventListener("click", closeAddWebsiteModal);
  els.addWebsiteCancel?.addEventListener("click", closeAddWebsiteModal);
  els.websiteSettingsModal?.addEventListener("click", (e) => {
    if (e.target === els.websiteSettingsModal) {
      closeWebsiteSettingsModal();
    }
  });
  els.addWebsiteSubmit?.addEventListener("click", submitAddWebsite);
  els.addWebsiteName?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAddWebsite();
  });
  els.addWebsiteInternal?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitAddWebsite();
  });
  document.addEventListener("click", (e) => {
    if (
      els.websiteContextMenu &&
      !els.websiteContextMenu.contains(e.target)
    ) {
      hideWebsiteContextMenu();
    }
  });
  // Mobile: close context menu when tapping outside (touchend doesn't always fire click)
  document.addEventListener("touchend", (e) => {
    if (
      els.websiteContextMenu &&
      !els.websiteContextMenu.contains(e.target) &&
      !els.websitesGrid.contains(e.target)
    ) {
      hideWebsiteContextMenu();
    }
  }, { passive: true });

  const menuBtn = $(".mobile-menu-btn");
  if (menuBtn) {
    menuBtn.addEventListener("click", () => els.sidebar.classList.toggle("open"));
    document.addEventListener("click", (event) => {
      if (
        els.sidebar?.classList.contains("open") &&
        !els.sidebar.contains(event.target) &&
        event.target !== menuBtn &&
        !menuBtn.contains(event.target)
      ) {
        els.sidebar.classList.remove("open");
      }
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.actionResultModal.open) {
      closeActionResultModal();
      return;
    }
    if (event.key === "Escape" && state.hermesFeedModal.open) {
      closeHermesFeedModal();
      return;
    }
    if (event.key === "Escape" && state.launcherCommandPreview.open) {
      closeLauncherCommandPreview();
      return;
    }
    if (event.key === "Escape" && state.saveLayoutModal.open) {
      closeSaveLayoutModal();
      return;
    }
    if (event.key === "Escape" && state.profileMenuOpen) {
      toggleProfileMenu(false);
      return;
    }
    if (event.key === "Escape" && state.launchersModal.open) {
      closeLaunchersModal();
      return;
    }
    if (event.key === "Escape" && state.profileModal.open) {
      closeProfileModal();
      return;
    }
    if (event.key === "Escape" && state.voiceTuningModal.open) {
      closeVoiceTuningModal();
      return;
    }
    if (event.key === "Escape" && state.hf.convertModalOpen) {
      closeHfConvertModal();
      return;
    }
    if (event.key === "Escape" && state.modal.open) {
      closeLaunchModal();
    }
  });

  window.addEventListener("resize", () => {
    updateVisualViewportVars();
    syncResponsiveUi();
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateVisualViewportVars);
    window.visualViewport.addEventListener("scroll", updateVisualViewportVars);
  }

  els.launchersBtn?.addEventListener("click", openLaunchersModal);
  els.restartLlm3Btn?.addEventListener("click", restartLlm3);
  els.refreshBtn.addEventListener("click", refreshAll);
  els.refreshBtnMobile?.addEventListener("click", () => {
    els.sidebar?.classList.remove("open");
    refreshAll();
  });
  els.profileManageBtn?.addEventListener("click", () => openProfileModal());
  els.profileManageBtnMobile?.addEventListener("click", () => {
    els.sidebar?.classList.remove("open");
    openProfileModal();
  });
  els.restartTargetBtn?.addEventListener("click", runSelectedRestartTarget);
  els.restartHermesBtnMobile?.addEventListener("click", () => {
    els.sidebar?.classList.remove("open");
    runAction("/api/hermes/restart", {}, { preserveModal: false });
  });
  els.restartVoiceBtnMobile?.addEventListener("click", () => {
    els.sidebar?.classList.remove("open");
    runAction("/api/voice/restart", {}, { preserveModal: false });
  });
  els.hermesRemoteIndicator?.addEventListener("click", () => openHermesFeedModal("remote"));
  els.hermesLocalIndicator?.addEventListener("click", () => openHermesFeedModal("local"));
  els.hermesRemoteIndicatorMobile?.addEventListener("click", () => openHermesFeedModal("remote"));
  els.hermesLocalIndicatorMobile?.addEventListener("click", () => openHermesFeedModal("local"));
  els.hermesRemoteIndicatorFloating?.addEventListener("click", () => openHermesFeedModal("remote"));
  els.hermesLocalIndicatorFloating?.addEventListener("click", () => openHermesFeedModal("local"));
  [
    els.hermesRemoteIndicator,
    els.hermesLocalIndicator,
    els.hermesRemoteIndicatorMobile,
    els.hermesLocalIndicatorMobile,
    els.hermesRemoteIndicatorFloating,
    els.hermesLocalIndicatorFloating,
  ].forEach((indicator) => {
    indicator?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const runtime = indicator.dataset.hermesRuntime || "local";
        openHermesFeedModal(runtime);
      }
    });
  });
  els.stopBtn.addEventListener("click", () => runAction("/api/stop", {}, { preserveModal: false }));
  els.stopBtnMobile?.addEventListener("click", () => {
    els.sidebar?.classList.remove("open");
    runAction("/api/stop", {}, { preserveModal: false });
  });
  els.launchModalCloseBtn.addEventListener("click", closeLaunchModal);
  els.actionResultModalCloseBtn?.addEventListener("click", closeActionResultModal);
  els.profileModalCloseBtn?.addEventListener("click", closeProfileModal);
  els.voiceTuningModalCloseBtn?.addEventListener("click", closeVoiceTuningModal);
  els.hermesFeedModalCloseBtn?.addEventListener("click", closeHermesFeedModal);
  els.hermesFeedAutoScrollInput?.addEventListener("change", (event) => {
    state.hermesFeedModal.autoScroll = Boolean(event.target.checked);
    if (state.hermesFeedModal.autoScroll) {
      queueMicrotask(() => autoScrollElement(getHermesFeedScrollElement(), true));
    }
  });
  // Right-click on the Profiles subtab: save what is loaded right now.
  els.modelsSurfaceTabs?.addEventListener("contextmenu", (event) => {
    if (!event.target.closest('[data-models-pane="profiles"], [data-profile-menu-toggle]')) {
      return;
    }
    event.preventDefault();
    openSaveLayoutModal();
  });

  els.modelsSurfaceTabs?.addEventListener("click", (event) => {
    const menuToggle = event.target.closest("[data-profile-menu-toggle]");
    if (menuToggle) {
      event.stopPropagation();
      toggleProfileMenu();
      return;
    }
    const menuSave = event.target.closest("[data-profile-menu-save]");
    if (menuSave) {
      openSaveLayoutModal();
      return;
    }
    const menuStart = event.target.closest("[data-profile-menu-start]");
    if (menuStart) {
      toggleProfileMenu(false);
      runApplyProfile(menuStart.dataset.profileMenuStart);
      return;
    }
    const menuSelect = event.target.closest("[data-profile-menu-select]");
    if (menuSelect) {
      state.selectedProfileId = String(menuSelect.dataset.profileMenuSelect || "").trim();
      toggleProfileMenu(false);
      if (state.modelsPane !== "profiles") {
        state.modelsPane = "profiles";
        persistModelsPane("profiles");
        renderFilters();
      }
      renderModels();
      renderModelsSurfaceTabs();
      return;
    }
    const createProfileButton = event.target.closest("[data-profile-new]");
    if (createProfileButton) {
      state.selectedProfileId = "";
      openProfileModal();
      return;
    }
    const deleteSelectedProfileButton = event.target.closest("[data-profile-delete-selected]");
    if (deleteSelectedProfileButton) {
      const profile = getSelectedProfileCard();
      if (!profile) {
        toast("select a profile first");
        return;
      }
      if (!window.confirm(`Delete profile ${profile.name}?`)) {
        return;
      }
      runDeleteProfile(profile.id);
      return;
    }
    const button = event.target.closest("[data-models-pane]");
    if (!button) {
      return;
    }
    const nextPane = button.dataset.modelsPane === "profiles" ? "profiles" : "models";
    if (state.modelsPane === nextPane) {
      return;
    }
    state.modelsPane = nextPane;
    persistModelsPane(nextPane);
    renderFilters();
    renderModels();
  });

  els.modelsSlotStrip?.addEventListener("click", (event) => {
    const stopButton = event.target.closest("[data-slot-strip-stop]");
    if (!stopButton) {
      return;
    }
    if (stopButton.dataset.slotStripStop === "voice") {
      runAction("/api/voice/stop", { voiceSlotId: stopButton.dataset.slotId }, { preserveModal: false });
      return;
    }
    runAction("/api/stop", { slotId: stopButton.dataset.slotId }, { preserveModal: false });
  });

  els.modelsSection?.addEventListener("focusin", (event) => {
    if (event.target.closest("[data-slot-strip-select], #modelSearchInput")) {
      pauseRefreshForEditing(15000);
    }
  });

  els.modelsSection?.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-slot-strip-select], #modelSearchInput")) {
      pauseRefreshForEditing(15000);
    }
  });

  document.addEventListener("click", (event) => {
    if (!state.profileMenuOpen) {
      return;
    }
    if (event.target.closest(".model-surface-tab-group")) {
      return;
    }
    toggleProfileMenu(false);
  });

  els.saveLayoutModalCloseBtn?.addEventListener("click", closeSaveLayoutModal);
  els.saveLayoutModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-save-layout-close]") || event.target.closest("[data-save-layout-cancel]")) {
      closeSaveLayoutModal();
      return;
    }
    if (event.target.closest("[data-save-layout-confirm]")) {
      runSaveCurrentLayout();
    }
  });
  els.saveLayoutModal?.addEventListener("change", (event) => {
    const target = event.target.closest("[data-save-layout-target]");
    if (!target) {
      return;
    }
    state.saveLayoutModal.targetProfileId = String(target.value || SAVE_LAYOUT_NEW_PROFILE);
    if (state.saveLayoutModal.targetProfileId === SAVE_LAYOUT_NEW_PROFILE && !state.saveLayoutModal.name) {
      state.saveLayoutModal.name = suggestProfileName();
    }
    renderSaveLayoutModal();
  });
  els.saveLayoutModal?.addEventListener("input", (event) => {
    const nameInput = event.target.closest("[data-save-layout-name]");
    if (!nameInput) {
      return;
    }
    pauseRefreshForEditing();
    state.saveLayoutModal.name = nameInput.value;
  });
  els.saveLayoutModal?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target.closest("[data-save-layout-name]")) {
      event.preventDefault();
      runSaveCurrentLayout();
    }
  });

  els.modelsSlotStrip?.addEventListener("dblclick", (event) => {
    const logJump = event.target.closest("[data-slot-log-jump]");
    if (logJump) {
      event.preventDefault();
      openSlotLogs(logJump.dataset.slotLogJump);
      return;
    }
  });

  // Rename is a long press on the slot title -- press and hold, mouse or touch.
  els.modelsSlotStrip?.addEventListener("pointerdown", (event) => {
    const renameTarget = event.target.closest("[data-slot-rename]");
    if (!renameTarget || event.button > 0) {
      return;
    }
    startSlotRenameLongPress(renameTarget.dataset.slotRename, event);
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((eventName) => {
    els.modelsSlotStrip?.addEventListener(eventName, cancelSlotRenameLongPress);
  });
  els.modelsSlotStrip?.addEventListener("pointermove", (event) => {
    if (!slotRenameLongPress.timer) {
      return;
    }
    // A drag is a text selection or a scroll, not a hold.
    const moved = Math.abs(event.clientX - slotRenameLongPress.x) + Math.abs(event.clientY - slotRenameLongPress.y);
    if (moved > 8) {
      cancelSlotRenameLongPress();
    }
  });
  // Suppress the text selection a hold would otherwise leave behind.
  els.modelsSlotStrip?.addEventListener("selectstart", (event) => {
    if (slotRenameLongPress.timer && event.target.closest("[data-slot-rename]")) {
      event.preventDefault();
    }
  });

  els.modelsSlotStrip?.addEventListener("input", (event) => {
    const renameInput = event.target.closest("[data-slot-rename-input]");
    if (!renameInput) {
      return;
    }
    pauseRefreshForEditing();
    state.slotRename.value = renameInput.value;
  });

  els.modelsSlotStrip?.addEventListener("keydown", (event) => {
    const renameInput = event.target.closest("[data-slot-rename-input]");
    if (!renameInput) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      state.slotRename.value = renameInput.value;
      commitSlotRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelSlotRename();
    }
  });

  els.modelsSlotStrip?.addEventListener("focusout", (event) => {
    const renameInput = event.target.closest("[data-slot-rename-input]");
    if (!renameInput) {
      return;
    }
    state.slotRename.value = renameInput.value;
    commitSlotRename();
  });

  els.modelsSlotStrip?.addEventListener("change", (event) => {
    const select = event.target.closest("[data-slot-strip-select]");
    if (!select) {
      return;
    }
    const modelKey = String(select.value || "").trim();
    if (!modelKey) {
      return;
    }
    if (select.dataset.slotStripSelect === "voice") {
      openVoiceSlotLaunchModal(select.dataset.slotId, modelKey);
    } else {
      openLaunchModal(modelKey, select.dataset.slotId, "slot");
    }
    select.value = "";
  });

  els.filterChips.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) {
      return;
    }
    state.activeFilter = button.dataset.filter;
    renderFilters();
    renderModels();
  });

  els.modelSearchInput?.addEventListener("input", () => {
    state.modelSearch = String(els.modelSearchInput?.value || "").trim();
    pauseRefreshForEditing();
    renderModels();
  });

  els.websitesSearchInput?.addEventListener("input", () => {
    state.websiteSearch = String(els.websitesSearchInput?.value || "").trim();
    // Both views read the same state, so refresh whichever one is mounted.
    renderWebsites();
    renderWebsitesTable();
  });

  // Escape clears the box instead of only blurring it.
  els.websitesSearchInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.websiteSearch) {
      return;
    }
    event.preventDefault();
    state.websiteSearch = "";
    els.websitesSearchInput.value = "";
    renderWebsites();
    renderWebsitesTable();
  });

  els.modelViewToggles?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-model-view]");
    if (!button) {
      return;
    }
    state.modelViewTouched = true;
    state.modelView = button.dataset.modelView === "cards" ? "cards" : "table";
    renderFilters();
    renderModels();
  });

  els.modelGrid.addEventListener("click", (event) => {
    const profileLaunchCard = event.target.closest("[data-profile-launch]");
    if (profileLaunchCard) {
      runApplyProfile(profileLaunchCard.dataset.profileLaunch);
      return;
    }
    const profileEditCard = event.target.closest("[data-profile-edit]");
    if (profileEditCard) {
      state.selectedProfileId = String(profileEditCard.dataset.profileEdit || "").trim();
      openProfileModal(profileEditCard.dataset.profileEdit);
      return;
    }
    const profileSelectCard = event.target.closest("[data-profile-select]");
    if (profileSelectCard) {
      state.selectedProfileId = String(profileSelectCard.dataset.profileSelect || "").trim();
      renderModels();
      return;
    }
    const sortButton = event.target.closest("[data-model-sort]");
    if (sortButton) {
      toggleModelSort(sortButton.dataset.modelSort);
      renderModels();
      return;
    }
    if (event.target.closest(".link")) {
      return;
    }
    const deleteButton = event.target.closest("[data-delete-model]");
    if (deleteButton) {
      const model = getModel(deleteButton.dataset.deleteModel);
      if (!model) {
        return;
      }
      if (!window.confirm(`Delete ${model.label} from disk?`)) {
        return;
      }
      runDeleteModel(model.key);
      return;
    }
    const stopButton = event.target.closest("[data-stop-model]");
    if (stopButton) {
      runStopModel(stopButton.dataset.stopModel);
      return;
    }
    const settingsButton = event.target.closest("[data-model-settings]");
    if (settingsButton) {
      openLaunchModal(settingsButton.dataset.modelSettings, null, "model");
      return;
    }
    const launchButton = event.target.closest("[data-launch-model]");
    if (!launchButton) {
      return;
    }
    runLaunchModelWithDefaults(launchButton.dataset.launchModel);
  });

  els.statusContent.addEventListener("click", (event) => {
    const copyButton = event.target.closest("[data-copy-endpoint]");
    if (copyButton) {
      const slot = getSlot(copyButton.dataset.copyEndpoint);
      if (!slot) {
        return;
      }
      const endpoint = runtimeEndpoint(slot);
      navigator.clipboard?.writeText(endpoint)
        .then(() => toast(`copied: ${endpoint}`))
        .catch(() => toast(`copied: ${endpoint}`));
      return;
    }

    // Copy voice endpoint
    const copyVoiceButton = event.target.closest("[data-copy-voice-endpoint]");
    if (copyVoiceButton) {
      const slot = getVoiceSlot(copyVoiceButton.dataset.copyVoiceEndpoint);
      if (!slot) return;
      const endpoint = voiceRuntimeEndpoint(slot);
      navigator.clipboard?.writeText(endpoint)
        .then(() => toast(`copied: ${endpoint}`))
        .catch(() => toast(`copied: ${endpoint}`));
      return;
    }

    const stopButton = event.target.closest("[data-stop-slot]");
    if (stopButton) {
      runAction("/api/stop", { slotId: stopButton.dataset.stopSlot }, { preserveModal: false });
      return;
    }

    const benchmarkButton = event.target.closest("[data-run-benchmark]");
    if (benchmarkButton) {
      runSlotBenchmark(benchmarkButton.dataset.runBenchmark);
      return;
    }

    // Stop voice slot
    const stopVoiceButton = event.target.closest("[data-voice-slot-stop]");
    if (stopVoiceButton) {
      runAction("/api/voice/stop", { voiceSlotId: stopVoiceButton.dataset.voiceSlotStop }, { preserveModal: false });
      return;
    }
  });

  els.hfSearchBtn?.addEventListener("click", () => {
    const query = String(els.hfSearchInput?.value || "").trim();
    if (state.hf.favoritesOnly) {
      state.hf.appliedFavoritesQuery = query;
      renderHfSearch();
      return;
    }
    state.hf.query = query;
    refreshHfSearch();
  });

  els.hfSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const query = String(els.hfSearchInput?.value || "").trim();
      if (state.hf.favoritesOnly) {
        state.hf.appliedFavoritesQuery = query;
        renderHfSearch();
        return;
      }
      state.hf.query = query;
      refreshHfSearch();
    }
  });
  els.hfSearchInput?.addEventListener("input", () => {
    pauseRefreshForEditing();
  });
  els.hfFavoritesToggleBtn?.addEventListener("click", () => {
    state.hf.favoritesOnly = !state.hf.favoritesOnly;
    if (state.hf.favoritesOnly) {
      state.hf.appliedFavoritesQuery = "";
      ensureHfFavoriteEntriesHydrated();
    }
    persistHfFavoritesOnly();
    renderHfSearch();
  });
  els.hfMobilePaneToggles?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-hf-mobile-pane]");
    if (!button) {
      return;
    }
    state.hf.mobilePane = button.dataset.hfMobilePane === "downloads" ? "downloads" : "results";
    state.hf.mobilePaneTouched = true;
    updateHfDownloadsPanelUi();
  });
  els.hfSplitter?.addEventListener("pointerdown", startHfSplitterDrag);
  els.hfSplitter?.addEventListener("keydown", (event) => {
    if (isMobileHfLayout()) {
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -0.03 : 0.03;
    state.hf.splitRatio = Math.max(0.45, Math.min(0.82, state.hf.splitRatio + delta));
    updateHfDownloadsPanelUi();
  });
  els.hfDownloadsToggleBtn?.addEventListener("click", () => {
    setHfDownloadsCollapsed(!state.hf.downloadsCollapsed, { user: true });
  });
  els.hfClearFinishedBtn?.addEventListener("click", () => {
    clearHfDownloads();
  });
  els.hfDeleteFailedBtn?.addEventListener("click", () => {
    clearHfDownloads("", { failedOnly: true });
  });

  els.hfResults?.addEventListener("click", (event) => {
    const sortButton = event.target.closest("[data-hf-sort]");
    if (sortButton) {
      const nextSort = sortButton.dataset.hfSort;
      if (state.hf.sort === nextSort) {
        state.hf.direction = state.hf.direction === "desc" ? "asc" : "desc";
      } else {
        state.hf.sort = nextSort;
        state.hf.direction = nextSort === "name" ? "asc" : "desc";
      }
      renderHfSearch();
      refreshHfSearch({ silent: true });
  fetchWebsites();
      return;
    }

    const favoriteButton = event.target.closest("[data-hf-favorite]");
    if (favoriteButton) {
      toggleHfFavorite(favoriteButton.dataset.hfFavorite);
      return;
    }

    const downloadButton = event.target.closest("[data-hf-download]");
    if (downloadButton) {
      const candidate = getVisibleHfResults().find((entry) => entry.id === downloadButton.dataset.hfDownload);
      if (!candidate) {
        return;
      }
      runHfDownload(candidate);
      return;
    }

    const convertButton = event.target.closest("[data-hf-convert]");
    if (convertButton) {
      const candidate = getVisibleHfResults().find((entry) => entry.id === convertButton.dataset.hfConvert);
      if (!candidate) {
        return;
      }
      runHfConvert(candidate);
      return;
    }

    const cancelJobButton = event.target.closest("[data-hf-cancel-job]");
    if (cancelJobButton) {
      cancelHfJob(cancelJobButton.dataset.hfCancelJob);
      return;
    }
  });

  els.hfDownloads?.addEventListener("click", (event) => {
    const cancelButton = event.target.closest("[data-hf-cancel-job]");
    if (cancelButton) {
      cancelHfJob(cancelButton.dataset.hfCancelJob);
      return;
    }
    const clearButton = event.target.closest("[data-hf-clear-job]");
    if (!clearButton) {
      return;
    }
    clearHfDownloads(clearButton.dataset.hfClearJob);
  });

  els.hfCompanionForm?.addEventListener("submit", submitHfCompanion);

  els.hfConvertModalCloseBtn?.addEventListener("click", closeHfConvertModal);
  els.hfConvertCancelBtn?.addEventListener("click", closeHfConvertModal);
  els.hfConvertConfirmBtn?.addEventListener("click", submitHfConvert);
  els.hfConvertQuantSelect?.addEventListener("change", updateHfConvertQuantHint);
  els.hfConvertModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-hf-convert-close]")) {
      closeHfConvertModal();
    }
  });

  els.applicationsContent?.addEventListener("change", (event) => {
    const select = event.target.closest("[data-application-select]");
    if (!select) {
      return;
    }
    const applicationKey = select.dataset.applicationSelect;
    state.applicationDrafts[applicationKey] = select.value;
    state.applicationDirty[applicationKey] = state.applicationDrafts[applicationKey] !== state.applicationTargets[applicationKey];
    renderApplications();
    pauseRefreshForEditing();
  });

  els.applicationsContent?.addEventListener("click", (event) => {
    const saveButton = event.target.closest("[data-application-save]");
    if (!saveButton) {
      return;
    }
    runSaveApplicationTarget(saveButton.dataset.applicationSave);
  });
  document.querySelector("#sec-models")?.addEventListener("wheel", handleSectionWheelScroll, { passive: false, capture: true });
  document.querySelector("#sec-applications")?.addEventListener("wheel", handleSectionWheelScroll, { passive: false, capture: true });

  els.launchModal.addEventListener("click", (event) => {
    const insideColorPicker = Boolean(event.target.closest(".model-color-picker"));
    if (state.modal.colorPickerOpen && !insideColorPicker) {
      state.modal.colorPickerOpen = false;
      state.modal.colorDraft = "";
      renderLaunchModal();
    }
    if (event.target.closest(".modal-dialog")) {
      pauseRefreshForEditing();
    }
    if (event.target.closest("[data-modal-close]")) {
      closeLaunchModal();
      closeAddWebsiteModal();
      return;
    }

    const colorToggle = event.target.closest("[data-model-color-toggle]");
    if (colorToggle) {
      const model = getModel(state.modal.modelKey);
      const nextOpen = !state.modal.colorPickerOpen;
      state.modal.colorPickerOpen = nextOpen;
      state.modal.colorDraft = nextOpen && model ? getModelColorValue(model) : "";
      renderLaunchModal();
      return;
    }

    const colorConfirm = event.target.closest("[data-model-color-confirm]");
    if (colorConfirm) {
      const normalized = normalizeHexColor(state.modal.colorDraft);
      if (!normalized || !state.modal.modelKey) {
        toast("enter a valid hex color", { type: "error" });
        return;
      }
      setModelColor(state.modal.modelKey, normalized);
      state.modal.colorPickerOpen = false;
      state.modal.colorDraft = "";
      renderLaunchModal();
      return;
    }

    const colorDefault = event.target.closest("[data-model-color-default]");
    if (colorDefault) {
      const model = getModel(state.modal.modelKey);
      if (!model || !state.modal.modelKey) {
        return;
      }
      clearModelColor(state.modal.modelKey);
      state.modal.colorPickerOpen = false;
      state.modal.colorDraft = "";
      renderLaunchModal();
      return;
    }

    const presetButton = event.target.closest("[data-modal-preset]");
    if (presetButton) {
      event.preventDefault();
      applyModalPreset(presetButton.dataset.modalPreset);
      return;
    }

    const saveUrlButton = event.target.closest("[data-modal-save-url]");
    if (saveUrlButton) {
      runAction(
        "/api/slot-config",
        {
          slotId: state.modal.slotId,
          runtimeBaseUrl: String(ensureModalForm().runtimeBaseUrl || "").trim(),
        },
        { preserveModal: true }
      );
      return;
    }

    const saveDefaultsButton = event.target.closest("[data-modal-save-defaults]");
    if (saveDefaultsButton) {
      runSaveDefaultsFromModal();
      return;
    }

    const resetSamplingButton = event.target.closest("[data-modal-reset-sampling]");
    if (resetSamplingButton) {
      state.modal.form = resetSamplingFields({
        ...ensureModalForm(),
      });
      renderLaunchModal();
      return;
    }

    const stopButton = event.target.closest("[data-modal-stop-slot]");
    if (stopButton) {
      if (state.modal.voiceModel) {
        runAction("/api/voice/stop", { voiceSlotId: state.modal.voiceSlotId }, { preserveModal: true });
      } else {
        runAction("/api/stop", { slotId: state.modal.slotId }, { preserveModal: true });
      }
      return;
    }

    const launchButton = event.target.closest("[data-modal-launch]");
    if (launchButton) {
      if (state.modal.voiceModel) {
        const model = getVoiceModels().find((m) => m.key === state.modal.voiceModel);
        const slot = getVoiceSlots().find((s) => s.id === state.modal.voiceSlotId) || null;
        if (!model || !slot) {
          toast("select a voice model and slot first");
          return;
        }
        if (model.type !== slot.type) {
          toast(`Model ${model.label} is ${model.type} but slot ${slot.label} is ${slot.type}`);
          return;
        }
        const form = state.modal.form || {};
        runAction(
          "/api/voice/start",
          {
            voiceSlotId: slot.id,
            modelKey: model.key,
            voiceName: form.voiceName || "",
            audioFormat: form.audioFormat || "pcm16",
            sampleRate: Number(form.sampleRate) || (model.type === "tts" ? 24000 : 16000),
            setHermes: Boolean(form.setHermes),
            setHermesM4: Boolean(form.setHermesM4),
            ...buildVoiceTtsPayload(form, model),
          },
          { closeModal: true }
        );
      } else {
        runLaunchFromModal();
      }
      return;
    }

    const saveVoiceDefaultsButton = event.target.closest("[data-modal-save-voice-defaults]");
    if (saveVoiceDefaultsButton) {
      const model = getVoiceModels().find((m) => m.key === state.modal.voiceModel);
      const slot = getVoiceSlots().find((s) => s.id === state.modal.voiceSlotId) || null;
      if (!model || !slot) {
        toast("select a voice model and slot first");
        return;
      }
      const form = state.modal.form || {};
      runAction(
        "/api/voice/defaults",
        {
          voiceSlotId: slot.id,
          modelKey: model.key,
          voiceName: form.voiceName || "",
          audioFormat: form.audioFormat || "pcm16",
          sampleRate: Number(form.sampleRate) || (model.type === "tts" ? 24000 : 16000),
          ...buildVoiceTtsPayload(form, model),
        },
        { preserveModal: true }
      );
      return;
    }
  });
  els.actionResultModal?.addEventListener("click", (event) => {
    if (event.target.closest("[data-action-result-close]")) {
      closeActionResultModal();
    }
  });
  els.voiceTuningModal?.addEventListener("click", (event) => {
    if (event.target.closest(".modal-dialog")) {
      pauseRefreshForEditing();
    }
    if (event.target.closest("[data-voice-tuning-close]")) {
      closeVoiceTuningModal();
      return;
    }
    if (event.target.closest("[data-voice-tuning-reset-modal]")) {
      const model = getVoiceModels().find((entry) => entry.key === state.voiceTuningModal.modelKey);
      if (!model) {
        return;
      }
      state.voiceTuningModal.values = getVoiceTtsTuningDefaults(model);
      renderVoiceTuningModal();
      return;
    }
    if (event.target.closest("[data-voice-tuning-save-modal]")) {
      saveVoiceTuningModal();
      return;
    }
    if (event.target.closest("[data-voice-library-upload]")) {
      void uploadVoiceTuningModalVoice();
      return;
    }
    const playVoiceButton = event.target.closest("[data-voice-library-play]");
    if (playVoiceButton) {
      void playVoiceTuningModalVoice(playVoiceButton.dataset.voiceLibraryPlay || "");
      return;
    }
    const deleteVoiceButton = event.target.closest("[data-voice-library-delete]");
    if (deleteVoiceButton) {
      void deleteVoiceTuningModalVoice(deleteVoiceButton.dataset.voiceLibraryDelete || "");
    }
  });
  els.voiceTuningModal?.addEventListener("input", (event) => {
    const libraryNameInput = event.target.closest("[data-voice-library-name]");
    if (libraryNameInput && state.voiceTuningModal.open) {
      pauseRefreshForEditing();
      state.voiceTuningModal = {
        ...state.voiceTuningModal,
        voiceLibrary: {
          ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
          draftName: String(libraryNameInput.value || ""),
          error: "",
        },
      };
      return;
    }
    const libraryReferenceTextInput = event.target.closest("[data-voice-library-reference-text]");
    if (libraryReferenceTextInput && state.voiceTuningModal.open) {
      pauseRefreshForEditing();
      state.voiceTuningModal = {
        ...state.voiceTuningModal,
        voiceLibrary: {
          ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
          draftReferenceText: String(libraryReferenceTextInput.value || ""),
          error: "",
        },
      };
      return;
    }
    const input = event.target.closest("[data-voice-tuning-modal-field]");
    if (!input || !state.voiceTuningModal.open) {
      return;
    }
    pauseRefreshForEditing();
    const model = getVoiceModels().find((entry) => entry.key === state.voiceTuningModal.modelKey);
    const field = String(input.dataset.voiceTuningModalField || "").trim();
    if (!model || !field) {
      return;
    }
    state.voiceTuningModal.values = normalizeVoiceTtsTuningDraft({
      ...state.voiceTuningModal.values,
      [field]: input.value,
    }, model);
    const entry = VOICE_TTS_TUNING_FIELDS.find((item) => item.field === field);
    const output = input.parentElement?.querySelector("output");
    if (entry && output) {
      output.textContent = `${state.voiceTuningModal.values[field]}${entry.valueSuffix || ""}`;
    }
    const badge = els.voiceTuningModalContent?.querySelector(".voice-tuning-badge");
    if (badge) {
      badge.textContent = getVoiceTtsTuningSummary(model, state.voiceTuningModal.values);
    }
  });
  els.voiceTuningModal?.addEventListener("change", async (event) => {
    const fileInput = event.target.closest("[data-voice-library-file]");
    if (!fileInput || !state.voiceTuningModal.open) {
      return;
    }
    pauseRefreshForEditing();
    const file = fileInput.files?.[0] || null;
    if (!file) {
      state.voiceTuningModal = {
        ...state.voiceTuningModal,
        voiceLibrary: {
          ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
          selectedFileName: "",
          selectedFileDataUrl: "",
          selectedFileSize: 0,
          error: "",
          statusMessage: "",
          statusTone: "",
        },
      };
      renderVoiceTuningModal();
      return;
    }
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        busy: true,
        error: "",
        statusMessage: `Reading ${file.name}...`,
        statusTone: "info",
      },
    };
    renderVoiceTuningModal();
    try {
      const audioBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Unable to read the selected file."));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
      });
      if (!state.voiceTuningModal.open) {
        return;
      }
      state.voiceTuningModal = {
        ...state.voiceTuningModal,
        voiceLibrary: {
          ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
          busy: false,
          selectedFileName: String(file.name || ""),
          selectedFileDataUrl: audioBase64,
          selectedFileSize: Number(file.size) || 0,
          error: "",
          statusMessage: `Ready to upload ${file.name}.`,
          statusTone: "info",
        },
      };
    } catch (error) {
      state.voiceTuningModal = {
        ...state.voiceTuningModal,
        voiceLibrary: {
          ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
          busy: false,
          selectedFileName: "",
          selectedFileDataUrl: "",
          selectedFileSize: 0,
          error: error.message || "Unable to read the selected file.",
          statusMessage: "",
          statusTone: "",
        },
      };
    }
    renderVoiceTuningModal();
  });

  els.launchModal.addEventListener("focusin", () => {
    if (state.modal.open) {
      pauseRefreshForEditing();
    }
  });
  els.launchModal.addEventListener("input", handleLaunchModalInput);
  els.launchModal.addEventListener("change", handleLaunchModalInput);
  els.launchModal.addEventListener("focusout", (event) => {
    if (!event.target.closest("[data-modal-slot-name]")) {
      return;
    }
    // A poll re-render destroys and recreates this field, which fires focusout
    // without the user having left it. restoreUiState puts focus back on the
    // next tick, so decide after that rather than committing a half-typed name.
    setTimeout(() => {
      if (document.activeElement?.closest?.("[data-modal-slot-name]")) {
        return;
      }
      commitLaunchModalSlotName();
    }, 0);
  });
  els.launchModal.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !event.target.closest("[data-modal-slot-name]")) {
      return;
    }
    // Enter in this field renames the slot; it must not submit the launch.
    event.preventDefault();
    event.stopPropagation();
    commitLaunchModalSlotName();
  });

  els.profileModal?.addEventListener("click", (event) => {
    const insideProfileColorPicker = Boolean(event.target.closest(".profile-color-picker"));
    if (state.profileModal.colorPickerOpen && !insideProfileColorPicker) {
      state.profileModal.colorPickerOpen = false;
      state.profileModal.colorDraft = "";
      renderProfileModal();
    }
    if (event.target.closest(".modal-dialog")) {
      pauseRefreshForEditing();
    }
    if (event.target.closest("[data-profile-modal-close]")) {
      closeProfileModal();
      return;
    }
    const tabButton = event.target.closest("[data-profile-slot-tab]");
    if (tabButton) {
      state.profileModal.activeSlotId = tabButton.dataset.profileSlotTab;
      renderProfileModal();
      return;
    }
    const presetButton = event.target.closest("[data-profile-preset]");
    if (presetButton) {
      const slotId = presetButton.dataset.slotId;
      const draft = ensureProfileModalSlot(slotId);
      draft.ctxSize = String(presetButton.dataset.profilePreset || draft.ctxSize);
      renderProfileModal();
      return;
    }
    if (event.target.closest("[data-profile-save]")) {
      runSaveProfile();
      return;
    }
    if (event.target.closest("[data-profile-delete]")) {
      runDeleteSelectedProfile();
      return;
    }
    const colorToggle = event.target.closest("[data-profile-color-toggle]");
    if (colorToggle) {
      state.profileModal.colorPickerOpen = !state.profileModal.colorPickerOpen;
      state.profileModal.colorDraft = state.profileModal.colorPickerOpen ? getProfileModalColorValue() : "";
      renderProfileModal();
      return;
    }
    if (event.target.closest("[data-profile-color-confirm]")) {
      const normalized = normalizeHexColor(state.profileModal.colorDraft);
      if (!normalized) {
        toast("enter a valid hex color", { type: "error" });
        return;
      }
      state.profileModal.color = normalized;
      state.profileModal.colorDraft = "";
      state.profileModal.colorPickerOpen = false;
      renderProfileModal();
      return;
    }
    if (event.target.closest("[data-profile-color-default]")) {
      state.profileModal.color = "";
      state.profileModal.colorDraft = "";
      state.profileModal.colorPickerOpen = false;
      renderProfileModal();
      return;
    }
    if (event.target.closest("[data-profile-reset-model-colors]")) {
      resetAllModelColors();
      return;
    }
  });
  els.profileModal?.addEventListener("input", handleProfileModalInput);
  els.profileModal?.addEventListener("change", handleProfileModalInput);

  els.launchersModal?.addEventListener("click", (event) => {
    if (event.target.closest(".modal-dialog")) {
      pauseRefreshForEditing();
    }
    if (event.target.closest("[data-launchers-modal-close]")) {
      closeLaunchersModal();
      return;
    }
    const commandButton = event.target.closest("[data-launcher-command]");
    if (commandButton) {
      openLauncherCommandPreview(commandButton.dataset.launcherCommand);
      return;
    }
    const updateButton = event.target.closest("[data-launcher-update]");
    if (updateButton) {
      runLauncherUpdate(updateButton.dataset.launcherUpdate);
    }
  });

  els.launcherCommandPreview?.addEventListener("click", (event) => {
    if (event.target.closest("[data-launcher-command-close]")) {
      closeLauncherCommandPreview();
    }
  });

  els.hermesFeedModal?.addEventListener("click", (event) => {
    if (event.target.closest(".modal-dialog")) {
      pauseRefreshForEditing();
    }
    if (event.target.closest("[data-hermes-feed-close]")) {
      closeHermesFeedModal();
    }
  });

  els.pauseLogsBtn.addEventListener("click", () => {
    state.logsPaused = !state.logsPaused;
    els.pauseLogsBtn.textContent = state.logsPaused ? "Resume" : "Pause";
    refreshLogs({ force: true });
  });

  els.downloadLogsBtn?.addEventListener("click", () => {
    const slotId = String(state.activeLogSlotId || "");
    if (!slotId) {
      return;
    }
    if (state.activeLogKind === "thinking") {
      window.location.href = `/api/logs/${encodeURIComponent(slotId)}/thinking/download`;
      return;
    }
    const logState = ensureLogState(slotId, state.activeLogKind);
    const content = state.activeLogKind === "traffic"
      ? JSON.stringify(logState.entries || [], null, 2)
      : String(logState.text || "");
    const filename = state.activeLogKind === "llm3"
      ? "llm3-server-log.txt"
      : `${slotId}-${state.activeLogKind}-log.txt`;
    downloadTextFile(filename, content, "text/plain;charset=utf-8");
  });

  els.clearLogsBtn.addEventListener("click", async () => {
    if (state.activeLogKind === "thinking") {
      const slotId = String(state.activeLogSlotId || "");
      const thinkingState = ensureLogState(slotId, "thinking");
      try {
        const data = await fetchJson(`/api/logs/${encodeURIComponent(slotId)}/thinking/clear`, {
          method: "POST",
        });
        const clearOffset = Math.max(
          Number(data?.clearOffset || 0),
          Number(thinkingState.offset || 0)
        );
        state.thinkingClearOffsets[slotId] = clearOffset;
        thinkingState.offset = clearOffset;
        thinkingState.text = "";
      } catch (_error) {
        state.thinkingClearOffsets[slotId] = Number(thinkingState.offset || 0);
        thinkingState.text = "";
      }
      persistThinkingClearOffsets();
    }
    resetLogBuffers();
    renderLogs();
  });

  els.logSlotTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-log-slot]");
    if (!button) {
      return;
    }
    state.activeLogSlotId = button.dataset.logSlot;
    renderLogTabs();
    renderLogs();
  });

  els.logKindTabs.addEventListener("click", (event) => {
    const button = event.target.closest("[data-log-kind]");
    if (!button) {
      return;
    }
    state.activeLogKind = button.dataset.logKind;
    renderLogTabs();
    renderLogs();
    // The llm3 kind is not polled in the background, so fetch it on arrival
    // rather than showing an empty panel until the next tick.
    if (state.activeLogKind === "llm3") {
      refreshLogs({ force: true });
    }
  });

  wireVoiceEvents();
  wireVoiceBenchmarkEvents();
}

function bindWheelScrollContainers(root = document) {
  root.querySelectorAll(WHEEL_SCROLL_CONTAINER_SELECTOR).forEach((element) => {
    if (!(element instanceof HTMLElement) || element.dataset.wheelScrollBound === "true") {
      return;
    }
    element.dataset.wheelScrollBound = "true";
    element.addEventListener("wheel", handleBoundWheelScroll, { passive: false });
  });
}

function normalizeWheelDelta(event) {
  const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? window.innerHeight
      : 1;
  return {
    deltaX: Number(event.deltaX || 0) * scale,
    deltaY: Number(event.deltaY || 0) * scale,
  };
}

function canScrollElement(element, deltaX, deltaY) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const verticalRange = element.scrollHeight - element.clientHeight;
  const horizontalRange = element.scrollWidth - element.clientWidth;
  const prefersVertical = Math.abs(deltaY) >= Math.abs(deltaX);

  if (prefersVertical && verticalRange > 0) {
    if (deltaY < 0) {
      return element.scrollTop > 0;
    }
    if (deltaY > 0) {
      return element.scrollTop < verticalRange;
    }
  }

  if (horizontalRange > 0) {
    if (deltaX < 0) {
      return element.scrollLeft > 0;
    }
    if (deltaX > 0) {
      return element.scrollLeft < horizontalRange;
    }
  }

  if (!prefersVertical && verticalRange > 0) {
    if (deltaY < 0) {
      return element.scrollTop > 0;
    }
    if (deltaY > 0) {
      return element.scrollTop < verticalRange;
    }
  }

  return false;
}

function handleBoundWheelScroll(event) {
  if (event.defaultPrevented || event.ctrlKey) {
    return;
  }

  const element = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!element) {
    return;
  }

  const { deltaX, deltaY } = normalizeWheelDelta(event);
  if (deltaX === 0 && deltaY === 0) {
    return;
  }

  if (!canScrollElement(element, deltaX, deltaY)) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  element.scrollBy({
    left: deltaX,
    top: deltaY,
    behavior: "auto",
  });
}

function findScrollableWithinScope(target, scope, deltaX, deltaY) {
  let current = target;
  while (current instanceof Element) {
    if (current instanceof HTMLElement && canScrollElement(current, deltaX, deltaY)) {
      return current;
    }
    if (current === scope) {
      break;
    }
    current = current.parentElement;
  }

  const tableScroll = scope.querySelector(".table-scroll");
  if (tableScroll instanceof HTMLElement && canScrollElement(tableScroll, deltaX, deltaY)) {
    return tableScroll;
  }

  const section = scope.closest(".section");
  if (section instanceof HTMLElement && canScrollElement(section, deltaX, deltaY)) {
    return section;
  }

  return null;
}

function handleSectionWheelScroll(event) {
  if (event.defaultPrevented || event.ctrlKey) {
    return;
  }

  const section = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const target = event.target instanceof Element ? event.target : null;
  if (!section || !target) {
    return;
  }

  const { deltaX, deltaY } = normalizeWheelDelta(event);
  if (deltaX === 0 && deltaY === 0) {
    return;
  }

  const interactiveAncestor = target.closest("select, option, input, textarea");
  if (interactiveAncestor && interactiveAncestor !== target) {
    return;
  }

  if (!canScrollElement(section, deltaX, deltaY)) {
    return;
  }

  event.preventDefault();
  section.scrollBy({
    left: deltaX,
    top: deltaY,
    behavior: "auto",
  });
}

function pauseRefreshForEditing(durationMs = 8000) {
  const duration = Math.max(1000, Number(durationMs) || 8000);
  state.editingApplications = true;
  state.refreshPausedUntil = Math.max(state.refreshPausedUntil, Date.now() + duration);
  clearTimeout(state.applicationEditTimeout);
  state.applicationEditTimeout = setTimeout(() => {
    state.editingApplications = false;
  }, duration);
}

function isRefreshPaused() {
  return state.refreshPausedUntil > Date.now();
}

function handleLaunchModalInput(event) {
  const colorDraftInput = event.target.closest("[data-model-color-draft]");
  if (colorDraftInput && state.modal.open && !state.modal.voiceModel) {
    pauseRefreshForEditing();
    state.modal.colorDraft = String(colorDraftInput.value || "").trim();
    syncModelColorPickerUi();
    return;
  }

  const colorValueInput = event.target.closest("[data-model-color-value]");
  if (colorValueInput && state.modal.open && !state.modal.voiceModel) {
    pauseRefreshForEditing();
    const model = getModel(state.modal.modelKey);
    const baseColor = getDraftOrModelColor(model);
    const hsv = hexToHsv(baseColor);
    if (hsv) {
      hsv.v = Math.max(0, Math.min(1, Number(colorValueInput.value || 0) / 100));
      state.modal.colorDraft = hsvToHex(hsv.h, hsv.s, hsv.v);
      syncModelColorPickerUi();
    }
    return;
  }

  // Handle sampling preset dropdown before the generic data-modal-input guard:
  // the preset <select> uses its own data attribute and otherwise returns early.
  const presetDropdown = event.target.closest("[data-modal-sampling-preset]");
  if (presetDropdown && state.modal.open && !state.modal.voiceModel) {
    pauseRefreshForEditing();
    const presetKey = presetDropdown.value;
    const preset = SAMPLING_PRESETS[presetKey];
    const form = ensureModalForm();
    if (preset) {
      Object.assign(form, {
        thinking: preset.thinking,
        temperature: String(preset.temperature),
        topP: String(preset.topP),
        topK: String(preset.topK),
        minP: String(preset.minP),
        presencePenalty: String(preset.presencePenalty),
        repetitionPenalty: String(preset.repetitionPenalty),
      });
      renderLaunchModal();
    }
    return;
  }

  const slotNameInput = event.target.closest("[data-modal-slot-name]");
  if (slotNameInput && state.modal.open) {
    pauseRefreshForEditing();
    state.modal.slotNameDraft = slotNameInput.value;
    return;
  }

  const input = event.target.closest("[data-modal-input]");
  if (!input || !state.modal.open) {
    return;
  }

  pauseRefreshForEditing();
  const field = input.dataset.modalInput;
  const form = ensureModalForm();
  if (field === "slotId") {
    state.modal.slotId = input.value;
    state.modal.form = createLaunchForm(state.modal.slotId, getModel(state.modal.modelKey));
    renderLaunchModal();
    return;
  }
  if (field === "launcher") {
    const model = getModel(state.modal.modelKey);
    const defaults = getSlotDefaults(getSlot(state.modal.slotId), model, input.value);
    const grammarSelection = normalizeGrammarSelection(model, defaults);
    Object.assign(form, {
      launcher: input.value,
      ctxSize: String(defaults.contextSize || defaults.ctxSize || form.ctxSize),
      parallel: String(defaults.parallel || form.parallel),
      thinking: model?.supportsThinking ? Boolean(defaults.thinking) : false,
      ...grammarSelection,
      ...buildDefaultSamplingForm({
        temperature: defaults.temperature,
        topP: defaults.topP,
        topK: defaults.topK,
        minP: defaults.minP,
        presencePenalty: defaults.presencePenalty,
        repetitionPenalty: defaults.repetitionPenalty,
      }),
    });
    renderLaunchModal();
    return;
  }

  const applicationFlag = getApplicationFlagByField(field);
  if (field === "thinking") {
    form.thinking = !!input.checked;
    applyThinkingPresencePenalty(form, form.thinking);
    renderLaunchModal();
    return;
  } else if (field === "chatTemplate") {
    form.chatTemplate = String(input.value || "");
    renderLaunchModal();
    return;
  } else if (field === "grammarMode") {
    // Segmented control over the two mutually-exclusive grammar flags; the
    // underlying form fields stay untouched so save/launch payloads are unchanged.
    const model = getModel(state.modal.modelKey);
    const mode = input.value;
    form.enableTinyGrammar = mode === "tiny" && supportsTinyGrammar(model);
    form.enableStructuredGbnf = mode === "structured" && supportsStructuredGbnf(model);
    renderLaunchModal();
    return;
  } else if (field === "enableTinyGrammar") {
    const model = getModel(state.modal.modelKey);
    form.enableTinyGrammar = supportsTinyGrammar(model) ? !!input.checked : false;
    if (form.enableTinyGrammar) {
      form.enableStructuredGbnf = false;
    }
    renderLaunchModal();
    return;
  } else if (field === "enableStructuredGbnf") {
    const model = getModel(state.modal.modelKey);
    form.enableStructuredGbnf = supportsStructuredGbnf(model) ? !!input.checked : false;
    if (form.enableStructuredGbnf) {
      form.enableTinyGrammar = false;
    }
    renderLaunchModal();
    return;
  } else if (field === "enableDry") {
    form.enableDry = !!input.checked;
  } else if (applicationFlag) {
    form[applicationFlag.field] = !!input.checked;
  } else {
    form[field] = (field === "sampleRate" || VOICE_TTS_TUNING_FIELD_NAMES.has(field))
      ? Number(input.value)
      : input.value;
  }
}

function setActiveSection(section) {
  state.activeSection = section;
  persistSection(section);
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.section === section));
  $$(".section").forEach((sectionEl) => {
    const id = sectionEl.id.replace("sec-", "");
    sectionEl.classList.toggle("active", id === section);
  });
  if (section === "huggingface-models" && !state.hf.hasLoaded) {
    refreshHfSearch({ silent: true });
  }
  fetchWebsites();
  if (section === "diagnostics") {
    refreshDiagnostics();
  }
  if (section === "logs") {
    resetLogBuffers();
    refreshLogs({ force: true });
  }
  if (section === "websites") {
    // Show the correct view based on state
    if (state.websiteView === "table") {
      els.websitesGrid?.classList.add("hidden");
      els.websitesTable?.classList.remove("hidden");
      renderWebsitesTable();
    } else {
      els.websitesGrid?.classList.remove("hidden");
      els.websitesTable?.classList.add("hidden");
    }
  }
  if (section === "pm2") {
    renderPm2Table();
  }
  els.pageTitle.textContent = SECTION_TITLES[section] || SECTION_TITLES.models;
  renderActiveSection(section);
}

async function runAction(url, body, options = {}) {
  const actionContext = buildActionContext(url, body, options);
  const isLaunchAction = isLaunchActionContext(actionContext);

  let result = null;
  state.actionInFlight = true;
  render();
  setGlobalActionButtonsDisabled(true);

  try {
    result = await fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    rememberActionFeedback(result, actionContext);
    if (isLaunchAction) {
      if (options.closeModal) {
        closeLaunchModal();
      }
      openActionResultModal("success", result, actionContext);
    } else {
      toast(result.stdout || "done", { type: "success" });
      if (options.closeModal) {
        closeLaunchModal();
      }
    }

    await refreshAll();
    return result;
  } catch (error) {
    rememberActionFeedback(error.data, actionContext);
    if (isLaunchAction) {
      openActionResultModal("error", error.data || { error: error.message || "Launch failed." }, actionContext);
    } else {
      toast(buildActionErrorMessage(error, actionContext), { type: "error", duration: 7000 });
    }
    return null;
  } finally {
    state.actionInFlight = false;
    setGlobalActionButtonsDisabled(false);
    render();
  }
}

function buildActionContext(url, body, options = {}) {
  const context = { ...options };
  const match = String(url || "").match(/^\/api\/applications\/([^/?#]+)/);
  if (!context.applicationKey && match) {
    context.applicationKey = decodeURIComponent(match[1]);
  }
  if (!context.applicationKey && url === "/api/hermes/restart") {
    context.applicationKey = "hermes";
  }
  context.body = body;
  context.url = url;
  return context;
}

// The server owns the application names: the generic integrations take their
// display names from .env, so the literals above are only neutral fallbacks.
function applyServedApplicationLabels(labels) {
  if (!labels || typeof labels !== "object") return;
  for (const application of ALL_APPLICATION_DEFINITIONS) {
    const served = labels[application.key];
    if (!served) continue;
    if (served.label) application.label = served.label;
    if (served.badgeLabel) application.badgeLabel = served.badgeLabel;
    if (served.description) application.description = served.description;
  }
  for (const flag of LLM_APPLICATION_FLAGS) {
    if (labels[flag.appKey]?.label) flag.label = labels[flag.appKey].label;
  }
}

function getApplicationLabel(applicationKey) {
  if (applicationKey === "tts") return "Hermes TTS";
  if (applicationKey === "stt") return "Hermes STT";
  return ALL_APPLICATION_DEFINITIONS.find((application) => application.key === applicationKey)?.label || applicationKey;
}

function compactMessage(message, maxLines = 4) {
  return String(message || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}

function formatSyncEntryMessage(entry) {
  const result = entry?.result || {};
  const primary = compactMessage(result.error || result.reason || "", 3);
  if (primary) {
    return primary;
  }
  if (result.service_state) {
    return `service ${result.service_state}`;
  }
  return result.ok === false ? "Sync failed." : "Sync updated.";
}

function extractSyncEntriesFromPayload(payload, context = {}) {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const entries = [];
  const integrationSync = payload.integration_sync;
  if (integrationSync && typeof integrationSync === "object") {
    for (const [key, result] of Object.entries(integrationSync)) {
      entries.push({ key, label: getApplicationLabel(key), result });
    }
  }
  if (payload.sync && typeof payload.sync === "object" && context.applicationKey) {
    entries.push({ key: context.applicationKey, label: getApplicationLabel(context.applicationKey), result: payload.sync });
  }
  if (payload.hermes_restart && typeof payload.hermes_restart === "object") {
    entries.push({ key: "hermes", label: getApplicationLabel("hermes"), result: payload.hermes_restart });
  }
  return entries.filter((entry, index, all) => (
    all.findIndex((candidate) => candidate.key === entry.key) === index
  ));
}

function rememberActionFeedback(payload, context = {}) {
  for (const entry of extractSyncEntriesFromPayload(payload, context)) {
    if (entry.result?.ok === false) {
      state.applicationFeedback[entry.key] = {
        level: "error",
        message: formatSyncEntryMessage(entry),
      };
      continue;
    }
    if (entry.result?.ok === true && !entry.result?.skipped) {
      delete state.applicationFeedback[entry.key];
    }
  }
}

function buildActionErrorMessage(error, context = {}) {
  const payload = error?.data;
  const baseMessage = compactMessage(payload?.error || error?.message || "Action failed", 4);
  const detailLines = extractSyncEntriesFromPayload(payload, context)
    .filter((entry) => entry.result?.ok === false)
    .map((entry) => `${entry.label}: ${formatSyncEntryMessage(entry)}`)
    .filter((line) => !baseMessage.includes(line));
  return [baseMessage, ...detailLines].filter(Boolean).join("\n");
}

function isLaunchActionContext(context = {}) {
  return context.url === "/api/start" || context.url === "/api/voice/start" || context.url === "/api/profiles/apply";
}

function fallbackLaunchLabel(modelKey) {
  const raw = String(modelKey || "").trim();
  if (!raw) {
    return "model";
  }
  const parts = raw.split("/").filter(Boolean);
  return parts[parts.length - 1] || raw;
}

function resolveLaunchActionSubject(context = {}) {
  if (context.url === "/api/profiles/apply") {
    const profile = (state.profiles || []).find((entry) => entry?.id === context.body?.profileId) || null;
    return {
      kind: "profile",
      label: profile?.name ? `profile ${profile.name}` : "profile",
      subtitle: profile ? buildProfileSummary(profile) : "Profile output stays here until you close it.",
    };
  }

  if (context.url === "/api/voice/start") {
    const model = getVoiceModels().find((entry) => entry.key === context.body?.modelKey) || null;
    const slot = getVoiceSlots().find((entry) => entry.id === context.body?.voiceSlotId) || null;
    return {
      kind: "voice",
      label: model?.label || fallbackLaunchLabel(context.body?.modelKey),
      subtitle: [slot?.label, model?.type ? model.type.toUpperCase() : ""].filter(Boolean).join(" · "),
    };
  }

  const model = getModel(context.body?.modelKey);
  const slot = getSlot(context.body?.slotId);
  const launcher = String(context.body?.launcher || model?.launcher || "").trim();
  return {
    kind: "model",
    label: model?.label || fallbackLaunchLabel(context.body?.modelKey),
    subtitle: [
      slot?.label,
      model?.runtime ? runtimeLabel(model.runtime) : "",
      launcher ? launcherLabel(launcher) : "",
    ].filter(Boolean).join(" · "),
  };
}

function buildLaunchResultSyncEntries(payload, context = {}) {
  return extractSyncEntriesFromPayload(payload, context).map((entry) => {
    const result = entry?.result || {};
    if (result.ok === false) {
      return {
        label: entry.label,
        message: formatSyncEntryMessage(entry),
      };
    }
    if (result.skipped) {
      return {
        label: entry.label,
        message: compactMessage(result.reason || "Skipped.", 3),
      };
    }
    return {
      label: entry.label,
      message: "Updated.",
    };
  });
}

function buildActionResultTitle(context = {}, subject = {}, success = false) {
  if (context.url === "/api/profiles/apply") {
    return success ? `Started ${subject.label}` : `Failed to start ${subject.label}`;
  }
  return success ? `Launched ${subject.label}` : `Failed to launch ${subject.label}`;
}

function openActionResultModal(status, payload, context = {}) {
  const subject = resolveLaunchActionSubject(context);
  const success = status === "success";
  state.actionResultModal = {
    open: true,
    status: success ? "success" : "error",
    title: buildActionResultTitle(context, subject, success),
    subtitle: subject.subtitle || "Launcher output stays here until you close it.",
    summary: compactMessage(
      success
        ? payload?.stdout || `Started ${subject.label}.`
        : payload?.error || payload?.stdout || "Launch failed.",
      8
    ),
    output: String(payload?.stdout || "").trim(),
    error: String(payload?.error || "").trim(),
    syncEntries: buildLaunchResultSyncEntries(payload, context),
  };
  renderActionResultModal();
}

function closeActionResultModal() {
  state.actionResultModal = {
    open: false,
    status: "success",
    title: "",
    subtitle: "",
    summary: "",
    output: "",
    error: "",
    syncEntries: [],
  };
  renderActionResultModal();
}

async function runSlotBenchmark(slotId) {
  const slot = getSlot(slotId);
  if (!slot?.status?.running) {
    toast(`${slot?.label || "Selected slot"} is idle`);
    return;
  }
  state.benchmarkStartInFlight = {
    ...state.benchmarkStartInFlight,
    [slotId]: true,
  };
  render();
  try {
    const result = await fetchJson(`/api/benchmarks/${encodeURIComponent(slotId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    toast(result.stdout || `Started benchmark for ${slot.label}`);
    await refreshOverview();
  } catch (error) {
    toast(error.message || "Benchmark failed to start");
  } finally {
    state.benchmarkStartInFlight = {
      ...state.benchmarkStartInFlight,
      [slotId]: false,
    };
    render();
  }
}

async function runLaunchFromModal() {
  const slot = getSlot(state.modal.slotId);
  const model = getModel(state.modal.modelKey);
  const form = ensureModalForm();
  if (!slot || !model) {
    toast("select a model first");
    return;
  }

  await runAction(
    "/api/start",
    buildLaunchRequestPayload(slot, model, form),
    { closeModal: true }
  );
}

async function runLaunchModelWithDefaults(modelKey) {
  const model = getModel(modelKey);
  const slot = getSlot(findPreferredSlotId(modelKey));
  if (!model || !slot) {
    toast("select a model first");
    return;
  }

  await runAction(
    "/api/start",
    buildLaunchRequestPayload(slot, model, buildDefaultLaunchForm(slot, model)),
    { preserveModal: false }
  );
}

async function runSaveDefaultsFromModal() {
  const slot = getSlot(state.modal.slotId);
  const model = getModel(state.modal.modelKey);
  const form = ensureModalForm();
  if (!slot || !model) {
    toast("select a model first");
    return;
  }

  const grammarSelection = normalizeGrammarSelection(model, form);
  const speedTricks = normalizeSpeedTrickSelection(model, form);
  await runAction(
    "/api/defaults",
    {
      slotId: slot.id,
      modelKey: model.key,
      ctxSize: Number(form.ctxSize),
      parallel: Number(form.parallel),
      thinking: model.supportsThinking ? Boolean(form.thinking) : false,
      ...grammarSelection,
      ...speedTricks,
      temperature: Number(form.temperature),
      topP: Number(form.topP),
      topK: Number(form.topK),
      minP: Number(form.minP),
      presencePenalty: Number(form.presencePenalty),
      repetitionPenalty: Number(form.repetitionPenalty),
      chatTemplate: resolveFormChatTemplate(model, form),
      launcher: form.launcher || model.launcher || getLauncherOptions(model)[0] || "gguf",
    },
    { preserveModal: true }
  );
  await saveApplicationPrefsFromModal(slot, model, form);
}

// Persist the application checkboxes as a soft preference scoped by how the modal
// was opened: per-model (gear icon) or per-slot (slot dropdown). Does not change
// live routing — that only happens on Launch.
async function saveApplicationPrefsFromModal(slot, model, form) {
  const applicationTargets = buildApplicationTargetRequest(form);
  const payload = state.modal.entryPoint === "slot"
    ? { scope: "slot", slotId: slot.id, applicationTargets }
    : { scope: "model", modelKey: model.key, applicationTargets };
  try {
    const result = await fetchJson("/api/application-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    applyOverview(result);
    render();
  } catch (error) {
    toast(error?.data?.error || error?.message || "Failed to save application preferences.", {
      type: "error",
      duration: 7000,
    });
  }
}

async function runStopModel(modelKey) {
  const model = getModel(modelKey);
  if (!model) {
    toast("unknown model");
    return;
  }
  const runningSlots = getRunningModelSlots(model);
  if (!runningSlots.length) {
    toast(`${model.label} is not running`);
    return;
  }
  for (const { slot } of runningSlots) {
    await runAction("/api/stop", { slotId: slot.id }, { preserveModal: false });
  }
}

async function runDeleteModel(modelKey) {
  state.actionInFlight = true;
  render();
  try {
    const result = await fetchJson("/api/models/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelKey }),
    });
    toast(result.stdout || "Model deleted.");
    applyOverview(result);
    refreshHfDownloads();
    render();
  } catch (error) {
    toast(error.message || "Delete failed");
  } finally {
    state.actionInFlight = false;
    updateTopbarSpinner();
    render();
  }
}

async function refreshHfSearch(options = {}) {
  const silent = Boolean(options.silent);
  state.hf.hasLoaded = true;
  state.hf.loading = true;
  state.hf.error = "";
  if (!silent) {
    renderHfSearch();
  }
  try {
    const query = encodeURIComponent(String(state.hf.query || "").trim());
    const sort = encodeURIComponent(state.hf.sort);
    const direction = encodeURIComponent(state.hf.direction);
    const data = await fetchJson(`/api/hf/search?query=${query}&sort=${sort}&direction=${direction}`);
    state.hf.results = data.results || [];
    syncCachedHfFavorites(state.hf.results);
    state.hf.error = "";
  } catch (error) {
    state.hf.results = [];
    state.hf.error = error.message || "Search failed";
  } finally {
    state.hf.loading = false;
    if (state.activeSection === "huggingface-models") {
      renderHfSearch();
    }
  }
}

async function refreshHfDownloads() {
  try {
    const data = await fetchJson("/api/hf/downloads");
    state.hf.downloads = data.jobs || [];
    if (state.activeSection === "huggingface-models") {
      rerenderHfPanels({ preserveUi: true });
    }
  } catch (_error) {
    return;
  }
}

async function clearHfDownloads(jobId = "", options = {}) {
  try {
    const result = await fetchJson("/api/hf/downloads/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...(jobId ? { jobId } : {}), ...(options.failedOnly ? { failedOnly: true } : {}) }),
    });
    state.hf.downloads = result.jobs || [];
    rerenderHfPanels({ preserveUi: true });
  } catch (error) {
    toast(error.message || (options.failedOnly ? "Unable to delete failed downloads" : "Unable to clear download history"));
  }
}

async function runHfDownload(candidate) {
  try {
    const result = await fetchJson("/api/hf/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate }),
    });
    state.hf.downloads = result.jobs || state.hf.downloads;
    state.hf.mobilePane = "downloads";
    state.hf.mobilePaneTouched = true;
    toast(`Queued ${candidate.name}`);
    rerenderHfPanels({ preserveUi: true });
  } catch (error) {
    toast(error.message || "Download failed");
  }
}

const HF_CONVERT_QUANT_OPTIONS = [
  { value: "Q4_K_M", label: "Q4_K_M — recommended", hint: "≈4.8 bits/weight. The usual best balance of size and quality.", sizeFactor: 0.3 },
  { value: "Q3_K_M", label: "Q3_K_M — smallest", hint: "≈3.9 bits/weight. Noticeably lossy; only when disk/RAM is tight.", sizeFactor: 0.25 },
  { value: "Q4_K_S", label: "Q4_K_S — small", hint: "Slightly smaller and slightly lossier than Q4_K_M.", sizeFactor: 0.28 },
  { value: "Q5_K_M", label: "Q5_K_M — higher quality", hint: "≈5.7 bits/weight. Closer to original at ~20% more size than Q4_K_M.", sizeFactor: 0.36 },
  { value: "Q6_K", label: "Q6_K — near lossless", hint: "≈6.6 bits/weight. Very close to the original model.", sizeFactor: 0.41 },
  { value: "Q8_0", label: "Q8_0 — effectively lossless", hint: "8.5 bits/weight. Also the fastest conversion (no separate quantize pass).", sizeFactor: 0.53 },
  { value: "BF16", label: "BF16 — full precision", hint: "Straight copy of the weights into GGUF. Biggest output, no quality loss.", sizeFactor: 1 },
  { value: "F16", label: "F16 — full precision", hint: "Like BF16 but stored as float16 (better Metal support on older llama.cpp).", sizeFactor: 1 },
];

function runHfConvert(candidate) {
  openHfConvertModal(candidate);
}

function openHfConvertModal(candidate) {
  if (!els.hfConvertModal || !els.hfConvertQuantSelect) {
    return;
  }
  state.hf.convertCandidate = candidate;
  state.hf.convertModalOpen = true;
  state.hf.convertSubmitting = false;
  els.hfConvertModalSubtitle.textContent = `Convert ${candidate.fullName || candidate.name} to a GGUF you can run locally.`;
  els.hfConvertQuantSelect.innerHTML = HF_CONVERT_QUANT_OPTIONS
    .map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`)
    .join("");
  els.hfConvertQuantSelect.value = "Q4_K_M";
  const sourceRepoId = String(candidate?.conversionRepoId || "").trim();
  const usesOtherRepo = sourceRepoId && sourceRepoId !== candidate.repoId;
  els.hfConvertSourceNote.classList.toggle("hidden", !usesOtherRepo);
  if (usesOtherRepo) {
    els.hfConvertSourceNote.textContent = `This repo's quantization can't be converted directly, so the original weights will be pulled from ${sourceRepoId} instead.`;
  }
  updateHfConvertQuantHint();
  els.hfConvertConfirmBtn.disabled = false;
  els.hfConvertConfirmBtn.textContent = "Start conversion";
  els.hfConvertModal.classList.remove("hidden");
  els.hfConvertModal.setAttribute("aria-hidden", "false");
  els.hfConvertQuantSelect.focus();
}

function closeHfConvertModal() {
  if (!els.hfConvertModal) {
    return;
  }
  state.hf.convertModalOpen = false;
  state.hf.convertCandidate = null;
  state.hf.convertSubmitting = false;
  els.hfConvertModal.classList.add("hidden");
  els.hfConvertModal.setAttribute("aria-hidden", "true");
}

function updateHfConvertQuantHint() {
  if (!els.hfConvertQuantHint || !els.hfConvertQuantSelect) {
    return;
  }
  const option = HF_CONVERT_QUANT_OPTIONS.find((entry) => entry.value === els.hfConvertQuantSelect.value);
  if (!option) {
    els.hfConvertQuantHint.textContent = "";
    return;
  }
  const sizeBytes = Number(state.hf.convertCandidate?.sizeBytes || 0);
  const estimate = sizeBytes > 0 ? ` Rough output size: ~${fmtBytes(sizeBytes * option.sizeFactor)}.` : "";
  els.hfConvertQuantHint.textContent = `${option.hint}${estimate}`;
}

async function submitHfConvert() {
  const candidate = state.hf.convertCandidate;
  if (!candidate || state.hf.convertSubmitting) {
    return;
  }
  const quantization = els.hfConvertQuantSelect?.value || "Q4_K_M";
  state.hf.convertSubmitting = true;
  els.hfConvertConfirmBtn.disabled = true;
  els.hfConvertConfirmBtn.textContent = "Queuing…";
  try {
    const result = await fetchJson("/api/hf/conversions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidate, quantization }),
    });
    state.hf.downloads = result.jobs || state.hf.downloads;
    state.hf.mobilePane = "downloads";
    state.hf.mobilePaneTouched = true;
    const sourceRepoId = String(candidate?.conversionRepoId || "").trim();
    toast(
      sourceRepoId && sourceRepoId !== candidate.repoId
        ? `Queued ${quantization} conversion for ${candidate.name} using ${sourceRepoId}`
        : `Queued ${quantization} conversion for ${candidate.name}`
    );
    closeHfConvertModal();
    rerenderHfPanels({ preserveUi: true });
  } catch (error) {
    state.hf.convertSubmitting = false;
    els.hfConvertConfirmBtn.disabled = false;
    els.hfConvertConfirmBtn.textContent = "Start conversion";
    toast(error.message || "Conversion failed");
  }
}

async function cancelHfJob(jobId) {
  try {
    const result = await fetchJson("/api/hf/downloads/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    state.hf.downloads = result.jobs || state.hf.downloads;
    rerenderHfPanels({ preserveUi: true });
  } catch (error) {
    toast(error.message || "Unable to cancel job");
  }
}

function isMobileHfLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function getEffectiveModelView() {
  if (!state.modelViewTouched) {
    return isMobileHfLayout() ? "cards" : "table";
  }
  return state.modelView === "cards" ? "cards" : "table";
}

function updateHfDownloadsPanelUi() {
  if (!els.hfDownloadsPanel || !els.hfLayout || !els.hfResultsPanel) {
    return;
  }
  const mobile = isMobileHfLayout();
  els.hfDownloadsToggleBtn.hidden = true;
  els.hfLayout.classList.toggle("mobile-pane-mode", mobile);
  els.hfResultsPanel.classList.toggle("mobile-hidden", mobile && state.hf.mobilePane !== "results");
  els.hfDownloadsPanel.classList.toggle("mobile-hidden", mobile && state.hf.mobilePane !== "downloads");
  els.hfSplitter.hidden = mobile;
  if (els.hfMobilePaneToggles) {
    els.hfMobilePaneToggles.hidden = !mobile;
    els.hfMobilePaneToggles.querySelectorAll("[data-hf-mobile-pane]").forEach((button) => {
      const active = button.dataset.hfMobilePane === state.hf.mobilePane;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }
  if (mobile) {
    els.hfLayout.style.gridTemplateColumns = "1fr";
    return;
  }
  const rect = els.hfLayout.getBoundingClientRect();
  const splitterWidth = 12;
  const minLeft = 420;
  const minRight = 320;
  const totalWidth = Math.max(rect.width, minLeft + minRight + splitterWidth);
  const available = Math.max(totalWidth - splitterWidth, minLeft + minRight);
  const desiredLeft = Math.round(available * state.hf.splitRatio);
  const left = Math.max(minLeft, Math.min(available - minRight, desiredLeft));
  const right = Math.max(minRight, available - left);
  els.hfLayout.style.gridTemplateColumns = `${left}px ${splitterWidth}px minmax(${minRight}px, ${right}px)`;
}

function setHfDownloadsCollapsed(collapsed, options = {}) {
  state.hf.downloadsCollapsed = Boolean(collapsed);
  if (options.user) {
    state.hf.downloadsCollapseTouched = true;
  }
  updateHfDownloadsPanelUi();
}

function syncHfDownloadsPanel(options = {}) {
  if (!isMobileHfLayout()) {
    state.hf.mobilePane = "results";
    updateHfDownloadsPanelUi();
    return;
  }
  if (options.force || !state.hf.mobilePaneTouched) {
    state.hf.mobilePane = "results";
  }
  updateHfDownloadsPanelUi();
}

function rerenderHfPanels(options = {}) {
  if (state.activeSection !== "huggingface-models") {
    return;
  }
  const preserveUi = options.preserveUi !== false;
  const uiState = preserveUi ? captureUiState() : null;
  renderHfSearch();
  renderHfDownloads();
  populateHfCompanionTargets();
  if (uiState) {
    restoreUiState(uiState);
  }
}

function populateHfCompanionTargets() {
  const select = els.hfCompanionTarget;
  if (!select) {
    return;
  }
  const directories = new Map();
  for (const model of state.models || []) {
    const modelPath = String(model.path || model.key || "").trim();
    // Any local model dir qualifies; the server rejects paths outside ~/models.
    if (!modelPath || !(model.downloaded || String(model.runtime || "") === "gguf")) {
      continue;
    }
    const dir = modelPath.toLowerCase().endsWith(".gguf") ? modelPath.slice(0, modelPath.lastIndexOf("/")) : modelPath;
    if (dir && !directories.has(dir)) {
      directories.set(dir, model.label || dir.split("/").at(-1));
    }
  }
  const signature = [...directories.keys()].join("|");
  if (select.dataset.signature === signature) {
    return;
  }
  const previous = select.value;
  select.dataset.signature = signature;
  select.innerHTML = [...directories.entries()]
    .sort((left, right) => left[1].localeCompare(right[1]))
    .map(([dir, label]) => `<option value="${esc(dir)}">${esc(label)} — ${esc(dir)}</option>`)
    .join("");
  if (previous && directories.has(previous)) {
    select.value = previous;
  }
}

async function submitHfCompanion(event) {
  event.preventDefault();
  const form = els.hfCompanionForm;
  if (!form) {
    return;
  }
  const payload = {
    targetDir: String(form.elements.targetDir?.value || "").trim(),
    repoId: String(form.elements.repoId?.value || "").trim(),
    filePath: String(form.elements.filePath?.value || "").trim(),
    kind: String(form.elements.kind?.value || "other").trim(),
  };
  if (!payload.targetDir || !payload.repoId || !payload.filePath) {
    toast("Target model, repo id, and file path are required.");
    return;
  }
  if (els.hfCompanionStatus) {
    els.hfCompanionStatus.textContent = "Queueing…";
  }
  try {
    const result = await fetchJson("/api/hf/companions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    state.hf.downloads = result.jobs || state.hf.downloads;
    if (els.hfCompanionStatus) {
      els.hfCompanionStatus.textContent = `Queued ${payload.filePath.split("/").at(-1)}`;
    }
    toast(`Queued companion ${payload.filePath.split("/").at(-1)}`);
    rerenderHfPanels({ preserveUi: true });
  } catch (error) {
    if (els.hfCompanionStatus) {
      els.hfCompanionStatus.textContent = "";
    }
    toast(error.message || "Companion download failed");
  }
}

function syncResponsiveUi() {
  renderFilters();
  renderModels();
  updateHfDownloadsPanelUi();
  if (state.activeSection === "huggingface-models") {
    renderHfSearch();
    renderHfDownloads();
  }
  if (state.modal.open) {
    renderLaunchModal();
  }
}

function startHfSplitterDrag(event) {
  if (isMobileHfLayout() || !els.hfLayout) {
    return;
  }
  event.preventDefault();
  const move = (moveEvent) => {
    const rect = els.hfLayout.getBoundingClientRect();
    const splitterWidth = 12;
    const minLeft = 420;
    const minRight = 320;
    const available = Math.max(rect.width - splitterWidth, minLeft + minRight);
    const offset = moveEvent.clientX - rect.left;
    const left = Math.max(minLeft, Math.min(available - minRight, offset));
    state.hf.splitRatio = left / available;
    updateHfDownloadsPanelUi();
  };
  const stop = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", stop);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", stop, { once: true });
}

function getDownloadedHfCandidateIds() {
  const ids = new Set();
  for (const model of state.models || []) {
    if (!model?.downloaded) {
      continue;
    }
    const explicitId = String(model.downloadId || "").trim();
    if (explicitId) {
      ids.add(explicitId);
      continue;
    }
    const repoId = String(model.repoId || "").trim();
    const runtime = String(model.runtime || "").trim();
    if (repoId && runtime === "mlx") {
      ids.add(`mlx:${repoId}`);
    }
  }
  return ids;
}

async function refreshAll() {
  await Promise.all([
    refreshOverview(),
    refreshDiagnostics(),
    refreshHermesStatus(),
    refreshVoiceBenchmarkState({ silent: true }),
    state.launchersModal.open ? refreshLauncherCatalog({ silent: true }) : Promise.resolve(),
  ]);
  if (state.activeSection === "logs") {
    resetLogBuffers();
    await refreshLogs({ force: true });
  }
}

async function refreshOverview() {
  try {
    const data = await fetchJson("/api/overview");
    applyOverview(data);
    state.connected = true;
    updateConnectionStatus(true);
    if (state.editingApplications || isRefreshPaused() || hasActiveModelsInteraction()) {
      renderTopbarMetrics();
      renderGlobalActionButtons();
      updateSlotWorkingIndicators();
      return;
    }
    if (state.activeSection === "voice-benchmark") {
      renderTopbarMetrics();
      renderHermesIndicators();
      renderGlobalActionButtons();
      updateSlotWorkingIndicators();
      return;
    }
    render({ includeModal: !state.modal.open });
  } catch (_error) {
    state.connected = false;
    updateConnectionStatus(false);
  }
}

async function refreshActiveBenchmarks() {
  const hasRunningBenchmark = state.slots.some((slot) => slot?.benchmark?.status === "running");
  const isStartingBenchmark = Object.values(state.benchmarkStartInFlight || {}).some(Boolean);
  if (!hasRunningBenchmark && !isStartingBenchmark) {
    return;
  }
  await refreshOverview();
}

function applyOverview(data) {
  const previousVoiceTtsCount = Array.isArray(state.voiceModels)
    ? state.voiceModels.filter((model) => model.type === "tts").length
    : 0;
  state.models = data.models || [];
  // The server sends the built-in name as `label` and the user's name as `name`.
  // Fold them here so the ~40 places that already render `slot.label` pick the
  // custom name up without each one having to know about renaming.
  state.slots = [...(data.slots || [])]
    .sort((left, right) => left.index - right.index)
    .map((slot) => ({
      ...slot,
      label: String(slot.name || "").trim() || slot.label,
      defaultName: String(slot.defaultName || slot.label || "").trim(),
    }));
  state.voiceModels = data.voiceModels || [];
  state.voiceSlots = [...(data.voiceSlots || [])].sort((left, right) => left.index - right.index);
  state.system = data.system || null;
  if (data.runtime?.lanIp) {
    LAN_IP = data.runtime.lanIp;
  }
  state.profiles = Array.isArray(data.profiles) ? data.profiles : [];
  state.defaultProfileId = String(data.defaultProfileId || "").trim();
  state.activeProfileId = String(data.activeProfileId || "").trim();
  state.preferredLaunchers = data.preferredLaunchers || {};
  state.modelApplicationPreferences = data.modelApplicationPreferences || {};
  state.slotApplicationPreferences = data.slotApplicationPreferences || {};
  if (!getProfileById(state.selectedProfileId)) {
    state.selectedProfileId = state.activeProfileId
      || state.defaultProfileId
      || state.profiles[0]?.id
      || "";
  }
  state.applicationTargets = data.applicationTargets || buildDefaultApplicationTargets();
  state.applications = Array.isArray(data.applications) ? data.applications : buildApplicationItems();
  state.applicationMachines = Array.isArray(data.applicationMachines) ? data.applicationMachines : state.applicationMachines;
  applyServedApplicationLabels(data.applicationLabels);
  state.integrationTargets = data.integrationTargets || buildDefaultIntegrationTargets();
  state.actionInFlight = Boolean(data.actionInFlight);
  syncApplicationDrafts();

  // Ensure voice log slot exists
  if (!getVoiceSlot(state.activeVoiceLogSlotId)) {
    state.activeVoiceLogSlotId = state.voiceSlots[0]?.id || "voice-tts-1";
  }

  if (!getSlot(state.activeLogSlotId)) {
    state.activeLogSlotId = state.slots[0]?.id || "slot1";
  }

  if (state.activeSection === "voice-benchmark") {
    const nextVoiceTtsCount = getTtsVoiceModels().length;
    if (nextVoiceTtsCount !== previousVoiceTtsCount) {
      renderVoiceBenchmark();
    }
  }

  if (state.modal.open) {
    if (state.modal.voiceModel) {
      // Voice model mode — check if the voice model still exists
      const voiceModel = getVoiceModels().find((m) => m.key === state.modal.voiceModel);
      if (!voiceModel) {
        closeLaunchModal();
      } else if (!getVoiceSlot(state.modal.voiceSlotId)) {
        openVoiceLaunchModal(state.modal.voiceModel);
      }
    } else {
      // LLM model mode
      const currentModel = getModel(state.modal.modelKey);
      if (!currentModel) {
        closeLaunchModal();
      } else if (!getSlot(state.modal.slotId)) {
        openLaunchModal(currentModel.key);
      }
    }
  }

  if (state.profileModal.open) {
    const currentProfile = getProfileById(state.profileModal.profileId);
    if (state.profileModal.profileId && !currentProfile) {
      closeProfileModal();
    } else if (!getSlot(state.profileModal.activeSlotId)) {
      state.profileModal.activeSlotId = state.slots[0]?.id || "slot1";
    }
  }
}

async function refreshLogs({ force } = {}) {
  if (state.activeSection !== "logs" && !force) {
    updateSlotWorkingIndicators();
    return;
  }
  if (state.logsPaused && !force) {
    updateSlotWorkingIndicators();
    return;
  }
  const requests = [];
  const activeSlot = getSlot(state.activeLogSlotId) || state.slots[0] || null;
  if (!activeSlot) {
    return;
  }
  // The other kinds are cheap incremental chunks of one file each, so they are
  // kept warm for instant tab switching. The llm3 kind merges three whole tails
  // on every call, so it is fetched only while it is on screen.
  ["thinking", "traffic", "server", "proxy"].forEach((kind) => {
    requests.push(refreshLogKind(activeSlot.id, kind));
  });
  if (state.activeLogKind === "llm3") {
    requests.push(refreshLogKind(activeSlot.id, "llm3"));
  }
  await Promise.all(requests);
  updateSlotWorkingIndicators();
  if (state.activeSection === "logs") {
    renderLogs();
  }
}

async function refreshDiagnostics() {
  state.diagnostics.loading = true;
  try {
    const data = await fetchJson("/api/diagnostics/errors");
    state.diagnostics.entries = Array.isArray(data.entries) ? data.entries : [];
    state.diagnostics.updatedAt = String(data.updatedAt || "");
    state.diagnostics.error = "";
  } catch (error) {
    state.diagnostics.error = error.message || "Unable to load diagnostics.";
  } finally {
    state.diagnostics.loading = false;
  }

  if (state.activeSection === "diagnostics") {
    renderDiagnostics();
  }
}

async function refreshHermesStatus() {
  if (state.hermesStatus.loading) {
    return;
  }
  state.hermesStatus.loading = true;
  try {
    const data = await fetchJson("/api/hermes/status");
    state.hermesStatus.remote = data.remote || null;
    state.hermesStatus.local = data.local || null;
    state.hermesStatus.updatedAt = String(data.updatedAt || "");
  } catch (_error) {
    // Keep the previous status visible if polling fails.
  } finally {
    state.hermesStatus.loading = false;
    renderHermesIndicators();
  }
}

async function refreshHermesFeed() {
  if (!state.hermesFeedModal.open || state.hermesFeedModal.loading || !state.hermesFeedModal.runtime) {
    return;
  }
  state.hermesFeedModal.loading = true;
  try {
    const data = await fetchJson(`/api/hermes/feed/${encodeURIComponent(state.hermesFeedModal.runtime)}`);
    state.hermesFeedModal.label = String(data.label || state.hermesFeedModal.label || "Hermes");
    state.hermesFeedModal.hostLabel = String(data.hostLabel || state.hermesFeedModal.hostLabel || "");
    state.hermesFeedModal.state = String(data.state || "offline");
    state.hermesFeedModal.online = Boolean(data.online);
    state.hermesFeedModal.working = Boolean(data.working);
    state.hermesFeedModal.serviceState = String(data.serviceState || "");
    state.hermesFeedModal.sessionId = String(data.sessionId || "");
    state.hermesFeedModal.updatedAt = String(data.updatedAt || "");
    state.hermesFeedModal.entries = Array.isArray(data.entries) ? data.entries : [];
    state.hermesFeedModal.error = "";
  } catch (error) {
    state.hermesFeedModal.error = error.message || "Unable to load Hermes activity feed.";
  } finally {
    state.hermesFeedModal.loading = false;
    renderHermesFeedModal();
  }
}

async function refreshLogKind(slotId, kind) {
  const logState = ensureLogState(slotId, kind);
  try {
    const requestOffset = kind === "thinking"
      ? Number(state.thinkingClearOffsets?.[slotId] ?? 0)
      : Number(logState.offset || 0);
    const data = await fetchJson(`/api/logs/${slotId}/${kind}?offset=${requestOffset}`);
    logState.offset = data.nextOffset;
    if (kind === "traffic") {
      if (data.reset) {
        logState.entries = data.entries || [];
      } else {
        logState.entries.push(...(data.entries || []));
      }
      logState.entries = logState.entries.slice(-100);
    } else if (kind === "thinking") {
      if (Number(data.clearOffset || 0) > Number(state.thinkingClearOffsets?.[slotId] || 0)) {
        state.thinkingClearOffsets[slotId] = Number(data.clearOffset || 0);
        persistThinkingClearOffsets();
      }
      logState.text = data.content || "";
      if (logState.text.length > 500000) {
        logState.text = logState.text.slice(-500000);
      }
    } else {
      if (data.reset) {
        logState.text = data.content || "";
      } else {
        logState.text += data.content || "";
      }
      if (logState.text.length > 250000) {
        logState.text = logState.text.slice(-250000);
      }
    }
  } catch (_error) {
    return;
  }
}

function render(options = {}) {
  const { includeModal = true } = options;
  const uiState = captureUiState();
  renderTopbarMetrics();
  renderHermesIndicators();
  renderGlobalActionButtons();
  renderActiveSection();
  if (includeModal) {
    renderProfileModal();
    renderLaunchModal();
    renderActionResultModal();
    renderSaveLayoutModal();
    renderVoiceTuningModal();
    renderHermesFeedModal();
    renderLaunchersModal();
    renderLauncherCommandPreview();
  }
  bindWheelScrollContainers();
  restoreUiState(uiState);
  updateSlotWorkingIndicators();
  // Slot list and live panel only — NOT the transcript, which must not be re-rendered
  // out from under a stream or the user's scroll position.
  renderChatSlotOptions();
  renderChatLive();
}

function renderActiveSection(section = state.activeSection) {
  switch (section) {
    case "huggingface-models":
      renderHfSearch();
      renderHfDownloads();
      break;
    case "voice":
      renderVoice();
      break;
    case "status":
      renderStatus();
      break;
    case "system":
      renderSystem();
      break;
    case "logs":
      renderLogTabs();
      renderLogs();
      break;
    case "diagnostics":
      renderDiagnostics();
      break;
    case "applications":
      renderApplications();
      break;
    case "benchmarks":
      break;
    case "voice-benchmark":
      renderVoiceBenchmark();
      break;
    case "websites":
      if (state.websiteView === "table") {
        renderWebsitesTable();
      } else {
        renderWebsites();
      }
      break;
    case "pm2":
      renderPm2Table();
      break;
    case "models":
    default:
      renderProfileControls();
      renderFilters();
      renderModels();
      break;
  }
}

// --- Websites ---
// Card icons are per-site SVG paths from the server (a git-ignored local file,
// see /api/websites), because the site names are private.

// Cards that open inside llm3 as an iframe instead of linking out. They are not
// real Websites-tab rows: they point at a reverse-proxy route llm3 serves on its
// own origin (see embed_proxy.js), so they must never be edited, deleted, or
// opened in a new tab like a normal entry. The server builds them from
// LLM3_EMBED_SITES in .env, so the public code names no site.
async function fetchEmbedSiteCards() {
  try {
    const res = await fetch("/api/embed-sites");
    return res.ok ? await res.json() : [];
  } catch (_e) {
    return [];
  }
}

async function fetchWebsites() {
  try {
    const [res, embedCards] = await Promise.all([fetch("/api/websites"), fetchEmbedSiteCards()]);
    state.websites = [...embedCards, ...(await res.json())];
    if (state.activeSection === "websites") {
      if (state.websiteView === "table") {
        renderWebsitesTable();
      } else {
        renderWebsites();
      }
    } else if (state.activeSection === "pm2") {
      renderPm2Table();
    }
  } catch (e) {
    console.warn("Failed to fetch websites:", e);
  }
}

async function restartLlm3() {
  if (state.actionInFlight) {
    return;
  }
  state.actionInFlight = true;
  render();
  setGlobalActionButtonsDisabled(true);

  try {
    const result = await fetchJson("/api/llm3/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    toast(result.stdout || "Restarting llm3...", { type: "success", duration: 5000 });
    setTimeout(() => {
      window.location.reload();
    }, 3500);
  } catch (error) {
    toast(error.message || "Unable to restart llm3.", { type: "error", duration: 7000 });
  } finally {
    state.actionInFlight = false;
    setGlobalActionButtonsDisabled(false);
    render();
  }
}

// Narrow the website list by the search box. Matches on name, category and
// both URLs, with the internal URL taken in its LAN form as well so that
// typing the machine's address finds the loopback rows the table now shows.
// Every whitespace-separated term must match, which makes "nuc track" a
// usable query.
function filterWebsitesBySearch(websites) {
  const query = String(state.websiteSearch || "").trim().toLowerCase();
  if (!query) return websites;
  const terms = query.split(/\s+/);
  return websites.filter((w) => {
    const haystack = [
      w.name,
      w.category,
      w.internal_url,
      toLanUrl(w.internal_url, w),
      w.external_url,
      w.pm2App,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

function renderWebsites() {
  if (!els.websitesCategories || !els.websitesGrid) return;

  const websites = state.websites || [];
  const categories = [...new Set(websites.map((w) => w.category))];

  // Resolve the usable URL for a website card
  function resolveUrl(w) {
    if (w.external_url && w.external_url.trim() !== "") {
      return w.external_url;
    }
    return toLanUrl(w.internal_url, w);
  }

  // Determine if a website has a true external subdomain (nginx)
  function hasExternalSubdomain(w) {
    return w.external_url && w.external_url.trim() !== "" && (w.external_url.startsWith("https://") || w.external_url.startsWith("http://"));
  }

 // Website color palette — one per category for visual distinction
  const cardColors = [
    { bg: "rgba(99,102,241,0.12)", border: "rgba(99,102,241,0.35)", icon: "#818cf8" },   // indigo
    { bg: "rgba(16,185,129,0.12)", border: "rgba(16,185,129,0.35)", icon: "#34d399" },   // emerald
    { bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)", icon: "#fbbf24" },   // amber
    { bg: "rgba(239,68,68,0.12)",  border: "rgba(239,68,68,0.35)",  icon: "#f87171" },   // red
    { bg: "rgba(139,92,246,0.12)", border: "rgba(139,92,246,0.35)", icon: "#a78bfa" },   // violet
    { bg: "rgba(6,182,212,0.12)",  border: "rgba(6,182,212,0.35)",  icon: "#22d3ee" },   // cyan
    { bg: "rgba(236,72,153,0.12)", border: "rgba(236,72,153,0.35)", icon: "#f472b6" },   // pink
    { bg: "rgba(34,197,94,0.12)",  border: "rgba(34,197,94,0.35)",  icon: "#4ade80" },   // green
    { bg: "rgba(251,146,60,0.12)", border: "rgba(251,146,60,0.35)", icon: "#fb923c" },   // orange
    { bg: "rgba(14,165,233,0.12)", border: "rgba(14,165,233,0.35)", icon: "#38bdf8" },   // sky
    { bg: "rgba(244,114,182,0.12)", border: "rgba(244,114,182,0.35)", icon: "#f472b6" }, // rose
    { bg: "rgba(168,85,247,0.12)", border: "rgba(168,85,247,0.35)", icon: "#c084fc" },   // purple
    { bg: "rgba(20,184,166,0.12)", border: "rgba(20,184,166,0.35)", icon: "#2dd4bf" },   // teal
    { bg: "rgba(217,119,6,0.12)",  border: "rgba(217,119,6,0.35)",  icon: "#d97706" },   // amber-dark
    { bg: "rgba(37,99,235,0.12)",  border: "rgba(37,99,235,0.35)",  icon: "#60a5fa" },   // blue
    { bg: "rgba(120,53,15,0.12)",  border: "rgba(120,53,15,0.35)",  icon: "#a16207" },   // yellow-brown
  ];

  // Hash function: maps a website name to a deterministic index in the color palette
  function nameColorHash(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % cardColors.length;
  }

  // Category filter state. Counts come from the searched set, so a category
  // reading 0 says "nothing here matches" rather than hiding that fact behind
  // its full total. The category list itself stays complete, so the chips do
  // not jump around while typing.
  const searched = filterWebsitesBySearch(websites);
  const allCount = searched.length;
  const activeCat = state._websiteActiveCategory || "All";

  // Render category tabs — "All" first, then per-category
  els.websitesCategories.innerHTML =
    `<button class="category-chip ${activeCat === "All" ? "active" : ""}" data-category="All">All <span class="cat-count">${allCount}</span></button>` +
    categories
      .map((cat) => {
        const count = searched.filter((w) => w.category === cat).length;
        const chipActive = cat === activeCat ? "active" : "";
        return `<button class="category-chip ${chipActive}" data-category="${esc(cat)}">${esc(cat)} <span class="cat-count">${count}</span></button>`;
      })
      .join("");

  // Add category click handlers
  els.websitesCategories.querySelectorAll(".category-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      state._websiteActiveCategory = chip.dataset.category;
      renderWebsites();
    });
  });

  // Filter by active category (or "All")
  const filtered = activeCat === "All" ? searched : searched.filter((w) => w.category === activeCat);

  if (!filtered.length) {
    els.websitesGrid.innerHTML = `<p class="websites-empty">${
      state.websiteSearch ? "No website matches this search." : "No website in this category."
    }</p>`;
    return;
  }

  // Render grid
  els.websitesGrid.innerHTML = filtered.map((w, idx) => {
    const colorIdx = nameColorHash(w.name);
    const color = cardColors[colorIdx];
    const url = resolveUrl(w);
    const lanOnly = !hasExternalSubdomain(w);
    const iconSvg = w.iconPath
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${esc(w.iconPath)}"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    const shortName = w.name.length > 16 ? w.name.slice(0, 15) + "…" : w.name;
    const lanBadge = lanOnly ? `<span class="website-lan-badge">Local</span>` : "";
    const onlineDot = w.online
      ? `<span class="website-status-dot website-status-dot-online" title="Online"></span>`
      : `<span class="website-status-dot website-status-dot-offline" title="Offline"></span>`;
    // An embedded site opens inside llm3 as an iframe, not a new tab. It is a
    // button, not a link: no href to leak, no target, and a small badge so it is
    // visibly a different kind of card.
    if (w.embed) {
      return `
        <button type="button" class="website-card website-card-embed" data-embed="${esc(w.embed)}" data-embed-title="${esc(w.name)}" title="Open ${esc(w.name)} inside llm3"
           style="--wb-bg:${color.bg};--wb-border:${color.border};--wb-icon:${color.icon}">
          <div class="website-card-icon">${iconSvg}</div>
          <span class="website-card-name">${shortName}</span>
          <span class="website-card-cat">${esc(w.category)}</span>
          <span class="website-embed-badge">Embed</span>
        </button>`;
    }
    return `
      <a class="website-card" data-id="${w.id}" data-online="${w.online ? "1" : "0"}" href="${safeHref(url)}" target="_blank" rel="noopener" title="${esc(url)}" draggable="false"
         style="--wb-bg:${color.bg};--wb-border:${color.border};--wb-icon:${color.icon}">
        <div class="website-card-icon">${iconSvg}</div>
        <span class="website-card-name">${shortName}</span>
        <span class="website-card-cat">${esc(w.category)}</span>
        ${lanBadge}
        ${onlineDot}
      </a>`;
  }).join("");

  // Embedded cards open the in-page iframe overlay.
  els.websitesGrid.querySelectorAll(".website-card-embed").forEach((card) => {
    card.addEventListener("click", () => openEmbedOverlay(card.dataset.embed, card.dataset.embedTitle));
  });

  // Add right-click handler to website cards (desktop) and long-press (mobile)
  const longPressTimer = new Map(); // card element -> timer id
  const longPressFired = new Map(); // card element -> boolean
  const longPressDelay = 500; // ms

  els.websitesGrid.querySelectorAll(".website-card:not(.website-card-embed)").forEach((card) => {
    // Desktop: right-click
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showWebsiteContextMenu(e.clientX, e.clientY, Number(card.dataset.id));
    });

    // Mobile: long-press -> context menu; short tap -> normal navigation
    card.addEventListener("touchstart", (e) => {
      longPressFired.set(card, false);

      // Track if the user is scrolling
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startY = touch.clientY;

      const onMove = (moveEvent) => {
        const t = moveEvent.touches[0];
        const dx = Math.abs(t.clientX - startX);
        const dy = Math.abs(t.clientY - startY);
        if (dx > 10 || dy > 10) {
          // Cancel long press if user is scrolling
          const timer = longPressTimer.get(card);
          if (timer) {
            clearTimeout(timer);
            longPressTimer.delete(card);
          }
        }
      };

      document.addEventListener("touchmove", onMove, { passive: true });
      document.addEventListener("touchend", () => {
        document.removeEventListener("touchmove", onMove);
        const timer = longPressTimer.get(card);
        if (timer) {
          clearTimeout(timer);
          longPressTimer.delete(card);
        }
      }, { passive: true });

      const timer = setTimeout(() => {
        if (!longPressFired.get(card)) {
          longPressFired.set(card, true);
          const t = e.touches[0];
          const rect = card.getBoundingClientRect();
          showWebsiteContextMenu(t.clientX, t.clientY, Number(card.dataset.id));
          // Vibrate if available
          if (navigator.vibrate) navigator.vibrate(30);
        }
      }, longPressDelay);
      longPressTimer.set(card, timer);
    }, { passive: true });

    // Prevent navigation when long-press just showed the context menu
    card.addEventListener("click", (e) => {
      if (longPressFired.get(card)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true); // capture phase so it fires before the anchor navigates

    // Clear timers when card is removed
    card.addEventListener("DOMNodeRemoved", () => {
      const timer = longPressTimer.get(card);
      if (timer) {
        clearTimeout(timer);
        longPressTimer.delete(card);
      }
      longPressFired.delete(card);
    });
  });
}


// The in-page iframe overlay for embedded sites. One overlay, reused: set the
// src on open, clear it on close so the framed page (and its polling, its audio)
// stops when the overlay is hidden rather than running unseen.
function openEmbedOverlay(src, title) {
  const overlay = els.embedOverlay || $("#embedOverlay");
  if (!overlay) return;
  const frame = overlay.querySelector(".embed-overlay-frame");
  const label = overlay.querySelector(".embed-overlay-title");
  const openBtn = overlay.querySelector(".embed-overlay-open");
  if (label) label.textContent = title || "Embedded site";
  if (openBtn) openBtn.href = src;
  if (frame) frame.src = src;
  overlay.hidden = false;
  document.body.classList.add("embed-overlay-active");
}

function closeEmbedOverlay() {
  const overlay = els.embedOverlay || $("#embedOverlay");
  if (!overlay) return;
  const frame = overlay.querySelector(".embed-overlay-frame");
  if (frame) frame.src = "about:blank";
  overlay.hidden = true;
  document.body.classList.remove("embed-overlay-active");
}

function showWebsiteContextMenu(x, y, id) {
  state.websiteContext = { id, x, y };
  const w = state.websites.find((we) => we.id === id);
  const menu = els.websiteContextMenu;
  // Disable External URL button if no external URL exists
  els.ctxExternal?.classList.toggle("ctx-disabled", !w || !w.external_url || w.external_url.trim() === "");
  // Only rows llm3 reverse-proxies (see EMBED_PROXIES in server.js) can open inside it.
  els.ctxEmbed?.classList.toggle("hidden", !w?.embedPath);
  // Set control button text: Start if offline, Restart if online
  if (w) {
    els.ctxControlText.textContent = w.online ? "Restart" : "Start";
  }
  menu.classList.remove("hidden");
  // Clamp with the menu's real size: it has grown past the fixed 140 px, and a
  // card near the bottom pushed its lower items off the screen.
  const menuWidth = menu.offsetWidth || 180;
  const menuHeight = menu.offsetHeight || 140;
  menu.style.left = Math.max(0, Math.min(x, window.innerWidth - menuWidth)) + "px";
  menu.style.top = Math.max(0, Math.min(y, window.innerHeight - menuHeight)) + "px";
}

function hideWebsiteContextMenu() {
  els.websiteContextMenu?.classList.add("hidden");
}

function renameWebsite(id) {
  const w = state.websites.find((we) => we.id === id);
  if (!w) return;
  const newName = prompt("Rename:", w.name);
  if (newName && newName.trim()) {
    fetchJson("/api/websites/update", { id, name: newName.trim(), internal_url: w.internal_url, external_url: w.external_url, category: w.category });
  }
  hideWebsiteContextMenu();
}

// This machine's LAN address. 127.0.0.1 is only meaningful on the host
// itself, so any loopback URL is rewritten before being opened -- otherwise
// the link is useless from a phone or another machine.
// Seeded with loopback so the first render is sane, then
// replaced by runtime.lanIp from /api/overview. The server detects it from the
// live interface list, so moving llm3 to another machine no longer needs an
// edit here.
let LAN_IP = "127.0.0.1";

// Rewrite a loopback URL to the LAN address. Previously this was gated on a
// hardcoded list of known ports, which silently broke every newly added
// service (Immich on 4991 among them). Remote hosts are left untouched.
// The host a loopback URL belongs to. A row that declares machine_ip is served
// somewhere else -- the Nginx rows store the reverse proxy's own loopback
// address -- so rewriting those to this Mac would produce a dead link. Only a
// row with no machine_ip is ours.
function lanHostFor(website) {
  return String(website?.machine_ip || "").trim() || LAN_IP;
}

function toLanUrl(rawUrl, website) {
  const url = String(rawUrl || "");
  if (!url) return url;
  return url.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/, `//${lanHostFor(website)}`);
}

function openInternalUrl(id) {
  const w = state.websites.find((we) => we.id === id);
  if (!w) return;
  window.open(toLanUrl(w.internal_url, w), "_blank");
  hideWebsiteContextMenu();
}

function openExternalUrl(id) {
  const w = state.websites.find((we) => we.id === id);
  if (!w) return;
  if (w.external_url && w.external_url !== "") {
    window.open(w.external_url, "_blank");
  } else {
    window.open(toLanUrl(w.internal_url, w), "_blank");
  }
  hideWebsiteContextMenu();
}

async function deleteWebsite(id) {
  if (!confirm("Delete this website?")) return;
  await fetchJson("/api/websites/delete", { id });
  fetchWebsites();
  hideWebsiteContextMenu();
}

// Control (start/stop/restart) a PM2-managed website
async function controlWebsite(id, action) {
  const w = state.websites.find((we) => we.id === id);
  if (!w) return;
  if (!action) {
    action = w.online ? "restart" : "start";
  }
  els.ctxControl?.classList.add("ctx-disabled");
  els.ctxControlText.textContent = "Processing...";
  try {
    // Use raw fetch so we can check res.ok (fetchJson throws on non-2xx)
    const resp = await fetch("/api/websites/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      fetchWebsites();
      const msg = action === "restart" ? `Restarted ${w.name}` : action === "stop" ? `Stopped ${w.name}` : `Started ${w.name}`;
      // Include pm2 app name if present for clarity
      const detail = data.pm2App ? ` (${data.pm2App})` : "";
      showToast(msg + detail, 3000);
    } else {
      // Build a detailed error message
      let errMsg = data.error || "Control failed";
      // If it's a port-missing error, suggest the fix
      if (errMsg.includes("No PM2 app mapped")) {
        const hostMatch = w.internal_url.match(/^(https?:\/\/)?([^:\/]+)/);
        const host = hostMatch ? hostMatch[2] : "unknown host";
        const portMatch = w.internal_url.match(/:([0-9]+)$/);
        const port = portMatch ? portMatch[1] : "unknown port";
        errMsg += ` — port ${port} on ${host} has no PM2 app. To control this service, ensure it runs under PM2 with a PORT env var set.`;
        // If it's a remote host, suggest SSH
        if (host !== "127.0.0.1" && host !== "localhost") {
          errMsg += ` (remote host — PM2 control runs on local machine only).`;
        }
      }
      // Include pm2 stderr output if available
      if (data.stderr) {
        errMsg += `\nPM2: ${data.stderr.split('\n')[0]}`;
      }
      showToast(errMsg, 5000);
    }
  } catch (e) {
    showToast("Control request failed: " + (e.message || e), 4000);
  } finally {
    fetchWebsites();
    hideWebsiteContextMenu();
  }
}

// Add Website modal
function openAddWebsiteModal() {
  hideWebsiteContextMenu();
  els.addWebsiteName.value = "";
  els.addWebsiteInternal.value = "";
  els.addWebsiteExternal.value = "";
  els.addWebsiteCategory.value = "Local";
  els.addWebsiteModal.classList.remove("hidden");
}

function closeAddWebsiteModal() {
  els.addWebsiteModal.classList.add("hidden");
}

async function submitAddWebsite() {
  const name = els.addWebsiteName.value.trim();
  const internal = els.addWebsiteInternal.value.trim();
  const external = els.addWebsiteExternal.value.trim();
  const category = els.addWebsiteCategory.value;
  if (!name || !internal) {
    els.addWebsiteName.style.borderColor = !name ? "#ef4444" : "";
    els.addWebsiteInternal.style.borderColor = !internal ? "#ef4444" : "";
    return;
  }
  els.addWebsiteSubmit.disabled = true;
  els.addWebsiteSubmit.textContent = "Adding...";
  try {
    await fetchJson("/api/websites/add", { name, internal_url: internal, external_url: external || "", category });
    closeAddWebsiteModal();
    fetchWebsites();
  } catch (e) {
    console.warn("Failed to add website:", e);
    alert("Failed to add website: " + (e.message || e));
  } finally {
    els.addWebsiteSubmit.disabled = false;
    els.addWebsiteSubmit.textContent = "Add";
  }
}

// Scan Nginx websites
// Website settings modal
function openWebsiteSettings(id) {
  const w = state.websites.find((we) => we.id === id);
  if (!w) return;
  
  state.websiteSettingsId = id;
  
  // Extract port from internal_url
  let port = "";
  try {
    const url = new URL(w.internal_url);
    port = url.port;
  } catch (e) {}
  
  els.websiteSettingsPort.value = port;
  els.websiteSettingsModalTitle.textContent = w.name;
  els.websiteSettingsModal.classList.remove("hidden");
  hideWebsiteContextMenu();
}

function closeWebsiteSettingsModal() {
  els.websiteSettingsModal.classList.add("hidden");
  state.websiteSettingsId = null;
}

// Update port
async function updateWebsitePort(id) {
  const w = state.websites.find((we) => we.id === id);
  if (!w) return;
  
  const newPort = els.websiteSettingsPort.value.trim();
  if (!newPort) {
    showToast("Port is required", 2000);
    return;
  }
  
  try {
    const res = await fetchJson("/api/websites/update-port", { id, newPort });
    if (res.ok) {
      fetchWebsites();
      closeWebsiteSettingsModal();
      showToast(`Port updated to ${newPort}`, 2000);
    } else {
      showToast(res.error || "Port update failed", 3000);
    }
  } catch (e) {
    showToast("Port update error: " + (e.message || e), 3000);
  }
}

function formatPm2Bytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "n/a";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const rounded = amount >= 10 || index === 0 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded}${units[index]}`;
}

function getWebsitePm2StatusLabel(website) {
  const status = String(website?.pm2?.status || "").trim().toLowerCase();
  if (!website?.pm2?.name) return "Unmanaged";
  if (status === "online") return website.online ? "Online" : "Port down";
  if (status === "stopped") return "Stopped";
  if (status) return status[0].toUpperCase() + status.slice(1);
  return "Unknown";
}

function getWebsitePm2StatusClass(website) {
  const status = String(website?.pm2?.status || "").trim().toLowerCase();
  if (!website?.pm2?.name) return "neutral";
  if (status === "online" && website.online) return "online";
  if (status === "online" && !website.online) return "warning";
  if (status === "stopped") return "offline";
  return "neutral";
}

function renderWebsitePm2Status(website) {
  const pm2 = website?.pm2 || null;
  if (!pm2?.name) {
    return `<div class="pm2-status-stack"><span class="pm2-status-badge neutral">Unmanaged</span><span class="pm2-health-text">No PM2 mapping</span></div>`;
  }
  const health = website.online ? "Port reachable" : "Port unreachable";
  const scope = pm2.remote ? "Remote host" : "Local host";
  return `
    <div class="pm2-status-stack">
      <span class="pm2-status-badge ${getWebsitePm2StatusClass(website)}">${esc(getWebsitePm2StatusLabel(website))}</span>
      <span class="pm2-health-text">${esc(`${health} · ${scope}`)}</span>
    </div>
  `;
}

async function updateWebsitePm2Memory(id) {
  const input = document.getElementById(`websitePm2Limit-${id}`);
  const rawValue = String(input?.value || "").trim();
  if (!rawValue) {
    showToast("Memory cap is required", 2500);
    return;
  }
  try {
    if (input) {
      input.disabled = true;
    }
    const result = await fetchJson("/api/websites/pm2-memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, value: rawValue }),
    });
    showToast(`Updated PM2 cap to ${result.website?.pm2?.maxMemoryRestartLabel || rawValue}`, 2500);
    await fetchWebsites();
  } catch (error) {
    showToast(error.message || "Unable to update PM2 memory cap", 4000);
  } finally {
    if (input) {
      input.disabled = false;
    }
  }
}

function renderPm2Categories() {
  if (!els.pm2Categories) return;
  const websites = state.websites || [];
  const categories = [...new Set(websites.map((w) => w.category))];
  const allCount = websites.length;
  const activeCat = state.pm2Category || "All";
  els.pm2Categories.innerHTML =
    `<button class="category-chip ${activeCat === "All" ? "active" : ""}" data-pm2-category="All">All <span class="cat-count">${allCount}</span></button>` +
    categories.map((cat) => {
      const count = websites.filter((w) => w.category === cat).length;
      return `<button class="category-chip ${cat === activeCat ? "active" : ""}" data-pm2-category="${cat}">${cat} <span class="cat-count">${count}</span></button>`;
    }).join("");
  els.pm2Categories.querySelectorAll("[data-pm2-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.pm2Category = button.dataset.pm2Category || "All";
      renderPm2Table();
    });
  });
}

function renderPm2Table() {
  if (!els.pm2Table) return;

  renderPm2Categories();

  const websites = state.websites || [];
  const activeCat = state.pm2Category || "All";
  const filtered = activeCat === "All" ? websites : websites.filter((w) => w.category === activeCat);

  els.pm2Table.innerHTML = `
    <div class="table-shell">
      <div class="table-scroll">
        <table class="data-table applications-table pm2-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>PM2 App</th>
              <th>Status</th>
              <th>Memory Cap</th>
              <th>Path</th>
              <th>URL</th>
              <th>Category</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map((w) => {
              const url = w.internal_url || "#";
              const pm2 = w.pm2 || null;
              const openUrl = w.external_url || url;
              const canEditCap = Boolean(pm2?.name && !pm2?.remote);
              const canControl = Boolean(pm2?.name);
              const capValue = pm2?.maxMemoryRestartLabel || "";
              const pathValue = pm2?.execPathDisplay || pm2?.cwdDisplay || "n/a";
              const memoryHint = pm2?.memoryBytes ? `Live RSS ${formatPm2Bytes(pm2.memoryBytes)}` : (pm2?.remote ? "Remote PM2 app" : "No PM2 memory data");
              return `
                <tr>
                  <td class="application-name-cell">
                    <div class="table-name-stack">
                      <div class="table-name-row">
                        <a class="link" href="${safeHref(openUrl)}" target="_blank" rel="noreferrer">${esc(w.name)}</a>
                      </div>
                      <span class="status-text">${esc(w.external_url || w.internal_url || "")}</span>
                    </div>
                  </td>
                  <td>
                    <div class="table-name-stack">
                      <span class="mono">${esc(pm2?.name || "n/a")}</span>
                      <span class="status-text">${pm2?.pid ? `PID ${esc(String(pm2.pid))}` : pm2?.remote ? "remote" : "not mapped"}</span>
                    </div>
                  </td>
                  <td>${renderWebsitePm2Status(w)}</td>
                  <td>
                    ${pm2?.name ? `
                      <div class="pm2-limit-editor">
                        <input id="websitePm2Limit-${w.id}" class="pm2-limit-input" type="text" value="${esc(capValue)}" placeholder="500M or 15G" ${canEditCap ? "" : "disabled"} />
                        <button class="btn btn-secondary btn-sm" type="button" data-website-action="pm2-memory" data-id="${w.id}" ${canEditCap ? "" : "disabled"}>Save</button>
                      </div>
                      <div class="pm2-inline-meta">${esc(memoryHint)}</div>
                    ` : `<span class="status-text">n/a</span>`}
                  </td>
                  <td><span class="mono">${esc(pathValue)}</span></td>
                  <td>
                    <div class="table-name-stack">
                      <a class="link mono" href="${safeHref(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>
                      ${w.external_url ? `<a class="link" href="${safeHref(w.external_url)}" target="_blank" rel="noreferrer">External</a>` : `<span class="status-text">Internal only</span>`}
                    </div>
                  </td>
                  <td>${esc(w.category || "General")}</td>
                  <td>
                    <div class="pm2-action-row">
                      <button class="btn btn-secondary btn-sm" type="button" data-website-action="control" data-control="start" data-id="${w.id}" ${canControl ? "" : "disabled"}>Start</button>
                      <button class="btn btn-secondary btn-sm" type="button" data-website-action="control" data-control="stop" data-id="${w.id}" ${canControl ? "" : "disabled"}>Stop</button>
                      <button class="btn btn-secondary btn-sm" type="button" data-website-action="control" data-control="restart" data-id="${w.id}" ${canControl ? "" : "disabled"}>Restart</button>
                      <button class="btn btn-secondary btn-sm" type="button" data-website-action="settings" data-id="${w.id}">Settings</button>
                    </div>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// Render Websites table view
function renderWebsitesTable() {
  if (!els.websitesTable) return;

  const websites = filterWebsitesBySearch(state.websites || []);
  const activeCat = state._websiteActiveCategory || "All";
  const filtered = activeCat === "All" ? websites : websites.filter((w) => w.category === activeCat);

  if (!filtered.length) {
    els.websitesTable.innerHTML = `<p class="websites-empty">${
      state.websiteSearch ? "No website matches this search." : "No website in this category."
    }</p>`;
    return;
  }

  els.websitesTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>URL</th>
          <th>Category</th>
          <th>Status</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${filtered.map((w) => {
          // Same rewrite the card view uses: a loopback address is useless to
          // anyone reading this table from another machine, so show and link
          // the LAN address instead.
          const url = w.internal_url ? toLanUrl(w.internal_url, w) : "#";
          const statusDot = w.online
            ? '<span style="color: #22c55e;">● Online</span>'
            : '<span style="color: #ef4444;">● Offline</span>';

          return `
            <tr>
              <td><a href="${safeHref(w.external_url || url)}" target="_blank" rel="noreferrer">${esc(w.name)}</a></td>
              <td><a href="${safeHref(url)}" target="_blank" rel="noreferrer">${esc(url)}</a></td>
              <td>${esc(w.category)}</td>
              <td>${statusDot}</td>
              <td class="table-actions">
                <button class="btn-icon" title="Settings" data-website-action="settings" data-id="${w.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                </button>
                <button class="btn-icon ${w.online ? '' : 'ctx-danger'}" title="${w.online ? 'Stop' : 'Start'}" data-website-action="control" data-control="${w.online ? 'stop' : 'start'}" data-id="${w.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${w.online
                    ? '<rect x="6" y="6" width="12" height="12"/>'
                    : '<polygon points="5 3 19 12 5 21 5 3"/>'}</svg>
                </button>
                <button class="btn-icon" title="Start" data-website-action="control" data-control="start" data-id="${w.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button class="btn-icon" title="Rename" data-website-action="rename" data-id="${w.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                </button>
                <button class="btn-icon ctx-danger" title="Delete" data-website-action="delete" data-id="${w.id}">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
              </td>
            </tr>
          `;
        }).join("")}
      </tbody>
    </table>
  `;
}

// Context menu handlers (added in wireEvents)

function captureUiState() {
  return {
    scrollPositions: captureScrollPositions(),
    focusedElement: captureFocusedElement(),
  };
}

function captureScrollPositions() {
  return PRESERVED_SCROLL_SELECTORS.reduce((positions, selector) => {
    const element = document.querySelector(selector);
    if (!element) {
      return positions;
    }
    positions.push({
      selector,
      top: element.scrollTop,
      left: element.scrollLeft,
    });
    return positions;
  }, []);
}

function restoreUiState(snapshot) {
  restoreScrollPositions(snapshot?.scrollPositions || []);
  restoreFocusedElement(snapshot?.focusedElement || null);
}

function restoreScrollPositions(positions) {
  positions.forEach(({ selector, top, left }) => {
    const element = document.querySelector(selector);
    if (!element) {
      return;
    }
    element.scrollTop = top;
    element.scrollLeft = left;
  });
}

function captureFocusedElement() {
  const element = document.activeElement;
  if (!element || element === document.body) {
    return null;
  }
  const selector = getFocusRestoreSelector(element);
  if (!selector) {
    return null;
  }
  const snapshot = { selector };
  if (typeof element.selectionStart === "number" && typeof element.selectionEnd === "number") {
    snapshot.selectionStart = element.selectionStart;
    snapshot.selectionEnd = element.selectionEnd;
  }
  return snapshot;
}

function restoreFocusedElement(snapshot) {
  if (!snapshot?.selector) {
    return;
  }
  const element = document.querySelector(snapshot.selector);
  if (!element || element.disabled || typeof element.focus !== "function") {
    return;
  }
  element.focus({ preventScroll: true });
  if (
    typeof snapshot.selectionStart === "number"
    && typeof snapshot.selectionEnd === "number"
    && typeof element.setSelectionRange === "function"
  ) {
    const valueLength = typeof element.value === "string" ? element.value.length : snapshot.selectionEnd;
    element.setSelectionRange(
      Math.min(snapshot.selectionStart, valueLength),
      Math.min(snapshot.selectionEnd, valueLength)
    );
  }
}

function getFocusRestoreSelector(element) {
  if (element.id) {
    return `#${selectorEscape(element.id)}`;
  }
  if (element.dataset.modalInput) {
    return `[data-modal-input="${selectorEscape(element.dataset.modalInput)}"]`;
  }
  if (element.dataset.profileInput) {
    return `[data-profile-input="${selectorEscape(element.dataset.profileInput)}"]`;
  }
  if (element.dataset.profileSlotInput && element.dataset.slotId) {
    return `[data-profile-slot-input="${selectorEscape(element.dataset.profileSlotInput)}"][data-slot-id="${selectorEscape(element.dataset.slotId)}"]`;
  }
  if (element.dataset.voicePanelInput && element.dataset.field) {
    return `[data-voice-panel-input="${selectorEscape(element.dataset.voicePanelInput)}"][data-field="${selectorEscape(element.dataset.field)}"]`;
  }
  if (element.dataset.applicationSelect) {
    return `[data-application-select="${selectorEscape(element.dataset.applicationSelect)}"]`;
  }
  if (element.dataset.slotStripSelect && element.dataset.slotId) {
    return `[data-slot-strip-select="${selectorEscape(element.dataset.slotStripSelect)}"][data-slot-id="${selectorEscape(element.dataset.slotId)}"]`;
  }
  if (element.dataset.slotRenameInput) {
    return `[data-slot-rename-input="${selectorEscape(element.dataset.slotRenameInput)}"]`;
  }
  if (element.dataset.saveLayoutName != null) {
    return "[data-save-layout-name]";
  }
  if (element.dataset.modalSlotName != null) {
    return "[data-modal-slot-name]";
  }
  return null;
}

function hasActiveModelsInteraction() {
  if (state.activeSection !== "models" || state.modelsPane !== "models" || state.modal.open || state.profileModal.open) {
    return false;
  }
  const activeElement = document.activeElement;
  if (!activeElement || activeElement === document.body || !els.modelsSection?.contains(activeElement)) {
    return false;
  }
  return Boolean(
    activeElement.closest?.("[data-slot-strip-select], [data-slot-rename-input], #modelSearchInput")
    || activeElement.matches?.("select, input, textarea")
  );
}

function selectorEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(String(value));
  }
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function renderFilters() {
  const effectiveModelView = getEffectiveModelView();
  renderModelsSurfaceTabs();
  if (els.modelFilterBar) {
    els.modelFilterBar.classList.toggle("hidden", state.modelsPane !== "models");
  }
  if (els.modelsSlotStrip) {
    els.modelsSlotStrip.classList.toggle("hidden", state.modelsPane !== "models");
  }
  if (state.modelsPane !== "models") {
    if (els.modelsSlotStrip) {
      els.modelsSlotStrip.innerHTML = "";
    }
    if (els.filterChips) {
      els.filterChips.innerHTML = "";
    }
    if (els.modelViewToggles) {
      els.modelViewToggles.innerHTML = "";
    }
    return;
  }
  renderModelsSlotStrip();
  const models = state.models;
  const chips = [
    { key: "all", label: "All", count: models.length },
    { key: "gguf", label: "GGUF", count: models.filter((model) => model.runtime === "gguf").length },
    { key: "mlx", label: "MLX", count: models.filter((model) => model.runtime === "mlx").length },
    { key: "dflash", label: "DFlash", count: models.filter((model) => model.runtime === "dflash").length },
  ];

  [...new Set(models.map((model) => model.family).filter(Boolean))].forEach((family) => {
    chips.push({
      key: `family:${family}`,
      label: family,
      count: models.filter((model) => model.family === family).length,
    });
  });

  els.filterChips.innerHTML = chips
    .filter((chip) => chip.count > 0)
    .map((chip) => (
      `<button class="filter-chip${chip.key === state.activeFilter ? " active" : ""}" data-filter="${chip.key}">` +
      `${esc(chip.label)}<span class="count">${chip.count}</span></button>`
    ))
    .join("");

  if (els.modelSearchInput && document.activeElement !== els.modelSearchInput) {
    els.modelSearchInput.value = state.modelSearch;
  }

  if (els.modelViewToggles) {
    els.modelViewToggles.innerHTML = `
      <button class="btn btn-icon icon-toggle ${effectiveModelView === "table" ? "active" : ""}" type="button" data-model-view="table" title="Table view" aria-label="Table view">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M9 4v16"/></svg>
      </button>
      <button class="btn btn-icon icon-toggle ${effectiveModelView === "cards" ? "active" : ""}" type="button" data-model-view="cards" title="Card view" aria-label="Card view">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      </button>
    `;
  }
}

function sortModelChoices(models) {
  return [...(models || [])].sort((left, right) => {
    const labelDiff = String(left?.label || left?.key || "").localeCompare(String(right?.label || right?.key || ""));
    if (labelDiff) {
      return labelDiff;
    }
    const runtimeDiff = String(left?.runtime || "").localeCompare(String(right?.runtime || ""));
    if (runtimeDiff) {
      return runtimeDiff;
    }
    return modelSizeValue(left) - modelSizeValue(right);
  });
}

function sortVoiceModels(models) {
  return [...(models || [])].sort((left, right) => {
    const labelDiff = String(left?.label || left?.key || "").localeCompare(String(right?.label || right?.key || ""));
    if (labelDiff) {
      return labelDiff;
    }
    return modelSizeValue(left) - modelSizeValue(right);
  });
}

function buildModelsSlotStripTitle(slot, kind = "llm") {
  if (kind === "voice") {
    return String(slot?.type || "").toUpperCase() || "Voice";
  }
  const customName = String(slot?.name || "").trim();
  if (customName) {
    return customName;
  }
  const numericIndex = Number(slot?.index);
  if (Number.isFinite(numericIndex) && numericIndex > 0) {
    return `Slot${numericIndex}`;
  }
  const fallback = String(slot?.id || "").match(/\d+/)?.[0];
  return fallback ? `Slot${fallback}` : String(slot?.shortLabel || slot?.label || "Slot");
}

function buildModelsSlotStripItems() {
  const llmItems = state.slots.map((slot) => ({
    kind: "llm",
    typeClass: "llm",
    slot,
    title: buildModelsSlotStripTitle(slot, "llm"),
    models: sortModelChoices(state.models),
  }));
  const voiceItems = ["tts", "stt"].map((type) => {
    const slot = getVoiceSlots().find((entry) => entry.type === type);
    if (!slot) {
      return null;
    }
    return {
      kind: "voice",
      typeClass: type,
      slot,
      title: buildModelsSlotStripTitle(slot, "voice"),
      models: sortVoiceModels(getVoiceModels().filter((model) => model.type === type)),
    };
  }).filter(Boolean);
  return [...llmItems, ...voiceItems];
}

function renderModelsSlotStrip() {
  if (!els.modelsSlotStrip) {
    return;
  }
  // The strip is rebuilt with innerHTML, which destroys the rename field and
  // fires its focusout -- committing the rename the moment the 2.5s poll lands.
  // Leave the DOM alone while the user is typing in it.
  if (isSlotRenameInputFocused()) {
    return;
  }
  const items = buildModelsSlotStripItems();
  if (!items.length) {
    els.modelsSlotStrip.innerHTML = "";
    return;
  }
  els.modelsSlotStrip.innerHTML = `
    <div class="models-slot-strip-grid">
      ${items.map((item) => renderModelsSlotStripCard(item)).join("")}
    </div>
  `;
}

function renderModelsSlotStripCard(item) {
  const slot = item.slot || null;
  const status = slot?.status || {};
  const running = Boolean(status.running);
  const model = status.model || {};
  const memoryInfo = getModelsSlotMemoryInfo(item);
  const currentLabel = running
    ? String(model.label || model.key || "Runtime live")
    : "Idle";
  const selectPlaceholder = `Select ${item.title} model…`;
  const selectedModelKey = running
    ? String(model.key || "")
    : "";
  return `
    <article class="models-slot-card ${esc(item.typeClass || item.kind)} ${running ? "running" : "idle"}" data-slot-id="${esc(slot?.id || "")}">
      <div class="models-slot-heading">
        <div class="models-slot-title-row">
          ${renderModelsSlotTitleCell(item)}
          ${memoryInfo.text ? `<div class="models-slot-memory${memoryInfo.estimated ? " estimated" : ""}" title="${esc(memoryInfo.title)}">${esc(memoryInfo.text)}</div>` : ""}
          <div class="models-slot-tps is-empty" data-slot-tps></div>
        </div>
      </div>
      <div
        class="models-slot-tooltip-anchor models-slot-status-anchor${running ? " has-tooltip" : ""}"
        ${running ? `tabindex="0" aria-label="Applications using ${esc(slot.label || item.title)}"` : `aria-label="${esc(item.title)} offline"`}
      >
        <span class="models-slot-status-dot ${running ? "running" : "idle"}"></span>
        <span class="models-slot-working-indicator" aria-hidden="true"></span>
        ${running ? renderModelsSlotApplicationsTooltip(item) : ""}
      </div>
      <div
        class="models-slot-tooltip-anchor models-slot-current-anchor${running ? " has-tooltip" : ""}"
        ${running ? `tabindex="0" aria-label="${esc(slot.label || item.title)} runtime details"` : ""}
      >
        <span
          class="models-slot-current-label ${running ? "running" : "idle"}${item.kind === "llm" ? " log-jump" : ""}"
          ${item.kind === "llm" ? `data-slot-log-jump="${esc(slot?.id || "")}"` : ""}
          title="${esc(item.kind === "llm" ? `${currentLabel}\nDouble-click to open the ${item.title} logs` : currentLabel)}"
        >${esc(currentLabel)}</span>
        <span class="models-slot-activity is-empty" data-slot-activity>&nbsp;</span>
        ${running ? renderModelsSlotRuntimeTooltip(item) : ""}
      </div>
      <button
        class="btn btn-icon icon-action btn-danger models-slot-stop"
        type="button"
        data-slot-strip-stop="${item.kind}"
        data-slot-id="${esc(slot?.id || "")}"
        ${running && !state.actionInFlight ? "" : "disabled"}
        title="${running ? `Stop ${slot?.label || item.title}` : `${item.title} is offline`}"
        aria-label="${running ? `Stop ${slot?.label || item.title}` : `${item.title} is offline`}"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
      </button>
      <div class="models-slot-select-wrap application-picker">
        <label class="field-label">
          <span class="sr-only">${esc(selectPlaceholder)}</span>
          <select
            class="models-slot-select"
            data-slot-strip-select="${item.kind}"
            data-slot-id="${esc(slot?.id || "")}"
            ${item.models.length && !state.actionInFlight ? "" : "disabled"}
          >
            <option value="">${esc(item.models.length ? selectPlaceholder : "No models available")}</option>
            ${item.models.map((modelOption) => renderModelsSlotOption(item, modelOption, selectedModelKey)).join("")}
          </select>
        </label>
      </div>
    </article>
  `;
}

// The title doubles as the rename field. Voice slots keep a plain label: their
// names come from the runtime type, not from the user.
function renderModelsSlotTitleCell(item) {
  const slotId = String(item.slot?.id || "");
  if (item.kind !== "llm") {
    return `<div class="models-slot-title">${esc(item.title)}</div>`;
  }
  if (state.slotRename.slotId === slotId) {
    return `
      <input
        class="models-slot-title-input"
        type="text"
        maxlength="40"
        value="${esc(state.slotRename.value)}"
        data-slot-rename-input="${esc(slotId)}"
        placeholder="${esc(item.slot?.defaultName || "Slot name")}"
        aria-label="Rename ${esc(item.title)}"
      />`;
  }
  return `
    <div
      class="models-slot-title renameable"
      data-slot-rename="${esc(slotId)}"
      title="${esc(`${item.title}\nPress and hold to rename`)}"
    >${esc(item.title)}</div>`;
}

const SLOT_RENAME_HOLD_MS = 550;
const slotRenameLongPress = { timer: null, x: 0, y: 0 };

function startSlotRenameLongPress(slotId, event) {
  cancelSlotRenameLongPress();
  const target = String(slotId || "");
  if (!target) {
    return;
  }
  slotRenameLongPress.x = event.clientX;
  slotRenameLongPress.y = event.clientY;
  slotRenameLongPress.timer = window.setTimeout(() => {
    slotRenameLongPress.timer = null;
    beginSlotRename(target);
  }, SLOT_RENAME_HOLD_MS);
}

function cancelSlotRenameLongPress() {
  if (slotRenameLongPress.timer) {
    window.clearTimeout(slotRenameLongPress.timer);
    slotRenameLongPress.timer = null;
  }
}

function isSlotRenameInputFocused() {
  if (!state.slotRename.slotId) {
    return false;
  }
  const active = document.activeElement;
  return Boolean(active?.dataset?.slotRenameInput === state.slotRename.slotId);
}

function beginSlotRename(slotId) {
  const slot = getSlot(slotId);
  if (!slot) {
    return;
  }
  state.slotRename = { slotId: slot.id, value: String(slot.name || "").trim() };
  pauseRefreshForEditing();
  renderModelsSlotStrip();
  const input = els.modelsSlotStrip?.querySelector(`[data-slot-rename-input="${selectorEscape(slot.id)}"]`);
  input?.focus();
  input?.select();
}

function cancelSlotRename() {
  if (!state.slotRename.slotId) {
    return;
  }
  state.slotRename = { slotId: "", value: "" };
  renderModelsSlotStrip();
}

async function commitSlotRename() {
  const slotId = String(state.slotRename.slotId || "");
  if (!slotId) {
    return;
  }
  const name = String(state.slotRename.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const slot = getSlot(slotId);
  state.slotRename = { slotId: "", value: "" };
  if (name === String(slot?.name || "").trim()) {
    renderModelsSlotStrip();
    return;
  }
  // The scope is decided by the server: the applied profile when there is one,
  // the global map when there is not.
  await runAction("/api/slots/name", { slotId, name }, { preserveModal: false });
}

function renderModelsSlotOption(item, model, selectedModelKey = "") {
  const runtimePart = item.kind === "llm" ? ` · ${runtimeLabel(model.runtime)}` : "";
  const selected = String(model.key || "") === String(selectedModelKey || "") ? " selected" : "";
  return `<option value="${esc(model.key)}"${selected}>${esc(model.label)}${esc(runtimePart)} · ${esc(model.sizeLabel || "n/a")}</option>`;
}

function renderModelsSlotApplicationsTooltip(item) {
  const slot = item.slot || {};
  const badges = item.kind === "voice" ? renderVoiceIntegrationBadges(slot) : renderIntegrationBadges(slot);
  return `
    <div class="models-slot-tooltip">
      <div class="models-slot-tooltip-title">${esc(slot.label || item.title)} usage</div>
      ${badges
        ? `<div class="integration-badges models-slot-tooltip-badges">${badges}</div>`
        : `<p class="models-slot-tooltip-copy">No applications are currently routed here.</p>`}
    </div>
  `;
}

function renderModelsSlotRuntimeTooltip(item) {
  const slot = item.slot || {};
  const model = slot.status?.model || {};
  const details = buildModelsSlotRuntimeDetails(item);
  return `
    <div class="models-slot-tooltip models-slot-tooltip-runtime">
      <div class="models-slot-tooltip-title">${esc(model.label || model.key || slot.label || item.title)}</div>
      <div class="models-slot-tooltip-grid">
        ${details.map(({ label, value }) => `
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
        `).join("")}
      </div>
    </div>
  `;
}

// The reasoning-effort row only applies to a launcher that has the knob (mlx-dspark),
// so key it on the field being present in the state file rather than on a launcher
// name. A slot started before the field existed simply omits the row.
function reasoningEffortDetailRows(params) {
  if (!params || !Object.prototype.hasOwnProperty.call(params, "reasoningEffort")) {
    return [];
  }
  const raw = String(params.reasoningEffort ?? "").trim().toLowerCase();
  return [{
    label: "Reasoning effort",
    value: DSPARK_REASONING_LABELS[raw] || raw || "n/a",
  }];
}

function buildModelsSlotRuntimeDetails(item) {
  const params = item.slot?.status?.params || {};
  if (item.kind === "voice") {
    return [
      { label: "Format", value: String(params.audioFormat || "pcm16") },
      { label: "Rate", value: `${NumberFmt(params.sampleRate || (item.slot?.type === "tts" ? 24000 : 16000))} Hz` },
      { label: item.slot?.type === "tts" ? "Voice" : "Language", value: String(item.slot?.type === "tts" ? (params.voiceName || "n/a") : (params.language || "auto")) },
      { label: "Status", value: "running" },
    ];
  }
  const requestedCtxSize = Number(params.requestedCtxSize || 0);
  const ctxClamped = Boolean(params.ctxClamped) && requestedCtxSize > Number(params.ctxSize || 0);
  const contextRows = ctxClamped
    ? [
        { label: "Applied", value: fmtCount(params.ctxSize) || "n/a" },
        { label: "Requested", value: fmtCount(requestedCtxSize) || "n/a" },
      ]
    : [{ label: "Context", value: fmtCount(params.ctxSize) || "n/a" }];
  return [
    ...contextRows,
    { label: "Parallel", value: String(NumberFmt(params.parallel) || "n/a") },
    { label: "Thinking", value: params.thinking ? "on" : "off" },
    ...reasoningEffortDetailRows(params),
    { label: "Temperature", value: Number.isFinite(Number(params.temperature)) ? String(params.temperature) : "n/a" },
    { label: "Top P", value: Number.isFinite(Number(params.topP)) ? String(params.topP) : "n/a" },
    { label: "Top K", value: Number.isFinite(Number(params.topK)) ? String(params.topK) : "n/a" },
    { label: "Min P", value: Number.isFinite(Number(params.minP)) ? String(params.minP) : "n/a" },
    { label: "Presence", value: Number.isFinite(Number(params.presencePenalty)) ? String(params.presencePenalty) : "n/a" },
    { label: "Repetition", value: Number.isFinite(Number(params.repetitionPenalty)) ? String(params.repetitionPenalty) : "n/a" },
    { label: "Tiny Grammar", value: params.enableTinyGrammar ? "on" : "off" },
    { label: "Structured GBNF", value: params.enableStructuredGbnf ? "on" : "off" },
    { label: "Grammar Mode", value: grammarModeLabel(params) },
    ...(ctxClamped ? [{
      label: "Clamp",
      value: `launcher max ${fmtCount(params.maxSafeCtxSize) || "n/a"}`,
    }] : []),
  ];
}

function getModelsSlotMemoryInfo(item) {
  const slot = item.slot || {};
  const status = slot.status || {};
  if (!status.running) {
    return { text: "", title: "", estimated: false };
  }
  const totalMemoryBytes = Number(state.system?.memory?.totalBytes || 0);
  if (item.kind === "llm") {
    const process = state.system?.processes?.[slot.id]?.backend || null;
    const rssBytes = Number(process?.rssBytes || 0);
    const memPercent = Number(process?.memPercent || 0);
    if (rssBytes > 0) {
      const percentText = formatModelsSlotMemoryPercent(
        memPercent > 0
          ? memPercent
          : (totalMemoryBytes > 0 ? (rssBytes / totalMemoryBytes) * 100 : 0)
      );
      // Resident, not total. The GPU's Metal working set for this model is wired
      // by the kernel and belongs to no process, so it is absent here and present
      // in the RAM badge -- which is why a 25 GB model can sit here reading 3.9 GB.
      // Naming the figure and putting the model's own size beside it stops the
      // card from being read as the model's whole cost. The badge tooltip carries
      // the full decomposition.
      const onDiskBytes = modelSizeValue(status.model);
      const onDiskText = onDiskBytes > 0 ? ` · model ${fmtBytes(onDiskBytes)} on disk` : "";
      return {
        text: `${fmtBytes(rssBytes)} resident`,
        title: `${slot.label || item.title} backend resident memory · ${percentText} of ${fmtBytes(totalMemoryBytes)}`
          + `${onDiskBytes > 0 ? `\nModel on disk: ${fmtBytes(onDiskBytes)}` : ""}`
          + "\nThis model's GPU (Metal) buffers are wired by the kernel and are not"
          + " reported per process, so they are not in this figure. See the RAM badge"
          + " for the machine-wide decomposition.",
        detail: onDiskText,
        estimated: false,
      };
    }
  }
  const estimatedBytes = modelSizeValue(status.model);
  if (estimatedBytes > 0) {
    const percentText = formatModelsSlotMemoryPercent(totalMemoryBytes > 0 ? (estimatedBytes / totalMemoryBytes) * 100 : 0);
    return {
      text: `~${fmtBytes(estimatedBytes)}`,
      title: `${slot.label || item.title} estimated from model size · ${percentText} of ${fmtBytes(totalMemoryBytes)}`,
      estimated: true,
    };
  }
  return { text: "", title: "", estimated: false };
}

function formatModelsSlotMemoryPercent(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return "0%";
  }
  return `${numeric >= 10 ? Math.round(numeric) : numeric.toFixed(1)}%`;
}

// Polling rewrites this grid every few seconds, which wiped out any text the
// user had selected inside it -- you could not drag across a model path and copy
// it, because the selection vanished mid-drag. Two rules fix that without
// slowing the refresh: never write markup identical to what is already there,
// and never write at all while a selection is live inside the grid. The deferred
// write is flushed the moment the selection is released.
function selectionInside(container) {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed || !selection.rangeCount) {
    return false;
  }
  const node = selection.getRangeAt(0).commonAncestorContainer;
  const element = node.nodeType === 1 ? node : node.parentElement;
  return Boolean(element && container.contains(element));
}

function writeGrid(container, html) {
  if (!container) {
    return;
  }
  if (container.dataset.renderedHtml === html) {
    return;
  }
  if (selectionInside(container)) {
    container.dataset.pendingHtml = html;
    return;
  }
  delete container.dataset.pendingHtml;
  container.innerHTML = html;
  container.dataset.renderedHtml = html;
}

function flushPendingGrids() {
  document.querySelectorAll("[data-pending-html]").forEach((container) => {
    if (selectionInside(container)) {
      return;
    }
    const html = container.dataset.pendingHtml;
    delete container.dataset.pendingHtml;
    container.innerHTML = html;
    container.dataset.renderedHtml = html;
  });
}

document.addEventListener("selectionchange", flushPendingGrids);
document.addEventListener("mouseup", flushPendingGrids);

function renderModels() {
  const effectiveModelView = getEffectiveModelView();
  if (state.modelsPane === "profiles") {
    els.modelGrid.classList.remove("table-mode");
    els.modelGrid.classList.add("profiles-mode");
    writeGrid(els.modelGrid, renderProfilesGrid());
    return;
  }
  const filteredModels = getFilteredModels();
  const palette = buildPalette();
  els.modelGrid.classList.remove("profiles-mode");
  els.modelGrid.classList.toggle("table-mode", effectiveModelView === "table");
  if (!filteredModels.length) {
    writeGrid(els.modelGrid, `<div class="empty-state"><h3>No models found</h3><p>Models will appear here when the launcher scripts are available.</p></div>`);
    return;
  }

  if (effectiveModelView === "table") {
    writeGrid(els.modelGrid, renderModelTable(filteredModels, palette));
    return;
  }

  writeGrid(els.modelGrid, filteredModels.map((model) => {
    const runtime = model.runtime || "gguf";
    const style = paletteStyle(palette.get(model.key), runtime);
    const activeClass = isModelActive(model) ? " active-model" : "";
    const stopDisabled = isModelActive(model) && !state.actionInFlight ? "" : "disabled";
    return `
      <article class="model-card ${runtimeClass(runtime)}${activeClass}" style="${style}">
        <div class="model-card-header">
          <div>
            <div class="model-name">${esc(model.label)}</div>
            <div class="model-family">${esc(model.family || "Unknown family")}</div>
          </div>
          <div class="model-badges">
            ${renderBenchmarkBadge(model)}
            ${renderIncompleteBadge(model)}
            ${renderUnsupportedBadge(model)}
            ${model.isNew ? `<span class="badge badge-new" title="Downloaded and not launched yet">New</span>` : ""}
            <span class="badge badge-runtime">${runtimeLabel(runtime)}</span>
            ${renderModelSlotBadges(model)}
          </div>
        </div>
        <div class="model-meta">
          <div class="meta-item"><dt>Size</dt><dd>${esc(model.sizeLabel || "n/a")}</dd></div>
          <div class="meta-item"><dt>Variant</dt><dd>${esc(getModelVariant(model) || "default")}</dd></div>
          <div class="meta-item"><dt>Thinking</dt><dd>${model.supportsThinking ? "On" : "Off"}</dd></div>
          <div class="meta-item"><dt>Slots</dt><dd>${getRunningModelSlots(model).length ? `${getRunningModelSlots(model).length} live` : "Idle"}</dd></div>
        </div>
        <div class="model-card-footer">
          <div class="table-actions">
            <button class="btn btn-primary btn-sm" data-launch-model="${model.key}" ${state.actionInFlight || modelLaunchBlockReason(model) ? "disabled" : ""} title="${esc(modelLaunchBlockReason(model) || buildLaunchButtonTitle(model))}" aria-label="${esc(modelLaunchBlockReason(model) || buildLaunchButtonTitle(model))}">
              Launch
            </button>
            <button class="btn btn-icon icon-action" data-model-settings="${model.key}" ${state.actionInFlight ? "disabled" : ""} title="Open ${esc(model.label)} settings" aria-label="Open ${esc(model.label)} settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 10.91 3H11a2 2 0 1 1 4 0h.09a1.65 1.65 0 0 0 1.51 1 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01A1.65 1.65 0 0 0 21 10.91V11a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            <button class="btn btn-icon icon-action btn-danger" data-stop-model="${model.key}" ${stopDisabled} title="Stop ${esc(model.label)}" aria-label="Stop ${esc(model.label)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            </button>
          </div>
          <div class="model-card-actions">
            ${model.hfUrl ? `<a class="link" href="${safeHref(model.hfUrl)}" target="_blank" rel="noreferrer">Hugging Face &rarr;</a>` : ""}
            <button class="btn btn-danger btn-sm" data-delete-model="${model.key}" ${state.actionInFlight ? "disabled" : ""} title="Delete model">
              Delete
            </button>
          </div>
        </div>
      </article>`;
  }).join(""));
}

function renderProfilesGrid() {
  if (!state.profiles.length) {
    return `<div class="empty-state"><h3>No profiles yet</h3><p>Create a profile from the Profiles tab, then launch it from here with one tap.</p></div>`;
  }
  return `
    <div class="profiles-grid">
      ${state.profiles.map(renderProfileTile).join("")}
    </div>
  `;
}

function estimateProfileModelMemoryBytes(model, config = {}) {
  const modelBytes = modelSizeValue(model);
  if (!(Number.isFinite(modelBytes) && modelBytes > 0)) {
    return 0;
  }
  const runtime = String(model?.runtime || "").toLowerCase();
  const baseMultiplier = {
    gguf: 1.08,
    mlx: 1.04,
    "rapid-mlx": 1.07,
    mtplx: 1.12,
    dflash: 1.16,
    turboquant: 1.06,
  }[runtime] || 1.08;
  const parallel = Math.max(1, Number(config.parallel || 1));
  const ctxSize = Math.max(1, Number(config.ctxSize || 131072));
  const parallelExtra = Math.max(0, parallel - 1) * 0.12;
  const contextExtra = Math.min(0.55, (ctxSize / 131072) * 0.08) * Math.min(parallel, 4);
  return modelBytes * (baseMultiplier + parallelExtra + contextExtra);
}

function estimateVoiceProfileMemoryBytes(model) {
  const modelBytes = modelSizeValue(model);
  return Number.isFinite(modelBytes) && modelBytes > 0 ? modelBytes * 1.08 : 0;
}

function estimateProfileMemoryBytes(profile) {
  if (!profile) {
    return 0;
  }
  const llmBytes = state.slots.reduce((sum, slot) => {
    const config = profile?.slots?.[slot.id];
    if (!config?.enabled || !config?.modelKey) {
      return sum;
    }
    const model = getModel(config.modelKey);
    return sum + estimateProfileModelMemoryBytes(model, config);
  }, 0);
  const voiceBytes = getVoiceSlots().reduce((sum, slot) => {
    const config = profile?.voiceSlots?.[slot.id];
    if (!config?.enabled || !config?.modelKey) {
      return sum;
    }
    const model = getVoiceModels().find((entry) => entry.key === config.modelKey);
    return sum + estimateVoiceProfileMemoryBytes(model);
  }, 0);
  return llmBytes + voiceBytes;
}

function buildProfileEstimateMarkup(profile) {
  const estimatedBytes = estimateProfileMemoryBytes(profile);
  if (!(estimatedBytes > 0)) {
    return `<div class="profile-estimate muted">Est. RAM <strong>n/a</strong><span>Add models to calculate a rough working-set estimate.</span></div>`;
  }
  const totalMemory = Number(state.system?.memory?.totalBytes || 0);
  const percent = totalMemory > 0 ? Math.min(999, Math.round((estimatedBytes / totalMemory) * 100)) : null;
  return `
    <div class="profile-estimate">
      <span>Est. RAM</span>
      <strong>${fmtBytes(estimatedBytes)}</strong>
      <span>${percent != null ? `${percent}% of ${fmtBytes(totalMemory)}` : "rough working-set estimate"}</span>
    </div>
  `;
}

function renderProfileTile(profile) {
  const active = profile.id === state.activeProfileId;
  const selected = profile.id === (state.selectedProfileId || getSelectedProfileCard()?.id);
  const isDefault = profile.id === state.defaultProfileId;
  const enabledSlots = state.slots
    .map((slot) => {
      const config = profile?.slots?.[slot.id];
      if (!config?.enabled || !config?.modelKey) {
        return null;
      }
      const model = getModel(config.modelKey);
      const label = model?.label || config.modelKey;
      return `<li><strong>${esc(slot.shortLabel)}</strong><span title="${esc(label)}">${esc(label)}</span><span class="mono">${fmtCount(config.ctxSize)}</span></li>`;
    })
    .filter(Boolean);
  const enabledVoiceSlots = getVoiceSlots()
    .map((slot) => {
      const config = profile?.voiceSlots?.[slot.id];
      if (!config?.enabled || !config?.modelKey) {
        return null;
      }
      const model = getVoiceModels().find((entry) => entry.key === config.modelKey);
      const label = model?.label || config.modelKey;
      return `<li class="voice"><strong>${esc(slot.type.toUpperCase())}</strong><span title="${esc(label)}">${esc(label)}</span><span>${esc(String(config.voiceName || config.audioFormat || "ready"))}</span></li>`;
    })
    .filter(Boolean);
  const style = buildProfileTileStyle(profile.color);
  return `
    <article class="profile-launch-card${active ? " active" : ""}${selected ? " selected" : ""}" style="${style}" data-profile-select="${esc(profile.id)}">
      <div class="profile-launch-card-head">
        <div class="profile-launch-card-title-wrap">
          <strong class="profile-title-chip" style="${buildProfileLabelStyle(profile.color)}">${esc(profile.name)}</strong>
          <span class="profile-launch-card-updated">${timeAgo(profile.updatedAt)}</span>
        </div>
        <div class="model-badges">
          ${active ? `<span class="badge badge-success">Active</span>` : ""}
          ${isDefault ? `<span class="badge badge-runtime">Default</span>` : ""}
        </div>
      </div>
      <p class="profile-launch-card-copy">${esc(buildProfileSummary(profile))}</p>
      <ul class="profile-launch-card-slots">
        ${enabledSlots.join("")}
        ${enabledVoiceSlots.join("")}
      </ul>
      ${buildProfileEstimateMarkup(profile)}
      <div class="profile-launch-card-actions">
        <button class="btn btn-primary btn-sm" type="button" data-profile-launch="${esc(profile.id)}" ${state.actionInFlight ? "disabled" : ""}>Start</button>
        <button class="btn btn-secondary btn-sm" type="button" data-profile-edit="${esc(profile.id)}" ${state.actionInFlight ? "disabled" : ""}>Edit</button>
      </div>
    </article>
  `;
}

function buildProfileSummary(profile) {
  const parts = state.slots.flatMap((slot) => {
    const config = profile?.slots?.[slot.id];
    if (!config?.enabled || !config?.modelKey) {
      return [];
    }
    const model = getModel(config.modelKey);
    return `${slot.shortLabel}: ${model?.label || config.modelKey} · ${fmtCount(config.ctxSize)}`;
  });
  const voiceParts = getVoiceSlots().flatMap((slot) => {
    const config = profile?.voiceSlots?.[slot.id];
    if (!config?.enabled || !config?.modelKey) {
      return [];
    }
    const model = getVoiceModels().find((entry) => entry.key === config.modelKey);
    return `${slot.type.toUpperCase()}: ${model?.label || config.modelKey}`;
  });
  const summary = [...parts.slice(0, 2), ...voiceParts.slice(0, 2)];
  return summary.length ? summary.join(" | ") : "No slots will be started.";
}

async function runApplyProfile(profileId) {
  const id = String(profileId || "").trim();
  if (!id) {
    return;
  }
  state.selectedProfileId = id;
  await runAction("/api/profiles/apply", { profileId: id }, { preserveModal: false });
}

function renderBenchmarkBadge(model) {
  const rank = model?.benchmark?.rank;
  if (!rank) {
    return "";
  }
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const overall = model?.benchmark?.overall;
  const decode = model?.benchmark?.decodeTps;
  const detailParts = [];
  if (overall != null) {
    detailParts.push(`weighted overall ${overall}`);
  }
  if (decode != null) {
    detailParts.push(`${decode} tok/s`);
  }
  const title = `Top ${rank} overall in the local benchmark suite${detailParts.length ? ` (${detailParts.join(", ")})` : ""}`;
  return `<span class="badge badge-top-score badge-top-${rank}" title="${esc(title)}">${medals[rank] || ""} #${rank}</span>`;
}

// A split GGUF loads through shard 1 and needs every shard on disk. If some
// are missing the set cannot load at all, so say so on the row rather than
// listing it as a model -- an interrupted download used to look exactly like
// a working one, just named "…-00002-of-00003".
// Why this model cannot be launched right now, or "" if it can.
function modelLaunchBlockReason(model) {
  if (model?.unsupported) {
    return model.performanceWarning || "No active launcher";
  }
  const shards = model?.incompleteShards;
  if (shards && shards.expected) {
    return `Incomplete download: ${shards.have} of ${shards.expected} shards on disk. llama.cpp cannot load a split model with shards missing.`;
  }
  return "";
}

function renderIncompleteBadge(model) {
  const shards = model?.incompleteShards;
  if (!shards || !shards.expected) {
    return "";
  }
  const missing = shards.expected - shards.have;
  return `<span class="badge badge-danger" title="${esc(`This split model is missing ${missing} of its ${shards.expected} shards, so it cannot be loaded. Delete it and download it again.`)}">${missing} shard${missing === 1 ? "" : "s"} missing</span>`;
}

function renderUnsupportedBadge(model) {
  if (!model?.unsupported) {
    return "";
  }
  return `<span class="badge badge-unsupported" title="${esc(model.performanceWarning || "No active launcher for this runtime.")}">No launcher</span>`;
}

function renderModelTable(models, palette) {
  return `
    <div class="table-shell">
      <div class="table-scroll">
        <table class="data-table applications-table">
          <thead>
            <tr>
              <th><button class="sortable-th ${state.modelSort.field === "name" ? "active" : ""}" type="button" data-model-sort="name">Name ${modelSortArrow("name")}</button></th>
              <th><button class="sortable-th ${state.modelSort.field === "runtime" ? "active" : ""}" type="button" data-model-sort="runtime">Runtime ${modelSortArrow("runtime")}</button></th>
              <th><button class="sortable-th ${state.modelSort.field === "family" ? "active" : ""}" type="button" data-model-sort="family">Family ${modelSortArrow("family")}</button></th>
              <th><button class="sortable-th ${state.modelSort.field === "variant" ? "active" : ""}" type="button" data-model-sort="variant">Variant ${modelSortArrow("variant")}</button></th>
              <th><button class="sortable-th ${state.modelSort.field === "size" ? "active" : ""}" type="button" data-model-sort="size">Size ${modelSortArrow("size")}</button></th>
              <th>Slots</th>
              <th>Hugging Face</th>
              <th>Stop</th>
              <th>Launch</th>
              <th>Settings</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            ${models.map((model) => `
              <tr class="${isModelActive(model) ? "active-model" : ""}">
                <td class="model-name-cell">
                  <div class="table-name-stack">
                    <div class="table-name-row">
                      ${renderTableModelName(model)}
                      ${renderBenchmarkBadge(model)}
                      ${renderIncompleteBadge(model)}
                      ${renderUnsupportedBadge(model)}
                      ${model.isNew ? `<span class="badge badge-new" title="Downloaded and not launched yet">New</span>` : ""}
                    </div>
                    <span class="mono">${esc(model.path || model.key)}</span>
                  </div>
                </td>
                <td><span class="runtime-pill ${runtimeClass(model.runtime)}">${runtimeLabel(model.runtime)}</span></td>
                <td>${esc(model.family || "n/a")}</td>
                <td>${esc(model.quantization || getModelVariant(model) || "default")}</td>
                <td>${esc(model.sizeLabel || "n/a")}</td>
                <td>${renderModelSlotBadges(model) || "<span class=\"status-text\">idle</span>"}</td>
                <td>${model.hfUrl ? `<a class="link" href="${safeHref(model.hfUrl)}" target="_blank" rel="noreferrer">Open</a>` : "<span class=\"status-text\">n/a</span>"}</td>
                <td>
                  <div class="table-actions">
                    <button class="btn btn-icon icon-action btn-danger" data-stop-model="${model.key}" ${isModelActive(model) && !state.actionInFlight ? "" : "disabled"} title="Stop ${esc(model.label)}" aria-label="Stop ${esc(model.label)}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                    </button>
                  </div>
                </td>
                <td>
                  <div class="table-actions">
                    <button class="btn btn-icon icon-action btn-primary" data-launch-model="${model.key}" ${state.actionInFlight || modelLaunchBlockReason(model) ? "disabled" : ""} title="${esc(modelLaunchBlockReason(model) || buildLaunchButtonTitle(model))}" aria-label="${esc(modelLaunchBlockReason(model) || buildLaunchButtonTitle(model))}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 3 14 9-14 9z"/></svg>
                    </button>
                  </div>
                </td>
                <td>
                  <div class="table-actions">
                    <button class="btn btn-icon icon-action" data-model-settings="${model.key}" ${state.actionInFlight ? "disabled" : ""} title="Open ${esc(model.label)} settings" aria-label="Open ${esc(model.label)} settings">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 10.91 3H11a2 2 0 1 1 4 0h.09a1.65 1.65 0 0 0 1.51 1 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01A1.65 1.65 0 0 0 21 10.91V11a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                    </button>
                  </div>
                </td>
                <td>
                  <div class="table-actions">
                    <button class="btn btn-icon icon-action btn-danger" data-delete-model="${model.key}" ${state.actionInFlight ? "disabled" : ""} title="Delete ${esc(model.label)}" aria-label="Delete ${esc(model.label)}">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                    </button>
                  </div>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
}

async function refreshLauncherCatalog(options = {}) {
  const silent = Boolean(options.silent);
  state.launchersModal.loading = true;
  if (!silent) {
    state.launchersModal.error = "";
  }
  if (state.launchersModal.open) {
    renderLaunchersModal();
  }
  try {
    const data = await fetchJson("/api/launchers");
    state.launchersModal.launchers = Array.isArray(data.launchers) ? data.launchers : [];
    state.launchersModal.error = "";
  } catch (error) {
    state.launchersModal.error = error.message || "Unable to load launchers.";
  } finally {
    state.launchersModal.loading = false;
    if (state.launchersModal.open) {
      renderLaunchersModal();
    }
  }
}

function openLaunchersModal() {
  state.launchersModal.open = true;
  renderLaunchersModal();
  refreshLauncherCatalog();
}

function closeLaunchersModal() {
  state.launchersModal.open = false;
  renderLaunchersModal();
}

function getLauncherCatalogEntry(launcherKey) {
  const key = String(launcherKey || "").trim();
  return state.launchersModal.launchers.find((launcher) => launcher.key === key) || null;
}

function closeLauncherCommandPreview() {
  state.launcherCommandPreview = {
    open: false,
    launcherKey: "",
    title: "",
    command: "",
  };
  renderLauncherCommandPreview();
}

function openLauncherCommandPreview(launcherKey) {
  const launcher = getLauncherCatalogEntry(launcherKey);
  if (!launcher) {
    toast("Launcher details are not loaded yet.", { type: "error" });
    return;
  }
  state.launcherCommandPreview = {
    open: true,
    launcherKey: launcher.key,
    title: launcher.name,
    command: String(launcher.commandTemplate || "").trim(),
  };
  renderLauncherCommandPreview();
}

async function runLauncherUpdate(launcherKey) {
  const key = String(launcherKey || "").trim();
  const launcher = getLauncherCatalogEntry(key);
  if (!key || !launcher || state.launchersModal.updatingKey) {
    return;
  }
  state.launchersModal.updatingKey = key;
  renderLaunchersModal();
  try {
    const result = await fetchJson(`/api/launchers/${encodeURIComponent(key)}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await refreshLauncherCatalog({ silent: true });
    toast(result.version ? `Updated ${launcher.name} · ${result.version}` : `Updated ${launcher.name}`, { type: "success" });
  } catch (error) {
    toast(error.message || `Unable to update ${launcher.name}`, { type: "error", duration: 9000 });
  } finally {
    state.launchersModal.updatingKey = "";
    renderLaunchersModal();
  }
}

function renderHfSearch() {
  if (!els.hfSummaryBar || !els.hfResults) {
    return;
  }
  updateHfDownloadsPanelUi();

  if (els.hfSearchInput && document.activeElement !== els.hfSearchInput) {
    els.hfSearchInput.value = getAppliedHfSearchInputValue();
  }

  const favoriteResults = getAllFavoriteHfResults();
  const favoriteCount = state.hf.favoriteIds.length;
  const results = getVisibleHfResults();
  if (els.hfFavoritesToggleBtn) {
    els.hfFavoritesToggleBtn.classList.toggle("active", state.hf.favoritesOnly);
    els.hfFavoritesToggleBtn.setAttribute("aria-pressed", String(state.hf.favoritesOnly));
    els.hfFavoritesToggleBtn.title = state.hf.favoritesOnly ? "Showing only favorited Hugging Face results" : "Show only favorited Hugging Face results";
  }
  els.hfSummaryBar.innerHTML = `
    <span>${state.hf.loading ? "Searching..." : `${results.length} result${results.length === 1 ? "" : "s"}${state.hf.favoritesOnly ? ` · favorites only${state.hf.appliedFavoritesQuery ? ` · filtered by "${esc(state.hf.appliedFavoritesQuery)}"` : ""}` : ""} · ${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"} saved · GGUF/MLX downloads supported`}</span>
    <span>${state.hf.sort === "name" ? "Sorted by name" : `Sorted by ${esc(state.hf.sort)}`} · ${state.hf.direction.toUpperCase()}</span>
  `;

  if (state.hf.loading) {
    els.hfResults.innerHTML = `
      <div class="empty-state table-empty hf-loading-state">
        <div class="loading-spinner" aria-hidden="true"></div>
        <h3>Searching Hugging Face</h3>
        <p>Finding matching models…</p>
      </div>`;
    return;
  }

  if (state.hf.error) {
    els.hfResults.innerHTML = `<div class="empty-state table-empty"><h3>Search failed</h3><p>${esc(state.hf.error)}</p></div>`;
    return;
  }

  if (!results.length) {
    const message = state.hf.favoritesOnly && state.hf.hydratingFavorites && favoriteCount
      ? "Loading favorited models..."
      : state.hf.favoritesOnly && favoriteResults.length && state.hf.appliedFavoritesQuery
      ? "No favorites match the current favorites filter."
      : state.hf.favoritesOnly && favoriteResults.length
        ? "No favorites available."
      : state.hf.favoritesOnly
        ? "You have not favorited any Hugging Face results yet."
        : "Search any Hugging Face model. GGUF and MLX repos can be downloaded into ~/models.";
    els.hfResults.innerHTML = `<div class="empty-state table-empty"><h3>No results yet</h3><p>${state.hf.loading ? "Searching Hugging Face..." : message}</p></div>`;
    return;
  }

  const downloadedIds = getDownloadedHfCandidateIds();
  els.hfResults.innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Favorite</th>
            <th><button class="sortable-th ${state.hf.sort === "name" ? "active" : ""}" type="button" data-hf-sort="name">Name ${sortArrow("name")}</button></th>
            <th>Runtime</th>
            <th>Quantization</th>
            <th><button class="sortable-th ${state.hf.sort === "size" ? "active" : ""}" type="button" data-hf-sort="size">Size ${sortArrow("size")}</button></th>
            <th><button class="sortable-th ${state.hf.sort === "downloads" ? "active" : ""}" type="button" data-hf-sort="downloads">Downloads ${sortArrow("downloads")}</button></th>
            <th><button class="sortable-th ${state.hf.sort === "likes" ? "active" : ""}" type="button" data-hf-sort="likes">Likes ${sortArrow("likes")}</button></th>
            <th>Hugging Face</th>
            <th>Download</th>
          </tr>
        </thead>
        <tbody>
          ${results.map((candidate) => {
            const isDownloaded = downloadedIds.has(candidate.id);
            const canDownload = Array.isArray(candidate.downloadSpec?.files) && candidate.downloadSpec.files.length > 0;
            const isFavorite = isHfFavorite(candidate.id);
            const activeJob = findActiveHfJobForCandidate(candidate);
            const convertable = !canDownload && !isDownloaded && !activeJob && candidate.browseOnly && !["gguf", "mlx", "dflash"].includes(String(candidate.runtime || "").toLowerCase());
            const quantAccent = getHfQuantizationAccent(candidate);
            return `
            <tr class="${quantAccent.className ? `hf-result-row ${quantAccent.className}` : ""}">
              <td class="hf-favorite-cell">
                <button class="btn btn-icon icon-action hf-favorite-btn ${isFavorite ? "active" : ""}" type="button" data-hf-favorite="${candidate.id}" title="${isFavorite ? `Remove ${esc(candidate.fullName)} from favorites` : `Add ${esc(candidate.fullName)} to favorites`}" aria-label="${isFavorite ? `Remove ${esc(candidate.fullName)} from favorites` : `Add ${esc(candidate.fullName)} to favorites`}" aria-pressed="${isFavorite ? "true" : "false"}">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
              </td>
              <td class="model-name-cell">
                <div class="table-name-stack">
                  <div class="table-name-row">
                    <strong>${esc(candidate.fullName)}</strong>
                    ${renderVisionBadge(candidate.vision)}
                  </div>
                  <span>${esc(candidate.provider || "unknown")} · ${esc(candidate.family || "Downloaded model")}</span>
                </div>
              </td>
              <td><span class="runtime-pill ${runtimeClass(candidate.runtime)}">${runtimeLabel(candidate.runtime)}</span></td>
              <td>
                <span class="hf-quant-pill ${esc(quantAccent.className)}" ${quantAccent.title ? `title="${esc(quantAccent.title)}"` : ""}>
                  ${esc(candidate.quantization || "n/a")}
                </span>
                ${quantAccent.label ? `<span class="hf-quant-callout">${esc(quantAccent.label)}</span>` : ""}
              </td>
              <td>${esc(candidate.sizeLabel || "n/a")}${candidate.multiPart ? ` <span class="status-text" title="Split GGUF — all ${candidate.multiPart} shards download together">(${candidate.multiPart} parts)</span>` : ""}</td>
              <td>${NumberFmt(candidate.downloads)}</td>
              <td>${NumberFmt(candidate.likes)}</td>
              <td><a class="link" href="${safeHref(candidate.hfUrl)}" target="_blank" rel="noreferrer">Open</a></td>
              <td>
                <div class="table-actions">
                  ${isDownloaded ? `<span class="hf-result-state on-disk" title="This exact model is already on disk">On disk</span>` : activeJob ? `
                  <button class="btn btn-sm hf-job-btn" type="button" data-hf-cancel-job="${esc(activeJob.id)}" title="Cancel ${esc(activeJob.kind || "job")}" aria-label="Cancel ${esc(activeJob.kind || "job")}">
                    <span class="btn-spinner" aria-hidden="true"></span>${activeJob.status === "cancelling" ? "Cancelling…" : activeJob.kind === "convert" ? "Converting…" : "Downloading…"}
                  </button>` : `
                  ${canDownload ? `
                  <button class="btn btn-icon icon-action btn-primary" type="button" data-hf-download="${candidate.id}" title="Download ${esc(candidate.name)}" aria-label="Download ${esc(candidate.name)}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
                  </button>` : convertable ? `<button class="btn btn-sm" type="button" data-hf-convert="${candidate.id}" title="Convert ${esc(candidate.name)} to GGUF" aria-label="Convert ${esc(candidate.name)} to GGUF">Convert to GGUF</button>` : `<span class="hf-result-state unavailable" title="This repo can be browsed here.">View only</span>`}`}
                </div>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildHfQuantizationSignals(candidate) {
  const text = [
    candidate?.name,
    candidate?.fullName,
    candidate?.repoId,
    candidate?.quantization,
    candidate?.quantizationMethod,
    ...(candidate?.tags || []),
  ].join(" ").toLowerCase();
  return {
    hasAwq: /\bawq\b/.test(text),
    hasAutoRound: /\bautoround\b|\bauto-round\b/.test(text),
    hasNvfp4: /\bnvfp4\b/.test(text),
    hasInt4: /\bint4\b|\bint-4\b|\b4bit-int\b|\bint4x\b|\bw4a(?:8|16)\b/.test(text),
  };
}

function getHfQuantizationAccent(candidate) {
  const signals = buildHfQuantizationSignals(candidate);
  if (signals.hasAwq || signals.hasAutoRound) {
    return {
      className: "hf-quant-awq",
      label: signals.hasAwq && signals.hasAutoRound ? "AWQ · AutoRound" : signals.hasAwq ? "AWQ" : "AutoRound",
      title: "Recommended balance of model size and performance.",
    };
  }
  if (signals.hasInt4 && !signals.hasNvfp4) {
    return {
      className: "hf-quant-int4",
      label: "INT4",
      title: "INT4 is generally preferred over NVFP4 for better performance and quality.",
    };
  }
  if (signals.hasNvfp4) {
    return {
      className: "hf-quant-nvfp4",
      label: "NVFP4",
      title: "NVFP4 is less preferred than INT4 here.",
    };
  }
  return { className: "", label: "", title: "" };
}

function getVisibleHfResults() {
  const results = state.hf.favoritesOnly ? getAllFavoriteHfResults() : (Array.isArray(state.hf.results) ? state.hf.results : []);
  if (!state.hf.favoritesOnly) {
    return results;
  }
  const appliedQuery = String(state.hf.appliedFavoritesQuery || "").trim();
  if (!appliedQuery) {
    return results;
  }
  return results.filter((candidate) => matchesHfFavoriteSearch(candidate, appliedQuery));
}

function findActiveHfJobForCandidate(candidate) {
  const candidateId = String(candidate?.id || "").trim();
  if (!candidateId) {
    return null;
  }
  return (state.hf.downloads || []).find((job) => {
    if (!job?.canCancel) {
      return false;
    }
    return String(job?.candidate?.id || "").trim() === candidateId;
  }) || null;
}

function isHfFavorite(candidateId) {
  const id = String(candidateId || "").trim();
  return Boolean(id) && (state.hf.favoriteIds || []).includes(id);
}

function toggleHfFavorite(candidateId) {
  const id = String(candidateId || "").trim();
  if (!id) {
    return;
  }
  const current = new Set(state.hf.favoriteIds || []);
  if (current.has(id)) {
    current.delete(id);
    delete state.hf.favoriteEntries[id];
    persistHfFavoriteEntries();
  } else {
    current.add(id);
    const candidate = findHfCandidateById(id);
    if (candidate) {
      rememberHfFavoriteCandidate(candidate);
    }
  }
  state.hf.favoriteIds = [...current];
  persistHfFavorites();
  renderHfSearch();
}

function getAppliedHfSearchInputValue() {
  return state.hf.favoritesOnly ? String(state.hf.appliedFavoritesQuery || "") : String(state.hf.query || "");
}

function getAllFavoriteHfResults() {
  return (state.hf.favoriteIds || [])
    .map((id) => normalizeHfFavoriteEntry(findHfCandidateById(id)))
    .filter(Boolean);
}

function findHfCandidateById(candidateId) {
  const id = String(candidateId || "").trim();
  if (!id) {
    return null;
  }
  return (state.hf.results || []).find((candidate) => candidate?.id === id)
    || state.hf.favoriteEntries?.[id]
    || null;
}

function normalizeHfFavoriteEntry(candidate) {
  const id = String(candidate?.id || "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    name: String(candidate?.name || "").trim(),
    fullName: String(candidate?.fullName || candidate?.repoId || "").trim(),
    repoId: String(candidate?.repoId || "").trim(),
    provider: String(candidate?.provider || "").trim(),
    family: String(candidate?.family || "").trim(),
    runtime: String(candidate?.runtime || "").trim(),
    quantization: String(candidate?.quantization || "").trim(),
    sizeBytes: Number(candidate?.sizeBytes || 0),
    sizeLabel: String(candidate?.sizeLabel || "").trim(),
    downloads: Number(candidate?.downloads || 0),
    likes: Number(candidate?.likes || 0),
    hfUrl: String(candidate?.hfUrl || "").trim(),
    baseModelRepoId: String(candidate?.baseModelRepoId || "").trim(),
    quantizationMethod: String(candidate?.quantizationMethod || "").trim(),
    conversionRepoId: String(candidate?.conversionRepoId || "").trim(),
    conversionBlockedReason: String(candidate?.conversionBlockedReason || "").trim(),
    browseOnly: Boolean(candidate?.browseOnly),
    tags: Array.isArray(candidate?.tags) ? candidate.tags.map((value) => String(value || "").trim()).filter(Boolean) : [],
    downloadSpec: candidate?.downloadSpec && Array.isArray(candidate.downloadSpec.files)
      ? {
          type: String(candidate.downloadSpec.type || "").trim(),
          runtime: String(candidate.downloadSpec.runtime || candidate.runtime || "").trim(),
          repoId: String(candidate.downloadSpec.repoId || candidate.repoId || "").trim(),
          revision: String(candidate.downloadSpec.revision || "").trim(),
          files: candidate.downloadSpec.files.map((entry) => ({
            path: String(entry?.path || "").trim(),
            sizeBytes: Number(entry?.sizeBytes || 0),
          })).filter((entry) => entry.path),
        }
      : undefined,
    template: candidate?.template || undefined,
  };
}

function rememberHfFavoriteCandidate(candidate) {
  const normalized = normalizeHfFavoriteEntry(candidate);
  if (!normalized) {
    return;
  }
  state.hf.favoriteEntries = {
    ...(state.hf.favoriteEntries || {}),
    [normalized.id]: normalized,
  };
  persistHfFavoriteEntries();
}

function syncCachedHfFavorites(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (isHfFavorite(candidate?.id)) {
      rememberHfFavoriteCandidate(candidate);
    }
  }
}

function matchesHfFavoriteSearch(candidate, query) {
  const rawQuery = String(query || "").trim().toLowerCase();
  if (!rawQuery) {
    return true;
  }
  const searchText = [
    candidate?.name,
    candidate?.fullName,
    candidate?.repoId,
    candidate?.provider,
    candidate?.family,
    candidate?.runtime,
    candidate?.quantization,
    ...(candidate?.tags || []),
  ].join(" ").toLowerCase();
  const terms = rawQuery.split(/\s+/).filter(Boolean);
  return terms.every((term) => searchText.includes(term));
}

async function ensureHfFavoriteEntriesHydrated() {
  const missingIds = (state.hf.favoriteIds || []).filter((id) => !state.hf.favoriteEntries?.[id]);
  if (!missingIds.length || state.hf.hydratingFavorites) {
    return;
  }
  state.hf.hydratingFavorites = true;
  try {
    const hydrated = await Promise.all(missingIds.map((id) => hydrateHfFavoriteEntry(id)));
    if (hydrated.some(Boolean) && state.activeSection === "huggingface-models") {
      renderHfSearch();
    }
  } finally {
    state.hf.hydratingFavorites = false;
  }
}

async function hydrateHfFavoriteEntry(candidateId) {
  const id = String(candidateId || "").trim();
  if (!id) {
    return null;
  }
  try {
    const { repoId, runtime } = parseHfFavoriteCandidateId(id);
    const query = encodeURIComponent(repoId || id);
    const sort = encodeURIComponent("downloads");
    const direction = encodeURIComponent("desc");
    const data = await fetchJson(`/api/hf/search?query=${query}&sort=${sort}&direction=${direction}`);
    const results = Array.isArray(data?.results) ? data.results : [];
    const match = results.find((candidate) => candidate?.id === id)
      || results.find((candidate) => candidate?.repoId === repoId && (!runtime || candidate?.runtime === runtime))
      || results.find((candidate) => candidate?.repoId === repoId)
      || null;
    if (match) {
      rememberHfFavoriteCandidate(match);
      return match;
    }
  } catch (_error) {
    return null;
  }
  return null;
}

function parseHfFavoriteCandidateId(candidateId) {
  const id = String(candidateId || "").trim();
  if (id.startsWith("gguf:")) {
    const [, repoId] = id.split(":", 3);
    return { runtime: "gguf", repoId: String(repoId || "").trim() };
  }
  if (id.startsWith("mlx:")) {
    return { runtime: "mlx", repoId: id.slice(4).trim() };
  }
  if (id.startsWith("repo:")) {
    return { runtime: "", repoId: id.slice(5).trim() };
  }
  return { runtime: "", repoId: id };
}

function renderHfDownloads() {
  if (!els.hfDownloads) {
    return;
  }
  updateHfDownloadsPanelUi();

  const jobs = state.hf.downloads || [];
  if (!jobs.length) {
    els.hfDownloads.innerHTML = `<div class="empty-state compact"><p>No Hugging Face downloads yet.</p></div>`;
    return;
  }

  els.hfDownloads.innerHTML = jobs.map((job) => {
    const progress = Math.max(0, Math.min(100, Number(job.progressPct || 0)));
    const isActive = Boolean(job.canCancel);
    return `
      <article class="hf-download-card">
        <div class="hf-download-head">
          <div>
            <strong>${esc(job.candidate?.fullName || job.candidate?.name || job.id)}</strong>
            <span>${esc(job.message || "")}</span>
          </div>
          <div class="hf-download-actions">
            <span class="hf-status-pill kind-${esc(job.kind || "download")}">${esc(job.kind === "convert" ? "convert" : "download")}</span>
            <span class="hf-status-pill ${esc(job.status || "queued")}">${esc(job.status || "queued")}</span>
            ${isActive ? `<button class="btn btn-sm hf-job-btn" type="button" data-hf-cancel-job="${esc(job.id)}"><span class="btn-spinner" aria-hidden="true"></span>${job.status === "cancelling" ? "Cancelling…" : "Cancel"}</button>` : ""}
            ${job.canClear ? `<button class="btn btn-sm" type="button" data-hf-clear-job="${esc(job.id)}">Clear</button>` : ""}
          </div>
        </div>
        <div class="download-progress"><div class="download-progress-bar" style="width:${progress}%"></div></div>
        <div class="download-meta">
          <span>${esc(job.kind === "convert" ? "Remote HF → GGUF" : job.candidate?.runtime === "mlx" ? "MLX snapshot" : "GGUF file")}</span>
          <span>${job.totalBytes ? `${fmtBytes(job.bytesDownloaded)} / ${fmtBytes(job.totalBytes)} · ${progress}%` : esc(job.message || "Working")}</span>
        </div>
      </article>`;
  }).join("");
}

function renderApplications() {
  if (!els.applicationsContent) {
    return;
  }

  const applications = state.applications?.length ? state.applications : buildApplicationItems();
  if (!applications.length) {
    els.applicationsContent.innerHTML = `<div class="empty-state"><h3>No applications configured</h3><p>Application mappings will appear here when the backend is available.</p></div>`;
    return;
  }

  // If user is actively editing, do a partial DOM update that preserves select values
  if (state.editingApplications) {
    const existingTable = els.applicationsContent.querySelector("tbody");
    if (existingTable) {
      const newRows = applications.map((application) => renderApplicationRow(application)).join("");
      // Only update rows that actually changed (by matching application key)
      const existingRows = existingTable.querySelectorAll("tr");
      let needsFullReplace = false;
      
      for (let i = 0; i < existingRows.length; i++) {
        const app = applications[i];
        if (!app) { needsFullReplace = true; break; }
        const newHtml = renderApplicationRow(app);
        // Check if the row content actually changed
        if (existingRows[i].innerHTML !== newHtml) {
          existingRows[i].innerHTML = newHtml;
        }
      }
      
      // Handle added/removed applications
      if (existingRows.length !== applications.length) {
        needsFullReplace = true;
      }
      
      if (!needsFullReplace) {
        return;
      }
    }
  }

  els.applicationsContent.innerHTML = `
    <div class="table-shell">
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th>Application</th>
              <th>Model</th>
            </tr>
          </thead>
          <tbody>
            ${applications.map((application) => renderApplicationRow(application)).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderApplicationRow(application) {
  const isVoiceApp = isVoiceApplication(application.key);
  const slots = isVoiceApp ? state.voiceSlots : state.slots;
  const getSlotFn = isVoiceApp ? getVoiceSlot : getSlot;

  const selectedSlotId = state.applicationDrafts[application.key] || state.applicationTargets[application.key] || slots[0]?.id || "slot1";
  const currentSlotId = state.applicationTargets[application.key] || selectedSlotId;
  const selectedSlot = getSlotFn(selectedSlotId);
  const currentSlot = getSlotFn(currentSlotId);
  const currentModel = currentSlot?.status?.model?.label || currentSlot?.status?.model?.key || "idle";
  const draftChanged = Boolean(state.applicationDirty[application.key]);
  const canApply = Boolean(selectedSlot?.status?.running && draftChanged && !state.actionInFlight);
  const feedback = state.applicationFeedback[application.key] || null;
  const slotOptions = slots.map((slot) => {
    const runningModel = slot.status?.model?.label || slot.status?.model?.key || "idle";
    const disabled = !slot.status?.running && selectedSlotId !== slot.id;
    return `<option value="${slot.id}" ${slot.id === selectedSlotId ? "selected" : ""} ${disabled ? "disabled" : ""}>${esc(slot.label)} · ${esc(runningModel)}</option>`;
  }).join("");

  return `
    <tr>
      <td class="model-name-cell application-name-cell">
        <div class="table-name-stack">
          <strong>${esc(application.label)}</strong>
          <span>${esc(applicationDescription(application.key))}</span>
        </div>
      </td>
      <td>
        <div class="application-picker">
          <label class="field-label application-select-label">
            <select data-application-select="${application.key}" aria-label="${esc(`Assigned ${isVoiceApp ? "voice" : "LLM"} slot for ${application.label}`)}">
              ${slotOptions}
            </select>
          </label>
          <button class="btn btn-primary btn-sm" type="button" data-application-save="${application.key}" ${canApply ? "" : "disabled"}>Apply</button>
        </div>
        <div class="application-meta">
          <span><strong>Current:</strong> ${esc(currentSlot?.label || currentSlotId)} · ${esc(currentModel)}</span>
          <span><strong>Endpoint:</strong> ${esc(currentSlot ? runtimeEndpoint(currentSlot) : "n/a")}</span>
          ${selectedSlot && !selectedSlot.status?.running ? `<span><strong>Note:</strong> Launch a model in ${esc(selectedSlot.label)} before applying.</span>` : ""}
        </div>
        ${feedback ? `
          <div class="application-feedback ${feedback.level}">
            <strong>Last error:</strong>
            <span>${esc(feedback.message)}</span>
          </div>` : ""}
      </td>
    </tr>
  `;
}

// ========== Voice Render Functions ==========

function getVoiceModels() {
  return state.voiceModels || [];
}

function getVoiceSlots() {
  return state.voiceSlots || [];
}

function renderVoice() {
  renderVoiceFilters();
  renderVoiceModels();
  renderVoiceStatus();
}

function renderVoiceFilters() {
  const voiceSlots = getVoiceSlots();
  const ttsSlots = voiceSlots.filter((slot) => slot.type === "tts");
  const sttSlots = voiceSlots.filter((slot) => slot.type === "stt");
  const ttsModels = getVoiceModels().filter((m) => m.type === "tts").length;
  const sttModels = getVoiceModels().filter((m) => m.type === "stt").length;
  const runningTtsSlots = ttsSlots.filter((slot) => slot.status?.running);
  const runningSttSlots = sttSlots.filter((slot) => slot.status?.running);
  const runningTTS = runningTtsSlots.length;
  const runningSTT = runningSttSlots.length;
  const ttsRunningLabel = runningTtsSlots
    .map((slot) => String(slot.status?.model?.label || slot.status?.model?.key || "").trim())
    .filter(Boolean)
    .join(", ");
  const sttRunningLabel = runningSttSlots
    .map((slot) => String(slot.status?.model?.label || slot.status?.model?.key || "").trim())
    .filter(Boolean)
    .join(", ");

  els.voiceFilterChips.innerHTML = `
    <div class="voice-page-header">
      <div>
        <div class="voice-page-eyebrow">Voice Control</div>
        <h3>Launch TTS and STT independently</h3>
        <p>Use each side as a self-contained workspace: select a model, pick the target slot, and manage that runtime without hunting through secondary cards.</p>
      </div>
      <div class="voice-page-summary">
        <div class="voice-summary-pill tts"><strong>TTS</strong><span>${runningTTS}/${Math.max(1, ttsSlots.length)} running · ${ttsModels} models${ttsRunningLabel ? ` · ${esc(ttsRunningLabel)}` : ""}</span></div>
        <div class="voice-summary-pill stt"><strong>STT</strong><span>${runningSTT}/${Math.max(1, sttSlots.length)} running · ${sttModels} models${sttRunningLabel ? ` · ${esc(sttRunningLabel)}` : ""}</span></div>
      </div>
    </div>
  `;
}

function renderVoiceModels() {
  els.voiceModelGrid.innerHTML = `${renderVoiceControlPanel("tts")}${renderVoiceControlPanel("stt")}`;
}

function renderVoiceStatus() {
  const slots = getVoiceSlots();
  if (!slots.length) {
    els.voiceStatusSection.innerHTML = "<p class=\"empty-state\"><div class=\"empty-state-icon\">🎤</div>No voice slots configured.</p>";
    return;
  }

  const ttsSlots = slots.filter((slot) => slot.type === "tts");
  const sttSlots = slots.filter((slot) => slot.type === "stt");

  els.voiceStatusSection.innerHTML = `
    <div class="voice-status-layout">
      <section class="voice-status-group">
        <div class="voice-status-group-header">
          <h4>TTS Slots</h4>
          <span>${ttsSlots.filter((slot) => slot.status?.running).length} running</span>
        </div>
        <div class="voice-status-grid">
          ${ttsSlots.map((slot) => renderVoiceSlotStatus(slot)).join("")}
        </div>
      </section>
      <section class="voice-status-group">
        <div class="voice-status-group-header">
          <h4>STT Slots</h4>
          <span>${sttSlots.filter((slot) => slot.status?.running).length} running</span>
        </div>
        <div class="voice-status-grid">
          ${sttSlots.map((slot) => renderVoiceSlotStatus(slot)).join("")}
        </div>
      </div>
      </section>
    </div>
  `;
}

function renderVoiceSlotStatus(slot) {
  const status = slot.status || {};
  const running = Boolean(status.running);
  const model = status.model || {};
  const runtimeUrl = voiceRuntimeEndpoint(slot);
  const params = status.params || {};

  return `
    <article class="voice-slot-card ${running ? "running" : "idle"}">
      <div class="voice-slot-card-top">
        <div>
          <div class="voice-slot-label">${esc(slot.label)}</div>
          <div class="voice-slot-model">${running ? esc(model.label || model.key || "Runtime live") : "Idle"}</div>
        </div>
        <span class="badge badge-${slot.type}">${slot.type.toUpperCase()}</span>
      </div>
      <div class="voice-slot-endpoint mono">${esc(runtimeUrl)}</div>
      <div class="voice-slot-stats">
        <div><span>Status</span><strong>${running ? "running" : "idle"}</strong></div>
        <div><span>Format</span><strong>${esc(params.audioFormat || "pcm16")}</strong></div>
        <div><span>Rate</span><strong>${NumberFmt(params.sampleRate || (slot.type === "tts" ? 24000 : 16000))} Hz</strong></div>
        <div><span>${slot.type === "tts" ? "Voice" : "Language"}</span><strong>${esc(slot.type === "tts" ? (params.voiceName || "n/a") : (params.language || "auto"))}</strong></div>
      </div>
      <div class="voice-slot-actions">
        ${running
          ? `<button class="btn btn-danger btn-sm" type="button" data-voice-slot-stop="${slot.id}">Stop</button>`
          : `<button class="btn btn-primary btn-sm" type="button" data-voice-slot-launch="${slot.id}">Launch</button>`
        }
      </div>
    </article>
  `;
}

function normalizeVoiceTtsModelKey(modelOrKey) {
  const raw = typeof modelOrKey === "string" ? modelOrKey : modelOrKey?.key;
  return String(raw || "").trim().split("/").pop().toLowerCase();
}

function normalizeVoiceModelKey(modelOrKey) {
  const raw = typeof modelOrKey === "string" ? modelOrKey : modelOrKey?.key;
  return String(raw || "").trim().split("/").pop().toLowerCase();
}

function findVoiceModelByKey(models, modelKey) {
  const target = normalizeVoiceModelKey(modelKey);
  if (!target) {
    return null;
  }
  return models.find((model) => normalizeVoiceModelKey(model) === target) || null;
}

function voiceModelSupportsTuning(modelOrKey) {
  return VOICE_TTS_TUNING_MODEL_KEYS.has(normalizeVoiceTtsModelKey(modelOrKey));
}

function voiceModelSupportsManagedLibrary(modelOrKey) {
  const model = typeof modelOrKey === "string"
    ? getVoiceModels().find((entry) => entry.key === modelOrKey)
    : modelOrKey;
  const runtime = String(model?.runtime || "").trim().toLowerCase();
  return runtime === "chatterbox" || runtime === "phonikud-chatterbox" || runtime === "phonikud-upstream" || runtime === "f5-tts";
}

function getEmptyVoiceLibraryState() {
  return {
    loading: false,
    busy: false,
    error: "",
    statusMessage: "",
    statusTone: "",
    defaultVoice: "",
    voices: [],
    draftName: "",
    draftReferenceText: "",
    selectedFileName: "",
    selectedFileDataUrl: "",
    selectedFileSize: 0,
  };
}

let voiceLibraryPreviewAudio = null;
let voiceLibraryPreviewObjectUrl = "";

function stopVoiceLibraryPreview() {
  if (voiceLibraryPreviewAudio) {
    voiceLibraryPreviewAudio.pause();
    voiceLibraryPreviewAudio = null;
  }
  if (voiceLibraryPreviewObjectUrl) {
    URL.revokeObjectURL(voiceLibraryPreviewObjectUrl);
    voiceLibraryPreviewObjectUrl = "";
  }
}

function getVoiceLibraryStatusMarkup(voiceLibrary) {
  if (!voiceLibrary?.statusMessage) {
    return "";
  }
  const tone = voiceLibrary.statusTone === "success"
    ? "success"
    : voiceLibrary.statusTone === "error"
      ? "error"
      : "info";
  const label = tone === "success" ? "Voice updated:" : tone === "error" ? "Voice error:" : "Voice status:";
  return `<div class="application-feedback ${tone}"><strong>${esc(label)}</strong><span>${esc(voiceLibrary.statusMessage)}</span></div>`;
}

function getManagedVoicePreviewUrl(modelKey, voiceName) {
  const model = getVoiceModels().find((entry) => entry.key === modelKey) || null;
  const runtime = String(model?.runtime || "").trim().toLowerCase();
  const prefix = runtime === "f5-tts" ? "f5" : "chatterbox";
  return `/api/voice/${prefix}/voices/audio?modelKey=${encodeURIComponent(modelKey)}&voiceName=${encodeURIComponent(voiceName)}`;
}

function getManagedVoiceLibraryApiPrefix(modelOrKey) {
  const model = typeof modelOrKey === "string"
    ? getVoiceModels().find((entry) => entry.key === modelOrKey)
    : modelOrKey;
  const runtime = String(model?.runtime || "").trim().toLowerCase();
  return runtime === "f5-tts" ? "f5" : "chatterbox";
}

function managedVoiceLibraryRequiresReferenceText(modelOrKey) {
  const model = typeof modelOrKey === "string"
    ? getVoiceModels().find((entry) => entry.key === modelOrKey)
    : modelOrKey;
  return String(model?.runtime || "").trim().toLowerCase() === "f5-tts";
}

function getVoiceTtsTuningDefaults(modelOrKey = "") {
  return normalizeVoiceTtsTuningDraft({}, modelOrKey);
}

function normalizeVoiceTtsTuningDraft(source = {}, modelOrKey = "") {
  if (!voiceModelSupportsTuning(modelOrKey)) {
    return {};
  }
  return Object.fromEntries(
    VOICE_TTS_TUNING_FIELDS.map((entry) => {
      const numeric = Number(source?.[entry.field]);
      const rawValue = Number.isFinite(numeric) ? numeric : entry.defaultValue;
      const clamped = Math.max(entry.min, Math.min(entry.max, rawValue));
      return [entry.field, clamped];
    })
  );
}

function buildVoiceTtsPayload(source = {}, modelOrKey = "") {
  return normalizeVoiceTtsTuningDraft(source, modelOrKey);
}

function getVoiceTtsTuningSummary(modelOrKey, values) {
  if (!voiceModelSupportsTuning(modelOrKey)) {
    return "";
  }
  const tuning = normalizeVoiceTtsTuningDraft(values, modelOrKey);
  const defaults = getVoiceTtsTuningDefaults(modelOrKey);
  const customizedCount = VOICE_TTS_TUNING_FIELDS.filter((entry) => tuning[entry.field] !== defaults[entry.field]).length;
  return customizedCount > 0 ? `${customizedCount} custom` : "Defaults";
}

function renderVoiceTtsTuningControls(modelOrKey, values, buildAttrs) {
  if (!voiceModelSupportsTuning(modelOrKey)) {
    return "";
  }
  const tuning = normalizeVoiceTtsTuningDraft(values, modelOrKey);
  const modelKey = typeof modelOrKey === "string" ? modelOrKey : String(modelOrKey?.key || "");
  return `
    <section class="voice-tuning-shell field-span-full">
      <div class="voice-tuning-header">
        <div>
          <strong>Generation parameters</strong>
          <p>These are forwarded to Chatterbox for synthesis.</p>
        </div>
        <button
          class="btn btn-secondary btn-sm"
          type="button"
          data-voice-tuning-reset="${esc(modelKey)}"
        >Default Values</button>
      </div>
      <div class="voice-tuning-grid">
        ${VOICE_TTS_TUNING_FIELDS.map((entry) => `
          <label class="field-label voice-tuning-field">
            <span>${entry.label}</span>
            <input
              ${buildAttrs(entry.field)}
              type="${entry.inputType || "number"}"
              min="${entry.min}"
              max="${entry.max}"
              step="${entry.step}"
              value="${esc(String(tuning[entry.field]))}"
            />
            ${entry.inputType === "range" ? `<output>${esc(String(tuning[entry.field]))}${entry.valueSuffix || ""}</output>` : ""}
            <small>${entry.help}</small>
          </label>
        `).join("")}
      </div>
    </section>
  `;
}

function renderVoiceTuningButton(scope, modelOrKey, options = {}) {
  if (!voiceModelSupportsTuning(modelOrKey) && !voiceModelSupportsManagedLibrary(modelOrKey)) {
    return "";
  }
  const modelKey = typeof modelOrKey === "string" ? modelOrKey : String(modelOrKey?.key || "");
  const fallbackSummary = voiceModelSupportsTuning(modelOrKey)
    ? getVoiceTtsTuningSummary(modelOrKey, options.values || {})
    : voiceModelSupportsManagedLibrary(modelOrKey)
      ? "Voice library"
      : "";
  const summary = String(options.summary || fallbackSummary).trim();
  const disabled = Boolean(options.disabled);
  const label = String(options.label || "Settings").trim() || "Settings";
  const title = voiceModelSupportsTuning(modelOrKey)
    ? "Adjust TTS generation parameters"
    : "Manage saved voices";
  return `
    <button
      class="btn btn-secondary btn-sm voice-tuning-trigger"
      type="button"
      data-voice-tuning-open="${esc(scope)}"
      data-model-key="${esc(modelKey)}"
      ${disabled ? "disabled" : ""}
      title="${esc(title)}"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.26 1.3.73 1.77.47.47 1.11.73 1.77.73H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      <span>${esc(label)}</span>
      ${summary ? `<small>${esc(summary)}</small>` : ""}
    </button>
  `;
}

function ensureVoiceDraft(type) {
  const slots = getVoiceSlots().filter((slot) => slot.type === type);
  const models = getVoiceModels().filter((model) => model.type === type);
  const runningSlot = slots.find((slot) => slot.status?.running) || slots[0] || null;
  const runningModelKey = runningSlot?.status?.model?.key || "";
  const liveVoiceName = String(runningSlot?.status?.params?.voiceName || runningSlot?.status?.params?.voice || "").trim();
  const draft = state.voiceLaunchDrafts[type] || {};
  const hasPersistedDraft = Object.keys(draft).length > 0;
  const followRuntime = Boolean(runningSlot?.status?.running) && !isRefreshPaused() && !hasPersistedDraft;
  const preferredModelKey = followRuntime ? String(runningModelKey || "").trim() : String(draft.modelKey || "").trim();
  const preferredSlotId = followRuntime ? String(runningSlot?.id || "").trim() : String(draft.voiceSlotId || "").trim();
  const resolvedModel = findVoiceModelByKey(models, preferredModelKey)
    || findVoiceModelByKey(models, draft.modelKey)
    || findVoiceModelByKey(models, runningModelKey)
    || models[0]
    || null;
  const resolvedSlot = slots.find((slot) => slot.id === preferredSlotId)
    || slots.find((slot) => slot.id === draft.voiceSlotId)
    || runningSlot
    || null;
  const liveTuning = type === "tts" ? normalizeVoiceTtsTuningDraft(runningSlot?.status?.params || {}, resolvedModel) : {};
  const draftTuning = type === "tts" ? normalizeVoiceTtsTuningDraft(draft, resolvedModel) : {};
  const requestedVoiceName = String(
    followRuntime
      ? (liveVoiceName || draft.voiceName || resolvedModel?.voices?.[0] || "")
      : (draft.voiceName || liveVoiceName || resolvedModel?.voices?.[0] || "")
  ).trim();
  const defaults = {
    modelKey: resolvedModel?.key || "",
    voiceSlotId: resolvedSlot?.id || "",
    audioFormat: draft.audioFormat || "pcm16",
    sampleRate: Number(draft.sampleRate) || (type === "tts" ? 24000 : 16000),
    voiceName: type === "tts" && resolvedModel?.voices?.length && !resolvedModel.voices.includes(requestedVoiceName)
      ? String(resolvedModel.voices[0] || "")
      : requestedVoiceName,
    setHermes: draft.setHermes ?? true,
    setHermesM4: draft.setHermesM4 ?? true,
    ...(type === "tts" ? (followRuntime ? liveTuning : draftTuning) : {}),
  };
  state.voiceLaunchDrafts[type] = defaults;
  persistVoiceLaunchDrafts();
  return defaults;
}

function renderVoiceControlPanel(type) {
  const title = type === "tts" ? "Speech output" : "Speech input";
  const icon = type === "tts" ? "🎙️" : "🎧";
  const models = getVoiceModels().filter((model) => model.type === type);
  const slots = getVoiceSlots().filter((slot) => slot.type === type);
  const draft = ensureVoiceDraft(type);
  const selectedSlot = slots.find((slot) => slot.id === draft.voiceSlotId) || null;
  const running = Boolean(selectedSlot?.status?.running);
  const liveModel = selectedSlot?.status?.model || {};
  const liveParams = selectedSlot?.status?.params || {};
  const displayedModelKey = running
    ? String(liveModel.key || draft.modelKey || "").trim()
    : String(draft.modelKey || "").trim();
  const selectedModel = findVoiceModelByKey(models, displayedModelKey)
    || findVoiceModelByKey(models, draft.modelKey)
    || null;
  const endpoint = selectedSlot ? voiceRuntimeEndpoint(selectedSlot) : "";
  const formatOptions = type === "tts" ? ["pcm16", "wav", "mp3", "ogg"] : ["pcm16", "wav"];
  const sampleRateOptions = type === "tts" ? [22050, 24000, 44100] : [16000];

  return `
    <section class="voice-workspace ${type}">
      <div class="voice-workspace-header">
        <div class="voice-workspace-title">
          <div class="voice-control-kicker">${icon} ${title}</div>
          <h4>${type === "tts" ? "Manage text-to-speech" : "Manage speech-to-text"}</h4>
          <p>${type === "tts" ? "Launch a synthesis runtime and optionally route Hermes TTS into it." : "Launch a transcription runtime and optionally route Hermes STT into it."}</p>
        </div>
        <div class="voice-runtime-chip ${running ? "running" : "idle"}">${running ? "Running" : "Idle"}</div>
      </div>
      <div class="voice-workspace-body">
        <section class="voice-panel-block">
          <div class="voice-block-heading">Launch</div>
          <div class="voice-control-fields">
            <label class="field-label field-span-full">
              <span>${type.toUpperCase()} model</span>
              <select data-voice-panel-input="${type}" data-field="modelKey">
                ${models.map((model) => `<option value="${model.key}" ${normalizeVoiceModelKey(model) === normalizeVoiceModelKey(displayedModelKey) ? "selected" : ""}>${esc(model.label)} · ${esc(model.runtime || "n/a")} · ${esc(model.sizeLabel || "n/a")}</option>`).join("")}
              </select>
            </label>
            <label class="field-label">
              <span>Target slot</span>
              <select data-voice-panel-input="${type}" data-field="voiceSlotId">
                ${slots.map((slot) => `<option value="${slot.id}" ${slot.id === draft.voiceSlotId ? "selected" : ""}>${esc(slot.label)} · port ${slot.publicPort}</option>`).join("")}
              </select>
            </label>
            <label class="field-label">
              <span>Audio format</span>
              <select data-voice-panel-input="${type}" data-field="audioFormat">
                ${formatOptions.map((format) => `<option value="${format}" ${draft.audioFormat === format ? "selected" : ""}>${format}</option>`).join("")}
              </select>
            </label>
            <label class="field-label">
              <span>Sample rate</span>
              <select data-voice-panel-input="${type}" data-field="sampleRate">
                ${sampleRateOptions.map((rate) => `<option value="${rate}" ${String(draft.sampleRate) === String(rate) ? "selected" : ""}>${rate} Hz</option>`).join("")}
              </select>
            </label>
            ${type === "tts" && selectedModel?.voices?.length ? `
            <label class="field-label">
              <span>Voice</span>
              <select data-voice-panel-input="${type}" data-field="voiceName">
                ${selectedModel.voices.map((voice) => `<option value="${esc(voice)}" ${draft.voiceName === voice ? "selected" : ""}>${esc(voice)}</option>`).join("")}
              </select>
            </label>
            ${renderVoiceTuningButton("voice", selectedModel, {
              values: draft,
              disabled: state.actionInFlight,
            })}` : `
            <div class="field-label voice-static-field">
              <span>Transcription mode</span>
              <div class="voice-static-value">Auto-detect language</div>
            </div>`}
            <label class="checkbox-label modal-flag field-span-full">
              <input type="checkbox" data-voice-panel-input="${type}" data-field="setHermes" ${draft.setHermes ? "checked" : ""} />
              <span>Point Hermes ${type.toUpperCase()} here after launch</span>
            </label>
            <label class="checkbox-label modal-flag field-span-full">
              <input type="checkbox" data-voice-panel-input="${type}" data-field="setHermesM4" ${draft.setHermesM4 ? "checked" : ""} />
              <span>Point Hermes M4 ${type.toUpperCase()} here after launch</span>
            </label>
          </div>
          <div class="voice-control-actions">
            <button class="btn btn-secondary btn-sm" type="button" data-voice-panel-save="${type}" ${selectedModel && selectedSlot && !state.actionInFlight ? "" : "disabled"}>Save Defaults</button>
            <button class="btn btn-primary btn-sm" type="button" data-voice-panel-launch="${type}" ${selectedModel && selectedSlot && !state.actionInFlight ? "" : "disabled"}>Launch</button>
            <button class="btn btn-danger btn-sm" type="button" data-voice-panel-stop="${type}" ${running && !state.actionInFlight ? "" : "disabled"}>Stop</button>
          </div>
        </section>
        <section class="voice-panel-block voice-runtime-block">
          <div class="voice-block-heading">Current Runtime</div>
          <div class="voice-runtime-summary">
            <div class="voice-runtime-main">
              <div class="voice-runtime-name">${running ? esc(liveModel.label || liveModel.key || "Runtime live") : "No runtime active"}</div>
              <div class="voice-runtime-endpoint mono">${esc(endpoint || "n/a")}</div>
            </div>
            <div class="voice-runtime-stats">
              <div><span>Selected model</span><strong>${selectedModel ? esc(selectedModel.label) : "n/a"}</strong></div>
              <div><span>Slot</span><strong>${selectedSlot ? esc(selectedSlot.label) : "n/a"}</strong></div>
              <div><span>Format</span><strong>${esc((running ? liveParams.audioFormat : draft.audioFormat) || "pcm16")}</strong></div>
              <div><span>Rate</span><strong>${NumberFmt((running ? liveParams.sampleRate : draft.sampleRate) || (type === "tts" ? 24000 : 16000))} Hz</strong></div>
              <div><span>${type === "tts" ? "Voice" : "Language"}</span><strong>${esc(type === "tts" ? ((running ? liveParams.voiceName : draft.voiceName) || "n/a") : ((running ? liveParams.language : "auto") || "auto"))}</strong></div>
              <div><span>Status</span><strong>${running ? "running" : "idle"}</strong></div>
            </div>
          </div>
        </section>
      </div>
      <div class="voice-model-strip">
        <div class="voice-block-heading">Available ${type.toUpperCase()} Models</div>
        <div class="voice-model-pills">
          ${models.map((model) => `
            <button class="voice-model-pill ${model.key === draft.modelKey ? "active" : ""}" type="button" data-voice-model-choice="${type}" data-model-key="${esc(model.key)}">
              <strong>${esc(model.label)}</strong>
              <span>${esc(model.runtime || "n/a")} · ${esc(model.sizeLabel || "n/a")}</span>
            </button>
          `).join("")}
        </div>
      </div>
    </section>
  `;
}

function resetVoicePanelTuningToDefaults(type) {
  if (type !== "tts") {
    return;
  }
  const current = ensureVoiceDraft(type);
  const model = getVoiceModels().find((entry) => entry.key === current.modelKey) || current.modelKey;
  const next = {
    ...current,
    ...getVoiceTtsTuningDefaults(model),
  };
  state.voiceLaunchDrafts[type] = next;
  persistVoiceLaunchDrafts();
  renderVoiceModels();
  pauseRefreshForEditing();
}

function openVoiceTuningModal(scope, modelKey) {
  const model = getVoiceModels().find((entry) => entry.key === modelKey);
  if (!model || (!voiceModelSupportsTuning(model) && !voiceModelSupportsManagedLibrary(model))) {
    return;
  }
  const values = scope === "benchmark"
    ? getVoiceBenchmarkSelectedTuning(model)
    : normalizeVoiceTtsTuningDraft(ensureVoiceDraft("tts"), model);
  state.voiceTuningModal = {
    open: true,
    scope,
    modelKey: model.key,
    values,
    disabled: scope === "benchmark" ? Boolean(getVoiceBenchmarkJob().running) : Boolean(state.actionInFlight),
    voiceLibrary: getEmptyVoiceLibraryState(),
  };
  pauseRefreshForEditing();
  renderVoiceTuningModal();
  if (voiceModelSupportsManagedLibrary(model)) {
    void loadVoiceTuningModalVoiceLibrary(model.key);
  }
}

function closeVoiceTuningModal() {
  stopVoiceLibraryPreview();
  state.voiceTuningModal = {
    open: false,
    scope: "voice",
    modelKey: "",
    values: {},
    disabled: false,
    voiceLibrary: getEmptyVoiceLibraryState(),
  };
  renderVoiceTuningModal();
}

function saveVoiceTuningModal() {
  const modal = state.voiceTuningModal;
  const model = getVoiceModels().find((entry) => entry.key === modal.modelKey);
  if (!modal.open || !model || !voiceModelSupportsTuning(model)) {
    return;
  }
  const nextValues = normalizeVoiceTtsTuningDraft(modal.values, model);
  if (modal.scope === "benchmark") {
    const nextMap = {
      ...(state.voiceBenchmark.selectedTunings || {}),
      [model.key]: nextValues,
    };
    state.voiceBenchmark.selectedTunings = nextMap;
    persistVoiceBenchmarkTunings(nextMap);
    renderVoiceBenchmark();
  } else {
    const current = ensureVoiceDraft("tts");
    state.voiceLaunchDrafts.tts = {
      ...current,
      modelKey: model.key,
      ...nextValues,
    };
    persistVoiceLaunchDrafts();
    renderVoiceModels();
  }
  closeVoiceTuningModal();
}

async function loadVoiceTuningModalVoiceLibrary(modelKey, options = {}) {
  const modal = state.voiceTuningModal;
  if (!modal.open || modal.modelKey !== modelKey || !voiceModelSupportsManagedLibrary(modelKey)) {
    return;
  }
  const apiPrefix = getManagedVoiceLibraryApiPrefix(modelKey);
  state.voiceTuningModal = {
    ...modal,
    voiceLibrary: {
      ...(modal.voiceLibrary || getEmptyVoiceLibraryState()),
      loading: true,
      error: options.preserveError ? String(modal.voiceLibrary?.error || "") : "",
      statusMessage: options.statusMessage != null ? String(options.statusMessage || "") : String(modal.voiceLibrary?.statusMessage || ""),
      statusTone: options.statusTone != null ? String(options.statusTone || "") : String(modal.voiceLibrary?.statusTone || ""),
    },
  };
  renderVoiceTuningModal();
  try {
    const payload = await fetchJson(`/api/voice/${apiPrefix}/voices?modelKey=${encodeURIComponent(modelKey)}`);
    if (!state.voiceTuningModal.open || state.voiceTuningModal.modelKey !== modelKey) {
      return;
    }
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        loading: false,
        busy: false,
        error: "",
        defaultVoice: String(payload.defaultVoice || ""),
        voices: Array.isArray(payload.voices) ? payload.voices : [],
      },
    };
    renderVoiceTuningModal();
  } catch (error) {
    if (!state.voiceTuningModal.open || state.voiceTuningModal.modelKey !== modelKey) {
      return;
    }
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        loading: false,
        busy: false,
        error: error.message || "Unable to load managed voices.",
      },
    };
    renderVoiceTuningModal();
  }
}

async function uploadVoiceTuningModalVoice() {
  const modal = state.voiceTuningModal;
  const model = getVoiceModels().find((entry) => entry.key === modal.modelKey);
  if (!modal.open || !model || !voiceModelSupportsManagedLibrary(model)) {
    return;
  }
  const apiPrefix = getManagedVoiceLibraryApiPrefix(model);
  const voiceLibrary = modal.voiceLibrary || getEmptyVoiceLibraryState();
  const voiceName = String(voiceLibrary.draftName || "").trim();
  const referenceText = String(voiceLibrary.draftReferenceText || "").trim();
  const audioBase64 = String(voiceLibrary.selectedFileDataUrl || "");
  if (!voiceName) {
    state.voiceTuningModal = {
      ...modal,
      voiceLibrary: {
        ...voiceLibrary,
        error: "Enter a voice name before uploading.",
        statusMessage: "",
        statusTone: "",
      },
    };
    renderVoiceTuningModal();
    toast("enter a voice name", { type: "error" });
    return;
  }
  if (!audioBase64) {
    state.voiceTuningModal = {
      ...modal,
      voiceLibrary: {
        ...voiceLibrary,
        error: "Select a WAV file before uploading.",
        statusMessage: "",
        statusTone: "",
      },
    };
    renderVoiceTuningModal();
    toast("select a WAV file", { type: "error" });
    return;
  }
  if (managedVoiceLibraryRequiresReferenceText(model) && !referenceText) {
    state.voiceTuningModal = {
      ...modal,
      voiceLibrary: {
        ...voiceLibrary,
        error: "Enter the transcript for the reference WAV before uploading.",
        statusMessage: "",
        statusTone: "",
      },
    };
    renderVoiceTuningModal();
    toast("enter the reference text", { type: "error" });
    return;
  }
  state.voiceTuningModal = {
    ...modal,
    voiceLibrary: {
      ...voiceLibrary,
      busy: true,
      error: "",
      statusMessage: `Uploading ${voiceLibrary.selectedFileName || "voice clip"} as ${voiceName}...`,
      statusTone: "info",
    },
  };
  renderVoiceTuningModal();
  try {
    await fetchJson(`/api/voice/${apiPrefix}/voices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelKey: model.key,
        voiceName,
        audioBase64,
        fileName: voiceLibrary.selectedFileName || "",
        referenceText,
      }),
    });
    await refreshOverview();
    await refreshVoiceBenchmarkState({ silent: true });
    toast(`Added voice ${voiceName}.`, { type: "success" });
    if (!state.voiceTuningModal.open || state.voiceTuningModal.modelKey !== model.key) {
      return;
    }
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        draftName: "",
        draftReferenceText: "",
        selectedFileName: "",
        selectedFileDataUrl: "",
        selectedFileSize: 0,
        statusMessage: `Added voice ${voiceName}.`,
        statusTone: "success",
      },
    };
    await loadVoiceTuningModalVoiceLibrary(model.key, {
      statusMessage: `Added voice ${voiceName}.`,
      statusTone: "success",
    });
  } catch (error) {
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        loading: false,
        busy: false,
        error: error.message || "Unable to add voice.",
        statusMessage: "",
        statusTone: "",
      },
    };
    renderVoiceTuningModal();
    toast(error.message || "Unable to add voice.", { type: "error" });
  }
}

async function deleteVoiceTuningModalVoice(voiceName) {
  const modal = state.voiceTuningModal;
  const model = getVoiceModels().find((entry) => entry.key === modal.modelKey);
  if (!modal.open || !model || !voiceModelSupportsManagedLibrary(model)) {
    return;
  }
  const apiPrefix = getManagedVoiceLibraryApiPrefix(model);
  const normalizedVoiceName = String(voiceName || "").trim();
  if (!normalizedVoiceName) {
    return;
  }
  state.voiceTuningModal = {
    ...modal,
    voiceLibrary: {
      ...(modal.voiceLibrary || getEmptyVoiceLibraryState()),
      busy: true,
      error: "",
      statusMessage: `Deleting ${normalizedVoiceName}...`,
      statusTone: "info",
    },
  };
  renderVoiceTuningModal();
  try {
    await fetchJson(`/api/voice/${apiPrefix}/voices/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelKey: model.key,
        voiceName: normalizedVoiceName,
      }),
    });
    await refreshOverview();
    await refreshVoiceBenchmarkState({ silent: true });
    toast(`Deleted voice ${normalizedVoiceName}.`, { type: "success" });
    stopVoiceLibraryPreview();
    await loadVoiceTuningModalVoiceLibrary(model.key, {
      statusMessage: `Deleted voice ${normalizedVoiceName}.`,
      statusTone: "success",
    });
  } catch (error) {
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        loading: false,
        busy: false,
        error: error.message || "Unable to delete voice.",
        statusMessage: "",
        statusTone: "",
      },
    };
    renderVoiceTuningModal();
    toast(error.message || "Unable to delete voice.", { type: "error" });
  }
}

async function playVoiceTuningModalVoice(voiceName) {
  const modal = state.voiceTuningModal;
  const model = getVoiceModels().find((entry) => entry.key === modal.modelKey);
  if (!modal.open || !model || !voiceModelSupportsManagedLibrary(model)) {
    return;
  }
  const normalizedVoiceName = String(voiceName || "").trim();
  if (!normalizedVoiceName) {
    return;
  }
  stopVoiceLibraryPreview();
  try {
    const response = await fetch(getManagedVoicePreviewUrl(model.key, normalizedVoiceName));
    if (!response.ok) {
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("application/json")) {
        const data = await responseJson(response).catch(() => ({}));
        throw new Error(data.error || `Preview request failed: ${response.status} ${response.statusText}`.trim());
      }
      const rawText = await response.text().catch(() => "");
      const compactText = String(rawText || "").replace(/\s+/g, " ").trim();
      const detail = compactText ? ` - ${compactText.slice(0, 160)}` : "";
      throw new Error(`Preview request failed: ${response.status} ${response.statusText}${detail}`.trim());
    }
    const blob = await response.blob();
    voiceLibraryPreviewObjectUrl = URL.createObjectURL(
      blob.type ? blob : new Blob([blob], { type: "audio/wav" })
    );
    const audio = new Audio(voiceLibraryPreviewObjectUrl);
    voiceLibraryPreviewAudio = audio;
    audio.addEventListener("ended", () => {
      if (voiceLibraryPreviewAudio === audio) {
        voiceLibraryPreviewAudio = null;
      }
      if (voiceLibraryPreviewObjectUrl) {
        URL.revokeObjectURL(voiceLibraryPreviewObjectUrl);
        voiceLibraryPreviewObjectUrl = "";
      }
    }, { once: true });
    await audio.play();
  } catch (error) {
    stopVoiceLibraryPreview();
    state.voiceTuningModal = {
      ...state.voiceTuningModal,
      voiceLibrary: {
        ...(state.voiceTuningModal.voiceLibrary || getEmptyVoiceLibraryState()),
        error: error.message || `Unable to play ${normalizedVoiceName}.`,
        statusMessage: "",
        statusTone: "",
      },
    };
    renderVoiceTuningModal();
    toast(error.message || `Unable to play ${normalizedVoiceName}.`, { type: "error" });
  }
}

function renderVoiceTuningModal() {
  if (!els.voiceTuningModal || !els.voiceTuningModalContent) {
    return;
  }
  const modalBody = els.voiceTuningModalContent.closest(".modal-body");
  const previousScrollTop = modalBody?.scrollTop ?? 0;
  const modal = state.voiceTuningModal;
  const open = Boolean(modal.open);
  els.voiceTuningModal.classList.toggle("hidden", !open);
  els.voiceTuningModal.setAttribute("aria-hidden", String(!open));
  if (!open) {
    els.voiceTuningModalContent.innerHTML = "";
    if (els.voiceTuningModalHeaderActions) {
      els.voiceTuningModalHeaderActions.innerHTML = "";
    }
    return;
  }

  const model = getVoiceModels().find((entry) => entry.key === modal.modelKey);
  if (!model || (!voiceModelSupportsTuning(model) && !voiceModelSupportsManagedLibrary(model))) {
    closeVoiceTuningModal();
    return;
  }

  const values = normalizeVoiceTtsTuningDraft(modal.values, model);
  const disabled = Boolean(modal.disabled);
  const scopeLabel = modal.scope === "benchmark" ? "Voice Benchmark" : "Voice";
  const voiceLibrarySupported = voiceModelSupportsManagedLibrary(model);
  const tuningSupported = voiceModelSupportsTuning(model);
  const needsReferenceText = managedVoiceLibraryRequiresReferenceText(model);
  const voiceLibrary = modal.voiceLibrary || getEmptyVoiceLibraryState();
  const libraryBusy = Boolean(voiceLibrary.loading || voiceLibrary.busy);
  const selectedFileSummary = voiceLibrary.selectedFileName
    ? `${voiceLibrary.selectedFileName}${voiceLibrary.selectedFileSize ? ` · ${formatBytes(voiceLibrary.selectedFileSize)}` : ""}`
    : "";

  if (els.voiceTuningModalTitle) {
    els.voiceTuningModalTitle.textContent = `${model.label} Settings`;
  }
  if (els.voiceTuningModalSubtitle) {
    els.voiceTuningModalSubtitle.textContent = `${scopeLabel} · saved ${modal.scope === "benchmark" ? "into the next benchmark run" : "into the current TTS launch defaults"}.`;
  }
  if (els.voiceTuningModalHeaderActions) {
    els.voiceTuningModalHeaderActions.innerHTML = tuningSupported ? `
      <button class="btn btn-secondary btn-sm" type="button" data-voice-tuning-reset-modal ${disabled ? "disabled" : ""}>Default Values</button>
      <button class="btn btn-primary btn-sm" type="button" data-voice-tuning-save-modal ${disabled ? "disabled" : ""}>Save</button>
    ` : "";
  }
  els.voiceTuningModalContent.innerHTML = `
    <section class="voice-tuning-shell voice-tuning-shell-modal">
      ${tuningSupported ? `
        <div class="voice-tuning-header">
          <div>
            <strong>Generation parameters</strong>
            <p>These values are forwarded to Chatterbox during synthesis.</p>
          </div>
          <div class="voice-tuning-badge">${esc(getVoiceTtsTuningSummary(model, values))}</div>
        </div>
        <div class="voice-tuning-grid">
          ${VOICE_TTS_TUNING_FIELDS.map((entry) => `
            <label class="field-label voice-tuning-field">
              <span>${entry.label}</span>
              <input
                data-voice-tuning-modal-field="${entry.field}"
                type="${entry.inputType || "number"}"
                min="${entry.min}"
                max="${entry.max}"
                step="${entry.step}"
                value="${esc(String(values[entry.field]))}"
                ${disabled ? "disabled" : ""}
              />
              ${entry.inputType === "range" ? `<output>${esc(String(values[entry.field]))}${entry.valueSuffix || ""}</output>` : ""}
              <small>${entry.help}</small>
            </label>
          `).join("")}
        </div>
      ` : ""}
      ${voiceLibrarySupported ? `
        <div class="voice-tuning-header voice-library-header">
          <div>
            <strong>Voice library</strong>
            <p>${needsReferenceText ? "llm3 owns the voices for this F5 model. Upload a short WAV clip plus the exact transcript to create a reusable voice." : "llm3 owns the voices for this chatterbox model. Add one short WAV clip to create a new voice, or delete an existing one."}</p>
          </div>
          <div class="voice-tuning-badge">${esc(voiceLibrary.defaultVoice ? `Default: ${voiceLibrary.defaultVoice}` : "Managed by llm3")}</div>
        </div>
        ${getVoiceLibraryStatusMarkup(voiceLibrary)}
        ${voiceLibrary.error ? `<div class="application-feedback error"><strong>Voice error:</strong><span>${esc(voiceLibrary.error)}</span></div>` : ""}
        <div class="voice-control-fields">
          <label class="field-label">
            <span>Voice name</span>
            <input type="text" data-voice-library-name value="${esc(voiceLibrary.draftName || "")}" placeholder="new-voice" ${libraryBusy ? "disabled" : ""} />
          </label>
          <label class="field-label field-span-full">
            <span>WAV clip</span>
            <input type="file" accept=".wav,audio/wav" data-voice-library-file ${libraryBusy ? "disabled" : ""} />
            ${selectedFileSummary ? `<div class="voice-library-selected-file">${esc(selectedFileSummary)}</div>` : ""}
            <small>${needsReferenceText ? "Use a short reference WAV clip. llm3 stores the clip and transcript under the selected F5 model." : "Use a short reference WAV clip. llm3 stores it under the selected chatterbox model and mirrors it into the other chatterbox models, so the voice resolves whichever one serves the request."}</small>
          </label>
          ${needsReferenceText ? `
            <label class="field-label field-span-full">
              <span>Reference transcript</span>
              <textarea data-voice-library-reference-text rows="4" placeholder="Type exactly what the WAV file says." ${libraryBusy ? "disabled" : ""}>${esc(voiceLibrary.draftReferenceText || "")}</textarea>
              <small>F5-TTS needs the text spoken in the reference WAV so llm3 can send both <code>ref_audio</code> and <code>ref_text</code>.</small>
            </label>
          ` : ""}
        </div>
        <div class="voice-control-actions">
          <button class="btn btn-primary btn-sm" type="button" data-voice-library-upload ${libraryBusy ? "disabled" : ""}>${voiceLibrary.loading ? "Loading…" : voiceLibrary.busy ? "Working…" : "Add Voice"}</button>
        </div>
        <div class="voice-benchmark-model-grid">
          ${(Array.isArray(voiceLibrary.voices) && voiceLibrary.voices.length ? voiceLibrary.voices : []).map((voice) => `
            <div class="voice-benchmark-model-option selected">
              <div class="voice-benchmark-model-check">
                <span>
                  <strong>${esc(voice.name || "voice")}</strong>
                  <span class="voice-benchmark-model-meta">
                    <span>${esc(voice.builtin ? "builtin" : "wav")}</span>
                    <span>${esc(voice.exists ? "available" : "missing")}</span>
                    <span>${esc(voice.deletable ? "deletable" : "protected")}</span>
                  </span>
                  ${needsReferenceText && voice.ref_text ? `<small class="voice-library-ref-text">${esc(voice.ref_text)}</small>` : ""}
                </span>
              </div>
              <div class="voice-control-actions voice-library-item-actions">
                ${voice.exists && !voice.builtin ? `<button class="btn btn-secondary btn-sm voice-library-play-btn" type="button" title="Play ${esc(voice.name || "voice")}" aria-label="Play ${esc(voice.name || "voice")}" data-voice-library-play="${esc(voice.name || "")}" ${libraryBusy ? "disabled" : ""}>▶</button>` : ""}
                ${voice.deletable ? `<button class="btn btn-danger btn-sm" type="button" data-voice-library-delete="${esc(voice.name || "")}" ${libraryBusy ? "disabled" : ""}>Delete</button>` : ""}
              </div>
            </div>
          `).join("") || `<div class="voice-benchmark-empty">No managed voices found.</div>`}
        </div>
      ` : ""}
    </section>
  `;
  if (modalBody) {
    modalBody.scrollTop = previousScrollTop;
  }
}

// ========== Voice Event Handlers ==========

function wireVoiceEvents() {
  els.voiceModelGrid?.addEventListener("click", (event) => {
    const resetTuningButton = event.target.closest("[data-voice-tuning-reset]");
    if (resetTuningButton) {
      resetVoicePanelTuningToDefaults("tts");
      return;
    }
    const tuningButton = event.target.closest("[data-voice-tuning-open]");
    if (tuningButton) {
      openVoiceTuningModal(
        String(tuningButton.dataset.voiceTuningOpen || "voice"),
        String(tuningButton.dataset.modelKey || "")
      );
      return;
    }
    const modelChoice = event.target.closest("[data-voice-model-choice]");
    if (modelChoice) {
      const type = modelChoice.dataset.voiceModelChoice;
      const current = ensureVoiceDraft(type);
      const next = { ...current, modelKey: modelChoice.dataset.modelKey };
      const model = getVoiceModels().find((entry) => entry.key === next.modelKey);
      if (type === "tts" && model?.voices?.length && !model.voices.includes(next.voiceName)) {
        next.voiceName = model.voices[0];
      }
      if (type === "tts") {
        Object.assign(next, normalizeVoiceTtsTuningDraft(next, model));
      }
      state.voiceLaunchDrafts[type] = next;
      persistVoiceLaunchDrafts();
      renderVoiceModels();
      pauseRefreshForEditing();
      return;
    }
    const launchPanelButton = event.target.closest("[data-voice-panel-launch]");
    if (launchPanelButton) {
      launchVoicePanel(launchPanelButton.dataset.voicePanelLaunch);
      return;
    }
    const savePanelButton = event.target.closest("[data-voice-panel-save]");
    if (savePanelButton) {
      saveVoicePanelDefaults(savePanelButton.dataset.voicePanelSave);
      return;
    }
    const stopPanelButton = event.target.closest("[data-voice-panel-stop]");
    if (stopPanelButton) {
      stopVoiceSlotByType(stopPanelButton.dataset.voicePanelStop);
      return;
    }
    const launchBtn = event.target.closest("[data-voice-launch]");
    if (launchBtn) {
      openVoiceLaunchModal(launchBtn.dataset.voiceModel);
      return;
    }
    const stopBtn = event.target.closest("[data-voice-stop]");
    if (stopBtn) {
      stopVoiceModel(stopBtn.dataset.voiceModel);
      return;
    }
    pauseRefreshForEditing();
  });

  els.voiceModelGrid?.addEventListener("change", (event) => {
    const input = event.target.closest("[data-voice-panel-input]");
    if (!input) return;
    const type = input.dataset.voicePanelInput;
    const field = input.dataset.field;
    const current = ensureVoiceDraft(type);
    const value = input.type === "checkbox" ? input.checked : input.value;
    const next = {
      ...current,
      [field]: (field === "sampleRate" || VOICE_TTS_TUNING_FIELD_NAMES.has(field)) ? Number(value) : value,
    };
    if (field === "modelKey") {
      const model = getVoiceModels().find((entry) => entry.key === next.modelKey);
      if (type === "tts" && model?.voices?.length && !model.voices.includes(next.voiceName)) {
        next.voiceName = model.voices[0];
      }
      if (type === "tts") {
        Object.assign(next, normalizeVoiceTtsTuningDraft(next, model));
      }
    }
    state.voiceLaunchDrafts[type] = next;
    persistVoiceLaunchDrafts();
    renderVoiceModels();
    pauseRefreshForEditing();
  });

  // Voice slot buttons (in status section)
  els.voiceStatusSection?.addEventListener("click", (event) => {
    const launchBtn = event.target.closest("[data-voice-slot-launch]");
    if (launchBtn) {
      openVoiceSlotLaunchModal(launchBtn.dataset.voiceSlotLaunch);
      return;
    }
    const stopBtn = event.target.closest("[data-voice-slot-stop]");
    if (stopBtn) {
      stopVoiceSlot(stopBtn.dataset.voiceSlotStop);
      return;
    }
    pauseRefreshForEditing();
  });
}

// ========== Voice Modal ==========

function openVoiceLaunchModal(modelKey, preferredSlotId = null) {
  const model = getVoiceModels().find((m) => m.key === modelKey);
  if (!model) return;
  const slots = getVoiceSlots().filter((slot) => slot.type === model.type);
  const draft = ensureVoiceDraft(model.type);
  const selectedSlot = slots.find((slot) => slot.id === preferredSlotId)
    || slots.find((slot) => slot.status?.running && slot.status?.model?.key === model.key)
    || slots[0]
    || null;
  if (!selectedSlot) {
    toast(`no ${model.type.toUpperCase()} slot available`);
    return;
  }

  state.modal.open = true;
  state.modal.modelKey = null;
  state.modal.voiceModel = modelKey;
  state.modal.voiceSlotId = selectedSlot.id;
  state.modal.voiceVoiceName = (model.voices && model.voices[0]) || "";
  state.modal.voiceFormat = model.type === "tts" ? "pcm16" : "pcm16";
  state.modal.voiceSampleRate = model.type === "tts" ? 24000 : 16000;
  state.modal.voiceSetHermes = model.type === "tts";
  state.modal.form = {
    voiceName: draft.modelKey === model.key ? (draft.voiceName || state.modal.voiceVoiceName) : state.modal.voiceVoiceName,
    audioFormat: draft.audioFormat || state.modal.voiceFormat,
    sampleRate: Number(draft.sampleRate) || state.modal.voiceSampleRate,
    setHermes: draft.setHermes ?? state.modal.voiceSetHermes,
    setHermesM4: draft.setHermesM4 ?? true,
    ...buildVoiceTtsPayload(draft, model),
  };

  els.launchModalTitle.textContent = `Launch ${model.label}`;
  els.launchModalSubtitle.textContent = `${model.type === "tts" ? "Text-to-Speech" : "Speech-to-Text"} · ${model.sizeLabel} · ${model.quality}`;
  els.launchModal.classList.remove("hidden");
  els.launchModal.setAttribute("aria-hidden", "false");

  // Trigger modal render with voice-specific form
  pauseRefreshForEditing();
  renderLaunchModal();
}

function openVoiceSlotLaunchModal(slotId, preferredModelKey = "") {
  const slot = getVoiceSlots().find((s) => s.id === slotId);
  if (!slot) return;
  const availableModels = sortVoiceModels(getVoiceModels().filter((model) => model.type === slot.type));
  const normalizedModelKey = String(preferredModelKey || "").trim();
  const defaultModel = availableModels.find((model) => model.key === normalizedModelKey) || availableModels[0] || null;
  if (!defaultModel) {
    toast(`no ${slot.type.toUpperCase()} models available`);
    return;
  }
  openVoiceLaunchModal(defaultModel.key, slot.id);
}

async function stopVoiceModel(modelKey) {
  const slot = getVoiceSlots().find((entry) => entry.status?.model?.key === modelKey);
  if (!slot) {
    toast("no running slot for that model");
    return;
  }
  await runAction("/api/voice/stop", { voiceSlotId: slot.id });
}

async function stopVoiceSlot(slotId) {
  await runAction("/api/voice/stop", { voiceSlotId: slotId });
}

async function launchVoicePanel(type) {
  const draft = ensureVoiceDraft(type);
  if (!draft.modelKey || !draft.voiceSlotId) {
    toast(`select a ${type.toUpperCase()} model and slot first`);
    return;
  }
  await runAction("/api/voice/start", {
    voiceSlotId: draft.voiceSlotId,
    modelKey: draft.modelKey,
    voiceName: draft.voiceName || "",
    audioFormat: draft.audioFormat || "pcm16",
    sampleRate: Number(draft.sampleRate) || (type === "tts" ? 24000 : 16000),
    setHermes: Boolean(draft.setHermes),
    setHermesM4: Boolean(draft.setHermesM4),
    ...buildVoiceTtsPayload(draft, draft.modelKey),
  });
}

async function saveVoicePanelDefaults(type) {
  const draft = ensureVoiceDraft(type);
  if (!draft.modelKey || !draft.voiceSlotId) {
    toast(`select a ${type.toUpperCase()} model and slot first`);
    return;
  }
  await runAction("/api/voice/defaults", {
    voiceSlotId: draft.voiceSlotId,
    modelKey: draft.modelKey,
    voiceName: draft.voiceName || "",
    audioFormat: draft.audioFormat || "pcm16",
    sampleRate: Number(draft.sampleRate) || (type === "tts" ? 24000 : 16000),
    ...buildVoiceTtsPayload(draft, draft.modelKey),
  });
}

async function stopVoiceSlotByType(type) {
  const draft = ensureVoiceDraft(type);
  if (!draft.voiceSlotId) {
    toast(`no ${type.toUpperCase()} slot selected`);
    return;
  }
  await runAction("/api/voice/stop", { voiceSlotId: draft.voiceSlotId });
}

// ========== Voice Benchmark ==========

function getTtsVoiceModels() {
  return getVoiceModels().filter((model) => model.type === "tts");
}

function getVoiceBenchmarkSelectedKeys() {
  const available = new Set(getTtsVoiceModels().map((model) => model.key));
  // An empty selection is empty. It used to mean "every model", so unchecking
  // the last box silently re-selected everything else.
  return (state.voiceBenchmark.selectedModelKeys || []).filter((key) => available.has(key));
}

function getVoiceBenchmarkQueue() {
  const available = new Set(getTtsVoiceModels().map((model) => model.key));
  return (state.voiceBenchmark.queue || []).filter((entry) => available.has(entry.modelKey));
}

function setVoiceBenchmarkQueue(queue) {
  // Same model + same voice only once; the order of first insertion is kept.
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(queue) ? queue : []) {
    const key = `${entry.modelKey}::${entry.voiceName || ""}`;
    if (!entry.modelKey || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ modelKey: entry.modelKey, voiceName: entry.voiceName || "" });
  }
  state.voiceBenchmark.queue = normalized;
  persistVoiceBenchmarkQueue(normalized);
}

function addVoiceBenchmarkQueueEntry(modelKey) {
  const model = getTtsVoiceModels().find((entry) => entry.key === modelKey);
  if (!model) return;
  const voiceName = model.voices?.length ? getVoiceBenchmarkSelectedVoice(model) : "";
  setVoiceBenchmarkQueue([...getVoiceBenchmarkQueue(), { modelKey, voiceName }]);
}

function autosizeVoiceBenchmarkTextarea(textarea) {
  if (!textarea) return;
  textarea.style.height = "auto";
  const cap = Math.round(window.innerHeight * 0.4);
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, cap)}px`;
  textarea.style.overflowY = textarea.scrollHeight + 2 > cap ? "auto" : "hidden";
}

function updateVoiceBenchmarkSelection(keys) {
  const normalized = Array.isArray(keys)
    ? [...new Set(keys.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  state.voiceBenchmark.selectedModelKeys = normalized;
  persistVoiceBenchmarkModelKeys(normalized);
}

function getVoiceBenchmarkRuntimeVoice(model) {
  const slotId = String(state.voiceBenchmark?.slotId || "voice-tts-1");
  const slot = getVoiceSlot(slotId);
  const availableVoices = Array.isArray(model?.voices) ? model.voices.map((voice) => String(voice || "").trim()).filter(Boolean) : [];
  if (!slot || !availableVoices.length) {
    return "";
  }
  const slotModelKey = String(slot.status?.model?.key || "").trim();
  const modelKey = String(model?.key || "").trim();
  if (!slotModelKey || !modelKey || slotModelKey !== modelKey) {
    return "";
  }
  const runtimeVoice = String(slot.status?.params?.voiceName || slot.status?.params?.voice || "").trim();
  return availableVoices.includes(runtimeVoice) ? runtimeVoice : "";
}

function getVoiceBenchmarkSelectedVoice(model) {
  const availableVoices = Array.isArray(model?.voices) ? model.voices.map((voice) => String(voice || "").trim()).filter(Boolean) : [];
  if (!availableVoices.length) {
    return "";
  }
  const stored = String(state.voiceBenchmark.selectedVoices?.[model.key] || "").trim();
  if (availableVoices.includes(stored)) {
    return stored;
  }
  const runtimeVoice = getVoiceBenchmarkRuntimeVoice(model);
  if (runtimeVoice) {
    return runtimeVoice;
  }
  return availableVoices[0];
}

function updateVoiceBenchmarkModelVoice(modelKey, voiceName) {
  const model = getTtsVoiceModels().find((entry) => entry.key === modelKey);
  if (!model) {
    return;
  }
  const availableVoices = Array.isArray(model.voices) ? model.voices.map((voice) => String(voice || "").trim()).filter(Boolean) : [];
  const nextVoice = String(voiceName || "").trim();
  const nextMap = {
    ...(state.voiceBenchmark.selectedVoices || {}),
  };
  if (!nextVoice || !availableVoices.includes(nextVoice)) {
    delete nextMap[modelKey];
  } else {
    nextMap[modelKey] = nextVoice;
  }
  state.voiceBenchmark.selectedVoices = nextMap;
  persistVoiceBenchmarkVoices(nextMap);
}

function getVoiceBenchmarkSelectedVoicesPayload() {
  return Object.fromEntries(
    getTtsVoiceModels()
      .map((model) => [model.key, getVoiceBenchmarkSelectedVoice(model)])
      .filter(([, voiceName]) => voiceName)
  );
}

function getVoiceBenchmarkRuntimeTuning(model) {
  if (!voiceModelSupportsTuning(model)) {
    return {};
  }
  const slotId = String(state.voiceBenchmark?.slotId || "voice-tts-1");
  const slot = getVoiceSlot(slotId);
  if (!slot) {
    return {};
  }
  const slotModelKey = String(slot.status?.model?.key || "").trim();
  const modelKey = String(model?.key || "").trim();
  if (!slotModelKey || !modelKey || slotModelKey !== modelKey) {
    return {};
  }
  return normalizeVoiceTtsTuningDraft(slot.status?.params || {}, model);
}

function getVoiceBenchmarkSelectedTuning(model) {
  if (!voiceModelSupportsTuning(model)) {
    return {};
  }
  const modelKey = String(model?.key || "").trim();
  const stored = state.voiceBenchmark.selectedTunings?.[modelKey];
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return normalizeVoiceTtsTuningDraft(stored, model);
  }
  const serverStored = state.voiceBenchmark.serverState?.selectedTunings?.[modelKey];
  if (serverStored && typeof serverStored === "object" && !Array.isArray(serverStored)) {
    return normalizeVoiceTtsTuningDraft(serverStored, model);
  }
  const runtimeTuning = getVoiceBenchmarkRuntimeTuning(model);
  if (Object.keys(runtimeTuning).length) {
    return runtimeTuning;
  }
  return normalizeVoiceTtsTuningDraft({}, model);
}

function getVoiceBenchmarkSelectedTuningsPayload() {
  const selectedKeys = new Set(getVoiceBenchmarkQueue().map((entry) => entry.modelKey));
  return Object.fromEntries(
    getTtsVoiceModels()
      .filter((model) => selectedKeys.has(model.key) && voiceModelSupportsTuning(model))
      .map((model) => [model.key, getVoiceBenchmarkSelectedTuning(model)])
      .filter(([, tuning]) => Object.keys(tuning || {}).length)
  );
}

let voiceBenchmarkPreviewAudio = null;
let voiceBenchmarkPreviewUrl = "";

function getVoiceBenchmarkJob() {
  return state.voiceBenchmark.serverState || {
    status: "idle",
    results: [],
    running: false,
    cancelRequested: false,
    completedCount: 0,
    totalCount: 0,
    currentStage: "",
    currentStageDetail: "",
    restorationNote: "",
    error: "",
    textDirection: detectVoiceBenchmarkTextDirection(state.voiceBenchmark.text),
  };
}

function detectVoiceBenchmarkTextDirection(text) {
  return /[\u0590-\u08FF]/.test(String(text || "")) ? "rtl" : "ltr";
}

function detectVoiceBenchmarkLanguageCode(text) {
  const value = String(text || "");
  if (/[\u0590-\u05FF]/.test(value)) return "he";
  if (/[\u0600-\u06FF]/.test(value)) return "ar";
  if (/[\u0900-\u097F]/.test(value)) return "hi";
  if (/[\u3040-\u30FF]/.test(value)) return "ja";
  if (/[\u4E00-\u9FFF]/.test(value)) return "zh";
  return "";
}

function normalizeVoiceBenchmarkLanguageCode(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return "";
  const [primary] = normalized.split("-");
  if (primary === "en") return "en";
  if (primary === "pt") return "pt";
  return primary;
}

function voiceBenchmarkLanguageLabel(code) {
  return ({
    he: "Hebrew",
    ar: "Arabic",
    hi: "Hindi",
    ja: "Japanese",
    zh: "Chinese",
  })[code] || code;
}

function voiceBenchmarkModelSupportsLanguage(model, languageCode) {
  const normalizedLanguage = normalizeVoiceBenchmarkLanguageCode(languageCode);
  if (!normalizedLanguage) return true;
  const supported = Array.isArray(model?.languages)
    ? [...new Set(model.languages.map((entry) => normalizeVoiceBenchmarkLanguageCode(entry)).filter(Boolean))]
    : [];
  return !supported.length || supported.includes(normalizedLanguage);
}

function renderVoiceBenchmark() {
  if (!els.voiceBenchmarkContent) {
    return;
  }

  const benchmark = state.voiceBenchmark;
  const job = getVoiceBenchmarkJob();
  const ttsModels = getTtsVoiceModels();
  const modelsByKey = new Map(ttsModels.map((model) => [model.key, model]));
  const slotOptions = getVoiceSlots().filter((slot) => slot.type === "tts");
  const queue = getVoiceBenchmarkQueue();
  const text = String(benchmark.text || "");
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  const charCount = text.length;
  const slot = getVoiceSlot(benchmark.slotId) || slotOptions[0] || null;
  const running = Boolean(job.running);
  const textareaDir = detectVoiceBenchmarkTextDirection(text || job.text || "");
  const languageCode = detectVoiceBenchmarkLanguageCode(text || job.text || "");
  const languageLabel = languageCode ? voiceBenchmarkLanguageLabel(languageCode) : "";
  const supportedModels = ttsModels.filter((model) => voiceBenchmarkModelSupportsLanguage(model, languageCode));
  const statusLine = running
    ? `${job.completedCount || 0}/${Math.max(job.totalCount || 0, 1)} · ${job.currentStageDetail || "Benchmark running"}`
    : (job.status && job.status !== "idle" ? `${String(job.status).replace(/-/g, " ")}${job.restorationNote ? ` · ${job.restorationNote}` : ""}` : "");

  els.voiceBenchmarkContent.innerHTML = `
    <section class="voice-benchmark-card voice-benchmark-text-card">
      <div class="voice-benchmark-row-header">
        <h4>Benchmark text</h4>
        <div class="voice-benchmark-stats">
          <span id="voiceBenchmarkCharCount" class="voice-benchmark-pill">${charCount} chars</span>
          <span id="voiceBenchmarkWordCount" class="voice-benchmark-pill">${wordCount} words</span>
          ${languageLabel ? `<span class="voice-benchmark-pill">${esc(languageLabel)}</span>` : ""}
        </div>
      </div>
      <textarea id="voiceBenchmarkText" class="voice-benchmark-textarea" rows="1" dir="${textareaDir}" placeholder="Type or paste the text every queued voice will read." ${running ? "disabled" : ""}>${esc(text)}</textarea>
    </section>

    <section class="voice-benchmark-card">
      <div class="voice-benchmark-row-header">
        <div class="voice-benchmark-title-group">
          <h4>Results</h4>
          ${statusLine ? `<span class="voice-benchmark-status-line">${running ? `<span class="voice-benchmark-spinner" aria-hidden="true"></span>` : ""}${esc(statusLine)}</span>` : ""}
        </div>
        <div class="voice-benchmark-controls">
          ${slotOptions.length > 1 ? `
            <select id="voiceBenchmarkSlot" title="TTS slot" ${running ? "disabled" : ""}>
              ${slotOptions.map((entry) => `<option value="${entry.id}" ${entry.id === (slot?.id || benchmark.slotId) ? "selected" : ""}>${esc(entry.label)}</option>`).join("")}
            </select>` : ""}
          <select id="voiceBenchmarkFormat" title="Audio format" ${running ? "disabled" : ""}>
            ${["wav", "mp3", "ogg"].map((format) => `<option value="${format}" ${benchmark.audioFormat === format ? "selected" : ""}>${format}</option>`).join("")}
          </select>
          <select id="voiceBenchmarkSampleRate" title="Sample rate" ${running ? "disabled" : ""}>
            ${[22050, 24000, 44100].map((rate) => `<option value="${rate}" ${Number(benchmark.sampleRate) === rate ? "selected" : ""}>${rate} Hz</option>`).join("")}
          </select>
          <button class="btn btn-primary" type="button" data-voice-benchmark-run ${running || !queue.length || !text.trim() ? "disabled" : ""}>Run ${queue.length ? `(${queue.length})` : ""}</button>
          <button class="btn btn-danger" type="button" data-voice-benchmark-cancel ${running ? "" : "disabled"}>Cancel</button>
        </div>
      </div>
      <div class="voice-benchmark-queue">
        ${queue.length ? queue.map((entry, index) => {
          const model = modelsByKey.get(entry.modelKey);
          const supported = voiceBenchmarkModelSupportsLanguage(model, languageCode);
          return `
            <span class="voice-benchmark-chip ${supported ? "" : "unsupported"}" title="${supported ? "" : esc(`does not list ${languageLabel}`)}">
              <strong>${esc(model?.label || entry.modelKey)}</strong>${entry.voiceName ? `<span>· ${esc(entry.voiceName)}</span>` : ""}
              <button type="button" class="voice-benchmark-chip-remove" data-voice-benchmark-remove="${index}" title="Remove" ${running ? "disabled" : ""}>×</button>
            </span>`;
        }).join("") : (running ? "" : `<span class="voice-benchmark-queue-empty">Queue is empty. Add a model and voice below; the same model can be added with several voices.</span>`)}
        ${queue.length ? `<button type="button" class="btn btn-secondary btn-sm" data-voice-benchmark-select="none" ${running ? "disabled" : ""}>Clear</button>` : ""}
      </div>
      ${job.error ? `<p class="voice-benchmark-error">${esc(job.error)}</p>` : ""}
      <div class="voice-benchmark-table-shell">
        <table class="voice-benchmark-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Model</th>
              <th>Voice</th>
              <th>Elapsed</th>
              <th>Audio</th>
              <th title="Synthesis time divided by audio length. Below 1.0 is faster than realtime.">RTF</th>
              <th>Size</th>
              <th>Actions</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            ${job.results?.length ? job.results.map(renderVoiceBenchmarkResultRow).join("") : `<tr><td colspan="9" class="voice-benchmark-empty">No benchmark results yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>

    <section class="voice-benchmark-card">
      <div class="voice-benchmark-row-header">
        <h4>Models</h4>
        <div class="voice-benchmark-controls">
          <button class="btn btn-secondary btn-sm" type="button" data-voice-benchmark-select="all" ${running || !supportedModels.length ? "disabled" : ""}>Add all${languageLabel ? ` ${esc(languageLabel)}` : ""} models</button>
        </div>
      </div>
      <div class="voice-benchmark-model-grid">
        ${ttsModels.map((model) => {
          const runtime = String(model.runtime || "").replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
          const supported = voiceBenchmarkModelSupportsLanguage(model, languageCode);
          const selectedVoice = getVoiceBenchmarkSelectedVoice(model);
          const queuedCount = queue.filter((entry) => entry.modelKey === model.key).length;
          return `
            <div class="voice-benchmark-model-option ${queuedCount ? "selected" : ""} ${languageCode && !supported ? "unsupported" : ""}">
              <div class="voice-benchmark-model-check">
                <span>
                  <strong>${esc(model.label)}</strong>
                  <span class="voice-benchmark-model-meta">
                    <span>${esc(runtime || "runtime n/a")}</span>
                    <span>${esc(model.sizeLabel || "n/a")}</span>
                    <span>${esc(model.latency || "latency n/a")}</span>
                    ${languageCode && !supported ? `<span class="voice-benchmark-model-warn">${esc(`no ${languageLabel.toLowerCase()}`)}</span>` : ""}
                    ${queuedCount ? `<span class="voice-benchmark-model-queued">queued ×${queuedCount}</span>` : ""}
                  </span>
                </span>
              </div>
              ${model.voices?.length > 1 ? `
                <label class="field-label voice-benchmark-model-field" title="Voice">
                  <select data-voice-benchmark-voice="${esc(model.key)}" ${running ? "disabled" : ""} aria-label="Voice">
                    ${model.voices.map((voice) => `<option value="${esc(voice)}" ${selectedVoice === voice ? "selected" : ""}>${esc(voice)}</option>`).join("")}
                  </select>
                </label>
              ` : `<span class="voice-benchmark-model-field voice-benchmark-model-single-voice">${esc(model.voices?.[0] || "default")}</span>`}
              ${renderVoiceTuningButton("benchmark", model, {
                values: getVoiceBenchmarkSelectedTuning(model),
                disabled: running,
                label: "Settings",
              }) || `<span></span>`}
              <button class="btn btn-secondary btn-sm" type="button" data-voice-benchmark-add="${esc(model.key)}" ${running ? "disabled" : ""} title="Add this model with the chosen voice to the queue">+ Add</button>
            </div>
          `;
        }).join("") || `<div class="voice-benchmark-empty">No managed voices found.</div>`}
      </div>
    </section>
  `;
  autosizeVoiceBenchmarkTextarea(els.voiceBenchmarkContent.querySelector("#voiceBenchmarkText"));
}

function renderVoiceBenchmarkResultRow(result) {
  const status = String(result.status || "queued");
  const detail = String(result.error || result.stageDetail || "").trim();
  return `
    <tr>
      <td>${renderVoiceBenchmarkStatusBadge(status, detail)}</td>
      <td>
        <strong>${esc(result.label || result.modelKey || "Unknown")}</strong>
        <div class="voice-benchmark-result-subtitle">${esc(result.runtimeLabel || "")}</div>
        ${result.servedModelKey && !String(result.modelKey || "").endsWith(`/${result.servedModelKey}`) && result.servedModelKey !== result.modelKey
          ? `<div class="voice-benchmark-result-subtitle voice-benchmark-error">served by ${esc(result.servedModelKey)}</div>`
          : ""}
      </td>
      <td>${esc(result.voiceName || "default")}</td>
      <td>${esc(formatElapsedMs(result.elapsedMs))}</td>
      <td>${esc(formatDurationSeconds(result.audioDurationSeconds))}</td>
      <td>${esc(formatVoiceBenchmarkRealtimeFactor(result))}</td>
      <td>${esc(formatBytes(result.audioBytes || 0))}</td>
      <td class="voice-benchmark-table-actions">
        ${result.audioUrl ? `<button class="btn btn-secondary btn-sm voice-benchmark-icon-btn" type="button" title="Play" data-voice-benchmark-play="${esc(result.audioUrl)}">▶</button>` : `<span class="voice-benchmark-action-placeholder">-</span>`}
        ${result.audioUrl ? `<a class="btn btn-secondary btn-sm voice-benchmark-icon-btn" href="${esc(result.audioUrl)}" download title="Download">↓</a>` : ""}
      </td>
      <td>${esc(detail || "-")}</td>
    </tr>
  `;
}

function formatVoiceBenchmarkRealtimeFactor(result) {
  const elapsed = Number(result?.elapsedMs || 0) / 1000;
  const audio = Number(result?.audioDurationSeconds || 0);
  if (!(elapsed > 0) || !(audio > 0)) return "-";
  return `${(elapsed / audio).toFixed(2)}x`;
}

function renderVoiceBenchmarkStatusBadge(status, detail = "") {
  const statusText = String(status || "queued");
  const statusClass = statusText === "ready" ? "badge-tts" : (statusText === "failed" ? "badge-danger" : "");
  const badge = `<span class="badge ${statusClass}">${esc(statusText)}</span>`;
  const tooltipCopy = String(detail || "").trim();
  if (statusText !== "failed" || !tooltipCopy) {
    return badge;
  }
  return `
    <span
      class="models-slot-tooltip-anchor voice-benchmark-status-anchor has-tooltip"
      tabindex="0"
      role="button"
      aria-label="${esc(`Benchmark error: ${tooltipCopy}`)}"
    >
      ${badge}
      <span class="models-slot-tooltip voice-benchmark-status-tooltip">
        <span class="models-slot-tooltip-title">Benchmark error</span>
        <span class="models-slot-tooltip-copy">${esc(tooltipCopy)}</span>
      </span>
    </span>
  `;
}

function formatElapsedMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) return "n/a";
  if (ms >= 60000) return `${(ms / 60000).toFixed(2)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s`;
  return `${Math.round(ms)} ms`;
}

function formatDurationSeconds(value) {
  const seconds = Number(value || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return "n/a";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.round(seconds % 60);
    return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  }
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const decimals = size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function formatClockTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function updateVoiceBenchmarkTextStats(text) {
  const normalized = String(text || "");
  const charCount = normalized.length;
  const wordCount = normalized.trim() ? normalized.trim().split(/\s+/).length : 0;
  const lineCount = normalized ? normalized.split(/\n/).length : 0;
  const charEl = document.getElementById("voiceBenchmarkCharCount");
  const wordEl = document.getElementById("voiceBenchmarkWordCount");
  const lineEl = document.getElementById("voiceBenchmarkLineCount");
  if (charEl) charEl.textContent = `${charCount} chars`;
  if (wordEl) wordEl.textContent = `${wordCount} words`;
  if (lineEl) lineEl.textContent = `${lineCount} lines`;
}
async function refreshVoiceBenchmarkState(options = {}) {
  const { silent = false } = options;
  if (state.voiceBenchmark.loading) {
    return;
  }
  state.voiceBenchmark.loading = true;
  try {
    const data = await fetchJson("/api/voice/benchmark");
    const signature = JSON.stringify({
      runId: data.runId || "",
      status: data.status || "idle",
      updatedAt: data.updatedAt || "",
      resultsLength: Array.isArray(data.results) ? data.results.length : 0,
      currentStageDetail: data.currentStageDetail || "",
      ttsModelsLength: getTtsVoiceModels().length,
      voiceSlotsLength: getVoiceSlots().filter((slot) => slot.type === "tts").length,
    });
    state.voiceBenchmark.serverState = data;
    if (!state.voiceBenchmark.text && data.text) {
      state.voiceBenchmark.text = String(data.text || "");
    }
    const shouldRender = state.activeSection === "voice-benchmark"
      && (!els.voiceBenchmarkContent?.children.length || signature !== state.voiceBenchmark.lastSignature);
    state.voiceBenchmark.lastSignature = signature;
    if (shouldRender) {
      renderVoiceBenchmark();
    }
  } catch (error) {
    if (!silent && state.activeSection === "voice-benchmark") {
      toast(error.message || "Unable to load voice benchmark state.", { type: "error" });
    }
  } finally {
    state.voiceBenchmark.loading = false;
  }
}

async function runVoiceBenchmark() {
  const benchmark = state.voiceBenchmark;
  const text = String(benchmark.text || "").trim();
  const queue = getVoiceBenchmarkQueue();
  const selectedKeys = [...new Set(queue.map((entry) => entry.modelKey))];
  const slotId = String(benchmark.slotId || "voice-tts-1");
  const slot = getVoiceSlot(slotId);

  if (!text) {
    toast("enter benchmark text first");
    return;
  }
  if (!queue.length) {
    toast("add at least one model to the queue");
    return;
  }
  if (!slot || slot.type !== "tts") {
    toast("select a valid TTS slot");
    return;
  }

  await fetchJson("/api/voice/benchmark/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voiceSlotId: slotId,
      audioFormat: benchmark.audioFormat,
      sampleRate: Number(benchmark.sampleRate) || 24000,
      selectedModelKeys: selectedKeys,
      queue,
      selectedVoices: getVoiceBenchmarkSelectedVoicesPayload(),
      selectedTunings: getVoiceBenchmarkSelectedTuningsPayload(),
    }),
  });
  await refreshVoiceBenchmarkState({ silent: true });
  await refreshOverview();
}

async function cancelVoiceBenchmark() {
  await fetchJson("/api/voice/benchmark/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  await refreshVoiceBenchmarkState({ silent: true });
}

function wireVoiceBenchmarkEvents() {
  els.voiceBenchmarkContent?.addEventListener("input", (event) => {
    const textarea = event.target.closest("#voiceBenchmarkText");
    if (!textarea) {
      return;
    }
    state.voiceBenchmark.text = textarea.value;
    persistVoiceBenchmarkText(textarea.value);
    updateVoiceBenchmarkTextStats(textarea.value);
    textarea.dir = detectVoiceBenchmarkTextDirection(textarea.value);
    autosizeVoiceBenchmarkTextarea(textarea);
  });

  els.voiceBenchmarkContent?.addEventListener("change", (event) => {
    const voiceSelect = event.target.closest("[data-voice-benchmark-voice]");
    if (voiceSelect) {
      updateVoiceBenchmarkModelVoice(voiceSelect.dataset.voiceBenchmarkVoice, voiceSelect.value);
      renderVoiceBenchmark();
      return;
    }

    if (event.target.id === "voiceBenchmarkSlot") {
      state.voiceBenchmark.slotId = event.target.value;
      renderVoiceBenchmark();
      return;
    }
    if (event.target.id === "voiceBenchmarkFormat") {
      state.voiceBenchmark.audioFormat = event.target.value;
      renderVoiceBenchmark();
      return;
    }
    if (event.target.id === "voiceBenchmarkSampleRate") {
      state.voiceBenchmark.sampleRate = Number(event.target.value) || 24000;
      renderVoiceBenchmark();
    }
  });

  els.voiceBenchmarkContent?.addEventListener("click", (event) => {
    const runButton = event.target.closest("[data-voice-benchmark-run]");
    if (runButton) {
      runVoiceBenchmark().catch((error) => toast(error.message || "Voice benchmark failed.", { type: "error" }));
      return;
    }
    const cancelButton = event.target.closest("[data-voice-benchmark-cancel]");
    if (cancelButton) {
      cancelVoiceBenchmark().catch((error) => toast(error.message || "Unable to cancel benchmark.", { type: "error" }));
      return;
    }
    const playButton = event.target.closest("[data-voice-benchmark-play]");
    if (playButton) {
      const audioUrl = String(playButton.dataset.voiceBenchmarkPlay || "");
      if (!audioUrl) {
        return;
      }
      if (!voiceBenchmarkPreviewAudio) {
        voiceBenchmarkPreviewAudio = new Audio();
      }
      if (voiceBenchmarkPreviewUrl === audioUrl && !voiceBenchmarkPreviewAudio.paused) {
        voiceBenchmarkPreviewAudio.pause();
        voiceBenchmarkPreviewUrl = "";
        return;
      }
      voiceBenchmarkPreviewAudio.src = audioUrl;
      voiceBenchmarkPreviewAudio.play().catch(() => {});
      voiceBenchmarkPreviewUrl = audioUrl;
      return;
    }
    const selectButton = event.target.closest("[data-voice-benchmark-select]");
    if (selectButton) {
      const selectLanguage = detectVoiceBenchmarkLanguageCode(state.voiceBenchmark.text || "");
      if (selectButton.dataset.voiceBenchmarkSelect === "none") {
        setVoiceBenchmarkQueue([]);
      } else {
        const additions = getTtsVoiceModels()
          .filter((model) => voiceBenchmarkModelSupportsLanguage(model, selectLanguage))
          .map((model) => ({ modelKey: model.key, voiceName: model.voices?.length ? getVoiceBenchmarkSelectedVoice(model) : "" }));
        setVoiceBenchmarkQueue([...getVoiceBenchmarkQueue(), ...additions]);
      }
      renderVoiceBenchmark();
      return;
    }
    const addButton = event.target.closest("[data-voice-benchmark-add]");
    if (addButton) {
      addVoiceBenchmarkQueueEntry(String(addButton.dataset.voiceBenchmarkAdd || ""));
      renderVoiceBenchmark();
      return;
    }
    const removeButton = event.target.closest("[data-voice-benchmark-remove]");
    if (removeButton) {
      const index = Number(removeButton.dataset.voiceBenchmarkRemove);
      setVoiceBenchmarkQueue(getVoiceBenchmarkQueue().filter((_entry, entryIndex) => entryIndex !== index));
      renderVoiceBenchmark();
      return;
    }
    const tuningButton = event.target.closest("[data-voice-tuning-open]");
    if (tuningButton) {
      openVoiceTuningModal(
        String(tuningButton.dataset.voiceTuningOpen || "benchmark"),
        String(tuningButton.dataset.modelKey || "")
      );
    }
  });
}

// ========== Voice Log Handling ==========

function sortArrow(field) {
  if (state.hf.sort !== field) {
    return "";
  }
  return state.hf.direction === "asc" ? "↑" : "↓";
}

function modelSortArrow(field) {
  if (state.modelSort.field !== field) {
    return "";
  }
  return state.modelSort.direction === "asc" ? "↑" : "↓";
}

function renderModelSlotBadges(model) {
  return getRunningModelSlots(model).map(({ slot, process }) => {
    const footprintLabel = process?.rssBytes ? `~${fmtBytes(process.rssBytes)}` : "";
    const footprintTitle = footprintLabel ? `${slot.label} backend RSS` : `${slot.label} is active`;
    return [
      `<span class="badge badge-live" title="${esc(slot.label)} is active">${esc(slot.shortLabel)} live</span>`,
      footprintLabel
        ? `<span class="badge badge-footprint" title="${esc(footprintTitle)}">${esc(footprintLabel)}</span>`
        : "",
    ].join("");
  }).join("");
}

function getRunningModelSlots(model) {
  return state.slots.flatMap((slot) => {
    const runningHere = slot.status?.running && slot.status?.model?.key === model.key;
    if (!runningHere) {
      return [];
    }
    const process = state.system?.processes?.[slot.id]?.backend || null;
    return [{ slot, process }];
  });
}

function isModelActive(model) {
  return getRunningModelSlots(model).length > 0;
}

function renderLaunchModal() {
  updateVisualViewportVars();
  const modalOpen = state.modal.open;
  const launchModalBody = els.launchModalContent?.closest(".modal-body");
  const previousScrollTop = launchModalBody?.scrollTop ?? 0;
  els.launchModal.classList.toggle("hidden", !modalOpen);
  els.launchModal.setAttribute("aria-hidden", String(!modalOpen));

  if (!modalOpen) {
    els.launchModalContent.innerHTML = "";
    if (els.launchModalHeaderActions) {
      els.launchModalHeaderActions.innerHTML = "";
    }
    return;
  }

  // ========== VOICE MODEL MODE ==========
  if (state.modal.voiceModel) {
    renderVoiceLaunchModal();
    return;
  }

  // ========== LLM MODEL MODE ==========
  const model = getModel(state.modal.modelKey);
  const slot = getSlot(state.modal.slotId) || state.slots[0] || null;
  const form = ensureModalForm();
  const running = Boolean(slot?.status?.running);
  const runningSameModel = Boolean(running && slot?.status?.model?.key === model?.key);
  const liveParams = runningSameModel ? slot.status?.params || {} : null;
  const launcherOptions = getLauncherOptions(model);
  const selectedLauncher = resolvePreferredLauncher(model, form.launcher);
  const defaults = getSlotDefaults(slot, model, selectedLauncher);
  const launchWarning = getLaunchCompatibilityWarning(model, slot);
  const tinyGrammarSupported = supportsTinyGrammar(model);
  const structuredGbnfSupported = supportsStructuredGbnf(model);
  const reasoningBudgetSupported = supportsReasoningBudget(model);
  const mtpDraftSupported = supportsMtpDraftTuning(model);

  if (!model || !slot) {
    els.launchModalContent.innerHTML = `<div class="empty-state compact"><p>No launch targets are available.</p></div>`;
    if (els.launchModalHeaderActions) {
      els.launchModalHeaderActions.innerHTML = "";
    }
    return;
  }

  els.launchModalTitle.textContent = `Launch ${model.label}`;
  els.launchModalSubtitle.textContent = `${model.family || "Unknown family"} · ${model.sizeLabel || "n/a"} · defaults and next-run settings for ${slot.label}`;
  if (els.launchModalHeaderActions) {
    const currentColor = getModelColorValue(model);
    const draftColor = getDraftOrModelColor(model);
    const draftHsv = hexToHsv(draftColor) || { h: 0, s: 1, v: 1 };
    els.launchModalHeaderActions.innerHTML = `
      <div class="model-color-picker ${state.modal.colorPickerOpen ? "open" : ""}">
        <button class="btn model-color-toggle" type="button" data-model-color-toggle style="--model-color:${esc(draftColor)}" title="Choose a color for ${esc(model.label)}" aria-label="Choose a color for ${esc(model.label)}"></button>
        ${state.modal.colorPickerOpen ? `
          <div class="model-color-popover" role="dialog" aria-label="Model color picker">
            <div class="model-color-wheel-layout">
              <div class="model-color-wheel-shell">
                <canvas
                  class="model-color-wheel"
                  data-model-color-wheel
                  width="${MODEL_COLOR_WHEEL_SIZE}"
                  height="${MODEL_COLOR_WHEEL_SIZE}"
                ></canvas>
                <div class="model-color-wheel-thumb" data-model-color-wheel-thumb></div>
              </div>
              <div class="model-color-preview" data-model-color-preview style="--model-color:${esc(draftColor)}"></div>
            </div>
            <label class="field-label model-color-field">
              <span>Brightness</span>
              <input data-model-color-value type="range" min="0" max="100" value="${Math.round(draftHsv.v * 100)}" />
            </label>
            <label class="field-label model-color-field">
              <span>Hex color</span>
              <input data-model-color-draft type="text" spellcheck="false" maxlength="7" value="${esc(state.modal.colorDraft || currentColor)}" placeholder="#22d3ee" />
            </label>
            <div class="model-color-actions">
              <button class="btn btn-secondary btn-sm" type="button" data-model-color-default ${hasCustomModelColor(model) ? "" : "disabled"}>Default</button>
              <button class="btn btn-primary btn-sm" type="button" data-model-color-confirm>Select</button>
            </div>
          </div>
        ` : ""}
      </div>
      <button class="btn btn-secondary btn-sm" type="button" data-modal-save-defaults ${state.actionInFlight ? "disabled" : ""}>Save</button>
      <button class="btn btn-primary btn-sm" type="button" data-modal-launch ${state.actionInFlight ? "disabled" : ""}>Launch ${esc(slot.shortLabel)}</button>
      <button class="btn btn-danger btn-sm" type="button" data-modal-stop-slot ${running && !state.actionInFlight ? "" : "disabled"}>Stop ${esc(slot.shortLabel)}</button>
    `;
  }

  const grammarMode = form.enableStructuredGbnf ? "structured" : (form.enableTinyGrammar ? "tiny" : "off");
  const routedCount = LLM_APPLICATION_FLAGS.filter((flag) => Boolean(form[flag.field])).length;
  const statusText = runningSameModel
    ? "running this model"
    : running
      ? `running ${slot.status?.model?.label || "another model"}`
      : "idle";
  const statusTone = runningSameModel ? "ok" : running ? "warn" : "idle";

  els.launchModalContent.innerHTML = `
    <div class="lc-grid">
      ${launchWarning ? `<div class="lc-span lc-warning"><strong>Compatibility</strong> ${esc(launchWarning)}</div>` : ""}

      <section class="lc-card lc-span lc-card--flat">
        <div class="lc-target">
          <label class="lc-field lc-field--slot">
            <span class="lc-field-label">Slot</span>
            <select data-modal-input="slotId">
              ${state.slots.map((entry) => `
                <option value="${entry.id}" ${entry.id === slot.id ? "selected" : ""}>${esc(entry.label)}</option>
              `).join("")}
            </select>
          </label>
          <label class="lc-field lc-field--launcher">
            <span class="lc-field-label">Launcher</span>
            ${launcherOptions.length > 1
              ? `<select data-modal-input="launcher">${launcherOptions.map((launcher) => `<option value="${esc(launcher)}" ${selectedLauncher === launcher ? "selected" : ""}>${esc(launcherLabel(launcher))}</option>`).join("")}</select>`
              : `<div class="lc-static" title="This model only exposes one launcher.">${esc(launcherLabel(selectedLauncher))}</div>`}
          </label>
          <label class="lc-field lc-field--url">
            <span class="lc-field-label">Model URL</span>
            <input
              data-modal-input="runtimeBaseUrl"
              type="text"
              spellcheck="false"
              value="${esc(form.runtimeBaseUrl)}"
              placeholder="${esc(runtimeEndpoint(slot))}"
            />
          </label>
          <button class="btn btn-secondary btn-sm lc-target-save" type="button" data-modal-save-url ${state.actionInFlight ? "disabled" : ""}>Save URL</button>
        </div>
      </section>

      <div class="lc-col">
      <section class="lc-card">
        <header class="lc-card-head">
          <h4>Runtime</h4>
          <span class="lc-card-note">${esc(runtimeLabel(model.runtime))}</span>
        </header>
        <div class="lc-field-row">
          <label class="lc-field">
            <span class="lc-field-label">Context window</span>
            <input data-modal-input="ctxSize" type="number" min="1" step="1" value="${esc(form.ctxSize)}" />
          </label>
          <label class="lc-field lc-field--narrow">
            <span class="lc-field-label">Parallel</span>
            <input data-modal-input="parallel" type="number" min="1" step="1" value="${esc(form.parallel)}" />
          </label>
        </div>
        <div class="lc-chips" role="group" aria-label="Safe context presets">
          ${["131072", "255000", "262144", "524288", "1048576"].map((preset) => `
            <button
              type="button"
              class="lc-chip ${String(form.ctxSize) === preset ? "is-active" : ""}"
              data-modal-preset="${preset}"
              ${state.actionInFlight ? "disabled" : ""}
            >${presetLabel(preset)}</button>`).join("")}
        </div>
        <div class="lc-rule"></div>
        <div class="lc-control-row">
          <span class="lc-control-label" title="Grammar-constrained decoding. Tiny Grammar constrains CoT for Qwen GGUF models; Structured GBNF uses the note-106 GOAL / APPROACH / EDGE grammar for Qwen 3.6 35B GGUF. They are mutually exclusive.">Grammar</span>
          <div class="lc-seg" role="radiogroup" aria-label="Grammar mode">
            <label class="lc-seg-opt" title="No grammar constraint.">
              <input type="radio" name="lcGrammarMode" data-modal-input="grammarMode" value="off" ${grammarMode === "off" ? "checked" : ""} />
              <span>Off</span>
            </label>
            <label class="lc-seg-opt" title="${tinyGrammarSupported ? "Grammar-constrained CoT for Qwen GGUF models." : "Only available for GGUF models."}">
              <input type="radio" name="lcGrammarMode" data-modal-input="grammarMode" value="tiny" ${grammarMode === "tiny" ? "checked" : ""} ${tinyGrammarSupported ? "" : "disabled"} />
              <span>Tiny</span>
            </label>
            <label class="lc-seg-opt" title="${structuredGbnfSupported ? "note-106 GOAL / APPROACH / EDGE grammar for Qwen 3.6 35B GGUF models." : "Only available for Qwen 3.6 35B GGUF models."}">
              <input type="radio" name="lcGrammarMode" data-modal-input="grammarMode" value="structured" ${grammarMode === "structured" ? "checked" : ""} ${structuredGbnfSupported ? "" : "disabled"} />
              <span>GBNF</span>
            </label>
          </div>
        </div>
        ${supportsTinyGrammar(model) ? `
        <div class="lc-control-row">
          <span class="lc-control-label" title="llama.cpp micro-batch (--ubatch-size). Blank uses the launcher default of 512. Bigger is faster for prompt processing on its own, but a large ubatch is a long Metal command buffer that stalls any OTHER model sharing the GPU: with two slots up, one slot fell from 10.5 to 3.7 tok/s while the other ran a prompt eval. Try 256 or 128 when you run two models at once.">Micro-batch (ubatch)</span>
          <input class="lc-num" data-modal-input="ubatchSize" type="number" min="1" max="8192" step="64" placeholder="512" value="${esc(form.ubatchSize ?? "")}" />
        </div>` : ""}
        ${mtpDraftSupported ? `
        <div class="lc-control-row">
          <span class="lc-control-label" title="Speculative draft tokens per step (spec-draft-n-max). 2 is the measured sweet spot for ~0.5-0.9 acceptance; raise only for highly predictable output.">MTP draft depth</span>
          <input class="lc-num" data-modal-input="mtpDraftMax" type="number" min="1" max="16" step="1" placeholder="2" value="${esc(form.mtpDraftMax ?? "")}" />
        </div>` : ""}
        ${selectedLauncher === "mlx-dspark" ? `
        <div class="lc-control-row">
          <span class="lc-control-label" title="Which speculative head mlx-dspark serves with. Auto uses its registry's measured-best for the target — DFlash 2 for Qwen3.8-27B-8bit, which benchmarked 37.4 tok/s here versus DSpark's 24.3 and 16.4 unspeculated (2026-08-22, 5 distinct prompts x 400 tokens). Pin an explicit head only for A/B work.">Speculation</span>
          <select data-modal-input="dsparkMode">
            ${DSPARK_MODES.map((mode) => `<option value="${esc(mode)}" ${String(form.dsparkMode || "auto") === mode ? "selected" : ""}>${esc(DSPARK_MODE_LABELS[mode] || mode)}</option>`).join("")}
          </select>
        </div>
        <div class="lc-control-row">
          <span class="lc-control-label" title="How long the model is allowed to think before answering. Model default leaves Qwen3.8's own chat template alone, which asks for xhigh — fine for chat, but an agent turn can spend a long time reasoning before emitting any content. Off sends --no-thinking. Lower levels trade answer depth for time-to-first-token.">Reasoning effort</span>
          <select data-modal-input="reasoningEffort">
            ${DSPARK_REASONING_EFFORTS.map((level) => `<option value="${esc(level)}" ${String(form.reasoningEffort ?? "") === level ? "selected" : ""}>${esc(DSPARK_REASONING_LABELS[level] ?? level)}</option>`).join("")}
          </select>
        </div>` : ""}
        ${renderChatTemplateControl(model, form)}
      </section>

      <section class="lc-card">
        <header class="lc-card-head">
          <h4>Routing</h4>
          <span class="lc-card-note">apps pointed at ${esc(slotName(slot))} &middot; ${routedCount} on</span>
        </header>
        ${renderSlotNameField(slot)}
        <div class="lc-machines">
          ${renderApplicationFlagMachineGroups(form)}
        </div>
      </section>
      </div>

      <div class="lc-col">
      <section class="lc-card">
        <header class="lc-card-head">
          <h4>Sampling</h4>
          <span class="lc-pill ${form.thinking ? "is-on" : ""}">Thinking ${model.supportsThinking ? (form.thinking ? "on" : "off") : "n/a"}</span>
          <button class="btn btn-secondary btn-sm lc-head-btn" type="button" data-modal-reset-sampling ${state.actionInFlight ? "disabled" : ""}>Reset</button>
        </header>
        <label class="lc-field">
          <span class="lc-field-label">Preset</span>
          <select data-modal-sampling-preset ${model.supportsThinking ? "" : "disabled"} title="${model.supportsThinking ? "Applies a matched thinking mode + sampling set." : "Model does not support thinking mode."}">
            <option value="nonThinking" ${form.thinking === false ? "selected" : ""}>Non-thinking (Instruct)</option>
            <option value="thinking" ${form.thinking === true && (form.temperature ?? 0.7) >= 0.9 ? "selected" : ""}>Thinking (Standard)</option>
            <option value="thinkingPrecise" ${form.thinking === true && (form.temperature ?? 0.7) < 0.9 ? "selected" : ""}>Thinking (Precise Code)</option>
          </select>
        </label>
        <div class="lc-num-grid">
          <label class="lc-field">
            <span class="lc-field-label">Temperature</span>
            <input data-modal-input="temperature" type="number" min="0" step="0.01" value="${esc(form.temperature)}" />
          </label>
          <label class="lc-field">
            <span class="lc-field-label">Top P</span>
            <input data-modal-input="topP" type="number" min="0" max="1" step="0.01" value="${esc(form.topP)}" />
          </label>
          <label class="lc-field">
            <span class="lc-field-label">Top K</span>
            <input data-modal-input="topK" type="number" min="0" step="1" value="${esc(form.topK)}" />
          </label>
          <label class="lc-field">
            <span class="lc-field-label">Min P</span>
            <input data-modal-input="minP" type="number" min="0" max="1" step="0.01" value="${esc(form.minP)}" />
          </label>
          <label class="lc-field">
            <span class="lc-field-label" title="Thinking mode jumps this to ${PRESENCE_PENALTY_BY_THINKING.enabled.toFixed(1)}; non-thinking to ${PRESENCE_PENALTY_BY_THINKING.disabled.toFixed(1)}.">Presence</span>
            <input data-modal-input="presencePenalty" type="number" step="0.1" value="${esc(form.presencePenalty)}" />
          </label>
          <label class="lc-field">
            <span class="lc-field-label">Repetition</span>
            <input data-modal-input="repetitionPenalty" type="number" min="0.01" step="0.01" value="${esc(form.repetitionPenalty)}" />
          </label>
        </div>
        <div class="lc-rule"></div>
        <div class="lc-control-row">
          <span class="lc-control-label" title="${reasoningBudgetSupported ? "Max reasoning tokens when thinking is on: -1 unlimited, 0 none, e.g. 1024 to stop rumination loops." : "Only available for GGUF models."}">Thinking budget</span>
          <input class="lc-num" data-modal-input="reasoningBudget" type="number" min="-1" step="1" placeholder="-1" value="${esc(form.reasoningBudget ?? "")}" ${reasoningBudgetSupported ? "" : "disabled"} />
        </div>
        <div class="lc-control-row">
          <span class="lc-control-label" title="${reasoningBudgetSupported ? "DRY sampler (multiplier 0.8): suppresses repetition loops with far less quality damage than repetition penalty." : "Only available for GGUF models."}">Anti-repetition (DRY)</span>
          <label class="lc-switch">
            <input data-modal-input="enableDry" type="checkbox" ${reasoningBudgetSupported && form.enableDry ? "checked" : ""} ${reasoningBudgetSupported ? "" : "disabled"} />
            <span class="lc-switch-track"></span>
          </label>
        </div>
      </section>
      </div>

      <div class="lc-span lc-statusbar">
        <span class="lc-stat"><em>Status</em><b class="lc-tone-${statusTone}">${esc(statusText)}</b></span>
        <span class="lc-stat"><em>Live ctx</em><b>${runningSameModel ? fmtCount(liveParams.ctxSize) : "&mdash;"}</b></span>
        <span class="lc-stat"><em>Live parallel</em><b>${runningSameModel ? NumberFmt(liveParams.parallel) : "&mdash;"}</b></span>
        <span class="lc-stat"><em>Saved ctx</em><b>${fmtCount(defaults.contextSize || defaults.ctxSize)}</b></span>
        <span class="lc-stat"><em>Saved parallel</em><b>${NumberFmt(defaults.parallel)}</b></span>
      </div>
    </div>
  `;

  els.launchModalContent.querySelectorAll("[data-modal-preset]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyModalPreset(button.dataset.modalPreset);
    });
  });
  if (launchModalBody) {
    launchModalBody.scrollTop = previousScrollTop;
  }
  queueMicrotask(() => wireModelColorPicker(model));
}

// ========== Voice Launch Modal ==========

function renderVoiceLaunchModal() {
  const model = getVoiceModels().find((m) => m.key === state.modal.voiceModel);
  const slotId = state.modal.voiceSlotId;
  const slots = getVoiceSlots().filter((s) => s.type === (model?.type || "tts"));
  const slot = slots.find((s) => s.id === slotId) || slots[0] || null;
  const isTTS = model?.type === "tts";
  const form = state.modal.form || {};

  if (!model || !slot) {
    els.launchModalContent.innerHTML = `<div class="empty-state compact"><p>No voice launch targets available.</p></div>`;
    if (els.launchModalHeaderActions) {
      els.launchModalHeaderActions.innerHTML = "";
    }
    return;
  }

  els.launchModalTitle.textContent = `Launch ${model.label}`;
  els.launchModalSubtitle.textContent = `${isTTS ? "Text-to-Speech" : "Speech-to-Text"} · ${model.sizeLabel} · ${model.quality}`;

  if (els.launchModalHeaderActions) {
    els.launchModalHeaderActions.innerHTML = `
      <button class="btn btn-secondary btn-sm" type="button" data-modal-save-voice-defaults ${state.actionInFlight ? "disabled" : ""}>Save</button>
      <button class="btn btn-primary btn-sm" type="button" data-modal-launch ${state.actionInFlight ? "disabled" : ""}>Launch ${esc(slot.label)}</button>
      <button class="btn btn-danger btn-sm" type="button" data-modal-stop-slot ${slot.status?.running && !state.actionInFlight ? "" : "disabled"}>Stop ${esc(slot.label)}</button>
    `;
  }

  // Build voice options for this model's type
  const allVoiceSlots = getVoiceSlots().filter((s) => s.type === model.type);
  const formatOptions = isTTS ? ["pcm16", "wav", "mp3", "ogg"] : ["pcm16", "wav"];
  const sampleRateOptions = isTTS ? [22050, 24000, 44100] : [16000];

  els.launchModalContent.innerHTML = `
    <div class="modal-topbar">
      <label class="field-label field-span-full">
        <span>Launch Slot</span>
        <select data-modal-input="voiceSlotId">
          ${allVoiceSlots.map((s) => `
            <option value="${s.id}" ${s.id === slot.id ? "selected" : ""}>${esc(s.label)} (port ${s.publicPort})</option>
          `).join("")}
        </select>
      </label>
    </div>

    <div class="slot-model-summary">
      <div class="slot-model-summary-header">
        <div>
          <h4>${esc(model.label)}</h4>
          <p>${isTTS ? "Text-to-Speech" : "Speech-to-Text"} &middot; ${esc(model.runtime || "n/a")} &middot; ${esc(model.sizeLabel)}</p>
        </div>
        <span class="badge badge-${model.type}">${model.type.toUpperCase()}</span>
      </div>
      <div class="slot-model-summary-grid">
        <div class="detail-row"><span class="detail-label">Runtime</span><span class="detail-value">${esc(model.runtime || "n/a")}</span></div>
        <div class="detail-row"><span class="detail-label">Quality</span><span class="detail-value">${esc(model.quality)}</span></div>
        <div class="detail-row"><span class="detail-label">Languages</span><span class="detail-value">${model.languages?.length || 0}</span></div>
        <div class="detail-row"><span class="detail-label">Latency</span><span class="detail-value">${esc(model.latency)}</span></div>
        <div class="detail-row"><span class="detail-label">Slot</span><span class="detail-value">${esc(slot.label)}</span></div>
        <div class="detail-row"><span class="detail-label">Status</span><span class="detail-value">${slot.status?.running ? "running" : "idle"}</span></div>
      </div>
    </div>

    <div class="launch-controls-row">
      <label class="field-label">
        <span>Audio Format</span>
        <select data-modal-input="audioFormat">
          ${formatOptions.map((f) => `<option value="${f}" ${String(form.audioFormat || (isTTS ? "pcm16" : "pcm16")) === f ? "selected" : ""}>${f}</option>`).join("")}
        </select>
      </label>
      <label class="field-label">
        <span>Sample Rate</span>
        <select data-modal-input="sampleRate">
          ${sampleRateOptions.map((sr) => `<option value="${sr}" ${String(form.sampleRate || (isTTS ? 24000 : 16000)) === String(sr) ? "selected" : ""}>${sr} Hz</option>`).join("")}
        </select>
      </label>
      ${isTTS && model.voices?.length ? `
      <label class="field-label field-span-full">
        <span>Voice</span>
        <select data-modal-input="voiceName">
          ${model.voices.map((v) => `<option value="${esc(v)}" ${form.voiceName === v ? "selected" : ""}>${esc(v)}</option>`).join("")}
        </select>
      </label>
      ` : ""}
    </div>

    ${isTTS ? renderVoiceTtsTuningControls(
      model,
      form,
      (field) => `data-modal-input="${field}"`
    ) : ""}

    <div class="modal-flags">
      <label class="checkbox-label modal-flag">
        <input data-modal-input="setHermes" type="checkbox" ${form.setHermes ? "checked" : ""} />
        <span>Set Hermes ${isTTS ? "TTS" : "STT"}</span>
      </label>
      <label class="checkbox-label modal-flag">
        <input data-modal-input="setHermesM4" type="checkbox" ${form.setHermesM4 ? "checked" : ""} />
        <span>Set Hermes M4 ${isTTS ? "TTS" : "STT"}</span>
      </label>
    </div>
  `;

  // Wire up voice modal events after DOM is updated
  wireVoiceModalEvents();
}

// ========== Voice event handlers for modal inputs ==========

function wireVoiceModalEvents() {
  // Voice slot change
  els.launchModalContent?.querySelector('select[data-modal-input="voiceSlotId"]')?.addEventListener("change", (event) => {
    state.modal.voiceSlotId = event.target.value;
  });

  // Voice format change
  els.launchModalContent?.querySelector('select[data-modal-input="audioFormat"]')?.addEventListener("change", (event) => {
    state.modal.form = { ...state.modal.form, audioFormat: event.target.value };
  });

  // Voice sample rate change
  els.launchModalContent?.querySelector('select[data-modal-input="sampleRate"]')?.addEventListener("change", (event) => {
    state.modal.form = { ...state.modal.form, sampleRate: Number(event.target.value) };
  });

  // Voice name change
  els.launchModalContent?.querySelector('select[data-modal-input="voiceName"]')?.addEventListener("change", (event) => {
    state.modal.form = { ...state.modal.form, voiceName: event.target.value };
  });

  // Voice Hermes checkbox
  els.launchModalContent?.querySelector('input[data-modal-input="setHermes"]')?.addEventListener("change", (event) => {
    state.modal.form = { ...state.modal.form, setHermes: event.target.checked };
  });

  els.launchModalContent?.querySelector('input[data-modal-input="setHermesM4"]')?.addEventListener("change", (event) => {
    state.modal.form = { ...state.modal.form, setHermesM4: event.target.checked };
  });

  // Save voice defaults button
  els.launchModalContent?.querySelector('[data-modal-save-voice-defaults]')?.addEventListener("click", async () => {
    const model = getVoiceModels().find((m) => m.key === state.modal.voiceModel);
    if (!model) { toast("select a model first"); return; }
    const slot = getVoiceSlots().find((s) => s.id === state.modal.voiceSlotId) || null;
    if (!slot) { toast("select a slot first"); return; }
    const form = state.modal.form || {};
    await runAction(
      "/api/voice/defaults",
      {
        voiceSlotId: slot.id,
        modelKey: model.key,
        voiceName: form.voiceName || "",
        audioFormat: form.audioFormat || "pcm16",
        sampleRate: Number(form.sampleRate) || (model.type === "tts" ? 24000 : 16000),
      },
      { preserveModal: true }
    );
  });

  // Launch button (voice mode)
  els.launchModalContent?.querySelector('[data-modal-launch]')?.addEventListener("click", async () => {
    const model = getVoiceModels().find((m) => m.key === state.modal.voiceModel);
    if (!model) { toast("select a model first"); return; }
    const slot = getVoiceSlots().find((s) => s.id === state.modal.voiceSlotId) || null;
    if (!slot) { toast("select a slot first"); return; }
    if (model.type !== slot.type) {
      toast(`Model ${model.label} is ${model.type} but slot ${slot.label} is ${slot.type}`);
      return;
    }
    const form = state.modal.form || {};
    await runAction(
      "/api/voice/start",
      {
        voiceSlotId: slot.id,
        modelKey: model.key,
        voiceName: form.voiceName || "",
        audioFormat: form.audioFormat || "pcm16",
        sampleRate: Number(form.sampleRate) || (model.type === "tts" ? 24000 : 16000),
        setHermes: Boolean(form.setHermes),
        setHermesM4: Boolean(form.setHermesM4),
      },
      { closeModal: true }
    );
  });

  // Stop slot button (voice mode)
  els.launchModalContent?.querySelector('[data-modal-stop-slot]')?.addEventListener("click", async () => {
    const slot = getVoiceSlots().find((s) => s.id === state.modal.voiceSlotId) || null;
    if (!slot) { toast("no slot selected"); return; }
    await runAction("/api/voice/stop", { voiceSlotId: slot.id }, { closeModal: true });
  });
}

function renderStatus() {
  if (!state.slots.length) {
    els.statusContent.innerHTML = `<div class="empty-state"><h3>No slots available</h3><p>The backend did not return any runtime state.</p></div>`;
    return;
  }

  const llmCards = state.slots.map((slot) => renderSlotStatusCard(slot)).join("");
  els.statusContent.innerHTML = `
    <div class="status-split">
      <div class="status-split-left">
        <div class="status-split-label">LLM Runtimes</div>
        <div class="status-stack compact-stack">
          ${llmCards}
        </div>
      </div>
      <div class="status-split-right">
        <div class="status-split-label">Voice Runtimes</div>
        <div class="voice-status-stack">
          ${state.voiceSlots.map((slot) => renderVoiceSlotStatusCard(slot)).join("")}
        </div>
      </div>
    </div>`;
}

function renderSlotStatusCard(slot) {
  const status = slot.status || {};
  const benchmark = slot.benchmark || null;
  const endpoint = runtimeEndpoint(slot);
  const badges = renderIntegrationBadges(slot);
  const crashReason = status.lastCrash?.reason || "";
  const crashDetail = status.lastCrash?.detail || "";

  if (!status.running) {
      return `
      <article class="status-active status-idle status-compact">
        <div class="status-header">
          <div class="status-header-left">
            <div class="slot-heading-icon">${slotIcon(slot)}</div>
            <div>
              <h3>${esc(slot.label)}</h3>
              <span class="status-header-meta">Idle</span>
            </div>
          </div>
          <div class="status-actions">
            <div class="integration-badges">${badges}</div>
          </div>
        </div>
        <div class="empty-state compact">
          <p>Launch a model into ${esc(slot.label)} to see live runtime details.</p>
          <p class="status-idle-note">Launcher details appear here after the slot is running.</p>
          ${crashReason ? `<p class="status-crash-note"><strong>Last crash:</strong> ${esc(crashReason)}${crashDetail ? ` <span>${esc(crashDetail)}</span>` : ""}</p>` : ""}
        </div>
      </article>`;
  }

  const model = status.model || {};
  const params = status.params || {};
  return `
    <article class="status-active status-compact">
      <div class="status-header">
        <div class="status-header-left">
          <div class="status-indicator"></div>
          <div>
            <h3>${slotIcon(slot)} ${esc(slot.label)} &middot; ${esc(model.label || model.key || "Live Runtime")}</h3>
            <span class="status-header-meta">${esc(model.family || "Unknown family")} &middot; ${esc(model.sizeLabel || "n/a")} &middot; <span class="badge badge-runtime">${runtimeLabel(model.runtime)}</span></span>
          </div>
        </div>
        <div class="status-actions status-actions-stacked">
          <div class="integration-badges">${badges}</div>
          <div class="status-button-row">
            <button class="btn btn-sm" data-copy-endpoint="${slot.id}">Copy Endpoint</button>
            <button class="btn btn-secondary btn-sm" data-run-benchmark="${slot.id}" ${benchmark?.status === "running" || state.benchmarkStartInFlight[slot.id] ? "disabled" : ""}>${benchmark?.status === "running" ? "Testing…" : "Run TPS Test"}</button>
            <button class="btn btn-danger btn-sm" data-stop-slot="${slot.id}" ${state.actionInFlight ? "disabled" : ""}>Stop ${esc(slot.shortLabel)}</button>
          </div>
        </div>
      </div>
      <div class="status-grid compact-grid">
        <div class="status-stat"><div class="status-stat-label">Endpoint</div><div class="status-stat-value mono">${esc(endpoint)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Started</div><div class="status-stat-value">${status.startedAt ? new Date(status.startedAt).toLocaleString() : "-"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Launcher</div><div class="status-stat-value">${esc(launcherLabel(model.launcher || model.runtime || "gguf"))}</div></div>
        <div class="status-stat"><div class="status-stat-label">Context</div><div class="status-stat-value mono">${fmtCount(params.ctxSize)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Parallel</div><div class="status-stat-value">${NumberFmt(params.parallel)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Thinking</div><div class="status-stat-value">${params.thinking ? "on" : "off"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Temperature</div><div class="status-stat-value">${Number.isFinite(Number(params.temperature)) ? esc(params.temperature) : "n/a"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Top P</div><div class="status-stat-value">${Number.isFinite(Number(params.topP)) ? esc(params.topP) : "n/a"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Top K</div><div class="status-stat-value">${Number.isFinite(Number(params.topK)) ? esc(params.topK) : "n/a"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Min P</div><div class="status-stat-value">${Number.isFinite(Number(params.minP)) ? esc(params.minP) : "n/a"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Presence</div><div class="status-stat-value">${Number.isFinite(Number(params.presencePenalty)) ? esc(params.presencePenalty) : "n/a"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Repetition</div><div class="status-stat-value">${Number.isFinite(Number(params.repetitionPenalty)) ? esc(params.repetitionPenalty) : "n/a"}</div></div>
        <div class="status-stat"><div class="status-stat-label">Grammar Mode</div><div class="status-stat-value">${grammarModeLabel(params)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Batch</div><div class="status-stat-value">${NumberFmt(params.batchSize)}</div></div>
        <div class="status-stat"><div class="status-stat-label">GPU Layers</div><div class="status-stat-value">${NumberFmt(params.gpuLayers)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Backend Port</div><div class="status-stat-value">${NumberFmt(status.network?.backendPort)}</div></div>
      </div>
      ${renderSlotBenchmarkCard(slot, benchmark)}
    </article>`;
}

function renderSlotBenchmarkCard(slot, benchmark) {
  const starting = Boolean(state.benchmarkStartInFlight[slot.id]);
  if (!benchmark && !starting) {
    return `
      <section class="status-benchmark-card">
        <div class="status-benchmark-header-row">
          <div>
            <h4>Throughput Test</h4>
            <p>Runs the standard llm3 benchmark: ${esc("output the integers 1 through 200, one per line")}.</p>
          </div>
          <span class="status-benchmark-pill idle">Idle</span>
        </div>
      </section>`;
  }

  const statusLabel = starting ? "Starting" : (benchmark?.status || "idle");
  const result = benchmark?.result || null;
  const progress = benchmark?.progress || {};
  const isRunning = starting || benchmark?.status === "running";
  const pillClass = isRunning ? "running" : benchmark?.status === "completed" ? "completed" : benchmark?.status === "failed" ? "failed" : "idle";
  return `
    <section class="status-benchmark-card">
      <div class="status-benchmark-header-row">
        <div>
          <h4>Throughput Test</h4>
          <p>${esc(benchmark?.promptSummary || "Starting standard benchmark…")}</p>
        </div>
        <span class="status-benchmark-pill ${pillClass}">${esc(statusLabel.replace(/^\w/, (match) => match.toUpperCase()))}</span>
      </div>
      <div class="status-benchmark-grid">
        <div class="status-stat"><div class="status-stat-label">Elapsed</div><div class="status-stat-value">${fmtMs(result?.elapsedMs || progress.elapsedMs)}</div></div>
        <div class="status-stat"><div class="status-stat-label">First Token</div><div class="status-stat-value">${fmtMs(result?.firstTokenMs || progress.firstTokenMs)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Output Tokens / s</div><div class="status-stat-value">${fmtRate(result?.completionTokensPerSecond, result?.completionTokensEstimated)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Completion Tokens</div><div class="status-stat-value">${NumberFmt(result?.completionTokens)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Prompt Tokens</div><div class="status-stat-value">${NumberFmt(result?.promptTokens)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Chunks</div><div class="status-stat-value">${NumberFmt(progress.chunkCount)}</div></div>
      </div>
      ${benchmark?.error ? `<p class="status-benchmark-error">${esc(benchmark.error)}</p>` : ""}
      ${result?.outputPreview ? `<p class="status-benchmark-preview"><span>Preview</span>${esc(result.outputPreview)}</p>` : ""}
    </section>`;
}

function renderVoiceSlotStatusCard(slot) {
  const status = slot.status || {};
  const running = status.running;
  const model = status.model || {};
  const modelKey = model.key || "none";
  const modelLabel = model.label || modelKey;

  if (!running) {
    return `
      <article class="status-active status-idle status-compact">
        <div class="status-header">
          <div class="status-header-left">
            <div class="slot-heading-icon">${slot.type === "tts" ? "🎙️" : "🎧"}</div>
            <div>
              <h3>${esc(slot.label)}</h3>
              <span class="status-header-meta">Idle · ${slot.type.toUpperCase()}</span>
            </div>
          </div>
          <div class="status-actions">
            <span class="voice-model-label">No model selected</span>
          </div>
        </div>
        <div class="empty-state compact">
          <p>Launch a voice model into ${esc(slot.label)}.</p>
        </div>
      </article>`;
  }

  const params = status.params || {};
  const runtimeUrl = voiceRuntimeEndpoint(slot);

  return `
    <article class="status-active status-compact">
      <div class="status-header">
        <div class="status-header-left">
          <div class="status-indicator"></div>
          <div>
            <h3>${slot.type === "tts" ? "🎙️" : "🎧"} ${esc(slot.label)} · ${esc(modelLabel)}</h3>
            <span class="status-header-meta">${slot.type.toUpperCase()} · ${esc(model.runtime || "n/a")} · ${esc(model.sizeLabel || "n/a")}</span>
          </div>
        </div>
        <div class="status-actions status-actions-stacked">
          <span class="voice-model-label">${esc(modelKey)}</span>
          <div class="status-button-row">
            <button class="btn btn-sm" data-copy-voice-endpoint="${slot.id}">Copy Endpoint</button>
            <button class="btn btn-danger btn-sm" data-voice-slot-stop="${slot.id}" ${state.actionInFlight ? "disabled" : ""}>Stop ${esc(slot.shortLabel)}</button>
          </div>
        </div>
      </div>
      <div class="status-grid compact-grid">
        <div class="status-stat"><div class="status-stat-label">Endpoint</div><div class="status-stat-value mono">${esc(runtimeUrl)}</div></div>
        <div class="status-stat"><div class="status-stat-label">Started</div><div class="status-stat-value">${status.startedAt ? new Date(status.startedAt).toLocaleString() : "-"}</div></div>
        ${slot.type === "tts" ? `
        <div class="status-stat"><div class="status-stat-label">Audio Format</div><div class="status-stat-value">${esc(params.audioFormat || "pcm16")}</div></div>
        <div class="status-stat"><div class="status-stat-label">Sample Rate</div><div class="status-stat-value">${NumberFmt(params.sampleRate || 24000)} Hz</div></div>
        <div class="status-stat"><div class="status-stat-label">Voice</div><div class="status-stat-value">${esc(params.voiceName || "n/a")}</div></div>` : `
        <div class="status-stat"><div class="status-stat-label">Audio Format</div><div class="status-stat-value">${esc(params.audioFormat || "pcm16")}</div></div>
        <div class="status-stat"><div class="status-stat-label">Sample Rate</div><div class="status-stat-value">${NumberFmt(params.sampleRate || 16000)} Hz</div></div>
        <div class="status-stat"><div class="status-stat-label">Language</div><div class="status-stat-value">${esc(params.language || "auto")}</div></div>`}
      </div>
    </article>`;
}

function applicationBadgeClassName(applicationKey) {
  return (
    applicationKey === "claudecode" ? " alt" :
    applicationKey === "librechat" ? " chat" :
    applicationKey === "remotejsonapp" ? " remotejsonapp" :
    ""
  );
}

function renderApplicationBadges(activeApplications, definitions = APPLICATION_DEFINITIONS) {
  const badges = [];
  definitions.forEach((application) => {
    if (!activeApplications?.[application.key]) {
      return;
    }
    badges.push(`<span class="slot-target-badge active${applicationBadgeClassName(application.key)}">${esc(application.badgeLabel)}</span>`);
  });
  return badges.join("");
}

function renderIntegrationBadges(slot) {
  return renderApplicationBadges(slot?.applicationTargets || {}, APPLICATION_DEFINITIONS);
}

function renderVoiceIntegrationBadges(slot) {
  return renderApplicationBadges(slot?.applicationTargets || {}, VOICE_APPLICATION_DEFINITIONS);
}

// Where the used figure actually goes.
//
// The slot cards in the Models tab show each backend's RSS, and those never add
// up to this badge. That is not an arithmetic slip: llama.cpp gives the GPU
// buffers over its own memory with StorageModeShared, the kernel wires those
// pages, and macOS attributes wired memory to no process at all. Measured with
// one inference request on a loaded slot: wired moved 31.3 -> 33.9 -> 32.5 GB
// while the slot's RSS sat at 26.5 GB and never twitched. Reading a 3.9 GB slot
// card next to a 97 percent badge looked like tens of gigabytes had gone
// missing, so spell the decomposition out rather than leave it to be inferred.
function buildRamAttributionTitle(memory, cachedBytes) {
  const a = memory?.attribution || null;
  const lines = ["Used = wired + app memory + compressed."];
  if (a) {
    lines.push("");
    lines.push(`  wired (GPU / kernel)   ${fmtBytes(a.wiredBytes)}`);
    lines.push(`  app memory             ${fmtBytes(a.appMemoryBytes)}`);
    lines.push(`  compressed             ${fmtBytes(a.compressedBytes)}`);
    lines.push(`  = used                 ${fmtBytes(memory?.usedBytes)}`);
    lines.push("");
    const slotCount = Array.isArray(a.slots) ? a.slots.length : 0;
    lines.push(
      `Model slots hold ${fmtBytes(a.modelResidentBytes)} resident`
      + `${slotCount ? ` across ${slotCount} running backend${slotCount === 1 ? "" : "s"}` : ""}.`
    );
    if (a.note) {
      lines.push(a.note);
    }
  }
  if (cachedBytes > 0) {
    lines.push("");
    lines.push(
      `${fmtBytes(cachedBytes)} of cached file pages (mmapped model weights and recently read`
      + " files) is reclaimable and is not counted."
    );
  }
  lines.push(`Kernel memory pressure: ${memory?.pressureLabel || "unknown"}.`);
  return lines.join("\n");
}

function renderSystem() {
  const system = state.system;
  if (!system) {
    return;
  }

  // "Used" is wired + app memory + compressed, the way Activity Monitor counts
  // it. Clean file-backed pages are NOT used memory: a model runtime mmaps its
  // weights, so a loaded 42 GB pack sits in the cache and is handed back on
  // demand. Counting it read 50.6 percent on a machine that was 11 percent
  // occupied. The cache is shown next to the figure instead of inside it.
  const ramPercent = system.memory?.usedPercent || 0;
  const cachedBytes = Number(system.memory?.cachedFilesBytes || 0);
  els.ramPct.textContent = `${ramPercent}%`;
  els.ramBar.style.width = `${Math.min(ramPercent, 100)}%`;
  els.ramBar.className = metricFillClass(ramPercent);
  els.ramDetail.textContent = cachedBytes > 0
    ? `${fmtBytes(system.memory?.usedBytes)} / ${fmtBytes(system.memory?.totalBytes)} used · ${fmtBytes(cachedBytes)} cached files`
    : `${fmtBytes(system.memory?.usedBytes)} / ${fmtBytes(system.memory?.totalBytes)} used`;
  els.ramDetail.title = buildRamAttributionTitle(system.memory, cachedBytes);

  const cpuPercent = system.cpu?.overallPercent || 0;
  els.cpuPct.textContent = `${cpuPercent}%`;
  els.cpuBar.style.width = `${Math.min(cpuPercent, 100)}%`;
  els.cpuBar.className = metricFillClass(cpuPercent);
  els.cpuDetail.textContent = `${NumberFmt(system.cpu?.performanceCores)} perf · ${NumberFmt(system.cpu?.logicalCores)} logical cores`;

  if (system.gpu?.available) {
    const gpuPercent = system.gpu.percent ?? 0;
    els.gpuPct.textContent = `${gpuPercent}%`;
    els.gpuBar.style.width = `${Math.min(gpuPercent, 100)}%`;
    els.gpuBar.className = metricFillClass(gpuPercent, { preferOrange: true });
    els.gpuDetail.textContent = `${fmtBytes(system.gpu.activeBytes || 0)} active · ${esc(system.gpu.note || "")}`;
  } else {
    els.gpuPct.textContent = "--";
    els.gpuBar.style.width = "0%";
    els.gpuBar.className = "progress-fill muted";
    els.gpuDetail.textContent = system.gpu?.note || "Waiting for Metal telemetry...";
  }

  if (system.disk) {
    const diskUsedPercent = Number(system.disk.usedPercent || 0);
    els.diskPct.textContent = fmtCompactBytes(system.disk.availableBytes);
    els.diskPct.title = `${fmtBytes(system.disk.availableBytes)} free of ${fmtBytes(system.disk.totalBytes)} total`;
    els.diskBar.style.width = `${Math.min(diskUsedPercent, 100)}%`;
    els.diskBar.className = metricFillClass(diskUsedPercent);
    els.diskDetail.textContent = `${fmtBytes(system.disk.availableBytes)} free · ${diskUsedPercent}% used of ${fmtBytes(system.disk.totalBytes)}`;
  } else {
    els.diskPct.textContent = "--";
    els.diskPct.title = "";
    els.diskBar.style.width = "0%";
    els.diskBar.className = "progress-fill muted";
    els.diskDetail.textContent = "Disk telemetry unavailable.";
  }

  const uptimeSec = Math.floor(system.cpu?.uptime || 0);
  if (uptimeSec > 0) {
    els.uptimeValue.textContent = formatUptime(uptimeSec, { compact: true });
    els.uptimeValue.title = formatUptime(uptimeSec);
    els.uptimeBar.style.width = "100%";
    els.uptimeBar.className = "progress-fill";
    const bootedAt = system.cpu?.bootedAt ? formatTimestamp(system.cpu.bootedAt) : "";
    els.uptimeDetail.textContent = bootedAt ? `${formatUptime(uptimeSec)} · booted ${bootedAt}` : formatUptime(uptimeSec);
  } else {
    els.uptimeValue.textContent = "--";
    els.uptimeValue.title = "";
    els.uptimeBar.style.width = "0%";
    els.uptimeBar.className = "progress-fill muted";
    els.uptimeDetail.textContent = "Uptime unavailable.";
  }

  const processes = system.processes || {};
  els.processGrid.innerHTML = state.slots.map((slot) => {
    const slotProcesses = processes[slot.id] || {};
    return `
      <div class="process-slot-group">
        <div class="process-slot-header">${slotIcon(slot)} ${esc(slot.label)}</div>
        <div class="process-slot-grid">
          ${slotProcesses.backend ? procCard("Model Process", slotProcesses.backend) : procEmptyCard("Model Process")}
          ${slotProcesses.proxy ? procCard("Proxy Process", slotProcesses.proxy) : procEmptyCard("Proxy Process")}
        </div>
      </div>`;
  }).join("");
}

function renderTopbarMetrics() {
  const system = state.system;
  if (!system) {
    els.topbarRamPct.textContent = "--%";
    els.topbarCpuPct.textContent = "--%";
    els.topbarGpuPct.textContent = "--";
    els.topbarDiskPct.textContent = "--";
    els.topbarUptime.textContent = "--";
    els.topbarRamBar.className = "progress-fill muted";
    els.topbarCpuBar.className = "progress-fill muted";
    els.topbarGpuBar.className = "progress-fill muted";
    els.topbarDiskBar.className = "progress-fill muted";
    els.topbarRamBar.style.width = "0%";
    els.topbarCpuBar.style.width = "0%";
    els.topbarGpuBar.style.width = "0%";
    els.topbarDiskBar.style.width = "0%";
    return;
  }

  const ramPercent = Number(system.memory?.usedPercent || 0);
  els.topbarRamPct.textContent = `${ramPercent}%`;
  els.topbarRamBar.style.width = `${Math.min(ramPercent, 100)}%`;
  els.topbarRamBar.className = metricFillClass(ramPercent);

  const cpuPercent = Number(system.cpu?.overallPercent || 0);
  els.topbarCpuPct.textContent = `${cpuPercent}%`;
  els.topbarCpuBar.style.width = `${Math.min(cpuPercent, 100)}%`;
  els.topbarCpuBar.className = metricFillClass(cpuPercent);

  if (system.gpu?.available) {
    const gpuPercent = Number(system.gpu.percent ?? 0);
    els.topbarGpuPct.textContent = `${gpuPercent}%`;
    els.topbarGpuBar.style.width = `${Math.min(gpuPercent, 100)}%`;
    els.topbarGpuBar.className = metricFillClass(gpuPercent, { preferOrange: true });
  } else {
    els.topbarGpuPct.textContent = "--";
    els.topbarGpuBar.style.width = "0%";
    els.topbarGpuBar.className = "progress-fill muted";
  }

  if (system.disk) {
    const diskUsedPercent = Number(system.disk.usedPercent || 0);
    els.topbarDiskPct.textContent = `${fmtCompactBytes(system.disk.usedBytes)} / ${fmtCompactBytes(system.disk.totalBytes)}`;
    els.topbarDiskPct.title = `${fmtBytes(system.disk.usedBytes)} used · ${fmtBytes(system.disk.availableBytes)} free of ${fmtBytes(system.disk.totalBytes)} total`;
    els.topbarDiskBar.style.width = `${Math.min(diskUsedPercent, 100)}%`;
    els.topbarDiskBar.className = metricFillClass(diskUsedPercent);
  } else {
    els.topbarDiskPct.textContent = "--";
    els.topbarDiskPct.title = "";
    els.topbarDiskBar.style.width = "0%";
    els.topbarDiskBar.className = "progress-fill muted";
  }

  const uptimeSec = Math.floor(system.cpu?.uptime || 0);
  if (uptimeSec > 0) {
    els.topbarUptime.textContent = formatUptime(uptimeSec, { compact: true });
    els.topbarUptime.title = formatUptime(uptimeSec);
  } else {
    els.topbarUptime.textContent = "--";
    els.topbarUptime.title = "";
  }
}

function renderHermesIndicators() {
  renderTopbarBusyIndicators();
  applyHermesIndicator(els.hermesRemoteIndicator, state.hermesStatus.remote, {
    fallbackLabel: "Hermes Agent",
    fallbackHost: ".155",
    runtime: "remote",
  });
  applyHermesIndicator(els.hermesRemoteIndicatorMobile, state.hermesStatus.remote, {
    fallbackLabel: "Hermes Agent",
    fallbackHost: ".155",
    runtime: "remote",
  });
  applyHermesIndicator(els.hermesRemoteIndicatorFloating, state.hermesStatus.remote, {
    fallbackLabel: "Hermes Agent",
    fallbackHost: ".155",
    runtime: "remote",
  });
  applyHermesIndicator(els.hermesLocalIndicator, state.hermesStatus.local, {
    fallbackLabel: "Hermes M4",
    fallbackHost: "local",
    runtime: "local",
  });
  applyHermesIndicator(els.hermesLocalIndicatorMobile, state.hermesStatus.local, {
    fallbackLabel: "Hermes M4",
    fallbackHost: "local",
    runtime: "local",
  });
  applyHermesIndicator(els.hermesLocalIndicatorFloating, state.hermesStatus.local, {
    fallbackLabel: "Hermes M4",
    fallbackHost: "local",
    runtime: "local",
  });
}

function hasTopbarBusyActivity() {
  const activeHfJobs = (state.hf.downloads || []).some((job) => !["completed", "failed", "cancelled"].includes(String(job?.status || "").toLowerCase()));
  const benchmarkStarting = Object.values(state.benchmarkStartInFlight || {}).some(Boolean);
  const voiceLibraryBusy = Boolean(state.voiceTuningModal?.voiceLibrary?.loading || state.voiceTuningModal?.voiceLibrary?.busy);
  return Boolean(
    state.actionInFlight ||
    activeHfJobs ||
    benchmarkStarting ||
    state.hf.loading ||
    state.diagnostics.loading ||
    state.hermesStatus.loading ||
    state.hermesFeedModal.loading ||
    state.launchersModal.loading ||
    state.voiceBenchmark.loading ||
    voiceLibraryBusy
  );
}

function topbarBusyTitle() {
  if (state.actionInFlight) return "Background activity: applying a model action";
  if ((state.hf.downloads || []).some((job) => !["completed", "failed", "cancelled"].includes(String(job?.status || "").toLowerCase()))) {
    return "Background activity: downloads or conversions in progress";
  }
  if (Object.values(state.benchmarkStartInFlight || {}).some(Boolean)) return "Background activity: starting benchmark";
  if (state.voiceBenchmark.loading) return "Background activity: preparing voice benchmark";
  if (state.voiceTuningModal?.voiceLibrary?.loading || state.voiceTuningModal?.voiceLibrary?.busy) return "Background activity: updating voice library";
  if (state.hf.loading) return "Background activity: searching Hugging Face";
  if (state.diagnostics.loading) return "Background activity: refreshing diagnostics";
  if (state.hermesStatus.loading || state.hermesFeedModal.loading) return "Background activity: refreshing Hermes status";
  if (state.launchersModal.loading) return "Background activity: loading launchers";
  return "Background activity in progress";
}

function renderTopbarBusyIndicators() {
  const visible = hasTopbarBusyActivity();
  const title = topbarBusyTitle();
  [
    els.topbarBusyIndicator,
    els.topbarBusyIndicatorMobile,
    els.topbarBusyIndicatorFloating,
  ].forEach((element) => {
    if (!element) {
      return;
    }
    element.hidden = !visible;
    element.setAttribute("title", title);
    element.setAttribute("aria-label", title);
  });
}

function applyHermesIndicator(element, payload, options = {}) {
  if (!element) {
    return;
  }
  const status = payload || {
    state: "offline",
    tooltip: `${options.fallbackLabel || "Hermes"} (${options.fallbackHost || ""})\nStatus: offline`,
  };
  element.classList.remove("offline", "online", "working");
  element.classList.add(status.state || "offline");
  const detail = String(status.detail || "").trim();
  const title = String(status.tooltip || "").trim()
    || `${options.fallbackLabel || "Hermes"} (${options.fallbackHost || ""})\nStatus: ${status.state || "offline"}`;
  element.title = title;
  element.setAttribute("aria-label", detail || title);
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  if (options.runtime) {
    element.dataset.hermesRuntime = options.runtime;
  }
}

function metricFillClass(percent, options = {}) {
  const value = Number(percent || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "progress-fill muted";
  }
  if (options.preferOrange) {
    return "progress-fill orange";
  }
  return "progress-fill" + (value > 85 ? " orange" : value > 60 ? " green" : "");
}

function procCard(title, process) {
  return `
    <div class="process-card">
      <h4>${esc(title)}</h4>
      <dl class="process-stats">
        <div class="process-stat"><dt>PID</dt><dd>${NumberFmt(process.pid)}</dd></div>
        <div class="process-stat"><dt>CPU</dt><dd>${NumberFmt(process.cpuPercent)}%</dd></div>
        <div class="process-stat"><dt>Mem</dt><dd>${NumberFmt(process.memPercent)}%</dd></div>
        <div class="process-stat"><dt>RSS</dt><dd>${fmtBytes(process.rssBytes)}</dd></div>
        <div class="process-stat full"><dt>Uptime</dt><dd>${esc(process.elapsed || "n/a")}</dd></div>
      </dl>
    </div>`;
}

function procEmptyCard(title) {
  return `<div class="process-card"><h4>${esc(title)}</h4><p class="process-empty">Not running</p></div>`;
}

function renderLogTabs() {
  const slotAgnostic = state.activeLogKind === "llm3";
  els.logSlotTabs.classList.toggle("inactive", slotAgnostic);
  els.logSlotTabs.title = slotAgnostic ? "The llm3 log is not per slot." : "";
  els.logSlotTabs.innerHTML = state.slots.map((slot) => `
    <button class="log-tab ${state.activeLogSlotId === slot.id ? "active" : ""}" data-log-slot="${slot.id}">
      ${slotIcon(slot)} ${esc(slotName(slot))}
    </button>`).join("");

  const kinds = [
    { key: "thinking", label: "Thinking" },
    { key: "proxy", label: "Proxy" },
    { key: "traffic", label: "Traffic" },
    { key: "server", label: "Server" },
    // llm3's own log is one file for the whole dashboard, so the slot tabs above
    // do not apply to it. renderLogTabs dims them while this kind is selected.
    { key: "llm3", label: "llm3" },
  ];
  els.logKindTabs.innerHTML = kinds.map((kind) => `
    <button class="log-tab ${state.activeLogKind === kind.key ? "active" : ""}" data-log-kind="${kind.key}">
      ${esc(kind.label)}
    </button>`).join("");
}

function formatLogTimestampLocal(rawTimestamp) {
  const date = new Date(rawTimestamp);
  if (Number.isNaN(date.getTime())) {
    return rawTimestamp;
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function formatLogTimestampsLocal(text) {
  return String(text || "").replace(
    /^(\[?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(\]?)/gm,
    (_match, open, stamp, close) => `${open}${formatLogTimestampLocal(stamp)}${close}`
  );
}

function renderLogs() {
  const slotId = state.activeLogSlotId;
  const trafficState = ensureLogState(slotId, "traffic");
  const serverState = ensureLogState(slotId, "server");
  const proxyState = ensureLogState(slotId, "proxy");
  const thinkingState = ensureLogState(slotId, "thinking");
  const llm3State = ensureLogState(slotId, "llm3");
  const slot = getSlot(slotId);
  const prefix = slot ? `${slot.label} · ` : "";
  const activeLogElement = getActiveLogElement();
  const activeLogScroll = getScrollSnapshot(activeLogElement);
  const thinkingLineCount = thinkingState.text
    ? thinkingState.text.split(/\r?\n/).filter((line) => line.length > 0).length
    : 0;

  els.thinkingPanel.classList.toggle("active", state.activeLogKind === "thinking");
  els.trafficPanel.classList.toggle("active", state.activeLogKind === "traffic");
  els.serverPanel.classList.toggle("active", state.activeLogKind === "server");
  els.proxyPanel.classList.toggle("active", state.activeLogKind === "proxy");
  els.llm3Panel.classList.toggle("active", state.activeLogKind === "llm3");

  els.thinkingStatus.textContent = thinkingState.text
    ? `${prefix}${state.logsPaused ? "paused" : "live"} · ${thinkingLineCount} lines`
    : `${prefix}${state.logsPaused ? "paused" : "waiting"}`;
  els.trafficStatus.textContent = trafficState.entries.length
    ? `${prefix}${state.logsPaused ? "paused" : "live"} · ${trafficState.entries.length} entries`
    : `${prefix}${state.logsPaused ? "paused" : "waiting"}`;
  els.serverStatus.textContent = serverState.text
    ? `${prefix}${state.logsPaused ? "paused" : "live"} · ${serverState.text.split("\n").length} lines`
    : `${prefix}${state.logsPaused ? "paused" : "waiting"}`;
  els.proxyStatus.textContent = proxyState.text
    ? `${prefix}${state.logsPaused ? "paused" : "live"} · ${proxyState.text.split("\n").length} lines`
    : `${prefix}${state.logsPaused ? "paused" : "waiting"}`;
  // No slot prefix: this log covers the whole dashboard, not the selected slot.
  els.llm3Status.textContent = llm3State.text
    ? `llm3 server · ${state.logsPaused ? "paused" : "live"} · ${llm3State.text.split("\n").length} lines`
    : `llm3 server · ${state.logsPaused ? "paused" : "waiting"}`;

  const trafficHtml = trafficState.entries.length
    ? trafficState.entries.map((entry) => `
        <div class="traffic-entry">
          <div class="traffic-head">
            <span class="traffic-method">${esc(entry.method || "LOG")}</span>
            <span class="traffic-path">${esc(entry.path || "")}</span>
            <span class="traffic-status">${entry.status ?? "-"}</span>
            <span class="traffic-ms">${entry.durationMs ?? "-"} ms</span>
          </div>
          <div class="traffic-body">
            <div><p>Request</p><pre>${esc(entry.request || "")}</pre></div>
            <div><p>Response</p><pre>${esc(entry.response || "")}</pre></div>
          </div>
        </div>`).join("")
    : `<div class="empty-state compact"><p>No traffic yet for ${esc(slot?.label || "this slot")}.</p></div>`;
  // Rebuilt every 2.5s by the log poller; a string compare is far cheaper than
  // re-creating hundreds of <pre> nodes when no entry arrived.
  if (els.trafficLog.dataset.renderedHtml !== trafficHtml) {
    els.trafficLog.innerHTML = trafficHtml;
    els.trafficLog.dataset.renderedHtml = trafficHtml;
  }

  els.thinkingLog.textContent = thinkingState.text
    ? formatLogTimestampsLocal(thinkingState.text)
    : `Waiting for thinking stream for ${slot?.label || "this slot"}...`;
  els.serverLog.textContent = serverState.text || `Waiting for server log for ${slot?.label || "this slot"}...`;
  els.proxyLog.textContent = proxyState.text
    ? formatLogTimestampsLocal(proxyState.text)
    : `Waiting for proxy log for ${slot?.label || "this slot"}...`;
  els.llm3Log.textContent = llm3State.text
    ? formatLogTimestampsLocal(llm3State.text)
    : "Waiting for the llm3 server log...";

  autoScroll(activeLogElement, activeLogScroll);
}

function renderDiagnostics() {
  if (!els.diagnosticsFeed || !els.diagnosticsStatus) {
    return;
  }

  const diagnostics = state.diagnostics || {};
  const entries = diagnostics.entries || [];
  const updatedAt = diagnostics.updatedAt
    ? `updated ${new Date(diagnostics.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
    : "waiting";

  if (diagnostics.error) {
    els.diagnosticsStatus.textContent = diagnostics.error;
    els.diagnosticsFeed.innerHTML = `<div class="empty-state compact"><p>${esc(diagnostics.error)}</p></div>`;
    return;
  }

  els.diagnosticsStatus.textContent = entries.length
    ? `${entries.length} curated entries · ${updatedAt}`
    : diagnostics.loading
      ? "Loading diagnostics..."
      : `No matching diagnostics yet · ${updatedAt}`;

  if (!entries.length) {
    els.diagnosticsFeed.innerHTML = diagnostics.loading
      ? `<div class="empty-state compact"><p>Loading diagnostics...</p></div>`
      : `<div class="empty-state compact"><p>No curated diagnostics matched the current Hermes logs, session anomalies, or runtime errors.</p></div>`;
    return;
  }

  els.diagnosticsFeed.innerHTML = entries.map((entry) => `
    <article class="diagnostic-entry ${esc(entry.severity || "info")}">
      <div class="diagnostic-entry-header">
        <span class="diagnostic-timestamp">${esc(entry.timestamp || "Unknown time")}</span>
        <span class="diagnostic-source">${esc(entry.source || "Runtime")}</span>
        <span class="diagnostic-severity ${esc(entry.severity || "info")}">${esc(entry.severity || "info")}</span>
        ${Number(entry.occurrences || 0) > 1 ? `<span class="diagnostic-occurrences">x${Number(entry.occurrences)}</span>` : ""}
      </div>
      <div class="diagnostic-summary">${esc(entry.summary || "")}</div>
      ${entry.details ? `<pre class="diagnostic-details">${esc(entry.details)}</pre>` : ""}
    </article>
  `).join("");
}

function openHermesFeedModal(runtime) {
  const normalized = runtime === "remote" ? "remote" : "local";
  const status = state.hermesStatus?.[normalized] || null;
  state.hermesFeedModal.open = true;
  state.hermesFeedModal.runtime = normalized;
  state.hermesFeedModal.label = String(status?.label || (normalized === "remote" ? "Hermes Agent" : "Hermes M4"));
  state.hermesFeedModal.hostLabel = String(status?.hostLabel || (normalized === "remote" ? ".155" : "local"));
  state.hermesFeedModal.state = String(status?.state || "offline");
  state.hermesFeedModal.online = Boolean(status?.online);
  state.hermesFeedModal.working = Boolean(status?.working);
  state.hermesFeedModal.serviceState = String(status?.serviceState || "");
  state.hermesFeedModal.sessionId = String(status?.sessionId || "");
  state.hermesFeedModal.updatedAt = String(status?.updatedAt || "");
  state.hermesFeedModal.entries = [];
  state.hermesFeedModal.error = "";
  renderHermesFeedModal();
  void refreshHermesFeed();
}

function closeHermesFeedModal() {
  state.hermesFeedModal.open = false;
  state.hermesFeedModal.runtime = "";
  state.hermesFeedModal.entries = [];
  state.hermesFeedModal.error = "";
  state.hermesFeedModal.loading = false;
  renderHermesFeedModal();
}

function renderHermesFeedModal() {
  if (!els.hermesFeedModal || !els.hermesFeedModalContent) {
    return;
  }

  const open = state.hermesFeedModal.open;
  els.hermesFeedModal.classList.toggle("hidden", !open);
  els.hermesFeedModal.setAttribute("aria-hidden", String(!open));
  if (!open) {
    els.hermesFeedModalContent.innerHTML = "";
    return;
  }

  const previousFeedList = getHermesFeedScrollElement();
  const previous = previousFeedList
    ? {
        scrollTop: previousFeedList.scrollTop,
        nearBottom: (previousFeedList.scrollHeight - previousFeedList.scrollTop - previousFeedList.clientHeight) < 64,
      }
    : { scrollTop: 0, nearBottom: true };
  const feed = state.hermesFeedModal;
  const statusLabel = feed.working ? "working" : feed.online ? "online" : "offline";
  const visibleEntries = getVisibleHermesFeedEntries(feed.entries);
  const hasReasoning = visibleEntries.some((entry) => String(entry?.kind || "") === "thinking");
  const subtitleBits = [
    feed.hostLabel ? `${feed.label} · ${feed.hostLabel}` : feed.label,
    `${statusLabel}${feed.serviceState ? ` [${feed.serviceState}]` : ""}`,
  ];
  els.hermesFeedModalTitle.textContent = `${feed.label} Trace`;
  els.hermesFeedModalSubtitle.textContent = subtitleBits.filter(Boolean).join(" · ");
  if (els.hermesFeedAutoScrollInput) {
    els.hermesFeedAutoScrollInput.checked = Boolean(feed.autoScroll);
  }

  const entriesHtml = visibleEntries.length
    ? visibleEntries.map((entry) => {
        const detailClass = shouldRenderHermesFeedMono(entry)
          ? "hermes-feed-detail mono"
          : "hermes-feed-detail";
        return `
          <article class="hermes-feed-entry">
            <div class="hermes-feed-entry-head">
              <span class="hermes-feed-kind ${esc(String(entry.kind || "log"))}">${esc(String(entry.kindLabel || entry.kind || "log"))}</span>
              <span class="hermes-feed-title">${esc(String(entry.title || "Activity"))}</span>
              <span class="hermes-feed-meta">
                ${entry.stepLabel ? `<span>${esc(String(entry.stepLabel))}</span>` : ""}
                ${entry.timestampLabel ? `<span>${esc(String(entry.timestampLabel))}</span>` : ""}
              </span>
            </div>
            <pre class="${detailClass}">${esc(String(entry.detail || ""))}</pre>
          </article>
        `;
      }).join("")
    : `<div class="hermes-feed-empty">${feed.loading ? "Loading Hermes trace..." : "No Hermes reasoning or tool trace is available yet."}</div>`;

  const summaryText = feed.error
    || (hasReasoning
      ? "Showing persisted Hermes reasoning plus tool execution for the active session."
      : "This session is not currently persisting Hermes reasoning text. Showing tool execution and runtime activity instead.");

  els.hermesFeedModalContent.innerHTML = `
    <div class="hermes-feed-shell">
      <div class="hermes-feed-summary">
        <div class="hermes-feed-card">
          <h4>Live Trace</h4>
          <p>${esc(summaryText)}</p>
        </div>
        <div class="hermes-feed-card">
          <dl class="hermes-feed-stats">
            <div class="hermes-feed-stat"><dt>Status</dt><dd>${esc(statusLabel)}</dd></div>
            <div class="hermes-feed-stat"><dt>Entries</dt><dd>${NumberFmt(visibleEntries.length)}</dd></div>
            <div class="hermes-feed-stat"><dt>Session</dt><dd>${esc(feed.sessionId || "n/a")}</dd></div>
            <div class="hermes-feed-stat"><dt>Updated</dt><dd>${esc(feed.updatedAt ? formatTimestamp(feed.updatedAt) : "n/a")}</dd></div>
          </dl>
        </div>
      </div>
      <div class="hermes-feed-status">${feed.loading ? "Refreshing..." : feed.error ? esc(feed.error) : hasReasoning ? `${NumberFmt(visibleEntries.length)} reasoning and tool entries` : `${NumberFmt(visibleEntries.length)} tool and runtime entries`}</div>
      <div class="hermes-feed-list">${entriesHtml}</div>
    </div>
  `;

  const feedList = els.hermesFeedModalContent.querySelector(".hermes-feed-list");
  if (feed.autoScroll) {
    queueMicrotask(() => autoScrollElement(feedList, true));
  } else if (feedList) {
    feedList.scrollTop = previous.scrollTop;
  } else if (previous.nearBottom) {
    queueMicrotask(() => autoScrollElement(feedList, true));
  }
}

function getVisibleHermesFeedEntries(entries) {
  const source = Array.isArray(entries) ? entries : [];
  const withoutUser = source.filter((entry) => String(entry?.kind || "") !== "user");
  const reasoningEntries = withoutUser.filter((entry) => String(entry?.kind || "") === "thinking" && String(entry?.detail || "").trim());
  if (reasoningEntries.length) {
    return withoutUser.filter((entry) => {
      const kind = String(entry?.kind || "");
      return kind === "thinking" || kind === "tool_call" || kind === "tool_output" || kind === "log";
    });
  }
  return withoutUser.filter((entry) => {
    const kind = String(entry?.kind || "");
    return kind === "tool_call" || kind === "tool_output" || kind === "log";
  });
}

function getHermesFeedScrollElement() {
  return els.hermesFeedModalContent?.querySelector(".hermes-feed-list") || null;
}

function shouldRenderHermesFeedMono(entry) {
  const kind = String(entry?.kind || "");
  const detail = String(entry?.detail || "");
  return kind.includes("tool") || kind === "log" || /\n|^\s*[\[{]/.test(detail);
}

function renderActionResultModal() {
  const modal = state.actionResultModal;
  const open = Boolean(modal?.open);
  els.actionResultModal?.classList.toggle("hidden", !open);
  els.actionResultModal?.setAttribute("aria-hidden", String(!open));

  if (!open) {
    if (els.actionResultModalContent) {
      els.actionResultModalContent.innerHTML = "";
    }
    if (els.actionResultModalTitle) {
      els.actionResultModalTitle.textContent = "Launch Result";
    }
    if (els.actionResultModalSubtitle) {
      els.actionResultModalSubtitle.textContent = "Launcher output stays here until you close it.";
    }
    return;
  }

  if (els.actionResultModalTitle) {
    els.actionResultModalTitle.textContent = modal.title || "Launch Result";
  }
  if (els.actionResultModalSubtitle) {
    els.actionResultModalSubtitle.textContent = modal.subtitle || "Launcher output stays here until you close it.";
  }
  if (!els.actionResultModalContent) {
    return;
  }

  const showError = modal.error && modal.error !== modal.summary;
  const showOutput = modal.output && modal.output !== modal.summary && modal.output !== modal.error;
  els.actionResultModalContent.innerHTML = `
    <div class="launch-result-shell">
      <section class="launch-result-banner ${modal.status === "error" ? "error" : "success"}">
        <span class="launch-result-status">${modal.status === "error" ? "failed" : "success"}</span>
        <p class="launch-result-summary">${esc(modal.summary || (modal.status === "error" ? "Launch failed." : "Launch succeeded."))}</p>
      </section>
      ${showError ? `
        <section class="launch-result-section">
          <h4>Error</h4>
          <pre class="launch-result-pre">${esc(modal.error)}</pre>
        </section>
      ` : ""}
      ${showOutput ? `
        <section class="launch-result-section">
          <h4>${modal.status === "error" ? "Launcher output before failure" : "Launcher output"}</h4>
          <pre class="launch-result-pre">${esc(modal.output)}</pre>
        </section>
      ` : ""}
      ${modal.syncEntries.length > 0 ? `
        <section class="launch-result-section">
          <h4>Application sync</h4>
          <div class="launch-result-sync-list">
            ${modal.syncEntries.map((entry) => `
              <article class="launch-result-sync-entry">
                <strong>${esc(entry.label)}</strong>
                <p>${esc(entry.message)}</p>
              </article>
            `).join("")}
          </div>
        </section>
      ` : ""}
    </div>
  `;
}

function openLaunchModal(modelKey, slotId = null, entryPoint = "model") {
  const model = getModel(modelKey);
  if (!model) {
    return;
  }
  if (state.profileModal.open) {
    closeProfileModal();
  }
  const preferredSlotId = slotId || findPreferredSlotId(modelKey);
  const resolvedEntryPoint = entryPoint === "slot" ? "slot" : "model";
  state.modal.open = true;
  state.modal.modelKey = modelKey;
  state.modal.voiceModel = null;
  state.modal.slotId = preferredSlotId;
  state.modal.entryPoint = resolvedEntryPoint;
  state.modal.form = createLaunchForm(preferredSlotId, model);
  Object.assign(
    state.modal.form,
    resolveLaunchAppFlags(getSlot(preferredSlotId), model, resolvedEntryPoint)
  );
  state.modal.colorPickerOpen = false;
  state.modal.colorDraft = "";
  pauseRefreshForEditing();
  renderLaunchModal();
}

// Convert a stored {appKey: bool} preference into the form's {setX: bool} fields.
function appKeyFlagsToFieldFlags(flags) {
  return Object.fromEntries(
    LLM_APPLICATION_FLAGS.map((flag) => [flag.field, Boolean(flags?.[flag.appKey])])
  );
}

// Pre-fill the launch modal's application checkboxes (soft): a saved per-model or
// per-slot preference wins for its entry point; otherwise fall back to the live
// routing currently configured for the slot.
function resolveLaunchAppFlags(slot, model, entryPoint) {
  if (entryPoint === "model") {
    const pref = state.modelApplicationPreferences?.[model?.key];
    if (pref) {
      return appKeyFlagsToFieldFlags(pref);
    }
  } else {
    const pref = state.slotApplicationPreferences?.[slot?.id];
    if (pref) {
      return appKeyFlagsToFieldFlags(pref);
    }
  }
  return buildApplicationFlagStateFromSlot(slot);
}

function closeLaunchModal() {
  state.modal.open = false;
  state.modal.modelKey = null;
  state.modal.voiceModel = null;
  state.modal.form = null;
  state.modal.colorPickerOpen = false;
  state.modal.colorDraft = "";
  state.modal.slotNameDraft = null;
  renderLaunchModal();
}

// The launch modal's rename commits on its own, not on Launch: the name is a
// property of the slot, not of the model about to start in it.
async function commitLaunchModalSlotName() {
  const draft = state.modal.slotNameDraft;
  if (draft == null) {
    return;
  }
  const slot = getSlot(state.modal.slotId);
  const name = String(draft).replace(/\s+/g, " ").trim().slice(0, 40);
  state.modal.slotNameDraft = null;
  if (!slot || name === customSlotName(slot)) {
    renderLaunchModal();
    return;
  }
  await runAction("/api/slots/name", { slotId: slot.id, name }, { preserveModal: true });
}

function getProfileById(profileId) {
  return state.profiles.find((profile) => profile.id === profileId) || null;
}

function getSelectedProfileCard() {
  return getProfileById(state.selectedProfileId)
    || getProfileById(state.activeProfileId)
    || getProfileById(state.defaultProfileId)
    || state.profiles[0]
    || null;
}

function buildProfileVoiceDraft(type, source = {}) {
  const slot = getVoiceSlots().find((entry) => entry.type === type) || null;
  const baseDraft = ensureVoiceDraft(type);
  const hasExplicitModelKey = Object.prototype.hasOwnProperty.call(source, "modelKey");
  const explicitModelKey = hasExplicitModelKey ? String(source.modelKey || "").trim() : "";
  const fallbackModelKey = explicitModelKey
    || String(baseDraft.modelKey || "").trim()
    || String(slot?.status?.model?.key || "").trim();
  const model = getVoiceModels().find((entry) => entry.key === fallbackModelKey && entry.type === type)
    || getVoiceModels().find((entry) => entry.type === type && entry.key === String(baseDraft.modelKey || "").trim())
    || null;
  const sampleRate = Number(source.sampleRate ?? baseDraft.sampleRate ?? (type === "tts" ? 24000 : 16000));
  const nextVoiceName = String(source.voiceName ?? baseDraft.voiceName ?? model?.voices?.[0] ?? "").trim();
  const tuning = type === "tts"
    ? normalizeVoiceTtsTuningDraft({
      exaggeration: source.exaggeration ?? baseDraft.exaggeration,
      cfgWeight: source.cfgWeight ?? baseDraft.cfgWeight,
      temperature: source.temperature ?? baseDraft.temperature,
      repetitionPenalty: source.repetitionPenalty ?? baseDraft.repetitionPenalty,
      minP: source.minP ?? baseDraft.minP,
      topP: source.topP ?? baseDraft.topP,
    }, model || fallbackModelKey)
    : {};
  return {
    slotId: String(slot?.id || `voice-${type}-1`),
    type,
    enabled: Boolean(Object.prototype.hasOwnProperty.call(source, "enabled") ? source.enabled : fallbackModelKey),
    modelKey: String(fallbackModelKey || ""),
    voiceSlotId: String(slot?.id || `voice-${type}-1`),
    voiceName: type === "tts" && model?.voices?.length && !model.voices.includes(nextVoiceName)
      ? String(model.voices[0] || "")
      : nextVoiceName,
    audioFormat: String(source.audioFormat ?? baseDraft.audioFormat ?? "pcm16"),
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : (type === "tts" ? 24000 : 16000),
    runtimeBaseUrl: String(source.runtimeBaseUrl ?? slot?.configuredRuntimeBaseUrl ?? ""),
    setHermes: Boolean(source.setHermes ?? baseDraft.setHermes ?? true),
    setHermesM4: Boolean(source.setHermesM4 ?? baseDraft.setHermesM4 ?? true),
    ...tuning,
  };
}

function loadProfileModalDraft(profile = null) {
  const selectedProfile = profile || null;
  state.profileModal.profileId = selectedProfile?.id || "";
  state.profileModal.name = selectedProfile?.name || "";
  state.profileModal.color = normalizeHexColor(selectedProfile?.color) || "";
  state.profileModal.colorDraft = "";
  state.profileModal.colorPickerOpen = false;
  state.profileModal.isDefault = Boolean(selectedProfile && selectedProfile.id === state.defaultProfileId);
  state.profileModal.activeSlotId = state.profileModal.activeSlotId || state.slots[0]?.id || "slot1";
  state.profileModal.slots = Object.fromEntries(
    state.slots.map((slot) => [
      slot.id,
      buildProfileSlotDraft(slot.id, selectedProfile?.slots?.[slot.id]),
    ])
  );
  state.profileModal.voiceSlots = Object.fromEntries(
    ["tts", "stt"].map((type) => {
      const slot = getVoiceSlots().find((entry) => entry.type === type);
      return [
        slot?.id || `voice-${type}-1`,
        buildProfileVoiceDraft(type, selectedProfile?.voiceSlots?.[slot?.id || `voice-${type}-1`]),
      ];
    })
  );
  state.selectedProfileId = selectedProfile?.id || state.selectedProfileId || "";
}

function getProfileModalColorValue() {
  return normalizeHexColor(state.profileModal.colorDraft)
    || normalizeHexColor(state.profileModal.color)
    || "#6366f1";
}

function hasCustomProfileColor() {
  return Boolean(normalizeHexColor(state.profileModal.color));
}

function buildDefaultSamplingForm(overrides = {}) {
  return {
    temperature: String(overrides.temperature ?? SAMPLING_DEFAULTS.temperature),
    topP: String(overrides.topP ?? SAMPLING_DEFAULTS.topP),
    topK: String(overrides.topK ?? SAMPLING_DEFAULTS.topK),
    minP: String(overrides.minP ?? SAMPLING_DEFAULTS.minP),
    presencePenalty: String(overrides.presencePenalty ?? SAMPLING_DEFAULTS.presencePenalty),
    repetitionPenalty: String(overrides.repetitionPenalty ?? SAMPLING_DEFAULTS.repetitionPenalty),
  };
}

function applyThinkingPresencePenalty(target, thinking) {
  if (!target) {
    return target;
  }
  target.presencePenalty = String(
    thinking ? PRESENCE_PENALTY_BY_THINKING.enabled : PRESENCE_PENALTY_BY_THINKING.disabled
  );
  return target;
}

function resetSamplingFields(target) {
  if (!target) {
    return target;
  }
  Object.assign(target, buildDefaultSamplingForm());
  return target;
}

function createEmptyLaunchLikeForm(slot) {
  return {
    ctxSize: "255000",
    parallel: "1",
    thinking: false,
    runtimeBaseUrl: String(slot?.configuredRuntimeBaseUrl || "").trim(),
    enableTinyGrammar: false,
    enableStructuredGbnf: false,
    ...buildDefaultSamplingForm(),
    ...Object.fromEntries(LLM_APPLICATION_FLAGS.map((flag) => [flag.field, false])),
  };
}

function buildProfileSlotDraft(slotId, source = {}) {
  const slot = getSlot(slotId);
  const hasExplicitModelKey = Object.prototype.hasOwnProperty.call(source, "modelKey");
  const explicitModelKey = hasExplicitModelKey ? String(source.modelKey || "").trim() : "";
  const fallbackModel = explicitModelKey
    ? getModel(explicitModelKey)
    : hasExplicitModelKey
      ? null
      : slot?.status?.running
        ? getModel(slot.status.model?.key)
        : null;
  const baseForm = fallbackModel ? createLaunchForm(slotId, fallbackModel) : createEmptyLaunchLikeForm(slot);
  const grammarSelection = normalizeGrammarSelection(fallbackModel, {
    enableTinyGrammar: source.enableTinyGrammar ?? baseForm.enableTinyGrammar,
    enableStructuredGbnf: source.enableStructuredGbnf ?? baseForm.enableStructuredGbnf,
  });
  return {
    enabled: Boolean(Object.prototype.hasOwnProperty.call(source, "enabled") ? source.enabled : fallbackModel),
    modelKey: explicitModelKey || String(fallbackModel?.key || "").trim(),
    name: Object.prototype.hasOwnProperty.call(source, "name")
      ? String(source.name || "")
      : customSlotName(slot),
    ctxSize: String(source.ctxSize ?? baseForm.ctxSize),
    parallel: String(source.parallel ?? baseForm.parallel),
    thinking: Boolean(source.thinking ?? baseForm.thinking),
    launcher: String(source.launcher ?? baseForm.launcher ?? ""),
    runtimeBaseUrl: String(source.runtimeBaseUrl ?? baseForm.runtimeBaseUrl ?? ""),
    ...grammarSelection,
    ...buildDefaultSamplingForm({
      temperature: source.temperature ?? baseForm.temperature,
      topP: source.topP ?? baseForm.topP,
      topK: source.topK ?? baseForm.topK,
      minP: source.minP ?? baseForm.minP,
      presencePenalty: source.presencePenalty ?? baseForm.presencePenalty,
      repetitionPenalty: source.repetitionPenalty ?? baseForm.repetitionPenalty,
    }),
    ...Object.fromEntries(
      LLM_APPLICATION_FLAGS.map((flag) => [flag.field, getApplicationFlagValue(source, flag, baseForm)])
    ),
  };
}

function ensureProfileModalSlot(slotId) {
  if (!state.profileModal.slots[slotId]) {
    state.profileModal.slots[slotId] = buildProfileSlotDraft(slotId);
  }
  return state.profileModal.slots[slotId];
}

function openProfileModal(profileId) {
  if (state.modal.open) {
    closeLaunchModal();
  }
  const requestedProfileId = typeof profileId === "string" ? String(profileId).trim() : null;
  const selectedProfile = requestedProfileId == null
    ? getProfileById(state.activeProfileId) || null
    : getProfileById(requestedProfileId) || null;
  state.profileModal.open = true;
  loadProfileModalDraft(selectedProfile);
  pauseRefreshForEditing();
  renderProfileModal();
}

function closeProfileModal() {
  state.profileModal.open = false;
  state.profileModal.profileId = "";
  state.profileModal.name = "";
  state.profileModal.color = "";
  state.profileModal.colorPickerOpen = false;
  state.profileModal.colorDraft = "";
  state.profileModal.isDefault = false;
  state.profileModal.activeSlotId = state.slots[0]?.id || "slot1";
  state.profileModal.slots = {};
  state.profileModal.voiceSlots = {};
  renderProfileModal();
}

function handleProfileModalInput(event) {
  if (!state.profileModal.open) {
    return;
  }
  const profileInput = event.target.closest("[data-profile-input]");
  if (profileInput) {
    pauseRefreshForEditing();
    const field = profileInput.dataset.profileInput;
    if (field === "profileId") {
      loadProfileModalDraft(getProfileById(String(profileInput.value || "").trim()));
      renderProfileModal();
      return;
    }
    if (field === "name") {
      state.profileModal.name = profileInput.value;
    } else if (field === "isDefault") {
      state.profileModal.isDefault = Boolean(profileInput.checked);
    }
    return;
  }

  const colorRange = event.target.closest("[data-profile-color-value]");
  if (colorRange) {
    const current = hexToHsv(getProfileModalColorValue()) || { h: 0, s: 1, v: 1 };
    state.profileModal.colorDraft = hsvToHex(current.h, current.s, Number(colorRange.value) / 100);
    syncProfileColorPickerUi();
    return;
  }

  const colorDraftInput = event.target.closest("[data-profile-color-draft]");
  if (colorDraftInput) {
    state.profileModal.colorDraft = colorDraftInput.value;
    syncProfileColorPickerUi();
    return;
  }

  // Handle profile slot sampling preset dropdown
  const profileSlotPreset = event.target.closest("[data-profile-slot-sampling-preset]");
  if (profileSlotPreset) {
    const slotId = profileSlotPreset.dataset.slotId;
    const presetKey = profileSlotPreset.value;
    const draft = ensureProfileModalSlot(slotId);
    const preset = SAMPLING_PRESETS[presetKey];
    if (preset) {
      Object.assign(draft, {
        thinking: preset.thinking,
        temperature: String(preset.temperature),
        topP: String(preset.topP),
        topK: String(preset.topK),
        minP: String(preset.minP),
        presencePenalty: String(preset.presencePenalty),
        repetitionPenalty: String(preset.repetitionPenalty),
      });
      renderProfileModal();
    }
    return;
  }

  const slotInput = event.target.closest("[data-profile-slot-input]");
  if (slotInput) {
    pauseRefreshForEditing();
    const slotId = slotInput.dataset.slotId;
    const field = slotInput.dataset.profileSlotInput;
    const draft = ensureProfileModalSlot(slotId);
    if (field === "enabled") {
      draft.enabled = Boolean(slotInput.checked) && Boolean(draft.modelKey);
      renderProfileModal();
      return;
    }
    if (field === "modelKey") {
      const nextModelKey = String(slotInput.value || "").trim();
      const nextModel = getModel(nextModelKey);
      state.profileModal.slots[slotId] = buildProfileSlotDraft(slotId, {
        modelKey: nextModelKey,
        enabled: Boolean(nextModelKey) && Boolean(draft.enabled || nextModel),
        runtimeBaseUrl: draft.runtimeBaseUrl,
        ...Object.fromEntries(
          LLM_APPLICATION_FLAGS.map((flag) => [flag.field, Boolean(draft[flag.field])])
        ),
      });
      renderProfileModal();
      return;
    }
    if (field === "enableTinyGrammar") {
      draft.enableTinyGrammar = supportsTinyGrammar(getModel(draft.modelKey)) ? Boolean(slotInput.checked) : false;
      if (draft.enableTinyGrammar) {
        draft.enableStructuredGbnf = false;
      }
      renderProfileModal();
      return;
    }
    if (field === "enableStructuredGbnf") {
      draft.enableStructuredGbnf = supportsStructuredGbnf(getModel(draft.modelKey)) ? Boolean(slotInput.checked) : false;
      if (draft.enableStructuredGbnf) {
        draft.enableTinyGrammar = false;
      }
      renderProfileModal();
      return;
    }
    if (field === "launcher") {
      const model = getModel(draft.modelKey);
      const defaults = getSlotDefaults(getSlot(slotId), model, slotInput.value);
      const grammarSelection = normalizeGrammarSelection(model, defaults);
      Object.assign(draft, {
        launcher: slotInput.value,
        ctxSize: String(defaults.contextSize || defaults.ctxSize || draft.ctxSize),
        parallel: String(defaults.parallel || draft.parallel),
        thinking: model?.supportsThinking ? Boolean(defaults.thinking) : false,
        ...grammarSelection,
        ...buildDefaultSamplingForm({
          temperature: defaults.temperature,
          topP: defaults.topP,
          topK: defaults.topK,
          minP: defaults.minP,
          presencePenalty: defaults.presencePenalty,
          repetitionPenalty: defaults.repetitionPenalty,
        }),
      });
      renderProfileModal();
      return;
    }
    if (field === "thinking") {
      draft.thinking = Boolean(slotInput.checked);
      applyThinkingPresencePenalty(draft, draft.thinking);
      renderProfileModal();
      return;
    }
    if (getApplicationFlagByField(field)) {
      draft[field] = Boolean(slotInput.checked);
      return;
    }
    draft[field] = slotInput.value;
    if (field === "ctxSize" || field === "parallel") {
      renderProfileModal();
    }
    return;
  }

  const voiceInput = event.target.closest("[data-profile-voice-input]");
  if (!voiceInput) {
    return;
  }
  pauseRefreshForEditing();
  const voiceType = voiceInput.dataset.voiceType;
  const voiceSlotId = getVoiceSlots().find((slot) => slot.type === voiceType)?.id || `voice-${voiceType}-1`;
  const draft = state.profileModal.voiceSlots[voiceSlotId] || buildProfileVoiceDraft(voiceType);
  const field = voiceInput.dataset.profileVoiceInput;
  if (field === "enabled") {
    draft.enabled = Boolean(voiceInput.checked) && Boolean(draft.modelKey);
    state.profileModal.voiceSlots[voiceSlotId] = draft;
    renderProfileModal();
    return;
  }
  if (field === "modelKey") {
    state.profileModal.voiceSlots[voiceSlotId] = buildProfileVoiceDraft(voiceType, {
      ...draft,
      modelKey: String(voiceInput.value || "").trim(),
      enabled: Boolean(voiceInput.value || draft.enabled),
    });
    renderProfileModal();
    return;
  }
  draft[field] = voiceInput.type === "checkbox"
    ? Boolean(voiceInput.checked)
    : (field === "sampleRate" || VOICE_TTS_TUNING_FIELD_NAMES.has(field))
      ? Number(voiceInput.value)
      : voiceInput.value;
  state.profileModal.voiceSlots[voiceSlotId] = draft;
}

async function runSaveProfile() {
  const name = String(state.profileModal.name || "").trim();
  if (!name) {
    toast("enter a profile name");
    return;
  }
  const payload = {
    profileId: state.profileModal.profileId || "",
    name,
    color: normalizeHexColor(state.profileModal.color) || "",
    isDefault: Boolean(state.profileModal.isDefault),
    slots: Object.fromEntries(
      state.slots.map((slot) => {
        const draft = ensureProfileModalSlot(slot.id);
        const model = getModel(draft.modelKey);
        return [slot.id, {
          enabled: Boolean(draft.enabled && draft.modelKey),
          modelKey: String(draft.modelKey || ""),
          ctxSize: Number(draft.ctxSize),
          parallel: Number(draft.parallel),
          thinking: Boolean(draft.thinking),
          ...normalizeGrammarSelection(model, draft),
          ...normalizeSpeedTrickSelection(model, draft),
          name: String(draft.name || ""),
          launcher: String(draft.launcher || getLauncherOptions(model)[0] || model?.launcher || ""),
          temperature: Number(draft.temperature),
          topP: Number(draft.topP),
          topK: Number(draft.topK),
          minP: Number(draft.minP),
          presencePenalty: Number(draft.presencePenalty),
          repetitionPenalty: Number(draft.repetitionPenalty),
          runtimeBaseUrl: String(draft.runtimeBaseUrl || "").trim(),
          ...Object.fromEntries(
            LLM_APPLICATION_FLAGS.map((flag) => [flag.field, Boolean(draft[flag.field])])
          ),
        }];
      })
    ),
    voiceSlots: Object.fromEntries(
      getVoiceSlots().map((slot) => {
        const draft = state.profileModal.voiceSlots?.[slot.id] || buildProfileVoiceDraft(slot.type);
        return [slot.id, {
          enabled: Boolean(draft.enabled && draft.modelKey),
          modelKey: String(draft.modelKey || ""),
          voiceSlotId: slot.id,
          voiceName: String(draft.voiceName || "").trim(),
          audioFormat: String(draft.audioFormat || "pcm16"),
          sampleRate: Number(draft.sampleRate) || (slot.type === "tts" ? 24000 : 16000),
          runtimeBaseUrl: String(draft.runtimeBaseUrl || "").trim(),
          setHermes: Boolean(draft.setHermes),
          setHermesM4: Boolean(draft.setHermesM4),
          ...buildVoiceTtsPayload(draft, draft.modelKey),
        }];
      })
    ),
  };
  const result = await runAction("/api/profiles/save", payload, { preserveModal: false });
  if (result?.profileId) {
    state.profileModal.profileId = result.profileId;
    state.activeProfileId = String(result.activeProfileId || state.activeProfileId || "");
    state.profileModal.color = normalizeHexColor(
      getProfileById(result.profileId)?.color
      || getProfileModalColorValue()
    ) || "";
    renderProfileModal();
  }
}

async function runDeleteProfile(profileId) {
  if (String(state.selectedProfileId || "") === String(profileId || "")) {
    state.selectedProfileId = "";
  }
  await runAction("/api/profiles/delete", { profileId }, { preserveModal: false });
}

function runDeleteSelectedProfile() {
  const profile = getProfileById(state.profileModal.profileId);
  if (!profile) {
    toast("select a saved profile first");
    return;
  }
  if (!window.confirm(`Delete profile ${profile.name}?`)) {
    return;
  }
  closeProfileModal();
  runDeleteProfile(profile.id);
}

function renderProfileControls() {
  renderModelsSurfaceTabs();
}

const SAVE_LAYOUT_NEW_PROFILE = "__new__";

// "The current layout" is what the slots hold right now, not what the profile
// editor happens to have open: buildProfileSlotDraft with no source reads the
// running model and its launch parameters straight off the slot.
function buildCurrentLayoutSummary() {
  const llmRows = state.slots.map((slot) => {
    const model = slot.status?.running ? getModel(slot.status.model?.key) : null;
    const label = slot.status?.running
      ? (model?.label || slot.status.model?.label || slot.status.model?.key || "Live runtime")
      : "";
    return { label: slotName(slot), value: label };
  });
  const voiceRows = getVoiceSlots().map((slot) => {
    const model = slot.status?.running
      ? getVoiceModels().find((entry) => entry.key === slot.status.model?.key)
      : null;
    return {
      label: String(slot.type || "").toUpperCase(),
      value: slot.status?.running ? (model?.label || slot.status.model?.key || "Live runtime") : "",
    };
  });
  return [...llmRows, ...voiceRows];
}

function openSaveLayoutModal() {
  toggleProfileMenu(false);
  // A right-click can be a mis-click, so the destructive option is never the
  // default: overwriting an existing profile takes one deliberate selection.
  state.saveLayoutModal = {
    open: true,
    targetProfileId: SAVE_LAYOUT_NEW_PROFILE,
    name: suggestProfileName(),
  };
  pauseRefreshForEditing();
  renderSaveLayoutModal();
}

function suggestProfileName() {
  const base = "Layout";
  const existing = new Set(state.profiles.map((profile) => profile.name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`;
    if (!existing.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return base;
}

function closeSaveLayoutModal() {
  state.saveLayoutModal = { open: false, targetProfileId: "", name: "" };
  renderSaveLayoutModal();
}

function renderSaveLayoutModal() {
  const modal = state.saveLayoutModal;
  const open = Boolean(modal?.open);
  els.saveLayoutModal?.classList.toggle("hidden", !open);
  els.saveLayoutModal?.setAttribute("aria-hidden", String(!open));
  if (!els.saveLayoutModalContent) {
    return;
  }
  if (!open) {
    els.saveLayoutModalContent.innerHTML = "";
    return;
  }

  const isNew = modal.targetProfileId === SAVE_LAYOUT_NEW_PROFILE;
  const target = getProfileById(modal.targetProfileId);
  const rows = buildCurrentLayoutSummary();
  const loadedCount = rows.filter((row) => row.value).length;
  els.saveLayoutModalContent.innerHTML = `
    <div class="save-layout-shell">
      <p class="save-layout-question">
        ${loadedCount
          ? `Save the ${loadedCount === 1 ? "one loaded model" : `${loadedCount} loaded models`} and their launch settings as a profile?`
          : "No slot is loaded. Saving now stores an all-idle profile."}
      </p>
      <ul class="save-layout-slots">
        ${rows.map((row) => `
          <li class="${row.value ? "" : "idle"}">
            <strong>${esc(row.label)}</strong>
            <span>${esc(row.value || "idle")}</span>
          </li>`).join("")}
      </ul>
      <label class="field-label save-layout-field">
        <span>Save to</span>
        <select data-save-layout-target>
          <option value="${SAVE_LAYOUT_NEW_PROFILE}"${isNew ? " selected" : ""}>New profile…</option>
          ${state.profiles.map((profile) => `
            <option value="${esc(profile.id)}"${profile.id === modal.targetProfileId ? " selected" : ""}>
              Overwrite ${esc(profile.name)}${profile.id === state.activeProfileId ? " (active)" : ""}
            </option>`).join("")}
        </select>
      </label>
      ${isNew ? `
        <label class="field-label save-layout-field">
          <span>Profile name</span>
          <input type="text" maxlength="60" data-save-layout-name value="${esc(modal.name)}" placeholder="Profile name" />
        </label>` : `
        <p class="save-layout-warning">${esc(target?.name || "This profile")} is replaced with the current layout. This cannot be undone.</p>`}
      <div class="save-layout-actions">
        <button class="btn btn-secondary btn-sm" type="button" data-save-layout-cancel>Cancel</button>
        <button class="btn btn-primary btn-sm" type="button" data-save-layout-confirm ${state.actionInFlight ? "disabled" : ""}>
          ${isNew ? "Create profile" : "Overwrite profile"}
        </button>
      </div>
    </div>
  `;
}

async function runSaveCurrentLayout() {
  const modal = state.saveLayoutModal;
  const isNew = modal.targetProfileId === SAVE_LAYOUT_NEW_PROFILE;
  const target = isNew ? null : getProfileById(modal.targetProfileId);
  const name = isNew ? String(modal.name || "").trim() : String(target?.name || "").trim();
  if (!name) {
    toast("enter a profile name", { type: "error" });
    return;
  }
  if (!isNew && !target) {
    toast("that profile no longer exists", { type: "error" });
    return;
  }

  // Reuse the profile editor's own draft builders so a layout saved from here is
  // byte-for-byte what the editor would have produced.
  const previousDrafts = state.profileModal.slots;
  const previousVoiceDrafts = state.profileModal.voiceSlots;
  const previousProfileId = state.profileModal.profileId;
  const previousName = state.profileModal.name;
  const previousIsDefault = state.profileModal.isDefault;
  const previousColor = state.profileModal.color;

  loadProfileModalDraft(null);
  state.profileModal.profileId = target?.id || "";
  state.profileModal.name = name;
  state.profileModal.color = normalizeHexColor(target?.color) || "";
  state.profileModal.isDefault = Boolean(target && target.id === state.defaultProfileId);

  closeSaveLayoutModal();
  try {
    await runSaveProfile();
  } finally {
    state.profileModal.slots = previousDrafts;
    state.profileModal.voiceSlots = previousVoiceDrafts;
    state.profileModal.profileId = previousProfileId;
    state.profileModal.name = previousName;
    state.profileModal.isDefault = previousIsDefault;
    state.profileModal.color = previousColor;
  }
}

function renderLaunchersModal() {
  if (!els.launchersModal || !els.launchersModalContent) {
    return;
  }
  const modalOpen = state.launchersModal.open;
  els.launchersModal.classList.toggle("hidden", !modalOpen);
  els.launchersModal.setAttribute("aria-hidden", String(!modalOpen));
  if (!modalOpen) {
    els.launchersModalContent.innerHTML = "";
    return;
  }

  const launchers = Array.isArray(state.launchersModal.launchers) ? state.launchersModal.launchers : [];
  const groups = {
    gguf: launchers.filter((launcher) => launcher.family === "gguf"),
    mlx: launchers.filter((launcher) => launcher.family === "mlx"),
  };

  if (state.launchersModal.loading && !launchers.length) {
    els.launchersModalContent.innerHTML = `
      <div class="empty-state hf-loading-state">
        <div class="loading-spinner"></div>
        <div>
          <h3>Loading launchers</h3>
          <p>Inspecting local GGUF and MLX launcher targets.</p>
        </div>
      </div>
    `;
    return;
  }

  els.launchersModalContent.innerHTML = `
    <div class="launchers-modal-layout">
      ${state.launchersModal.error ? `<div class="launch-result-banner error"><strong>Unable to refresh launchers</strong><span>${esc(state.launchersModal.error)}</span></div>` : ""}
      ${renderLauncherGroupTable("GGUF Launchers", "GGUF", "gguf", groups.gguf, "llama.cpp-based launchers for local GGUF models.")}
      ${renderLauncherGroupTable("MLX Launchers", "MLX", "mlx", groups.mlx, "MLX-family launchers, including rapid-mlx and MTPLX.")}
    </div>
  `;
}

function renderLauncherGroupTable(title, pillLabel, pillClass, launchers, description) {
  if (!launchers.length) {
    return `
      <section class="launcher-group-card">
        <div class="launcher-group-header">
          <div>
            <h4>${esc(title)}</h4>
            <p>${esc(description)}</p>
          </div>
          <span class="runtime-pill ${pillClass}">${esc(pillLabel)}</span>
        </div>
        <div class="status-text">No launchers detected.</div>
      </section>
    `;
  }

  return `
    <section class="launcher-group-card">
      <div class="launcher-group-header">
        <div>
          <h4>${esc(title)}</h4>
          <p>${esc(description)}</p>
        </div>
        <span class="runtime-pill ${pillClass}">${esc(pillLabel)}</span>
      </div>
      <div class="table-shell">
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Path</th>
                <th>Version</th>
                <th>CLI</th>
                <th>Update</th>
              </tr>
            </thead>
            <tbody>
              ${launchers.map((launcher) => renderLauncherRow(launcher)).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  `;
}

function renderLauncherRow(launcher) {
  const updating = state.launchersModal.updatingKey === launcher.key;
  const accentClass = launcher.accent === "mtplx" ? "mtplx" : launcher.family === "gguf" ? "gguf" : "mlx";
  return `
    <tr>
      <td class="launcher-name-cell"><span class="runtime-pill ${accentClass}">${esc(launcher.name)}</span></td>
      <td class="launcher-path">${esc(launcher.path || "n/a")}</td>
      <td class="launcher-version">${esc(launcher.version || "unknown")}</td>
      <td>
        <div class="table-actions">
          <button class="btn btn-icon icon-action" type="button" data-launcher-command="${esc(launcher.key)}" title="Show CLI params for ${esc(launcher.name)}" aria-label="Show CLI params for ${esc(launcher.name)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 9-4 3 4 3"/><path d="m16 9 4 3-4 3"/><path d="M14 5 10 19"/></svg>
          </button>
        </div>
      </td>
      <td>
        <div class="table-actions">
          <button class="btn btn-icon icon-action btn-primary" type="button" data-launcher-update="${esc(launcher.key)}" ${updating ? "disabled" : ""} title="Update ${esc(launcher.name)} upstream" aria-label="Update ${esc(launcher.name)} upstream">
            ${updating
              ? `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`
              : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`}
          </button>
        </div>
      </td>
    </tr>
  `;
}

function renderLauncherCommandPreview() {
  if (!els.launcherCommandPreview) {
    return;
  }
  const preview = state.launcherCommandPreview;
  els.launcherCommandPreview.classList.toggle("hidden", !preview.open);
  els.launcherCommandPreview.setAttribute("aria-hidden", String(!preview.open));
  if (!preview.open) {
    els.launcherCommandPreview.innerHTML = "";
    return;
  }
  els.launcherCommandPreview.innerHTML = `
    <div class="launcher-command-preview-header">
      <div>
        <div class="launcher-command-preview-title">${esc(preview.title || "Launcher command")}</div>
        <div class="launcher-command-preview-subtitle">Exact launcher invocation template with placeholders for runtime-selected values.</div>
      </div>
      <button class="btn btn-icon" type="button" data-launcher-command-close="true" aria-label="Close launcher command preview">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
      </button>
    </div>
    <div class="launcher-command-preview-body">
      <pre>${esc(preview.command || "")}</pre>
    </div>
  `;
}

function renderModelsSurfaceTabs() {
  if (!els.modelsSurfaceTabs) {
    return;
  }
  const selectedProfile = getSelectedProfileCard();
  els.modelsSurfaceTabs.innerHTML = `
    <div class="models-surface-tabs-primary">
      <button class="model-surface-tab ${state.modelsPane === "models" ? "active" : ""}" type="button" data-models-pane="models">Models</button>
      <div class="model-surface-tab-group${state.profileMenuOpen ? " menu-open" : ""}">
        <button
          class="model-surface-tab ${state.modelsPane === "profiles" ? "active" : ""}"
          type="button"
          data-models-pane="profiles"
          title="Right-click to save the current layout as a profile"
        >Profiles<span>${state.profiles.length}</span></button>
        <button
          class="model-surface-tab-caret ${state.modelsPane === "profiles" ? "active" : ""}"
          type="button"
          data-profile-menu-toggle
          aria-expanded="${state.profileMenuOpen ? "true" : "false"}"
          aria-label="Select a profile"
          title="Select a profile"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        ${renderProfileSelectMenu()}
      </div>
    </div>
    <div class="models-surface-tabs-actions ${state.modelsPane === "profiles" ? "" : "hidden"}">
      <button class="btn btn-secondary btn-sm" type="button" data-profile-new ${state.actionInFlight ? "disabled" : ""}>+ New</button>
      <button class="btn btn-danger btn-sm" type="button" data-profile-delete-selected title="${esc(selectedProfile ? `Delete ${selectedProfile.name}` : "Select a profile to delete")}" ${selectedProfile && !state.actionInFlight ? "" : "disabled"}>Delete</button>
    </div>
  `;
}

function renderProfileSelectMenu() {
  if (!state.profileMenuOpen) {
    return "";
  }
  const rows = state.profiles.map((profile) => {
    const isActive = profile.id === state.activeProfileId;
    const isSelected = profile.id === state.selectedProfileId;
    return `
      <div class="profile-menu-row${isSelected ? " selected" : ""}${isActive ? " active" : ""}">
        <button class="profile-menu-pick" type="button" data-profile-menu-select="${esc(profile.id)}">
          <span class="profile-menu-swatch" style="background:${esc(normalizeHexColor(profile.color) || "#6366f1")}"></span>
          <span class="profile-menu-name">${esc(profile.name)}</span>
          ${isActive ? `<span class="badge badge-success">Active</span>` : ""}
          ${profile.id === state.defaultProfileId ? `<span class="badge badge-runtime">Default</span>` : ""}
        </button>
        <button
          class="btn btn-primary btn-xs profile-menu-start"
          type="button"
          data-profile-menu-start="${esc(profile.id)}"
          ${state.actionInFlight ? "disabled" : ""}
          title="Stop everything and start ${esc(profile.name)}"
        >Start</button>
      </div>`;
  }).join("");
  return `
    <div class="profile-menu" role="menu">
      <div class="profile-menu-head">Profiles</div>
      ${rows || `<p class="profile-menu-empty">No profiles saved yet.</p>`}
      <div class="profile-menu-foot">
        <button class="btn btn-secondary btn-xs" type="button" data-profile-menu-save>Save current layout…</button>
      </div>
    </div>`;
}

function toggleProfileMenu(open) {
  const next = typeof open === "boolean" ? open : !state.profileMenuOpen;
  if (next === state.profileMenuOpen) {
    return;
  }
  state.profileMenuOpen = next;
  renderModelsSurfaceTabs();
}

function runSelectedRestartTarget() {
  const target = String(els.restartTargetSelect?.value || "hermes").trim();
  const restartUrl = target === "voice" ? "/api/voice/restart" : "/api/hermes/restart";
  runAction(restartUrl, {}, { preserveModal: false });
}

function buildProfileModelOptionLabel(model) {
  if (!model) {
    return "";
  }
  return [
    model.label,
    runtimeLabel(model.runtime),
    getModelVariant(model) || model.family || "",
    model.sizeLabel || "",
  ].filter(Boolean).join(" · ");
}

function buildProfileModelTitle(model) {
  if (!model) {
    return "";
  }
  return [
    model.label,
    model.family || "",
    runtimeLabel(model.runtime),
    getModelVariant(model) || "",
    model.sizeLabel || "",
    model.path || "",
  ].filter(Boolean).join("\n");
}

function renderProfileModelPreview(model) {
  if (!model) {
    return `<div class="profile-model-preview empty"><span>Pick a model to see runtime, size, variant, path, and Hugging Face details.</span></div>`;
  }
  return `
    <div class="profile-model-preview" title="${esc(buildProfileModelTitle(model))}">
      <div class="profile-model-preview-head">
        <strong>${esc(model.label)}</strong>
        <span class="runtime-pill ${runtimeClass(model.runtime)}">${runtimeLabel(model.runtime)}</span>
      </div>
      <div class="profile-model-preview-meta">
        <span>${esc(model.family || "Unknown family")}</span>
        <span>${esc(getModelVariant(model) || "default")}</span>
        <span>${esc(model.sizeLabel || "n/a")}</span>
      </div>
      <div class="profile-model-preview-path mono">${esc(model.path || model.key)}</div>
      ${model.hfUrl ? `<a class="link" href="${safeHref(model.hfUrl)}" target="_blank" rel="noreferrer">Hugging Face &rarr;</a>` : ""}
    </div>
  `;
}

function buildProfileModalEstimateProfile() {
  return {
    slots: state.profileModal.slots,
    voiceSlots: state.profileModal.voiceSlots,
  };
}

function renderProfileEstimatePanel(profileLike) {
  const estimate = estimateProfileMemoryBytes(profileLike);
  const totalMemory = Number(state.system?.memory?.totalBytes || 0);
  const pressure = totalMemory > 0 && estimate > 0 ? Math.round((estimate / totalMemory) * 100) : null;
  return `
    <div class="profile-estimate-panel">
      <div>
        <span class="profile-estimate-kicker">Estimated RAM occupation</span>
        <strong>${estimate > 0 ? fmtBytes(estimate) : "n/a"}</strong>
      </div>
      <div>
        <span class="profile-estimate-kicker">Budget</span>
        <strong>${pressure != null ? `${pressure}% of ${fmtBytes(totalMemory)}` : "Waiting for model data"}</strong>
      </div>
      <p>This is a rough working-set estimate based on selected LLMs, voice models, runtime family, context window, and parallelism.</p>
    </div>
  `;
}

function renderProfileVoicePanel(type) {
  const slot = getVoiceSlots().find((entry) => entry.type === type) || null;
  const slotId = slot?.id || `voice-${type}-1`;
  const draft = state.profileModal.voiceSlots?.[slotId] || buildProfileVoiceDraft(type);
  const models = getVoiceModels().filter((entry) => entry.type === type);
  const model = models.find((entry) => entry.key === draft.modelKey) || null;
  const sampleRateOptions = type === "tts" ? [22050, 24000, 44100] : [16000];
  const formatOptions = type === "tts" ? ["pcm16", "wav", "mp3", "ogg"] : ["pcm16", "wav"];
  return `
    <section class="profile-voice-card ${type}">
      <div class="profile-voice-card-head">
        <div>
          <h4>${type === "tts" ? "Text to speech" : "Speech to text"}</h4>
          <p>${slot ? `${slot.label} profile settings` : "Voice slot unavailable"}</p>
        </div>
        <label class="checkbox-label modal-flag">
          <input data-profile-voice-input="enabled" data-voice-type="${type}" type="checkbox" ${draft.enabled && draft.modelKey ? "checked" : ""} ${draft.modelKey ? "" : "disabled"} />
          <span>Launch ${type.toUpperCase()}</span>
        </label>
      </div>
      <div class="voice-control-fields profile-voice-fields">
        <label class="field-label field-span-full">
          <span>${type.toUpperCase()} model</span>
          <select data-profile-voice-input="modelKey" data-voice-type="${type}">
            <option value="">Do not start ${type.toUpperCase()}</option>
            ${models.map((entry) => `<option value="${entry.key}" ${entry.key === draft.modelKey ? "selected" : ""}>${esc([entry.label, entry.runtime || "n/a", entry.sizeLabel || "n/a"].join(" · "))}</option>`).join("")}
          </select>
        </label>
        <label class="field-label">
          <span>Audio format</span>
          <select data-profile-voice-input="audioFormat" data-voice-type="${type}">
            ${formatOptions.map((format) => `<option value="${format}" ${draft.audioFormat === format ? "selected" : ""}>${format}</option>`).join("")}
          </select>
        </label>
        <label class="field-label">
          <span>Sample rate</span>
          <select data-profile-voice-input="sampleRate" data-voice-type="${type}">
            ${sampleRateOptions.map((rate) => `<option value="${rate}" ${String(draft.sampleRate) === String(rate) ? "selected" : ""}>${rate} Hz</option>`).join("")}
          </select>
        </label>
        ${type === "tts" && model?.voices?.length ? `
          <label class="field-label">
            <span>Voice</span>
            <select data-profile-voice-input="voiceName" data-voice-type="${type}">
              ${model.voices.map((voice) => `<option value="${esc(voice)}" ${draft.voiceName === voice ? "selected" : ""}>${esc(voice)}</option>`).join("")}
            </select>
          </label>
        ` : `
          <div class="field-label voice-static-field">
            <span>${type === "tts" ? "Voice" : "Language"}</span>
            <div class="voice-static-value">${type === "tts" ? "Model default voice" : "Auto-detect language"}</div>
          </div>
        `}
        ${type === "tts" ? renderVoiceTtsTuningControls(
          model || draft.modelKey,
          draft,
          (field) => `data-profile-voice-input="${field}" data-voice-type="${type}"`
        ) : ""}
        <label class="field-label field-span-full">
          <span>Runtime URL</span>
          <input data-profile-voice-input="runtimeBaseUrl" data-voice-type="${type}" type="text" spellcheck="false" value="${esc(draft.runtimeBaseUrl || "")}" placeholder="${esc(slot ? voiceRuntimeEndpoint(slot) : "")}" />
        </label>
        <label class="checkbox-label modal-flag field-span-full">
          <input data-profile-voice-input="setHermes" data-voice-type="${type}" type="checkbox" ${draft.setHermes ? "checked" : ""} />
          <span>Point Hermes ${type.toUpperCase()} here after apply</span>
        </label>
        <label class="checkbox-label modal-flag field-span-full">
          <input data-profile-voice-input="setHermesM4" data-voice-type="${type}" type="checkbox" ${draft.setHermesM4 ? "checked" : ""} />
          <span>Point Hermes M4 ${type.toUpperCase()} here after apply</span>
        </label>
      </div>
    </section>
  `;
}

function renderProfileModal() {
  if (!els.profileModal || !els.profileModalContent) {
    return;
  }
  const profileModalBody = els.profileModalContent.closest(".modal-body");
  const previousScrollTop = profileModalBody?.scrollTop ?? 0;
  const open = state.profileModal.open;
  els.profileModal.classList.toggle("hidden", !open);
  els.profileModal.setAttribute("aria-hidden", String(!open));
  if (!open) {
    els.profileModalContent.innerHTML = "";
    if (els.profileModalHeaderActions) {
      els.profileModalHeaderActions.innerHTML = "";
    }
    return;
  }

  const activeSlot = getSlot(state.profileModal.activeSlotId) || state.slots[0] || null;
  const draft = activeSlot ? ensureProfileModalSlot(activeSlot.id) : null;
  const model = draft?.modelKey ? getModel(draft.modelKey) : null;
  const activeDraft = activeSlot ? state.profileModal.slots?.[activeSlot.id] || buildProfileSlotDraft(activeSlot.id) : null;
  const defaults = model && activeSlot ? getSlotDefaults(activeSlot, model, activeDraft?.launcher) : {};
  const selectedProfile = getProfileById(state.profileModal.profileId);
  if (els.profileModalHeaderActions) {
    const currentColor = getProfileModalColorValue();
    const draftHsv = hexToHsv(currentColor) || { h: 0, s: 1, v: 1 };
    els.profileModalHeaderActions.innerHTML = `
      <div class="profile-color-picker model-color-picker ${state.profileModal.colorPickerOpen ? "open" : ""}">
        <button class="btn model-color-toggle" type="button" data-profile-color-toggle style="--model-color:${esc(currentColor)}" title="Choose a profile color"></button>
        ${state.profileModal.colorPickerOpen ? `
          <div class="model-color-popover" role="dialog" aria-label="Profile color picker">
            <div class="model-color-wheel-layout">
              <div class="model-color-wheel-shell">
                <canvas class="model-color-wheel" data-profile-color-wheel width="${MODEL_COLOR_WHEEL_SIZE}" height="${MODEL_COLOR_WHEEL_SIZE}"></canvas>
                <div class="model-color-wheel-thumb" data-profile-color-wheel-thumb></div>
              </div>
              <div class="model-color-preview" data-profile-color-preview style="--model-color:${esc(currentColor)}"></div>
            </div>
            <label class="field-label model-color-field">
              <span>Brightness</span>
              <input data-profile-color-value type="range" min="0" max="100" value="${Math.round(draftHsv.v * 100)}" />
            </label>
            <label class="field-label model-color-field">
              <span>Hex color</span>
              <input data-profile-color-draft type="text" spellcheck="false" maxlength="7" value="${esc(state.profileModal.colorDraft || currentColor)}" placeholder="#7c3aed" />
            </label>
            <div class="model-color-actions">
              <button class="btn btn-secondary btn-sm" type="button" data-profile-color-default ${hasCustomProfileColor() ? "" : "disabled"}>Default</button>
              <button class="btn btn-primary btn-sm" type="button" data-profile-color-confirm>Select</button>
            </div>
          </div>
        ` : ""}
      </div>
      <button class="btn btn-secondary btn-sm" type="button" data-profile-reset-model-colors ${hasAnyCustomModelColors() ? "" : "disabled"}>Reset Model Colors</button>
      <button class="btn btn-primary btn-sm" type="button" data-profile-save ${state.actionInFlight ? "disabled" : ""}>Save Profile</button>
    `;
  }
  els.profileModalTitle.textContent = selectedProfile ? `Profile · ${selectedProfile.name}` : "Profiles";
  els.profileModalSubtitle.textContent = selectedProfile
    ? "Edit a saved profile, change its color, or create a new variant."
    : "Build a reusable startup profile, color it, and keep the slot plan mobile-friendly.";

  els.profileModalContent.innerHTML = `
    <div class="profile-modal-layout">
      <div class="profile-picker-row">
        <label class="field-label">
          <span>Edit Saved Profile</span>
          <select data-profile-input="profileId">
            <option value="">New profile</option>
            ${state.profiles.map((profile) => {
              const suffix = [
                profile.id === state.activeProfileId ? "active" : "",
                profile.id === state.defaultProfileId ? "default" : "",
              ].filter(Boolean).join(" · ");
              return `<option value="${esc(profile.id)}" ${profile.id === state.profileModal.profileId ? "selected" : ""}>${esc(profile.name)}${suffix ? ` (${esc(suffix)})` : ""}</option>`;
            }).join("")}
          </select>
        </label>
        <div class="profile-picker-actions">
          ${selectedProfile ? `<span class="profile-color-chip" style="${buildProfileLabelStyle(selectedProfile.color)}">${esc(selectedProfile.name)}</span>` : `<span class="profile-picker-note">New profile</span>`}
          <button class="btn btn-danger" type="button" data-profile-delete ${selectedProfile && !state.actionInFlight ? "" : "disabled"}>Delete</button>
        </div>
      </div>
      <div class="profile-header-fields">
        <label class="field-label">
          <span>Profile Name</span>
          <input data-profile-input="name" type="text" spellcheck="false" value="${esc(state.profileModal.name)}" placeholder="e.g. Hauhau + MXFP4 pair" />
        </label>
        <label class="checkbox-label modal-flag profile-default-toggle">
          <input data-profile-input="isDefault" type="checkbox" ${state.profileModal.isDefault ? "checked" : ""} />
          <span>Start this profile when llm3 boots</span>
        </label>
      </div>
      ${renderProfileEstimatePanel(buildProfileModalEstimateProfile())}
      <div class="profile-tabs">
        ${state.slots.map((slot) => {
          const slotDraft = ensureProfileModalSlot(slot.id);
          const runningCount = slotDraft.enabled && slotDraft.modelKey ? "configured" : "off";
          return `<button class="profile-tab ${slot.id === activeSlot?.id ? "active" : ""}" type="button" data-profile-slot-tab="${slot.id}">${esc(slot.shortLabel)}<span>${esc(runningCount)}</span></button>`;
        }).join("")}
      </div>
      ${activeSlot ? renderProfileSlotPanel(activeSlot, activeDraft || draft, model, defaults) : `<div class="empty-state compact"><p>No slots available.</p></div>`}
      <div class="profile-voice-grid">
        ${renderProfileVoicePanel("tts")}
        ${renderProfileVoicePanel("stt")}
      </div>
    </div>
  `;
  wireProfileColorPicker();
  if (profileModalBody) {
    profileModalBody.scrollTop = previousScrollTop;
  }
}

function renderProfileSlotPanel(slot, draft, model, defaults) {
  const tinyGrammarSupported = supportsTinyGrammar(model);
  const structuredGbnfSupported = supportsStructuredGbnf(model);
  const launcherOptions = getLauncherOptions(model);
  const selectedLauncher = resolvePreferredLauncher(model, draft.launcher);
  const summaryRows = model ? `
    <div class="slot-model-summary">
      <div class="slot-model-summary-header">
        <div>
          <h4>${esc(model.label)}</h4>
          <p>${esc(model.family || "Unknown family")} &middot; ${esc(model.sizeLabel || "n/a")} &middot; ${esc(slot.label)}</p>
        </div>
        <span class="badge badge-runtime">${runtimeLabel(model.runtime)}</span>
      </div>
      <div class="slot-model-summary-grid">
        <div class="detail-row"><span class="detail-label">Profile Context</span><span class="detail-value mono">${fmtCount(draft.ctxSize)}</span></div>
        <div class="detail-row"><span class="detail-label">Profile Parallel</span><span class="detail-value">${NumberFmt(draft.parallel)}</span></div>
        <div class="detail-row"><span class="detail-label">Default Context</span><span class="detail-value mono">${fmtCount(defaults.contextSize || defaults.ctxSize)}</span></div>
        <div class="detail-row"><span class="detail-label">Default Parallel</span><span class="detail-value">${NumberFmt(defaults.parallel)}</span></div>
        <div class="detail-row"><span class="detail-label">Thinking</span><span class="detail-value">${model.supportsThinking && draft.thinking ? "on" : "off"}</span></div>
        <div class="detail-row"><span class="detail-label">Grammar Mode</span><span class="detail-value">${grammarModeLabel(draft)}</span></div>
        <div class="detail-row"><span class="detail-label">Temperature</span><span class="detail-value">${esc(draft.temperature)}</span></div>
        <div class="detail-row"><span class="detail-label">Top P</span><span class="detail-value">${esc(draft.topP)}</span></div>
        <div class="detail-row"><span class="detail-label">Top K</span><span class="detail-value">${esc(draft.topK)}</span></div>
        <div class="detail-row"><span class="detail-label">Min P</span><span class="detail-value">${esc(draft.minP)}</span></div>
        <div class="detail-row"><span class="detail-label">Presence</span><span class="detail-value">${esc(draft.presencePenalty)}</span></div>
        <div class="detail-row"><span class="detail-label">Repetition</span><span class="detail-value">${esc(draft.repetitionPenalty)}</span></div>
        <div class="detail-row"><span class="detail-label">Runtime</span><span class="detail-value">${runtimeLabel(model.runtime)}</span></div>
        <div class="detail-row"><span class="detail-label">Launcher</span><span class="detail-value">${launcherLabel(selectedLauncher)}</span></div>
        <div class="detail-row"><span class="detail-label">Slot</span><span class="detail-value">${esc(slot.label)}</span></div>
        <div class="detail-row"><span class="detail-label">Launch</span><span class="detail-value">${draft.enabled ? "enabled" : "disabled"}</span></div>
      </div>
    </div>` : "";

  return `
    <div class="profile-slot-shell">
      <div class="profile-slot-top">
        <label class="field-label">
          <span>${esc(slot.label)} Model</span>
          <select data-profile-slot-input="modelKey" data-slot-id="${slot.id}" title="${esc(model ? buildProfileModelTitle(model) : "Select a model to inspect its runtime, size, and variant.")}">
            <option value="">Do not start this slot</option>
            ${state.models.map((entry) => `<option value="${esc(entry.key)}" ${entry.key === draft.modelKey ? "selected" : ""}>${esc(buildProfileModelOptionLabel(entry))}</option>`).join("")}
          </select>
        </label>
        <label class="checkbox-label modal-flag">
          <input data-profile-slot-input="enabled" data-slot-id="${slot.id}" type="checkbox" ${draft.enabled && draft.modelKey ? "checked" : ""} ${draft.modelKey ? "" : "disabled"} />
          <span>Launch this slot</span>
        </label>
      </div>
      ${renderProfileModelPreview(model)}
      ${summaryRows}
      ${model ? `
        <div class="launch-controls-row">
          <label class="field-label">
            <span>Launcher</span>
            ${launcherOptions.length > 1
              ? `<select data-profile-slot-input="launcher" data-slot-id="${slot.id}">${launcherOptions.map((launcher) => `<option value="${esc(launcher)}" ${selectedLauncher === launcher ? "selected" : ""}>${esc(launcherLabel(launcher))}</option>`).join("")}</select>`
              : `<div class="launcher-choice-static">${esc(launcherLabel(selectedLauncher))}</div>`}
          </label>
          <label class="field-label">
            <span>Context Window</span>
            <input data-profile-slot-input="ctxSize" data-slot-id="${slot.id}" type="number" min="1" step="1" value="${esc(draft.ctxSize)}" />
          </label>
          <label class="field-label">
            <span>Parallel Requests</span>
            <input data-profile-slot-input="parallel" data-slot-id="${slot.id}" type="number" min="1" step="1" value="${esc(draft.parallel)}" />
          </label>
          <label class="field-label field-span-full">
            <span>Model URL</span>
            <input data-profile-slot-input="runtimeBaseUrl" data-slot-id="${slot.id}" type="text" spellcheck="false" value="${esc(draft.runtimeBaseUrl)}" placeholder="${esc(runtimeEndpoint(slot))}" />
          </label>
        </div>
        <div class="sampling-controls-shell">
          <div class="sampling-controls-header">
            <span class="presets-label">Sampling Defaults</span>
          </div>
          <div class="launch-controls-row sampling-controls-grid">
            <label class="field-label">
              <span>Temperature</span>
              <input data-profile-slot-input="temperature" data-slot-id="${slot.id}" type="number" min="0" step="0.01" value="${esc(draft.temperature)}" />
            </label>
            <label class="field-label">
              <span>Top P</span>
              <input data-profile-slot-input="topP" data-slot-id="${slot.id}" type="number" min="0" max="1" step="0.01" value="${esc(draft.topP)}" />
            </label>
            <label class="field-label">
              <span>Top K</span>
              <input data-profile-slot-input="topK" data-slot-id="${slot.id}" type="number" min="0" step="1" value="${esc(draft.topK)}" />
            </label>
            <label class="field-label">
              <span>Min P</span>
              <input data-profile-slot-input="minP" data-slot-id="${slot.id}" type="number" min="0" max="1" step="0.01" value="${esc(draft.minP)}" />
            </label>
            <label class="field-label">
              <span>Presence Penalty</span>
              <input data-profile-slot-input="presencePenalty" data-slot-id="${slot.id}" type="number" step="0.1" value="${esc(draft.presencePenalty)}" />
            </label>
            <label class="field-label">
              <span>Repetition Penalty</span>
              <input data-profile-slot-input="repetitionPenalty" data-slot-id="${slot.id}" type="number" min="0.01" step="0.01" value="${esc(draft.repetitionPenalty)}" />
            </label>
          </div>
          <div class="field-support-copy">Thinking mode jumps presence penalty to ${PRESENCE_PENALTY_BY_THINKING.enabled.toFixed(1)}. Non-thinking jumps it to ${PRESENCE_PENALTY_BY_THINKING.disabled.toFixed(1)}.</div>
        </div>
        <div class="presets-section">
          <span class="presets-label">Safe Presets</span>
          <div class="preset-buttons">
            ${["131072", "255000", "262144", "524288", "1048576"].map((preset) => `
              <button type="button" class="chip ${String(draft.ctxSize) === preset ? "active" : ""}" data-profile-slot-input="ctxSize" data-slot-id="${slot.id}" data-profile-preset="${preset}">${presetLabel(preset)}</button>
            `).join("")}
          </div>
        </div>
        <div class="tiny-grammar-toggle">
          <label class="checkbox-label">
            <input data-profile-slot-input="enableTinyGrammar" data-slot-id="${slot.id}" type="checkbox" ${tinyGrammarSupported && draft.enableTinyGrammar ? "checked" : ""} ${tinyGrammarSupported ? "" : "disabled"} />
            <span class="tiny-grammar-copy"><strong>Tiny Grammar</strong><span>${tinyGrammarSupported ? "Grammar-constrained CoT for Qwen GGUF models." : "Only available for GGUF models."}</span></span>
          </label>
          <label class="checkbox-label">
            <input data-profile-slot-input="enableStructuredGbnf" data-slot-id="${slot.id}" type="checkbox" ${structuredGbnfSupported && draft.enableStructuredGbnf ? "checked" : ""} ${structuredGbnfSupported ? "" : "disabled"} />
            <span class="tiny-grammar-copy"><strong>Structured GBNF</strong><span>${structuredGbnfSupported ? "Mutually exclusive with Tiny Grammar. Uses the note-106 GOAL / APPROACH / EDGE grammar for Qwen 3.6 35B GGUF models." : "Only available for Qwen 3.6 35B GGUF models."}</span></span>
          </label>
        </div>
        <div class="modal-flags">
          <div class="form-group">
            <label>Sampling Preset</label>
            <select data-profile-slot-sampling-preset data-slot-id="${slot.id}" ${model.supportsThinking ? "" : "disabled"}>
              <option value="nonThinking" ${draft.thinking === false ? "selected" : ""}>Non-thinking (Instruct)</option>
              <option value="thinking" ${draft.thinking === true && (draft.temperature ?? 0.7) >= 0.9 ? "selected" : ""}>Thinking (Standard)</option>
              <option value="thinkingPrecise" ${draft.thinking === true && (draft.temperature ?? 0.7) < 0.9 ? "selected" : ""}>Thinking (Precise Code)</option>
            </select>
            ${model.supportsThinking ? "" : '<span class="help-text">Model does not support thinking mode</span>'}
          </div>
          ${renderProfileApplicationFlagCheckboxes(slot, draft)}
        </div>
      ` : `<div class="profile-slot-disabled-note">Choose a model for ${esc(slot.label)} to include it in the profile.</div>`}
    </div>
  `;
}

function findPreferredSlotId(modelKey) {
  const idleSlot = state.slots.find((slot) => !slot.status?.running);
  if (idleSlot) {
    return idleSlot.id;
  }
  const runningSameModelSlot = state.slots.find((slot) => slot.status?.running && slot.status?.model?.key === modelKey);
  if (runningSameModelSlot) {
    return runningSameModelSlot.id;
  }
  return state.slots[0]?.id || "slot1";
}

function buildLaunchButtonTitle(model) {
  const slot = getSlot(findPreferredSlotId(model?.key));
  const launcher = getLauncherOptions(model)[0] || model?.launcher || model?.runtime || "gguf";
  const slotLabel = slot?.label || "the first slot";
  return `Launch ${model?.label || "model"} into ${slotLabel} using ${launcherLabel(launcher)} defaults. Open settings to choose a different slot or launcher.`;
}

// "gguf" as a RUNTIME is not the same as "llama.cpp as a launcher": ds4 serves a
// GGUF too, and none of the llama.cpp extras below (tiny grammar, structured
// GBNF, DRY, reasoning budget, chat-template override) exist in it. Showing
// those controls for a ds4 model gives a switch that silently does nothing.
function supportsTinyGrammar(model) {
  if (String(model?.launcher || "").toLowerCase() === "ds4") {
    return false;
  }
  return String(model?.runtime || model?.launcher || "").toLowerCase() === "gguf";
}

function supportsStructuredGbnf(model) {
  if (!supportsTinyGrammar(model)) {
    return false;
  }
  const aliases = Array.isArray(model?.aliases) ? model.aliases.join(" ") : "";
  const haystack = `${model?.key || ""} ${model?.label || ""} ${model?.family || ""} ${model?.path || ""} ${aliases}`.toLowerCase();
  return haystack.includes("qwen") && haystack.includes("3.6") && (haystack.includes("35b") || haystack.includes("a3b"));
}

function supportsReasoningBudget(model) {
  return supportsTinyGrammar(model);
}

// Families that ship an MTP head inside the weights with no "MTP" in the file
// name (Qwen3.8 carries blk.N.nextn.*). bin/qwen_llama confirms this for real by
// reading the GGUF before it passes --spec-type; this list only decides whether
// the draft-depth control is worth showing.
const EMBEDDED_MTP_PATTERNS = [/qwen\s*3\.?8/];

function supportsMtpDraftTuning(model) {
  // ds4 has its own MTP head and takes the same depth control (--mtp-draft), so
  // it keeps this field even though it has no other llama.cpp extra.
  if (String(model?.launcher || "").toLowerCase() === "ds4") {
    return true;
  }
  if (!supportsTinyGrammar(model)) {
    return false;
  }
  const aliases = Array.isArray(model?.aliases) ? model.aliases.join(" ") : "";
  const haystack = `${model?.key || ""} ${model?.label || ""} ${model?.family || ""} ${model?.path || ""} ${aliases}`.toLowerCase();
  return haystack.includes("mtp")
    || haystack.includes("speculative")
    || EMBEDDED_MTP_PATTERNS.some((pattern) => pattern.test(haystack));
}

const DSPARK_MODES = ["auto", "dflash", "dspark", "lookup", "baseline"];
// "" = leave the model's chat template alone (Qwen3.8's own asks for xhigh).
// "off" sends --no-thinking; the levels send --reasoning-effort.
// No "high": Qwen3.8's chat template rejects it outright (TemplateError), so it is
// not a valid choice even though mlx-dspark's CLI would accept the string.
const DSPARK_REASONING_EFFORTS = ["", "off", "low", "medium", "xhigh"];
const DSPARK_REASONING_LABELS = {
  "": "Model default (= Extra high)",
  off: "Off (no thinking)",
  low: "Low (brief thinking)",
  medium: "Medium (unguided)",
  xhigh: "Extra high",
};
const DSPARK_MODE_LABELS = {
  auto: "Auto (best for model)",
  dflash: "DFlash 2",
  dspark: "DSpark",
  lookup: "Lookup (n-gram)",
  baseline: "None (no speculation)",
};

function normalizeSpeedTrickSelection(model, source = {}) {
  const budgetRaw = Number.parseInt(String(source.reasoningBudget ?? ""), 10);
  const reasoningBudget = supportsReasoningBudget(model) && Number.isInteger(budgetRaw) && budgetRaw >= -1
    ? budgetRaw
    : null;
  const draftRaw = Number.parseInt(String(source.mtpDraftMax ?? ""), 10);
  const mtpDraftMax = supportsMtpDraftTuning(model) && Number.isInteger(draftRaw) && draftRaw >= 1 && draftRaw <= 16
    ? draftRaw
    : null;
  // Blank = let bin/qwen_llama use its own default (512), so the field is opt-in.
  const ubatchRaw = Number.parseInt(String(source.ubatchSize ?? ""), 10);
  const ubatchSize = supportsTinyGrammar(model) && Number.isInteger(ubatchRaw) && ubatchRaw >= 1 && ubatchRaw <= 8192
    ? ubatchRaw
    : null;
  // mlx-dspark speculation head. Blank/auto = let its registry pick the measured-best
  // for the target (DFlash 2 on Qwen3.8-27B-8bit). Only the mlx-dspark launcher reads it.
  const dsparkMode = DSPARK_MODES.includes(String(source.dsparkMode ?? "").trim().toLowerCase())
    ? String(source.dsparkMode).trim().toLowerCase()
    : "auto";
  const effortRaw = String(source.reasoningEffort ?? "").trim().toLowerCase();
  const reasoningEffort = DSPARK_REASONING_EFFORTS.includes(effortRaw) ? effortRaw : "";
  return {
    reasoningBudget,
    enableDry: supportsTinyGrammar(model) ? Boolean(source.enableDry) : false,
    mtpDraftMax,
    ubatchSize,
    dsparkMode,
    reasoningEffort,
  };
}

function normalizeGrammarSelection(model, source = {}) {
  const enableStructuredGbnf = supportsStructuredGbnf(model) ? Boolean(source.enableStructuredGbnf) : false;
  const enableTinyGrammar = supportsTinyGrammar(model) ? Boolean(source.enableTinyGrammar) && !enableStructuredGbnf : false;
  return { enableTinyGrammar, enableStructuredGbnf };
}

function grammarModeLabel(source = {}) {
  if (source.enableStructuredGbnf) {
    return "structured GBNF";
  }
  if (source.enableTinyGrammar) {
    return "tiny grammar";
  }
  return "off";
}

function createLaunchForm(slotId, model) {
  const slot = getSlot(slotId);
  const launcherOptions = getLauncherOptions(model);
  const selectedLauncher = resolvePreferredLauncher(model, model?.preferredLauncher || state.preferredLaunchers?.[model?.key]);
  const defaults = getSlotDefaults(slot, model, selectedLauncher);
  const grammarSelection = normalizeGrammarSelection(model, defaults);
  const speedTricks = normalizeSpeedTrickSelection(model, defaults);
  return {
    ctxSize: String(defaults.contextSize || defaults.ctxSize || 255000),
    parallel: String(defaults.parallel || 1),
    thinking: model?.supportsThinking ? Boolean(defaults.thinking) : false,
    runtimeBaseUrl: String(slot?.configuredRuntimeBaseUrl || "").trim(),
    ...grammarSelection,
    reasoningBudget: speedTricks.reasoningBudget === null ? "" : String(speedTricks.reasoningBudget),
    enableDry: speedTricks.enableDry,
    mtpDraftMax: speedTricks.mtpDraftMax === null ? "" : String(speedTricks.mtpDraftMax),
    ubatchSize: speedTricks.ubatchSize === null ? "" : String(speedTricks.ubatchSize),
    dsparkMode: speedTricks.dsparkMode,
    reasoningEffort: speedTricks.reasoningEffort,
    chatTemplate: String(model?.chatTemplate?.selected || ""),
    ...buildDefaultSamplingForm({
      temperature: defaults.temperature,
      topP: defaults.topP,
      topK: defaults.topK,
      minP: defaults.minP,
      presencePenalty: defaults.presencePenalty,
      repetitionPenalty: defaults.repetitionPenalty,
    }),
    launcher: String(selectedLauncher || model?.launcher || launcherOptions[0] || "gguf"),
    ...buildApplicationFlagStateFromSlot(slot),
  };
}

function buildDefaultLaunchForm(slot, model) {
  const launcherOptions = getLauncherOptions(model);
  const selectedLauncher = resolvePreferredLauncher(model, model?.preferredLauncher || state.preferredLaunchers?.[model?.key]);
  const defaults = getSlotDefaults(slot, model, selectedLauncher);
  const grammarSelection = normalizeGrammarSelection(model, defaults);
  return {
    ctxSize: String(defaults.contextSize || defaults.ctxSize || 255000),
    parallel: String(defaults.parallel || 1),
    thinking: model?.supportsThinking ? Boolean(defaults.thinking) : false,
    runtimeBaseUrl: String(slot?.configuredRuntimeBaseUrl || "").trim(),
    chatTemplate: String(model?.chatTemplate?.selected || ""),
    ...grammarSelection,
    ...buildDefaultSamplingForm({
      temperature: defaults.temperature,
      topP: defaults.topP,
      topK: defaults.topK,
      minP: defaults.minP,
      presencePenalty: defaults.presencePenalty,
      repetitionPenalty: defaults.repetitionPenalty,
    }),
    launcher: String(selectedLauncher || model?.launcher || launcherOptions[0] || "gguf"),
    ...buildApplicationFlagStateFromSlot(slot),
  };
}

function getApplicationFlagByField(fieldName) {
  return LLM_APPLICATION_FLAGS.find((flag) => flag.field === fieldName || flag.legacyField === fieldName) || null;
}

function getApplicationFlagValue(source, flag, fallback = {}) {
  if (Object.prototype.hasOwnProperty.call(source || {}, flag.field)) {
    return Boolean(source?.[flag.field]);
  }
  if (flag.legacyField && Object.prototype.hasOwnProperty.call(source || {}, flag.legacyField)) {
    return Boolean(source?.[flag.legacyField]);
  }
  return Boolean(fallback?.[flag.field]);
}

function buildApplicationFlagStateFromSlot(slot) {
  return Object.fromEntries(
    LLM_APPLICATION_FLAGS.map((flag) => [
      flag.field,
      Boolean(
        slot?.applicationTargets?.[flag.appKey]
        || (flag.appKey === "hermes" && slot?.integrationTargets?.hermes)
        || (flag.appKey === "claudecode" && slot?.integrationTargets?.openclaude)
        || (flag.appKey === "librechat" && slot?.integrationTargets?.chat)
      ),
    ])
  );
}

function appOwnerSlotLabel(slotId) {
  const id = String(slotId || "").trim();
  return getSlot(id)?.label || id;
}

function renderApplicationFlagCheckboxes(form) {
  // Only the per-slot entry point flags conflicts: a per-model save explicitly
  // overrides whatever was routed before, so it needs no warning.
  const showConflicts = state.modal.entryPoint === "slot";
  const currentSlotId = state.modal.slotId;
  return LLM_APPLICATION_FLAGS.map((flag) => {
    const ownerSlotId = String(state.applicationTargets?.[flag.appKey] || "").trim();
    const conflict = showConflicts && ownerSlotId && ownerSlotId !== currentSlotId;
    const marker = conflict
      ? `<span class="modal-flag-conflict" title="Currently configured on ${esc(appOwnerSlotLabel(ownerSlotId))}. Launching here takes it over.">on ${esc(appOwnerSlotLabel(ownerSlotId))}</span>`
      : "";
    return `
    <label class="checkbox-label modal-flag${conflict ? " modal-flag--conflict" : ""}">
      <input data-modal-input="${flag.field}" type="checkbox" ${form[flag.field] ? "checked" : ""} />
      <span>${esc(flag.label)}</span>
      ${marker}
    </label>
  `;
  }).join("");
}

// Compact chip variant of the same flags, used by the launch modal's routing card.
// Same data-modal-input wiring as renderApplicationFlagCheckboxes -- only the shell differs.
function renderApplicationFlagToggle(flag, form) {
  const showConflicts = state.modal.entryPoint === "slot";
  const currentSlotId = state.modal.slotId;
  const ownerSlotId = String(state.applicationTargets?.[flag.appKey] || "").trim();
  const conflict = showConflicts && ownerSlotId && ownerSlotId !== currentSlotId;
  const ownerLabel = conflict ? appOwnerSlotLabel(ownerSlotId) : "";
  const spans = (flag.alsoOn || []).map(machineLabel).filter(Boolean);
  const title = conflict
    ? `Currently configured on ${ownerLabel}. Launching here takes it over.`
    : spans.length
      ? `${flag.label} — also updates ${spans.join(", ")}.`
      : flag.label;
  return `
    <label class="lc-toggle${conflict ? " is-conflict" : ""}" title="${esc(title)}">
      <input data-modal-input="${flag.field}" type="checkbox" ${form[flag.field] ? "checked" : ""} />
      <span class="lc-toggle-box"></span>
      <span class="lc-toggle-text">${esc(flag.label)}</span>
      ${spans.length ? `<span class="lc-toggle-also">+${esc(spans.join("/"))}</span>` : ""}
      ${conflict ? `<span class="lc-toggle-warn">${esc(ownerLabel)}</span>` : ""}
    </label>
  `;
}

// Only rendered for models the server offers alternatives for (currently the
// Qwen3.8 27B GGUFs); everything else keeps the model's own template silently.
function renderChatTemplateControl(model, form) {
  const spec = model?.chatTemplate;
  if (!spec || !Array.isArray(spec.options) || spec.options.length < 2) {
    return "";
  }
  const selected = resolveFormChatTemplate(model, form);
  const active = spec.options.find((option) => option.key === selected);
  const isOverride = selected && selected !== "model-default";
  return `
    <div class="lc-rule"></div>
    <div class="lc-control-row">
      <span class="lc-control-label" title="${esc(active?.description || "Jinja chat template passed to llama.cpp as --chat-template-file.")}">
        Chat template${spec.saved ? "" : isOverride ? ` <em class="lc-hint">default</em>` : ""}
      </span>
      <select class="lc-select-inline" data-modal-input="chatTemplate">
        ${spec.options.map((option) => `
          <option value="${esc(option.key)}" ${option.key === selected ? "selected" : ""} title="${esc(option.description || "")}">${esc(option.label)}${option.source ? ` (${esc(option.source)})` : ""}</option>
        `).join("")}
      </select>
    </div>
  `;
}

function getApplicationMachines() {
  const served = state.applicationMachines;
  return Array.isArray(served) && served.length ? served : LLM_APPLICATION_MACHINES;
}

function renderSlotNameField(slot) {
  const pending = state.modal.slotNameDraft;
  const value = pending == null ? customSlotName(slot) : pending;
  const scope = getProfileById(state.activeProfileId);
  return `
    <label class="lc-field lc-slot-name">
      <span class="lc-field-label" title="${esc(scope
        ? `Saved in the ${scope.name} profile, so switching profiles switches the name.`
        : "Saved for every profile, because none is applied.")}">Slot name</span>
      <input
        type="text"
        maxlength="40"
        data-modal-slot-name
        value="${esc(value)}"
        placeholder="${esc(slot.defaultName || slot.label || "Slot name")}"
      />
      <span class="lc-field-note">${esc(scope ? `stored in profile ${scope.name}` : "stored globally")}</span>
    </label>
  `;
}

function machineLabel(machineKey) {
  return getApplicationMachines().find((entry) => entry.key === machineKey)?.label || "";
}

// One column per machine, so it is obvious which boxes a launch reaches out to.
function renderApplicationFlagMachineGroups(form) {
  return getApplicationMachines().map((machine) => {
    const flags = LLM_APPLICATION_FLAGS.filter((flag) => flag.machine === machine.key);
    if (!flags.length) {
      return "";
    }
    const onCount = flags.filter((flag) => Boolean(form[flag.field])).length;
    return `
      <div class="lc-machine${onCount ? " has-on" : ""}">
        <div class="lc-machine-head" title="${esc(machine.host)}">
          <span class="lc-machine-name">${esc(machine.label)}</span>
          <span class="lc-machine-count">${onCount}/${flags.length}</span>
        </div>
        <div class="lc-toggles">
          ${flags.map((flag) => renderApplicationFlagToggle(flag, form)).join("")}
        </div>
      </div>
    `;
  }).join("");
}

function renderProfileApplicationFlagCheckboxes(slot, draft) {
  return LLM_APPLICATION_FLAGS.map((flag) => {
    // Within the profile a slot conflicts if another slot's draft already claims the app.
    const otherSlot = state.slots.find((entry) => entry.id !== slot.id
      && Boolean(state.profileModal.slots?.[entry.id]?.[flag.field]));
    const conflict = Boolean(otherSlot);
    const marker = conflict
      ? `<span class="modal-flag-conflict" title="Already set on ${esc(otherSlot.label)} in this profile. Both can't own it; the last applied wins.">on ${esc(otherSlot.label)}</span>`
      : "";
    return `
    <label class="checkbox-label modal-flag${conflict ? " modal-flag--conflict" : ""}">
      <input data-profile-slot-input="${flag.field}" data-slot-id="${slot.id}" type="checkbox" ${draft[flag.field] ? "checked" : ""} />
      <span>${esc(flag.label)}</span>
      ${marker}
    </label>
  `;
  }).join("");
}

function buildApplicationTargetRequest(form) {
  const payload = {};
  for (const flag of LLM_APPLICATION_FLAGS) {
    payload[flag.appKey] = Boolean(form[flag.field]);
  }
  return payload;
}

function ensureModalForm() {
  if (!state.modal.form) {
    state.modal.form = createLaunchForm(state.modal.slotId, getModel(state.modal.modelKey));
  }
  return state.modal.form;
}

function applyModalPreset(presetValue) {
  const preset = String(presetValue || "").trim();
  if (!preset) {
    return;
  }

  state.modal.form = {
    ...ensureModalForm(),
    ctxSize: preset,
  };

  const ctxInput = els.launchModalContent.querySelector('input[data-modal-input="ctxSize"]');
  if (ctxInput) {
    ctxInput.value = preset;
  }

  renderLaunchModal();
}

window.applyModalPreset = applyModalPreset;

function resolvePreferredLauncher(model, candidate) {
  const options = getLauncherOptions(model);
  const selected = String(candidate || model?.preferredLauncher || state.preferredLaunchers?.[model?.key] || model?.launcher || "").trim();
  return options.includes(selected) ? selected : options[0] || model?.runtime || "gguf";
}

function getSlotDefaults(slot, model, launcher = "") {
  if (!slot || !model) {
    return {};
  }
  const selectedLauncher = String(launcher || "").trim();
  return (selectedLauncher ? slot.defaults?.[selectedLauncher] : null)
    || slot.defaults?.[model.preferredLauncher]
    || slot.defaults?.[model.runtime]
    || {};
}

function buildDefaultIntegrationTargets() {
  const applicationTargets = buildDefaultApplicationTargets();
  return {
    hermes: applicationTargets.hermes,
    openclaude: applicationTargets.claudecode,
    chat: applicationTargets.librechat,
  };
}

function buildDefaultApplicationTargets() {
  const fallback = state.slots[0]?.id || "slot1";
  return Object.fromEntries(ALL_APPLICATION_DEFINITIONS.map((application) => {
    if (application.slotKind === "voice") {
      const voiceFallback = application.key === "voicetts"
        ? state.voiceSlots.find((slot) => slot.type === "tts")?.id || "voice-tts-1"
        : state.voiceSlots.find((slot) => slot.type === "stt")?.id || "voice-stt-2";
      return [application.key, voiceFallback];
    }
    return [application.key, fallback];
  }));
}

function buildApplicationItems() {
  return APPLICATION_DEFINITIONS.map((application) => ({
    key: application.key,
    label: application.label,
    badgeLabel: application.badgeLabel,
    slotId: state.applicationTargets[application.key] || state.slots[0]?.id || "slot1",
  }));
}

function syncApplicationDrafts() {
  const serverTargets = state.applicationTargets || buildDefaultApplicationTargets();
  ALL_APPLICATION_DEFINITIONS.forEach((application) => {
    const key = application.key;
    const isVoiceApp = isVoiceApplication(key);
    const slots = isVoiceApp ? state.voiceSlots : state.slots;
    const fallback = isVoiceApp
      ? (application.key === "voicetts"
        ? slots.find((slot) => slot.type === "tts")?.id || "voice-tts-1"
        : slots.find((slot) => slot.type === "stt")?.id || "voice-stt-2")
      : slots[0]?.id || "slot1";
    if (!state.applicationDirty[key] || !((isVoiceApp ? getVoiceSlot : getSlot)(state.applicationDrafts[key]))) {
      state.applicationDrafts[key] = serverTargets[key] || fallback;
      state.applicationDirty[key] = false;
    }
  });
}

async function runSaveApplicationTarget(applicationKey) {
  const isVoiceApp = isVoiceApplication(applicationKey);
  const getSlotFn = isVoiceApp ? getVoiceSlot : getSlot;
  const endpoint = `/api/applications/${applicationKey}`;
  const slotId = state.applicationDrafts[applicationKey] || state.applicationTargets[applicationKey];
  const slot = getSlotFn(slotId);
  if (!slot?.status?.running) {
    toast(`${slot?.label || "Selected slot"} is idle`);
    return;
  }

  const result = await runAction(endpoint, { slotId });
  if (result) {
    state.applicationDirty[applicationKey] = false;
    state.applicationDrafts[applicationKey] = slotId;
    renderApplications();
  }
}

function applicationDescription(applicationKey) {
  return ALL_APPLICATION_DEFINITIONS.find((application) => application.key === applicationKey)?.description || "";
}

function isVoiceApplication(applicationKey) {
  return ALL_APPLICATION_DEFINITIONS.find((application) => application.key === applicationKey)?.slotKind === "voice";
}

function toggleModelSort(field) {
  const nextField = String(field || "name");
  if (state.modelSort.field === nextField) {
    state.modelSort.direction = state.modelSort.direction === "asc" ? "desc" : "asc";
    return;
  }
  state.modelSort.field = nextField;
  state.modelSort.direction = nextField === "size" ? "desc" : "asc";
}

function getFilteredModels() {
  const filter = state.activeFilter;
  let filtered = state.models;
  if (filter === "gguf" || filter === "mlx" || filter === "dflash") {
    filtered = filtered.filter((model) => model.runtime === filter);
  } else {
    const familyMatch = filter.match(/^family:(.+)$/);
    if (familyMatch) {
      filtered = filtered.filter((model) => model.family === familyMatch[1]);
    }
  }

  const query = String(state.modelSearch || "").trim().toLowerCase();
  if (query) {
    filtered = filtered.filter((model) => modelMatchesSearch(model, query));
  }

  return sortModels(filtered);
}

function modelMatchesSearch(model, query) {
  const haystack = [
    model.label,
    model.family,
    model.runtime,
    model.quantization,
    model.sizeLabel,
    model.path,
    model.key,
    ...(Array.isArray(model.aliases) ? model.aliases : []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

function sortModels(models) {
  const { field, direction } = state.modelSort;
  const multiplier = direction === "desc" ? -1 : 1;
  return [...models].sort((left, right) => {
    if (field === "size") {
      return multiplier * ((modelSizeValue(left) - modelSizeValue(right)) || String(left.label || "").localeCompare(String(right.label || "")));
    }
    const leftValue = modelSortValue(left, field);
    const rightValue = modelSortValue(right, field);
    return multiplier * (leftValue.localeCompare(rightValue) || String(left.label || "").localeCompare(String(right.label || "")));
  });
}

function modelSortValue(model, field) {
  if (field === "runtime") {
    return String(model.runtime || "");
  }
  if (field === "family") {
    return String(model.family || "");
  }
  if (field === "variant") {
    return String(model.quantization || getModelVariant(model) || "");
  }
  return String(model.label || model.key || "");
}

function modelSizeValue(model) {
  const sizeBytes = Number(model?.sizeBytes || 0);
  if (Number.isFinite(sizeBytes) && sizeBytes > 0) {
    return sizeBytes;
  }

  const label = String(model?.sizeLabel || "").trim().toUpperCase();
  const byteMatch = label.match(/([\d.]+)\s*(TIB|GIB|MIB|KIB|TB|GB|MB|KB|B)\b/);
  if (byteMatch) {
    const unit = byteMatch[2];
    const multipliers = {
      B: 1,
      KB: 1000,
      MB: 1000 ** 2,
      GB: 1000 ** 3,
      TB: 1000 ** 4,
      KIB: 1024,
      MIB: 1024 ** 2,
      GIB: 1024 ** 3,
      TIB: 1024 ** 4,
    };
    return Number(byteMatch[1]) * multipliers[unit];
  }

  const paramMatch = label.match(/([\d.]+)\s*([TBMK])\b/);
  if (paramMatch) {
    const unit = paramMatch[2];
    const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
    return Number(paramMatch[1]) * multipliers[unit];
  }

  const numericMatch = label.match(/([\d.]+)/);
  return numericMatch ? Number(numericMatch[1]) : 0;
}

function ensureLogState(slotId, kind) {
  if (!state.logs[slotId]) {
    state.logs[slotId] = {};
  }
  if (!state.logs[slotId][kind]) {
    state.logs[slotId][kind] = kind === "traffic"
      ? { offset: 0, entries: [] }
      : { offset: 0, text: "" };
  }
  return state.logs[slotId][kind];
}

function resetLogBuffers() {
  state.logs = {};
  state.slots.forEach((slot) => {
    ensureLogState(slot.id, "traffic");
    ensureLogState(slot.id, "server");
    ensureLogState(slot.id, "proxy");
    ensureLogState(slot.id, "thinking");
    ensureLogState(slot.id, "llm3");
  });
}

function getSlot(slotId) {
  return state.slots.find((slot) => slot.id === slotId) || null;
}

// The Models tab's shortcut into the Logs tab: pick the slot, then show it.
function openSlotLogs(slotId, kind = "") {
  const slot = getSlot(String(slotId || ""));
  if (!slot) {
    return;
  }
  state.activeLogSlotId = slot.id;
  if (kind) {
    state.activeLogKind = kind;
  } else if (state.activeLogKind === "llm3") {
    // The llm3 log is not per slot, so landing on it would ignore the slot the
    // user just double-clicked.
    state.activeLogKind = "server";
  }
  setActiveSection("logs");
  renderLogTabs();
  renderLogs();
}

function customSlotName(slot) {
  const name = String(slot?.name || "").trim();
  return name && name !== String(slot?.defaultName || "").trim() ? name : "";
}

function slotName(slot) {
  return String(slot?.name || "").trim() || String(slot?.label || "").trim() || "Slot";
}

function getVoiceSlot(slotId) {
  const voiceSlots = Array.isArray(state.voiceSlots) ? state.voiceSlots : [];
  return voiceSlots.find((slot) => slot.id === slotId) || null;
}

function getModel(modelKey) {
  return state.models.find((model) => model.key === modelKey) || null;
}

function renderGlobalActionButtons() {
  setGlobalActionButtonsDisabled(Boolean(state.actionInFlight));
}

function updateTopbarSpinner() {
  const spinning = Boolean(state.actionInFlight);
  [els.topbarBusyIndicator, els.topbarBusyIndicatorMobile, els.topbarBusyIndicatorFloating].forEach((indicator) => {
    if (indicator) {
      const spinner = indicator.querySelector('.topbar-busy-spinner');
      if (spinner) {
        spinner.classList.toggle('spinning', spinning);
      }
    }
  });
}

function setGlobalActionButtonsDisabled(disabled) {
  [
    els.refreshBtn,
    els.launchersBtn,
    els.restartLlm3Btn,
    els.refreshBtnMobile,
    els.profileManageBtn,
    els.profileManageBtnMobile,
    els.restartTargetBtn,
    els.restartTargetSelect,
    els.restartHermesBtnMobile,
    els.restartVoiceBtnMobile,
  ].forEach((button) => {
    if (button) {
      button.disabled = disabled;
    }
  });
  [els.stopBtn, els.stopBtnMobile].forEach((button) => {
    if (button) {
      button.disabled = false;
    }
  });
  updateTopbarSpinner();
  updateSlotWorkingIndicators();
}

async function refreshSlotActivity() {
  // Cheap enough to poll at 1s (localhost /metrics per slot); the spinner is
  // useless if it lags the generation it is meant to be reporting.
  try {
    const data = await fetchJson("/api/slots/activity");
    state.slotActivity = data?.activity || {};
  } catch (_error) {
    // A failed probe must not strand the ring spinning: treat unknown as idle.
    state.slotActivity = {};
  }
  updateSlotWorkingIndicators();
  renderChatLive();
}

// Keeps the last measured rate visible after a generation ends, marked stale, so the
// card does not blink to empty between agent turns. A stale number is dimmed and says
// so on hover — it is never presented as the live rate.
const slotLastTokensPerSecond = new Map();

const SLOT_PHASE_TEXT = {
  prefill: "reading the prompt",
  decode: "generating",
};

function updateSlotThroughputReadout(slot, activity) {
  const live = Number(activity?.tokensPerSecond);
  const busy = activity?.busy === true;
  const phase = activity?.phase || null;
  const hasLive = Number.isFinite(live) && live > 0;
  if (hasLive) {
    slotLastTokensPerSecond.set(slot.id, { rate: live, phase });
  }
  const last = slotLastTokensPerSecond.get(slot.id);
  const shown = hasLive ? live : last?.rate;
  const shownPhase = hasLive ? phase : last?.phase;
  const stale = !(busy && hasLive);

  document.querySelectorAll(`[data-slot-id="${slot.id}"]`).forEach((card) => {
    const pill = card.querySelector("[data-slot-tps]");
    if (pill) {
      const empty = !Number.isFinite(shown);
      // is-empty hides it with `visibility`, keeping its box: switching `display`
      // here would resize the card and shove the whole table below it.
      pill.classList.toggle("is-empty", empty);
      pill.textContent = empty ? "0.0 tok/s" : `${shown.toFixed(1)} tok/s`;
      pill.classList.toggle("stale", stale);
      pill.title = empty
        ? ""
        : (stale
          ? "Last measured rate. The slot is not working now."
          : (shownPhase === "prefill"
            ? "Prompt-processing speed right now."
            : "Generation speed right now."));
    }

    const line = card.querySelector("[data-slot-activity]");
    if (!line) return;
    // Busy with no phase yet = the runtime says it is working but no counter has moved
    // inside the window. Say "working", not a phase we have not actually observed.
    const label = busy ? (SLOT_PHASE_TEXT[phase] || "working") : "";
    line.classList.toggle("is-empty", !label);
    // A non-breaking space keeps the line box even when there is nothing to say, so
    // the card height is identical idle and busy.
    line.textContent = label || "\u00a0";
    if (!label) {
      line.title = "";
      return;
    }
    line.title = phase === "prefill"
      ? "Processing the prompt. No tokens are generated yet."
      : phase === "decode"
        ? "Generating the reply."
        : "The runtime reports a request in flight.";
  });
}

function updateSlotWorkingIndicators() {
  state.slots.forEach((slot) => {
    updateSlotThroughputReadout(slot, state.slotActivity?.[slot.id]);
    // "Working" means the model is generating right now, which is what
    // /api/slots/activity reports (llama.cpp's requests_processing, with a
    // traffic-log fallback). It deliberately does NOT include "a model is
    // loaded" -- that was the old `slot.status.running` term, and because it is
    // true for the entire life of a slot the ring simply span forever.
    const shouldShow = state.slotActivity?.[slot.id]?.busy === true;

    const cards = document.querySelectorAll(`[data-slot-id="${slot.id}"]`);
    cards.forEach((card) => {
      const indicator = card.querySelector('.models-slot-working-indicator');
      if (indicator) {
        indicator.classList.toggle('working', shouldShow);
      }
    });
  });
}

function runtimeEndpoint(slot) {
  const configured = String(slot?.configuredRuntimeBaseUrl || "").trim();
  if (configured) {
    return configured;
  }
  const host = runtimeHost();
  return `http://${host}:${slot.publicPort}/v1`;
}

function voiceRuntimeEndpoint(slot) {
  const configured = String(slot?.configuredRuntimeBaseUrl || "").trim();
  if (configured) {
    return configured;
  }
  return `http://${runtimeHost()}:${slot.publicPort}`;
}

function voiceModelEndpoint(model) {
  return `http://${runtimeHost()}:${model.publicPort}`;
}

function runtimeHost() {
  return window.location.hostname || "127.0.0.1";
}

function updateConnectionStatus(connected) {
  const badge = els.connectionStatus;
  if (!badge) {
    return;
  }
  badge.classList.toggle("connected", connected);
  const text = badge.querySelector(".status-text");
  if (text) {
    text.textContent = connected ? "connected" : "disconnected";
  }
}

function toast(message, options = {}) {
  els.toast.textContent = String(message || "");
  els.toast.classList.remove("hidden", "error", "success");
  if (options.type === "error") {
    els.toast.classList.add("error");
  } else if (options.type === "success") {
    els.toast.classList.add("success");
  }
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    els.toast.classList.add("hidden");
    els.toast.classList.remove("error", "success");
  }, Number(options.duration) > 0 ? Number(options.duration) : 2500);
}

// showToast(message, durationMs) has been called from the Websites and PM2
// error paths since they were written, but was never defined -- every one of
// those calls threw "showToast is not defined" instead of showing the message,
// which is why a failed port change or PM2 cap update looked like it did
// nothing. Same call sites, now with the function they expect.
function showToast(message, durationMs) {
  toast(message, Number(durationMs) > 0 ? { duration: Number(durationMs) } : {});
}

function buildLaunchRequestPayload(slot, model, form) {
  const grammarSelection = normalizeGrammarSelection(model, form);
  const speedTricks = normalizeSpeedTrickSelection(model, form);
  return {
    slotId: slot.id,
    modelKey: model.key,
    ctxSize: Number(form.ctxSize),
    parallel: Number(form.parallel),
    thinking: model.supportsThinking ? Boolean(form.thinking) : false,
    applicationTargets: buildApplicationTargetRequest(form),
    ...grammarSelection,
    ...speedTricks,
    temperature: Number(form.temperature),
    topP: Number(form.topP),
    topK: Number(form.topK),
    minP: Number(form.minP),
    presencePenalty: Number(form.presencePenalty),
    repetitionPenalty: Number(form.repetitionPenalty),
    chatTemplate: resolveFormChatTemplate(model, form),
    launcher: form.launcher || model.launcher || getLauncherOptions(model)[0] || "gguf",
  };
}

// "" means the model has no alternatives; the server then keeps the model default.
function resolveFormChatTemplate(model, form) {
  const options = model?.chatTemplate?.options;
  if (!Array.isArray(options) || !options.length) {
    return "";
  }
  const selected = String(form?.chatTemplate || "").trim();
  return options.some((option) => option.key === selected)
    ? selected
    : String(model.chatTemplate.selected || "");
}

function loadPersistedModelColors() {
  try {
    const raw = localStorage.getItem("llm3.modelColors");
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [String(key || "").trim(), normalizeHexColor(value)])
        .filter(([key, value]) => key && value)
    );
  } catch (_error) {
    return {};
  }
}

function persistModelColors() {
  try {
    localStorage.setItem("llm3.modelColors", JSON.stringify(state.modelColors || {}));
  } catch (_error) {
    // Ignore persistence failures so the UI still works in private mode.
  }
}

function normalizeHexColor(value) {
  const match = String(value || "").trim().match(/^#?([0-9a-f]{6})$/i);
  return match ? `#${match[1].toLowerCase()}` : "";
}

function getDefaultRuntimeColor(runtime) {
  if (runtime === "mlx") return "#8b5cf6";
  if (runtime === "dflash") return "#fb923c";
  return "#22d3ee";
}

function rgbaCss(rgb, alpha) {
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${Math.max(0, Math.min(1, Number(alpha) || 0))})`;
}

function getReadableForegroundColor(color) {
  const rgb = hexToRgb(color);
  if (!rgb) {
    return "";
  }
  const hsp = Math.sqrt(
    0.299 * rgb.r ** 2 +
    0.587 * rgb.g ** 2 +
    0.114 * rgb.b ** 2
  );
  return hsp > 127.5 ? "#000000" : "#ffffff";
}

function getModelColorValue(model) {
  return normalizeHexColor(state.modelColors?.[model?.key]) || getDefaultRuntimeColor(model?.runtime);
}

function hasCustomModelColor(model) {
  return Boolean(model?.key && normalizeHexColor(state.modelColors?.[model.key]));
}

function hasAnyCustomModelColors() {
  return Object.values(state.modelColors || {}).some((value) => Boolean(normalizeHexColor(value)));
}

function getDraftOrModelColor(model) {
  return normalizeHexColor(state.modal.colorDraft) || getModelColorValue(model);
}

function setModelColor(modelKey, color) {
  const key = String(modelKey || "").trim();
  const normalized = normalizeHexColor(color);
  if (!key || !normalized) {
    return;
  }
  state.modelColors = {
    ...(state.modelColors || {}),
    [key]: normalized,
  };
  persistModelColors();
  renderModels();
  if (state.modal.open && state.modal.modelKey === key && !state.modal.voiceModel) {
    renderLaunchModal();
  }
}

function clearModelColor(modelKey) {
  const key = String(modelKey || "").trim();
  if (!key || !state.modelColors?.[key]) {
    return;
  }
  const next = { ...(state.modelColors || {}) };
  delete next[key];
  state.modelColors = next;
  persistModelColors();
  renderModels();
  if (state.modal.open && state.modal.modelKey === key && !state.modal.voiceModel) {
    renderLaunchModal();
  }
}

function resetAllModelColors() {
  if (!hasAnyCustomModelColors()) {
    return;
  }
  if (!window.confirm("Reset all model colors to their defaults?")) {
    return;
  }
  state.modelColors = {};
  persistModelColors();
  render();
}

function buildModelNameChipStyle(color) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return "";
  }
  return `--model-name-fg:${getReadableForegroundColor(normalized)};--model-name-bg:${normalized};--model-name-border:${normalized}`;
}

function renderTableModelName(model) {
  const color = getModelColorValue(model);
  const style = buildModelNameChipStyle(color);
  return `<strong class="model-name-token" style="${style}">${esc(model.label)}</strong>${renderVisionBadge(model.vision)}`;
}

function renderVisionBadge(enabled) {
  if (!enabled) {
    return "";
  }
  return `<span class="vision-badge" title="Vision-capable" aria-label="Vision-capable">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  </span>`;
}

function buildProfileLabelStyle(color) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return "";
  }
  return `--profile-chip-fg:${getReadableForegroundColor(normalized)};--profile-chip-bg:${normalized};--profile-chip-border:${normalized}`;
}

function buildProfileTileStyle(color) {
  const normalized = normalizeHexColor(color);
  const rgb = hexToRgb(normalized);
  if (!rgb) {
    return "";
  }
  return `--profile-tile-bg:${rgbaCss(rgb, 0.18)};--profile-tile-border:${rgbaCss(rgb, 0.42)};--profile-tile-fg:${getReadableForegroundColor(normalized)}`;
}

function timeAgo(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return "updated recently";
  }
  const deltaMs = Date.now() - timestamp;
  const deltaMinutes = Math.max(1, Math.round(deltaMs / 60000));
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m ago`;
  }
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h ago`;
  }
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function rgbToHsv(rgb) {
  if (!rgb) {
    return null;
  }
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) {
      h = 60 * (((g - b) / delta) % 6);
    } else if (max === g) {
      h = 60 * (((b - r) / delta) + 2);
    } else {
      h = 60 * (((r - g) / delta) + 4);
    }
  }
  return {
    h: (h + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hexToHsv(color) {
  return rgbToHsv(hexToRgb(color));
}

function hsvToRgb(h, s, v) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, Number(s) || 0));
  const val = Math.max(0, Math.min(1, Number(v) || 0));
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - chroma;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) {
    r = chroma; g = x;
  } else if (hue < 120) {
    r = x; g = chroma;
  } else if (hue < 180) {
    g = chroma; b = x;
  } else if (hue < 240) {
    g = x; b = chroma;
  } else if (hue < 300) {
    r = x; b = chroma;
  } else {
    r = chroma; b = x;
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

function hsvToHex(h, s, v) {
  const rgb = hsvToRgb(h, s, v);
  return `#${[rgb.r, rgb.g, rgb.b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function drawModelColorWheel(canvas, value) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const size = canvas.width;
  const radius = size / 2;
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) - radius;
      const dy = (y + 0.5) - radius;
      const distance = Math.sqrt((dx * dx) + (dy * dy));
      const offset = (y * size + x) * 4;
      if (distance > radius) {
        image.data[offset + 3] = 0;
        continue;
      }
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const saturation = Math.min(1, distance / radius);
      const rgb = hsvToRgb(hue, saturation, value);
      image.data[offset] = rgb.r;
      image.data[offset + 1] = rgb.g;
      image.data[offset + 2] = rgb.b;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
}

function syncModelColorPickerUi() {
  if (!state.modal.open || state.modal.voiceModel || !state.modal.colorPickerOpen) {
    return;
  }
  const model = getModel(state.modal.modelKey);
  if (!model) {
    return;
  }
  const color = getDraftOrModelColor(model);
  const hsv = hexToHsv(color);
  if (!hsv) {
    return;
  }
  const toggle = els.launchModalHeaderActions?.querySelector("[data-model-color-toggle]");
  if (toggle instanceof HTMLElement) {
    toggle.style.setProperty("--model-color", color);
  }
  const preview = els.launchModalHeaderActions?.querySelector("[data-model-color-preview]");
  if (preview instanceof HTMLElement) {
    preview.style.setProperty("--model-color", color);
  }
  const hexInput = els.launchModalHeaderActions?.querySelector("[data-model-color-draft]");
  if (hexInput instanceof HTMLInputElement && document.activeElement !== hexInput) {
    hexInput.value = state.modal.colorDraft || color;
  }
  const range = els.launchModalHeaderActions?.querySelector("[data-model-color-value]");
  if (range instanceof HTMLInputElement) {
    range.value = String(Math.round(hsv.v * 100));
    range.style.background = `linear-gradient(90deg, rgb(0 0 0), ${hsvToHex(hsv.h, hsv.s, 1)})`;
  }
  const canvas = els.launchModalHeaderActions?.querySelector("[data-model-color-wheel]");
  if (canvas instanceof HTMLCanvasElement) {
    drawModelColorWheel(canvas, hsv.v);
    const thumb = els.launchModalHeaderActions?.querySelector("[data-model-color-wheel-thumb]");
    if (thumb instanceof HTMLElement) {
      const radius = canvas.width / 2;
      const radians = hsv.h * Math.PI / 180;
      const x = radius + (Math.cos(radians) * hsv.s * radius);
      const y = radius + (Math.sin(radians) * hsv.s * radius);
      thumb.style.left = `${x}px`;
      thumb.style.top = `${y}px`;
      thumb.style.setProperty("--model-color", color);
    }
  }
}

function updateDraftFromWheelPointer(canvas, clientX, clientY) {
  const model = getModel(state.modal.modelKey);
  if (!model) {
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const radius = rect.width / 2;
  const cx = rect.left + radius;
  const cy = rect.top + radius;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const distance = Math.min(radius, Math.sqrt((dx * dx) + (dy * dy)));
  const saturation = radius ? distance / radius : 0;
  const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const current = hexToHsv(getDraftOrModelColor(model)) || { h: 0, s: 0, v: 1 };
  state.modal.colorDraft = hsvToHex(hue, saturation, current.v);
  syncModelColorPickerUi();
}

function wireModelColorPicker(model) {
  if (!state.modal.colorPickerOpen || state.modal.voiceModel || !model) {
    return;
  }
  const canvas = els.launchModalHeaderActions?.querySelector("[data-model-color-wheel]");
  if (!(canvas instanceof HTMLCanvasElement) || canvas.dataset.bound === "true") {
    syncModelColorPickerUi();
    return;
  }
  canvas.dataset.bound = "true";
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    updateDraftFromWheelPointer(canvas, event.clientX, event.clientY);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!canvas.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateDraftFromWheelPointer(canvas, event.clientX, event.clientY);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  });
  syncModelColorPickerUi();
}

function syncProfileColorPickerUi() {
  if (!state.profileModal.open || !state.profileModal.colorPickerOpen) {
    return;
  }
  const color = getProfileModalColorValue();
  const hsv = hexToHsv(color);
  if (!hsv) {
    return;
  }
  const toggle = els.profileModalHeaderActions?.querySelector("[data-profile-color-toggle]");
  if (toggle instanceof HTMLElement) {
    toggle.style.setProperty("--model-color", color);
  }
  const preview = els.profileModalHeaderActions?.querySelector("[data-profile-color-preview]");
  if (preview instanceof HTMLElement) {
    preview.style.setProperty("--model-color", color);
  }
  const hexInput = els.profileModalHeaderActions?.querySelector("[data-profile-color-draft]");
  if (hexInput instanceof HTMLInputElement && document.activeElement !== hexInput) {
    hexInput.value = state.profileModal.colorDraft || color;
  }
  const range = els.profileModalHeaderActions?.querySelector("[data-profile-color-value]");
  if (range instanceof HTMLInputElement) {
    range.value = String(Math.round(hsv.v * 100));
    range.style.background = `linear-gradient(90deg, rgb(0 0 0), ${hsvToHex(hsv.h, hsv.s, 1)})`;
  }
  const canvas = els.profileModalHeaderActions?.querySelector("[data-profile-color-wheel]");
  if (canvas instanceof HTMLCanvasElement) {
    drawModelColorWheel(canvas, hsv.v);
    const thumb = els.profileModalHeaderActions?.querySelector("[data-profile-color-wheel-thumb]");
    if (thumb instanceof HTMLElement) {
      const radius = canvas.width / 2;
      const radians = hsv.h * Math.PI / 180;
      const x = radius + (Math.cos(radians) * hsv.s * radius);
      const y = radius + (Math.sin(radians) * hsv.s * radius);
      thumb.style.left = `${x}px`;
      thumb.style.top = `${y}px`;
      thumb.style.setProperty("--model-color", color);
    }
  }
}

function updateProfileColorDraftFromWheel(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const radius = rect.width / 2;
  const cx = rect.left + radius;
  const cy = rect.top + radius;
  const dx = clientX - cx;
  const dy = clientY - cy;
  const distance = Math.min(radius, Math.sqrt((dx * dx) + (dy * dy)));
  const saturation = radius ? distance / radius : 0;
  const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  const current = hexToHsv(getProfileModalColorValue()) || { h: 0, s: 0, v: 1 };
  state.profileModal.colorDraft = hsvToHex(hue, saturation, current.v);
  syncProfileColorPickerUi();
}

function wireProfileColorPicker() {
  if (!state.profileModal.open || !state.profileModal.colorPickerOpen) {
    return;
  }
  const canvas = els.profileModalHeaderActions?.querySelector("[data-profile-color-wheel]");
  if (!(canvas instanceof HTMLCanvasElement) || canvas.dataset.bound === "true") {
    syncProfileColorPickerUi();
    return;
  }
  canvas.dataset.bound = "true";
  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    updateProfileColorDraftFromWheel(canvas, event.clientX, event.clientY);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!canvas.hasPointerCapture(event.pointerId)) {
      return;
    }
    updateProfileColorDraftFromWheel(canvas, event.clientX, event.clientY);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  });
  syncProfileColorPickerUi();
}

function hexToRgb(color) {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return null;
  }
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function buildCustomPaletteEntry(accent) {
  const rgb = hexToRgb(accent);
  if (!rgb) {
    return null;
  }
  return {
    accent,
    surface: `linear-gradient(180deg, rgb(${rgb.r} ${rgb.g} ${rgb.b} / 0.2), rgba(12, 12, 16, 0.98))`,
  };
}

function buildPalette() {
  const families = {
    gguf: state.models.filter((model) => model.runtime === "gguf"),
    mlx: state.models.filter((model) => model.runtime === "mlx"),
    dflash: state.models.filter((model) => model.runtime === "dflash"),
  };
  const palette = new Map();
  for (const [family, models] of Object.entries(families)) {
    const sorted = [...models].sort((left, right) => parseSize(left) - parseSize(right));
    const lastIndex = Math.max(sorted.length - 1, 1);
    sorted.forEach((model, index) => {
      const customEntry = buildCustomPaletteEntry(state.modelColors?.[model.key]);
      if (customEntry) {
        palette.set(model.key, customEntry);
        return;
      }
      const ratio = index / lastIndex;
      const hue = family === "mlx" ? 268 : family === "dflash" ? 24 : 195;
      const saturation = family === "mlx" ? 82 : family === "dflash" ? 92 : 78;
      const lightness = family === "mlx" ? 68 - ratio * 10 : family === "dflash" ? 66 - ratio * 11 : 64 - ratio * 14;
      palette.set(model.key, {
        accent: `hsl(${hue} ${saturation}% ${lightness}%)`,
        surface: `linear-gradient(180deg, hsl(${hue} ${saturation}% ${family === "mlx" ? 16 + ratio * 7 : family === "dflash" ? 14 + ratio * 7 : 13 + ratio * 6}% / 0.98), rgba(12, 12, 16, 0.98))`,
      });
    });
  }
  return palette;
}

function parseSize(model) {
  const match = String(model?.sizeLabel || "").match(/([\d.]+)/);
  return match ? Number(match[1]) : 0;
}

function paletteStyle(palette, runtime) {
  const fallback = runtime === "mlx"
    ? { accent: "var(--mlx-accent)", surface: "linear-gradient(180deg, rgba(40, 24, 74, 0.98), rgba(12, 12, 16, 0.98))" }
    : runtime === "dflash"
      ? { accent: "var(--dflash-accent)", surface: "linear-gradient(180deg, rgba(70, 30, 11, 0.98), rgba(12, 12, 16, 0.98))" }
      : { accent: "var(--cyan)", surface: "linear-gradient(180deg, rgba(15, 39, 44, 0.98), rgba(12, 12, 16, 0.98))" };
  const active = palette || fallback;
  return `--card-accent:${active.accent};background:${active.surface}`;
}

function runtimeClass(runtime) {
  if (runtime === "mlx" || runtime === "dflash" || runtime === "gguf" || runtime === "mtplx") {
    return runtime;
  }
  return "default";
}

function runtimeLabel(runtime) {
  if (runtime === "mlx") return "MLX";
  if (runtime === "dflash") return "DFlash";
  if (runtime === "mtplx") return "MTPLX";
  if (runtime === "gguf") return "GGUF";
  return String(runtime || "other")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function launcherLabel(launcher) {
  if (launcher === "gguf") return "llama.cpp";
  if (launcher === "gguf-tq3") return "llama.cpp TQ3";
  if (launcher === "beellama") return "beellama";
  if (launcher === "mlx") return "MLX API proxy";
  if (launcher === "rapid-mlx") return "rapid-mlx";
  if (launcher === "mtplx") return "MTPLX";
  if (launcher === "dflash") return "DFlash";
  if (launcher === "turboquant") return "TurboQuant";
  return String(launcher || "default");
}

function getLauncherOptions(model) {
  const explicit = Array.isArray(model?.launchers)
    ? model.launchers.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }
  if (model?.runtime === "mtplx") {
    return ["mlx", "mtplx"];
  }
  if (model?.runtime === "mlx") {
    return ["mlx"];
  }
  if (model?.runtime === "dflash") {
    return ["dflash"];
  }
  if (model?.launcher) {
    return [String(model.launcher)];
  }
  return ["gguf"];
}

function getModelVariant(model) {
  return String(model?.label || "")
    .replace(/^Qwen 3\.6\s*/i, "")
    .replace(/^Gemma 4\s*/i, "")
    .replace(/^Qwen\s*/i, "")
    .replace(/^Gemma\s*/i, "")
    .trim();
}

function getLaunchCompatibilityWarning(model, slot) {
  if (String(model?.runtime || "") !== "dflash") {
    return "";
  }
  const key = String(model?.key || "").toLowerCase();
  const label = String(model?.label || "").toLowerCase();
  if (!key.includes("bf16") && !label.includes("bf16")) {
    return "";
  }

  const conflicts = state.slots
    .filter((entry) => entry.id !== slot?.id && entry.status?.running)
    .map((entry) => getModel(entry.status?.model?.key) || getModel(entry.status?.model?.path) || entry.status?.model)
    .filter(Boolean)
    .filter((entry) => modelFootprintBytes(entry) >= 25 * 1024 * 1024 * 1024)
    .map((entry) => entry.label || entry.key);

  if (!conflicts.length) {
    return "";
  }

  return `bf16 DFlash will usually crash from GPU memory pressure while ${conflicts.join(", ")} is also loaded. Use MXFP4 DFlash or stop the other slot first.`;
}

function modelFootprintBytes(model) {
  const direct = Number(model?.sizeBytes || 0);
  if (direct > 0) {
    return direct;
  }

  const match = String(model?.sizeLabel || "").match(/([\d.]+)\s*([KMGT]?)(?:i)?B/i);
  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const power = { "": 0, K: 1, M: 2, G: 3, T: 4 }[String(match[2] || "").toUpperCase()];
  return power == null ? 0 : Math.round(value * 1024 ** power);
}

function slotIcon(slot) {
  const name = slot?.iconName || slot?.id;
  if (name === "diamond" || slot?.id === "slot1") {
    return `<span class="slot-icon slot-icon-diamond" aria-hidden="true">&#9670;</span>`;
  }
  if (name === "orbit" || slot?.id === "slot2") {
    return `<span class="slot-icon slot-icon-orbit" aria-hidden="true">&#9678;</span>`;
  }
  if (name === "triangle" || slot?.id === "slot3") {
    return `<span class="slot-icon slot-icon-triangle" aria-hidden="true">&#9651;</span>`;
  }
  return `<span class="slot-icon" aria-hidden="true">&#9675;</span>`;
}

function presetLabel(value) {
  const numeric = Number(value);
  if (numeric >= 1048576) {
    return "1M";
  }
  if (numeric >= 524288) {
    return "512K";
  }
  if (numeric >= 262144) {
    return "262K";
  }
  if (numeric >= 255000) {
    return "255K";
  }
  if (numeric >= 131072) {
    return "128K";
  }
  return value;
}

function updateVisualViewportVars() {
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const width = viewport?.width || window.innerWidth || 0;
  const height = viewport?.height || window.innerHeight || 0;
  const offsetLeft = viewport?.offsetLeft || 0;
  const offsetTop = viewport?.offsetTop || 0;
  root.style.setProperty("--visual-vw", `${Math.max(0, width)}px`);
  root.style.setProperty("--visual-vh", `${Math.max(0, height)}px`);
  root.style.setProperty("--visual-offset-left", `${Math.max(0, offsetLeft)}px`);
  root.style.setProperty("--visual-offset-top", `${Math.max(0, offsetTop)}px`);
  syncHfDownloadsPanel();
}

function getActiveLogElement() {
  if (state.activeLogKind === "thinking") {
    return els.thinkingLog;
  }
  if (state.activeLogKind === "traffic") {
    return els.trafficLog;
  }
  if (state.activeLogKind === "server") {
    return els.serverLog;
  }
  if (state.activeLogKind === "llm3") {
    return els.llm3Log;
  }
  return els.proxyLog;
}

function getScrollSnapshot(element) {
  if (!element) {
    return { scrollTop: 0, nearBottom: true };
  }
  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  return {
    scrollTop: element.scrollTop,
    nearBottom: distanceFromBottom < 64,
  };
}

function autoScroll(element, previous = null) {
  autoScrollElement(element, Boolean(els.autoScrollInput?.checked), previous);
}

function autoScrollElement(element, enabled = true, previous = null) {
  if (!element) {
    return;
  }
  if (!enabled) {
    if (previous) {
      element.scrollTop = previous.scrollTop;
    }
    return;
  }
  if (!previous || previous.nearBottom) {
    element.scrollTop = element.scrollHeight;
    return;
  }
  element.scrollTop = previous.scrollTop;
}

function fmtBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function fmtCompactBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) {
    return "0B";
  }
  const units = ["B", "K", "M", "G", "T", "P"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 100 || index === 0 ? 0 : 1)}${units[index]}`;
}

function formatUptime(seconds, options = {}) {
  const total = Math.max(0, Math.floor(Number(seconds || 0)));
  if (!total) {
    return "--";
  }
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || parts.length) parts.push(`${hours}h`);
  if (minutes || (!options.compact && parts.length)) {
    parts.push(`${minutes}m`);
  }
  if (!parts.length) {
    return "<1m";
  }
  return options.compact ? parts.slice(0, 2).join(" ") : parts.join(" ");
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtCount(value) {
  const numeric = Number(value || 0);
  if (!numeric) {
    return "n/a";
  }
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: numeric >= 1000000 ? 1 : 0,
  }).format(numeric);
}

function NumberFmt(value) {
  if (value === null || value === undefined || value === "") {
    return "n/a";
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat().format(numeric) : String(value);
}

function fmtMs(value) {
  const numeric = Number(value || 0);
  if (!numeric) {
    return "n/a";
  }
  if (numeric < 1000) {
    return `${Math.round(numeric)} ms`;
  }
  return `${(numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1)} s`;
}

function fmtRate(value, approximate = false) {
  const numeric = Number(value || 0);
  if (!numeric) {
    return "n/a";
  }
  return `${numeric.toFixed(numeric >= 100 ? 0 : 1)} tok/s${approximate ? " ~" : ""}`;
}

// For an href that carries a value from the server or the database. Only an
// http(s) URL, a fragment, or a root-relative path is allowed; anything else
// (javascript:, data:, a bare word) becomes "#". The result is escaped.
function safeHref(value) {
  const text = String(value ?? "").trim();
  if (!text) return "#";
  if (/^(?:https?:\/\/|\/(?!\/)|#)/i.test(text)) return esc(text);
  return "#";
}

function esc(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Markdown + LaTeX for model replies -----------------------------------
//
// markdown-it does the parsing and markdown-it-texmath + KaTeX do the maths,
// all vendored under /vendor so this works with no network. Rolling our own
// was a mistake: escaping, emphasis-vs-underscore, tables, and above all the
// interaction between markdown and TeX (CommonMark turns the "\\" row break in
// a matrix into a single backslash before any renderer sees it) are exactly
// what these libraries already get right.
//
// SAFETY: html:false makes markdown-it escape any raw HTML in the source, so a
// model emitting <script> or an onerror attribute produces visible text rather
// than live markup. texmath hands maths to KaTeX with trust:false, which
// refuses \htmlClass and friends.
//
// Delimiters: "dollars" gives $...$ and $$...$$; "beg_end" gives a bare
// \begin{pmatrix}...\end{pmatrix} with no surrounding $$, which is how models
// usually write matrices.
let chatMarkdownRenderer = null;

function getChatMarkdownRenderer() {
  if (chatMarkdownRenderer !== null) {
    return chatMarkdownRenderer;
  }
  if (typeof window.markdownit !== "function") {
    chatMarkdownRenderer = false;
    return chatMarkdownRenderer;
  }
  const md = window.markdownit({
    html: false,
    linkify: true,
    breaks: true,
    typographer: false,
  });
  if (typeof window.texmath === "function" && typeof window.katex !== "undefined") {
    // texmath ships \\begin{...}...\\end{...} as a BLOCK rule only, so it is
    // recognised solely when the environment starts a line. Models routinely
    // write "A = \\begin{pmatrix}", and that form fell through as literal text.
    // Registering the same delimiter as an inline rule through texmath.rules --
    // the table its own delimiter sets live in, which mergeDelimiters reads by
    // name -- picks the environment up wherever it appears. Sticky flag because
    // texmath.inline drives the regex with rex.lastIndex.
    if (!window.texmath.rules.beg_end_inline) {
      window.texmath.rules.beg_end_inline = {
        inline: [{
          name: "math_inline_beg_end",
          rex: /(\\begin\{([a-z]+\*?)\}[\s\S]+?\\end\{\2\})/gy,
          tmpl: "<eqn>$1</eqn>",
          tag: "\\",
          displayMode: true,
        }],
        block: [],
      };
    }
    md.use(window.texmath, {
      engine: window.katex,
      delimiters: ["dollars", "beg_end", "beg_end_inline"],
      // outerSpace demands whitespace on BOTH sides of an inline $...$, which
      // real replies violate constantly -- "Multiply by $-1$:" ends with a
      // colon and was left as literal text. Measured on this box against live
      // output, so it stays off; the cost is that a "$5 ... $10" pair in prose
      // can be misread as one formula, which is far rarer than punctuation.
      outerSpace: false,
      katexOptions: { throwOnError: false, errorColor: "#f87171", strict: false, trust: false },
    });

    // With outerSpace off, texmath's single-$ rule also spans prose: in "It
    // costs $5 and $10" it matches "$5 and $" and the money disappears. Rather
    // than tighten the regex (and lose "$-1$:" again), decide from the captured
    // body: a body containing whitespace must also contain something only TeX
    // has -- a backslash, ^, _, { or } -- otherwise it is a sentence and gets
    // put back verbatim. "-1", "x^2", "(a+b)" and "\det(A) = 1" all pass;
    // "5 and" does not. Wraps texmath's own renderer rule, so the maths path is
    // untouched.
    const inlineMath = md.renderer.rules.math_inline;
    if (typeof inlineMath === "function") {
      md.renderer.rules.math_inline = (tokens, idx, ...rest) => {
        const body = tokens[idx].content || "";
        if (/\s/.test(body) && !/[\\^_{}]/.test(body)) {
          return esc(`$${body}$`);
        }
        return inlineMath(tokens, idx, ...rest);
      };
    }
  }
  chatMarkdownRenderer = md;
  return chatMarkdownRenderer;
}

// Balance markup the reply never closed.
//
// A reply is routinely cut off mid-construct: while it streams, and permanently
// when it hits the token limit or Stop. markdown-it and texmath both need a
// closing delimiter to match, so an unterminated block falls through as literal
// text -- and markdown-it's escape rule then turns each "\\" row separator into
// a single backslash, which is the mangled matrix in the bug report.
//
// This does not parse anything: it counts delimiters and appends the closers
// that are missing, innermost first, so the renderer sees a well-formed
// document. Fenced code is masked out before the maths delimiters are counted,
// because a "$$" inside a code block is not maths.
function closeUnterminatedMarkup(text) {
  let out = text;

  // 1. Code fence. Do this first: everything else must ignore what is inside.
  const fenceMarks = out.match(/^[ \t]*(?:```|~~~)/gm) || [];
  if (fenceMarks.length % 2 === 1) {
    const marker = fenceMarks[fenceMarks.length - 1].trim().slice(0, 3);
    out += (out.endsWith("\n") ? "" : "\n") + marker;
  }

  // Mask complete fenced blocks so their contents cannot be miscounted. Same
  // length, so nothing below shifts.
  const masked = out.replace(/(^|\n)([ \t]*)(```|~~~)[\s\S]*?\n[ \t]*\3/g,
    (match) => match.replace(/[^\n]/g, " "));

  // 2. LaTeX environments, innermost first.
  const envStack = [];
  const envRex = /\\(begin|end)\{([a-zA-Z]+\*?)\}/g;
  let envMatch;
  while ((envMatch = envRex.exec(masked)) !== null) {
    if (envMatch[1] === "begin") {
      envStack.push(envMatch[2]);
    } else if (envStack[envStack.length - 1] === envMatch[2]) {
      envStack.pop();
    }
  }
  // 3. Display maths, then inline maths. Inline is counted on a copy with the
  // $$ pairs removed, so the two delimiters cannot be confused for each other.
  const displayCount = (masked.match(/\$\$/g) || []).length;
  const inlineSource = masked.replace(/\$\$[\s\S]*?\$\$/g, "");
  const inlineOpen = displayCount % 2 === 0
    && ((inlineSource.match(/(?<!\\)\$/g) || []).length % 2 === 1);

  // 4. A tail that is still being typed cannot be closed, only dropped. While a
  // reply streams, the text ends mid-token constantly -- "\begin{" with the
  // environment name half written, or a bare "\" starting a command -- and that
  // reaches KaTeX as invalid input, which is the raw "\begin{" seen on screen.
  // Only trimmed when we are already inside unclosed maths, so ordinary prose
  // that happens to end in a backslash is left alone.
  if (envStack.length || displayCount % 2 === 1 || inlineOpen) {
    let previous;
    do {
      previous = out;
      out = out
        .replace(/\\(?:begin|end)\{[a-zA-Z*]*$/, "")
        .replace(/(^|[^\\])\\[a-zA-Z]*$/, "$1")
        .replace(/[ \t]+$/, "");
    } while (out !== previous);
  }

  // Closers last, innermost first, so an \end lands inside its $$ block.
  while (envStack.length) {
    out += `\n\\end{${envStack.pop()}}`;
  }
  if (displayCount % 2 === 1) {
    out += "\n$$";
  } else if (inlineOpen) {
    // After trimming a half-typed token the text can end on the opening "$"
    // itself. Appending a closer there would build an empty "$$", which renders
    // as a stray delimiter; drop the opener instead and let the next chunk
    // bring it back.
    if (/\$[ \t]*$/.test(out)) {
      out = out.replace(/\$[ \t]*$/, "");
    } else {
      out += "$";
    }
  }

  return out;
}

// Falls back to escaped plain text if the vendored bundles failed to load, so a
// broken asset shows the reply verbatim instead of an empty bubble.
function renderMarkdown(raw) {
  const text = String(raw ?? "");
  const md = getChatMarkdownRenderer();
  if (!md) {
    return esc(text);
  }
  try {
    return md.render(closeUnterminatedMarkup(text));
  } catch (_error) {
    return esc(text);
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const data = await responseJson(response).catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function responseJson(response) {
  return response.json();
}

// ---- Collapsible sidebar ---------------------------------------------------
// Collapsed, the rail keeps every destination and drops only the labels, so the
// nav behaves exactly as it does when expanded. There is no dedicated handle:
// clicking anywhere in the column that is not a destination toggles it, which is
// also why the labels are mirrored into title/aria-label while it is narrow --
// an icon with no tooltip is a guess. The choice is remembered.
(function initSidebarRail() {
  const SIDEBAR_KEY = "llm3SidebarCollapsedV1";
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) {
    return;
  }

  function syncNavLabels(collapsed) {
    sidebar.querySelectorAll(".nav-item[data-section]").forEach((item) => {
      const label = [...item.children]
        .filter((child) => child.tagName === "SPAN")
        .map((child) => child.textContent.trim())
        .find(Boolean) || "";
      if (collapsed && label) {
        item.setAttribute("title", label);
        item.setAttribute("aria-label", label);
      } else {
        item.removeAttribute("title");
        item.removeAttribute("aria-label");
      }
    });
  }

  function setCollapsed(collapsed, persist) {
    sidebar.classList.toggle("is-collapsed", collapsed);
    sidebar.setAttribute("aria-expanded", collapsed ? "false" : "true");
    syncNavLabels(collapsed);
    if (persist) {
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
      } catch (_error) { /* private mode */ }
    }
  }

  let stored = false;
  try {
    stored = localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch (_error) { /* private mode */ }
  setCollapsed(stored, false);

  sidebar.addEventListener("click", (event) => {
    // Destinations and controls keep their own behaviour; only the gaps toggle.
    if (event.target.closest("a, button, input, select, textarea, [role='button']")) {
      return;
    }
    if (String(window.getSelection() || "").length) {
      return;
    }
    setCollapsed(!sidebar.classList.contains("is-collapsed"), true);
  });
})();

// ===========================================================================
// Diagnostics -> Model chat
// A real conversation against one running slot, with the runtime's numbers beside
// it, so a model can be exercised the way an agent would exercise it. The transport
// is llm3's own SSE shape from POST /api/chat/:slotId — see the server comment.
//
// Conversations are PER SLOT. Each slot keeps its own transcript, session totals and
// in-flight stream, so switching slots shows that slot's history rather than one
// shared thread — and a stream started on one slot keeps filling its own transcript
// while you read another.
// ===========================================================================

const chatState = {
  slotId: "",
  bySlot: new Map(),
};

function newChatSession() {
  return { turns: 0, promptTokens: 0, completionTokens: 0, totalMs: 0, rates: [] };
}

function chatConv(slotId) {
  const id = String(slotId || "");
  if (!id) return null;
  if (!chatState.bySlot.has(id)) {
    chatState.bySlot.set(id, {
      slotId: id,
      messages: [],
      session: newChatSession(),
      lastStats: null,
      streaming: false,
      abort: null,
    });
  }
  return chatState.bySlot.get(id);
}

function currentChatConv() {
  return chatConv(chatState.slotId);
}

// --- Composer attachments ---------------------------------------------------
//
// Images ride along as OpenAI content parts, which is what every vision runtime
// here speaks (mlx-vlm, llama.cpp with an mmproj, mlx-dspark). They are held as
// data URLs: the chat proxy forwards `messages` verbatim and express.json is
// already configured for 25mb, so nothing needs uploading separately.
const CHAT_MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const CHAT_MAX_ATTACHMENTS = 6;
let chatPendingAttachments = [];

function chatRenderAttachments() {
  const strip = document.getElementById("chatAttachments");
  if (!strip) return;
  if (!chatPendingAttachments.length) {
    strip.classList.add("hidden");
    strip.innerHTML = "";
    return;
  }
  strip.classList.remove("hidden");
  strip.innerHTML = chatPendingAttachments.map((att, index) => `
    <div class="chat-attachment" title="${esc(att.name)}">
      <img src="${att.url}" alt="${esc(att.name)}">
      <button type="button" class="chat-attachment-remove" data-attachment-index="${index}" aria-label="Remove ${esc(att.name)}">×</button>
    </div>`).join("");
}

function chatAddAttachment(file) {
  if (!file || !/^image\//.test(file.type)) return;
  if (chatPendingAttachments.length >= CHAT_MAX_ATTACHMENTS) {
    showToast(`At most ${CHAT_MAX_ATTACHMENTS} images per message`, 2500);
    return;
  }
  if (file.size > CHAT_MAX_IMAGE_BYTES) {
    showToast(`${file.name || "Image"} is larger than 6 MB`, 3000);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    chatPendingAttachments.push({
      name: file.name || "pasted-image",
      type: file.type,
      url: String(reader.result || ""),
    });
    chatRenderAttachments();
  };
  reader.readAsDataURL(file);
}

function chatClearAttachments() {
  chatPendingAttachments = [];
  chatRenderAttachments();
}

// Does the model on this slot claim vision? Used only to warn -- a wrong guess
// must never block a send, because the flag is metadata and the runtime is the
// real authority.
function chatSlotSupportsVision() {
  const slot = (state.slots || []).find((entry) => entry.id === chatState.slotId);
  const key = String(slot?.status?.model?.key || "");
  if (!key) return null;
  const model = (state.models || []).find((entry) => entry.key === key);
  return model ? Boolean(model.vision) : null;
}

// --- Prompt history ---------------------------------------------------------
//
// Deliberately global rather than per-slot: the point of this tab is running the
// same prompt against different slots, so the history follows you when you
// switch. Persisted so it survives a reload, capped so it cannot grow forever.
const CHAT_HISTORY_KEY = "llm3.chat.promptHistory";
const CHAT_HISTORY_MAX = 200;
let chatPromptHistory = [];
let chatHistoryIndex = -1;   // -1 = not browsing; 0 = most recent
let chatHistoryDraft = "";   // what was typed before browsing started

function chatLoadHistory() {
  try {
    const raw = window.localStorage.getItem(CHAT_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    chatPromptHistory = Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : [];
  } catch (_error) {
    chatPromptHistory = [];
  }
}

function chatPushHistory(text) {
  const value = String(text || "").trim();
  if (!value) return;
  // Same prompt twice in a row is one history entry, as in a shell.
  if (chatPromptHistory[0] === value) return;
  chatPromptHistory.unshift(value);
  if (chatPromptHistory.length > CHAT_HISTORY_MAX) {
    chatPromptHistory.length = CHAT_HISTORY_MAX;
  }
  try {
    window.localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(chatPromptHistory));
  } catch (_error) {
    // A full or disabled localStorage must not break sending.
  }
  chatHistoryIndex = -1;
  chatHistoryDraft = "";
}

// Arrow keys only take over when the caret cannot move any further in that
// direction, so they still navigate normally inside a multi-line draft.
function chatHistoryKeydown(event) {
  const input = event.target;
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return false;
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
  if (!chatPromptHistory.length) return false;

  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;

  if (event.key === "ArrowUp") {
    if (!atStart && chatHistoryIndex === -1) return false;
    if (chatHistoryIndex === -1) chatHistoryDraft = input.value;
    if (chatHistoryIndex >= chatPromptHistory.length - 1) return true;
    chatHistoryIndex += 1;
  } else {
    if (chatHistoryIndex === -1) return false;
    if (!atEnd && chatHistoryIndex === -1) return false;
    chatHistoryIndex -= 1;
  }

  const next = chatHistoryIndex === -1 ? chatHistoryDraft : chatPromptHistory[chatHistoryIndex];
  input.value = next;
  chatAutoGrow(input);
  // Caret to the end, so a further ArrowUp keeps walking back.
  requestAnimationFrame(() => {
    input.selectionStart = input.selectionEnd = input.value.length;
  });
  return true;
}

// --- Composer ergonomics ----------------------------------------------------

function chatAutoGrow(input) {
  if (!input) return;
  input.style.height = "auto";
  const max = 260;
  input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  input.style.overflowY = input.scrollHeight > max ? "auto" : "hidden";
}

// --- Transcript as markdown -------------------------------------------------

function chatTranscriptMarkdown() {
  const conv = currentChatConv();
  if (!conv) return "";
  return conv.messages
    .filter((m) => !m.streaming || m.content)
    .map((m) => {
      const who = m.role === "user" ? "### User" : "### Assistant";
      const images = (m.images || []).length ? `\n\n_(${m.images.length} image(s) attached)_` : "";
      return `${who}\n\n${m.content || ""}${images}`;
    })
    .join("\n\n---\n\n");
}

async function chatCopyText(text, label) {
  const value = String(text || "");
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast(`${label} copied`, 1500);
  } catch (_error) {
    // Clipboard permission can be refused; a textarea fallback still works.
    const scratch = document.createElement("textarea");
    scratch.value = value;
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);
    scratch.select();
    try { document.execCommand("copy"); showToast(`${label} copied`, 1500); }
    catch (_e) { showToast("Could not copy", 2000); }
    document.body.removeChild(scratch);
  }
}

function chatEls() {
  return {
    select: document.getElementById("chatSlotSelect"),
    model: document.getElementById("chatModelLabel"),
    log: document.getElementById("chatLog"),
    jump: document.getElementById("chatJumpLatest"),
    form: document.getElementById("chatComposer"),
    input: document.getElementById("chatInput"),
    send: document.getElementById("chatSend"),
    stop: document.getElementById("chatStop"),
    clear: document.getElementById("chatClear"),
    regenerate: document.getElementById("chatRegenerate"),
    copyAll: document.getElementById("chatCopyAll"),
    attach: document.getElementById("chatAttach"),
    fileInput: document.getElementById("chatFileInput"),
    attachments: document.getElementById("chatAttachments"),
    dropHint: document.getElementById("chatDropHint"),
    composer: document.getElementById("chatComposer"),
    live: document.getElementById("chatLiveGrid"),
    turn: document.getElementById("chatTurnGrid"),
    sessionGrid: document.getElementById("chatSessionGrid"),
    native: document.getElementById("chatNative"),
    temp: document.getElementById("chatTemp"),
    topP: document.getElementById("chatTopP"),
    topK: document.getElementById("chatTopK"),
    maxTokens: document.getElementById("chatMaxTokens"),
    thinking: document.getElementById("chatThinking"),
    system: document.getElementById("chatSystem"),
  };
}

function chatRunningSlots() {
  return (state.slots || []).filter((slot) => slot?.status?.running);
}

function renderChatSlotOptions() {
  const els = chatEls();
  if (!els.select) return;
  const running = chatRunningSlots();
  if (!running.some((slot) => slot.id === chatState.slotId)) {
    chatState.slotId = running[0]?.id || "";
  }
  els.select.innerHTML = running.length
    ? running.map((slot) => {
      const conv = chatState.bySlot.get(slot.id);
      // Mark slots that already hold a conversation, so switching is informed.
      const badge = conv?.streaming ? " ●" : (conv?.messages.length ? ` (${conv.messages.filter((m) => m.role === "user").length})` : "");
      return `<option value="${esc(slot.id)}" ${slot.id === chatState.slotId ? "selected" : ""}>${esc(slot.label || slot.id)}${esc(badge)}</option>`;
    }).join("")
    : `<option value="">no running model</option>`;
  els.select.disabled = !running.length;

  const slot = running.find((entry) => entry.id === chatState.slotId);
  const model = slot?.status?.model || {};
  els.model.textContent = slot
    ? `${model.label || model.key || "runtime"} · ${model.launcher || model.runtime || ""}`.trim()
    : "no running model";

  const conv = currentChatConv();
  if (els.send) els.send.disabled = !slot || Boolean(conv?.streaming);
  if (els.stop) els.stop.disabled = !conv?.streaming;
  // Regenerate needs a finished turn to re-ask, so it is off while streaming
  // and off on an empty transcript.
  if (els.regenerate) {
    els.regenerate.disabled = !slot
      || Boolean(conv?.streaming)
      || !(conv?.messages || []).some((m) => m.role === "user");
  }
  // The attach button is only meaningful against a running model; the title
  // says why when the slot's model is not marked vision-capable.
  if (els.attach) {
    els.attach.disabled = !slot;
    const vision = chatSlotSupportsVision();
    els.attach.title = vision === false
      ? "Attach an image (this model is not marked vision-capable)"
      : "Attach an image (or paste / drop one)";
  }
}

function chatStatRow(label, value, title = "") {
  return `<span class="chat-stat-k">${esc(label)}</span><span class="chat-stat-v"${title ? ` title="${esc(title)}"` : ""}>${esc(value)}</span>`;
}

const CHAT_PHASE_TEXT = { prefill: "reading prompt", decode: "generating" };

function renderChatLive() {
  const els = chatEls();
  if (!els.live) return;
  const activity = state.slotActivity?.[chatState.slotId] || {};
  const slot = (state.slots || []).find((entry) => entry.id === chatState.slotId);
  const params = slot?.status?.params || {};
  const phase = activity.phase;
  const busy = activity.busy === true;
  const rate = Number(activity.tokensPerSecond);
  els.live.innerHTML = [
    chatStatRow("state", busy ? (CHAT_PHASE_TEXT[phase] || "working") : "idle"),
    chatStatRow("tok/s", Number.isFinite(rate) ? rate.toFixed(1) : "—",
      phase === "prefill" ? "prompt-processing speed" : "generation speed"),
    chatStatRow("source", activity.source || "—", "which runtime endpoint the number came from"),
    chatStatRow("context", params.ctxSize ? fmtCount(params.ctxSize) : "—"),
    chatStatRow("parallel", params.parallel ?? "—"),
    chatStatRow("effort", params.reasoningEffort === "" ? "model default" : (params.reasoningEffort ?? "—")),
  ].join("");
}

// llama.cpp and mlx-dspark name their speculation counters differently. llama.cpp
// reports draft tokens offered vs accepted; mlx-dspark reports a mean accept length
// per verify round. Show whichever the runtime actually sent.
function chatAcceptSummary(native) {
  const drafted = Number(native?.draft_n);
  const accepted = Number(native?.draft_n_accepted);
  if (Number.isFinite(drafted) && drafted > 0 && Number.isFinite(accepted)) {
    return `${accepted}/${drafted} drafts (${Math.round((accepted / drafted) * 100)}%)`;
  }
  const acceptLen = Number(native?.accept_len);
  if (Number.isFinite(acceptLen) && acceptLen > 0) {
    return `${acceptLen.toFixed(2)} tok/round`;
  }
  return "—";
}

function chatPrefillRate(native) {
  const rate = Number(native?.prompt_per_second ?? native?.prefill_tokens_per_sec);
  return Number.isFinite(rate) ? rate.toFixed(1) : "—";
}

function chatDecodeRate(stats) {
  const native = stats?.native || {};
  const nativeRate = Number(native.predicted_per_second ?? native.decode_tokens_per_sec);
  return Number.isFinite(nativeRate)
    ? { rate: nativeRate, fromRuntime: true }
    : { rate: Number(stats?.tokensPerSecond), fromRuntime: false };
}

function fmtMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function renderChatTurn() {
  const els = chatEls();
  if (!els.turn) return;
  const stats = currentChatConv()?.lastStats || null;
  if (!stats) {
    els.turn.innerHTML = chatStatRow("—", "no turn yet");
    if (els.native) els.native.textContent = "—";
    return;
  }
  const native = stats.native || {};
  const { rate, fromRuntime } = chatDecodeRate(stats);
  els.turn.innerHTML = [
    chatStatRow("tok/s", Number.isFinite(rate) ? rate.toFixed(1) : "—",
      fromRuntime ? "reported by the runtime" : "measured by llm3 across the stream"),
    chatStatRow("TTFT", fmtMs(stats.ttftMs), "time to first token, includes prompt processing"),
    chatStatRow("decode", fmtMs(stats.decodeMs)),
    chatStatRow("total", fmtMs(stats.totalMs)),
    chatStatRow("prefill tok/s", chatPrefillRate(native), "prompt-processing speed for this turn"),
    chatStatRow("prompt tok", stats.promptTokens ?? "—"),
    chatStatRow("output tok", stats.completionTokens ?? "—"),
    chatStatRow("speculation", chatAcceptSummary(native),
      "how well the draft model predicted: higher means fewer target passes"),
    chatStatRow("thinking", stats.reasoningChars ? `${stats.reasoningChars} chars` : "none"),
    chatStatRow("finish", stats.aborted ? "stopped" : (stats.finishReason || "—"),
      stats.finishReason === "length" ? "hit the max-tokens cap — the reply is truncated" : ""),
  ].join("");
  if (els.native) {
    els.native.textContent = Object.keys(native).length
      ? JSON.stringify(native, null, 1)
      : "the runtime reported no timings block";
  }
}

function renderChatSession() {
  const els = chatEls();
  if (!els.sessionGrid) return;
  const s = currentChatConv()?.session || newChatSession();
  const mean = s.rates.length ? s.rates.reduce((a, b) => a + b, 0) / s.rates.length : null;
  els.sessionGrid.innerHTML = [
    chatStatRow("turns", s.turns),
    chatStatRow("mean tok/s", Number.isFinite(mean) ? mean.toFixed(1) : "—"),
    chatStatRow("prompt tok", s.promptTokens || "—"),
    chatStatRow("output tok", s.completionTokens || "—"),
    chatStatRow("wall", fmtMs(s.totalMs)),
  ].join("");
}

function chatTurnSummary(stats) {
  const { rate } = chatDecodeRate(stats);
  const bits = [];
  if (Number.isFinite(rate)) bits.push(`${rate.toFixed(1)} tok/s`);
  if (Number.isFinite(stats.ttftMs)) bits.push(`TTFT ${fmtMs(stats.ttftMs)}`);
  if (stats.completionTokens) bits.push(`${stats.completionTokens} tok`);
  if (stats.finishReason === "length") bits.push("truncated at max tokens");
  if (stats.aborted) bits.push("stopped");
  return bits.join(" · ");
}

function renderChatLog() {
  const els = chatEls();
  if (!els.log) return;
  wireChatScroll(els.log);
  const conv = currentChatConv();
  if (!conv || !conv.messages.length) {
    chatScrollState.pinned = null;
    chatMarkUnread(false);
    els.log.innerHTML = `<div class="chat-empty">${conv
      ? "Send a message to exercise this model. Each slot keeps its own conversation."
      : "Launch a model in a slot to start chatting."}</div>`;
    return;
  }
  // Scroll ownership. Every streamed chunk rewrites innerHTML, and replacing a
  // scroll container's contents resets scrollTop to 0 -- so reading back "am I
  // at the bottom" after the write is useless, and doing nothing threw the
  // reader to the top of the log on every token. Decide before the write, and
  // restore the exact offset afterwards when the reader has scrolled away.
  const wasPinned = chatScrollPinned(els.log);
  const previousTop = els.log.scrollTop;
  const previousHeight = els.log.scrollHeight;

  els.log.innerHTML = conv.messages.map((m, index) => {
    if (m.role === "user") {
      const thumbs = Array.isArray(m.images) && m.images.length
        ? `<div class="chat-msg-images">${m.images
            .map((url) => `<img class="chat-msg-image" src="${url}" alt="attached image" loading="lazy">`)
            .join("")}</div>`
        : "";
      // Actions are rendered always and revealed on hover by CSS, so the row
      // does not reflow when the pointer enters it.
      const actions = `<div class="chat-msg-actions">
        <button type="button" class="chat-act" data-chat-act="copy" data-chat-index="${index}" title="Copy this message">Copy</button>
        <button type="button" class="chat-act" data-chat-act="edit" data-chat-index="${index}" title="Put this back in the composer and drop everything after it">Edit</button>
      </div>`;
      return `<div class="chat-msg user">${thumbs}<div class="chat-bubble">${esc(m.content)}</div>${actions}</div>`;
    }
    const think = m.reasoning
      ? `<details class="chat-think"${m.streaming ? " open" : ""}><summary>thinking · ${m.reasoning.length} chars</summary><pre>${esc(m.reasoning)}</pre></details>`
      : "";
    // Model replies go through markdown-it (html:false, so any raw HTML in the
    // reply is escaped) with texmath+KaTeX for the maths. User messages stay
    // plain -- they are echoed back verbatim on purpose.
    const body = m.error
      ? `<div class="chat-error">${esc(m.error)}</div>`
      : `<div class="chat-bubble chat-md">${m.content ? renderMarkdown(m.content) : (m.streaming ? '<span class="chat-caret"></span>' : '<em class="chat-muted">(empty reply)</em>')}</div>`;
    const foot = m.stats && !m.streaming
      ? `<div class="chat-msg-foot">${esc(chatTurnSummary(m.stats))}</div>`
      : "";
    const actions = m.streaming
      ? ""
      : `<div class="chat-msg-actions">
        <button type="button" class="chat-act" data-chat-act="copy" data-chat-index="${index}" title="Copy this reply as markdown">Copy</button>
      </div>`;
    return `<div class="chat-msg assistant">${think}${body}${foot}${actions}</div>`;
  }).join("");

  if (wasPinned) {
    els.log.scrollTop = els.log.scrollHeight;
  } else {
    // Content only ever grows below the reader mid-stream, so holding the old
    // offset holds the same text in view. Clamped because Clear and Stop can
    // shrink the log under us.
    els.log.scrollTop = Math.min(previousTop, Math.max(0, els.log.scrollHeight - els.log.clientHeight));
    if (els.log.scrollHeight > previousHeight) {
      chatMarkUnread(true);
    }
  }
}

// "Pinned" means the reader is following the tail and wants new output to keep
// scrolling into view. Anything else means they deliberately scrolled away, and
// the log must not move under them.
const CHAT_PIN_SLACK_PX = 80;
function chatScrollPinned(log) {
  if (!log) return true;
  if (chatScrollState.pinned === null) {
    return log.scrollHeight - log.scrollTop - log.clientHeight < CHAT_PIN_SLACK_PX;
  }
  return chatScrollState.pinned;
}

const chatScrollState = { pinned: null, unread: false };

function chatMarkUnread(value) {
  const next = Boolean(value);
  if (chatScrollState.unread === next) return;
  chatScrollState.unread = next;
  const button = document.getElementById("chatJumpLatest");
  if (button) button.classList.toggle("hidden", !next);
}

// Wired once, from the chat log element itself: a scroll that leaves the tail
// unpins, a scroll back to the tail re-pins and clears the "new output" pill.
function wireChatScroll(log) {
  if (!log || log.dataset.scrollWired === "1") return;
  log.dataset.scrollWired = "1";
  log.addEventListener("scroll", () => {
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < CHAT_PIN_SLACK_PX;
    chatScrollState.pinned = pinned;
    if (pinned) chatMarkUnread(false);
  }, { passive: true });
}

function renderChatAll() {
  renderChatSlotOptions();
  renderChatLog();
  renderChatLive();
  renderChatTurn();
  renderChatSession();
}

function chatRequestBody(messages) {
  const els = chatEls();
  const thinking = els.thinking?.value || "default";
  const body = {
    messages,
    temperature: Number(els.temp?.value),
    topP: Number(els.topP?.value),
    topK: Number.parseInt(els.topK?.value ?? "", 10),
    maxTokens: Number.parseInt(els.maxTokens?.value ?? "", 10),
  };
  if (thinking === "off") body.thinking = false;
  else if (thinking !== "default") body.reasoningEffort = thinking;
  return body;
}

async function sendChatMessage(text, images) {
  const slotId = chatState.slotId;
  const conv = chatConv(slotId);
  if (!conv || conv.streaming) return;

  // Everything below writes to `conv`, never to "the current slot": the user may
  // switch away mid-stream and this transcript must keep filling regardless.
  const isVisible = () => chatState.slotId === slotId;

  // Attachments are snapshotted onto the message, not read from the composer
  // later: the composer is cleared immediately and the user may attach the next
  // image while this turn is still streaming.
  const userMessage = { role: "user", content: text };
  if (images && images.length) {
    userMessage.images = images;
  }
  conv.messages.push(userMessage);
  const assistant = { role: "assistant", content: "", reasoning: "", streaming: true, stats: null, error: "" };
  conv.messages.push(assistant);
  conv.streaming = true;

  const els = chatEls();
  if (isVisible()) {
    if (els.send) els.send.disabled = true;
    if (els.stop) els.stop.disabled = false;
    if (els.regenerate) els.regenerate.disabled = true;
    renderChatLog();
  }
  renderChatSlotOptions();

  const wire = [];
  const system = String(els.system?.value || "").trim();
  if (system) wire.push({ role: "system", content: system });
  for (const m of conv.messages) {
    if (m.streaming) continue;
    if (m.role === "user" || (m.role === "assistant" && m.content)) {
      // A message with images becomes the OpenAI content-parts form, which is
      // what every vision runtime here accepts. Text-only messages keep the
      // plain string, because some templates choke on a one-element array.
      if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
        wire.push({
          role: m.role,
          content: [
            ...(m.content ? [{ type: "text", text: m.content }] : []),
            ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        });
      } else {
        wire.push({ role: m.role, content: m.content });
      }
    }
  }

  const controller = new AbortController();
  conv.abort = controller;
  const startedAt = performance.now();
  try {
    const response = await fetch(`/api/chat/${encodeURIComponent(slotId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatRequestBody(wire)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `${response.status} ${response.statusText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let pending = false;
    const paint = () => { pending = false; if (isVisible()) renderChatLog(); };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary).replace(/^data:\s?/, "");
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
        if (!raw.trim()) continue;
        let evt = null;
        try { evt = JSON.parse(raw); } catch (_e) { continue; }
        if (evt.type === "delta") {
          assistant.content += evt.content || "";
          assistant.reasoning += evt.reasoning || "";
          // Coalesce paints: a fast model emits far more frames than 60 fps.
          if (!pending) { pending = true; requestAnimationFrame(paint); }
        } else if (evt.type === "done") {
          assistant.stats = evt.stats || null;
        } else if (evt.type === "error") {
          assistant.error = evt.message || "stream failed";
        }
      }
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      assistant.stats = { aborted: true, totalMs: performance.now() - startedAt };
    } else {
      assistant.error = error?.message || String(error);
    }
  } finally {
    assistant.streaming = false;
    conv.streaming = false;
    conv.abort = null;

    const stats = assistant.stats;
    if (stats) {
      conv.lastStats = stats;
      if (!stats.aborted) {
        const s = conv.session;
        s.turns += 1;
        s.promptTokens += Number(stats.promptTokens) || 0;
        s.completionTokens += Number(stats.completionTokens) || 0;
        s.totalMs += Number(stats.totalMs) || 0;
        const { rate } = chatDecodeRate(stats);
        if (Number.isFinite(rate) && rate > 0) s.rates.push(rate);
      }
    }
    if (isVisible()) {
      renderChatLog();
      renderChatTurn();
      renderChatSession();
    }
    renderChatSlotOptions();
  }
}

function initDiagnosticsChat() {
  const els = chatEls();
  if (!els.form || els.form.dataset.wired === "1") return;
  els.form.dataset.wired = "1";

  document.querySelectorAll("[data-diag-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const key = tab.dataset.diagTab;
      document.querySelectorAll("[data-diag-tab]").forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      document.querySelectorAll("[data-diag-pane]").forEach((pane) => {
        pane.classList.toggle("hidden", pane.dataset.diagPane !== key);
      });
      if (key === "chat") renderChatAll();
    });
  });

  els.select?.addEventListener("change", () => {
    chatState.slotId = els.select.value;
    renderChatAll();
  });

  els.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = String(els.input.value || "").trim();
    const images = chatPendingAttachments.map((att) => att.url);
    // An image on its own is a legitimate turn ("what is this?"), so only an
    // empty composer with no attachments is a no-op.
    if (!text && !images.length) return;
    if (images.length && chatSlotSupportsVision() === false) {
      showToast("This model is not marked as vision-capable; sending anyway", 3000);
    }
    chatPushHistory(text);
    els.input.value = "";
    chatClearAttachments();
    chatAutoGrow(els.input);
    void sendChatMessage(text, images);
  });

  els.input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.form.requestSubmit();
    }
  });

  els.stop?.addEventListener("click", async () => {
    const slotId = chatState.slotId;
    chatConv(slotId)?.abort?.abort();
    try {
      await fetch(`/api/chat/${encodeURIComponent(slotId)}/stop`, { method: "POST" });
    } catch (_error) { /* the local abort already stopped the render */ }
  });

  // Clears only the slot on screen. Another slot's transcript is its own.
  els.clear?.addEventListener("click", () => {
    const conv = currentChatConv();
    if (!conv) return;
    conv.messages = [];
    conv.session = newChatSession();
    conv.lastStats = null;
    chatScrollState.pinned = null;
    chatMarkUnread(false);
    renderChatAll();
  });

  // Re-pin to the tail. The scroll listener clears the pill once the jump
  // lands, so there is nothing to reset here beyond the pin itself.
  els.jump?.addEventListener("click", () => {
    const log = chatEls().log;
    if (!log) return;
    chatScrollState.pinned = true;
    chatMarkUnread(false);
    log.scrollTop = log.scrollHeight;
  });

  // --- attachments: paste, drop, picker ---
  els.input?.addEventListener("paste", (event) => {
    const items = Array.from(event.clipboardData?.items || []);
    const files = items.filter((item) => item.kind === "file" && /^image\//.test(item.type));
    if (!files.length) return;
    // Only swallow the paste when it actually carried an image; a normal text
    // paste must keep working.
    event.preventDefault();
    for (const item of files) {
      chatAddAttachment(item.getAsFile());
    }
  });

  els.attach?.addEventListener("click", () => els.fileInput?.click());
  els.fileInput?.addEventListener("change", () => {
    for (const file of Array.from(els.fileInput.files || [])) {
      chatAddAttachment(file);
    }
    els.fileInput.value = "";
  });

  els.attachments?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-attachment-index]");
    if (!button) return;
    chatPendingAttachments.splice(Number(button.dataset.attachmentIndex), 1);
    chatRenderAttachments();
  });

  // Drag and drop over the whole composer, with a hint while a file is over it.
  // dragover must be cancelled or the browser navigates to the dropped file.
  let dragDepth = 0;
  const setDragging = (on) => els.composer?.classList.toggle("dragging", on);
  els.composer?.addEventListener("dragenter", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    dragDepth += 1;
    setDragging(true);
  });
  els.composer?.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
  });
  els.composer?.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setDragging(false);
  });
  els.composer?.addEventListener("drop", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    dragDepth = 0;
    setDragging(false);
    for (const file of Array.from(event.dataTransfer?.files || [])) {
      chatAddAttachment(file);
    }
  });

  // --- composer keys: history + auto-grow ---
  els.input?.addEventListener("keydown", (event) => {
    if (chatHistoryKeydown(event)) {
      event.preventDefault();
    }
  });
  els.input?.addEventListener("input", () => {
    // Typing ends history browsing, so the next ArrowUp starts from the newest
    // entry again rather than continuing from wherever it left off.
    chatHistoryIndex = -1;
    chatAutoGrow(els.input);
  });

  // --- message actions (delegated: the log is re-rendered every chunk) ---
  els.log?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chat-act]");
    if (!button) return;
    const conv = currentChatConv();
    const message = conv?.messages?.[Number(button.dataset.chatIndex)];
    if (!message) return;
    if (button.dataset.chatAct === "copy") {
      chatCopyText(message.content, message.role === "user" ? "Message" : "Reply");
      return;
    }
    if (button.dataset.chatAct === "edit") {
      if (conv.streaming) {
        showToast("Stop the current reply first", 2000);
        return;
      }
      // Same shape as an editor's "go back to here": the prompt returns to the
      // composer with its images, and everything from that turn on is dropped.
      els.input.value = message.content || "";
      chatPendingAttachments = (message.images || []).map((url, i) => ({
        name: `image-${i + 1}`, type: "image/*", url,
      }));
      chatRenderAttachments();
      conv.messages = conv.messages.slice(0, Number(button.dataset.chatIndex));
      renderChatAll();
      chatAutoGrow(els.input);
      els.input.focus();
    }
  });

  // Clicking a thumbnail opens the full image in a new tab.
  els.log?.addEventListener("click", (event) => {
    const img = event.target.closest(".chat-msg-image");
    if (!img) return;
    const win = window.open();
    if (win) win.document.write(`<img src="${img.src}" style="max-width:100%">`);
  });

  // --- regenerate + copy transcript ---
  els.regenerate?.addEventListener("click", () => {
    const conv = currentChatConv();
    if (!conv || conv.streaming) return;
    // Walk back to the last user turn, drop it and everything after, and send
    // it again -- so a regenerate is exactly a re-ask, not a second question.
    let lastUser = -1;
    for (let i = conv.messages.length - 1; i >= 0; i -= 1) {
      if (conv.messages[i].role === "user") { lastUser = i; break; }
    }
    if (lastUser === -1) return;
    const message = conv.messages[lastUser];
    const text = message.content || "";
    const images = Array.isArray(message.images) ? message.images.slice() : [];
    conv.messages = conv.messages.slice(0, lastUser);
    renderChatAll();
    sendChatMessage(text, images);
  });

  els.copyAll?.addEventListener("click", () => {
    const text = chatTranscriptMarkdown();
    if (!text) {
      showToast("Nothing to copy yet", 1800);
      return;
    }
    chatCopyText(text, "Transcript");
  });

  chatLoadHistory();
  chatAutoGrow(els.input);
  renderChatAll();
}
