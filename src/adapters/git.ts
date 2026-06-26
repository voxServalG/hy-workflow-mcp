import { execSync } from "node:child_process";

export function gitLines(root: string, command: string): string[] {
  const output = execSync(command, { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  return output ? output.split("\n").map(line => line.trim()).filter(Boolean) : [];
}

export function trackedFiles(root: string): string[] {
  return gitLines(root, "git ls-files");
}

