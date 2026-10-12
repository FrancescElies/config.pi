import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// execFile (no shell) so arguments can't inject commands; no force-push option exists.
const git = (cwd: string, args: string[], signal?: AbortSignal) =>
	new Promise<string>((resolve) =>
		execFile("git", args, { cwd, signal, maxBuffer: 10 << 20 }, (err, out, errOut) =>
			resolve(`${out}${errOut}${err ? `\n[exit: ${err.message}]` : ""}`.trim() || "(no output)"),
		),
	);

const gitTool = defineTool({
	name: "git",
	label: "Git",
	description: "Run git log, commit or push in the current repo. Commit only commits what is already staged unless all=true (git add -A first). Push never forces.",
	parameters: Type.Object({
		action: Type.Union([Type.Literal("log"), Type.Literal("commit"), Type.Literal("push")]),
		count: Type.Optional(Type.Number({ description: "log: number of commits (default 10)" })),
		message: Type.Optional(Type.String({ description: "commit: message (required)" })),
		all: Type.Optional(Type.Boolean({ description: "commit: stage everything first (default false)" })),
	}),

	async execute(_id, p, signal, _onUpdate, ctx) {
		let text: string;
		if (p.action === "log") {
			const n = Math.max(1, Math.min(200, Math.floor(p.count ?? 10)));
			text = await git(ctx.cwd, ["log", "--oneline", "--decorate", `-n${n}`], signal);
		} else if (p.action === "commit") {
			if (!p.message?.trim()) throw new Error("commit requires a message");
			if (p.all) await git(ctx.cwd, ["add", "-A"], signal);
			text = await git(ctx.cwd, ["commit", "-m", p.message], signal);
		} else {
			text = await git(ctx.cwd, ["push"], signal);
		}
		return { content: [{ type: "text", text }], details: { action: p.action } };
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(gitTool);
}
