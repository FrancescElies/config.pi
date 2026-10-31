/**
 * no-sleep: prevent system sleep while the pi agent is running.
 *
 * Env:
 *   PI_NO_SLEEP                  enable/disable (default true). false/0/no/off disables.
 *   PI_NO_SLEEP_DISPLAY_AWAKE    keep display awake too (default false).
 *   PI_NO_SLEEP_SCOPE            "agent" (default) or "session".
 * Command: /no-sleep [status|on|off|toggle|agent|session]
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import type { ChildProcess } from "node:child_process";

const MACOS = process.platform === "darwin";
const WINDOWS = process.platform === "win32";

type Scope = "agent" | "session";
type Level = "info" | "warning" | "error";

// Lazily loaded on Windows only, so a missing/broken native module
// never breaks extension load on macOS or any other platform.
async function setExecutionState(flags: number): Promise<number> {
  try {
    const ps = `Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace W; [W.K]::SetThreadExecutionState(${flags})`;
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      ps,
    ]);
    return Number(stdout.trim()) || 0;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    return 0;
  }
}

let sleepPrevention: ChildProcess | undefined;
let enabled = readBooleanEnv("PI_NO_SLEEP", true);
let scope: Scope = readScopeEnv();
let agentActive = false;
let lastError: string | undefined;
let sleepPreventionActive = false;

function readBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  return !/^(0|false|no|off)$/i.test(value);
}

function readScopeEnv(): Scope {
  return /^session$/i.test(process.env.PI_NO_SLEEP_SCOPE ?? "")
    ? "session"
    : "agent";
}

function macosSleepArgs(): string[] {
  const args = ["-i", "-s"];
  if (readBooleanEnv("PI_NO_SLEEP_DISPLAY", false)) {
    args.push("-d");
  }
  args.push("-w", String(process.pid));
  return args;
}

function notify(
  ctx: ExtensionContext | undefined,
  message: string,
  level: Level = "info",
): void {
  if (ctx?.hasUI) {
    ctx.ui.notify(message, level);
  }
}

async function start(ctx?: ExtensionContext): Promise<void> {
  if (!enabled || sleepPrevention || sleepPreventionActive) {
    return;
  }

  if (MACOS) {
    const cmd = { command: "caffeinate", args: macosSleepArgs() };
    lastError = undefined;
    const child = spawn(cmd.command, cmd.args, { stdio: "ignore" });
    child.unref();
    sleepPrevention = child;

    child.once("error", (error) => {
      if (sleepPrevention !== child) {
        return;
      }
      sleepPrevention = undefined;
      lastError = error.message;
      notify(
        ctx,
        `No Sleep: failed to start sleep prevention: ${error.message}`,
        "error",
      );
    });

    child.once("exit", (code, signal) => {
      if (sleepPrevention !== child) {
        return;
      }
      sleepPrevention = undefined;

      if (code && code !== 0) {
        lastError = `sleep prevention exited with code ${code}`;
        notify(
          ctx,
          `No Sleep: sleep prevention stopped unexpectedly (${lastError}).`,
          "warning",
        );
      } else if (signal) {
        lastError = `sleep prevention exited after signal ${signal}`;
        notify(
          ctx,
          `No Sleep: sleep prevention stopped unexpectedly (${lastError}).`,
          "warning",
        );
      }
    });
  } else if (WINDOWS) {
    let flags = 0x80000001; // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    if (readBooleanEnv("PI_NO_SLEEP_DISPLAY", false)) {
      flags |= 0x00000002; // ES_DISPLAY_REQUIRED
    }

    lastError = undefined;
    const result = await setExecutionState(flags);
    if (result === 0) {
      lastError = "failed to start sleep prevention";
      notify(
        ctx,
        `No Sleep: failed to start sleep prevention: ${lastError}`,
        "error",
      );
    } else {
      sleepPreventionActive = true;
      notify(ctx, "No Sleep: active", "info");
    }
  } else if (process.platform === "linux") {
    // systemd-inhibit may be absent in containers/minimal images; skip there.
    const inhibitPath = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"].find((p) => existsSync(p));
    if (!inhibitPath) {
      lastError = "systemd-inhibit not available; skipping";
      return;
    }
    const child = spawn(
      inhibitPath,
      [
        "--what=sleep:idle",
        "--who=pi",
        "--why=agent running",
        "sleep",
        "infinity",
      ],
      { stdio: "ignore" },
    );
    child.unref();
    sleepPrevention = child;
    lastError = undefined;

    child.once("error", (error) => {
      if (sleepPrevention !== child) return;
      sleepPrevention = undefined;
      lastError = error.message;
      notify(
        ctx,
        `No Sleep: failed to start sleep prevention: ${error.message}`,
        "error",
      );
    });

    child.once("exit", (code, signal) => {
      if (sleepPrevention !== child) return;
      sleepPrevention = undefined;
      if (code && code !== 0) {
        lastError = `sleep prevention exited with code ${code}`;
        notify(
          ctx,
          `No Sleep: sleep prevention stopped unexpectedly (${lastError}).`,
          "warning",
        );
      } else if (signal) {
        lastError = `sleep prevention exited after signal ${signal}`;
        notify(
          ctx,
          `No Sleep: sleep prevention stopped unexpectedly (${lastError}).`,
          "warning",
        );
      }
    });
    notify(ctx, "No Sleep: active", "info");
  }
}

async function stop(ctx?: ExtensionContext): Promise<void> {
  const child = sleepPrevention;
  sleepPrevention = undefined;

  if (child) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 1000);
      timer.unref?.();
    }
  }

  if (WINDOWS && sleepPreventionActive) {
    // Reset execution state back to normal (ES_CONTINUOUS only).
    await setExecutionState(0x80000000);
    sleepPreventionActive = false;
  }
}

async function reconcile(ctx?: ExtensionContext): Promise<void> {
  if (!enabled) {
    await stop(ctx);
    return;
  }

  if (scope === "session" || agentActive) {
    await start(ctx);
  } else {
    await stop(ctx);
  }
}

function describeState(): string {
  if (!MACOS && !WINDOWS) {
    return "No Sleep is inactive: sleep prevention is only supported on macOS and Windows.";
  }

  const active = MACOS ? Boolean(sleepPrevention) : sleepPreventionActive;
  const state = active
    ? MACOS
      ? `active (pid ${sleepPrevention?.pid ?? "unknown"})`
      : "active"
    : "idle";
  const display = readBooleanEnv("PI_NO_SLEEP_DISPLAY", false) ? "yes" : "no";
  return [
    `No Sleep is ${enabled ? "enabled" : "disabled"}.`,
    `scope: ${scope}`,
    `state: ${state}`,
    `keeps display awake: ${display}`,
    lastError ? `last error: ${lastError}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export default function noSleepExtension(pi: ExtensionAPI) {
  const cleanupOnProcessExit = () => {
    // Best-effort synchronous cleanup on process exit; the async
    // Windows reset can't reliably complete here, so at minimum
    // terminate the macOS caffeinate child.
    const child = sleepPrevention;
    sleepPrevention = undefined;
    if (child && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  };
  process.once("exit", cleanupOnProcessExit);

  pi.on("session_start", async (_event, ctx) => {
    agentActive = false;
    await reconcile(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    agentActive = true;
    await reconcile(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    agentActive = false;
    await reconcile(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    agentActive = false;
    await stop(ctx);
    process.off("exit", cleanupOnProcessExit);
  });

  pi.registerCommand("no-sleep", {
    description: "Show or change sleep-prevention status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "on" || command === "enable") {
        enabled = true;
        await reconcile(ctx);
      } else if (command === "off" || command === "disable") {
        enabled = false;
        await reconcile(ctx);
      } else if (command === "toggle") {
        enabled = !enabled;
        await reconcile(ctx);
      } else if (command === "agent") {
        scope = "agent";
        await reconcile(ctx);
      } else if (command === "session") {
        scope = "session";
        await reconcile(ctx);
      } else if (command && command !== "status") {
        notify(
          ctx,
          "Usage: /no-sleep [status|on|off|toggle|agent|session]",
          "warning",
        );
        return;
      }

      notify(ctx, describeState(), lastError ? "warning" : "info");
    },
  });
}
