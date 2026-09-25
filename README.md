# omp-jev-router

Jev Decision Layer for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`): routes each prompt to the right model + thinking level via fast-path → cached Jev triage (one OpenRouter decisions request) → deterministic policy.

Four decision points, all config-driven, all sharing one Jev client (auth chain + breaker + cache + log):

- **Routing** — each prompt gets a model + thinking level (fast-path → cached Jev triage → `routes`).
- **Tool gate** — the deterministic regex runs first; Jev then answers allow/ask/deny on the *redacted* action (`safety.jev`, off by default).
- **Subagent cascade** — a `task` assignment is graded easy/medium/hard and the child starts on the matching target's model (`cascade`, off by default).
- **Verification** — at session stop Jev checks the final answer against the request and can ask for one more pass (`verify`, off by default).

Routing extras:

- Sticky follow-ups keep the warm model (prompt cache intact)
- Hysteresis: non-high-risk switches need the same target twice
- Shadow-by-default safety net for destructive tool calls
- `/jev-router` command: `status | on | off | reload | config | models | available [provider] | test <prompt> | history | rewind`

## Install

Straight from GitHub (no npm publish needed):

```bash
omp plugin install github:diego-ruas/omp-jev-router
```

Or from a clone (also the local-dev setup; edits are live on the next omp start):

```bash
git clone https://github.com/diego-ruas/omp-jev-router ~/.omp/plugins-src/omp-jev-router
omp plugin link ~/.omp/plugins-src/omp-jev-router
```

The shipped targets point at the author's providers (`openai-codex`, `anthropic`, `commandcode`). On any other setup, `/jev-router models` flags each unresolved target with ⚠, and the router keeps the current model for them. Adapt `targets` to your registry (`/jev-router available`) before relying on it; the prompt below does that for you.

### Install with your AI

Paste this into omp (or any coding agent with shell access):

````text
Install the omp-jev-router plugin for Oh My Pi (omp) and adapt it to my models. Do exactly this, and stop to ask me when a step needs my input:

1. Run `omp --version` (must be 18.x or newer).
2. Install: `omp plugin install github:diego-ruas/omp-jev-router`. If that fails, run
   `git clone https://github.com/diego-ruas/omp-jev-router ~/.omp/plugins-src/omp-jev-router && omp plugin link ~/.omp/plugins-src/omp-jev-router`.
3. If `~/.omp/agent/extensions/jev-router.ts` exists, it is an older copy that would double-route. Rename it to `jev-router.ts.bak`; do not delete it.
4. The shipped defaults use the providers openai-codex, anthropic and commandcode. Ask me to restart omp, run `/jev-router available`, and paste the output. Do not guess model ids.
5. Write `~/.omp/agent/jev-router.json` with overrides only; it is merged over the shipped config. Back up any existing file first.
   - Set `providers.allow` to the providers I actually have.
   - For each target, set `targets.<name>.models` to exact `provider/id` strings copied from my list. Roles: `luna` trivial edits (fast, cheap); `muse` default low-risk work (cheap); `deepseek` research (cheap, long context); `sol` code review and risky work (strong); `opus` planning and high-complexity work (strongest); `sonnet` UI/design.
   - If I lack a good model for a role, reuse a model I do have. Leave `routes` and `thinking` unchanged unless I ask.
6. Triage uses Jev through OpenRouter. If I have no OpenRouter login in omp and no `OPENROUTER_API_KEY`, tell me that the router falls back to a local heuristic, and that logging in to OpenRouter enables triage.
7. Ask me to run `/jev-router reload`, `/jev-router config` and `/jev-router models`, then paste the output. If it reports "config inválida", fix the listed issues. Repeat until every target resolves (no ⚠).
8. Finally, have me run `/jev-router test fix the css bug in the header component` and confirm that it names one of my models.
9. Leave `safety.jev`, `verify` and `cascade` disabled unless I explicitly ask for them: the gate sends the redacted shell command to Jev, `verify` sends the final answer text, and `cascade` overrides the model omp picked for my subagents. If I ask for the gate, set `safety.jev.enabled: true` with `safety.mode: shadow` first, and only switch to `enforce` after I have reviewed `~/.omp/agent/jev-evals.jsonl`.

Change nothing outside `~/.omp/plugins*`, `~/.omp/agent/jev-router.json` and the rename in step 3.
````

Requires a credential for the Jev triage provider (`jev.provider`, default `openrouter`), resolved via `ctx.modelRegistry.getApiKeyForProvider(<provider>, …)` — the same auth you already use in omp — then `OPENROUTER_API_KEY` (openrouter only) / `JEV_API_KEY`. Without it the router falls back to the local heuristic.

## Config

Providers, models, thinking levels and routing policy all live in `jev-router.json`; the code names no target model. The shipped file is the complete default. `~/.omp/agent/jev-router.json` is merged over it:

- objects merge recursively (override one field of one target),
- arrays and scalars replace (`routes`, `models`, `providers.allow`),
- `null` deletes a key (drop a shipped target).

Edits are picked up on the next prompt (mtime check); `/jev-router reload` also clears caches and the auth breaker. An invalid file is rejected as a whole with a list of every problem, and the last valid config stays in effect. Keys from the old layout (`models`, `thinking`, `finalEval`, `economy.solThinkingBelowHighRisk`) are reported, not silently ignored.

| Section | Purpose |
|---|---|
| `jev` | Triage classifier: `provider` (credential lookup), `endpoint`, `model`, `timeoutMs`, `cacheSeconds`, `maxPromptChars` |
| `providers.allow` | Providers targets may use; a target model outside it is a config error. `[]` = any |
| `targets.<name>` | `models`: ordered `provider/id` fallbacks (first one in the omp registry wins, exact provider). `thinking`: `off \| minimal \| low \| medium \| high \| xhigh \| max`, or per risk `{ "high": "high", "default": "medium" }` |
| `routes` | Ordered `{ "when": { "type"?, "complexity"?, "risk"? }, "target" }`; first match wins. Lists inside a field are OR, fields are AND. The last route must omit `when` (catch-all) |
| `safety` | `enabled`, `mode` (`shadow` \| `enforce`), `tools` checked locally |
| `safety.jev` | Tool gate: `enabled`, `tools` (only these are sent, redacted), `timeoutMs`, `cacheSeconds`, `maxActionChars`, `minConfidence`, `askInHeadless` (`warn` \| `block`) |
| `verify` | Post-run check: `enabled`, `minConfidence`, `maxContinuations` (0–8), `maxAnswerChars`, `skipTrivial` |
| `cascade` | Subagent grading: `enabled`, `minConfidence`, `targets` (`easy`/`medium`/`hard` → target name), `maxTaskChars` |
| `economy` | `stickyFollowUps`, `followUpMaxChars` |
| `logging` | `enabled`, `path` (`~/` = home; relative = next to the user config) |

Classifier values: `type` ∈ coding, research, operations, documentation, review, planning, design, other · `complexity` ∈ trivial, low, medium, high · `risk` ∈ low, medium, high.

### The three extra decision points

Each is a separate section, each needs explicit `"enabled": true` (the shipped file ships them `false`), and each logs its own `kind` in the eval log.

**`safety.jev` — the tool gate.** Order of judgement, per tool call:

1. `dangerousCall()` — local regex over the tool input. A hit blocks in `enforce` mode and warns in `shadow`. No Jev call, no network.
2. Anything the regex left alone, if its tool is in `safety.jev.tools`, is sent to Jev as a `choice` (`allow`/`ask`/`deny`) plus a `noul` on irreversibility. Only `actionOf()` output leaves the machine: the shell command, or the target path of a write — never file contents, tool results, or the transcript. Secrets are redacted and the string is capped before sending.
3. Verdicts compose conservatively: a verdict under `minConfidence`, or `irreversible ≥ 0.5`, becomes `ask` (never `allow`, and never a hard `deny`). A confident `deny` blocks; a confident `allow` runs.
4. `ask` with a UI opens `ctx.ui.confirm`. Headless (subagents, `-p`) it follows `askInHeadless`: `warn` notifies and hands the model a scope reminder via `additionalContext`, `block` refuses the call.
5. A Jev failure fails open — the deterministic layer already ran, and the auth breaker stops a dead credential from being retried on every call. Verdicts are cached by the redacted action (`cacheSeconds`), so a repeated command costs one request.

In `shadow` the gate never blocks and never prompts; it only logs and notifies, which is what you want while calibrating thresholds against `jev-evals.jsonl`. Switch `safety.mode` to `enforce` when the log shows no false `deny`/`ask` on your ordinary commands.

**`cascade` — subagent model selection.** `before_subagent_spawn` receives an agent name and a spawn key, but no assignment text, so the parent's `task` tool call records the items and the spawn is matched back by item name, or by spawn order when omp generated the name. Jev grades the assignment into `easy`/`medium`/`hard`; the spawn then starts on `cascade.targets.<difficulty>`'s models at that target's thinking level. Below `minConfidence`, or when the assignment cannot be matched, the spawn keeps whatever omp resolved. Because the child session re-enters routing on its own first prompt, a successful cascade also marks that assignment so the child does not re-triage it and switch back.

**`verify` — the post-run check.** At session stop, Jev sees the request and the final answer's text blocks only (`maxAnswerChars`), and answers a `choice` (`done`/`incomplete`/`wrong_scope`) plus a `noul` ("the answer fully satisfies the request"). A continuation is requested only when the two agree, the answer is not `done`, and confidence clears `minConfidence` — at most `maxContinuations` per session, and never when another stop hook already asked for one. `skipTrivial` leaves trivial/`other` turns alone. A Jev failure never holds the turn open.

Both `safety.jev` and `verify` send data that the routing triage does not: the redacted action, and the final answer text. That is why they are opt-in per install; leave them off for a fully local decision layer.

### Adding a provider or model

1. `/jev-router available <provider>` — lists the exact ids the omp registry exposes (what `targets.*.models` must match).
2. In `~/.omp/agent/jev-router.json`, allow the provider, add the target, and route to it. Example — Gemini for research:

```json
{
  "providers": { "allow": ["openai-codex", "anthropic", "commandcode", "google"] },
  "targets": { "gemini": { "models": ["google/gemini-3-pro"], "thinking": "high" } },
  "routes": [
    { "when": { "risk": ["high"] }, "target": "sol" },
    { "when": { "type": ["research"] }, "target": "gemini" },
    { "target": "muse" }
  ]
}
```

   `routes` replaces the whole list, so copy the shipped routes and insert yours where precedence requires.
3. `/jev-router models` — every target shows its resolved model, `⚠` if none of its specs is in the registry, `sem rota` if no route reaches it. `/jev-router config` shows the effective route table; `/jev-router test <prompt>` dry-runs one decision.

Swapping a model version is a one-line change to `targets.<name>.models`; listing a second spec gives a fallback when the first is not registered.

## Layout

- `extensions/jev-router.ts` — the extension (registered via `omp.extensions` in `package.json`)
- `jev-router.json` — shipped default config; the base every user config is merged over
- `jev-benchmark.py` — reads `~/.omp/agent/jev-evals.jsonl` and summarizes the decision log

Log `kind` values: `routing`, `routing-hold`, `routing-checkpoint`, `routing-rewind`, `safety` (local regex), `safety-jev` (gate verdict), `cascade`, `cascade-handoff`, `verify`.
