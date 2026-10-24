import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// /gc: have Pi draft a commit message from the staged diff and commit it after you approve.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("gc", {
		description: "Draft a commit message from the staged diff and commit",
		handler: async (_args, ctx) => {
			let { stdout, code } = await pi.exec("git", ["diff", "--staged"]);
			if (code !== 0) {
				ctx.ui.notify("git diff failed", "error");
				return;
			}
			if (!stdout.trim()) {
				const answer = await ctx.ui.input(
					"Nothing staged. What should be staged?",
					"files/paths/glob, or 'all' (default: all)",
				);
				if (answer === undefined) return;
				const spec = (answer ?? "").trim() || "all";
				const addArgs = spec.toLowerCase() === "all" ? ["add", "-A"] : ["add", ...spec.split(/\s+/).filter(Boolean)];
				const add = await pi.exec("git", addArgs);
				if (add.code !== 0) {
					ctx.ui.notify(add.stderr || "git add failed", "error");
					return;
				}
				const r2 = await pi.exec("git", ["diff", "--staged"]);
				stdout = r2.stdout;
				code = r2.code;
				if (code !== 0 || !stdout.trim()) {
					ctx.ui.notify("Nothing staged", "warning");
					return;
				}
			}
			// The commit hook demands a ticket: reuse the #number of the previous commit if it has one.
			const last = await pi.exec("git", ["log", "-1", "--format=%B"]);
			const ticket = last.code === 0 ? last.stdout.match(/#\d+/g)?.pop() : undefined;
			const ticketHint = ticket
				? `End the body with the line "Related work items: ${ticket}" (copied from the previous commit). `
				: "";
			pi.sendUserMessage(
				"Write a concise git commit message (subject <=72 chars, optional short body) for this staged diff. " +
					ticketHint +
					"Show it to me and ask for approval; only after I approve, run `git commit -F -` with the message on stdin.\n\n" +
					"```diff\n" + stdout + "\n```",
			);
		},
	});
}
