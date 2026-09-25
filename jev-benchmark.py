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

gate = [
    r
    for r in records
    if r.get("kind") == "safety-jev"
]

cascade = [
    r
    for r in records
    if r.get("kind") == "cascade"
]

verifications = [
    r
    for r in records
    if r.get("kind") == "verify"
]

pinned = [
    r
    for r in records
    if r.get("kind") == "routing-pinned"
]

outcomes = [
    r
    for r in records
    if r.get("kind") == "routing-outcome"
]

dispatched = [
    r
    for r in records
    if r.get("kind") == "safety-jev-outcome"
]

blocked = [
    r
    for r in records
    if r.get("kind") == "safety-jev-block"
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

abstained = [
    r
    for r in routing
    if r.get("fallback")
]

if routing:
    print()
    print(
        "Fallback rate    : "
        f"{fallbacks / len(routing) * 100:.1f}%"
    )

if abstained:
    print()
    print(f"Abstentions      : {len(abstained)}/{len(routing)}")
    for key, value in Counter(r.get("fallback") for r in abstained).most_common():
        print(f"  {key:16} {value}")

rejected = [
    r
    for r in outcomes
    if r.get("outcome") == "unresolved"
]

if outcomes:
    print()
    print("Observed outcomes:")
    for key, value in Counter(r.get("outcome", "unknown") for r in outcomes).most_common():
        print(f"  {key:16} {value}")
    if rejected:
        print(f"  (unresolved: decision had no dispatchable model)")

if pinned:
    print()
    print(f"Manual pins kept : {len(pinned)}")

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

if gate:
    verdicts = Counter(r.get("verdict", "unknown") for r in gate)
    print()
    print(f"Jev gate calls   : {len(gate)}")
    print("Gate verdicts    :")
    for key, value in verdicts.most_common():
        print(f"  {key:14} {value}")
    latencies = [
        float(r.get("latency_ms", 0))
        for r in gate
        if r.get("verdict") != "error"
    ]
    if latencies:
        print(f"Gate avg latency : {sum(latencies) / len(latencies):.0f} ms")

if cascade:
    print()
    print(f"Cascade spawns   : {len(cascade)}")
    for key, value in Counter(r.get("difficulty", "unknown") for r in cascade).most_common():
        print(f"  {key:14} {value}")
    for key, value in Counter(str(r.get("target")) for r in cascade).most_common():
        print(f"  -> {key:11} {value}")

if blocked:
    print()
    print("Gate enforcement :")
    for key, value in Counter(str(r.get("outcome") or r.get("verdict")) for r in blocked).most_common():
        print(f"  {key:16} {value}")

if dispatched:
    errors = sum(1 for r in dispatched if r.get("is_error"))
    print()
    print(f"Gated calls that ran: {len(dispatched)} ({errors} errored)")

if verifications:
    print()
    print(f"Verifications    : {len(verifications)}")
    for key, value in Counter(r.get("verdict", "unknown") for r in verifications).most_common():
        print(f"  {key:14} {value}")

print()
