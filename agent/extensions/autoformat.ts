import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extname, resolve } from "node:path";

// Ranges are "changed lines" [start,end] (1-based) from git diff; null = format whole file.
type Fmt = (f: string, r: [number, number][] | null) => [string, string[]][];

const clang: Fmt = (f, r) => [
  [
    "clang-format",
    ["-i", ...(r ?? []).map(([a, b]) => `--lines=${a}:${b}`), f],
  ],
];
const FORMATTERS: Record<string, Fmt> = {
  ".py": (f, r) => [
    [
      "ruff",
      ["format", ...(r ? r.map(([a, b]) => `--range=${a}-${b}`) : []), f],
    ],
  ],
  // shortcut: rustfmt --file-lines is nightly-only, so whole file; upgrade if nightly is acceptable.
  ".rs": (f) => [["rustfmt", ["--edition", "2021", f]]],
  ".lua": (f) => [["stylua", [f]]], // whole file only; stylua --range is byte-offset based
  ".zig": (f) => [["zig", ["fmt", f]]], // whole file only
  // shortcut: dotnet format whitespace has no line ranges, whole file.
  ".cs": (f) => [
    ["dotnet", ["format", "whitespace", "--folder", "--include", f]],
  ],
  ".c": clang,
  ".h": clang,
  ".cpp": clang,
  ".cc": clang,
  ".cxx": clang,
  ".hpp": clang,
  ".hh": clang,
  ".hxx": clang,
};

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (
      event.isError ||
      (event.toolName !== "edit" && event.toolName !== "write")
    )
      return;
    const p = event.input.path;
    if (typeof p !== "string") return;
    const fmt = FORMATTERS[extname(p).toLowerCase()];
    if (!fmt) return;
    const file = resolve(ctx.cwd, p.replace(/^@/, ""));

    // Only changed lines vs HEAD; untracked/new/unknown -> whole file. Whole-file write is fine for new files.
    let ranges: [number, number][] | null = null;
    const tracked = await pi.exec(
      "git",
      ["ls-files", "--error-unmatch", file],
      { cwd: ctx.cwd },
    );
    if (tracked.code === 0) {
      const d = await pi.exec("git", ["diff", "-U0", "HEAD", "--", file], {
        cwd: ctx.cwd,
      });
      if (d.code === 0) {
        ranges = [...d.stdout.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)]
          .map(
            (m) =>
              [Number(m[1]), Number(m[1]) + Number(m[2] ?? 1) - 1] as [
                number,
                number,
              ],
          )
          .filter(([a, b]) => b >= a);
        if (ranges.length === 0) return; // nothing changed
      }
    }
    // ruff accepts a single --range: collapse to one covering span.
    if (ranges && extname(file) === ".py")
      ranges = [[ranges[0][0], ranges[ranges.length - 1][1]]];

    for (const [cmd, args] of fmt(file, ranges)) {
      const r = await pi
        .exec(cmd, args, { cwd: ctx.cwd, timeout: 30000 })
        .catch(() => null);
      if (r && r.code !== 0 && ctx.hasUI)
        ctx.ui.notify(`${cmd} failed: ${r.stderr.slice(0, 200)}`, "warning");
    }
  });
}
