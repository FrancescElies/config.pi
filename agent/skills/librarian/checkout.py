#!/usr/bin/env python3
"""Cache and refresh remote git repositories under ~/.cache/checkouts/<host>/<org>/<repo>.

Ensures a reusable local checkout that is:
  - stable   (predictable path: ~/.cache/checkouts/<host>/<org>/<repo>)
  - up to date (periodic fetch + fast-forward when safe)
  - efficient (partial clone with --filter=blob:none, no repeated full clones)

Usage:
    checkout.py <repo> [options]

Options:
    --path-only              Print only the checkout path.
    --force-update           Always fetch from origin and attempt fast-forward.
    --update-interval <secs> Minimum seconds between updates (default: 300).

Environment:
    LIBRARIAN_CACHE_ROOT     Override cache root (default: ~/.cache/checkouts)
    LIBRARIAN_DEFAULT_HOST   Host for owner/repo shorthand (default: github.com)
    LIBRARIAN_UPDATE_INTERVAL  Default update interval in seconds
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

DEFAULT_UPDATE_INTERVAL = 300
LAST_FETCH_MARKER = ".git/librarian-last-fetch"
DEEP_LINK_SEGMENTS = {"tree", "blob", "pull", "issues", "commit", "actions",
                      "releases", "compare", "wiki"}


def die(msg: str, code: int = 2) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def run_git(args: list[str], cwd: Path | None = None,
            check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run a git command, returning the completed process."""
    cmd = ["git", *args]
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, check=check,
                          capture_output=True, text=True)


def parse_repo(input_str: str, default_host: str) -> tuple[str, str, str]:
    """Parse a repository reference into (host, org, repo).

    Accepts: git@host:org/repo(.git), ssh://[user@]host/org/repo,
             http(s)://host/org/repo(.git), host/org/repo, org/repo.
    """
    # Strip query/fragment for URL-like inputs.
    input_str = input_str.split("?", 1)[0].split("#", 1)[0].strip()

    host: str | None = None
    path: str | None = None

    if input_str.startswith("git@") and ":" in input_str:
        host = input_str[len("git@"):]
        host, path = host.split(":", 1)
    elif input_str.startswith("ssh://"):
        rest = input_str[len("ssh://"):]
        host = rest.split("/", 1)[0]
        path = rest.split("/", 1)[1] if "/" in rest else ""
    elif input_str.startswith("http://") or input_str.startswith("https://"):
        rest = input_str.split("://", 1)[1]
        host = rest.split("/", 1)[0]
        path = rest.split("/", 1)[1] if "/" in rest else ""
    elif "/" in input_str:
        first = input_str.split("/", 1)[0]
        if "." in first or first == "localhost":
            host, path = input_str.split("/", 1)
        else:
            host = default_host
            path = input_str
    else:
        die(f"unsupported repository format: {input_str}")

    host = (host or "").split("@")[-1]
    path = (path or "").strip("/")

    # Strip optional .git suffix.
    if path.endswith(".git"):
        path = path[:-4]

    # For GitHub-like deep links (e.g. org/repo/tree/branch), use owner/repo only.
    parts = path.split("/")
    if len(parts) >= 3 and parts[2] in DEEP_LINK_SEGMENTS:
        path = f"{parts[0]}/{parts[1]}"
        parts = path.split("/")

    if len(parts) < 2:
        die(f"repository path must contain at least org/repo: {path}")

    repo = parts[-1]
    org = "/".join(parts[:-1])

    if not host or not org or not repo:
        die(f"failed to parse repository: {input_str}")

    return host, org, repo


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="checkout.py",
        description="Cache and refresh a remote git repository.",
        add_help=False,
    )
    parser.add_argument("repo", nargs="?", help="Repository reference")
    parser.add_argument("--path-only", action="store_true",
                        help="Print only the checkout path")
    parser.add_argument("--force-update", action="store_true",
                        help="Always fetch from origin and attempt fast-forward")
    parser.add_argument("--update-interval", type=int,
                        default=int(os.environ.get("LIBRARIAN_UPDATE_INTERVAL",
                                                   str(DEFAULT_UPDATE_INTERVAL))),
                        help=f"Minimum seconds between updates (default: {DEFAULT_UPDATE_INTERVAL})")
    parser.add_argument("-h", "--help", action="help",
                        help="Show this help message and exit")

    args = parser.parse_args()

    if args.repo is None:
        parser.print_help(sys.stderr)
        sys.exit(1)

    if args.update_interval < 0:
        die("update interval must be a non-negative integer")

    default_host = os.environ.get("LIBRARIAN_DEFAULT_HOST", "github.com")
    cache_root = os.environ.get("LIBRARIAN_CACHE_ROOT",
                                str(Path.home() / ".cache" / "checkouts"))

    host, org, repo = parse_repo(args.repo, default_host)
    checkout_path = Path(cache_root) / host / org / repo
    origin_url = f"https://{host}/{org}/{repo}.git"

    checkout_path.parent.mkdir(parents=True, exist_ok=True)

    if not (checkout_path / ".git").is_dir():
        run_git(["clone", "--filter=blob:none", origin_url, str(checkout_path)])
        clone_state = "cloned"
    else:
        clone_state = "existing"

    if not (checkout_path / ".git").is_dir():
        die(f"checkout path is not a git repository: {checkout_path}", code=3)

    # Ensure origin is set and canonical.
    try:
        current_origin = run_git(["remote", "get-url", "origin"],
                                 cwd=checkout_path, check=False).stdout.strip()
    except subprocess.CalledProcessError:
        current_origin = ""

    if not current_origin:
        run_git(["remote", "add", "origin", origin_url], cwd=checkout_path)
    elif current_origin != origin_url:
        run_git(["remote", "set-url", "origin", origin_url], cwd=checkout_path)

    now_epoch = int(__import__("time").time())
    needs_update = True

    last_fetch_file = checkout_path / LAST_FETCH_MARKER
    if last_fetch_file.exists() and not args.force_update:
        try:
            last_epoch = int(last_fetch_file.read_text().strip())
        except ValueError:
            last_epoch = 0
        if now_epoch - last_epoch < args.update_interval:
            needs_update = False

    update_state = "skipped"
    ff_state = "not-attempted"

    if needs_update:
        run_git(["fetch", "--prune", "--tags", "origin"], cwd=checkout_path)
        last_fetch_file.write_text(str(now_epoch))
        update_state = "fetched"

        branch = run_git(["symbolic-ref", "--short", "-q", "HEAD"],
                         cwd=checkout_path, check=False).stdout.strip() or None
        upstream = run_git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
                           cwd=checkout_path, check=False).stdout.strip() or None
        dirty = run_git(["status", "--porcelain", "--untracked-files=no"],
                        cwd=checkout_path, check=False).stdout.strip()

        if branch and upstream and not dirty:
            if run_git(["merge", "--ff-only", upstream],
                       cwd=checkout_path, check=False).returncode == 0:
                ff_state = "fast-forwarded"
            else:
                ff_state = "skipped-non-ff"
        elif dirty:
            ff_state = "skipped-dirty"
        else:
            ff_state = "skipped-no-upstream"

    if args.path_only:
        print(checkout_path)
        return

    print(f"repo: {host}/{org}/{repo}")
    print(f"path: {checkout_path}")
    print(f"state: {clone_state}")
    print(f"update: {update_state}")
    print(f"fast_forward: {ff_state}")


if __name__ == "__main__":
    main()
