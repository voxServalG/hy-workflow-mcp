import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MINIMAL_PROJECT_CONTRACT, writeDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertNoPromptFields(value: unknown, location = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPromptFields(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assert(!["prompt", "display", "hint", "instruction"].includes(key), `${location}.${key} must not appear in the CLI envelope`);
    assertNoPromptFields(child, `${location}.${key}`);
  }
}

const runtime = mkdtempSync(join(tmpdir(), "hy-cli-corrupt-state-"));
try {
  const roots = {
    config: join(runtime, "config"),
    state: join(runtime, "state"),
    cache: join(runtime, "cache"),
  };
  process.env.HY_WORKFLOW_CONFIG_HOME = roots.config;
  process.env.HY_WORKFLOW_STATE_HOME = roots.state;
  process.env.HY_WORKFLOW_CACHE_HOME = roots.cache;

  const root = process.cwd();
  writeDeployment(root, {
    setupVersion: "cli-test",
    mode: "shared",
    clients: [],
    projectFiles: [],
    projectContract: MINIMAL_PROJECT_CONTRACT,
    tools: {},
    artifacts: {},
  });
  const workflowState = projectPaths(root).workflowState;
  mkdirSync(dirname(workflowState), { recursive: true });
  writeFileSync(workflowState, "{not json\n", "utf-8");

  const env = {
    ...process.env,
    HY_WORKFLOW_CONFIG_HOME: roots.config,
    HY_WORKFLOW_STATE_HOME: roots.state,
    HY_WORKFLOW_CACHE_HOME: roots.cache,
  } as NodeJS.ProcessEnv;
  const entrypoint = resolve("dist/main.js");

  const invoke = (command: "status" | "reset") => {
    const child = spawnSync(process.execPath, [entrypoint, command], {
      cwd: root,
      env,
      encoding: "utf-8",
      timeout: 5_000,
    });
    assert(!child.error, `${command} CLI failed to start: ${child.error?.message ?? "unknown error"}`);
    assert(child.stderr === "", `${command} CLI must not write unexpected stderr: ${child.stderr}`);
    const lines = child.stdout.trim().split(/\r?\n/);
    assert(lines.length === 1, `${command} CLI should emit exactly one compact JSON document`);
    const payload = JSON.parse(lines[0]) as Record<string, any>;
    assert(payload.schema === "hy-workflow.cli.v1" && payload.command === command, `${command} should use the public CLI envelope`);
    assertNoPromptFields(payload);
    return { status: child.status, payload };
  };

  const failed = invoke("status");
  assert(failed.status === 1 && failed.payload.ok === false, "status must fail closed for unreadable external workflow state");
  assert(failed.payload.error?.code === "WORKFLOW_STATE_CORRUPT", "status must preserve the corrupt-state error identity");
  assert(failed.payload.route?.action?.command === "reset", "corrupt state must route directly to reset instead of another status loop");
  assert(
    JSON.stringify(failed.payload.route?.action?.argv) === JSON.stringify(["hy-workflow", "reset"]),
    "corrupt-state recovery must expose reset as an exact argv array",
  );

  const reset = invoke("reset");
  assert(reset.status === 0 && reset.payload.ok === true, "reset should replace only the unreadable workflow state");
  assert(reset.payload.phase === "plan" && reset.payload.stage === "plan.before_plan", "reset should recover to the initial planning gate");

  const recovered = invoke("status");
  assert(recovered.status === 0 && recovered.payload.ok === true, "status should succeed after CLI reset recovery");
  assert(recovered.payload.phase === "plan" && recovered.payload.error === undefined, "recovered status should retain the new valid plan state");
} finally {
  rmSync(runtime, { recursive: true, force: true });
}

console.log("server-corrupt-state: CLI status routes corrupt external state to reset and recovers");
