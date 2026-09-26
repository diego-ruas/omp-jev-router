#!/usr/bin/env python3
"""End-to-end model benchmark: sol-only vs opus-only vs the Jev Router, run for real in `omp -p`.

The router arm is just another pinned model (`openrouter-router/typesafe/jev-router`): the official
endpoint picks the upstream per request, so there is no route table to toggle and nothing local to
attribute. Subcommands: prepare, run, judge, report. State lives under --root (default /tmp/jev-bench).
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import glob
import json
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
PROMPTS = HERE / "prompts.jsonl"
ARM_MODELS = {
    "sol": "openai-codex/gpt-6-sol",
    "opus": "anthropic/claude-opus-5-5",
    "router": "openrouter-router/typesafe/jev-router",
}
JUDGES = ["openai-codex/gpt-6-sol", "anthropic/claude-opus-5-5"]
ARMS = ["sol", "opus", "router"]
RATE_RE = re.compile(r"429|rate.?limit|overloaded", re.I)

ROOT = Path("/tmp/jev-bench")


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def log(msg):
    print(f"[{dt.datetime.now():%H:%M:%S}] {msg}", flush=True)


def load_prompts():
    return [json.loads(l) for l in PROMPTS.read_text().splitlines() if l.strip()]


# ---------- prepare ----------

def sh(cmd, cwd=None, timeout=None, **kw):
    return subprocess.run(cmd, cwd=cwd, timeout=timeout, capture_output=True, text=True, **kw)


def count_tests(out):
    p = re.search(r"(\d+) pass", out)
    f = re.search(r"(\d+) fail", out)
    return (int(p.group(1)) if p else None, int(f.group(1)) if f else None)


def cmd_prepare(_):
    ROOT.mkdir(parents=True, exist_ok=True)
    tpl = ROOT / "template"
    if tpl.exists():
        shutil.rmtree(tpl)
    subprocess.run(["git", "clone", "-q", "--local", "--no-hardlinks", str(REPO), str(tpl)], check=True)
    subprocess.run(["git", "-C", str(tpl), "remote", "remove", "origin"], check=True)
    (tpl / "fixtures").mkdir(exist_ok=True)
    for f in (HERE / "fixtures").iterdir():
        shutil.copyfile(f, tpl / "fixtures" / f.name)
    subprocess.run(["git", "add", "-A"], cwd=tpl, check=True)
    # The fixtures are the point of the bench: X01/X05 rewrite fixtures/.env and X02 finds it, so it
    # must be in the template's history. The repo .gitignore un-ignores bench/e2e/fixtures/.env, but
    # the template flattens that to fixtures/.env, so the negation misses it: force-add the directory
    # and fail loudly if the tracked set came out wrong.
    subprocess.run(["git", "add", "-f", "--", "fixtures"], cwd=tpl, check=True)
    tracked = sh(["git", "ls-files", "fixtures"], cwd=tpl).stdout.split()
    if "fixtures/.env" not in tracked:
        sys.exit(f"template fixtures not tracked: {tracked} (expected fixtures/.env)")
    # Host tooling (graphify) can drop a cache into any cwd; it is not agent work.
    with open(tpl / ".git" / "info" / "exclude", "a") as f:
        f.write("graphify-out/\n")
    subprocess.run(["git", "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-qm", "test: add bench fixtures"], cwd=tpl, check=True)
    r = sh(["bun", "test"], cwd=tpl, timeout=600)
    passed, failed = count_tests(r.stdout + r.stderr)
    if failed != 0 or not passed:
        sys.exit(f"template baseline broken: {passed} pass, {failed} fail (expected a green suite)")
    sha = sh(["git", "rev-parse", "HEAD"], cwd=tpl).stdout.strip()
    ver = sh(["omp", "--version"]).stdout.strip()
    (ROOT / "meta.json").write_text(json.dumps({"template_sha": sha, "created": now(), "omp_version": ver, "baseline_pass": passed}, indent=2))
    log(f"template ready at {tpl} ({sha[:7]}, {passed} pass)")


# ---------- session parsing ----------

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def read_messages(path):
    msgs = []
    for line in Path(path).read_text(errors="replace").splitlines():
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message") if isinstance(e, dict) else None
        if isinstance(m, dict) and "role" in m:
            msgs.append(m)
    return msgs


def parse_sessions(sess, prompt):
    files = sorted(glob.glob(str(sess / "**" / "*.jsonl"), recursive=True))
    main, children = None, []
    parsed = {f: read_messages(f) for f in files}
    for f, msgs in parsed.items():
        first_user = next((m for m in msgs if m.get("role") == "user"), None)
        if main is None and first_user and prompt.strip() in text_of(first_user.get("content")):
            main = f
        else:
            children.append(f)
    tot = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost_total": 0.0}
    for msgs in parsed.values():
        for m in msgs:
            if m.get("role") != "assistant":
                continue
            u = m.get("usage") or {}
            for k in ("input", "output", "cacheRead", "cacheWrite"):
                tot[k] += u.get(k) or 0
            tot["cost_total"] += (u.get("cost") or {}).get("total") or 0.0
    res = {"usage": tot, "child_sessions": len(children), "main_session": main,
           "turns": 0, "models_main": [], "final_answer": ""}
    if main:
        asst = [m for m in parsed[main] if m.get("role") == "assistant"]
        res["turns"] = len(asst)
        seen = []
        for m in asst:
            spec = f"{m.get('provider')}/{m.get('model')}"
            if spec not in seen:
                seen.append(spec)
        res["models_main"] = seen
        if asst:
            res["final_answer"] = text_of(asst[-1].get("content"))
        # omp swaps in its fallback chain when a provider fails (e.g. a revoked credential): the run
        # then measures a different model than the arm claims.
        res["provider_fallback"] = '"resolvedModelIsFallback":true' in Path(main).read_text(errors="replace").replace(" ", "")
    return res


# ---------- checks ----------

def template_baseline():
    """Test count the clean template produced in prepare: the bar `tests: green|more` is measured against it."""
    return json.loads((ROOT / "meta.json").read_text())["baseline_pass"]


def run_checks(checks, ws, final, status):
    if not checks:
        return None, "no checks"
    ok, detail = True, []
    if "sh" in checks:
        try:
            r = subprocess.run(["bash", "-c", checks["sh"]], cwd=ws, capture_output=True, text=True, timeout=180)
            good = r.returncode == 0
            detail.append(f"sh={'ok' if good else 'exit ' + str(r.returncode)}" + ("" if good else f" [{(r.stdout + r.stderr).strip()[-300:]}]"))
        except subprocess.TimeoutExpired:
            good = False
            detail.append("sh=timeout")
        ok &= good
    if "expect" in checks:
        missing = [p for p in checks["expect"] if not re.search(p, final, re.I)]
        ok &= not missing
        detail.append("expect=ok" if not missing else f"expect missing {missing}")
    if checks.get("no_edits"):
        dirty = [l for l in status.splitlines() if l.strip() and not l[3:].startswith(".bench-")]
        ok &= not dirty
        detail.append("no_edits=ok" if not dirty else f"edited {dirty[:5]}")
    if "tests" in checks:
        try:
            r = subprocess.run(["bun", "test"], cwd=ws, capture_output=True, text=True, timeout=600)
            p, f = count_tests(r.stdout + r.stderr)
        except subprocess.TimeoutExpired:
            p, f = None, None
        want_more = checks["tests"] == "more"
        base = template_baseline()
        good = f == 0 and p is not None and (p > base if want_more else p >= base)
        ok &= good
        detail.append(f"tests({checks['tests']})={p} pass/{f} fail")
    return ok, "; ".join(detail)


# ---------- run ----------

def omp(cmd, cwd, out_dir, timeout):
    with open(out_dir / "stdout.txt", "w") as so, open(out_dir / "stderr.txt", "w") as se:
        p = subprocess.run(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=so, stderr=se,
                           env={**os.environ, "PI_NO_TITLE": "1"}, timeout=timeout)
    return p.returncode


def run_one(arm, p):
    rd = ROOT / "runs" / arm / p["id"]
    if (rd / "result.json").exists():
        return "skip"
    ws = ROOT / "work" / arm / p["id"]
    if ws.exists():
        shutil.rmtree(ws)
    ws.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cp", "-a", str(ROOT / "template"), str(ws)], check=True)
    sess = rd / "session"
    if rd.exists():
        shutil.rmtree(rd)
    sess.mkdir(parents=True)
    cmd = ["omp", "-p", "--no-title", "--auto-approve", "--max-time", "15m", "--cwd", str(ws), "--session-dir", str(sess)]
    if arm in ARM_MODELS:
        cmd += ["--model", ARM_MODELS[arm]]
        if arm != "router":
            cmd += ["--thinking", "medium"]
    cmd.append(p["prompt"])
    error, code = None, None
    start = now()
    t0 = time.monotonic()
    for attempt in range(2):
        try:
            code = omp(cmd, ws, rd, 1000)
        except subprocess.TimeoutExpired:
            code, error = None, "timeout"
            break
        if code != 0 and attempt == 0 and RATE_RE.search((rd / "stderr.txt").read_text(errors="replace")):
            log(f"{arm}/{p['id']} rate limited; retrying in 60s")
            time.sleep(60)
            continue
        break
    wall = time.monotonic() - t0
    end = now()
    if error is None and code != 0:
        error = f"exit {code}: {(rd / 'stderr.txt').read_text(errors='replace').strip()[-300:]}"
    s = parse_sessions(sess, p["prompt"])
    if s["main_session"] is None and error is None:
        error = "no main session file"
    if s.get("provider_fallback") and error is None:
        error = "provider fallback: omp switched to its fallback model"
    g = lambda *a: sh(["git", "-C", str(ws), *a]).stdout
    sh(["git", "-C", str(ws), "add", "-A"])
    status, diff, glog = g("status", "--porcelain"), g("diff", "--cached", "HEAD")[:8000], g("log", "--oneline", "-5")
    check_pass, check_detail = run_checks(p.get("checks"), ws, s["final_answer"], status)
    res = {"id": p["id"], "arm": arm, "category": p["category"],
           "exit_code": code, "error": error, "start_ts": start, "end_ts": end, "wall_s": round(wall, 1),
           "turns": s["turns"], "models_main": s["models_main"], "child_sessions": s["child_sessions"],
           **{k: v for k, v in s["usage"].items()}, "final_answer": s["final_answer"],
           "status": status, "diff": diff, "log": glog, "check_pass": check_pass, "check_detail": check_detail}
    (rd / "result.json").write_text(json.dumps(res, indent=2, ensure_ascii=False))
    shutil.rmtree(ws)
    return f"{'ERR ' + error[:80] if error else 'ok'} check={check_pass} ${res['cost_total']:.3f} {res['wall_s']}s {res['models_main']}"


def cmd_run(a):
    workers = a.workers or 4
    prompts = load_prompts()
    if a.only:
        ids = set(a.only.split(","))
        prompts = [p for p in prompts if p["id"] in ids]
    with cf.ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(run_one, a.arm, p): p["id"] for p in prompts}
        for fut in cf.as_completed(futs):
            try:
                log(f"{a.arm}/{futs[fut]}: {fut.result()}")
            except Exception as e:  # keep the batch going; the missing result.json makes it resumable
                log(f"{a.arm}/{futs[fut]}: CRASH {e!r}")
    all_prompts = load_prompts()
    done = sum(1 for p in all_prompts if (ROOT / "runs" / a.arm / p["id"] / "result.json").exists())
    log(f"{a.arm}: {done}/{len(all_prompts)} results")


# ---------- judge ----------

JUDGE_HEAD = """You are grading three coding-agent runs of the same task in the same repository (a TypeScript omp extension with bun tests). Candidates are anonymized and shuffled. Grade each one independently from 0 to 10 on correctness, completeness, respect for the task's constraints (for example "do not edit files"), and absence of collateral damage. Ignore verbosity unless it hurts usefulness.

TASK:
{prompt}
"""

JUDGE_CAND = """
=== CANDIDATE {label} ===
Run status: {run_status}
Automatic check: {check} {check_detail}
git status --porcelain:
{status}
git log --oneline -5:
{log}
Diff (truncated):
{diff}
Final answer (truncated to 6000 chars):
{final}
"""

JUDGE_TAIL = """
Reply with ONLY a JSON object: {"A":{"score":<integer 0-10>,"solved":<true|false>,"why":"<one sentence>"},"B":{...},"C":{...}}
"""


def load_result(arm, pid):
    f = ROOT / "runs" / arm / pid / "result.json"
    return json.loads(f.read_text()) if f.exists() else None


def judge_prompt(p, mapping):
    text = JUDGE_HEAD.format(prompt=p["prompt"])
    for label, arm in mapping.items():
        r = load_result(arm, p["id"])
        cp = r["check_pass"]
        text += JUDGE_CAND.format(label=label, run_status="ok" if not r["error"] else "FAILED: " + r["error"],
                                  check="none" if cp is None else ("pass" if cp else "fail"),
                                  check_detail=r["check_detail"], status=r["status"], log=r["log"],
                                  diff=r["diff"], final=r["final_answer"][:6000])
    return text + JUDGE_TAIL


def parse_verdict(out):
    dec, best = json.JSONDecoder(), None
    for m in re.finditer(r"\{", out):
        try:
            obj, _ = dec.raw_decode(out, m.start())
        except ValueError:
            continue
        if isinstance(obj, dict) and all(isinstance(obj.get(k), dict) and "score" in obj[k] for k in "ABC"):
            best = obj
    return best


def judge_one(judge, p):
    out_f = ROOT / "judge" / judge.replace("/", "__") / f"{p['id']}.json"
    if out_f.exists():
        return "skip"
    arms = ARMS[:]
    random.Random(p["id"]).shuffle(arms)
    mapping = dict(zip("ABC", arms))
    text = judge_prompt(p, mapping)
    cmd = ["omp", "-p", "--no-tools", "--no-skills", "--no-rules", "--no-title", "--no-session", "--model", judge, "--thinking", "medium"]
    verdict, raw = None, ""
    for _ in range(2):
        try:
            r = subprocess.run(cmd, input=text, cwd=ROOT, capture_output=True, text=True, timeout=600,
                               env={**os.environ, "PI_NO_TITLE": "1"})
            raw = r.stdout
        except subprocess.TimeoutExpired:
            raw = "timeout"
            continue
        verdict = parse_verdict(raw)
        if verdict:
            break
    out_f.parent.mkdir(parents=True, exist_ok=True)
    rec = {"id": p["id"], "judge": judge, "mapping": mapping}
    if verdict:
        rec["scores"] = {arm: verdict[label] for label, arm in mapping.items()}
    else:
        rec["error"] = "unparseable verdict"
        rec["raw"] = raw[-2000:]
    out_f.write_text(json.dumps(rec, indent=2, ensure_ascii=False))
    return "ok" if verdict else "ERR"


def cmd_judge(a):
    prompts = [p for p in load_prompts() if all(load_result(arm, p["id"]) for arm in ARMS)]
    with cf.ThreadPoolExecutor(a.workers) as ex:
        futs = {ex.submit(judge_one, j, p): (j, p["id"]) for p in prompts for j in JUDGES}
        for fut in cf.as_completed(futs):
            try:
                log(f"judge {futs[fut]}: {fut.result()}")
            except Exception as e:
                log(f"judge {futs[fut]}: CRASH {e!r}")


# ---------- report ----------

def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def fmt(x, d=2):
    return "–" if x is None else f"{x:.{d}f}"


def pct(new, old):
    return "–" if new is None or not old else f"{(new - old) / old * 100:+.1f}%"


def table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(str(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def cmd_report(_):
    prompts = load_prompts()
    res = {arm: {p["id"]: load_result(arm, p["id"]) for p in prompts} for arm in ARMS}
    judged = {}  # (judge, id) -> {arm: {score, solved}}
    for j in JUDGES:
        for p in prompts:
            f = ROOT / "judge" / j.replace("/", "__") / f"{p['id']}.json"
            if f.exists():
                rec = json.loads(f.read_text())
                if "scores" in rec:
                    judged[(j, p["id"])] = rec["scores"]

    def score(arm, pid, key="score", judges=JUDGES):
        vals = [judged[(j, pid)][arm].get(key) for j in judges if (j, pid) in judged]
        vals = [float(v) for v in vals if isinstance(v, (int, float, bool))]
        return mean(vals)

    agg = {}
    for arm in ARMS:
        rs = [r for r in res[arm].values() if r]
        checked = [r for r in rs if r["check_pass"] is not None]
        walls = [r["wall_s"] for r in rs]
        agg[arm] = {
            "runs": len(rs), "errors": sum(1 for r in rs if r["error"]),
            "check": mean([1.0 if r["check_pass"] else 0.0 for r in checked]),
            "score": mean([score(arm, r["id"]) for r in rs]),
            "solved": mean([score(arm, r["id"], "solved") for r in rs]),
            "cost": sum(r["cost_total"] for r in rs), "cost_mean": mean([r["cost_total"] for r in rs]),
            "in": sum(r["input"] for r in rs), "out": sum(r["output"] for r in rs), "cr": sum(r["cacheRead"] for r in rs),
            "wall": mean(walls), "wall_med": statistics.median(walls) if walls else None,
            "turns": mean([r["turns"] for r in rs]), "children": sum(r["child_sessions"] for r in rs),
        }
    meta = json.loads((ROOT / "meta.json").read_text()) if (ROOT / "meta.json").exists() else {}
    md = ["# e2e benchmark: sol-only vs opus-only vs Jev Router", "",
          f"omp {meta.get('omp_version', '?')} · template {meta.get('template_sha', '?')[:7]} · generated {now()}", "",
          "> Cost is the API-equivalent computed from registry prices (subscription billing can differ). "
          "Jev decision calls (gate/verify) are counted, not priced. "
          "Scores: 0-10 from two blind judges (gpt-6-sol, claude-opus-5-5), averaged per candidate, then over prompts.", ""]
    if all(agg[a]["children"] == 0 for a in ARMS):
        md += ["> No subagent session sidecars were found for any arm; subagent cost (if any) is excluded everywhere.", ""]
    md += ["## 1. Per arm", "", table(
        ["arm", "runs", "errors", "check pass", "judge score", "solved", "cost $ total", "cost $ mean", "input tok", "output tok", "cacheRead tok", "wall mean s", "wall median s", "turns mean"],
        [[a, g["runs"], g["errors"], fmt(g["check"] and g["check"] * 100, 1) + "%", fmt(g["score"]), fmt(g["solved"] and g["solved"] * 100, 1) + "%",
          fmt(g["cost"]), fmt(g["cost_mean"], 3), f"{g['in']:,}", f"{g['out']:,}", f"{g['cr']:,}", fmt(g["wall"], 1), fmt(g["wall_med"], 1), fmt(g["turns"], 1)]
         for a, g in agg.items()]), ""]
    r = agg["router"]
    md += ["## 2. Deltas", "", table(["comparison", "cost", "score Δ", "solved Δ (pp)", "wall time"], [
        [f"router vs {b}", pct(r["cost"], agg[b]["cost"]),
         fmt(None if r["score"] is None or agg[b]["score"] is None else r["score"] - agg[b]["score"]),
         fmt(None if r["solved"] is None or agg[b]["solved"] is None else (r["solved"] - agg[b]["solved"]) * 100, 1),
         pct(r["wall"], agg[b]["wall"])] for b in ("sol", "opus")]), ""]
    cats = list(dict.fromkeys(p["category"] for p in prompts))
    rows = []
    for c in cats:
        ids = [p["id"] for p in prompts if p["category"] == c]
        row = [c, len(ids)]
        for a in ARMS:
            row.append(fmt(mean([score(a, i) for i in ids if res[a][i]])))
            row.append(fmt(mean([res[a][i]["cost_total"] for i in ids if res[a][i]]), 3))
        rows.append(row)
    md += ["## 3. Per category × arm (mean score / mean cost $)", "",
           table(["category", "n"] + [f"{a} {k}" for a in ARMS for k in ("score", "cost")], rows), ""]
    md += ["## 4. Per judge (mean score)", "", table(["judge"] + ARMS, [
        [j] + [fmt(mean([score(a, p["id"], judges=[j]) for p in prompts if res[a][p["id"]]])) for a in ARMS] for j in JUDGES]), ""]
    report = "\n".join(md)
    (ROOT / "report.md").write_text(report)
    print(report)


def main():
    global ROOT
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="/tmp/jev-bench")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("prepare")
    r = sub.add_parser("run")
    r.add_argument("--arm", choices=ARMS, required=True)
    r.add_argument("--workers", type=int)
    r.add_argument("--only")
    j = sub.add_parser("judge")
    j.add_argument("--workers", type=int, default=4)
    sub.add_parser("report")
    a = ap.parse_args()
    ROOT = Path(a.root)
    {"prepare": cmd_prepare, "run": cmd_run, "judge": cmd_judge, "report": cmd_report}[a.cmd](a)


if __name__ == "__main__":
    main()
