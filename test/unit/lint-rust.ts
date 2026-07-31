import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lintCode } from "../../templates/lint/code.mjs";
import { scanRustFile } from "../../templates/lint/rust.mjs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hy-lint-rust-"));
}

function write(project: string, relative: string, content: string): void {
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

const scanned = scanRustFile("src/lib.rs", [
  "/* outer /* nested */ done */",
  "use crate::{alpha::Thing, beta::{self, Value}};",
  "const RAW: &str = r###\"{ not syntax }\"###;",
  "mod child;",
  "",
].join("\n"));
assert(scanned.errors.length === 0, `valid Rust lexer failed: ${JSON.stringify(scanned.errors)}`);
assert(scanned.imports.some(item => item.segments.join("::").startsWith("crate::alpha")), `grouped use alpha missing: ${JSON.stringify(scanned.imports)}`);
assert(scanned.imports.some(item => item.segments.join("::").startsWith("crate::beta")), `nested grouped use beta missing: ${JSON.stringify(scanned.imports)}`);
assert(scanned.modules.some(item => item.name === "child"), `external mod declaration missing: ${JSON.stringify(scanned.modules)}`);

const broken = scanRustFile("src/broken.rs", "fn broken() { /* never closed");
assert(broken.errors.some(item => item.message.includes("unterminated Rust block comment")), `unterminated comment must fail: ${JSON.stringify(broken.errors)}`);
assert(broken.errors.some(item => item.message.includes("unclosed Rust delimiter")), `unclosed delimiter must fail: ${JSON.stringify(broken.errors)}`);

{
  const project = root();
  write(project, "src/lib.rs", "mod high;\nmod low;\n");
  write(project, "src/high.rs", "use crate::low::value;\npub fn value() {}\n");
  write(project, "src/low.rs", "use crate::high::value;\npub fn value() {}\n");
  const result = lintCode({
    root: project,
    config: {
      project: { codeExt: ".rs", codeDirs: ["src"], docsDir: "docs" },
      codelint: {
        lintDirs: ["src"],
        tiers: [
          { name: "high", paths: ["src/high.rs"] },
          { name: "low", paths: ["src/low.rs"] },
        ],
      },
    },
  });
  assert(!result.findings.some(item => item.rule === "C003" || item.rule === "C004"), `legacy Rust tiers must remain inert: ${JSON.stringify(result.findings)}`);
  assert(!result.findings.some(item => item.rule === "C005"), `valid Rust must not fail parser reliability: ${JSON.stringify(result.findings)}`);
}
