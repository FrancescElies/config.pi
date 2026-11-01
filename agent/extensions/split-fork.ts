// Based on https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/split-fork.ts
//
// WezTerm integration for pi: tab title status, user var for Lua, /wez-split, /wez-fork, /wez-read.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

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

  // Last pane opened by /wez-split or /wez-fork (read back with /wez-read)
  let lastPane: string | undefined;

  // Right split in ctx.cwd running `cmd` in nu; onErr adds context to failures
  const split = (
    ctx: any,
    cmd: string,
    percent: number,
    onOk: (pane: string) => string,
    onErr = "",
  ) =>
    execFile(
      "wezterm",
      // nu resolves shims (pi.cmd); -e runs the command then keeps the shell open
      [
        "cli",
        "split-pane",
        "--percent",
        String(percent),
        "--cwd",
        ctx.cwd,
        "--",
        "nu",
        "-e",
        cmd,
      ],
      (err, stdout) => {
        if (err)
          return ctx.ui.notify(`wezterm: ${err.message}${onErr}`, "error");
        const pane = (lastPane = stdout.trim()); // split-pane prints the new pane id
        ctx.ui.notify(onOk(pane), "info");
      },
    );

  // /wez-split [command...]  -> right split in same cwd (default: pi)
  pi.registerCommand("wez-split", {
    description: "Open a WezTerm split pane (default: pi)",
    handler: async (args: string, ctx: any) => {
      const cmd = args?.trim() ? args.trim().split(/\s+/).join(" ") : "pi";
      split(ctx, cmd, 40, (p) => `Split opened (pane ${p}). Use /wez-read`);
    },
  });

  // /wez-fork [prompt]  -> copy this session's current branch to a new session file
  // and open it in a right split (adapted from mitsuhiko/agent-stuff split-fork.ts)
  pi.registerCommand("wez-fork", {
    description:
      "Fork this session into a WezTerm split. Usage: /wez-fork [prompt]",
    handler: async (args: string, ctx: any) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile)
        return ctx.ui.notify("No persisted session to fork", "warning");
      const header = ctx.sessionManager.getHeader();
      const now = new Date().toISOString();
      const id = randomUUID();
      const file = join(
        dirname(sessionFile),
        `${now.replace(/[:.]/g, "-")}_${id}.jsonl`,
      );
      const lines = [
        {
          type: "session",
          version: header?.version ?? 3,
          id,
          timestamp: now,
          cwd: header?.cwd ?? ctx.cwd,
          parentSession: sessionFile,
        },
        ...ctx.sessionManager.getBranch(),
      ].map((e) => JSON.stringify(e));
      await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");

      // JSON strings are valid nu double-quoted strings.
      // shortcut: control chars become JSON \uXXXX escapes nu may reject; write a nu escaper if prompts need them
      const q = (v: string) => JSON.stringify(v);
      const prompt = (args ?? "").trim();
      const cmd = `pi --session ${q(file)}${prompt ? ` -- ${q(prompt)}` : ""}`;
      split(
        ctx,
        cmd,
        50,
        (p) => `Forked to ${basename(file)} (pane ${p})`,
        ` (fork saved: ${file})`,
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
