---
name: wezterm
description: "Remote control WezTerm sessions for interactive CLIs (python, gdb, etc.) by sending keystrokes and scraping pane output via the socket API."
license: Vibecoded
---

# WezTerm Skill

Use WezTerm as a programmable terminal multiplexer for interactive work.

## Quickstart (isolated socket)

```bash
SOCKET_DIR=${TMPDIR:-/tmp}/claude-wezterm-sockets  # well-known dir for all agent sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"                   # keep agent sessions separate from your personal WezTerm
SESSION="claude-python"                            # slug-like names; avoid spaces

# Start WezTerm server on private socket
WEZTERM_SOCK="$SOCKET" wezterm start --class claude-agent

# Send Python command to active pane
WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 'python3 -q' Enter

# Capture pane output
WEZTERM_SOCK="$SOCKET" wezterm cli capture-pane -p 0

# Clean up
WEZTERM_SOCK="$SOCKET" wezterm cli kill-pane --pane-id 0
```

After starting a session ALWAYS tell the user how to monitor the session by giving them a command to copy paste:

```
To monitor this session yourself:
  WEZTERM_SOCK="$SOCKET" wezterm cli attach --pane-id 0

Or to capture the output once:
  WEZTERM_SOCK="$SOCKET" wezterm cli capture-pane -p 0
```

This must ALWAYS be printed right after a session was started and once again at the end of the tool loop. But the earlier you send it, the happier the user will be.

## Socket convention

- Agents MUST place WezTerm sockets under `CLAUDE_WEZTERM_SOCKET_DIR` (defaults to `${TMPDIR:-/tmp}/claude-wezterm-sockets`) and use `WEZTERM_SOCK="$SOCKET"` so we can enumerate/clean them. Create the dir first: `mkdir -p "$CLAUDE_WEZTERM_SOCKET_DIR"`.
- Default socket path to use unless you must isolate further: `SOCKET="$CLAUDE_WEZTERM_SOCKET_DIR/claude.sock"`.
- Set `WEZTERM_SOCK` environment variable before all `wezterm cli` commands.

## Tabs, panes, and naming

- Pane IDs are referenced as integers (0, 1, 2, ...) in the pane-id flag.
- Create new tabs with `WEZTERM_SOCK="$SOCKET" wezterm cli spawn-tab --domain-name local`.
- Use human-readable tab titles: `WEZTERM_SOCK="$SOCKET" wezterm cli set-tab-title --pane-id 0 "Python REPL"`.
- List panes: `WEZTERM_SOCK="$SOCKET" wezterm cli list-clients`.
- Keep names short and descriptive (e.g., `Claude Python`, `Claude GDB`).

## Finding sessions and panes

- List all active panes/tabs: `WEZTERM_SOCK="$SOCKET" wezterm cli list-clients`.
- Get metadata and tab information: `WEZTERM_SOCK="$SOCKET" wezterm cli list-clients --format json` for structured output.
- Inspect a specific pane: pane IDs start at 0 and increment for each new tab.

## Sending input safely

- Send text with Enter key: `WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 'command' Enter`.
- Use the `send-text` command for literal text (no shell expansion within the string itself).
- Escape special characters in the command string: use ANSI C quoting where needed, e.g., `$'python3 -c "import sys"'`.
- Send control keys: `WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 C-c` (Ctrl+C), `C-d` (Ctrl+D), `C-z` (Ctrl+Z).

## Watching output

- Capture recent output (plaintext): `WEZTERM_SOCK="$SOCKET" wezterm cli capture-pane -p 0`.
- For continuous monitoring, poll with timed intervals instead of blocking waits.
- You can also temporarily attach to observe (requires tmux-like detach sequence or manual termination): detach workflows work differently in WezTerm.
- When giving instructions to a user, **explicitly print a copy/paste monitor command** alongside the action; don't assume they remembered the command.

## Spawning processes

Some special rules for processes:

- when asked to debug, use lldb on macOS or gdb on Linux by default.
- when starting a python interactive shell, always set the `PYTHONUNBUFFERED=1` environment variable. This ensures output is not buffered and captured correctly.

## Synchronizing / waiting for prompts

- Use timed polling to avoid races with interactive tools. Example: wait for a Python prompt before sending code:
  ```bash
  ./scripts/wait-for-text.sh -p 0 '^>>>' -T 15 -l 4000
  ```
- For long-running commands, poll for completion text (`"Type quit to exit"`, `"Program exited"`, etc.) before proceeding.
- WezTerm's pane capture is synchronous, so polling works naturally without complex waits.

## Interactive tool recipes

- **Python REPL**: `WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 'PYTHONUNBUFFERED=1 python3 -q' Enter`; wait for `^>>>`; send code with `send-text`; interrupt with `C-c`. Always set `PYTHONUNBUFFERED=1`.
- **gdb/lldb**: `WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 'lldb ./a.out' Enter` (macOS) or `gdb --quiet ./a.out` (Linux); disable paging if available `set pagination off` (gdb); break with `C-c`; issue `bt`, `info locals`, etc.; exit via `quit` then confirm `y`.
- **Other TTY apps** (ipdb, psql, mysql, node, bash): same pattern—start the program, poll for its prompt, then send literal text and Enter.

## Cleanup

- Kill a pane when done: `WEZTERM_SOCK="$SOCKET" wezterm cli kill-pane --pane-id 0`.
- Kill all panes/close the window: `WEZTERM_SOCK="$SOCKET" wezterm cli kill-client`.
- Remove the socket and server: `rm -f "$SOCKET"` after ensuring no processes are using it.

## Helper: wait-for-text.sh (adapted for WezTerm)

`./scripts/wait-for-text.sh` polls a pane for a regex (or fixed string) with a timeout. Works on Linux/macOS/Windows with bash + wezterm-cli + grep.

```bash
./scripts/wait-for-text.sh -p 0 -P 'pattern' [-F] [-T 20] [-i 0.5] [-l 2000]
```

- `-p`/`--pane-id` pane ID (integer, required)
- `-P`/`--pattern` regex to match (required); add `-F` for fixed string
- `-T` timeout seconds (integer, default 15)
- `-i` poll interval seconds (float, default 0.5)
- `-l` history lines to search from the pane (integer, default 1000)
- Exits 0 on first match, 1 on timeout. On failure prints the last captured text to stderr to aid debugging.

### Example implementation:

```bash
#!/bin/bash
# wait-for-text.sh - Poll WezTerm pane for text pattern

PANE_ID=""
PATTERN=""
FIXED=false
TIMEOUT=15
INTERVAL=0.5
LINES=1000
SOCKET="${WEZTERM_SOCK:-/tmp/wezterm.sock}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--pane-id) PANE_ID="$2"; shift 2 ;;
    -P|--pattern) PATTERN="$2"; shift 2 ;;
    -F|--fixed-string) FIXED=true; shift ;;
    -T|--timeout) TIMEOUT="$2"; shift 2 ;;
    -i|--interval) INTERVAL="$2"; shift 2 ;;
    -l|--lines) LINES="$2"; shift 2 ;;
    *) shift ;;
  esac
done

[[ -z "$PANE_ID" || -z "$PATTERN" ]] && { echo "Usage: $0 -p PANE_ID -P PATTERN"; exit 1; }

START=$(date +%s)
while true; do
  OUTPUT=$(WEZTERM_SOCK="$SOCKET" wezterm cli capture-pane -p "$PANE_ID" 2>/dev/null | tail -n "$LINES")
  if [[ "$FIXED" == true ]]; then
    grep -qF "$PATTERN" <<< "$OUTPUT" && exit 0
  else
    grep -qE "$PATTERN" <<< "$OUTPUT" && exit 0
  fi

  NOW=$(date +%s)
  [[ $((NOW - START)) -ge $TIMEOUT ]] && { echo "$OUTPUT" >&2; exit 1; }
  sleep "$INTERVAL"
done
```

## Key differences from tmux

- **Pane identification**: WezTerm uses simple integer pane IDs (0, 1, 2...) instead of tmux's `session:window.pane` format.
- **Command interface**: `wezterm cli` replaces `tmux` for most remote control operations.
- **Socket setup**: `WEZTERM_SOCK` environment variable instead of `-S` flag.
- **Output capture**: `wezterm cli capture-pane -p PANE_ID` (simpler, no -J flag needed).
- **Tab management**: Tabs are created with `spawn-tab` and listed with `list-clients`.
- **Buffering**: Use `PYTHONUNBUFFERED=1` for interactive Python to ensure output appears immediately.
- **Performance**: WezTerm's GPU-accelerated rendering is faster for continuous output monitoring.

## Example workflow

```bash
# Setup
SOCKET_DIR=${TMPDIR:-/tmp}/claude-wezterm-sockets
mkdir -p "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/claude.sock"

# Start server
WEZTERM_SOCK="$SOCKET" wezterm start --class claude-agent &
sleep 1  # wait for server to initialize

# Start Python REPL
WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 $'PYTHONUNBUFFERED=1 python3 -q\n'

# Wait for prompt
./scripts/wait-for-text.sh -p 0 -P '^>>>' -T 10

# Send command
WEZTERM_SOCK="$SOCKET" wezterm cli send-text --pane-id 0 $'print("Hello")\n'

# Capture output
WEZTERM_SOCK="$SOCKET" wezterm cli capture-pane -p 0

# Cleanup
WEZTERM_SOCK="$SOCKET" wezterm cli kill-pane --pane-id 0
```
