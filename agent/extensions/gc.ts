import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// /gc: have Pi draft a commit message from the staged diff and commit it after you approve.
export default function (pi: ExtensionAPI) {
	pi.registerCommand("gc", {
		description: "Draft a commit message from the staged diff and commit",
		handler: async (_args, ctx) => {
			const { stdout, code } = await pi.exec("git", ["diff", "--staged"]);
			if (code !== 0 || !stdout.trim()) {
				ctx.ui.notify("Nothing staged", "warning");
				return;
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
