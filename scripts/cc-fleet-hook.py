#!/usr/bin/env python3
"""CC -> focus fleet auto-report hook (FOC-12).

Wire into ~/.claude/settings.json so local Claude Code sessions report their presence to the
focus fleet with zero per-agent effort. Reads the hook JSON on stdin; the event name is argv[1]
(or falls back to the payload's hook_event_name). Maps the CC lifecycle to fleet state:

    SessionStart / UserPromptSubmit -> working
    Notification                    -> needs_you   (CC is waiting on the human)
    Stop / SubagentStop             -> done        (turn finished)

Identity: FOCUS_USER_ID (= the web app's focus_user_id cookie). Endpoint: FOCUS_CONVEX_URL
(defaults to prod). Designed to NEVER block or fail Claude Code: no id -> no-op, all errors
swallowed, always exits 0, 3s timeout.
"""
import sys, os, json, urllib.request

uid = os.environ.get("FOCUS_USER_ID")
if not uid:
    sys.exit(0)  # no identity configured -> silently do nothing

url = os.environ.get("FOCUS_CONVEX_URL", "https://perceptive-butterfly-406.convex.cloud")

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
agent = "cc-" + (payload.get("session_id") or "session")[:6]

body = {
    "path": "fleet:report",
    "args": {"userId": uid, "agentId": agent, "project": project, "state": state, "source": "cc"},
    "format": "json",
}
try:
    req = urllib.request.Request(
        url + "/api/mutation",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=3).read()
except Exception:
    pass

sys.exit(0)
