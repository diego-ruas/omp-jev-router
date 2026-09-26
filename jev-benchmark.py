#!/usr/bin/env python3
"""Summarize a jev-evals.jsonl decision log.

The log only carries the two decision points the extension still owns — the tool gate (`safety`,
`safety-jev`, `safety-jev-block`, `safety-jev-outcome`) and the post-run check (`verify`). Routing
moved to the `typesafe/jev-router` model, so no routing records exist to summarize.
"""

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

verifications = [
    r
    for r in records
    if r.get("kind") == "verify"
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


print()
print("JEV DECISION LAYER BENCHMARK")
print("=" * 50)

print(f"safety checks     : {len(safety)}")
print(f"gate calls        : {len(gate)}")
print(f"gated calls ran   : {len(dispatched)}")
print(f"verifications     : {len(verifications)}")

# `flagged` is written by the Jev gate (kind "safety-jev"), never by the local regex record.
flagged = sum(1 for r in gate if r.get("flagged"))

if gate:
    verdicts = Counter(r.get("verdict", "unknown") for r in gate)
    print()
    print(
        "Gate flagged     : "
        f"{flagged}/{len(gate)} "
        f"({flagged / len(gate) * 100:.1f}%)"
    )
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
