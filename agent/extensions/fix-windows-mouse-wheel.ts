import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ConPTY drops the mouse DECSETs Pi writes before raw mode.
export default function (pi: ExtensionAPI) {
    if (process.platform !== "win32") return;
    pi.on("session_start", async () => {
        // ESC[?<n>h = enable xterm mode n: 1000 mouse clicks, 1002 drag, 1003 any motion, 1006 SGR coordinates (wheel reports).
        process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    });
}
