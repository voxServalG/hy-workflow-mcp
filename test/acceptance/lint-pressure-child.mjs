import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [tool, mode = "scan"] = process.argv.slice(2);
if (tool !== "doclint" && tool !== "codelint") throw new Error("lint pressure child requires doclint or codelint");
if (mode !== "prepare" && mode !== "scan") throw new Error("lint pressure child mode must be prepare or scan");
const packageRoot = process.env.HY_ACCEPTANCE_PACKAGE_ROOT;
if (!packageRoot) throw new Error("HY_ACCEPTANCE_PACKAGE_ROOT is required");
const installedRoot = realpathSync(packageRoot);
const checksPath = join(installedRoot, "dist", "checks.js");
const configPath = join(installedRoot, "dist", "config.js");
const profilePath = join(installedRoot, "dist", "project-profile.js");
if (!existsSync(checksPath) || !existsSync(configPath) || !existsSync(profilePath)) throw new Error("installed acceptance package is missing lint runtime modules");

const [{ DOCLINT_SOURCE, CODELINT_SOURCE, DOCLINT_INTEGRITY_SHA512, CODELINT_INTEGRITY_SHA512 }, { withRuntimeCompatConfigs }, { inspectProject }] = await Promise.all([
  import(pathToFileURL(checksPath).href),
  import(pathToFileURL(configPath).href),
  import(pathToFileURL(profilePath).href),
]);
const source = tool === "doclint" ? DOCLINT_SOURCE : CODELINT_SOURCE;
const expectedSha512 = tool === "doclint" ? DOCLINT_INTEGRITY_SHA512 : CODELINT_INTEGRITY_SHA512;
if (!/^https:\/\/codeload\.github\.com\/voxServalG\/(?:doclint|codelint)\/tar\.gz\/[0-9a-f]{40}$/.test(source)) throw new Error("lint source must be an immutable codeload commit");
if (!/^[0-9a-f]{128}$/.test(expectedSha512)) throw new Error("lint source must declare a SHA-512 integrity pin");
const archiveRootInput = process.env.HY_ACCEPTANCE_LINT_ARCHIVE_DIR;
if (!archiveRootInput) throw new Error("HY_ACCEPTANCE_LINT_ARCHIVE_DIR is required");
mkdirSync(archiveRootInput, { recursive: true, mode: 0o700 });
const archiveRoot = realpathSync(archiveRootInput);
const commit = source.match(/\/([0-9a-f]{40})$/)?.[1];
if (!commit) throw new Error("lint source has no full commit");
const archivePath = join(archiveRoot, `${tool}-${commit}.tar.gz`);
const command = tool === "doclint" ? "lint" : "check";
const timeoutMs = Number(process.env.HY_ACCEPTANCE_LINT_TIMEOUT_MS ?? 120_000);
const started = Date.now();
const digest = file => createHash("sha512").update(readFileSync(file)).digest("hex");
const failureResult = message => ({ status: 2, signal: null, stdout: "", stderr: message, error: null });
let phase = mode === "prepare" ? "download" : "scan";
let preparationError = null;
let result = null;
let profile = null;

if (mode === "prepare") {
  if (existsSync(archivePath) && digest(archivePath) !== expectedSha512) rmSync(archivePath, { force: true });
  if (!existsSync(archivePath)) {
    const temporary = archivePath + ".part";
    rmSync(temporary, { force: true });
    const download = spawnSync("curl", [
      "--fail", "--location", "--silent", "--show-error", "--http1.1",
      "--proto", "=https", "--proto-redir", "=https",
      "--connect-timeout", "15", "--max-time", "60",
      "--retry", "2", "--retry-all-errors", "--retry-delay", "1",
      "--output", temporary, source,
    ], {
      encoding: "utf8",
      env: process.env,
      timeout: Math.min(timeoutMs, 210_000),
      maxBuffer: 4 * 1024 * 1024,
    });
    if (download.error || download.status !== 0 || !existsSync(temporary)) {
      preparationError = `immutable codeload download failed: ${download.error?.message ?? download.stderr ?? `exit ${download.status}`}`;
      result = download;
      rmSync(temporary, { force: true });
    } else {
      const downloadedSha512 = digest(temporary);
      if (downloadedSha512 !== expectedSha512) {
        preparationError = `immutable codeload SHA-512 mismatch: expected ${expectedSha512}, got ${downloadedSha512}`;
        result = failureResult(preparationError);
        rmSync(temporary, { force: true });
      } else {
        renameSync(temporary, archivePath);
      }
    }
  }
  if (!result) {
    phase = "dependencies";
    result = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--yes", `--package=${archivePath}`, tool, "--help"],
      {
        encoding: "utf8",
        env: process.env,
        timeout: Math.max(1_000, timeoutMs - (Date.now() - started)),
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  }
} else if (!existsSync(archivePath) || digest(archivePath) !== expectedSha512) {
  preparationError = "prepared lint archive is missing or failed its SHA-512 pin";
  result = failureResult(preparationError);
} else {
  profile = inspectProject(process.cwd());
  result = withRuntimeCompatConfigs(process.cwd(), () => spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["--yes", "--offline", `--package=${archivePath}`, tool, command, "--json"],
    { encoding: "utf8", env: process.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
  ));
}

const codeExt = new Set(profile ? (Array.isArray(profile.codeExt) ? profile.codeExt : [profile.codeExt]).map(value => String(value).toLowerCase()) : []);
const lintDirs = profile ? profile.lintDirs.map(value => String(value).replace(/^\.\//, "").replace(/\/$/, "")) : [];
const inLintDir = file => lintDirs.some(dir => dir === "." || file === dir || file.startsWith(dir + "/"));
const extension = file => /(?:^|\/)(?:[^/]+)(\.[^./]+)$/.exec(file)?.[1]?.toLowerCase() ?? "";
const profileCodeFiles = profile ? profile.trackedFiles.filter(file => inLintDir(file) && codeExt.has(extension(file))) : [];
const supportedExt = new Set([".py", ".pyw", ".pyi", ".rs"]);
const supportedCodeFiles = profileCodeFiles.filter(file => supportedExt.has(extension(file)));
const durationMs = Date.now() - started;
const timedOut = result.error?.code === "ETIMEDOUT";
let report = null;
let parseError = null;
if (mode === "scan") {
  try {
    report = JSON.parse(result.stdout || "");
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
}
process.stdout.write(JSON.stringify({
  tool,
  mode,
  phase,
  source,
  archive: archivePath,
  expectedSha512,
  archiveSha512: existsSync(archivePath) ? digest(archivePath) : null,
  status: result.status,
  signal: result.signal,
  timedOut,
  durationMs,
  projectProfile: profile ? {
    kind: profile.kind,
    codeExt: [...codeExt],
    lintDirs,
    codeFiles: profileCodeFiles.length,
    supportedCodeFiles: supportedCodeFiles.length,
  } : null,
  report,
  parseError,
  spawnError: result.error?.message ?? null,
  stderrTail: [preparationError, result.stderr].filter(Boolean).join("\n").slice(-4_000),
}) + "\n");
if (timedOut || result.status === null || (mode === "prepare" && result.status !== 0) || (mode === "scan" && (parseError || !report))) process.exitCode = 2;
