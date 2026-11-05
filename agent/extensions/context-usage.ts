import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Skills with `disable-model-invocation: true` (not in the prompt), found by scanning the skill roots.
function disabledSkills(): [string, number][] {
  const root = join(homedir(), ".pi", "agent");
  const out: [string, number][] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git")
        walk(join(dir, e.name), depth + 1);
      else if (e.name === "SKILL.md") {
        const fm =
          readFileSync(join(dir, e.name), "utf8").split(/^---\s*$/m)[1] ?? "";
        if (/^disable-model-invocation:\s*true/m.test(fm))
          out.push([
            dir.replaceAll(String.fromCharCode(92), "/").split("/").pop()!,
            (fm.match(/^description:.*$/m)?.[0].length ?? 0) + 150,
          ]);
      }
    }
  };
  for (const r of [
    "skills",
    "pi-hermes-memory/skills",
    "git",
    "npm/node_modules",
  ])
    walk(join(root, r), 0);
  return out;
}

// ponytail: char-based estimate scaled to real usage tokens so percentages are
// accurate even though per-category tokens are approximate. Real total comes
// from ctx.getContextUsage() (last assistant usage). Falls back to ~4 chars/token
// before the first response.

const fmt = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;

function bar(pct: number, w = 20): string {
  const f = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return "█".repeat(f) + "░".repeat(w - f);
}

function categorize(messages: any[]): Record<string, number> {
  const cats: Record<string, number> = {
    "system-prompt": 0,
    user: 0,
    assistant: 0,
    thinking: 0,
    "tool-call": 0,
    "tool-result": 0,
    image: 0,
  };
  for (const m of messages) {
    const role: string = m.role ?? "";
    const content = m.content;
    if (typeof content === "string") {
      cats[
        role === "user"
          ? "user"
          : role === "system"
            ? "system-prompt"
            : "assistant"
      ] += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      switch (b?.type) {
        case "text":
          cats[
            role === "user"
              ? "user"
              : role === "system"
                ? "system-prompt"
                : "assistant"
          ] += (b.text ?? "").length;
          break;
        case "thinking":
          cats["thinking"] += (b.text ?? "").length;
          break;
        case "toolCall":
          cats["tool-call"] +=
            (b.name ?? "").length + JSON.stringify(b.arguments ?? {}).length;
          break;
        case "toolResult":
          if (Array.isArray(b.content)) {
            for (const c of b.content) {
              if (c?.type === "text")
                cats["tool-result"] += (c.text ?? "").length;
              else if (c?.type === "image") cats["image"] += 850;
            }
          }
          break;
        case "image":
          cats["image"] += 850;
          break;
      }
    }
  }
  return cats;
}

export default function (pi: ExtensionAPI) {
  function report(ctx: any): string[] {
    const usage = ctx.getContextUsage();
    const total: number = usage?.tokens ?? 0;
    const window: number = ctx.model?.contextWindow ?? 0;
    const sysPrompt: string = ctx.getSystemPrompt() ?? "";
    const msgs: any[] = ctx.sessionManager.getBranch() ?? [];
    const cats = categorize(msgs);
    cats["system-prompt"] += sysPrompt.length;
    const totalChars = Object.values(cats).reduce((a, b) => a + b, 0) || 1;
    const scale = total > 0 ? total / totalChars : 0.25;
    const pct = window > 0 ? (total / window) * 100 : 0;

    const lines: string[] = [];
    lines.push(
      `Context  ${fmt(total)} / ${fmt(window)} tokens  (${pct.toFixed(1)}%)`,
    );
    lines.push(bar(pct, 40));
    lines.push("");
    lines.push("Breakdown (estimated, scaled to real usage):");
    const entries = Object.entries(cats)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [name, chars] of entries) {
      const toks = Math.round(chars * scale);
      const p = total > 0 ? (toks / total) * 100 : 0;
      lines.push(
        `  ${name.padEnd(14)} ${fmt(toks).padStart(7)}  ${p.toFixed(1).padStart(5)}%  ${bar(p, 16)}`,
      );
    }
    // ---- where the system prompt / tools / loaded skills go (same char->token scale) ----
    const tk = (chars: number) =>
      `${fmt(Math.round(chars * scale)).padStart(7)}  ${(total > 0 ? ((chars * scale) / total) * 100 : 0).toFixed(1).padStart(5)}%`;
    // "✎ how" = you can change this; no mark = comes from pi itself
    // enabled/disabled label: italic + colour (plain when there is no theme)
    const theme = ctx.ui?.theme;
    const pastel = (on: boolean, t: string) =>
      `[38;2;${on ? "152;225;152" : "255;150;150"}m${t}[39m`;
    const state = (on: boolean) => {
      const t = on ? "enabled" : "disabled";
      return theme ? pastel(on, `[3m${t}[23m`) : t;
    };
    // name gets the same pastel colour as the label
    const dim = (on: boolean) => (t: string) => (theme ? pastel(on, t) : t);
    type Row = [string, number, string?, ((t: string) => string)?];
    const section = (title: string, rows: Row[], max = 12) => {
      if (!rows.length) return;
      lines.push("", title);
      rows.sort((a, b) => b[1] - a[1]);
      for (const [n, c, h, paint] of rows.slice(0, max)) {
        const name = n.slice(0, 40).padEnd(40);
        lines.push(
          `  ${paint ? paint(name) : name} ${tk(c)}${h ? `  ✎ ${h}` : ""}`,
        );
      }
      if (rows.length > max)
        lines.push(
          `  … ${rows.length - max} more (${tk(rows.slice(max).reduce((a, r) => a + r[1], 0)).trim()})`,
        );
    };
    // top-level <tag>…</tag> blocks of the system prompt; <skills> is split per skill below
    const BLOCK_HINT: Record<string, string> = {
      available_skills: "skills/: disable-model-invocation or delete",
      skills: "skills/: disable-model-invocation or delete",
      project_instructions: "AGENTS.md",
      mcp_servers: "mcp.json",
      ponytail: "/ponytail level, or 'stop ponytail'",
    };
    const blocks: [string, number, string?][] = [];
    let rest = sysPrompt;
    for (const m of sysPrompt.matchAll(/<(\w+)>[\s\S]*?<\/\1>/g)) {
      if (m[1] !== "skill")
        blocks.push([`<${m[1]}>`, m[0].length, BLOCK_HINT[m[1]]]);
      rest = rest.replace(m[0], "");
    }
    blocks.push(["(other prompt text)", rest.length]);
    section("System prompt by section:", blocks);
    const enabledSkills: Row[] = [
      ...sysPrompt.matchAll(/<skill>([\s\S]*?)<\/skill>/g),
    ].map((m) => [
      m[1].match(/<name>(.*?)<\/name>/)?.[1] ?? "?",
      m[0].length,
      state(true),
      dim(true),
    ]);
    const offSkills: Row[] = disabledSkills().map(([n, c]) => [
      n,
      c,
      state(false),
      dim(false),
    ]);
    section(
      `Skills (${enabledSkills.length} enabled, ${offSkills.length} disabled; disabled size = what you save)`,
      [...enabledSkills, ...offSkills],
      40,
    );
    // tool declarations are sent next to the prompt: estimate from name+description+schema
    const active = new Set(pi.getActiveTools());
    const allTools = pi.getAllTools() as any[];
    const toolRows: Row[] = allTools.map((t) => [
      t.name,
      JSON.stringify({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }).length,
      state(active.has(t.name)),
      dim(active.has(t.name)),
    ]);
    section(
      `Tools (${toolRows.filter((r) => active.has(r[0])).length} enabled, ${toolRows.filter((r) => !active.has(r[0])).length} disabled; sizes are estimates, disabled = what you save)`,
      toolRows,
      40,
    );
    // SKILL.md files actually read into the conversation
    const paths = new Map<string, string>();
    const loaded = new Map<string, number>();
    for (const e of msgs) {
      const m = e.message ?? e;
      if (m.role === "assistant" && Array.isArray(m.content))
        for (const b of m.content)
          if (
            b?.type === "toolCall" &&
            b.name === "read" &&
            /SKILL\.md$/i.test(String(b.arguments?.path ?? ""))
          )
            paths.set(b.id, String(b.arguments.path));
      if (m.role === "toolResult" && paths.has(m.toolCallId)) {
        const n = (Array.isArray(m.content) ? m.content : []).reduce(
          (a: number, c: any) => a + (c?.text?.length ?? 0),
          0,
        );
        const name = paths
          .get(m.toolCallId)!
          .replaceAll(String.fromCharCode(92), "/")
          .split("/")
          .slice(-2)[0];
        loaded.set(name, (loaded.get(name) ?? 0) + n);
      }
    }
    section(
      "Skills loaded into this conversation (SKILL.md reads):",
      [...loaded].map(([n, c]): [string, number, string] => [
        n,
        c,
        "only loads when read",
      ]),
    );
    lines.push(
      "",
      "✎ = you can change it (hint says how). Unmarked = comes from pi. Your messages and tool results: ask for less output / smaller reads.",
    );
    if (total === 0)
      lines.push("", "(Send a message to get real token counts.)");
    lines.push("", "esc/enter/q to close");
    return lines;
  }

  function updateStatus(ctx: any) {
    if (!ctx.hasUI) return;
    const usage = ctx.getContextUsage();
    const total: number = usage?.tokens ?? 0;
    const window: number = ctx.model?.contextWindow ?? 0;
    if (window > 0) {
      const p = (total / window) * 100;
      const color = p > 80 ? "error" : p > 50 ? "warning" : "success";
      ctx.ui.setStatus(
        "context-usage",
        ctx.ui.theme.fg(
          color,
          `ctx ${fmt(total)}/${fmt(window)} ${p.toFixed(0)}%`,
        ),
      );
    } else {
      ctx.ui.setStatus("context-usage", undefined);
    }
  }

  pi.on("turn_end", async (_e, ctx) => updateStatus(ctx));
  pi.on("session_start", async (_e, ctx) => updateStatus(ctx));
  pi.on("model_select", async (_e, ctx) => updateStatus(ctx));
  pi.on("session_shutdown", async (_e, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("context-usage", undefined);
  });

  pi.registerCommand("context", {
    description: "Show context usage and breakdown by category",
    handler: async (_args, ctx) => {
      const lines = report(ctx);
      if (ctx.mode !== "tui") {
        for (const l of lines) console.log(l);
        return;
      }
      await ctx.ui.custom<void>((_tui, _theme, _kb, done) => ({
        render: (w: number) =>
          lines.map((l) => (l.length > w ? l.slice(0, w) : l)),
        invalidate: () => {},
        handleInput: (data: string) => {
          if (data === "\x1b" || data === "\r" || data === "q") done();
        },
      }));
    },
  });
}
