// Intercepts bash tool calls using GNU grep/find and rewrites them to rg/fd.
// Fail-open.

import type { BashToolCallEvent, ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent"

function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash"
}

function rewriteGrepToRg(cmd: string): string {
  let out = cmd
  out = out.replace(/--include=(\S+)/g, "-g $1")
  out = out.replace(/--exclude=(\S+)/g, "-g '!$1'")
  out = out.replace(/--exclude-dir=(\S+)/g, "-g '!$1/**'")
  out = out.replace(/(^|\s)-([A-Za-z]+)E([A-Za-z]*)/g, (_m, pre, a, b) => `${pre}-${a}${b}`.replace(/-$/, ""))
  out = out.replace(/(^|\s)-([A-Za-z]*)r([A-Za-z]*)/gi, (_m, pre, a, b) => {
    const flags = `${a}${b}`
    return flags ? `${pre}-${flags}` : pre
  })
  out = out.replace(/(^|\s)-([A-Za-z]*)R([A-Za-z]*)/g, (_m, pre, a, b) => {
    const flags = `${a}${b}`
    return flags ? `${pre}-${flags}` : pre
  })
  out = out.replace(/\bgrep\b/g, "rg")
  return out
}

function rewriteFindToFd(cmd: string): string {
  const m = cmd.match(/^(\s*)find\s+(\S+)(?:\s+-name\s+(\S+))?(?:\s+-type\s+([fd]))?/)
  if (m) {
    const [, pre, pathArg, namePat, typeChar] = m
    let rest = cmd.slice(m[0].length)
  // Additional common find flags.
  rest = rest.replace(/-maxdepth\s+(\d+)/g, "--max-depth $1")
  rest = rest.replace(/-iname\s+(\S+)/g, "-i $1")
  rest = rest.replace(/-path\s+(\S+)/g, "-p $1")
    const typeFlag = typeChar ? `-t ${typeChar} ` : ""
    const pat = namePat ?? ""
    const pathPart = pathArg && pathArg !== "." ? ` ${pathArg}` : ""
    return `${pre}fd ${typeFlag}${pat}${pathPart}${rest}`
  }
  const m2 = cmd.match(/^(\s*)find\s+-name\s+(\S+)(?:\s+-type\s+([fd]))?/)
  if (m2) {
    const [, pre, namePat, typeChar] = m2
    const rest = cmd.slice(m2[0].length)
    const typeFlag = typeChar ? `-t ${typeChar} ` : ""
    return `${pre}fd ${typeFlag}${namePat}${rest}`
  }
  return cmd.replace(/\bfind\b/, "fd")
}

export default async function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    try {
      if (!isBashToolCallEvent(event)) return
      const cmd = event.input.command
      if (typeof cmd !== "string" || cmd.trim() === "") return
      // Only act when grep/find appear as commands at a shell segment boundary.
      if (!/(^|\n|[;|&]{1,2})\s*(?:\S+\/)?(grep|find)\b/m.test(cmd)) return
      let rewritten = cmd
      if (/\bgrep\b/.test(cmd)) rewritten = rewriteGrepToRg(rewritten)
      if (/\bfind\b/.test(cmd)) rewritten = rewriteFindToFd(rewritten)
      if (rewritten && rewritten !== cmd) {
        event.input.command = rewritten
      }
    } catch (err) {
      console.warn("[search-tools-rewrite] unexpected error; passing through", err)
    }
  })
}
