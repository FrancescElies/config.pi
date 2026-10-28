import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { rewriteBash } from "./shell.js";

export default function piReflag(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (!isToolCallEventType("bash", event)) return undefined;
    event.input.command = await rewriteBash(event.input.command, "auto");
    return undefined;
  });
}
