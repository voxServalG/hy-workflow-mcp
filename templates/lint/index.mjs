import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { lintCode } from "./code.mjs";
import { lintDocs } from "./docs.mjs";

export const LINT_SCHEMA = "hy-workflow.lint.v1";
export const LINT_VERSION = 1;
export const RULES = ["D001", "D002", "D003", "D004", "D005", "C001", "C002", "C003", "C004", "C005"];

function stableFindings(findings) {
  return findings
    .map(item => ({
      rule: item.rule,
      severity: item.severity,
      path: item.path,
      ...(Number.isInteger(item.line) && item.line > 0 ? { line: item.line } : {}),
      message: item.message,
    }))
    .sort((left, right) => {
      const leftKey = [left.rule, left.path, left.line ?? 0, left.message].join("\u0000");
      const rightKey = [right.rule, right.path, right.line ?? 0, right.message].join("\u0000");
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function checkStatus(rule, ruleFindings, context) {
  if (ruleFindings.some(item => item.severity === "error")) return "failed";
  if (ruleFindings.some(item => item.severity === "warning")) return "warning";
  if (rule === "C003" && !context.tierConfigured) return "not_configured";
  if ((rule === "C004" || rule === "C005") && !context.supportsDependencies) return "not_applicable";
  if (rule.startsWith("D") && context.docsFiles === 0 && rule !== "D001") return "not_applicable";
  if (rule.startsWith("C") && context.codeFiles === 0 && rule !== "C001") return "not_applicable";
  return "passed";
}

function checkMessage(rule, status, errors, warnings, files) {
  if (status === "not_configured") return `${rule} is not configured`;
  if (status === "not_applicable") return `${rule} is not applicable`;
  if (status === "passed") return `${rule} passed across ${files} file${files === 1 ? "" : "s"}`;
  return `${rule} produced ${errors} error${errors === 1 ? "" : "s"} and ${warnings} warning${warnings === 1 ? "" : "s"}`;
}

function buildReport(root, docs, code, extraFindings = []) {
  const findings = stableFindings([...docs.findings, ...code.findings, ...extraFindings]);
  const context = {
    docsFiles: docs.files.length,
    codeFiles: code.files.length,
    tierConfigured: code.tierConfigured,
    supportsDependencies: code.supportsDependencies,
  };
  const checks = RULES.map(rule => {
    const ruleFindings = findings.filter(item => item.rule === rule);
    const errors = ruleFindings.filter(item => item.severity === "error").length;
    const warnings = ruleFindings.filter(item => item.severity === "warning").length;
    const files = rule.startsWith("D") ? docs.files.length : code.files.length;
    const status = checkStatus(rule, ruleFindings, context);
    return { rule, status, files, errors, warnings, message: checkMessage(rule, status, errors, warnings, files) };
  });
  const errors = findings.filter(item => item.severity === "error").length;
  const warnings = findings.filter(item => item.severity === "warning").length;
  return {
    schema: LINT_SCHEMA,
    version: LINT_VERSION,
    ok: errors === 0,
    root: ".",
    counts: {
      checks: RULES.length,
      failed: checks.filter(check => check.status === "failed").length,
      errors,
      warnings,
      files: docs.files.length + code.files.length,
      docs: docs.files.length,
      code: code.files.length,
    },
    checks,
    findings,
  };
}

function emptyDocs(findings = []) {
  return { files: [], findings, parsed: new Map(), entries: [] };
}

function emptyCode(findings = []) {
  return {
    files: [],
    findings,
    graph: new Map(),
    scans: new Map(),
    tierConfigured: false,
    supportsDependencies: false,
  };
}

export function runLint({ root, config, pythonCommand } = {}) {
  const projectRoot = path.resolve(root ?? process.cwd());
  const runtimeConfig = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  let docs;
  let code;
  try {
    docs = lintDocs({ root: projectRoot, config: runtimeConfig });
  } catch (error) {
    docs = emptyDocs([{
      rule: "D001",
      severity: "error",
      path: runtimeConfig?.project?.docsDir ?? ".",
      message: `documentation scan failed: ${error?.message ?? String(error)}`,
    }]);
  }
  try {
    code = lintCode({ root: projectRoot, config: runtimeConfig, pythonCommand });
  } catch (error) {
    code = emptyCode([{
      rule: "C005",
      severity: "error",
      path: ".",
      message: `code scan failed: ${error?.message ?? String(error)}`,
    }]);
  }
  return buildReport(projectRoot, docs, code);
}

function argumentValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return argv[index + 1];
}

function invalidConfigReport(root, message) {
  return buildReport(
    root,
    emptyDocs(),
    emptyCode([{ rule: "C005", severity: "error", path: "hy-workflow.json", message }]),
  );
}

export function main(argv = process.argv.slice(2), io = {}) {
  let root;
  let configPath;
  let pythonCommand;
  let report;
  try {
    root = path.resolve(argumentValue(argv, "--root") ?? process.cwd());
    configPath = path.resolve(root, argumentValue(argv, "--config") ?? "hy-workflow.json");
    pythonCommand = argumentValue(argv, "--python") ?? undefined;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("top-level value must be an object");
    report = runLint({ root, config, pythonCommand });
  } catch (error) {
    root ??= process.cwd();
    report = invalidConfigReport(root, `cannot load lint configuration: ${error?.message ?? String(error)}`);
  }
  const stdout = `${JSON.stringify(report)}\n`;
  const result = { report, exitCode: report.ok ? 0 : 1, stdout };
  if (typeof io.stdout === "function") io.stdout(stdout);
  return result;
}

const directPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (directPath && directPath === fileURLToPath(import.meta.url)) {
  const result = main();
  process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
