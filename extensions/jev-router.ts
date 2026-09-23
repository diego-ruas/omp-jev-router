import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Flow: sticky follow-up → fast path → cached Jev triage (one request) → deterministic policy → model/thinking.
// Jev only classifies; chooseTarget() applies the ordered "routes" from jev-router.json.
// Providers, models, thinking and policy all live in config: adding a provider/model is a JSON edit.
// Token economy: every model switch or system-prompt change invalidates the provider prompt cache and
// re-bills the whole context, so the router avoids both unless the task actually needs a different model.

type TaskType = "coding" | "research" | "operations" | "documentation" | "review" | "planning" | "design" | "other";
type Complexity = "trivial" | "low" | "medium" | "high";
type Risk = "low" | "medium" | "high";
// Target names are config keys (jev-router.json "targets"); adding one needs no code change.
type Target = string;
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

// Thinking per target: one level, or per-risk levels with an optional "default".
type ThinkingSpec = string | Partial<Record<Risk | "default", string>>;
type TargetConfig = { models: string[]; thinking: ThinkingSpec };
type RouteWhen = { type?: TaskType[]; complexity?: Complexity[]; risk?: Risk[] };
type Route = { when?: RouteWhen; target: Target };

type Config = {
  enabled: boolean;
  jev: { provider: string; endpoint: string; model: string; timeoutMs: number; cacheSeconds: number; maxPromptChars: number };
  // Model providers the router may switch to. Empty = any. The Jev provider is separate on purpose.
  providers: { allow: string[] };
  targets: Record<Target, TargetConfig>;
  // Ordered policy: first matching route wins; the last route must be a catch-all (no "when").
  routes: Route[];
  safety: { enabled: boolean; mode: "shadow" | "enforce"; tools: string[] };
  economy: { stickyFollowUps: boolean; followUpMaxChars: number };
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
// decision is the running (effective) decision; pendingTarget is a held hysteresis suggestion.
type TurnState = { prompt: string; decision: Decision; pendingTarget?: Target; pendingCount: number; history: Decision[] };

const TASK_TYPES = ["coding", "research", "operations", "documentation", "review", "planning", "design", "other"] as const;
const COMPLEXITIES = ["trivial", "low", "medium", "high"] as const;
const RISKS = ["low", "medium", "high"] as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const WRITE_TOOLS: Record<string, true> = { write: true, edit: true, ast_edit: true };
const CONTINUATION_PREFIX = "Jev final evaluation:";
// Loader substitutes ${OMP_PLUGIN_ROOT} only in MCP/stdio configs, not in extension code,
// so resolve the same locations here: explicit env wins, install dir via import.meta, homedir last.
const PLUGIN_ROOT = process.env.OMP_PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT
  ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DATA = process.env.PLUGIN_DATA ?? join(homedir(), ".omp", "agent");
const CONFIG_PATH = join(PLUGIN_DATA, "jev-router.json");
// Bundled default shipped with the plugin; the user config at CONFIG_PATH is merged over it.
const BUNDLED_CONFIG_PATH = join(PLUGIN_ROOT, "jev-router.json");

// undefined until a config validates; the router stays inert (and reports why) until then.
let config: Config | undefined;
let configStamp = "";
let configIssues: string[] = [];
let reportedIssuesStamp = "";
let enabled = true;
const JEV_CACHE_MAX = 20;
const jevCache = new Map<string, { decision: Decision; at: number }>();
const TURNS_MAX = 50;
const HISTORY_MAX = 10;
// Auth state is intentionally global: the Jev credential is user-scoped, not session-scoped
// (registry key, OPENROUTER_API_KEY, JEV_API_KEY are identical in every session). A per-session
// breaker would retry the same dead credential once per session; a per-session key cache would
// repeat the same refresh in each. Session-scoped state lives in `turns` (keyed by session id).
let keyCache: { value: string; expiresAt: number } | undefined;
// Auth breaker with half-open probe: a 401/403 on every credential candidate opens it.
// After the backoff elapses the next real triage is the probe (no background request); success
// closes, failure reopens with backoff capped at BREAKER_MAX_MS.
const BREAKER_MAX_MS = 300_000;
const PROBE_AFTER_MS = 30_000;
let authBlockedUntil = 0;
let authFailures = 0;
const turns = new Map<string, TurnState>();
let lastError: string | undefined;

function authDelayMs(failures: number): number {
  return Math.min(BREAKER_MAX_MS, PROBE_AFTER_MS * 2 ** Math.max(0, failures - 1));
}

function resetAuthState(): void {
  keyCache = undefined;
  authBlockedUntil = 0;
  authFailures = 0;
}


function fallbackCause(message: string): string {
  if (/circuit breaker/i.test(message)) {
    const waitS = Math.max(0, Math.ceil((authBlockedUntil - Date.now()) / 1000));
    return waitS > 0 ? `auth em espera após 401/403 (nova tentativa em ~${waitS}s)` : "auth em espera após 401/403 (nova tentativa na próxima mensagem)";
  }
  if (/credential/i.test(message)) return "sem credencial para o Jev";
  const status = /Jev HTTP (\d+)/.exec(message)?.[1];
  if (status) return `Jev HTTP ${status}`;
  if (/abort|timeout/i.test(message)) return "tempo esgotado";
  return "falha de rede";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Objects merge recursively, arrays and scalars replace, null deletes the key.
// So a user file can override one target's thinking, add a target, or replace the route list.
function mergeRaw(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    if (value === null) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeRaw(out[key] as Record<string, unknown>, value);
    else out[key] = value;
  }
  return out;
}

type ConfigFile = { raw?: Record<string, unknown>; stamp: string };

function readConfigFile(path: string, issues: string[]): ConfigFile {
  let mtime: number;
  try {
    mtime = statSync(path).mtimeMs;
  } catch {
    return { stamp: "-" };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPlainObject(parsed)) return { raw: parsed, stamp: String(mtime) };
    issues.push(`${path}: raiz deve ser um objeto JSON`);
  } catch (error) {
    issues.push(`${path}: JSON inválido (${error instanceof Error ? error.message : String(error)})`);
  }
  return { stamp: String(mtime) };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function checkEnumList(value: unknown, allowed: readonly string[], where: string, issues: string[]): void {
  if (!isStringArray(value) || value.length === 0) {
    issues.push(`${where}: deve ser uma lista não vazia`);
    return;
  }
  for (const item of value) if (!allowed.includes(item)) issues.push(`${where}: "${item}" inválido (use ${allowed.join(" | ")})`);
}

// Structural validation of the merged config. Any issue rejects the whole file: the router keeps the
// last valid config instead of routing with half-applied policy.
function validateConfig(raw: Record<string, unknown>, issues: string[]): Config | undefined {
  const section = (name: string): Record<string, unknown> => {
    const value = raw[name];
    if (isPlainObject(value)) return value;
    issues.push(`${name}: seção ausente ou não é objeto`);
    return {};
  };
  // Old layout (top-level models/thinking): silently ignoring these would route with defaults the user thinks they overrode.
  for (const key of ["models", "thinking", "finalEval"]) {
    if (key in raw) issues.push(`${key}: formato antigo; mova para targets.<nome>.models/thinking (veja README)`);
  }
  if (isPlainObject(raw.economy) && "solThinkingBelowHighRisk" in raw.economy) {
    issues.push("economy.solThinkingBelowHighRisk: formato antigo; use targets.sol.thinking = { \"high\": \"high\", \"default\": \"medium\" }");
  }
  const jev = section("jev");
  for (const key of ["provider", "endpoint", "model"]) {
    if (typeof jev[key] !== "string" || !jev[key]) issues.push(`jev.${key}: deve ser texto não vazio`);
  }
  for (const key of ["timeoutMs", "cacheSeconds", "maxPromptChars"]) {
    if (typeof jev[key] !== "number" || !(jev[key] as number >= 0)) issues.push(`jev.${key}: deve ser número >= 0`);
  }

  const providers = section("providers");
  if (!isStringArray(providers.allow)) issues.push("providers.allow: deve ser lista de providers ([] = qualquer)");
  const allow = isStringArray(providers.allow) ? providers.allow.map((p) => p.toLowerCase()) : [];

  const targets = section("targets");
  if (Object.keys(targets).length === 0) issues.push("targets: defina pelo menos um target");
  for (const [name, value] of Object.entries(targets)) {
    const where = `targets.${name}`;
    if (!isPlainObject(value)) {
      issues.push(`${where}: deve ser objeto { models, thinking }`);
      continue;
    }
    if (!isStringArray(value.models) || value.models.length === 0) {
      issues.push(`${where}.models: lista não vazia de "provider/id"`);
    } else {
      for (const spec of value.models) {
        const slash = spec.indexOf("/");
        if (slash <= 0 || slash === spec.length - 1 || /\s/.test(spec)) {
          issues.push(`${where}.models: "${spec}" não está no formato provider/id`);
        } else if (allow.length > 0 && !allow.includes(spec.slice(0, slash).toLowerCase())) {
          issues.push(`${where}.models: provider "${spec.slice(0, slash)}" fora de providers.allow`);
        }
      }
    }
    const thinking = value.thinking;
    if (typeof thinking === "string") {
      if (!(THINKING_LEVELS as readonly string[]).includes(thinking)) issues.push(`${where}.thinking: "${thinking}" inválido (use ${THINKING_LEVELS.join(" | ")})`);
    } else if (isPlainObject(thinking)) {
      for (const [key, level] of Object.entries(thinking)) {
        if (key !== "default" && !(RISKS as readonly string[]).includes(key)) issues.push(`${where}.thinking: chave "${key}" inválida (use default | ${RISKS.join(" | ")})`);
        if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) issues.push(`${where}.thinking.${key}: "${String(level)}" inválido`);
      }
      if (thinking.default === undefined && RISKS.some((risk) => thinking[risk] === undefined)) {
        issues.push(`${where}.thinking: sem "default", precisa cobrir ${RISKS.join(", ")}`);
      }
    } else {
      issues.push(`${where}.thinking: nível ou objeto por risco`);
    }
  }

  const routes = raw.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    issues.push("routes: lista não vazia de { when?, target }");
  } else {
    routes.forEach((route: unknown, index: number) => {
      const where = `routes[${index}]`;
      if (!isPlainObject(route)) {
        issues.push(`${where}: deve ser objeto`);
        return;
      }
      if (typeof route.target !== "string" || !isPlainObject(targets[route.target])) issues.push(`${where}.target: "${String(route.target)}" não existe em targets`);
      const when = route.when;
      const isLast = index === routes.length - 1;
      if (when === undefined) {
        if (!isLast) issues.push(`${where}: catch-all (sem "when") antes do fim torna as rotas seguintes inalcançáveis`);
        return;
      }
      if (!isPlainObject(when) || Object.keys(when).length === 0) {
        issues.push(`${where}.when: objeto com type/complexity/risk; omita "when" para catch-all`);
        return;
      }
      for (const [key, value] of Object.entries(when)) {
        if (key === "type") checkEnumList(value, TASK_TYPES, `${where}.when.type`, issues);
        else if (key === "complexity") checkEnumList(value, COMPLEXITIES, `${where}.when.complexity`, issues);
        else if (key === "risk") checkEnumList(value, RISKS, `${where}.when.risk`, issues);
        else issues.push(`${where}.when: chave "${key}" desconhecida (use type | complexity | risk)`);
      }
      if (isLast) issues.push(`${where}: a última rota deve ser catch-all (sem "when")`);
    });
  }

  const safety = section("safety");
  if (safety.mode !== "shadow" && safety.mode !== "enforce") issues.push(`safety.mode: "${String(safety.mode)}" inválido (use shadow | enforce)`);
  if (!isStringArray(safety.tools)) issues.push("safety.tools: lista de nomes de ferramenta");
  const economy = section("economy");
  if (typeof economy.followUpMaxChars !== "number") issues.push("economy.followUpMaxChars: deve ser número");
  const logging = section("logging");
  if (typeof logging.path !== "string" || !logging.path) issues.push("logging.path: deve ser texto não vazio");

  if (issues.length > 0) return undefined;
  return {
    enabled: raw.enabled !== false,
    jev: jev as Config["jev"],
    providers: { allow },
    targets: targets as Config["targets"],
    routes: routes as Route[],
    safety: { ...safety, enabled: safety.enabled !== false } as Config["safety"],
    economy: { stickyFollowUps: economy.stickyFollowUps !== false, followUpMaxChars: economy.followUpMaxChars as number },
    logging: { enabled: logging.enabled !== false, path: logging.path as string },
  };
}

function loadConfig(): Config | undefined {
  const issues: string[] = [];
  const bundled = readConfigFile(BUNDLED_CONFIG_PATH, issues);
  // Standalone installs (~/.omp/agent/extensions) resolve both paths to the same file.
  const user: ConfigFile = CONFIG_PATH === BUNDLED_CONFIG_PATH ? { stamp: "" } : readConfigFile(CONFIG_PATH, issues);
  const stamp = `${bundled.stamp}|${user.stamp}`;
  if (stamp === configStamp) return config;
  configStamp = stamp;
  if (!bundled.raw && !user.raw && issues.length === 0) issues.push(`nenhuma config encontrada (${BUNDLED_CONFIG_PATH}, ${CONFIG_PATH})`);
  const next = issues.length === 0 ? validateConfig(mergeRaw(bundled.raw ?? {}, user.raw ?? {}), issues) : undefined;
  configIssues = issues;
  if (next) {
    config = next;
    // Cached decisions carry a target resolved under the old policy; the key may be for another provider.
    jevCache.clear();
    resetAuthState();
  }
  return config;
}

// Surface config problems once per file change, in the UI the user is looking at.
function reportConfigIssues(ctx: RuntimeContext): void {
  if (configIssues.length === 0 || reportedIssuesStamp === configStamp) return;
  reportedIssuesStamp = configStamp;
  const kept = config ? "mantendo a última config válida" : "roteamento desativado até corrigir";
  notify(ctx, `Jev Router: config inválida, ${kept}:\n- ${configIssues.join("\n- ")}`, "warning");
}

function normalize(text: unknown): string {
  return String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const LOG_FLUSH_MS = 2000;
const LOG_BATCH_MAX = 50;
let logBuffer: string[] = [];
let logTimer: NodeJS.Timeout | undefined;
let logPathCache = "";
let logPathResolved = "";

function flushLog(): void {
  if (logTimer !== undefined) {
    clearTimeout(logTimer);
    logTimer = undefined;
  }
  if (logBuffer.length === 0 || !logPathCache) return;
  const batch = logBuffer.join("");
  logBuffer = [];
  try {
    appendFileSync(logPathCache, batch);
  } catch {
    // Logging must never affect routing.
  }
}

if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("exit", flushLog);
}

function logEvent(cfg: Config, event: Record<string, unknown>, flush = false): void {
  if (!cfg.logging.enabled) return;
  // "~/x" is home-relative; a relative path lives next to the user config (PLUGIN_DATA).
  const path = cfg.logging.path.startsWith("~/") ? join(homedir(), cfg.logging.path.slice(2)) : resolve(PLUGIN_DATA, cfg.logging.path);
  if (path !== logPathResolved) {
    flushLog();
    logPathCache = path;
    logPathResolved = path;
  }
  logBuffer.push(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  if (flush || logBuffer.length >= LOG_BATCH_MAX) {
    flushLog();
    return;
  }
  if (logTimer === undefined) {
    logTimer = setTimeout(flushLog, LOG_FLUSH_MS);
    const timer = logTimer as unknown as { unref?: () => void };
    timer.unref?.();
  }
}


function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
// Cache key: follow-up rewrites ("e agora o footer?" vs "e agora o header?") must differ,
// but case/accent/punctuation/whitespace rewrites of the same prompt should hit.
function cacheKey(text: string): string {
  return hash(normalize(text).replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim());
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

// First matching route wins. validateConfig() guarantees a trailing catch-all and known targets.
function chooseTarget(cfg: Config, type: TaskType, complexity: Complexity, risk: Risk): Target {
  const route = cfg.routes.find(({ when }) => !when
    || ((!when.type || when.type.includes(type))
      && (!when.complexity || when.complexity.includes(complexity))
      && (!when.risk || when.risk.includes(risk))));
  return (route ?? cfg.routes[cfg.routes.length - 1]).target;
}

function thinkingFor(cfg: Config, decision: Decision): string {
  const spec = cfg.targets[decision.target]?.thinking ?? "medium";
  return typeof spec === "string" ? spec : spec[decision.risk] ?? spec.default ?? "medium";
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

function decisionOf(cfg: Config, source: Decision["source"], type: TaskType, complexity: Complexity, risk: Risk, tool?: string): Decision {
  return { source, type, complexity, risk, target: chooseTarget(cfg, type, complexity, risk), agent: AGENT_BY_TYPE[type], tool };
}

function fastPath(cfg: Config, prompt: string, tools: Tool[]): Decision | undefined {
  const p = normalize(prompt);
  // Screenshot/capture verbs are browser work even without a pasted URL. Bare "print" usually means
  // printing data or logs, so it only fast-paths in screenshot context ("print the page/site").
  if (/\b(screenshot|screenshots|capture|captura|capturar)\b/.test(p)
    || /\bprints?\b[\s\S]{0,30}\b(page|pagina|site|screen|tela)\b/.test(p)
    || /\b(page|pagina|site|screen|tela)\b[\s\S]{0,30}\bprints?\b/.test(p)) {
    return decisionOf(cfg, "fast-path", "operations", "low", "low", findTool(tools, /^(browser|puppeteer|playwright|screenshot)/i));
  }
  if (/https?:\/\//.test(prompt) && /\b(imagem|foto|image|picture)\b/.test(p)) {
    return decisionOf(cfg, "fast-path", "operations", "low", "low", findTool(tools, /^(browser|puppeteer|playwright|screenshot)/i));
  }
  if (/^(continue|continua|siga|ok|sim|yes)\.?$/.test(p.trim())) {
    return decisionOf(cfg, "fast-path", "other", "trivial", "low", findTool(tools, /^read$/));
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
// Stems (rotat, expir, revog…) need \w* before the closing \b, or "rotate"/"expired" never match.
const SECRET_WITH_ACTION = /\b(token|password|senha)\b[\s\S]{0,40}\b(refresh|rotat\w*|rotac\w*|expir\w*|secret|auth|revog\w*|revok\w*|gerar|generate|reset|trocar|vazou|leak)\b|\b(refresh|rotat\w*|rotac\w*|expir\w*|gerar|generate|reset|trocar|vazou|leak)\b[\s\S]{0,40}\b(token|password|senha)\b/;
const SECRET_COMPROMISE = /\b(token|password|senha|secret|credential)\b[\s\S]{0,40}\b(expir\w*|revog\w*|revok\w*|vazou|leak|exposto|exposed)\b|\b(expir\w*|revog\w*|revok\w*|vazou|leak|exposto|exposed)\b[\s\S]{0,40}\b(token|password|senha|secret|credential)\b/;
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

function heuristic(cfg: Config, prompt: string, tools: Tool[]): Decision {
  const p = normalize(prompt);
  let type: TaskType = "other";
  if (/\b(plan|planej\w*|roadmap|arquitetura|architecture|estrategia)\b/.test(p)) type = "planning";
  else if (/\b(review|revisao|revisar|audit|auditar)\b/.test(p)) type = "review";
  else if (/\b(linux|docker|server|servidor|terminal|deploy|systemctl|infra)\b/.test(p)) type = "operations";
  else if (/\b(documentacao|documentation|document\b|documentar|documente|readme|docs|changelog)\b/.test(p)) type = "documentation";
  else if (/\b(design|ux|ui|wireframe|visual)\b/.test(p)) type = "design";
  else if (/\b(pesquis\w*|research|buscar|busque|procure|compare|latest|mais recente)\b/.test(p)) type = "research";
  else if (CODE_WORDS.test(p) || (KEBAB_SLUG.test(p) && CODE_PATH_WORDS.test(p))) type = "coding";

  const complexity: Complexity = /\b(complex|complexo|repo inteiro|repository-wide|cross-cutting|migracao|migration|arquitetura)\b/.test(p)
    ? "high"
    : /\b(medium|medio|moderad\w*|varios arquivos|several files|multiple|multiplos)\b/.test(p)
      ? "medium"
      : type === "other" && prompt.length < 60 ? "trivial" : "low";
  let risk: Risk = highRisk(p) ? "high" : MEDIUM_RISK_WORDS.test(p) ? "medium" : "low";
  // "Document the password reset screen" describes UI copy; without a standalone secret/production
  // signal it is not a credential operation. A real compromise (leaked/exposed token needing
  // revoke/expire) stays high even in design/documentation context.
  if (risk === "high" && (type === "documentation" || type === "design")
    && !HIGH_RISK_STANDALONE.test(p) && !SECRET_COMPROMISE.test(p)) risk = "medium";
  return decisionOf(cfg, "fallback", type, complexity, risk, findTool(tools, /^read$/));
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

async function registryKey(ctx: RuntimeContext, cfg: Config, forceRefresh: boolean): Promise<string | undefined> {
  if (!forceRefresh && keyCache && keyCache.expiresAt > Date.now()) return keyCache.value;
  const sessionId = ctx.sessionManager?.getSessionId?.();
  const value = (await ctx.modelRegistry?.getApiKeyForProvider?.(cfg.jev.provider, sessionId, forceRefresh ? { forceRefresh: true } : undefined).catch(() => undefined))?.trim() || undefined;
  keyCache = value ? { value, expiresAt: Date.now() + 300_000 } : undefined;
  return value;
}

async function apiCandidates(ctx: RuntimeContext, cfg: Config, forceRefresh: boolean): Promise<string[]> {
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const raw of [await registryKey(ctx, cfg, forceRefresh), cfg.jev.provider === "openrouter" ? process.env.OPENROUTER_API_KEY : undefined, process.env.JEV_API_KEY]) {
    const value = raw?.trim();
    if (value && !seen[value]) {
      seen[value] = true;
      out.push(value);
    }
  }
  return out;
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

function openAuthBreaker(accountDead: boolean): void {
  keyCache = undefined;
  authFailures = accountDead ? 5 : authFailures + 1;
  authBlockedUntil = Date.now() + authDelayMs(authFailures);
}

async function callJev(ctx: RuntimeContext, cfg: Config, state: unknown, questions: Record<string, unknown>): Promise<JevResponse> {
  // Elapsed backoff means the next real triage is the half-open probe: let it through.
  if (Date.now() < authBlockedUntil) throw new Error("Jev auth circuit breaker active");
  const tried: Record<string, true> = {};
  let lastStatus = 0;
  let lastBody = "";
  let sawAccountDead = false;
  for (let round = 0; round < 2; round++) {
    const candidates = await apiCandidates(ctx, cfg, round === 1);
    if (round === 0 && candidates.length === 0) throw new Error(`${cfg.jev.provider} credential unavailable`);
    for (const key of candidates) {
      if (tried[key]) continue;
      tried[key] = true;
      const response = await postJev(cfg, key, state, questions);
      if (response.status !== 401 && response.status !== 403) {
        const text = await response.text();
        if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${text.slice(0, 160)}`);
        authBlockedUntil = 0;
        authFailures = 0;
        keyCache = { value: key, expiresAt: Date.now() + 300_000 };
        return asRecord(JSON.parse(text)) as JevResponse;
      }
      const body = await response.text();
      lastStatus = response.status;
      lastBody = body;
      // Account gone for this candidate: skip it and try the next one. A forced refresh
      // cannot resurrect it, but the env/JEV_API_KEY candidates may belong to another account.
      if (/user not found/i.test(body)) sawAccountDead = true;
    }
    // Same key back from a forced refresh means the registry has nothing new: stop, don't loop.
    if (round === 1) break;
  }
  openAuthBreaker(sawAccountDead);
  const detail = lastBody.slice(0, 160) || "all credential candidates rejected";
  throw new Error(`Jev HTTP ${lastStatus || 401}: ${detail}`);
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
  const fast = fastPath(cfg, clipped, tools);
  if (fast) {
    logEvent(cfg, { kind: "routing", prompt_hash: hash(clipped), prompt_len: clipped.length, ...fast, thinking: thinkingFor(cfg, fast), latency_ms: 0 });
    return fast;
  }
  const key = cacheKey(clipped);
  const cached = jevCache.get(key);
  if (cached && Date.now() - cached.at < cfg.jev.cacheSeconds * 1000) {
    // Refresh recency; a hit must not log (hot path) — but keep the stored decision as-is.
    jevCache.delete(key);
    jevCache.set(key, cached);
    return cached.decision;
  }

  const baseline = heuristic(cfg, clipped, tools);
  const startedAt = Date.now();
  try {
    const response = await callJev(ctx, cfg, { request: clipped }, TRIAGE_QUESTIONS);
    const decision = decisionOf(
      cfg,
      "jev",
      pick(response, "task_type", TASK_TYPES, baseline.type),
      pick(response, "complexity", COMPLEXITIES, baseline.complexity),
      pick(response, "risk", RISKS, baseline.risk),
      baseline.tool,
    );
    jevCache.delete(key);
    jevCache.set(key, { decision, at: Date.now() });
    if (jevCache.size > JEV_CACHE_MAX) jevCache.delete(jevCache.keys().next().value as string);
    logEvent(cfg, { kind: "routing", prompt_hash: key, prompt_len: clipped.length, ...decision, thinking: thinkingFor(cfg, decision), latency_ms: Date.now() - startedAt }, true);
    return decision;
  } catch (error) {
    const cause = error instanceof Error ? (error.cause === undefined ? "" : ` | cause: ${String(error.cause).slice(0, 80)}`) : "";
    lastError = error instanceof Error ? error.message : String(error);
    const message = `${lastError.slice(0, 160)}${cause}`;
    logEvent(cfg, { kind: "routing", prompt_hash: key, prompt_len: clipped.length, ...baseline, thinking: thinkingFor(cfg, baseline), error: message, latency_ms: Date.now() - startedAt }, true);
    notify(ctx, `Jev Router: triagem indisponível (${fallbackCause(lastError)}). Usando regra local: ${baseline.target} (${baseline.type}/${baseline.risk}).`, "warning");
    return baseline;
  }
}

async function applyDecision(pi: ExtensionAPI, ctx: RuntimeContext, cfg: Config, decision: Decision): Promise<Model | undefined> {
  const specs = cfg.targets[decision.target]?.models ?? [];
  const model = resolveModel(ctx, specs);
  if (!model) {
    notify(ctx, `Jev Router: ${decision.target} indisponível (${specs.join(", ") || "target fora da config"}). Mantendo o modelo atual.`, "warning");
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
  setThinking(pi, thinkingFor(cfg, decision));
  return model;
}

function setThinking(pi: ExtensionAPI, level: string): void {
  try {
    // Config values are OMP thinking levels; the provider clamps unsupported ones.
    pi.setThinkingLevel(level as unknown as Parameters<ExtensionAPI["setThinkingLevel"]>[0]);
  } catch {
    // Unsupported thinking level must not block the turn.
  }
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
  if (toolName === "bash" && /\b(rm\s+-rf|mkfs|dd\s+if=|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|git\s+push\s+(-f|--force)|docker\s+system\s+prune|systemctl\s+(stop|disable)|curl\b|wget\b|sudo\b|ssh\b|scp\b|credential|secret|password|token)\b/.test(text)) {
    return "destructive or external shell command";
  }
  if (WRITE_TOOLS[toolName] && /\/etc\/|\.ssh\/|authorized_keys|\.env\b|private[_ -]?key/.test(text)) return "sensitive file write";
  if (WRITE_TOOLS[toolName] && /\b(password|senha|credential|secret|token)\b/.test(text)) return "possible secret write";
  return undefined;
}

// Test seam: pure functions with no omp dependency, exercised by bun test and the
// pre-commit/pre-release gate. Tree-shaken from the shipped plugin (default export only).
export const __jevRouterTest = {
  mergeRaw,
  validateConfig,
  chooseTarget,
  thinkingFor,
  fastPath,
  heuristic,
  highRisk,
  normalize,
  cacheKey,
  resolveModel,
  pick,
  dangerousCall,
  callJev,
  authDelayMs,
  resetAuthState,
  authState: () => ({ blockedUntil: authBlockedUntil, failures: authFailures }),
  TASK_TYPES,
  COMPLEXITIES,
  RISKS,
};

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
        const cfg = loadConfig();
        if (!cfg) throw new Error(`config inválida: ${configIssues.join("; ")}`);
        const response = await callJev(ctx as RuntimeContext, cfg, { state: params.state.slice(0, 6000) }, {
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

  // Serialize per session: OMP can emit this hook twice for one prompt, and concurrent
  // subagents share this module. Without the gate both calls run decide() → double Jev
  // billing and a last-writer-wins race on turns.
  const routing = new Map<string, Promise<void>>();
  pi.on("before_agent_start", async (event: { prompt?: string }, ctx: RuntimeContext) => {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    while (routing.has(sessionId)) await routing.get(sessionId)?.catch(() => undefined);
    let release: () => void = () => undefined;
    routing.set(sessionId, new Promise<void>((resolve) => { release = resolve; }));
    try {
      await routeTurn(pi, event.prompt, ctx);
    } finally {
      routing.delete(sessionId);
      release();
    }
  });

  async function routeTurn(pi: ExtensionAPI, rawPrompt: string | undefined, ctx: RuntimeContext): Promise<void> {
    const cfg = loadConfig();
    reportConfigIssues(ctx);
    const prompt = rawPrompt?.trim();
    if (!cfg || !cfg.enabled || !enabled || !prompt || prompt.startsWith(CONTINUATION_PREFIX)) return;
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    const previous = turns.get(sessionId);
    if (previous?.prompt === prompt) return;

    const tools = pi.getAllTools() as Tool[];
    const fast = fastPath(cfg, prompt, tools);
    const light = heuristic(cfg, prompt, tools);
    // Short low-risk follow-ups keep the current model: no Jev call, no switch, prompt cache intact.
    const sticky = cfg.economy.stickyFollowUps && previous !== undefined
      && (fast === undefined || fast.type === "other")
      && prompt.length <= cfg.economy.followUpMaxChars
      && light.risk === "low"
      && (light.complexity === "trivial" || light.complexity === "low")
      && light.type !== "planning" && light.type !== "design";

    // Sticky keeps the running model and adopts the follow-up's own low risk/complexity, so
    // per-risk thinking can drop. previous.decision is always the running (effective) decision.
    const decision: Decision = sticky && previous
      ? { ...previous.decision, complexity: light.complexity, risk: light.risk, source: "sticky" }
      : await decide(prompt, ctx, cfg, tools);
    const prevTarget = previous?.decision.target;
    // Mid-session switch with hysteresis: a single divergent triage must not bust the prompt
    // cache. High risk switches at once; anything else needs the same target twice in a row.
    let effectiveTarget = decision.target;
    let pendingTarget: Target | undefined;
    let pendingCount = 0;
    if (prevTarget !== undefined && decision.target !== prevTarget && decision.risk !== "high") {
      pendingCount = previous?.pendingTarget === decision.target ? previous.pendingCount + 1 : 1;
      if (pendingCount < 2) {
        pendingTarget = decision.target;
        effectiveTarget = prevTarget;
        logEvent(cfg, { kind: "routing-hold", prompt_hash: hash(prompt), kept: prevTarget, suggested: decision.target, ...decision, latency_ms: 0 });
      } else {
        pendingCount = 0;
      }
    }
    // The running decision: the suggested one, or the held target judged with this prompt's risk.
    let effective: Decision = effectiveTarget === decision.target ? decision : { ...decision, target: effectiveTarget };
    if (sticky) logEvent(cfg, { kind: "routing", prompt_hash: hash(prompt), ...decision, thinking: thinkingFor(cfg, decision), latency_ms: 0 });

    let model: Model | undefined;
    if (sticky || pendingTarget !== undefined) {
      // Same target: keep whatever model is running (respects a manual switch); thinking follows risk.
      model = ctx.models?.current?.();
      if (pendingTarget !== undefined) {
        notify(ctx, `Jev Router: mantendo ${effectiveTarget} (cache quente); ${pendingTarget} sugerido (${pendingCount}/2) — ${decision.type}/${decision.risk}.`);
      }
      const thinking = thinkingFor(cfg, effective);
      if (!previous || thinking !== thinkingFor(cfg, previous.decision)) setThinking(pi, thinking);
    } else {
      // Checkpoint before leaving a warm model: history holds the prior running decisions,
      // so /jev-router rewind can restore the previous target without a new triage call.
      if (prevTarget !== undefined && effectiveTarget !== prevTarget) {
        logEvent(cfg, { kind: "routing-checkpoint", prompt_hash: hash(prompt), from: prevTarget, to: effectiveTarget });
      }
      model = await applyDecision(pi, ctx, cfg, effective);
      // Switch failed: the old model is still running, so state must keep pointing at it.
      if (!model && previous) effective = { ...effective, target: previous.decision.target };
    }
    const history = [...(previous?.history ?? []), effective].slice(-HISTORY_MAX);
    turns.delete(sessionId);
    turns.set(sessionId, { prompt, decision: effective, pendingTarget, pendingCount, history });
    if (turns.size > TURNS_MAX) turns.delete(turns.keys().next().value as string);
    const pendingNote = pendingTarget !== undefined ? ` · ${pendingTarget}? ${pendingCount}/2` : "";
    ctx.ui?.setStatus?.("jev-router", `${effective.target} (${shortId(model)}, ${thinkingFor(cfg, effective)}) · ${effective.type}/${effective.risk}${effective.source === "jev" ? "" : ` · ${effective.source}`}${pendingNote}`);
    // No system-prompt injection: a per-turn change would bust the cached prompt prefix every turn.
  }

  pi.on("tool_call", async (event: { toolName: string; input: unknown }, ctx: RuntimeContext) => {
    const cfg = loadConfig();
    if (!cfg || !cfg.enabled || !enabled || !cfg.safety.enabled || !cfg.safety.tools.includes(event.toolName)) return;
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

  pi.on("session_start", async (_event: unknown, ctx: RuntimeContext) => {
    enabled = true;
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
    turns.delete(sessionId);
    ctx.ui?.setStatus?.("jev-router", "ready");
  });
  pi.registerCommand("jev-router", {
    description: "Jev Router: status | on | off | reload | config | models | available [provider] | test <prompt> | history | rewind",
    handler: async (args: string, ctx: RuntimeContext) => {
      const command = args.trim();
      if (command === "reload") {
        configStamp = "";
        reportedIssuesStamp = "";
        jevCache.clear();
        resetAuthState();
      }
      const cfg = loadConfig();
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "default";
      const invalid = configIssues.length > 0 ? `\nConfig inválida:\n- ${configIssues.join("\n- ")}` : "";
      if (command === "on" || command === "off") {
        enabled = command === "on";
        notify(ctx, enabled ? "Jev Router ativado: próximas mensagens passam por triagem." : "Jev Router desativado: modelo atual mantido até reativar.");
      } else if (command === "reload") {
        notify(ctx, invalid ? `Jev Router: caches limpos.${invalid}` : "Jev Router: config recarregada e caches limpos.", invalid ? "warning" : "info");
      } else if (command === "config") {
        const summary = cfg
          ? [
            `jev: ${cfg.jev.provider} · ${cfg.jev.model}`,
            `providers permitidos: ${cfg.providers.allow.length > 0 ? cfg.providers.allow.join(", ") : "qualquer"}`,
            "rotas (primeira que casar vence):",
            ...cfg.routes.map((route, i) => {
              const when = route.when
                ? Object.entries(route.when).map(([key, values]) => `${key}=${(values as string[]).join("|")}`).join(" ")
                : "qualquer";
              return `  ${i + 1}. ${when} → ${route.target}`;
            }),
          ].join("\n")
          : "sem config válida carregada";
        notify(ctx, `Jev Router config\nbundled: ${BUNDLED_CONFIG_PATH}\nusuário: ${CONFIG_PATH}\n${summary}${invalid}`, invalid ? "warning" : "info");
      } else if (command === "available" || command.startsWith("available ")) {
        // Registry view for writing "provider/id" specs: exactly what resolveModel() can match.
        const wanted = command.slice(9).trim().toLowerCase();
        const byProvider = new Map<string, string[]>();
        for (const model of ctx.models?.list?.() ?? []) {
          const provider = String(model.provider ?? "").toLowerCase();
          if (wanted && provider !== wanted) continue;
          const ids = byProvider.get(provider) ?? [];
          ids.push(String(model.id));
          byProvider.set(provider, ids);
        }
        notify(ctx, byProvider.size > 0
          ? [...byProvider].sort(([a], [b]) => a.localeCompare(b)).map(([provider, ids]) => `${provider} (${ids.length}):\n  ${ids.sort().join("\n  ")}`).join("\n")
          : wanted ? `Jev Router: nenhum modelo do provider "${wanted}" no registro.` : "Jev Router: registro de modelos vazio.");
      } else if (!cfg) {
        notify(ctx, `Jev Router: sem config válida; corrija e rode /jev-router reload.${invalid}`, "warning");
      } else if (command === "models") {
        const used = new Set(cfg.routes.map((route) => route.target));
        notify(ctx, Object.entries(cfg.targets)
          .map(([target, { models, thinking }]) => {
            const model = resolveModel(ctx, models);
            const level = typeof thinking === "string" ? thinking : Object.entries(thinking).map(([key, value]) => `${key}:${value}`).join(" ");
            const notes = [model ? "" : ` ⚠ nenhum de ${models.join(", ")} no registro`, used.has(target) ? "" : " · sem rota"].join("");
            return `${target}: ${modelName(model)} (${level})${notes}`;
          })
          .join("\n"));
      } else if (command === "test" || command.startsWith("test ")) {
        const decision = await decide(command.slice(4).trim() || "tire prints do site https://app.maleta.dev/ para colocar na home", ctx, cfg, pi.getAllTools() as Tool[]);
        const model = resolveModel(ctx, cfg.targets[decision.target]?.models ?? []);
        notify(ctx, `${decision.target} (${shortId(model)}, thinking ${thinkingFor(cfg, decision)}) · ${decision.type}/${decision.complexity}/${decision.risk} · ${decision.agent} · origem ${decision.source} · modelo ${modelName(model)} · ferramenta ${decision.tool ?? "nenhuma"}`);
      } else if (command === "history") {
        const turn = turns.get(sessionId);
        notify(ctx, turn?.history?.length
          ? turn.history.map((d, i) => `${i + 1}. ${d.target} · ${d.type}/${d.complexity}/${d.risk} · ${d.source}`).join("\n")
          : "Jev Router: sem histórico nesta sessão.");
      } else if (command === "rewind") {
        const turn = turns.get(sessionId);
        const prev = turn && turn.history.length > 1 ? turn.history[turn.history.length - 2] : undefined;
        if (!turn || !prev) {
          notify(ctx, "Jev Router: nada para reverter nesta sessão.", "warning");
        } else if (await applyDecision(pi, ctx, cfg, prev)) {
          // Pop the undone decision so a second rewind steps further back instead of toggling.
          turn.history.pop();
          turn.decision = prev;
          turn.pendingTarget = undefined;
          turn.pendingCount = 0;
          logEvent(cfg, { kind: "routing-rewind", prompt_hash: hash(turn.prompt), to: prev.target });
        }
      } else if (command === "status" || command === "") {
        const authNote = Date.now() < authBlockedUntil ? " · auth em espera (401/403 recente)" : lastError ? ` · última falha: ${fallbackCause(lastError)}` : "";
        const turn = turns.get(sessionId);
        const last = turn?.decision;
        const pendingNote = turn?.pendingTarget !== undefined ? ` · ${turn.pendingTarget} sugerido (${turn.pendingCount}/2)` : "";
        notify(ctx, last
          ? `${last.target} (${thinkingFor(cfg, last)}) · ${last.type}/${last.complexity}/${last.risk} · ${last.agent} · origem ${last.source} · ferramenta ${last.tool ?? "nenhuma"}${pendingNote}${authNote}${invalid}`
          : `Jev Router: nenhuma decisão ainda${authNote}. Envie uma mensagem ou rode /jev-router test <prompt>.${invalid}`);
      } else {
        notify(ctx, "Uso: /jev-router [status | on | off | reload | config | models | available [provider] | test <prompt> | history | rewind]");
      }
    },
  });
}
