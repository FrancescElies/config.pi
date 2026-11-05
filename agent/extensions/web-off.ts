/** Keeps the pi-web-access tools out of the model's context until `/web on` (their declarations are large).
 *  pi-web-access re-activates its tools on session_start/session_tree (toolActivation "auto" = eager for this model),
 *  so we re-apply "off" before every agent run instead of only once. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WEB = ["web_search", "source_check", "fetch_content", "get_search_content"];

export default function (pi: ExtensionAPI) {
	let on = false;
	const apply = () => {
		const active = pi.getActiveTools();
		const has = WEB.some((t) => active.includes(t));
		if (on === has && (on ? WEB.every((t) => active.includes(t)) : true)) return;
		const rest = active.filter((t) => !WEB.includes(t));
		pi.setActiveTools(on ? [...rest, ...WEB] : rest);
	};
	for (const ev of ["session_start", "session_tree", "before_agent_start"] as const) pi.on(ev, () => apply());
	pi.registerCommand("web", {
		description: "Web tools (web_search, source_check, fetch_content, get_search_content): 'on' or 'off'",
		getArgumentCompletions: (p) => ["on", "off"].filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			const a = args.trim();
			if (a !== "on" && a !== "off") return ctx.ui.notify("usage: /web on|off", "info");
			on = a === "on";
			apply();
			ctx.ui.notify(`web tools ${a}`, "info");
		},
	});
}
