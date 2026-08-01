import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type PackEntry = { filename?: unknown; files?: Array<{ path?: unknown }> };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const npmExecPath = process.env.npm_execpath;
assert(npmExecPath && existsSync(npmExecPath), "npm_execpath is required; run this contract through npm");
const npmCli = npmExecPath;

function pack(destination: string): { archive: string; files: string[] } {
  const result = spawnSync(process.execPath, [npmCli, "pack", "--json", "--pack-destination", destination], {
    cwd: root,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
    encoding: "utf8",
    shell: false,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert(!result.error, `npm pack failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(result.status === 0, `npm pack failed (${String(result.status)}):\n${result.stderr}`);
  const report: PackEntry[] = JSON.parse(result.stdout);
  assert(Array.isArray(report) && report.length === 1 && typeof report[0]?.filename === "string", "npm pack must report exactly one tarball");
  const archive = join(destination, report[0].filename as string);
  assert(existsSync(archive), "npm pack reported a missing tarball");
  const files = (report[0].files ?? []).flatMap(file => typeof file.path === "string" ? [file.path] : []).sort();
  return { archive, files };
}

const firstDirectory = mkdtempSync(join(tmpdir(), "hy-pack-first-"));
const secondDirectory = mkdtempSync(join(tmpdir(), "hy-pack-second-"));
const stale = join(root, "dist", "stale-from-previous-build.js");
try {
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(stale, "stale first build\n", "utf8");
  const first = pack(firstDirectory);
  assert(!first.files.includes("dist/stale-from-previous-build.js"), "prepack did not remove stale compiled output");

  writeFileSync(stale, "different stale second build\n", "utf8");
  const second = pack(secondDirectory);
  assert(!second.files.includes("dist/stale-from-previous-build.js"), "second prepack did not start from a clean dist directory");

  const digest = (file: string): string => createHash("sha512").update(readFileSync(file)).digest("hex");
  assert(digest(first.archive) === digest(second.archive), "two clean packs from the same tree must be byte-for-byte reproducible");
  assert(JSON.stringify(first.files) === JSON.stringify(second.files), "two clean packs must expose the same sorted file manifest");
} finally {
  rmSync(firstDirectory, { recursive: true, force: true });
  rmSync(secondDirectory, { recursive: true, force: true });
  rmSync(stale, { force: true });
}

process.stdout.write("reproducible-pack: stale dist cleanup and consecutive SHA-512 equality pass\n");
