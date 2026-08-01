import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TestRepository = {
  root: string;
  write: (relativePath: string, content: string, mode?: number) => void;
  git: (...args: string[]) => string;
  commitAll: (message?: string) => void;
  remove: () => void;
};

export function run(command: string, args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
export function createRepository(): TestRepository {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-workflow-test-"));
  const git = (...args: string[]): string => {
    const result = run("git", args, root);
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (relativePath: string, content: string, mode?: number): void => {
    const target = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    if (mode !== undefined) fs.chmodSync(target, mode);
  };
  const commitAll = (message = "fixture"): void => {
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
  };
  const initialized = run("git", ["init", "--quiet", "--initial-branch=main"], root);
  if (initialized.status !== 0) throw new Error(initialized.stderr);
  git("config", "user.name", "hy-workflow test");
  git("config", "user.email", "test@example.invalid");
  return { root, write, git, commitAll, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function baseProtocol(options: {
  second?: boolean;
  source?: string;
  pattern?: string;
  argv?: string[];
  scale?: "small" | "medium" | "large";
} = {}): string {
  const argv = JSON.stringify(options.argv ?? ["node", "--version"]);
  const source = options.source ?? "docs/invariants/INV-TEST-001.md";
  const pattern = options.pattern ?? "src/**";
  const entry = (id: string) => [
    `  - id: ${id}`,
    "    kind: invariant",
    "    status: active",
    `    statement: This reviewed invariant remains true for ${id}.`,
    "    sources:",
    `      - ${source}`,
    "    applies_to:",
    "      paths:",
    `        - ${pattern}`,
    "    verification:",
    `      scale: ${options.scale ?? "small"}`,
    "      commands:",
    `        - argv: ${argv}`,
    "          expected_exit_code: 0",
  ].join("\n");
  return [
    "schema: hy-workflow.protocol.v1",
    "obligations:",
    entry("INV-TEST-001"),
    ...(options.second ? [entry("INV-TEST-002")] : []),
    "",
  ].join("\n");
}

export function seedProtocolRepository(protocol = baseProtocol()): TestRepository {
  const repository = createRepository();
  repository.write("docs/invariants/INV-TEST-001.md", "# Invariant\n\nReviewed project rule.\n");
  repository.write("src/app.ts", "export const value = 1;\n");
  repository.write("hy-workflow.yml", protocol);
  repository.commitAll("seed protocol");
  return repository;
}
