import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const yaml = readFileSync("templates/hy-workflow.yml", "utf-8");
for (const token of [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "No supported project ecosystem detected",
  "No native verification command detected",
  "npm fallback requires package-lock.json or npm-shrinkwrap.json",
  "ci.commands must be a non-empty string array",
  "const standardChecks = ['build', 'typecheck', 'check', 'lint', 'test']",
  "const yarnV1 = /^yarn@1",
  "exists('tests') || exists('test')",
  "exists('Cargo.lock') ? 'cargo test --workspace --all-targets --locked' : 'cargo test --workspace --all-targets'",
]) {
  assert(yaml.includes(token), `cross-ecosystem workflow token missing: ${token}`);
}

const nativeMarker = "      - name: Run native project CI\n";
const nativeStart = yaml.indexOf(nativeMarker);
assert(nativeStart >= 0, "native CI step missing");
const nativeEnd = yaml.indexOf("      - name: Run built-in doclint and codelint\n", nativeStart);
assert(nativeEnd > nativeStart, "native CI step boundary missing");
const nativeStep = yaml.slice(nativeStart, nativeEnd);
const heredocStart = nativeStep.indexOf("          node <<'NODE'\n");
const heredocEnd = nativeStep.indexOf("\n          NODE", heredocStart);
assert(heredocStart >= 0 && heredocEnd > heredocStart, "native CI Node program missing");
const program = nativeStep
  .slice(heredocStart + "          node <<'NODE'\n".length, heredocEnd)
  .split("\n")
  .map(line => line.startsWith("          ") ? line.slice(10) : line)
  .join("\n");

function exercise(config: unknown, files: Record<string, string>, expected: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "hy-native-ci-"));
  writeFileSync(join(root, "hy-workflow.json"), JSON.stringify(config));
  for (const [file, value] of Object.entries(files)) writeFileSync(join(root, file), value);
  const result = spawnSync(process.execPath, ["-e", program], { cwd: root, encoding: "utf-8", timeout: 10_000 });
  assert((result.status === 0) === expected, `native CI expectation mismatch: ${result.stderr || result.stdout}`);
  return root;
}

const explicitRoot = exercise(
  { project: {}, ci: { commands: [`${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('native-ran','ok')"`] } },
  {},
  true,
);
assert(existsSync(join(explicitRoot, "native-ran")), "explicit ci.commands must execute");
exercise({ project: {} }, {}, false);
exercise({ project: {}, ci: { commands: [] } }, {}, false);
exercise({ project: {} }, { "package.json": JSON.stringify({ scripts: {} }) }, false);
exercise({ project: {} }, { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, false);

console.log("setup-workflow-ecosystems: explicit and inferred CI fail-closed contract passes");
