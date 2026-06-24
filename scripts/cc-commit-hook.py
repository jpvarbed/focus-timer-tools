#!/usr/bin/env python3
"""CC PostToolUse -> focus provenance: capture git commits as `output` events (FOC-31).

Fires after every Bash tool call. If the command made a git commit, records the new commit (and
the files it touched) as an `output` event — so an agent's commits land on the fleet graph
regardless of the session's working directory (the Stop-based hook only saw cwd's repo). Resolves
the repo from `git -C <dir>` / `cd <dir>` in the command, else the session cwd. Dedups by sha so a
non-commit git call (or a repeated fire) doesn't double-post.

Auth: FOCUS_API_KEY (launchd/shell env). Endpoint: FOCUS_CONVEX_SITE. Never blocks CC: no key ->
no-op, all errors swallowed, exits 0, 3s timeouts.
"""
import sys, os, json, re, subprocess, urllib.request

key = os.environ.get("FOCUS_API_KEY")
if not key:
    sys.exit(0)
site = os.environ.get("FOCUS_CONVEX_SITE", "https://perceptive-butterfly-406.convex.site").rstrip("/")

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = (payload.get("tool_input") or {}).get("command") or ""
# Only react to an actual `git … commit` (not `git log`, not `--grep=commit`).
if not re.search(r"\bgit\b[^|&;]*\bcommit\b", cmd):
    sys.exit(0)

# Resolve the repo: explicit `-C <dir>`, else a `cd <dir>` in the command, else the session cwd.
m = re.search(r"-C\s+(\S+)", cmd) or re.search(r"\bcd\s+(\S+)", cmd)
repo = (m.group(1).strip("'\"") if m else (payload.get("cwd") or "")).rstrip("/")
repo = os.path.expanduser(repo)


def git(*a):
    try:
        return subprocess.run(["git", "-C", repo, *a], capture_output=True, text=True, timeout=3).stdout.strip()
    except Exception:
        return ""


if not repo or git("rev-parse", "--is-inside-work-tree") != "true":
    sys.exit(0)
sha = git("rev-parse", "HEAD")
if not sha:
    sys.exit(0)

sid = payload.get("session_id") or "session"
seen = "/tmp/focus-commit-%s.last" % sid
try:
    if open(seen).read().strip() == sha:  # already posted this commit
        sys.exit(0)
except Exception:
    pass

subject = git("log", "-1", "--format=%s")
files = [f for f in git("show", "--name-only", "--format=", "HEAD").splitlines() if f][:8]
refs = [{"type": "produces", "target": "commit:" + sha[:12]}]
refs += [{"type": "produces", "target": "file:" + f} for f in files]
agent = "cc-" + sid[:6]
project = (repo.split("/")[-1] or "unknown")
try:
    req = urllib.request.Request(
        site + "/agent/event",
        data=json.dumps({
            "agentId": agent, "type": "output",
            "summary": ("committed: " + subject)[:200],
            "refs": refs,
        }).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    urllib.request.urlopen(req, timeout=3).read()
    open(seen, "w").write(sha)
except Exception:
    pass

sys.exit(0)
