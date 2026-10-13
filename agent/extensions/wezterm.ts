// WezTerm integration for pi: tab title status, user var for Lua, /wez-split command.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"; // newer builds: "@earendil-works/pi-coding-agent"
import { execFile } from "node:child_process";
import { basename } from "node:path";

const inWez = !!process.env.WEZTERM_PANE;

// Non-printing escape; wrap for tmux passthrough (needs `set -g allow-passthrough on`)
const osc = (seq: string) =>
  process.stdout.write(process.env.TMUX ? `\x1bPtmux;\x1b${seq}\x1b\\` : seq);

const setVar = (k: string, v: string) =>
  osc(`\x1b]1337;SetUserVar=${k}=${Buffer.from(v).toString("base64")}\x07`);

const setTitle = (t: string) => osc(`\x1b]2;${t}\x07`);

export default function (pi: ExtensionAPI) {
  if (!inWez) return;

  const project = basename(process.cwd());
  const icons = { idle: "✅", working: "⏳", waiting: "❓" } as const;
  const state = (s: keyof typeof icons) => {
    setVar("PI_STATE", s); // consumed by user-var-changed in wezterm.lua
    setTitle(`π ${icons[s]} ${project}`);
  };

  // Flag the tab while any extension (e.g. toolwatch) waits on the user.
  // Monkey-patches ctx.ui prompts once; untested against all pi versions.
  let wrapped = false;
  const wrapUi = (ui: any) => {
    if (wrapped || !ui) return;
    wrapped = true;
    for (const m of ["confirm", "select", "input"]) {
      const orig = ui[m]?.bind(ui);
      if (!orig) continue;
      ui[m] = async (...a: unknown[]) => {
        state("waiting");
        try {
          return await orig(...a);
        } finally {
          state("working");
        }
      };
    }
  };

  pi.on("session_start", async (_e: any, ctx: any) => {
    wrapUi(ctx.ui);
    state("idle");
  });
  pi.on("agent_start", async () => state("working"));
  pi.on("agent_end", async () => state("idle"));
  pi.on("session_shutdown", async () => {
    setVar("PI_STATE", "exit");
    setTitle(project);
  });

  // Last pane opened by /wez-split (read back with /wez-read)
  let lastPane: string | undefined;

  // /wez-split [command...]  -> right split in same cwd (default: pi)
  pi.registerCommand("wez-split", {
    description: "Open a WezTerm split pane (default: pi)",
    handler: async (args: string, ctx: any) => {
      const cmd = args?.trim() ? args.trim().split(/\s+/) : ["pi"];
      execFile(
        "wezterm",
        [
          "cli",
          "split-pane",
          "--percent",
          "40",
          "--cwd",
          process.cwd(),
          "--",
          // nu resolves shims (pi.cmd); -e runs the command then keeps the shell open
          "nu",
          "-e",
          cmd.join(" "),
        ],
        (err, stdout) => {
          if (err) return ctx.ui.notify(`wezterm: ${err.message}`, "error");
          lastPane = stdout.trim(); // split-pane prints the new pane id
          ctx.ui.notify(
            `Split opened (pane ${lastPane}). Use /wez-read`,
            "info",
          );
        },
      );
    },
  });

  // /wez-read [paneId] [lines]  -> send pane text (incl. scrollback) to the agent
  pi.registerCommand("wez-read", {
    description:
      "Send a WezTerm pane's output to the agent (default: last split)",
    handler: async (args: string, ctx: any) => {
      const [idArg, linesArg] = (args ?? "").trim().split(/\s+/);
      const pane = idArg || lastPane;
      if (!pane)
        return ctx.ui.notify(
          "No pane. Run /wez-split first or pass a pane id",
          "warning",
        );
      const lines = Math.max(1, Number(linesArg) || 200);
      execFile(
        "wezterm",
        ["cli", "get-text", "--pane-id", pane, "--start-line", String(-lines)],
        { maxBuffer: 5_000_000 },
        (err, stdout) => {
          if (err) return ctx.ui.notify(`wezterm: ${err.message}`, "error");
          const text = stdout
            .replace(/\s+$/, "")
            .split("\n")
            .slice(-lines)
            .join("\n");
          pi.sendUserMessage(
            `Output of WezTerm pane ${pane}:\n\n\`\`\`\n${text}\n\`\`\``,
          );
        },
      );
    },
  });
}
