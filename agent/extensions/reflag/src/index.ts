import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { rewriteBash } from "./shell.js";

export default function piReflag(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    const original = event.input.command;
    const rewritten = await rewriteBash(original, "auto");
    if (rewritten !== original) {
      pi.sendMessage(
        { customType: "reflag", content: `reflag: ${original}  →  ${rewritten}`, display: true },
        { triggerTurn: false },
      );
    }
    event.input.command = rewritten;
    return undefined;
  });
}