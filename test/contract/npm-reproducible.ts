import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmPackReport, parseNpmPackFiles } from "../../src/npm/package.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
mkdirSync(join(root, "dist"), { recursive: true });
writeFileSync(join(root, "dist", "orphan-from-old-build.js"), "stale\n");
const preview = npmPackReport(root, true);
assert(!parseNpmPackFiles(preview).includes("dist/orphan-from-old-build.js"), "prepack must remove stale compiled files");

const firstDir = mkdtempSync(join(tmpdir(), "hy-pack-first-"));
const secondDir = mkdtempSync(join(tmpdir(), "hy-pack-second-"));
const first = npmPackReport(root, false, firstDir)[0];
const second = npmPackReport(root, false, secondDir)[0];
assert(first?.filename && second?.filename, "npm pack must return a tarball filename");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
assert(
  digest(join(firstDir, first.filename!)) === digest(join(secondDir, second.filename!)),
  "two clean packs from one commit must be byte-for-byte reproducible",
);
assert(
  JSON.stringify(parseNpmPackFiles([first])) === JSON.stringify(parseNpmPackFiles([second])),
  "two clean packs must have the same sorted file manifest",
);

console.log("npm-reproducible: polluted dist is cleaned and consecutive tarballs match");
