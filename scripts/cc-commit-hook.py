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
import sys, os, json, re, subprocess, urllib.request, urllib.parse


def canonical_remote(raw):
    """Match the file-decision collector's hosted RepositoryId grammar; return empty on ambiguity."""
    raw = (raw or "").strip()
    if not raw or raw.startswith(("/", "./", "../")) or raw.lower().startswith("file:"):
        return ""
    host = ""
    repo_path = ""
    port = None
    scp = re.fullmatch(r"([^@/:]+)@([^/:]+):(.+)", raw)
    if scp and "://" not in raw:
        if scp.group(1) != "git":
            return ""
        host, repo_path = scp.group(2), scp.group(3)
    else:
        try:
            url = urllib.parse.urlsplit(raw)
            if url.scheme not in ("https", "http", "ssh", "git"):
                return ""
            if url.password or (url.username and not (url.scheme == "ssh" and url.username == "git")):
                return ""
            host, port, repo_path = url.hostname or "", url.port, url.path
            if (url.scheme, port) in (("https", 443), ("http", 80), ("ssh", 22)):
                port = None
        except Exception:
            return ""
    try:
        host = host.encode("idna").decode("ascii").lower()
    except (UnicodeError, UnicodeDecodeError):
        return ""
    if host == "github.com":
        port = None
    repo_path = repo_path.strip("/")
    if repo_path.lower().endswith(".git"):
        repo_path = repo_path[:-4].rstrip("/")
    if "%" in repo_path:
        return ""
    segments = repo_path.split("/")
    if not host or len(segments) < 2 or any(segment in ("", ".", "..") for segment in segments):
        return ""
    if "." not in host or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in host.split(".")):
        return ""
    if host == "github.com":
        if len(segments) != 2 or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", segment) for segment in segments):
            return ""
        segments = [segment.lower() for segment in segments]
    elif any(re.search(r"[\x00-\x20\x7f]", segment) for segment in segments):
        return ""
    return host + ((":" + str(port)) if port else "") + "/" + "/".join(segments)


def file_ref(repository, repo_relative_path):
    return (
        "file:"
        + urllib.parse.quote(repository, safe="")
        + ":"
        + urllib.parse.quote(repo_relative_path, safe="")
    )


def focus_site(raw):
    try:
        url = urllib.parse.urlsplit((raw or "").strip())
        host = (url.hostname or "").encode("idna").decode("ascii").lower()
        loopback = host in ("localhost", "127.0.0.1", "::1")
        if (url.scheme != "https" and not (loopback and url.scheme == "http")):
            return ""
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            return ""
        port = url.port
        authority = "[" + host + "]" if ":" in host else host
        return url.scheme + "://" + authority + ((":" + str(port)) if port else "")
    except Exception:
        return ""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


if len(sys.argv) == 3 and sys.argv[1] == "--canonicalize":
    print(canonical_remote(sys.argv[2]))
    sys.exit(0)
if len(sys.argv) == 4 and sys.argv[1] == "--file-ref":
    print(file_ref(sys.argv[2], sys.argv[3]))
    sys.exit(0)

key = os.environ.get("FOCUS_API_KEY")
if not key:
    sys.exit(0)
site = focus_site(os.environ.get("FOCUS_CONVEX_SITE", "https://perceptive-butterfly-406.convex.site"))
if not site:
    sys.exit(0)

try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

cmd = (payload.get("tool_input") or {}).get("command") or ""
tool_response = payload.get("tool_response") or {}
exit_code = tool_response.get("exitCode", tool_response.get("exit_code")) if isinstance(tool_response, dict) else None
# A post-hook without an explicit successful Bash exit cannot prove a commit happened. Fail closed
# until the pre/post durable commit collector replaces this legacy best-effort path.
if exit_code != 0:
    sys.exit(0)
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
all_files = [f for f in git("show", "--name-only", "--format=", "HEAD").splitlines() if f]
origins = [line for line in git("config", "--get-all", "remote.origin.url").splitlines() if line]
repository = canonical_remote(origins[0]) if len(origins) == 1 else ""
refs = [{"type": "produces", "target": "commit:" + sha}]
if repository:
    for file_path in all_files:
        target = file_ref(repository, file_path)
        if len(refs) >= 97 or len(target) > 1024:
            continue
        refs.append({"type": "produces", "target": target})
omitted_files = len(all_files) - (len(refs) - 1)
agent = "cc-" + sid[:6]
project = (repo.split("/")[-1] or "unknown")
try:
    req = urllib.request.Request(
        site + "/agent/event",
        data=json.dumps({
            "agentId": agent, "type": "output",
            "summary": ("committed: " + subject + (f" [{omitted_files} files omitted]" if omitted_files else ""))[:200],
            "refs": refs,
        }).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key},
    )
    response = urllib.request.build_opener(NoRedirect).open(req, timeout=3)
    if response.status < 200 or response.status >= 300:
        raise ValueError("Focus event request failed")
    if "application/json" not in (response.headers.get("Content-Type") or "").lower():
        raise ValueError("Focus event response was not JSON")
    response_bytes = response.read(65537)
    if len(response_bytes) > 65536:
        raise ValueError("Focus event response was too large")
    response_value = json.loads(response_bytes)
    if not isinstance(response_value, dict) or not isinstance(response_value.get("eventId"), str):
        raise ValueError("Focus event response did not contain an event id")
    open(seen, "w").write(sha)
except Exception:
    pass

sys.exit(0)
