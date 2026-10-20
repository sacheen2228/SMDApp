#!/usr/bin/env python3
"""Shared contract for the orchestrator's agents A-E.

Every agent is a standalone process:
  * the task arrives as JSON on stdin
  * the result leaves as JSON on stdout (stdout carries ONLY the result)
  * diagnostics go to stderr
  * exit code 0 = a result was produced, non-zero = the agent failed

The orchestrator treats ANY deviation as a fail-closed veto:
timeout, non-zero exit, unparseable stdout, or a result missing a required
field.  A half-parsed agent can never become a "pass".
"""
import json
import os
import sys

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, SCRIPTS_DIR)

IST_TZ = "Asia/Kolkata"

REQUIRED = {
    "A": ("agent", "status", "direction", "vetoes"),
    "B": ("agent", "status", "direction", "vetoes"),
    "C": ("agent", "status", "direction", "vetoes"),
    "D": ("agent", "status", "direction", "vetoes"),
    "E": ("agent", "status", "direction", "vetoes", "trade"),
}

DIRECTIONS = ("CE", "PE", "NEUTRAL")


def veto(gate, observed, threshold, detail=""):
    """One mandatory veto. Always names what was seen and what was needed."""
    return {"gate": gate, "observed": str(observed), "threshold": str(threshold),
            "detail": str(detail)}


def result(agent, direction="NEUTRAL", vetoes=None, checks=None, data=None, notes=None):
    return {
        "agent": agent,
        "status": "ok",
        "direction": direction if direction in DIRECTIONS else "NEUTRAL",
        "vetoes": list(vetoes or []),
        "checks": checks or {},
        "data": data or {},
        "notes": list(notes or []),
    }


def failed(agent, reason, vetoes=None):
    vetoes = list(vetoes or [])
    if not vetoes:
        vetoes = [veto("AGENT_FAILED", reason, "a successful agent result")]
    res = result(agent, direction="NEUTRAL", vetoes=vetoes)
    res["status"] = "failed"
    res["notes"] = [str(reason)]
    res["error"] = str(reason)
    return res


def check(passed, observed, threshold, detail=""):
    """One check with its number - never a silent pass."""
    return {"pass": bool(passed), "observed": str(observed), "threshold": str(threshold),
            "detail": str(detail)}


def load_json(path):
    with open(path) as fh:
        return json.load(fh)


def read_task(argv=None):
    """Task JSON from stdin (preferred) or from --task <file>."""
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--task" in argv:
        idx = argv.index("--task")
        return load_json(argv[idx + 1])
    data = sys.stdin.read()
    if not data.strip():
        raise ValueError("no task on stdin")
    return json.loads(data)


def emit(res, argv=None):
    """Print the result JSON and exit.

    Exit code 0 means "a result object was produced" - the result's own
    `status` says whether the agent succeeded.  A non-zero exit therefore
    always means the agent never produced a result at all.
    """
    sys.stdout.write(json.dumps(res))
    sys.stdout.flush()
    sys.exit(0)


def main_wrapper(agent, fn, argv=None):
    """Standard entry point: parse the task, run the agent, emit the result."""
    try:
        task = read_task(argv)
    except Exception as exc:
        emit(failed(agent, "could not read the task: %s" % exc))
        return
    try:
        res = fn(task)
    except Exception as exc:  # fail closed - an exception is never a pass
        res = failed(agent, "%s: %s" % (type(exc).__name__, exc))
    if not isinstance(res, dict):
        res = failed(agent, "agent returned a non-object result")
    for field in REQUIRED.get(agent, ()):
        if field not in res:
            res = failed(agent, "result is missing the required field %r" % field)
            break
    emit(res, argv)
