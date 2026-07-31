import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  abortAcceptance,
  assertNoSymlinkEscape,
  assertWorkspaceDiskBudget,
  createWorkspace,
  loadMatrix,
  packAndInstall,
  terminateAllAcceptanceChildren,
} from "./harness.js";
import {
  runConcurrencyScenario,
  runFaultScenario,
  runRepositoryScenario,
  type ScenarioResult,
} from "./scenarios.js";

type AcceptanceReport = {
  schemaVersion: "1";
  ok: boolean;
  profile: "release";
  sourceCommit: string;
  packageArchive?: string;
  workspace: string;
  startedAt: string;
  durationMs: number;
  expectedScenarios: number;
  completedScenarios: number;
  skipped: [];
  workspaceDisk: {
    limitBytes: number;
    currentBytes: number;
    peakBytes: number;
  };
  results: ScenarioResult[];
  error?: string;
};

const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : "release";
if (profile !== "release") throw new Error("Acceptance supports only the complete release profile; partial profiles are forbidden");
const packageArchiveIndex = process.argv.indexOf("--package-archive");
const packageArchive = packageArchiveIndex >= 0 ? process.argv[packageArchiveIndex + 1] : undefined;
if (packageArchiveIndex >= 0 && (!packageArchive || packageArchive.startsWith("--"))) {
  throw new Error("--package-archive requires one explicit .tgz path");
}

const sourceRoot = process.cwd();
const matrix = loadMatrix(sourceRoot);
const workspace = createWorkspace(sourceRoot);
const started = Date.now();
const totalTimeoutMs = Number(process.env.HY_ACCEPTANCE_TOTAL_TIMEOUT_MS ?? 2_700_000);
const report: AcceptanceReport = {
  schemaVersion: "1",
  ok: false,
  profile: "release",
  sourceCommit: "unknown",
  workspace: workspace.root,
  startedAt: new Date(started).toISOString(),
  durationMs: 0,
  expectedScenarios: matrix.repositories.length + 2,
  completedScenarios: 0,
  skipped: [],
  workspaceDisk: { ...workspace.disk },
  results: [],
};

async function main(): Promise<void> {
  const { run } = await import("./harness.js");
  report.sourceCommit = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, env: workspace.env })).stdout.trim();
  report.packageArchive = await packAndInstall(workspace, packageArchive);
  for (const [index, repo] of matrix.repositories.entries()) {
    const result = await runRepositoryScenario(workspace, repo, index);
    report.results.push(result);
    process.stdout.write(JSON.stringify({ event: "acceptance-scenario", ok: true, ...result }) + "\n");
  }
  report.results.push(await runConcurrencyScenario(workspace));
  process.stdout.write(JSON.stringify({ event: "acceptance-scenario", ok: true, ...report.results.at(-1) }) + "\n");
  report.results.push(await runFaultScenario(workspace));
  process.stdout.write(JSON.stringify({ event: "acceptance-scenario", ok: true, ...report.results.at(-1) }) + "\n");

  const eventFile = workspace.env.HY_ACCEPTANCE_CLIENT_EVENTS!;
  const events = existsSync(eventFile)
    ? readFileSync(eventFile, "utf8").split(/\r?\n/).filter(Boolean)
    : [];
  if (events.some(line => JSON.parse(line).action === "remote-write-attempt")) {
    throw new Error("A client attempted a remote write during acceptance");
  }
  assertNoSymlinkEscape(workspace.root);
  assertWorkspaceDiskBudget(workspace);
  report.completedScenarios = report.results.length;
  if (report.completedScenarios !== report.expectedScenarios) {
    throw new Error(`Acceptance completed ${report.completedScenarios}/${report.expectedScenarios}; skips are forbidden`);
  }
  report.ok = true;
}

let totalTimer: NodeJS.Timeout | undefined;
let timedOut = false;
const mainPromise = main();
try {
  await Promise.race([
    mainPromise,
    new Promise<never>((_, reject) => {
      totalTimer = setTimeout(() => {
        timedOut = true;
        const error = new Error("Release acceptance exceeded total timeout " + totalTimeoutMs + "ms");
        abortAcceptance(error);
        reject(error);
      }, totalTimeoutMs);
    }),
  ]);
} catch (error: any) {
  report.error = error?.stack ?? error?.message ?? String(error);
  if (timedOut) {
    try { await mainPromise; } catch {}
  }
  report.ok = false;
  process.exitCode = 1;
} finally {
  if (totalTimer) clearTimeout(totalTimer);
  terminateAllAcceptanceChildren();
  report.durationMs = Date.now() - started;
  report.completedScenarios = report.results.length;
  try {
    assertWorkspaceDiskBudget(workspace);
  } catch (error: any) {
    report.error ??= error?.stack ?? error?.message ?? String(error);
    report.ok = false;
    process.exitCode = 1;
  }
  report.workspaceDisk = { ...workspace.disk };
  const reportPath = join(workspace.reports, "acceptance-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ event: "acceptance-complete", reportPath, ...report }) + "\n");
}
