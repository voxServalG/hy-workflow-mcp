import * as path from "node:path";
import { requireRuntimeConfig, type JsonObject } from "./config.js";
import { resolveLintPolicyRule, type EffectivePolicyRule } from "./policy/effective.js";

export const LINT_SCHEMA = "hy-workflow.lint.v1" as const;
export const LINT_VERSION = 1 as const;

const RULES = ["D001", "D002", "D003", "D004", "D005", "C001", "C002", "C003", "C004", "C005"] as const;
type LintRule = typeof RULES[number];
type LintStatus = "passed" | "failed" | "warning" | "advisory" | "not_applicable" | "not_configured";

export type LintFinding = {
  rule: string;
  severity: "error" | "warning" | "advisory";
  path: string;
  line?: number;
  message: string;
};

export type LintReport = {
  schema: typeof LINT_SCHEMA;
  version: typeof LINT_VERSION;
  ok: boolean;
  root: ".";
  counts: { checks: number; failed: number; errors: number; warnings: number; advisories: number; files: number; docs: number; code: number };
  checks: Array<{ rule: LintRule; status: LintStatus; files: number; errors: number; warnings: number; advisories: number; message: string }>;
  findings: LintFinding[];
};

type LintModule = {
  runLint(options: {
    root: string;
    config: JsonObject;
    pythonCommand?: string;
    resolvePolicyRule(rule: LintRule, file?: string): EffectivePolicyRule;
  }): LintReport;
};

type LintArgs = {
  help: boolean;
  json: boolean;
  root: string;
  pythonCommand?: string;
  errors: string[];
};

function valueAfter(argv: string[], index: number, flag: string, errors: string[]): string | null {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    errors.push(`Missing value for ${flag}`);
    return null;
  }
  return value;
}

function parseLintArgs(argv: string[], cwd: string): LintArgs {
  const args: LintArgs = { help: false, json: false, root: cwd, errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--root" || arg === "--python") {
      const value = valueAfter(argv, index, arg, args.errors);
      if (value !== null) {
        if (arg === "--root") args.root = path.resolve(cwd, value);
        else args.pythonCommand = value;
        index += 1;
      }
    } else if (arg.startsWith("-")) args.errors.push(`Unknown lint option: ${arg}`);
    else args.errors.push(`Unexpected lint argument: ${arg}`);
  }
  return args;
}

function failedReport(message: string): LintReport {
  const finding: LintFinding = { rule: "C005", severity: "error", path: "hy-workflow.json", message };
  const checks = RULES.map(rule => {
    const status: LintStatus = rule === "C005"
      ? "failed"
      : rule === "C003"
        ? "not_configured"
        : rule === "D001" || rule === "C001"
          ? "passed"
          : "not_applicable";
    return {
      rule,
      status,
      files: 0,
      errors: rule === "C005" ? 1 : 0,
      warnings: 0,
      advisories: 0,
      message: rule === "C005" ? message : `${rule} ${status.replace("_", " ")}`,
    };
  });
  return {
    schema: LINT_SCHEMA,
    version: LINT_VERSION,
    ok: false,
    root: ".",
    counts: { checks: RULES.length, failed: 1, errors: 1, warnings: 0, advisories: 0, files: 0, docs: 0, code: 0 },
    checks,
    findings: [finding],
  };
}

function assertLintReport(value: unknown): asserts value is LintReport {
  const report = value as Partial<LintReport> | null;
  if (!report || report.schema !== LINT_SCHEMA || report.version !== LINT_VERSION || !Array.isArray(report.checks) || !Array.isArray(report.findings)) {
    throw new Error("internal lint engine returned an invalid report envelope");
  }
}

async function lintModule(): Promise<LintModule> {
  const loaded = await import(new URL("../templates/lint/index.mjs", import.meta.url).href) as Partial<LintModule>;
  if (typeof loaded.runLint !== "function") throw new Error("internal lint engine does not export runLint");
  return loaded as LintModule;
}

export async function runInternalLint(root: string, pythonCommand?: string): Promise<LintReport> {
  const config = requireRuntimeConfig(root);
  const engine = await lintModule();
  const report = engine.runLint({
    root,
    config,
    pythonCommand,
    resolvePolicyRule: (rule, file) => resolveLintPolicyRule(config, rule, file),
  });
  assertLintReport(report);
  return report;
}

export function lintHelp(): string {
  return [
    "Usage:",
    "  hy-workflow lint --json",
    "  hy-workflow lint --json --root project-dir",
    "  hy-workflow lint --json --python python3",
    "",
    "Runs the built-in D001-D005 and C001-C005 rules without generating compatibility JSON.",
  ].join("\n");
}

export async function runLintCli(argv: string[], cwd = process.cwd()): Promise<{ exitCode: number; stdout: string; report?: LintReport }> {
  const args = parseLintArgs(argv, cwd);
  if (args.help) return { exitCode: 0, stdout: lintHelp() + "\n" };
  let report: LintReport;
  try {
    if (args.errors.length) throw new Error(args.errors.join("; "));
    report = await runInternalLint(path.resolve(args.root), args.pythonCommand);
  } catch (error: any) {
    report = failedReport(`C005 scanner reliability failure: ${error?.message ?? String(error)}`);
  }
  return { exitCode: report.ok ? 0 : 1, stdout: JSON.stringify(report) + "\n", report };
}
