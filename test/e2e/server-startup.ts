import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

type Invocation = {
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
};

const workflowInvocations: Array<{ command: string; args: string[] }> = [
  { command: "init", args: ["init"] },
  { command: "status", args: ["status"] },
  { command: "read-docs", args: ["read-docs", "--input", JSON.stringify({ stage: "before_plan", task: "CLI startup contract" })] },
  { command: "plan", args: ["plan", "--input", JSON.stringify({ task: "CLI startup contract", plan: {} })] },
  { command: "approve", args: ["approve", "--input", JSON.stringify({ approved: "reject", decisionId: "plan:000000000000" })] },
  { command: "branch", args: ["branch", "--input", JSON.stringify({ category: "test", topic: "cli-startup" })] },
  { command: "edit", args: ["edit"] },
  { command: "sync-docs", args: ["sync-docs"] },
  { command: "verify", args: ["verify"] },
  { command: "exam-plan", args: ["exam-plan"] },
  { command: "exam-submit", args: ["exam-submit", "--input", JSON.stringify({ examId: "exam-cli-startup-contract", results: [] })] },
  { command: "amend-plan", args: ["amend-plan", "--input", JSON.stringify({ approved: "reject", decisionId: "amendment:000000000000" })] },
  { command: "commit", args: ["commit", "--input", JSON.stringify({ title: "CLI startup probe", body: "" })] },
  { command: "merge", args: ["merge"] },
  { command: "reset", args: ["reset"] },
];

assert(workflowInvocations.length === 15, "the public CLI must expose exactly 15 workflow commands");

if (process.platform !== "win32") {
  const runtime = mkdtempSync(join(tmpdir(), "hy-cli-startup-"));
  try {
    const bin = join(runtime, "bin");
    const authMarker = join(runtime, "gh-auth-was-called");
    mkdirSync(bin, { recursive: true });
    const gh = join(bin, "gh");
    writeFileSync(gh, [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then printf 'gh version test\\n'; exit 0; fi",
      `if [ "$1" = "auth" ]; then printf called > ${JSON.stringify(authMarker)}; sleep 5; exit 1; fi`,
      "exit 1",
      "",
    ].join("\n"), "utf-8");
    chmodSync(gh, 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HY_WORKFLOW_CONFIG_HOME: join(runtime, "config"),
      HY_WORKFLOW_STATE_HOME: join(runtime, "state"),
      HY_WORKFLOW_CACHE_HOME: join(runtime, "cache"),
    } as NodeJS.ProcessEnv;
    const entrypoint = resolve("dist/main.js");

    const invoke = (args: string[]): Invocation => {
      const started = Date.now();
      const child = spawnSync(process.execPath, [entrypoint, ...args], {
        cwd: process.cwd(),
        env,
        encoding: "utf-8",
        timeout: 2_500,
      });
      const elapsedMs = Date.now() - started;
      assert(!child.error, `CLI ${args.join(" ") || "startup"} failed to start: ${child.error?.message ?? "unknown error"}`);
      assert(elapsedMs < 2_500, `CLI ${args.join(" ") || "startup"} must not wait for gh auth (${elapsedMs}ms)`);
      assert(child.stderr === "", `CLI ${args.join(" ") || "startup"} must not write unexpected stderr: ${child.stderr}`);
      return { args, status: child.status, stdout: child.stdout, stderr: child.stderr, elapsedMs };
    };

    const startup = invoke([]);
    const help = invoke(["--help"]);
    assert(startup.status === 0 && help.status === 0, "startup and --help should exit successfully");
    assert(startup.stdout === help.stdout && startup.stdout.includes("State and evidence CLI"), "startup should render the same CLI help as --help");
    for (const { command } of workflowInvocations) {
      assert(startup.stdout.includes(command), `CLI help should list ${command}`);
    }

    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf-8")) as { version: string };
    const version = invoke(["--version"]);
    assert(version.status === 0 && version.stdout.trim() === pkg.version, "--version should print the package version exactly");
    const dotenvProject = join(runtime, "dotenv-project");
    const safeHome = join(runtime, "safe-home");
    const attackerRoot = join(runtime, "attacker-controlled");
    mkdirSync(dotenvProject, { recursive: true });
    mkdirSync(join(safeHome, ".codex"), { recursive: true });
    const gitInit = spawnSync("git", ["init", "-q"], { cwd: dotenvProject, encoding: "utf-8" });
    assert(gitInit.status === 0, `dotenv boundary fixture must initialize Git: ${gitInit.stderr}`);
    writeFileSync(join(dotenvProject, ".env"), [
      `CODEX_HOME=${join(attackerRoot, "codex")}`,
      `XDG_CONFIG_HOME=${join(attackerRoot, "config")}`,
      `XDG_DATA_HOME=${join(attackerRoot, "data")}`,
      `XDG_STATE_HOME=${join(attackerRoot, "state")}`,
      `HY_WORKFLOW_CONFIG_HOME=${join(attackerRoot, "workflow-config")}`,
      `HY_WORKFLOW_STATE_HOME=${join(attackerRoot, "workflow-state")}`,
      `HY_WORKFLOW_CACHE_HOME=${join(attackerRoot, "workflow-cache")}`,
      "HY_WORKFLOW_RUNTIME_CONFIG_SOURCE=hy-workflow.runtime-config-source.v1",
      "",
    ].join("\n"), "utf-8");
    const dotenvEnv = {
      ...process.env,
      HOME: safeHome,
      PATH: env.PATH,
    } as NodeJS.ProcessEnv;
    for (const key of [
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
      "HY_WORKFLOW_CONFIG_HOME",
      "HY_WORKFLOW_STATE_HOME",
      "HY_WORKFLOW_CACHE_HOME",
      "HY_WORKFLOW_RUNTIME_CONFIG_SOURCE",
    ]) delete dotenvEnv[key];
    const dotenvBoundary = spawnSync(process.execPath, [
      entrypoint,
      "helper",
      "install",
      "--clients",
      "codex",
      "--mode",
      "copy",
      "--json",
    ], {
      cwd: dotenvProject,
      env: dotenvEnv,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert(!dotenvBoundary.error, `helper .env boundary process failed: ${dotenvBoundary.error?.message ?? "unknown error"}`);
    const dotenvPayload = JSON.parse(dotenvBoundary.stdout) as Record<string, any>;
    assert(
      dotenvPayload.layers?.skills?.targets?.[0]?.skillsDir === join(safeHome, ".codex", "skills"),
      "helper must derive Agent targets from the explicit parent environment, never the project .env",
    );
    assert(
      dotenvPayload.layers?.skills?.changedPaths?.every((changedPath: string) => changedPath.startsWith(safeHome)),
      `project .env must not redirect helper Skill data or state: ${dotenvBoundary.stdout}`,
    );
    assert(!dotenvBoundary.stdout.includes(attackerRoot), "project .env values must not appear in helper facts");
    assert(!existsSync(attackerRoot), "helper must not create any project-.env-controlled user directory");


    for (const invocation of workflowInvocations) {
      const result = invoke(invocation.args);
      assert(result.status === 1, `${invocation.command} should fail closed when the isolated deployment is absent`);
      const lines = result.stdout.trim().split(/\r?\n/);
      assert(lines.length === 1, `${invocation.command} should emit exactly one compact JSON document`);
      const payload = JSON.parse(lines[0]) as Record<string, any>;
      assert(payload.schema === "hy-workflow.cli.v1" && payload.version === 1, `${invocation.command} should use the versioned CLI envelope`);
      assert(payload.command === invocation.command, `${invocation.command} should retain its public command identity`);
      assert(payload.error?.code === "SETUP_UPDATE_REQUIRED", `${invocation.command} should stop at the missing external deployment gate`);
    }

    assert(!existsSync(authMarker), "CLI startup and workflow dispatch must not probe slow gh auth eagerly");
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

console.log("server-startup: CLI startup, help, version, and 15 workflow commands avoid eager gh auth");
