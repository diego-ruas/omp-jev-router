import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Flow: sticky follow-up → fast path → cached Jev triage (one request) → deterministic policy → model/thinking.
// Jev only classifies; chooseTarget() owns the routing decision.
// Token economy: every model switch or system-prompt change invalidates the provider prompt cache and
// re-bills the whole context, so the router avoids both unless the task actually needs a different model.

type TaskType = "coding" | "research" | "operations" | "documentation" | "review" | "planning" | "design" | "other";
type Complexity = "trivial" | "low" | "medium" | "high";
type Risk = "low" | "medium" | "high";
type Target = "luna" | "muse" | "sol" | "deepseek" | "opus" | "sonnet";
type Agent = "planner" | "researcher" | "implementer" | "reviewer" | "designer" | "operator" | "general";

type Decision = {
  source: "sticky" | "fast-path" | "jev" | "fallback";
  type: TaskType;
  complexity: Complexity;
  risk: Risk;
  target: Target;
  agent: Agent;
  tool?: string;
};

type Config = {
  enabled: boolean;
  jev: { endpoint: string; model: string; timeoutMs: number; cacheSeconds: number; maxPromptChars: number };
  models: Record<Target, string[]>;
  thinking: Record<Target, string>;
  safety: { enabled: boolean; mode: "shadow" | "enforce"; tools: string[] };
  finalEval: { enabled: boolean; threshold: number };
  economy: { stickyFollowUps: boolean; followUpMaxChars: number; solThinkingBelowHighRisk: string };
  logging: { enabled: boolean; path: string };
};

type Model = { provider: string; id: string };
type Tool = { name?: string; description?: string };
type RuntimeContext = {
  ui?: { notify?: (text: string, level: "info" | "warning") => void; setStatus?: (key: string, value: string) => void };
  models?: { list?: () => Model[]; current?: () => Model | undefined };
  sessionManager?: { getSessionId?: () => string | undefined };
  modelRegistry?: { getApiKeyForProvider?: (provider: string, sessionId?: string, options?: { forceRefresh: boolean }) => Promise<string | undefined> };
};
type JevAnswer = { type?: string; choice?: string; noul?: number };
type JevResponse = { answers?: Record<string, JevAnswer> };
type TurnState = { prompt: string; decision: Decision; writes: number; continued: boolean; sessionTarget: Target; pendingTarget?: Target; pendingCount: number; history: Decision[] };

const TASK_TYPES = ["coding", "research", "operations", "documentation", "review", "planning", "design", "other"] as const;
const COMPLEXITIES = ["trivial", "low", "medium", "high"] as const;
const RISKS = ["low", "medium", "high"] as const;
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };
const CONFIG_PATH = join(homedir(), ".omp", "agent", "jev-router.json");
// Bundled default shipped with the npm plugin; user config at CONFIG_PATH overrides it.
const BUNDLED_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "jev-router.json");
const DEFAULT_CONFIG: Config = {
  enabled: true,
  jev: { endpoint: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13", timeoutMs: 1800, cacheSeconds: 300, maxPromptChars: 2000 },
  models: {
    luna: ["openai-codex/gpt-5.6-luna"],
    muse: ["commandcode/meta/muse-spark-1.3-contributor"],
    sol: ["openai-codex/gpt-5.6-sol"],
    deepseek: ["commandcode/deepseek/deepseek-v4.1-flash"],
    opus: ["anthropic/claude-opus-5-5"],
    sonnet: ["anthropic/claude-sonnet-5"],
  },
  thinking: { luna: "low", muse: "low", sol: "high", deepseek: "low", opus: "medium", sonnet: "medium" },
  safety: { enabled: true, mode: "shadow", tools: ["bash", "write", "edit", "ast_edit"] },
  finalEval: { enabled: true, threshold: 0.8 },
  economy: { stickyFollowUps: true, followUpMaxChars: 120, solThinkingBelowHighRisk: "medium" },
  logging: { enabled: true, path: "~/.omp/agent/jev-evals.jsonl" },
};

let config = DEFAULT_CONFIG;
let configMtime = -1;
let enabled = true;
let lastDecisionBySession = new Map<string, Decision>();
const JEV_CACHE_MAX = 20;
const jevCache = new Map<string, { decision: Decision; at: number }>();
const TURNS_MAX = 50;
const HISTORY_MAX = 10;
let keyCache: { value: string; expiresAt: number } | undefined;
let authBlockedUntil = 0;
const turns = new Map<string, TurnState>();
let lastError: string | undefined;

function fallbackCause(message: string): string {
  if (/circuit breaker/i.test(message)) return "auth em espera após 401/403";
  if (/credential/i.test(message)) return "sem credencial OpenRouter";
  const status = /Jev HTTP (\d+)/.exec(message)?.[1];
  if (status) return `Jev HTTP ${status}`;
  if (/abort|timeout/i.test(message)) return "tempo esgotado";
  return "falha de rede";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function loadConfig(): Config {
  // User config wins; plugin install dir provides the shipped default for fresh installs.
  let raw: Record<string, unknown> | undefined;
  let mtime = -1;
  for (const path of [CONFIG_PATH, BUNDLED_CONFIG_PATH]) {
    try {
      mtime = statSync(path).mtimeMs;
      raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
      break;
    } catch {
      continue;
    }
  }
  if (!raw) {
    config = DEFAULT_CONFIG;
    configMtime = -1;
    return config;
  }
  if (mtime === configMtime) return config;
  // Section-level merge keeps partial configs valid; values are trusted local user config.
  config = {
    enabled: raw.enabled !== false,
    jev: { ...DEFAULT_CONFIG.jev, ...asRecord(raw.jev) } as Config["jev"],
    models: { ...DEFAULT_CONFIG.models, ...asRecord(raw.models) } as Config["models"],
    thinking: { ...DEFAULT_CONFIG.thinking, ...asRecord(raw.thinking) } as Config["thinking"],
    safety: { ...DEFAULT_CONFIG.safety, ...asRecord(raw.safety) } as Config["safety"],
    finalEval: { ...DEFAULT_CONFIG.finalEval, ...asRecord(raw.finalEval) } as Config["finalEval"],
    economy: { ...DEFAULT_CONFIG.economy, ...asRecord(raw.economy) } as Config["economy"],
    logging: { ...DEFAULT_CONFIG.logging, ...asRecord(raw.logging) } as Config["logging"],
  };
  configMtime = mtime;
  return config;
}

function normalize(text: unknown): string {
  return String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function logEvent(cfg: Config, event: Record<string, unknown>): void {
  if (!cfg.logging.enabled) return;
  const path = cfg.logging.path.startsWith("~/") ? join(homedir(), cfg.logging.path.slice(2)) : cfg.logging.path;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  } catch {
    // Logging must never affect routing.
  }
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function notify(ctx: RuntimeContext, text: string, level: "info" | "warning" = "info"): void {
  ctx.ui?.notify?.(text, level);
}

function shortId(model: Model | undefined): string {
  if (!model) return "unresolved";
  const id = model.id;
  return id.slice(id.lastIndexOf("/") + 1);
}

function modelName(model: Model | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unresolved";
}

// Provider remains exact; tolerate registry IDs that retain a vendor prefix.
function resolveModel(ctx: RuntimeContext, specs: string[]): Model | undefined {
  const models = ctx.models?.list?.() ?? [];
  for (const rawSpec of specs) {
    const spec = rawSpec.trim().toLowerCase();
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1) continue;
    const wantedProvider = spec.slice(0, slash);
    const wantedId = spec.slice(slash + 1);
    const found = models.find((model) => {
      const provider = String(model?.provider ?? "").trim().toLowerCase();
      const id = String(model?.id ?? "").trim().toLowerCase();
      if (provider !== wantedProvider || !id) return false;
      return id === wantedId || id.endsWith(`/${wantedId}`);
    });
    if (found) return found;
  }
  return undefined;
}

// Sol replaces Terra for moderate risk; thinkingFor() runs it below "high" unless risk is high.
function chooseTarget(type: TaskType, complexity: Complexity, risk: Risk): Target {
  if (risk === "high") return "sol";
  if (type === "planning") return "opus";
  if (type === "design") return "sonnet";
  if (complexity === "trivial") return "luna";
  if (complexity === "high") return "opus";
  if (type === "review" || (risk === "medium" && (type === "coding" || type === "operations"))) return "sol";
  if (type === "research" || (type === "operations" && complexity === "medium")) return "deepseek";
  return "muse";
}

function thinkingFor(cfg: Config, decision: Decision): string {
  return decision.target === "sol" && decision.risk !== "high" ? cfg.economy.solThinkingBelowHighRisk : cfg.thinking[decision.target];
}

const AGENT_BY_TYPE: Record<TaskType, Agent> = {
  planning: "planner",
  research: "researcher",
  review: "reviewer",
  design: "designer",
  operations: "operator",
  coding: "implementer",
  documentation: "general",
  other: "general",
};

// Match tool names only: descriptions of unrelated tools often mention "browser" or "web".
function findTool(tools: Tool[], pattern: RegExp): string | undefined {
  return tools.find((tool) => pattern.test(tool.name ?? ""))?.name;
}

function decisionOf(source: Decision["source"], type: TaskType, complexity: Complexity, risk: Risk, tool?: string): Decision {
  return { source, type, complexity, risk, target: chooseTarget(type, complexity, risk), agent: AGENT_BY_TYPE[type], tool };
}

function fastPath(prompt: string, tools: Tool[]): Decision | undefined {
  const p = normalize(prompt);
  // Screenshot/capture verbs are browser work even without a pasted URL. Bare "print" usually means
  // printing data or logs, so it only fast-paths in screenshot context ("print the page/site").
  if (/\b(screenshot|screenshots|capture|captura|capturar)\b/.test(p)
    || /\bprints?\b[\s\S]{0,30}\b(page|pagina|site|screen|tela)\b/.test(p)
    || /\b(page|pagina|site|screen|tela)\b[\s\S]{0,30}\bprints?\b/.test(p)) {
    return decisionOf("fast-path", "operations", "low", "low", findTool(tools, /^(browser|puppeteer|playwright|screenshot)/i));
  }
  if (/https?:\/\//.test(prompt) && /\b(imagem|foto|image|picture)\b/.test(p)) {
    return decisionOf("fast-path", "operations", "low", "low", findTool(tools, /^(browser|puppeteer|playwright|screenshot)/i));
  }
  if (/^(continue|continua|siga|ok|sim|yes)\.?$/.test(p.trim())) {
    return decisionOf("fast-path", "other", "trivial", "low", findTool(tools, /^read$/));
  }
  return undefined;
}

// Code-vocabulary signal; a bare kebab-case slug (my-trip-to-rome) is not code on its own.
const CODE_WORDS = /\b(bug|erro|error|quebr|fix|corrig|css|component|componente|code|codigo|typescript|javascript|tsx|jsx|refa[cz])/;
const KEBAB_SLUG = /[a-z0-9]+(?:[-_]{1,2}[a-z0-9]+){2,}/;
const CODE_PATH_WORDS = /\b(file|arquivo|path|stack|trace|import|error|log|src|app|components?|styles?)\b/;

// Standalone high-risk signals. Bare "token"/"password"/"senha" are design vocabulary as often as
// secrets, so they only escalate next to a secret-handling action (SECRET_WITH_ACTION below).
const HIGH_RISK_STANDALONE = /\b(production|producao|auth|authentication|authorization|secret|credential|security|seguranca|payment|database|delete|rm -rf|force push|plaintext|hardcoded)\b/;
const SECRET_WITH_ACTION = /\b(token|password|senha)\b[\s\S]{0,40}\b(refresh|rotat|rotac|expir|secret|auth|revog|revok|gerar|generate|reset|trocar|vazou|leak)\b|\b(refresh|rotat|rotac|expir|gerar|generate|reset|trocar|vazou|leak)\b[\s\S]{0,40}\b(token|password|senha)\b/;
const SECRET_COMPROMISE = /\b(token|password|senha|secret|credential)\b[\s\S]{0,40}\b(expir|revog|revok|vazou|leak|exposto|exposed)\b|\b(expir|revog|revok|vazou|leak|exposto|exposed)\b[\s\S]{0,40}\b(token|password|senha|secret|credential)\b/;
const MEDIUM_RISK_WORDS = /\b(deploy|dependency|dependencia|infra|migration|migracao|permission|permissao)\b/;

function highRisk(p: string): boolean {
  // "design token" is a theme file, not a credential: check first, before the standalone list
  // (which contains "auth", a word that also appears in token-refresh flows). Routine
  // refresh/rotate/generate/reset are design-system vocabulary too; only compromise signals
  // (leak/revoke/expire in a secret context) or destructive words escalate here.
  if (/\bdesign tokens?\b/.test(p)) {
    if (/\b(production|producao|payment|database|delete|rm -rf|force push|plaintext|hardcoded)\b/.test(p)) return true;
    return SECRET_COMPROMISE.test(p);
  }
  if (HIGH_RISK_STANDALONE.test(p)) return true;
  return SECRET_WITH_ACTION.test(p);
}

function heuristic(prompt: string, tools: Tool[]): Decision {
  const p = normalize(prompt);
  let type: TaskType = "other";
  if (/\b(plan|planej|roadmap|arquitetura|architecture|estrategia)\b/.test(p)) type = "planning";
  else if (/\b(review|revisao|revisar|audit|auditar)\b/.test(p)) type = "review";
  else if (/\b(linux|docker|server|servidor|terminal|deploy|systemctl|infra)\b/.test(p)) type = "operations";
  else if (/\b(documentacao|documentation|document\b|documentar|documente|readme|docs|changelog)\b/.test(p)) type = "documentation";
  else if (/\b(design|ux|ui|wireframe|visual)\b/.test(p)) type = "design";
  else if (/\b(pesquis|research|buscar|busque|procure|compare|latest|mais recente)\b/.test(p)) type = "research";
  else if (CODE_WORDS.test(p) || (KEBAB_SLUG.test(p) && CODE_PATH_WORDS.test(p))) type = "coding";

  const complexity: Complexity = /\b(complex|complexo|repo inteiro|repository-wide|cross-cutting|migracao|migration|arquitetura)\b/.test(p)
    ? "high"
    : /\b(medium|medio|moderad|varios arquivos|several files|multiple|multiplos)\b/.test(p)
      ? "medium"
      : type === "other" && prompt.length < 60 ? "trivial" : "low";
  let risk: Risk = highRisk(p) ? "high" : MEDIUM_RISK_WORDS.test(p) ? "medium" : "low";
  // "Document the password reset screen" describes UI copy; without a standalone secret/production
  // signal it is not a credential operation. A real compromise (leaked/exposed token needing
  // revoke/expire) stays high even in design/documentation context.
  if (risk === "high" && (type === "documentation" || type === "design")
    && !HIGH_RISK_STANDALONE.test(p) && !SECRET_COMPROMISE.test(p)) risk = "medium";
  return decisionOf("fallback", type, complexity, risk, findTool(tools, /^read$/));
}

function pick<T extends string>(response: JevResponse, id: string, allowed: readonly T[], fallback: T): T {
  const answer = response.answers?.[id];
  const value = answer?.type === "choice" ? answer.choice : undefined;
  return value && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function probability(response: JevResponse, id: string): number {
  const answer = response.answers?.[id];
  return answer?.type === "noul" && typeof answer.noul === "number" ? answer.noul : 0;
}

async function apiKey(ctx: RuntimeContext, forceRefresh: boolean): Promise<string | undefined> {
  if (!forceRefresh && keyCache && keyCache.expiresAt > Date.now()) return keyCache.value;
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("openrouter", sessionId, forceRefresh ? { forceRefresh: true } : undefined).catch(() => undefined);
  const value = (registryKey ?? process.env.OPENROUTER_API_KEY ?? process.env.JEV_API_KEY)?.trim();
  keyCache = value ? { value, expiresAt: Date.now() + 300_000 } : undefined;
  return value;
}

async function postJev(cfg: Config, key: string, state: unknown, questions: Record<string, unknown>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.jev.timeoutMs);
  try {
    return await fetch(cfg.jev.endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "OMP Jev Router" },
      body: JSON.stringify({ model: cfg.jev.model, state, questions }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function callJev(ctx: RuntimeContext, cfg: Config, state: unknown, questions: Record<string, unknown>): Promise<JevResponse> {
  if (Date.now() < authBlockedUntil) throw new Error("Jev auth circuit breaker active");
  const key = await apiKey(ctx, false);
  if (!key) throw new Error("OpenRouter credential unavailable");
  let response = await postJev(cfg, key, state, questions);
  // OAuth-backed keys may be stale: refresh once, then open the breaker if still rejected.
  if (response.status === 401 || response.status === 403) {
    const refreshed = await apiKey(ctx, true);
    if (refreshed && refreshed !== key) response = await postJev(cfg, refreshed, state, questions);
  }
  const text = await response.text();
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      keyCache = undefined;
      authBlockedUntil = Date.now() + 300_000;
    }
    throw new Error(`Jev HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  return asRecord(JSON.parse(text)) as JevResponse;
}

const TRIAGE_QUESTIONS = {
  task_type: {
    type: "choice",
    instructions: "Classify the immediate task. Short bug reports about components, CSS, layout, or APIs are coding.",
    criteria: {
      coding: "Implementing, debugging, testing, or modifying software",
      research: "Gathering or comparing current external information",
      operations: "Browser, screenshots, system, deployment, or infrastructure work",
      documentation: "Writing technical docs, README, or changelog",
      review: "Reviewing code, architecture, security, or quality",
      planning: "Architecture, decomposition, or roadmap",
      design: "UI, UX, or visual design",
      other: "Anything else",
    },
  },
  complexity: {
    type: "choice",
    instructions: "Judge implementation complexity, not message length.",
    criteria: {
      trivial: "Mechanical or immediate",
      low: "Localized task, a few files",
      medium: "Several files or non-obvious debugging",
      high: "Cross-cutting, migration, or long-horizon work",
    },
  },
  risk: {
    type: "choice",
    instructions: "Judge the risk of the requested outcome.",
    criteria: {
      low: "Reversible local change",
      medium: "Dependencies, permissions, or meaningful regression potential",
      high: "Secrets, production, security, destructive, or external side effects",
    },
  },
};

async function decide(prompt: string, ctx: RuntimeContext, cfg: Config, tools: Tool[]): Promise<Decision> {
  const clipped = prompt.slice(0, cfg.jev.maxPromptChars);
  const fast = fastPath(clipped, tools);
  if (fast) {
    logEvent(cfg, { kind: "routing", prompt_hash: hash(clipped), ...fast, thinking: thinkingFor(cfg, fast), latency_ms: 0 });
    return fast;
  }
  const key = hash(clipped);
  const cached = jevCache.get(key);
  if (cached && Date.now() - cached.at < cfg.jev.cacheSeconds * 1000) {
    // Refresh recency; a hit must not log (hot path) — but keep the stored decision as-is.
    jevCache.delete(key);
    jevCache.set(key, cached);
    return cached.decision;
  }

  const baseline = heuristic(clipped, tools);
  const startedAt = Date.now();
  try {
    const response = await callJev(ctx, cfg, { request: clipped }, TRIAGE_QUESTIONS);
    const decision = decisionOf(
      "jev",
      pick(response, "task_type", TASK_TYPES, baseline.type),
      pick(response, "complexity", COMPLEXITIES, baseline.complexity),
      pick(response, "risk", RISKS, baseline.risk),
      baseline.tool,
    );
    jevCache.delete(key);
    jevCache.set(key, { decision, at: Date.now() });
    if (jevCache.size > JEV_CACHE_MAX) jevCache.delete(jevCache.keys().next().value as string);
    logEvent(cfg, { kind: "routing", prompt_hash: key, ...decision, thinking: thinkingFor(cfg, decision), latency_ms: Date.now() - startedAt });
    return decision;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    const message = lastError.slice(0, 160);
    logEvent(cfg, { kind: "routing", prompt_hash: key, ...baseline, thinking: thinkingFor(cfg, baseline), error: message, latency_ms: Date.now() - startedAt });
    notify(ctx, `Jev Router: triagem indisponível (${fallbackCause(lastError)}). Usando regra local: ${baseline.target} (${baseline.type}/${baseline.risk}).`, "warning");
    return baseline;
  }
}

async function applyDecision(pi: ExtensionAPI, ctx: RuntimeContext, cfg: Config, decision: Decision): Promise<Model | undefined> {
  const model = resolveModel(ctx, cfg.models[decision.target]);
  if (!model) {
    notify(ctx, `Jev Router: ${decision.target} indisponível (${cfg.models[decision.target].join(", ")}). Mantendo o modelo atual.`, "warning");
    return undefined;
  }
  const active = ctx.models?.current?.();
  if (active?.provider !== model.provider || active?.id !== model.id) {
    // Model comes from ctx.models.list(), so it is the registry object setModel expects.
    const registryModel = model as unknown as Parameters<ExtensionAPI["setModel"]>[0];
    if (!(await pi.setModel(registryModel))) {
      notify(ctx, `Jev Router: não foi possível ativar ${modelName(model)}. Mantendo o modelo atual.`, "warning");
      return undefined;
    }
    notify(ctx, `Jev Router: trocou para ${decision.target} (${shortId(model)}, thinking ${thinkingFor(cfg, decision)}) — ${decision.type}/${decision.risk}.`);
  }
  try {
    // Config values are OMP thinking levels; the provider clamps unsupported ones.
    pi.setThinkingLevel(thinkingFor(cfg, decision) as unknown as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  } catch {
    // Unsupported thinking level must not block the turn.
  }
  return model;
}

function safeInputText(input: unknown): string {
  try {
    return JSON.stringify(input ?? "").toLowerCase();
  } catch {
    try {
      return String(input).toLowerCase();
    } catch {
      return "";
    }
  }
}

function dangerousCall(toolName: string, input: unknown): string | undefined {
  const text = safeInputText(input);
  if (!text) return undefined;
  if (toolName === "bash" && /\b(rm\s+-rf|mkfs|dd\s+if=|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\s+(-f|--force)|docker\s+system\s+prune|systemctl\s+(stop|disable)|curl\b|wget\b|sudo\b|ssh\b|scp\b)/.test(text)) {
    return "destructive or external shell command";
  }
  if (WRITE_TOOLS[toolName] && /\/etc\/|\.ssh\/|authorized_keys|\.env\b|private[_ -]?key/.test(text)) return "sensitive file write";
  if (WRITE_TOOLS[toolName] && /\b(password|senha|credential|secret|token)\b/.test(text)) return "possible secret write";
  return undefined;
}

function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = asRecord(messages[i]);
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content) return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) => asRecord(part))
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n");
    if (text) return text;
  }
  return "";
}

export default function (pi: ExtensionAPI) {
  const z = pi.zod;
  pi.setLabel("Jev Router");

  pi.registerTool({
    name: "jev_ask",
    label: "Jev Ask",
    description: "Ask Jev a fast calibrated yes/no decision about the current state. Use for narrow decisions, not deep reasoning.",
    parameters: z.object({ state: z.string(), question: z.string() }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const response = await callJev(ctx as RuntimeContext, loadConfig(), { state: params.state.slice(0, 6000) }, {
          answer: { type: "noul", instructions: params.question.slice(0, 1200) },
        });
        const value = probability(response, "answer");
        return { content: [{ type: "text", text: `Jev probability: ${value.toFixed(3)}` }], details: { probability: value } };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Jev unavailable: ${message}` }], details: { error: message } };
      }
    },
  });

  pi.on("before_agent_start", async (event: { prompt?: string }, ctx: RuntimeContext) => {
    const cfg = loadConfig();
    const prompt = event.prompt?.trim();
    if (!cfg.enabled || !enabled || !prompt || prompt.startsWith(CONTINUATION_PREFIX)) return;
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const previous = turns.get(sessionId);
    // OMP can emit this hook twice for one prompt; the first call already routed it.
    if (previous?.prompt === prompt) return;

    const tools = pi.getAllTools() as Tool[];
    const fast = fastPath(prompt, tools);
    const light = heuristic(prompt, tools);
    // Short low-risk follow-ups keep the current model: no Jev call, no switch, prompt cache intact.
    const sticky = cfg.economy.stickyFollowUps && previous !== undefined
      && (fast === undefined || fast.type === "other")
      && prompt.length <= cfg.economy.followUpMaxChars
      && light.risk === "low"
      && (light.complexity === "trivial" || light.complexity === "low")
      && light.type !== "planning" && light.type !== "design";

    // Sticky keeps the previous model but adopts the follow-up's own (low) risk/complexity.
    const decision: Decision = sticky && previous
      ? { ...previous.decision, complexity: light.complexity, risk: light.risk, source: "sticky" }
      : await decide(prompt, ctx, cfg, tools);
    const prevTarget = previous?.sessionTarget;
    const history = [...(previous?.history ?? []), decision].slice(-HISTORY_MAX);
    // Mid-session switch with hysteresis: a single divergent triage must not bust the prompt
    // cache. High risk switches at once; anything else needs the same target twice in a row.
    let effectiveTarget = decision.target;
    let pendingTarget = previous?.pendingTarget;
    let pendingCount = previous?.pendingCount ?? 0;
    if (sticky && previous) {
      effectiveTarget = previous.sessionTarget;
      pendingTarget = undefined;
      pendingCount = 0;
    } else if (prevTarget !== undefined && decision.target !== prevTarget) {
      if (decision.risk === "high") {
        pendingTarget = undefined;
        pendingCount = 0;
      } else if (pendingTarget === decision.target) {
        pendingCount += 1;
        if (pendingCount < 2) effectiveTarget = prevTarget;
        else { pendingTarget = undefined; pendingCount = 0; }
      } else {
        pendingTarget = decision.target;
        pendingCount = 1;
        effectiveTarget = prevTarget;
        logEvent(cfg, { kind: "routing-hold", prompt_hash: hash(prompt), kept: prevTarget, suggested: decision.target, ...decision, latency_ms: 0 });
      }
    } else {
      pendingTarget = undefined;
      pendingCount = 0;
    }
    const switchedTarget = prevTarget !== undefined && effectiveTarget !== prevTarget;
    const sessionTarget = effectiveTarget;
    turns.delete(sessionId);
    turns.set(sessionId, { prompt, decision, writes: 0, continued: false, sessionTarget, pendingTarget, pendingCount, history });
    if (turns.size > TURNS_MAX) turns.delete(turns.keys().next().value as string);
    lastDecisionBySession.set(sessionId, decision);
    if (sticky) logEvent(cfg, { kind: "routing", prompt_hash: hash(prompt), ...decision, thinking: thinkingFor(cfg, decision), latency_ms: 0 });

    let model: Model | undefined;
    if (sticky && previous) {
      model = ctx.models?.current?.();
      // Only Sol changes thinking with risk: drop high → medium for a low-risk follow-up; no model switch.
      const thinking = thinkingFor(cfg, decision);
      if (thinking !== thinkingFor(cfg, previous.decision)) {
        try {
          pi.setThinkingLevel(thinking as unknown as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
        } catch {
          // Unsupported thinking level must not block the turn.
        }
      }
    } else if (!switchedTarget && prevTarget !== undefined && effectiveTarget === prevTarget && decision.target !== prevTarget) {
      // Hysteresis hold: keep the warm model, adjust thinking only.
      model = ctx.models?.current?.();
      notify(ctx, `Jev Router: mantendo ${prevTarget} (cache quente); ${decision.target} sugerido (${pendingCount}/2) — ${decision.type}/${decision.risk}.`);
    } else {
      // Checkpoint before leaving a warm model: history already holds the prior decisions,
      // so /jev-router rewind can restore the previous target without a new triage call.
      if (switchedTarget) logEvent(cfg, { kind: "routing-checkpoint", prompt_hash: hash(prompt), from: prevTarget, to: effectiveTarget });
      const effective: Decision = effectiveTarget === decision.target ? decision : { ...decision, target: effectiveTarget, agent: decision.agent };
      model = await applyDecision(pi, ctx, cfg, effective);
    }
    ctx.ui?.setStatus?.("jev-router", `${decision.target} (${shortId(model)}, ${thinkingFor(cfg, decision)}) · ${decision.type}/${decision.risk}${decision.source === "jev" ? "" : ` · ${decision.source}`}`);
    // No system-prompt injection: a per-turn change would bust the cached prompt prefix every turn.
  });

  pi.on("tool_call", async (event: { toolName: string; input: unknown }, ctx: RuntimeContext) => {
    const cfg = loadConfig();
    if (!cfg.enabled || !enabled || !cfg.safety.enabled || !cfg.safety.tools.includes(event.toolName)) return;
    const reason = dangerousCall(event.toolName, event.input);
    if (!reason) return;
    // Local-only check: tool input is never sent to Jev, so secrets stay on this machine.
    logEvent(cfg, { kind: "safety", tool: event.toolName, mode: cfg.safety.mode, reason, input_hash: hash(safeInputText(event.input)) });
    if (cfg.safety.mode === "enforce") {
      notify(ctx, `Jev Router bloqueou: ${reason} via ${event.toolName}.`, "warning");
      return { block: true, reason: `Jev Router bloqueou: ${reason} via ${event.toolName}.` };
    }
    notify(ctx, `Jev Router [shadow, não bloqueou]: ${reason} via ${event.toolName}. Revise o comando antes de executar.`, "warning");
  });

  pi.on("tool_result", async (event: { toolName: string; isError?: boolean }, ctx: RuntimeContext) => {
    if (!WRITE_TOOLS[event.toolName] || event.isError) return;
    const turn = turns.get(ctx.sessionManager?.getSessionId?.() ?? "default");
    if (turn) turn.writes++;
  });

  pi.on("session_start", async (_event: unknown, ctx: RuntimeContext) => {
    enabled = true;
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    turns.delete(sessionId);
    lastDecisionBySession.delete(sessionId);
    ctx.ui?.setStatus?.("jev-router", "ready");
  });
  pi.registerCommand("jev-router", {
    description: "Jev Router: status | on | off | reload | models | test <prompt> | history | rewind",
    handler: async (args: string, ctx: RuntimeContext) => {
      const command = args.trim();
      const cfg = loadConfig();
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
      if (command === "on" || command === "off") {
        enabled = command === "on";
        notify(ctx, enabled ? "Jev Router ativado: próximas mensagens passam por triagem." : "Jev Router desativado: modelo atual mantido até reativar.");
      } else if (command === "reload") {
        configMtime = -1;
        jevCache.clear();
        keyCache = undefined;
        authBlockedUntil = 0;
        loadConfig();
        notify(ctx, "Jev Router: config recarregada e caches limpos.");
      } else if (command === "models") {
        notify(ctx, (Object.keys(cfg.models) as Target[])
          .map((target) => `${target}: ${modelName(resolveModel(ctx, cfg.models[target]))} (${cfg.thinking[target]})`)
          .join("\n"));
      } else if (command === "test" || command.startsWith("test ")) {
        const decision = await decide(command.slice(4).trim() || "tire prints do site https://app.maleta.dev/ para colocar na home", ctx, cfg, pi.getAllTools() as Tool[]);
        const model = resolveModel(ctx, cfg.models[decision.target]);
        notify(ctx, `${decision.target} (${shortId(model)}, thinking ${thinkingFor(cfg, decision)}) · ${decision.type}/${decision.complexity}/${decision.risk} · ${decision.agent} · origem ${decision.source} · modelo ${modelName(model)} · ferramenta ${decision.tool ?? "nenhuma"}`);
      } else if (command === "history") {
        const turn = turns.get(sessionId);
        notify(ctx, turn?.history?.length
          ? turn.history.map((d, i) => `${i + 1}. ${d.target} · ${d.type}/${d.complexity}/${d.risk} · ${d.source}`).join("\n")
          : "Jev Router: sem histórico nesta sessão.");
      } else if (command === "rewind") {
        const turn = turns.get(sessionId);
        const prev = turn?.history && turn.history.length > 1 ? turn.history[turn.history.length - 2] : undefined;
        if (!turn || !prev) {
          notify(ctx, "Jev Router: nada para reverter nesta sessão.", "warning");
        } else {
          turn.sessionTarget = prev.target;
          turn.pendingTarget = undefined;
          turn.pendingCount = 0;
          logEvent(cfg, { kind: "routing-rewind", prompt_hash: hash(turn.prompt), to: prev.target });
          await applyDecision(pi, ctx, cfg, prev);
        }
      } else if (command === "status" || command === "") {
        const authNote = Date.now() < authBlockedUntil ? " · auth em espera (401/403 recente)" : lastError ? ` · última falha: ${fallbackCause(lastError)}` : "";
        const last = lastDecisionBySession.get(sessionId);
        notify(ctx, last
          ? `${last.target} (${thinkingFor(cfg, last)}) · ${last.type}/${last.complexity}/${last.risk} · ${last.agent} · origem ${last.source} · ferramenta ${last.tool ?? "nenhuma"}${authNote}`
          : `Jev Router: nenhuma decisão ainda${authNote}. Envie uma mensagem ou rode /jev-router test <prompt>.`);
      } else {
        notify(ctx, "Uso: /jev-router [status | on | off | reload | models | test <prompt> | history | rewind]");
      }
    },
  });
}
