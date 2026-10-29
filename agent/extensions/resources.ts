import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, dirname } from "node:path";

// /resources: the loaded-resource listing that pi prints at startup when quietStartup is false.
// shortcut: the extension API has no list of loaded extensions, so [Extensions] only shows extensions
// that register a command or tool (event-only ones such as pid-status are missing); upgrade if pi
// exposes the resource loader to extensions.

type Src = { path: string; source: string; origin: string; scope: string };

function extensionLabel(s: Src): string {
	if (s.origin === "package") return s.source.replace(/^(npm|git):/, "").replace(/@[0-9a-f]{7,}$|@[\d.]+$/, "");
	const file = basename(s.path);
	return /^index\.[jt]s$/.test(file) ? basename(dirname(s.path)) : file.replace(/\.[jt]s$/, "");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("resources", {
		description: "Show loaded context files, skills, prompts and extensions (the quietStartup: false listing)",
		handler: async (_args, ctx) => {
			const options = ctx.getSystemPromptOptions();
			const commands = pi.getCommands();
			const extSources: Src[] = [
				...commands.filter((c) => c.source === "extension").map((c) => c.sourceInfo),
				...pi.getAllTools().map((t) => t.sourceInfo),
			].filter((s) => s && !s.path.startsWith("builtin:") && !s.path.startsWith("<"));

			const sorted = (items: string[]) => [...new Set(items)].sort((a, b) => a.localeCompare(b));
			const sections: Array<[string, string[]]> = [
				["Context", (options.contextFiles ?? []).map((f) => f.path)],
				["Skills", sorted((options.skills ?? []).map((s) => s.name))],
				["Prompts", sorted(commands.filter((c) => c.source === "prompt").map((c) => `/${c.name}`))],
				["Extensions (global)", sorted(extSources.filter((s) => s.scope !== "project").map(extensionLabel))],
				["Extensions (project)", sorted(extSources.filter((s) => s.scope === "project").map(extensionLabel))],
			];

			const th = ctx.hasUI ? ctx.ui.theme : undefined;
			const head = (s: string) => (th ? th.fg("mdHeading", s) : s);
			const dim = (s: string) => (th ? th.fg("dim", s) : s);
			const text = sections
				.filter(([, items]) => items.length > 0)
				.map(([name, items]) => `${head(`[${name}]`)}\n${dim(`  ${items.join(name === "Context" ? "\n  " : ", ")}`)}`)
				.join("\n\n");

			if (ctx.hasUI) ctx.ui.notify(text, "info");
			else console.log(text);
		},
	});
}
