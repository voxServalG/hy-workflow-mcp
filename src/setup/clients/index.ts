import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { McpDefinition } from "../types.js";

export type CommandResult = { ok: boolean; stdout: string; stderr: string; status: number | null };

export function executableInvocation(executable: string, args: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const isCmdShim = platform === "win32" && [".cmd", ".bat"].includes(path.extname(executable).toLowerCase());
  return isCmdShim
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", executable, ...args] }
    : { command: executable, args };
}

export function resolveExecutable(name: string): string | null {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(locator, [name], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    return output.split(/\r?\n/).map(value => value.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export function runExecutable(executable: string, args: string[], timeout = 15_000): CommandResult {
  try {
    const invocation = executableInvocation(executable, args);
    const stdout = execFileSync(invocation.command, invocation.args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "", status: 0 };
  } catch (error: any) {
    return {
      ok: false,
      stdout: String(error?.stdout ?? "").trim(),
      stderr: String(error?.stderr ?? error?.message ?? "").trim(),
      status: typeof error?.status === "number" ? error.status : null,
    };
  }
}

export function normalizeDefinition(value: any): McpDefinition | null {
  if (!value || typeof value !== "object") return null;
  const transport = value.transport && typeof value.transport === "object" ? value.transport : value;
  const command = transport.command ?? value.command;
  if (typeof command !== "string" || !command) return null;
  const rawArgs = transport.args ?? value.args ?? [];
  const args = Array.isArray(rawArgs) ? rawArgs.filter((item): item is string => typeof item === "string") : [];
  const rawEnv = transport.env ?? value.env;
  const env = rawEnv && typeof rawEnv === "object" && !Array.isArray(rawEnv)
    ? Object.fromEntries(Object.entries(rawEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return { command, args, ...(env && Object.keys(env).length ? { env } : {}) };
}

export function definitionEquals(left: McpDefinition | null, right: McpDefinition | null): boolean {
  if (!left || !right) return left === right;
  const sortedEnv = (value?: Record<string, string>) => Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ command: left.command, args: left.args, env: sortedEnv(left.env) })
    === JSON.stringify({ command: right.command, args: right.args, env: sortedEnv(right.env) });
}

export function versionOf(executable: string): string | null {
  const result = runExecutable(executable, ["--version"], 5_000);
  return result.ok ? result.stdout.split(/\r?\n/)[0]?.trim() || null : null;
}
