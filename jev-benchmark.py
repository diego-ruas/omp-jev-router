#!/usr/bin/env python3

import json
import sys
from collections import Counter
from pathlib import Path


path = (
    Path(sys.argv[1]).expanduser()
    if len(sys.argv) > 1
    else Path.home() / ".omp/agent/jev-evals.jsonl"
)

if not path.exists():
    raise SystemExit(f"No eval log found: {path}")


records = []

for line in path.read_text().splitlines():
    try:
        records.append(json.loads(line))
    except Exception:
        pass


routing = [
    r
    for r in records
    if r.get("kind") == "routing"
]

execution = [
    r
    for r in records
    if r.get("kind") == "execution_eval"
]

finals = [
    r
    for r in records
    if r.get("kind") == "final_eval"
]

safety = [
    r
    for r in records
    if r.get("kind") == "safety"
]


def counts(key):
    return Counter(
        r.get(key, "unknown")
        for r in routing
    )


print()
print("JEV DECISION LAYER BENCHMARK")
print("=" * 50)

print(f"routing decisions : {len(routing)}")
print(f"execution evals   : {len(execution)}")
print(f"final evals       : {len(finals)}")
print(f"safety checks     : {len(safety)}")

print()
print("Sources:")
for key, value in counts("source").most_common():
    print(f"  {key:14} {value}")

print()
print("Task types:")
for key, value in counts("type").most_common():
    print(f"  {key:14} {value}")

print()
print("Complexity:")
for key, value in counts("complexity").most_common():
    print(f"  {key:14} {value}")

print()
print("Models:")
for key, value in counts("target").most_common():
    print(f"  {key:14} {value}")

print()
print("Agents:")
for key, value in counts("agent").most_common():
    print(f"  {key:14} {value}")

fallbacks = sum(
    1
    for r in routing
    if r.get("source") == "fallback"
)

if routing:
    print()
    print(
        "Fallback rate    : "
        f"{fallbacks / len(routing) * 100:.1f}%"
    )

tool_conf = [
    float(r.get("tool_confidence", 0))
    for r in routing
]

if tool_conf:
    print(
        "Avg tool conf.   : "
        f"{sum(tool_conf) / len(tool_conf):.3f}"
    )

if finals:
    avg_complete = sum(
        float(r.get("complete", 0))
        for r in finals
    ) / len(finals)

    avg_regression = sum(
        float(r.get("regression_risk", 0))
        for r in finals
    ) / len(finals)

    print()
    print(f"Avg completion    : {avg_complete:.3f}")
    print(f"Avg regression    : {avg_regression:.3f}")

flagged = sum(
    1
    for r in safety
    if r.get("flagged")
)

if safety:
    print()
    print(
        "Safety flagged   : "
        f"{flagged}/{len(safety)} "
        f"({flagged / len(safety) * 100:.1f}%)"
    )

print()
