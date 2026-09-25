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
| `jev` | Triage classifier: `provider` (credential lookup), `endpoint`, `model`, `timeoutMs`, `cacheSeconds`, `maxPromptChars`, `minConfidence` (abstention threshold), `decisionTtlMs` (prepared-decision expiry) |
| `providers.allow` | Providers targets may use; a target model outside it is a config error. `[]` = any |
| `targets.<name>` | `models`: ordered `provider/id` fallbacks (first one in the omp registry wins, exact provider). `thinking`: `off \| minimal \| low \| medium \| high \| xhigh \| max`, or per risk `{ "high": "high", "default": "medium" }`. `description` (optional, ≤160 chars): the text the selector reads for this candidate |
| `decision.mode` | `classify` (default): Jev answers the label questions and the host applies `routes`. `select`: Jev picks one prepared candidate ID instead. With `select` the `routes` table stops choosing the target — it still supplies the deterministic fallback and the labels that map to thinking — so use `classify` when the table is a policy you want enforced (risk → strong model, for instance) |
| `routes` | Ordered `{ "when": { "type"?, "complexity"?, "risk"? }, "target" }`; first match wins. Lists inside a field are OR, fields are AND. The last route must omit `when` (catch-all) |
| `safety` | `enabled`, `mode` (`shadow` \| `enforce`), `tools` checked locally |
| `safety.jev` | Tool gate: `enabled`, `tools` (only these are sent, redacted), `timeoutMs`, `cacheSeconds`, `maxActionChars`, `minConfidence`, `askInHeadless` (`warn` \| `block`) |
| `verify` | Post-run check: `enabled`, `minConfidence`, `maxContinuations` (0–8), `maxAnswerChars`, `skipTrivial` |
| `cascade` | Subagent grading: `enabled`, `minConfidence`, `targets` (`easy`/`medium`/`hard` → target name), `maxTaskChars` |
| `economy` | `stickyFollowUps`, `followUpMaxChars`, `respectManualModel` (a model chosen outside the router is kept) |
| `logging` | `enabled`, `path` (`~/` = home; relative = next to the user config) |

Classifier values: `type` ∈ coding, research, operations, documentation, review, planning, design, other · `complexity` ∈ trivial, low, medium, high · `risk` ∈ low, medium, high.

### The three extra decision points

Each is a separate section, each needs explicit `"enabled": true` (the shipped file ships them `false`), and each logs its own `kind` in the eval log.

**`safety.jev` — the tool gate.** Order of judgement, per tool call:

1. `dangerousCall()` — local regex over the tool input. A hit blocks in `enforce` mode and warns in `shadow`. No Jev call, no network.
2. Anything the regex left alone, if its tool is in `safety.jev.tools`, is sent to Jev as a `choice` (`allow`/`ask`/`deny`) plus a `noul` on irreversibility. Only `actionOf()` output leaves the machine: the shell command, or the target path of a write — never file contents, tool results, or the transcript. Secrets are redacted and the string is capped before sending.
3. Verdicts compose conservatively, calibrated against the live model (7 sample commands): `allow` needs a probability mass ≥ `minConfidence` and `irreversible < 0.5`; `deny` needs mass ≥ 0.9 **and** `irreversible ≥ 0.5`; everything else — including a `deny` that Jev does not consider consequential — becomes `ask`. The observed samples: `allow` at 0.71-0.81, `deny` at 0.95-1.0 on real destructive commands, and `echo hello` at `deny` 0.95 with `irreversible` 0.02 (merely outside the stated request). Without the second signal a deny is a scope objection, and scope goes to the human instead of becoming a block.
4. `ask` with a UI opens `ctx.ui.confirm`. Headless (subagents, `-p`) it follows `askInHeadless`: `warn` notifies and hands the model a scope reminder via `additionalContext`, `block` refuses the call.
5. A Jev failure fails open — the deterministic layer already ran, and the auth breaker stops a dead credential from being retried on every call. Only an `allow` is cached (keyed by the exact tool arguments, TTL `cacheSeconds`), so a repeated command costs one request; a refusal is never sticky, because a false `deny` served from cache would have no escape for the whole TTL.

In `shadow` the gate never blocks and never prompts; it only logs and notifies, which is what you want while calibrating thresholds against `jev-evals.jsonl`. Switch `safety.mode` to `enforce` when the log shows no false `deny`/`ask` on your ordinary commands.

**`cascade` — subagent model selection.** `before_subagent_spawn` receives an agent name and a spawn key, but no assignment text, so the parent's `task` tool call records the items and the spawn is matched back by item name, or by spawn order when omp generated the name. Jev grades the assignment into `easy`/`medium`/`hard`; the spawn then starts on `cascade.targets.<difficulty>`'s models at that target's thinking level. Below `minConfidence`, or when the assignment cannot be matched, the spawn keeps whatever omp resolved. Because the child session re-enters routing on its own first prompt, a successful cascade also marks that assignment so the child does not re-triage it and switch back.

**`verify` — the post-run check.** At session stop, Jev sees the request and the final answer's text blocks only (`maxAnswerChars`), and answers a `choice` (`done`/`incomplete`/`wrong_scope`) plus a `noul` ("the answer fully satisfies the request"). A continuation is requested only when the two agree, the answer is not `done`, and confidence clears `minConfidence` — at most `maxContinuations` per session, and never when another stop hook already asked for one. `skipTrivial` leaves trivial/`other` turns alone. A Jev failure never holds the turn open.

Both `safety.jev` and `verify` send data that the routing triage does not: the redacted action, and the final answer text. That is why they are opt-in per install; leave them off for a fully local decision layer.

### Keel-aligned boundaries

[Keel](https://github.com/codejunkie99/keel) states the contract this extension follows: *the host owns the options, state checks, and permissions; the selector returns a choice or abstains.*

| Keel rule | Here |
|---|---|
| The selector picks from host-prepared options | Routing sends the reachable, registry-resolvable targets as candidate IDs with host-authored descriptions. With `decision.mode: "select"` the answer *is* one of those IDs (`routeQuestion()` turns them into the choice criteria), so the answer space is exactly what the host can dispatch; with the default `classify` the labels are the host's enums and `routes` maps them |
| Re-validate the selection before applying | `validateRoute()` rechecks `invalid_id`, `stale_revision` (config stamp changed), `expired` (`jev.decisionTtlMs`), `stale_read_set` (candidate fingerprint changed) and `unauthorized` (payload no longer dispatchable). A rejection falls back — never applies |
| Abstention is an answer | `jev.minConfidence` (routing abstains to the deterministic heuristic), `safety.jev.minConfidence` (gate degrades to `ask`), `cascade.minConfidence` (spawn keeps omp's model), `verify.minConfidence` (no extra pass) |
| A selector result never grants permission | The gate can only *add* an objection: it blocks or annotates inside `tool_call`. OMP's approval path is untouched, and a Jev `allow` is never an authorization |
| Pinned routes keep their route | `economy.respectManualModel`: if the live model is not the one this router left in place, it is treated as a manual choice and routing stops overriding it |
| Judgment is a signal, not an authority | A denial only blocks when Jev also calls the action irreversible; a confident "out of scope" verdict asks. `deny` mass ≥ 0.9 **and** `irreversible` ≥ 0.5, or the gate degrades to `ask` |
| Prepared actions carry an exact payload | The gate cache key is `hash(tool + exact JSON arguments)`, never the normalized or redacted text: a verdict for one command cannot be reused for a different one. Only `allow` verdicts are cached at all |
| Record evidence, not reasoning | Every record carries `schema: "jev-log/1"`, a typed `fallback` code, `calls_used`, the candidate fingerprint, and the observed outcome (`routing-outcome`, `safety-jev-outcome`) |
| No selector where the host has no verified executor | Verification is advisory: `{ continue: true, additionalContext }` within `maxContinuations`, never a blocking `decision: "block"` |

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

## When Jev stops answering

The triage client tries, in order: the credential omp has for `jev.provider`, then `OPENROUTER_API_KEY` (openrouter only), then `JEV_API_KEY` — and it remembers the candidate that worked, so a rejected one is not paid for twice in the same process. A `401`/`403` is the common case, and the notification names it.

omp can hold **several credentials for one provider** and resolve them `ORDER BY id ASC`, so a stale key with a low id can be the one handed to the router. Two ways out:

1. `OPENROUTER_API_KEY=<chave boa>` in the shell — tried right after the registry candidate.
2. Disable the stale credential in the store (reversible, needs no UI button):

```python
# backup primeiro: sqlite3 backup API grava uma cópia consistente (inclui o WAL)
import sqlite3, pathlib, time
db = pathlib.Path.home()/".omp/agent/agent.db"
con = sqlite3.connect(db)
with con:
    con.execute("UPDATE auth_credentials SET disabled_cause = ?, updated_at = ? "
                "WHERE provider='openrouter' AND id = ? AND disabled_cause IS NULL",
                ("stale key: 401 User not found", int(time.time()), 5))
```

The resolver's own query filters `disabled_cause IS NULL`, so a non-null value hides the row; `/login` shows it as disabled with that cause. Set the column back to `NULL` to undo. Always take the backup — `backups/` sits next to `agent.db`.

## Layout

- `extensions/jev-router.ts` — the extension (registered via `omp.extensions` in `package.json`)
- `jev-router.json` — shipped default config; the base every user config is merged over
- `jev-benchmark.py` — reads `~/.omp/agent/jev-evals.jsonl` and summarizes the decision log

Log `kind` values: `routing`, `routing-outcome`, `routing-pinned`, `routing-hold`, `routing-checkpoint`, `routing-rewind`, `safety` (local regex), `safety-jev` (gate verdict), `safety-jev-block` (what enforce did), `safety-jev-outcome` (how the call that ran finished), `cascade`, `cascade-handoff`, `verify`.

Every record is stamped `schema: "jev-log/1"` and carries a typed `fallback` code when the decision did not come from Jev (`low_confidence`, `circuit_open`, `http_error`, `stale_read_set`, `expired`, `invalid_id`, `unauthorized`, …), the `calls_used` the decision cost, and the `candidates_fingerprint` it was validated against.
