# omp-jev-router

Jev Decision Layer for [Oh My Pi](https://github.com/can1357/oh-my-pi) (`omp`): routes each prompt to the right model + thinking level via fast-path → cached Jev triage (one OpenRouter decisions request) → deterministic policy.

- Sticky follow-ups keep the warm model (prompt cache intact)
- Hysteresis: non-high-risk switches need the same target twice
- Shadow-by-default safety net for destructive tool calls
- `/jev-router` command: `status | on | off | reload | models | test <prompt> | history | rewind`

## Install

```bash
omp plugin install omp-jev-router
```

Local dev:

```bash
omp plugin link /path/to/omp-jev-router
```

Requires an OpenRouter credential for the Jev triage call (resolved via `ctx.modelRegistry.getApiKeyForProvider("openrouter", …)` — the same auth you already use in omp). Without it the router falls back to the local heuristic.

## Config

User config at `~/.omp/agent/jev-router.json` overrides the shipped `jev-router.json` default (section-level merge, partial files OK). Key sections: `jev` (endpoint/model/timeout/cache), `models` (exact `provider/id` per target), `thinking`, `safety` (`shadow` | `enforce`), `finalEval`, `economy`, `logging`.

## Layout

- `extensions/jev-router.ts` — the extension (registered via `omp.extensions` in `package.json`)
- `jev-router.json` — shipped default config (fallback when no user config exists)
- `jev-benchmark.py` — reads `~/.omp/agent/jev-evals.jsonl` and summarizes routing decisions
