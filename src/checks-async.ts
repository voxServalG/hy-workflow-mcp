import { spawn } from "node:child_process";
import type { CheckResult, ExecResult } from "./checks.js";
import {
  CHECK_COMMAND_SUPERVISOR,
  CHECK_COMMAND_TIMEOUT_MS,
  CHECK_OUTPUT_LIMIT_BYTES,
  buildImplementationManifest,
  checkCommandTimeoutMs,
  runCompile,
  runScopeCheck,
  runBoundaryCheck,
  runPlatform,
  runSmoke,
  runTests,
  suggestPlanAmendment,
  ok,
  fail,
  formatExit,
  type CheckCommand,
  type VerifyReport,
} from "./checks.js";
import type { PlanDoc, ImplementationManifest, WorkflowState } from "./state.js";

function setImmediatePromise(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export function runCheckCommandAsync(
  command: CheckCommand,
  cwd?: string,
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Promise<ExecResult> {
  const effectiveTimeoutMs = timeoutMs ?? (typeof command === "string" ? checkCommandTimeoutMs(command) : CHECK_COMMAND_TIMEOUT_MS);
  const payload = typeof command === "string"
    ? { kind: "shell", command, cwd, timeoutMs: effectiveTimeoutMs }
    : { kind: "file", file: command.file, args: command.args, cwd, timeoutMs: effectiveTimeoutMs };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const started = Date.now();

  return new Promise<ExecResult>(resolve => {
    const child = spawn(process.execPath, ["-e", CHECK_COMMAND_SUPERVISOR, encoded], {
      cwd,
      env: env ?? process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > CHECK_OUTPUT_LIMIT_BYTES) {
        if (!truncated) {
          stdout += "\n...[truncated]...\n";
          truncated = true;
        }
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > CHECK_OUTPUT_LIMIT_BYTES) {
        if (!truncated) {
          stderr += "\n...[truncated]...\n";
          truncated = true;
        }
        return;
      }
      stderr += chunk;
    });

    child.once("error", error => {
      resolve({
        ok: false,
        stdout: stdout.trim(),
        stderr: error?.message ? error.message : String(error),
        status: null,
        timedOut: false,
        timeoutMs: effectiveTimeoutMs,
        durationMs: Date.now() - started,
      });
    });

    child.once("close", (status, signal) => {
      const durationMs = Date.now() - started;
      if (status !== 0 || signal) {
        resolve({
          ok: false,
          stdout: stdout.trim(),
          stderr: (stderr.trim() || `check command supervisor exited ${status ?? signal}`),
          status: null,
          timedOut: false,
          timeoutMs: effectiveTimeoutMs,
          durationMs,
        });
        return;
      }
      try {
        const result = JSON.parse(stdout || "{}");
        const timedOut = result.timedOut === true;
        const exitStatus = timedOut ? null : (typeof result.status === "number" ? result.status : null);
        const timeoutDetail = timedOut ? `timed out after ${effectiveTimeoutMs}ms` : "";
        const combinedStderr = [result.stderr, result.error, timeoutDetail].filter(Boolean).join("; ").trim();
        resolve({
          ok: !timedOut && !result.error && exitStatus === 0,
          stdout: typeof result.stdout === "string" ? result.stdout.trim() : "",
          stderr: combinedStderr,
          status: exitStatus,
          timedOut,
          timeoutMs: effectiveTimeoutMs,
          durationMs: typeof result.durationMs === "number" ? result.durationMs : durationMs,
        });
      } catch (error: any) {
        resolve({
          ok: false,
          stdout: "",
          stderr: `Could not parse check command supervisor result: ${error?.message ?? String(error)}; ${stdout.slice(-2_000)}`,
          status: null,
          timedOut: false,
          timeoutMs: effectiveTimeoutMs,
          durationMs,
        });
      }
    });
  });
}

async function execOrAsync(cmd: string, cwd?: string): Promise<ExecResult> {
  return runCheckCommandAsync(cmd, cwd);
}

async function execWithOneRetryAsync(cmd: string, cwd?: string): Promise<ExecResult> {
  const first = await execOrAsync(cmd, cwd);
  if (first.ok) return first;
  await setImmediatePromise();
  const second = await execOrAsync(cmd, cwd);
  return second.ok
    ? second
    : { ...second, stderr: `attempt 1: ${first.stderr || first.stdout}; attempt 2: ${second.stderr || second.stdout}` };
}

async function runTypeScriptCompileAsync(root: string): Promise<CheckResult> {
  const r = await execOrAsync("npx tsc --noEmit", root);
  return r.ok
    ? ok("compile: typescript", "compile", "TypeScript build OK")
    : fail("compile: typescript", "compile", `${formatExit(r)}: ${r.stderr || r.stdout || "TypeScript build failed"}`, true);
}

async function runPythonCompileAsync(root: string, files: string[]): Promise<CheckResult> {
  if (!files.length) return ok("compile: python", "compile", "No Python files found in configured codeDirs", false);
  const python = process.platform === "win32" ? "python" : "python3";
  const r = await runCheckCommandAsync({ file: python, args: ["-m", "py_compile", ...files] }, root);
  return r.ok
    ? ok("compile: python", "compile", `${files.length} Python file(s) compiled`)
    : fail("compile: python", "compile", `${formatExit(r)}: ${r.stderr || r.stdout || "Python compile failed"}`, true);
}

async function runItemsAsync(items: { command: string; expected_exit: number; description: string }[], layer: string, root: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const item of items) {
    const r = await execOrAsync(item.command, root);
    const exitOk = r.status === item.expected_exit;
    const output = r.stdout || r.stderr;
    out.push(exitOk
      ? ok(item.description, layer, output || `${formatExit(r)} as expected`)
      : fail(item.description, layer, `expected exit ${item.expected_exit}, got ${formatExit(r)}${output ? `: ${output}` : ""}`));
    await setImmediatePromise();
  }
  return out;
}

async function runBoundaryAsync(root: string, plan: PlanDoc, manifest: ImplementationManifest | undefined, manifestError: string | undefined): Promise<CheckResult[]> {
  const res: CheckResult[] = [];
  for (const ep of plan.boundary.entry_points) {
    const r = await execOrAsync(ep, root);
    res.push(r.ok
      ? ok(`entry: ${ep.slice(0, 55)}...`, "boundary", "OK")
      : fail(`entry: ${ep.slice(0, 55)}...`, "boundary", `${formatExit(r)}: ${r.stderr || r.stdout || "command failed"}`));
    await setImmediatePromise();
  }

  if (plan.boundary.no_new_external) {
    let boundaryManifest = manifest ?? null;
    let boundaryManifestError = manifestError ?? null;
    if (!boundaryManifest && !boundaryManifestError) {
      try {
        boundaryManifest = buildImplementationManifest(root);
      } catch (e: any) {
        boundaryManifestError = e.message ?? String(e);
      }
    }

    if (boundaryManifestError) {
      res.push(fail("no_new_external", "boundary", `Cannot verify dependency manifests: ${boundaryManifestError}`));
    } else {
      const changed = boundaryManifest?.changed ?? [];
      const depManifests = [
        "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
        "bun.lock", "bun.lockb", "pyproject.toml", "setup.cfg", "setup.py", "requirements.txt",
        "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "Cargo.toml", "Cargo.lock",
        "go.mod", "go.sum", "composer.json", "composer.lock", "Gemfile", "Gemfile.lock", "policy.md",
      ];
      const changedDeps = changed.filter(f => depManifests.includes(f) || (f.startsWith("requirements/") && f.endsWith(".txt")));
      const nonNpmChanges = changedDeps.filter(f => f !== "package.json" && f !== "package-lock.json");
      let npmDeclarationsChanged = false;
      if (changedDeps.some(f => f === "package.json" || f === "package-lock.json")) {
        try {
          const { execFileSync } = await import("node:child_process");
          const baseRef = `origin/${plan.boundary as any}`;
          try {
            execFileSync("git", ["rev-parse", "--verify", `origin/main^{commit}`], { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 30_000 });
          } catch {
            // ignore
          }
          const fs = await import("node:fs");
          const path = await import("node:path");
          const readJson = (p: string) => {
            try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
          };
          const currentPkg = readJson(path.join(root, "package.json"));
          const currentLock = readJson(path.join(root, "package-lock.json"));
          npmDeclarationsChanged = Boolean(currentPkg && currentLock);
        } catch {
          npmDeclarationsChanged = false;
        }
      }
      const finalChanges = [...nonNpmChanges, ...(npmDeclarationsChanged ? ["package.json"] : [])];
      res.push(finalChanges.length
        ? fail("no_new_external", "boundary", `Dependency declarations changed: ${finalChanges.join(", ")}`)
        : ok("no_new_external", "boundary", "No external dependency declaration changes"));
    }
  }

  return res;
}

async function runPlatformAsync(plan: PlanDoc, root: string): Promise<CheckResult[]> {
  const res: CheckResult[] = [];
  const pyVer = plan.verify.platform.python_version;
  const trimmed = typeof pyVer === "string" ? pyVer.trim() : "";
  if (trimmed && !/^(n\/?a|none|no|false|not required|not-required)$/i.test(trimmed)) {
    const match = /^(?:>=\s*)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(trimmed);
    if (match) {
      const required: [number, number, number] = [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
      const python = process.platform === "win32" ? "python" : "python3";
      const r = await execOrAsync(`${python} --version`, root);
      const out = r.stdout || r.stderr;
      const v = /Python\s+(\d+)\.(\d+)\.(\d+)/.exec(out);
      if (!r.ok || !v) {
        res.push(fail("python_version", "platform", `${formatExit(r)}: ${out || "could not read Python version"}`));
      } else {
        const actual: [number, number, number] = [Number(v[1]), Number(v[2]), Number(v[3])];
        const okCmp = actual[0] > required[0]
          || (actual[0] === required[0] && actual[1] > required[1])
          || (actual[0] === required[0] && actual[1] === required[1] && actual[2] >= required[2]);
        const fmt = (x: [number, number, number]) => x.join(".").replace(/(?:\.0)+$/, "");
        res.push(okCmp
          ? ok("python_version", "platform", `Python ${fmt(actual)} satisfies >=${fmt(required)}`)
          : fail("python_version", "platform", `Python ${fmt(actual)} is below required >=${fmt(required)}`));
      }
      await setImmediatePromise();
    }
  }

  for (const cmd of plan.verify.platform.setup) {
    const r = await execOrAsync(cmd, root);
    res.push(r.ok
      ? ok(`setup: ${cmd.slice(0, 50)}`, "platform", r.stdout || "OK")
      : fail(`setup: ${cmd.slice(0, 50)}`, "platform", `${formatExit(r)}: ${r.stderr || r.stdout || "setup command failed"}`));
    await setImmediatePromise();
  }
  return res;
}

export async function runAllChecksAsync(root: string, state: WorkflowState): Promise<VerifyReport> {
  const p = state.plan;
  const emptyManifest: ImplementationManifest = { modified: [], added: [], deleted: [], untracked: [], changed: [] };
  if (!p) {
    return {
      allPassed: false,
      hardFailed: 1,
      total: 1,
      checks: [fail("plan", "lint", "No plan")],
      status: "hard_fail",
      implementationManifest: emptyManifest,
      suggestedAmendment: null,
    };
  }

  let implementationManifest = emptyManifest;
  let manifestError: CheckResult | null = null;
  try {
    implementationManifest = buildImplementationManifest(root);
  } catch (e: any) {
    manifestError = fail("scope", "scope", e.message ?? String(e));
  }

  const compileChecks = runCompile(root);
  await setImmediatePromise();

  const scopeChecks = manifestError ? [manifestError] : runScopeCheck(root, p, implementationManifest);
  await setImmediatePromise();

  const boundaryChecks = await runBoundaryAsync(root, p, manifestError ? undefined : implementationManifest, manifestError?.detail);
  await setImmediatePromise();

  const platformChecks = await runPlatformAsync(p, root);
  await setImmediatePromise();

  const smokeChecks = await runItemsAsync(p.verify.smoke, "smoke", root);
  await setImmediatePromise();

  const testsChecks = await runItemsAsync(p.verify.tests, "tests", root);

  const all: CheckResult[] = [
    ...compileChecks,
    ...scopeChecks,
    ...boundaryChecks,
    ...platformChecks,
    ...smokeChecks,
    ...testsChecks,
  ];

  const hardFailures = all.filter(c => c.hard && !c.passed);
  const suggestedAmendment = manifestError ? null : suggestPlanAmendment(p, implementationManifest);
  const status = hardFailures.length === 0
    ? "passed"
    : hardFailures.every(c => c.classification === "amend_required") && suggestedAmendment
      ? "amend_required"
      : "hard_fail";

  return {
    allPassed: all.every(c => c.passed || !c.hard),
    hardFailed: hardFailures.length,
    total: all.length,
    checks: all,
    status,
    implementationManifest,
    suggestedAmendment,
  };
}
