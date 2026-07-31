import * as fs from "node:fs";
import * as path from "node:path";
import { isRuntimeIgnoredArtifact, isWorkflowAuthorityExcludedArtifact } from "./policy/artifacts.js";
import type { PlanDoc, PlanScopeAmendment } from "./state.js";

function hasProjectPathMarkers(root: string): boolean {
  return ["package.json", "src", "docs"].some(file => fs.existsSync(path.join(root, file)));
}

export type ScopeValidationMode = "plan" | "amendment" | "verify";

export type PlanValidationResult =
  | { ok: true; plan: PlanDoc }
  | { ok: false; errors: string[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function error(path: string, message: string): string {
  return `${path}: ${message}`;
}

function stringAt(value: Record<string, unknown>, key: string, pathName: string, errors: string[]): string {
  const current = value[key];
  if (typeof current !== "string") {
    errors.push(error(pathName, "must be a string"));
    return "";
  }
  return current;
}

function booleanAt(value: Record<string, unknown>, key: string, pathName: string, errors: string[]): boolean {
  const current = value[key];
  if (typeof current !== "boolean") {
    errors.push(error(pathName, "must be a boolean"));
    return false;
  }
  return current;
}

function stringArrayAt(value: Record<string, unknown>, key: string, pathName: string, errors: string[]): string[] {
  const current = value[key];
  if (current === null || current === undefined) return [];
  if (!Array.isArray(current)) {
    errors.push(error(pathName, "must be an array of strings"));
    return [];
  }
  const result: string[] = [];
  current.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(error(`${pathName}[${index}]`, "must be a string"));
      return;
    }
    result.push(item);
  });
  return result;
}

function objectAt(value: Record<string, unknown>, key: string, pathName: string, errors: string[]): Record<string, unknown> {
  const current = value[key];
  if (!isRecord(current)) {
    errors.push(error(pathName, "must be an object"));
    return {};
  }
  return current;
}

function checkArrayAt(value: Record<string, unknown>, key: string, pathName: string, errors: string[]): PlanDoc["verify"]["smoke"] {
  const current = value[key];
  if (!Array.isArray(current)) {
    errors.push(error(pathName, "must be an array of check objects"));
    return [];
  }

  return current.map((item, index) => {
    const itemPath = `${pathName}[${index}]`;
    if (!isRecord(item)) {
      errors.push(error(itemPath, "must be an object"));
      return { command: "", expected_exit: 0, description: "" };
    }

    const expected = item.expected_exit;
    if (typeof expected !== "number" || !Number.isFinite(expected)) {
      errors.push(error(`${itemPath}.expected_exit`, "must be a finite number"));
    }

    return {
      command: stringAt(item, "command", `${itemPath}.command`, errors),
      expected_exit: typeof expected === "number" && Number.isFinite(expected) ? expected : 0,
      description: stringAt(item, "description", `${itemPath}.description`, errors),
    };
  });
}

export function normalizePlanDoc(input: unknown): PlanValidationResult {
  if (!isRecord(input)) {
    return { ok: false, errors: ["PlanDoc must be an object"] };
  }

  // Fast path: if the input already has string task and looks like a PlanDoc, use it as-is
  // but still normalize nested fields for safety.
  if (typeof input.task === "string" && input.scope && typeof input.scope === "object" && !Array.isArray(input.scope)) {
    // Looks like a PlanDoc — still normalize to be safe
  }

  const errors: string[] = [];
  const scope = objectAt(input, "scope", "scope", errors);
  const boundary = objectAt(input, "boundary", "boundary", errors);
  const verify = objectAt(input, "verify", "verify", errors);
  const platform = objectAt(verify, "platform", "verify.platform", errors);

  const risks = stringArrayAt(input, "risks", "risks", errors);

  const plan: PlanDoc = {
    task: stringAt(input, "task", "task", errors),
    scope: {
      changes: stringArrayAt(scope, "changes", "scope.changes", errors),
      new_files: stringArrayAt(scope, "new_files", "scope.new_files", errors),
      delete: stringArrayAt(scope, "delete", "scope.delete", errors),
    },
    boundary: {
      dependency_dag: stringAt(boundary, "dependency_dag", "boundary.dependency_dag", errors),
      entry_points: stringArrayAt(boundary, "entry_points", "boundary.entry_points", errors),
      no_new_external: booleanAt(boundary, "no_new_external", "boundary.no_new_external", errors),
    },
    verify: {
      platform: {
        python_version: stringAt(platform, "python_version", "verify.platform.python_version", errors),
        setup: stringArrayAt(platform, "setup", "verify.platform.setup", errors),
      },
      smoke: checkArrayAt(verify, "smoke", "verify.smoke", errors),
      tests: checkArrayAt(verify, "tests", "verify.tests", errors),
    },
    risks,
    discussion: stringAt(input, "discussion", "discussion", errors),
    branch: typeof input.branch === "string" ? input.branch : null,
    verify_hash: typeof input.verify_hash === "string" ? input.verify_hash : null,
    pr_number: typeof input.pr_number === "number" && Number.isSafeInteger(input.pr_number) && input.pr_number > 0 ? input.pr_number : null,
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan };
}

function normalizeProjectRelativePath(root: string, field: string, file: string, errors: string[]): string | null {
  const trimmed = file.trim();
  if (!trimmed) {
    errors.push(error(field, "<empty> is not a valid project path"));
    return null;
  }

  const normalized = trimmed.replace(/\\/g, "/");
  if (path.isAbsolute(trimmed) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    errors.push(error(field, `${file} is outside the project root`));
    return null;
  }

  const resolved = path.resolve(root, trimmed);
  const rel = path.relative(root, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    errors.push(error(field, `${file} is outside the project root`));
    return null;
  }

  return rel.replace(/\\/g, "/");
}

export function validatePlanScopePaths(root: string, plan: PlanDoc, mode: ScopeValidationMode = "plan"): string[] {
  const errors: string[] = [];
  const enforceExistence = mode !== "verify" && hasProjectPathMarkers(root);
  const rejectExcluded = (
    field: "scope.changes" | "scope.new_files" | "scope.delete",
    file: string,
    normalized: string,
  ): boolean => {
    if (isWorkflowAuthorityExcludedArtifact(normalized)) {
      errors.push(error(
        field,
        `${file} is permanently outside hy-workflow authority; legacy ignored and local/runtime artifacts cannot be declared in PlanDoc scope`,
      ));
      return true;
    }
    if (isRuntimeIgnoredArtifact(root, normalized)) {
      errors.push(error(
        field,
        `${file} is not authoritative for this project; new project artifacts require the exact external minimal-v1 deployment marker`,
      ));
      return true;
    }
    return false;
  };
  const requireExisting = (field: "scope.changes" | "scope.delete", file: string) => {
    const normalized = normalizeProjectRelativePath(root, field, file, errors);
    if (!normalized) return;
    if (rejectExcluded(field, file, normalized)) return;
    if (enforceExistence && !fs.existsSync(path.join(root, normalized))) {
      errors.push(error(field, `${file} does not exist`));
    }
  };
  const allowPlanned = (field: "scope.new_files", file: string) => {
    const normalized = normalizeProjectRelativePath(root, field, file, errors);
    if (!normalized) return;
    rejectExcluded(field, file, normalized);
  };

  for (const file of plan.scope.changes) requireExisting("scope.changes", file);
  for (const file of plan.scope.delete) requireExisting("scope.delete", file);
  for (const file of plan.scope.new_files) allowPlanned("scope.new_files", file);

  if (mode === "amendment") {
    const all = [...plan.scope.changes, ...plan.scope.new_files, ...plan.scope.delete];
    if (all.length === 0) {
      errors.push("scope: amended PlanDoc scope is empty");
    }
  }

  return errors;
}

function validateAmendmentList(field: string, values: unknown, errors: string[]): string[] {
  if (!Array.isArray(values)) {
    errors.push(error(field, "must be an array of strings"));
    return [];
  }
  const result: string[] = [];
  values.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(error(`${field}[${index}]`, "must be a string"));
      return;
    }
    result.push(item);
  });
  return result;
}

function amendmentBucket(value: unknown, field: string, errors: string[]): { add: string[]; remove: string[] } {
  if (!isRecord(value)) {
    errors.push(error(field, "must be an object with add/remove arrays"));
    return { add: [], remove: [] };
  }
  return {
    add: validateAmendmentList(`${field}.add`, value.add, errors),
    remove: validateAmendmentList(`${field}.remove`, value.remove, errors),
  };
}

export function normalizePlanScopeAmendment(input: unknown): { ok: true; scope: PlanScopeAmendment } | { ok: false; errors: string[] } {
  if (!isRecord(input)) {
    return { ok: false, errors: ["pendingAmendment.scope: must be an object"] };
  }
  const errors: string[] = [];
  const scope: PlanScopeAmendment = {
    changes: amendmentBucket(input.changes, "pendingAmendment.scope.changes", errors),
    new_files: amendmentBucket(input.new_files, "pendingAmendment.scope.new_files", errors),
    delete: amendmentBucket(input.delete, "pendingAmendment.scope.delete", errors),
  };

  if (errors.length) return { ok: false, errors };
  return { ok: true, scope };
}

export function validateAmendmentPaths(root: string, amendment: PlanScopeAmendment): string[] {
  const plan: PlanDoc = {
    task: "amendment path validation",
    scope: {
      changes: [...amendment.changes.add, ...amendment.changes.remove],
      new_files: [...amendment.new_files.add, ...amendment.new_files.remove],
      delete: [...amendment.delete.add, ...amendment.delete.remove],
    },
    boundary: { dependency_dag: "", entry_points: [], no_new_external: true },
    verify: { platform: { python_version: "", setup: [] }, smoke: [], tests: [] },
    risks: [],
    discussion: "",
    branch: null,
    verify_hash: null,
    pr_number: null,
  };
  return validatePlanScopePaths(root, plan);
}
