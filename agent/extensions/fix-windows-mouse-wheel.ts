import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fix: mouse wheel does not scroll Pi's fullscreen viewport in Git Bash (mintty).
 *
 * Root cause (measured on mintty 3.8.3 + Node 24 + Pi 1.0.4):
 * `TuiAltScreen.beforeTerminalStart()` writes the mouse DECSET burst
 * (`?1000h ?1002h ?1003h ?1004h ?1006h`) *before* `ProcessTerminal.start()`
 * calls `process.stdin.setRawMode(true)` and adds ENABLE_VIRTUAL_TERMINAL_INPUT.
 * On Windows those writes travel through ConPTY. While the console input handle
 * is still cooked (no raw mode, no VT input), ConPTY does not forward the mouse
 * tracking modes to the terminal, so mintty never enables mouse reporting.
 * mintty then emulates xterm "alternateScroll": the wheel becomes cursor keys /
 * PgUp-PgDn, which Pi consumes as editor prompt-history navigation instead of
 * transcript scrolling. A focus-reporting DECSET written in the same burst
 * (`?1004h`) *is* forwarded, which is why only the wheel breaks.
 *
 * Upstream: https://github.com/earendil-works/pi/issues/9656 (same ordering bug,
 * reported for Zellij; the fix there is to move the writes after raw mode).
 *
 * This extension does not patch Pi, so it survives `pi` upgrades. It records the
 * mouse DECSET burst that Pi writes while stdin is not raw yet, and replays it
 * once raw mode + VT input are active. DECSET `h` is idempotent, so replaying a
 * burst that partially took effect is harmless.
 */

const MOUSE_MODES = new Set([1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016]);
const DEC_PRIVATE = /\x1b\[\?(\d+)([hl])/g;
const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const SGR_MOUSE = /\x1b\[<\d+(?:;\d+){0,3}[Mm]/;
const X10_MOUSE = /\x1b\[M[\x20-\x7f][\x20-\x7f][\x20-\x7f]/;
const WHEEL = /\x1b\[<(6[45])(?:;\d+){2}[Mm]/;

interface FixState {
    /** Mouse burst Pi wrote while raw mode was still off, waiting for replay. */
    pending: string | null;
    /** Last enable burst seen, used by `/wheelFix force`. */
    lastEnable: string;
    replays: number;
    installs: number;
    mouseEvents: number;
    wheelEvents: number;
    patched: boolean;
    unsupported: boolean;
    off: boolean;
}

const state: FixState = ((globalThis as Record<symbol, FixState>)[Symbol.for("pi.minttyWheelFix")] ??=
    {
        pending: null,
        lastEnable: ENABLE_MOUSE,
        replays: 0,
        installs: 0,
        mouseEvents: 0,
        wheelEvents: 0,
        patched: false,
        unsupported: false,
        off: false,
    });

function observeWrite(chunk: string): void {
    DEC_PRIVATE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const enabled: number[] = [];
    let disabledRoot = false;
    while ((match = DEC_PRIVATE.exec(chunk)) !== null) {
        const mode = Number.parseInt(match[1], 10);
        if (!MOUSE_MODES.has(mode)) continue;
        if (match[2] === "h") enabled.push(mode);
        else if (mode === 1000) disabledRoot = true;
    }
    if (disabledRoot) {
        // Pi turned mouse tracking off (terminal stop); nothing to replay.
        state.pending = null;
        return;
    }
    if (!enabled.includes(1000)) return;
    const burst = [...new Set(enabled)].sort((a, b) => a - b).map((mode) => `\x1b[?${mode}h`).join("");
    state.lastEnable = burst;
    // Raw mode already on => Pi's write lands in a VT-input console and works.
    // Raw mode off => ConPTY drops it, so remember it for the next raw transition.
    state.pending = process.stdin.isRaw === true ? null : burst;
}

function install(): void {
    const stdout = process.stdout as unknown as {
        write: (...args: unknown[]) => boolean;
        __piWheelFix?: boolean;
    };
    const stdin = process.stdin as unknown as {
        setRawMode?: (mode: boolean) => void;
        __piWheelFixRaw?: boolean;
    };
    if (stdout.__piWheelFix) {
        state.patched = true;
        return;
    }
    if (typeof stdin.setRawMode !== "function") {
        state.unsupported = true;
        return;
    }
    const originalWrite = stdout.write.bind(stdout);
    const replay = (data: string) => {
        originalWrite(data);
    };

    stdout.write = function patchedWrite(...args: unknown[]) {
        const result = originalWrite(...args);
        try {
            if (!state.off) {
                const chunk = args[0];
                if (typeof chunk === "string") observeWrite(chunk);
                else if (Buffer.isBuffer(chunk)) observeWrite(chunk.toString("latin1"));
            }
        } catch {
            // Never break rendering because of bookkeeping.
        }
        return result;
    } as typeof stdout.write;
    stdout.__piWheelFix = true;

    const originalSetRawMode = stdin.setRawMode.bind(stdin);
    stdin.setRawMode = function patchedSetRawMode(mode: boolean) {
        const result = originalSetRawMode(mode);
        try {
            if (mode === true && state.pending && !state.off) {
                const burst = state.pending;
                // Fire after ProcessTerminal.start() finished enabling
                // ENABLE_VIRTUAL_TERMINAL_INPUT (synchronous, same stack).
                setTimeout(() => {
                    if (!process.stdin.isRaw || state.off) return;
                    if (state.pending === burst) state.pending = null;
                    replay(burst);
                    state.replays++;
                }, 10);
            }
        } catch {
            // Ignore.
        }
        return result;
    } as typeof stdin.setRawMode;
    stdin.__piWheelFixRaw = true;
    state.patched = true;
    state.installs++;
}

function observeInput(data: string): void {
    if (SGR_MOUSE.test(data) || X10_MOUSE.test(data)) state.mouseEvents++;
    if (WHEEL.test(data)) state.wheelEvents++;
}

function statusText(): string {
    const lines = [
        `platform=${process.platform} TERM=${process.env.TERM ?? "-"} TERM_PROGRAM=${process.env.TERM_PROGRAM ?? "-"}`,
        `raw mode=${String(Boolean(process.stdin.isRaw))} patched=${String(state.patched)} unsupported=${String(state.unsupported)}`,
        `replays=${state.replays} pending=${state.pending ? "yes" : "no"} disabled=${String(state.off)}`,
        `terminal->pi: mouse reports=${state.mouseEvents} wheel events=${state.wheelEvents}`,
    ];
    if (state.wheelEvents > 0) lines.push("Wheel reports are arriving: the fix is active.");
    else if (state.replays > 0) lines.push("Replayed the mouse burst but no wheel report yet - roll the wheel once and run /wheelFix again.");
    else lines.push("No replay yet - restart pi in Git Bash, then roll the wheel.");
    lines.push("Usage: /wheelFix [force|on|off|reset]");
    return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
    if (process.platform === "win32" && process.env.PI_WHEEL_FIX !== "0") install();

    pi.on("session_start", async (_event, ctx) => {
        if (process.platform === "win32" && process.env.PI_WHEEL_FIX !== "0") install();
        try {
            if (ctx.mode === "tui")
                ctx.ui.onTerminalInput((data) => {
                    observeInput(data);
                });
        } catch {
            // onTerminalInput is unavailable outside interactive mode.
        }
    });

    pi.registerCommand("wheelFix", {
        description: "Git Bash / mintty mouse-wheel fix status (Pi fullscreen wheel scrolling)",
        handler: async (args, ctx) => {
            const action = (args || "").trim().toLowerCase();
            const write = (data: string) => process.stdout.write(data);
            if (action === "force") {
                if (state.off) state.off = false;
                if (!state.patched) install();
                write(state.lastEnable);
                state.replays++;
                ctx.ui.notify(`Re-enabled mouse reporting for Pi fullscreen.\n${statusText()}`, "info");
                return;
            }
            if (action === "off") {
                state.off = true;
                state.pending = null;
                write(DISABLE_MOUSE);
                ctx.ui.notify("Mouse-wheel fix disabled and mouse reporting turned off.", "info");
                return;
            }
            if (action === "on") {
                state.off = false;
                install();
                write(state.lastEnable);
                ctx.ui.notify("Mouse-wheel fix enabled.", "info");
                return;
            }
            if (action === "reset") {
                state.mouseEvents = 0;
                state.wheelEvents = 0;
                state.replays = 0;
                ctx.ui.notify("Counters reset.", "info");
                return;
            }
            ctx.ui.notify(statusText(), "info");
        },
    });
}
