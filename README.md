# omp-jev-router

[Jev](https://openrouter.ai/docs/guides/community/jev) for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`), in two halves:

**Routing is the model.** The session runs on `typesafe/jev-router`, the official Jev Router endpoint from TypeSafe, which picks the upstream model and its reasoning effort per request. Nothing in this repo decides which model answers.

**Two decision points stay in the extension**, because both need a host hook a routing model cannot have:

- **Tool gate** — the deterministic regex runs first; Jev then answers allow/ask/deny on the *redacted* action (`safety.jev`, off by default).
- **Verification** — at session stop Jev checks the final answer against the request and can ask for one more pass (`verify`, off by default).

Both share one Jev client: credential chain, auth breaker, cache and eval log.

## 0.4.0

0.3.0 routed in-process with its own targets, route table and triage. TypeSafe shipped the same idea as a model, so that whole layer was deleted instead of maintained:

- **Deleted.** `routes`, `targets`, `decision.mode`, `economy`, `cascade`, `providers.allow`, per-turn model switching, hysteresis, sticky follow-ups, the local heuristic, and `validateRoute`. A leftover routing key in `jev-router.json` is a config error, not a silently ignored one.
- **Kept.** The tool gate and the post-run check, unchanged, including the calibration of `deny` against irreversibility and the "only `allow` is cached" rule.
- **Fixed while porting.** Verification used to clip the answer at `maxAnswerChars` before judging it, so a long completed answer read as unfinished and cost a real extra pass (measured: `incomplete` at 0.96-0.99 confidence on a finished plan). An answer longer than the cap is now not judged at all and is logged as `verdict: "skipped"`. The nudge also asks for the complete answer again, because the extra pass replaces the previous reply.
- **Cascade is gone with routing.** A subagent on the router model is routed per request by the same endpoint, so grading an assignment ahead of the spawn was doing the same job twice.
- **The served model is now visible.** omp's completions parser drops the `model` field OpenRouter repeats on every streamed chunk, so the transcript only ever names the router. The extension looks the finished generation up by `responseId` and reports it in the status line, in `/jev-router status`, and as `kind: "served-model"` in the eval log. See "Seeing which model answered".
- **Bench harness repaired.** `prepare` now force-adds the fake `fixtures/.env` (the flattened template path missed the `.gitignore` negation, which cost X01/X02/X05 the file they operate on), the router arm no longer pins `--thinking` and so lets the endpoint choose the effort, and the prompts were aligned to this release's API — the previous set still asked for `chooseTarget`, `validateRoute`, `decision.mode` and `hysteresis`. `jev-benchmark.py` counts `flagged` from the gate records that actually carry it.

## Routing setup

Register the router model once, in `~/.omp/agent/models.yml`:

```yaml
providers:
  openrouter-router:
    name: OpenRouter (Jev Router)
    baseUrl: https://openrouter.ai/api/v1
    api: openai-completions
    # Attribution: shows these calls as your app in the OpenRouter dashboard.
    headers:
      HTTP-Referer: https://github.com/diego-ruas/omp-jev-router
      X-Title: OMP Jev Router
    # Reuses the OpenRouter credential omp already stores; never a literal in this file.
    apiKey: "!omp token openrouter"
    models:
      - id: typesafe/jev-router
        name: TypeSafe Jev Router
        reasoning: false
        input: [text, image]
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        contextWindow: 1000000
        # Client-side output cap; the router clamps per upstream. Raising it very high makes the
        # router pick a huge-output model even for easy prompts.
        maxTokens: 32000
```

`apiKey: "!omp token openrouter"` runs `omp token openrouter` and uses its stdout, so the key stays in omp's credential store instead of being copied into a config file. The provider id is arbitrary; the model **id** is not — it is the wire model name and must stay `typesafe/jev-router`.

Then run the session on it:

```bash
omp --model openrouter-router/typesafe/jev-router
```

or make it the default in `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: openrouter-router/typesafe/jev-router
```

Two things the router owns, so omp must not pin them:

- **Thinking.** Declare the model `reasoning: false`: the router already picks the reasoning effort per request, and `--thinking` would only fight it.
- **Context window.** `1000000` is the router's own window; the upstream model it picks may be smaller, and the router caps what it dispatches.

### What you get and what you lose

Gain: one model id covers every tier, chosen per request from the actual prompt and conversation state, with no local route table to keep in sync.

Lose, deliberately: the router answers *where*, not *what happened*. omp records the session model (`openrouter-router/typesafe/jev-router`) in the transcript, so the upstream model that served a turn is not visible in `message.model`. The per-target routing rows this repo used to write to `jev-evals.jsonl` are gone with routing. The gate and verification rows remain.

### Seeing which model answered

The transcript keeps the router id: omp's completions parser reads `chunk.id` but drops the `model` field OpenRouter repeats on every streamed chunk. The extension therefore asks OpenRouter for the generation it just finished (`GET /generation?id=<responseId>`, accepted only when the returned id matches) and shows the result in two places:

- the status line — `ctx.ui.setStatus("jev-router", <model>)`, and
- `/jev-router status` — a `último modelo servido:` line.

Each observation is also logged as `kind: "served-model"`, so the upstream choice stays auditable after the fact. The lookup is asynchronous: it never holds a turn open, and OpenRouter indexes a generation a few seconds after the stream ends, so the footer can lag. A session not running the router is ignored, and a failed lookup only costs the attribution.

Not ported, with the reason:

| Not ported | Why |
|---|---|
| Route table, targets, thinking map | The router chooses both. Keeping a local table would either override it or be dead config |
| Local heuristic fallback | There is no local decision left to fall back to; the model either answers or omp's own provider fallback takes over |
| Cascade (grade the `task` assignment) | A subagent on the router model is routed per request by the endpoint itself |
| `verify.skipTrivial` | The classifier that identified trivial turns was part of routing. Verification runs once per turn now; turn it off with `verify.enabled` if that cost is not wanted |
| Per-decision routing evidence | The router returns no decision record; the served model is recovered per response instead (see "Seeing which model answered") |

## Config

Only the gate, verification and logging are configurable. `~/.omp/agent/jev-router.json` is merged over the shipped `jev-router.json`:

- objects merge recursively,
- arrays and scalars replace,
- `null` deletes a key.

Edits are picked up on the next tool call (mtime check); `/jev-router reload` also clears caches and the auth breaker. An invalid file is rejected as a whole with a list of every problem, and the last valid config stays in effect. Routing keys from 0.3.x (`routes`, `targets`, `decision`, `economy`, `cascade`, `providers`) are reported as errors.

| Section | Purpose |
|---|---|
| `jev` | Jev client for the gate and verification: `provider` (credential lookup), `endpoint`, `model`, `timeoutMs`, `cacheSeconds`, `maxPromptChars` |
| `safety` | `enabled`, `mode` (`shadow` \| `enforce`), `tools` checked locally by the regex |
| `safety.jev` | Tool gate: `enabled`, `tools` (only these are sent, redacted), `timeoutMs`, `cacheSeconds`, `maxActionChars`, `minConfidence`, `askInHeadless` (`warn` \| `block`) |
| `verify` | Post-run check: `enabled`, `minConfidence`, `maxContinuations` (0–8), `maxAnswerChars` |
| `logging` | `enabled`, `path` (`~/` = home; relative = next to the user config) |

### `safety.jev` — the tool gate

1. `dangerousCall()` — local regex over the tool input. A hit blocks in `enforce` mode and warns in `shadow`. No Jev call, no network.
2. Anything the regex left alone, if its tool is in `safety.jev.tools`, is sent to Jev as a `choice` (`allow`/`ask`/`deny`) plus a `noul` on irreversibility. Only `actionOf()` output leaves the machine: the shell command, or the target path of a write — never file contents, tool results, or the transcript. Secrets are redacted and the string is capped before sending.
3. Verdicts compose conservatively, calibrated against the live model (7 sample commands): `allow` needs a probability mass ≥ `minConfidence` and `irreversible < 0.5`; `deny` needs mass ≥ 0.9 **and** `irreversible ≥ 0.5`; everything else — including a `deny` that Jev does not consider consequential — becomes `ask`. The observed samples: `allow` at 0.71-0.81, `deny` at 0.95-1.0 on real destructive commands, and `echo hello` at `deny` 0.95 with `irreversible` 0.02 (merely outside the stated request). Without the second signal a deny is a scope objection, and scope goes to the human instead of becoming a block.
4. `ask` with a UI opens `ctx.ui.confirm`. Headless (subagents, `-p`) it follows `askInHeadless`: `warn` notifies and hands the model a scope reminder via `additionalContext`, `block` refuses the call.
5. A Jev failure fails open — the deterministic layer already ran, and the auth breaker stops a dead credential from being retried on every call. Only an `allow` is cached (keyed by the exact tool arguments, TTL `cacheSeconds`), so a repeated command costs one request; a refusal is never sticky, because a false `deny` served from cache would have no escape for the whole TTL.

In `shadow` the gate never blocks and never prompts; it only logs and notifies, which is what you want while calibrating thresholds against `jev-evals.jsonl`. Switch `safety.mode` to `enforce` when the log shows no false `deny`/`ask` on your ordinary commands.

### `verify` — the post-run check

At session stop, Jev sees the request and the final answer's text blocks only, and answers a `choice` (`done`/`incomplete`/`wrong_scope`) plus a `noul` ("the answer fully satisfies the request"). A continuation is requested only when the two agree, the answer is not `done`, and confidence clears `minConfidence` — at most `maxContinuations` per session, and never when another stop hook already asked for one. An answer longer than `maxAnswerChars` is not verified at all (logged as `verdict: "skipped"`), because a clipped answer always reads as unfinished. The nudge asks for the complete answer again, because the extra pass replaces the previous reply. A Jev failure never holds the turn open.

`skipTrivial` from 0.3.x is gone: it keyed off the routing classifier, which no longer exists. Verification now runs once per turn, so it costs one Jev request per turn — input tokens only.

Both sections send data that routing never needed to: the redacted action, and the final answer text. That is why they ship disabled.

### Keel-aligned boundaries

[Keel](https://github.com/codejunkie99/keel) states the contract this extension follows: *the host owns the options, state checks, and permissions; the selector returns a choice or abstains.*

| Keel rule | Here |
|---|---|
| A selector result never grants permission | The gate can only *add* an objection: it blocks or annotates inside `tool_call`. OMP's approval path is untouched, and a Jev `allow` is never an authorization |
| Judgment is a signal, not an authority | A denial only blocks when Jev also calls the action irreversible; a confident "out of scope" verdict asks. `deny` mass ≥ 0.9 **and** `irreversible` ≥ 0.5, or the gate degrades to `ask` |
| Prepared actions carry an exact payload | The gate cache key is `hash(tool + exact JSON arguments)`, never the redacted text: a verdict for one command cannot be reused for a different one. Only `allow` verdicts are cached at all |
| Abstention is an answer | `safety.jev.minConfidence` (gate degrades to `ask`), `verify.minConfidence` (no extra pass), and a Jev failure leaves the deterministic rule in charge |
| Record evidence, not reasoning | Every gate and verification record carries `schema: "jev-log/1"`, a typed `fallback` code, `calls_used`, and the observed outcome (`safety-jev-outcome`) |
| No selector where the host has no verified executor | Verification is advisory: `{ continue: true, additionalContext }` within `maxContinuations`, never a blocking `decision: "block"` |

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

### Install with your AI

Paste this into omp (or any coding agent with shell access):

````text
Install the omp-jev-router plugin for Oh My Pi (omp) and wire it to the official Jev Router. Do exactly this, and stop to ask me when a step needs my input:

1. Run `omp --version` (must be 18.x or newer).
2. Install: `omp plugin install github:diego-ruas/omp-jev-router`. If that fails, run
   `git clone https://github.com/diego-ruas/omp-jev-router ~/.omp/plugins-src/omp-jev-router && omp plugin link ~/.omp/plugins-src/omp-jev-router`.
3. If `~/.omp/agent/extensions/jev-router.ts` exists, it is an older copy that would double-route. Rename it to `jev-router.ts.bak`; do not delete it.
4. Ask me to run `omp token openrouter` and confirm it prints a key (a non-zero exit means I have no OpenRouter credential: I should run `omp login openrouter`). Do not print the key back to me.
5. Add the router model to `~/.omp/agent/models.yml` (create the file if missing, keep any existing providers). Back it up first. Use provider id `openrouter-router` and model id `typesafe/jev-router` exactly, `api: openai-completions`, `baseUrl: https://openrouter.ai/api/v1`, `apiKey: "!omp token openrouter"`, provider `headers` with `HTTP-Referer: https://github.com/diego-ruas/omp-jev-router` and `X-Title: OMP Jev Router` (attribution), `reasoning: false`, `input: [text, image]`, `contextWindow: 1000000`, `maxTokens: 32000`.
6. Verify with `omp models find jev-router` — it must list `typesafe/jev-router` under `openrouter-router`. If the file is rejected, `omp models` reports the schema error: fix it and repeat.
7. Ask me whether to make it my default model. If yes, add `modelRoles: { default: openrouter-router/typesafe/jev-router }` to `~/.omp/agent/config.yml`, backing it up first. If no, tell me to launch with `--model openrouter-router/typesafe/jev-router`.
8. Run `omp -p --no-session --model openrouter-router/typesafe/jev-router "reply with exactly: ROUTER_OK"` and confirm it prints ROUTER_OK. If it fails, stop and report the error instead of editing more files.
9. If `~/.omp/agent/jev-router.json` exists and contains `routes`, `targets`, `cascade`, `decision`, `economy` or `providers`, remove those keys (routing moved to the model) and keep `safety`, `verify` and `logging`.
10. Ask me to run `/jev-router status` and paste the output: it must say the session model is the router.
11. Leave `safety.jev` and `verify` disabled unless I explicitly ask: the gate sends the redacted shell command to Jev, and `verify` sends the final answer text. If I ask for the gate, set `safety.jev.enabled: true` with `safety.mode: shadow` first, and only switch to `enforce` after I have reviewed `~/.omp/agent/jev-evals.jsonl`.

Change nothing outside `~/.omp/plugins*`, `~/.omp/agent/models.yml`, `~/.omp/agent/jev-router.json`, `~/.omp/agent/config.yml` and the rename in step 3.
````

The gate and verification need a credential for `jev.provider` (default `openrouter`), resolved via `ctx.modelRegistry.getApiKeyForProvider(<provider>, …)` — the same auth omp already uses — then `OPENROUTER_API_KEY` (openrouter only) / `JEV_API_KEY`.

## When Jev stops answering

The client tries, in order: the credential omp has for `jev.provider`, then `OPENROUTER_API_KEY` (openrouter only), then `JEV_API_KEY` — and it remembers the candidate that worked, so a rejected one is not paid for twice in the same process. A `401`/`403` is the common case, and the notification names it.

omp can hold **several credentials for one provider** and resolve them `ORDER BY id ASC`, so a stale key with a low id can be the one handed to Jev. Two ways out:

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

This matters for the router model too: `models.yml` reads the same store, and `omp token openrouter` returns the first credential omp finds, so a dead low-id key breaks both halves the same way.

## Layout

- `extensions/jev-router.ts` — the extension (registered via `omp.extensions` in `package.json`): gate, verification, `jev_ask`, `/jev-router`
- `jev-router.json` — shipped default config; the base every user config is merged over
- `jev-benchmark.py` — summarizes `~/.omp/agent/jev-evals.jsonl`: gate verdicts, enforcement outcomes and verifications
- `bench/e2e/` — end-to-end harness: `prepare` clones the committed repo into a template, force-adds the fake `fixtures/.env` (needed by X01/X02/X05 despite `.gitignore`), and records the suite baseline. `run --arm sol|opus|router`, `judge`, `report` use that template. The router arm runs `openrouter-router/typesafe/jev-router` without pinning `--thinking`, so the endpoint chooses both the upstream model and reasoning effort. Run `prepare` again after committing changes: it does not clone the working tree.

Log `kind` values: `safety` (local regex), `safety-jev` (gate verdict), `safety-jev-block` (what enforce did), `safety-jev-outcome` (how the call that ran finished), `verify`, `served-model` (the upstream model OpenRouter reported for a response).

Every record is stamped `schema: "jev-log/1"` and carries a typed `fallback` code when the decision did not come from Jev (`circuit_open`, `credential_unavailable`, `http_error`, `transport_error`), plus the `calls_used` the decision cost.
