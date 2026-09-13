import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const ATTACH_FLAG = "attach-subagent";
const CHILD_ENV = "PI_WEZTERM_SUBAGENT_CHILD";
const RESULT_ENV = "PI_WEZTERM_SUBAGENT_RESULT";
const RUNS_DIR = "wezterm-subagents";
const POLL_INTERVAL_MS = 500;
const PANE_PREVIEW_LINES = 18;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const EXTENSION_PATH = fileURLToPath(import.meta.url);

type RunStatus = "queued" | "running" | "completed" | "failed";

interface ChildResult {
  version: 1;
  status: "completed" | "failed";
  output: string;
  error?: string;
  stopReason?: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  finishedAt: number;
}

interface RunDetails {
  status: RunStatus;
  task: string;
  cwd: string;
  paneId: string;
  attachCommand: string;
  captureCommand: string;
  killCommand: string;
  provider: string;
  model: string;
  thinking: string;
  pane?: string;
  output?: string;
  sessionFile?: string;
  startedAt?: number;
  finishedAt?: number;
}

interface RunSpec {
  task: string;
  cwd: string;
  attachmentId: string;
  paneId: string;
  attachCommand: string;
  captureCommand: string;
  killCommand: string;
  provider: string;
  model: string;
  thinking: string;
  trusted: boolean;
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function updateWeztermCommands(spec: RunSpec): void {
  spec.attachCommand = `pi --${ATTACH_FLAG} ${shellQuote(spec.paneId)}`;
  spec.captureCommand = `wezterm cli get-text --pane-id ${shellQuote(spec.paneId)}`;
  spec.killCommand = `wezterm cli kill-pane --pane-id ${shellQuote(spec.paneId)}`;
}

function attachToSubagentAndExit(rawTarget: string): never {
  const paneId = rawTarget.trim();
  if (!paneId || !/^\d+$/.test(paneId)) {
    console.error(
      `Error: --${ATTACH_FLAG} requires a valid pane id printed by the subagent tool.`,
    );
    process.exit(2);
  }

  const result = spawnSync(
    "wezterm",
    ["cli", "activate-pane", "--pane-id", paneId],
    { stdio: "inherit", env: process.env },
  );

  if (result.error) {
    console.error(`Failed to activate WezTerm pane: ${result.error.message}`);
  }
  process.exit(result.status ?? 0);
}

function getPiInvocationParts(): string[] {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return [process.execPath, currentScript];
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return [process.execPath];
  }

  return ["pi"];
}

function textFromAssistant(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(
        part &&
          typeof part === "object" &&
          part.type === "text" &&
          typeof part.text === "string",
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function findLastAssistant(
  ctx: ExtensionContext,
): Record<string, unknown> | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as Record<string, unknown>;
    if (message.role === "assistant") return message;
  }
  return undefined;
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

function registerChildReporter(pi: ExtensionAPI, resultPath: string): void {
  let reported = false;

  const report = async (
    ctx: ExtensionContext,
    fallbackError?: string,
  ): Promise<void> => {
    if (reported) return;
    reported = true;

    const assistant = findLastAssistant(ctx);
    const stopReason =
      typeof assistant?.stopReason === "string"
        ? assistant.stopReason
        : undefined;
    const assistantError =
      typeof assistant?.errorMessage === "string"
        ? assistant.errorMessage
        : undefined;
    const failed =
      !assistant ||
      stopReason === "error" ||
      stopReason === "aborted" ||
      Boolean(fallbackError);
    const output = assistant ? textFromAssistant(assistant) : "";
    const result: ChildResult = {
      version: 1,
      status: failed ? "failed" : "completed",
      output,
      error:
        fallbackError ??
        assistantError ??
        (!assistant
          ? "Subagent exited without an assistant response."
          : undefined),
      stopReason,
      sessionFile: ctx.sessionManager.getSessionFile(),
      provider:
        typeof assistant?.provider === "string"
          ? assistant.provider
          : ctx.model?.provider,
      model:
        typeof assistant?.model === "string" ? assistant.model : ctx.model?.id,
      thinking: pi.getThinkingLevel(),
      finishedAt: Date.now(),
    };

    try {
      await writeJsonAtomic(resultPath, result);
    } catch (error) {
      console.error(
        `[wezterm-subagent] Failed to write result: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  (
    pi.on as unknown as (
      event: "agent_settled",
      handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
    ) => void
  )("agent_settled", async (_event, ctx) => {
    await report(ctx);
    ctx.shutdown();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!reported)
      await report(ctx, "Subagent session shut down before the task settled.");
  });
}

function trimPane(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n");
  while (lines.length > 0 && !lines[0]?.trim()) lines.shift();
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.slice(-PANE_PREVIEW_LINES).join("\n");
}

function formatDuration(
  startedAt: number | undefined,
  finishedAt = Date.now(),
): string | undefined {
  if (startedAt === undefined) return undefined;
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function detailsFor(
  spec: RunSpec,
  status: RunStatus,
  extra: Partial<RunDetails> = {},
): RunDetails {
  return {
    status,
    task: spec.task,
    cwd: spec.cwd,
    paneId: spec.paneId,
    attachCommand: spec.attachCommand,
    captureCommand: spec.captureCommand,
    killCommand: spec.killCommand,
    provider: spec.provider,
    model: spec.model,
    thinking: spec.thinking,
    ...extra,
  };
}

function partialText(details: RunDetails): string {
  const lines = [
    `Subagent ${details.status} in WezTerm pane ${details.paneId}.`,
    `Attach: ${details.attachCommand}`,
    `Capture: ${details.captureCommand}`,
  ];
  if (details.pane) lines.push("", details.pane);
  return lines.join("\n");
}

function truncateToolText(text: string): string {
  const truncated = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n\n[Output truncated. Full output is available in the child session file.]`;
}

function resultText(details: RunDetails): string {
  const duration = formatDuration(details.startedAt, details.finishedAt);
  const lines = [
    `Subagent ${details.status}${duration ? ` after ${duration}` : ""}.`,
    `Model: ${details.provider}/${details.model} (${details.thinking})`,
    `WezTerm Pane: ${details.paneId}`,
    `Attach: ${details.attachCommand}`,
    `Capture: ${details.captureCommand}`,
    `Clean up: ${details.killCommand}`,
  ];
  if (details.sessionFile) lines.push(`Child session: ${details.sessionFile}`);
  if (details.output) lines.push("", details.output);
  return truncateToolText(lines.join("\n"));
}

async function abortableDelay(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) throw new Error("Subagent aborted.");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("Subagent aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function validateCwd(cwd: string): Promise<void> {
  let info;
  try {
    info = await stat(cwd);
  } catch {
    throw new Error(`Subagent working directory does not exist: ${cwd}`);
  }
  if (!info.isDirectory())
    throw new Error(`Subagent working directory is not a directory: ${cwd}`);
}

function isSameOrDescendant(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function resolveModel(
  ctx: ExtensionContext,
  providerOverride: string | undefined,
  modelOverride: string | undefined,
): { provider: string; model: string } {
  const explicitProvider = providerOverride?.trim();
  const explicitModel = modelOverride?.trim();
  let provider = explicitProvider || ctx.model?.provider || "";
  let model = explicitModel || ctx.model?.id || "";

  const slashIndex = explicitModel?.indexOf("/") ?? -1;
  if (explicitModel && slashIndex > 0) {
    const modelProvider = explicitModel.slice(0, slashIndex);
    if (!explicitProvider) {
      provider = modelProvider;
      model = explicitModel.slice(slashIndex + 1);
    } else if (explicitProvider === modelProvider) {
      model = explicitModel.slice(slashIndex + 1);
    }
  }

  if (!provider || !model) {
    throw new Error(
      "No model is active. Pass both provider and model to the subagent tool.",
    );
  }
  return { provider, model };
}

export default function subagentExtension(pi: ExtensionAPI): void {
  pi.registerFlag(ATTACH_FLAG, {
    description: "Attach using the pane id printed by the subagent tool",
    type: "string",
  });
  const attachTarget = attachFlagValue(process.argv);
  if (attachTarget !== undefined) attachToSubagentAndExit(attachTarget);

  if (process.env[CHILD_ENV] === "1") {
    const resultPath = process.env[RESULT_ENV];
    if (!resultPath) {
      console.error(
        `[wezterm-subagent] ${RESULT_ENV} is required in child mode.`,
      );
      return;
    }
    registerChildReporter(pi, resultPath);
    return;
  }

  let queueTail: Promise<void> = Promise.resolve();
  let queueDepth = 0;
  let activePaneId: string | undefined;

  const withSerialExecution = async <T>(
    signal: AbortSignal | undefined,
    onQueued: () => void,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const queued = queueDepth > 0;
    queueDepth++;
    const previous = queueTail;
    let release!: () => void;
    queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (queued) onQueued();

    try {
      await previous;
      if (signal?.aborted)
        throw new Error("Subagent aborted while waiting in the serial queue.");
      return await fn();
    } finally {
      queueDepth--;
      release();
    }
  };

  pi.on("session_shutdown", async () => {
    if (!activePaneId) return;
    await pi.exec("wezterm", ["cli", "kill-pane", "--pane-id", activePaneId]);
    activePaneId = undefined;
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one delegated task in a separate interactive Pi process inside a WezTerm window. Calls are serialized: only one child works at a time, even if several calls are requested together. The child inherits the current provider, model, and thinking level unless overridden. Live pane output and a copy/paste pi --attach-subagent command are shown while it runs. Output is capped at 50KB or 2000 lines; the complete child session is preserved on disk.",
    promptSnippet:
      "Run one delegated task in an observable, WezTerm-backed Pi session",
    promptGuidelines: [
      "Use subagent once per delegated task; subagent calls are serialized automatically, so prefer multiple simple calls over asking one child to orchestrate other children.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The complete task for the child Pi process",
      }),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory. Defaults to the current project.",
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description: "Provider override. Defaults to the current provider.",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model id or provider/model override. Defaults to the current model.",
        }),
      ),
      thinking: Type.Optional(
        StringEnum(THINKING_LEVELS, {
          description:
            "Thinking level override. Defaults to the current thinking level.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!params.task.trim())
        throw new Error("Subagent task must not be empty.");
      const cwd = path.resolve(ctx.cwd, params.cwd?.trim() || ".");
      const selectedModel = resolveModel(ctx, params.provider, params.model);
      const thinking = params.thinking ?? pi.getThinkingLevel();
      const childSessionId = randomUUID();
      const runDir = path.join(
        getAgentDir(),
        RUNS_DIR,
        ctx.sessionManager.getSessionId(),
        childSessionId,
      );
      const resultPath = path.join(runDir, "result.json");

      const spec: RunSpec = {
        task: params.task,
        cwd,
        attachmentId: childSessionId,
        paneId: "",
        attachCommand: "",
        captureCommand: "",
        killCommand: "",
        provider: selectedModel.provider,
        model: selectedModel.model,
        thinking,
        trusted:
          isSameOrDescendant(path.resolve(ctx.cwd), cwd) &&
          ctx.isProjectTrusted(),
      };

      return withSerialExecution(
        signal,
        () => {
          const details = detailsFor(spec, "queued");
          onUpdate?.({
            content: [
              {
                type: "text",
                text: "Waiting for the active subagent to finish...",
              },
            ],
            details,
          });
        },
        async () => {
          await validateCwd(cwd);
          await mkdir(runDir, { recursive: true, mode: 0o700 });
          const promptPath = path.join(runDir, "task.md");
          const sessionDir = path.join(runDir, "session");
          await mkdir(sessionDir, { recursive: true, mode: 0o700 });
          await writeFile(promptPath, `# Delegated task\n\n${params.task}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });

          const weztermCheck = await pi.exec("wezterm", ["cli", "list"], {
            timeout: 5_000,
          });
          if (weztermCheck.code !== 0) {
            throw new Error(
              `WezTerm CLI access is required: ${weztermCheck.stderr.trim() || "wezterm cli failed"}`,
            );
          }

          const piArgs = [
            ...getPiInvocationParts(),
            "--provider",
            selectedModel.provider,
            "--model",
            selectedModel.model,
            "--thinking",
            thinking,
            "--session-dir",
            sessionDir,
            "--session-id",
            childSessionId,
            "--name",
            `pi-subagent-${childSessionId.slice(0, 8)}`,
            spec.trusted ? "--approve" : "--no-approve",
            "--extension",
            EXTENSION_PATH,
            `@${promptPath}`,
          ];

          const childCommand = [
            "env",
            `${CHILD_ENV}=1`,
            `${RESULT_ENV}=${shellQuote(resultPath)}`,
            piArgs.map(shellQuote).join(" "),
          ].join(" ");

          const startedAt = Date.now();
          const spawnResult = await pi.exec(
            "wezterm",
            [
              "cli",
              "spawn",
              "--new-window",
              "--cwd",
              cwd,
              "--",
              "sh",
              "-c",
              childCommand,
            ],
            { timeout: 10_000 },
          );

          if (spawnResult.code !== 0) {
            throw new Error(
              `Failed to spawn WezTerm pane: ${spawnResult.stderr.trim() || spawnResult.stdout.trim()}`,
            );
          }

          const paneId = spawnResult.stdout.trim();
          spec.paneId = paneId;
          updateWeztermCommands(spec);
          activePaneId = paneId;

          try {
            const initialDetails = detailsFor(spec, "running", { startedAt });
            onUpdate?.({
              content: [{ type: "text", text: partialText(initialDetails) }],
              details: initialDetails,
            });

            let lastPane = "";
            let childResult: ChildResult | undefined;

            while (!childResult) {
              if (signal?.aborted) throw new Error("Subagent aborted.");
              try {
                childResult = JSON.parse(
                  await readFile(resultPath, "utf8"),
                ) as ChildResult;
                break;
              } catch {
                // Result file is written atomically upon completion.
              }

              const paneResult = await pi.exec(
                "wezterm",
                ["cli", "get-text", "--pane-id", paneId],
                { timeout: 5_000 },
              );

              if (paneResult.code === 0) {
                const pane = trimPane(paneResult.stdout);
                if (pane && pane !== lastPane) {
                  lastPane = pane;
                  const details = detailsFor(spec, "running", {
                    pane,
                    startedAt,
                  });
                  onUpdate?.({
                    content: [{ type: "text", text: partialText(details) }],
                    details,
                  });
                }
              }

              // Check if pane process is still active
              const listResult = await pi.exec("wezterm", ["cli", "list"], {
                timeout: 5_000,
              });
              const paneExists =
                listResult.code === 0 &&
                listResult.stdout
                  .split("\n")
                  .some((line) => line.trim().startsWith(paneId));

              if (!paneExists) {
                await abortableDelay(100, signal);
                try {
                  childResult = JSON.parse(
                    await readFile(resultPath, "utf8"),
                  ) as ChildResult;
                  break;
                } catch {
                  throw new Error(
                    `Child Pi process exited before reporting a result.\n\n${lastPane || "No pane output."}\n\nInspect: ${spec.captureCommand}`,
                  );
                }
              }

              await abortableDelay(POLL_INTERVAL_MS, signal);
            }

            const finalPaneResult = await pi.exec(
              "wezterm",
              ["cli", "get-text", "--pane-id", paneId],
              { timeout: 5_000 },
            );
            const finalPane =
              finalPaneResult.code === 0
                ? trimPane(finalPaneResult.stdout)
                : lastPane;
            const status: RunStatus =
              childResult.status === "completed" ? "completed" : "failed";
            let rawOutput = childResult.output.trim();
            if (childResult.status === "failed" && childResult.error?.trim()) {
              rawOutput += `${rawOutput ? "\n\n" : ""}Error: ${childResult.error.trim()}`;
            }
            const output = truncateToolText(rawOutput || "(no text output)");
            const details = detailsFor(spec, status, {
              pane: finalPane,
              output,
              sessionFile: childResult.sessionFile,
              provider: childResult.provider ?? spec.provider,
              model: childResult.model ?? spec.model,
              thinking: childResult.thinking ?? spec.thinking,
              startedAt,
              finishedAt: childResult.finishedAt,
            });

            if (childResult.status === "failed") {
              throw new Error(resultText(details));
            }
            return {
              content: [{ type: "text", text: resultText(details) }],
              details,
            };
          } catch (error) {
            if (signal?.aborted) {
              await pi.exec("wezterm", [
                "cli",
                "kill-pane",
                "--pane-id",
                paneId,
              ]);
              activePaneId = undefined;
            }
            throw error;
          } finally {
            if (activePaneId === paneId) activePaneId = undefined;
          }
        },
      );
    },

    renderCall(args, theme) {
      const task = args.task?.trim() || "...";
      const firstLine = task.split("\n", 1)[0] ?? task;
      const preview =
        firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("dim", preview);
      const overrides = [args.provider, args.model, args.thinking].filter(
        Boolean,
      );
      if (overrides.length > 0)
        text += `\n  ${theme.fg("muted", overrides.join(" · "))}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as RunDetails | undefined;
      if (!details) {
        const content = result.content.find((part) => part.type === "text");
        return new Text(
          content?.type === "text" ? content.text : "(no output)",
          0,
          0,
        );
      }

      const running =
        isPartial ||
        details.status === "queued" ||
        details.status === "running";
      const icon = running
        ? theme.fg("warning", details.status === "queued" ? "◦" : "●")
        : details.status === "completed"
          ? theme.fg("success", "✓")
          : theme.fg("error", "✗");
      const duration = formatDuration(details.startedAt, details.finishedAt);
      let text = `${icon} ${theme.fg("toolTitle", theme.bold(`Pane ${details.paneId}`))}`;
      text += theme.fg(
        "muted",
        ` · ${details.status}${duration ? ` · ${duration}` : ""}`,
      );
      text += `\n  ${theme.fg("accent", details.attachCommand)}`;
      text += `\n  ${theme.fg("dim", `${details.provider}/${details.model} (${details.thinking})`)}`;

      if (running && details.pane) {
        const paneLines = details.pane.split("\n");
        const visible = expanded ? paneLines : paneLines.slice(-8);
        text += `\n\n${visible.map((line) => theme.fg("dim", line)).join("\n")}`;
      } else if (!running && details.output) {
        const outputLines = details.output.split("\n");
        const visible = expanded ? outputLines : outputLines.slice(0, 8);
        text += `\n\n${visible.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
        if (!expanded && outputLines.length > visible.length)
          text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        text += `\n\n  ${theme.fg("dim", `capture: ${details.captureCommand}`)}`;
        text += `\n  ${theme.fg("dim", `cleanup: ${details.killCommand}`)}`;
      }
      return new Text(text, 0, 0);
    },
  });
}
