#!/usr/bin/env python3
"""CC -> focus fleet auto-report hook (FOC-12, keyed in FOC-25).

Wire into ~/.claude/settings.json so local Claude Code sessions report their presence to the
focus fleet with zero per-agent effort. Reads the hook JSON on stdin; the event name is argv[1]
(or falls back to the payload's hook_event_name). Maps the CC lifecycle to fleet state:

    SessionStart / UserPromptSubmit -> working
    Notification                    -> needs_you   (CC is waiting on the human)
    Stop / SubagentStop             -> done        (turn finished)

Auth: FOCUS_API_KEY — a minted `ak_…` key (focus web -> Settings -> Mint key), kept in bws and
injected via settings.json env. The owner is derived from the KEY server-side; no cleartext
account id is ever carried. Endpoint: FOCUS_CONVEX_SITE (the deployment's .convex.site host).
Designed to NEVER block or fail Claude Code: no key -> no-op, all errors swallowed, always
exits 0, 3s timeout.
"""
import sys, os, json, urllib.request

key = os.environ.get("FOCUS_API_KEY")
if not key:
    sys.exit(0)  # no key configured -> silently do nothing

# The .convex.site HTTP host (NOT .convex.cloud). Defaults to the auth-enabled deployment.
site = os.environ.get("FOCUS_CONVEX_SITE", "https://perceptive-butterfly-406.convex.site").rstrip("/")

try:
    payload = json.load(sys.stdin)
except Exception:
    payload = {}

event = (sys.argv[1] if len(sys.argv) > 1 else "") or payload.get("hook_event_name") or ""
state = {
    "SessionStart": "working",
    "UserPromptSubmit": "working",
    "Notification": "needs_you",
    "Stop": "done",
    "SubagentStop": "done",
}.get(event)
if not state:
    sys.exit(0)

cwd = (payload.get("cwd") or "").rstrip("/")
project = cwd.split("/")[-1] or "unknown"
sid = payload.get("session_id") or "session"
agent = "cc-" + sid[:6]


# Presence + activity. "what is this agent doing right now" = the latest prompt's first line
# (UserPromptSubmit only); other events leave the last-known activity untouched. Commit capture
# now lives in the PostToolUse hook (cc-commit-hook.py), which sees commits in ANY repo regardless
# of the session cwd — so this hook is presence-only.
body = {"agentId": agent, "project": project, "state": state, "source": "cc"}
prompt = (payload.get("prompt") or "").strip()
if event == "UserPromptSubmit" and prompt:
    body["activity"] = prompt.splitlines()[0][:80]
try:
    req = urllib.request.Request(
        site + "/agent/report",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    urllib.request.urlopen(req, timeout=3).read()
except Exception:
    pass

sys.exit(0)
