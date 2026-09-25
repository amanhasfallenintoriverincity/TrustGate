---
name: trustgate
description: Use when an authorized project needs a TrustGate local security scan and sandbox verdict review.
---

# TrustGate local scans

TrustGate is a local CLI for a separately running, loopback-only TrustGate orchestrator. It does not start the server or authorize a workspace for you. Never supply credentials, secrets, or a remote URL to this CLI; never print raw input files or secrets in chat or logs. The report itself may contain sensitive evidence: share only what the user authorizes.

1. Confirm the user authorized the specific project to scan. The operator must set `TRUSTGATE_WORKSPACE_ROOT` to the intended pinned project and have the server already running; this CLI does not set the root, start the server, or auto-authorize access. Use `scan --root` for that authorized pinned project, or `scan --repo RELATIVE_PATH` for an authorized subdirectory **inside the orchestrator's pinned workspace root**, not an arbitrary local/absolute path. The server independently checks its allowlist; if it refuses, stop instead of retrying with a different path. Fixture scans replay saved demonstrations, not live workspace/LLM/Podman results.
2. Check that the server is already running and consult exact CLI help before scanning:

    node {{TRUSTGATE_CLI}} --help
    node {{TRUSTGATE_CLI}} health

   The default server is `http://127.0.0.1:8787`. If the operator has explicitly configured another loopback HTTP port, pass `--server http://127.0.0.1:PORT` to `health` and `scan`. Only literal `127.0.0.1` and `[::1]` hosts are accepted; do not use remote, DNS-based, or HTTPS endpoints. Scans default to a 180-second timeout (the LLM request can take 120 seconds); for a slower authorized scan use `--timeout-ms 300000` (maximum 300 seconds).
3. Run the authorized task, once:

    node {{TRUSTGATE_CLI}} scan --fixture
    node {{TRUSTGATE_CLI}} scan --root
    node {{TRUSTGATE_CLI}} scan --repo RELATIVE_PATH

   Choose **exactly one** of `--fixture`, `--root`, or `--repo`. Each successful command prints one JSON report to stdout. A failure prints a fixed diagnostic to stderr and exits nonzero; do not treat it as a negative security verdict or attempt to print raw server error bodies. A report can be retrieved on that server by `GET /api/runs/:runId`; this CLI only exposes scan and health.
4. Interpret the JSON carefully: `hypotheses` are LLM proposals, not confirmed vulnerabilities. Inspect each test's `vulnerableResult.verdict`, `patchedResult.verdict`, evidence, and `regressionVerdict`, and the overall `regressionVerdict`. A sandbox `CONFIRMED` describes reproduction **in that sandbox target only**; `BLOCKED` describes a blocked attempt there. `UNVERIFIED`/`ERROR` are inconclusive, and `FIXED` requires the before/after evidence to match the claimed regression. The current sandbox image runs TrustGate's fixed demo target, not an arbitrary scanned project's service. Never claim an external project's vulnerability was reproduced or fixed from this report alone. Do not claim a fixture replay proved a live workspace run.

Codex, Claude Code, Cursor and Hermes can load this project skill when installed in their respective project skill directories. For Hermes project skills, the user must additionally run `hermes skills trust ABS_DIR` for that project; this installer does not grant trust automatically.
