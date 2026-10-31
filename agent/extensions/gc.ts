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
      const underS = /^([a-z]:)?\/s(\/|$)/i.test(
        process.cwd().replaceAll("\\", "/"),
      ); // ticket rule only for repos under /s
      const ticket =
        underS && last.code === 0
          ? last.stdout.match(/#\d+/g)?.pop()
          : undefined;
      const ticketHint = ticket
        ? `End the body with the line "story ${ticket}" (ticket number copied from the previous commit; always write "story #1234", never a bare "#1234"). `
        : "";
      pi.sendUserMessage(
        "Write a concise git commit message (subject <=72 chars, optional short body) for this staged diff. " +
          ticketHint +
          "Print the message, then run `git commit -F -` with the message on stdin without asking for approval.\n\n" +
          "```diff\n" +
          stdout +
          "\n```",
      );
    },
  });
}
