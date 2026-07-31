import {
  IMMUTABLE_SAFETY_RULES,
  LEGACY_COMPATIBLE_POLICY_PROFILE,
  LINT_RULE_TO_POLICY_RULE,
  POLICY_PROFILES,
  POLICY_SEVERITIES,
  PROFILE_RULES,
  QUALITY_POLICY_RULES,
  isImmutableSafetyRule,
  isEffectivePolicyProfile,
  isPolicyProfile,
  isPolicySeverity,
  isQualityPolicyRule,
  type EffectivePolicyProfileName,
  type PolicyRuleId,
  type PolicySeverity,
} from "./profiles.js";

type JsonObject = Record<string, any>;

const RETIRED_DEPENDENCY_POLICY_RULES = new Set(["code.tier-dependency", "code.dependency-cycle"]);

function isRetiredDependencyPolicyRule(value: unknown): boolean {
  return typeof value === "string" && RETIRED_DEPENDENCY_POLICY_RULES.has(value);
}

export type PolicySource = {
  layer: "safety" | "profile" | "legacy" | "project" | "override" | "exception";
  reference: string;
  value: { severity?: PolicySeverity; warning?: number; error?: number };
};

export type EffectivePolicyRule = {
  id: PolicyRuleId;
  severity: PolicySeverity;
  immutable: boolean;
  warning?: number;
  error?: number;
  sources: PolicySource[];
};

export type EffectivePolicy = {
  profile: EffectivePolicyProfileName;
  file?: string;
  rules: Record<PolicyRuleId, EffectivePolicyRule>;
  diagnostics: string[];
};

export type PolicyExplanation = {
  rule: PolicyRuleId;
  file?: string;
  profile: EffectivePolicyProfileName;
  effective: Omit<EffectivePolicyRule, "sources">;
  sources: PolicySource[];
  diagnostics: string[];
};

export type PolicyResolveOptions = {
  file?: string;
  now?: Date | string;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function normalizedFile(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function globExpression(pattern: string): RegExp {
  const normalized = normalizedFile(pattern) ?? "";
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.-]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function matches(files: unknown, file: string | undefined): boolean {
  if (!file || !Array.isArray(files)) return false;
  return files.some(pattern => typeof pattern === "string" && globExpression(pattern).test(file));
}

function dateOnly(value: Date | string | undefined): string {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function copyValue(value: JsonObject): PolicySource["value"] {
  return {
    ...(isPolicySeverity(value.severity) ? { severity: value.severity } : {}),
    ...(positiveInteger(value.warning) ? { warning: value.warning } : {}),
    ...(positiveInteger(value.error) ? { error: value.error } : {}),
  };
}

function applyValue(rule: EffectivePolicyRule, value: JsonObject, source: Omit<PolicySource, "value">): void {
  const copied = copyValue(value);
  if (copied.severity !== undefined) rule.severity = copied.severity;
  if (copied.warning !== undefined) rule.warning = copied.warning;
  if (copied.error !== undefined) rule.error = copied.error;
  rule.sources.push({ ...source, value: copied });
}

function legacyLineValue(config: JsonObject, id: PolicyRuleId): { value: JsonObject; reference: string } | null {
  if (id !== "code.max-lines" && id !== "docs.max-lines") return null;
  const key = id === "code.max-lines" ? "codelint" : "doclint";
  const raw = object(config[key]);
  const error = positiveInteger(raw.maxLinesError) ?? positiveInteger(raw.maxLines);
  const warning = positiveInteger(raw.maxLinesWarning);
  if (warning === undefined && error === undefined) return null;
  return {
    value: { ...(warning === undefined ? {} : { warning }), ...(error === undefined ? {} : { error }) },
    reference: `${key}.maxLinesWarning/maxLinesError`,
  };
}

function profileName(config: JsonObject): EffectivePolicyProfileName {
  const configured = object(config.policy).profile;
  return isEffectivePolicyProfile(configured) ? configured : "standard";
}

function validateResolvedThresholds(rule: EffectivePolicyRule, diagnostics: string[]): void {
  if (rule.id !== "code.max-lines" && rule.id !== "docs.max-lines") return;
  if (rule.warning === undefined || rule.error === undefined) {
    const fallback = PROFILE_RULES.standard[rule.id];
    rule.warning ??= fallback.warning;
    rule.error ??= fallback.error;
  }
  if ((rule.warning ?? 0) > (rule.error ?? 0)) {
    diagnostics.push(`${rule.id} warning threshold exceeds its error threshold; using the error threshold for both`);
    rule.warning = rule.error;
  }
}

export function resolveEffectivePolicyRule(
  config: JsonObject,
  id: PolicyRuleId,
  options: PolicyResolveOptions = {},
): { rule: EffectivePolicyRule; diagnostics: string[]; profile: EffectivePolicyProfileName } {
  const profile = profileName(config);
  const profileValue = PROFILE_RULES[profile][id];
  const immutable = isImmutableSafetyRule(id);
  const rule: EffectivePolicyRule = {
    id,
    severity: profileValue.severity,
    immutable,
    ...(profileValue.warning === undefined ? {} : { warning: profileValue.warning }),
    ...(profileValue.error === undefined ? {} : { error: profileValue.error }),
    sources: [{
      layer: immutable ? "safety" : "profile",
      reference: immutable ? `immutable:${id}` : `profile:${profile}`,
      value: { ...profileValue },
    }],
  };
  const diagnostics: string[] = [];
  if (immutable) return { rule, diagnostics, profile };

  const legacy = legacyLineValue(config, id);
  if (legacy) applyValue(rule, legacy.value, { layer: "legacy", reference: legacy.reference });

  const policy = object(config.policy);
  const projectRules = object(policy.rules);
  if (projectRules[id] && typeof projectRules[id] === "object" && !Array.isArray(projectRules[id])) {
    applyValue(rule, object(projectRules[id]), { layer: "project", reference: `policy.rules.${id}` });
  }

  const file = normalizedFile(options.file);
  if (Array.isArray(policy.overrides)) {
    policy.overrides.forEach((candidate: unknown, index: number) => {
      const override = object(candidate);
      const value = object(object(override.rules)[id]);
      if (Object.keys(value).length && matches(override.files, file)) {
        applyValue(rule, value, { layer: "override", reference: `policy.overrides[${index}].rules.${id}` });
      }
    });
  }

  const today = dateOnly(options.now);
  if (Array.isArray(policy.exceptions)) {
    policy.exceptions.forEach((candidate: unknown, index: number) => {
      const exception = object(candidate);
      if (exception.rule !== id || !matches(exception.files, file)) return;
      if (typeof exception.expires !== "string" || exception.expires < today) {
        diagnostics.push(`policy.exceptions[${index}] for ${id} is expired and was not applied`);
        return;
      }
      const severity = isPolicySeverity(exception.severity) ? exception.severity : "off";
      applyValue(rule, { severity }, { layer: "exception", reference: `policy.exceptions[${index}]` });
    });
  }

  validateResolvedThresholds(rule, diagnostics);
  return { rule, diagnostics, profile };
}

export function resolveEffectivePolicy(config: JsonObject, options: PolicyResolveOptions = {}): EffectivePolicy {
  const ids = [...IMMUTABLE_SAFETY_RULES, ...QUALITY_POLICY_RULES] as PolicyRuleId[];
  const rules = {} as Record<PolicyRuleId, EffectivePolicyRule>;
  const diagnostics: string[] = [];
  let profile: EffectivePolicyProfileName = "standard";
  for (const id of ids) {
    const resolved = resolveEffectivePolicyRule(config, id, options);
    profile = resolved.profile;
    rules[id] = resolved.rule;
    diagnostics.push(...resolved.diagnostics);
  }
  return { profile, ...(options.file ? { file: normalizedFile(options.file) } : {}), rules, diagnostics };
}

export function explainEffectivePolicy(
  config: JsonObject,
  rule: PolicyRuleId,
  options: PolicyResolveOptions = {},
): PolicyExplanation {
  const resolved = resolveEffectivePolicyRule(config, rule, options);
  const { sources, ...effective } = resolved.rule;
  return {
    rule,
    ...(options.file ? { file: normalizedFile(options.file) } : {}),
    profile: resolved.profile,
    effective,
    sources,
    diagnostics: resolved.diagnostics,
  };
}

export function resolveLintPolicyRule(
  config: JsonObject,
  lintRule: string,
  file?: string,
  now?: Date | string,
): EffectivePolicyRule {
  const policyRule = LINT_RULE_TO_POLICY_RULE[lintRule as keyof typeof LINT_RULE_TO_POLICY_RULE];
  if (!policyRule) throw new Error(`Lint rule ${lintRule} has no configurable policy`);
  return resolveEffectivePolicyRule(config, policyRule, { file, now }).rule;
}

export function findingSeverity(
  rule: Pick<EffectivePolicyRule, "severity">,
  natural: "warning" | "error",
): "advisory" | "warning" | "error" | null {
  if (rule.severity === "off") return null;
  if (rule.severity === "advisory") return "advisory";
  if (rule.severity === "warning") return "warning";
  return natural;
}

function owns(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function policyTypeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function safePolicyGlob(value: string): boolean {
  if (!value || value.length > 300 || value.trim() !== value) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.includes("\\")) return false;
  if (/\0|\r|\n/.test(value) || value.split("/").some(part => part === "..")) return false;
  return /^[A-Za-z0-9._/*?-]+$/.test(value);
}

function validatePolicyFiles(value: unknown, field: string, file: string, issues: string[]): void {
  if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === "string")) {
    issues.push(`${file} ${field} must be a non-empty array of glob strings`);
    return;
  }
  for (const pattern of value as string[]) {
    if (!safePolicyGlob(pattern)) issues.push(`${file} ${field} contains an unsafe project-relative glob: ${pattern}`);
  }
}

function validatePolicyRuleValue(rule: string, value: unknown, field: string, file: string, issues: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${file} ${field} must be an object`);
    return;
  }
  const ruleValue = value as JsonObject;
  const unknown = Object.keys(ruleValue).filter(key => !["severity", "warning", "error"].includes(key));
  if (unknown.length) issues.push(`${file} ${field} has unknown fields: ${unknown.join(", ")}`);
  if (owns(ruleValue, "severity") && !isPolicySeverity(ruleValue.severity)) {
    issues.push(`${file} ${field}.severity must be one of ${POLICY_SEVERITIES.join(", ")}`);
  }
  const lineRule = rule === "code.max-lines" || rule === "docs.max-lines";
  for (const threshold of ["warning", "error"] as const) {
    if (!owns(ruleValue, threshold)) continue;
    if (!lineRule) issues.push(`${file} ${field}.${threshold} is only valid for max-lines rules`);
    else if (!Number.isSafeInteger(ruleValue[threshold]) || Number(ruleValue[threshold]) <= 0) {
      issues.push(`${file} ${field}.${threshold} must be a positive integer; got ${JSON.stringify(ruleValue[threshold])}`);
    }
  }
  const warning = positiveInteger(ruleValue.warning);
  const error = positiveInteger(ruleValue.error);
  if (warning !== undefined && error !== undefined && warning > error) {
    issues.push(`${file} ${field}.warning must not exceed ${field}.error`);
  }
}

function validatePolicyRules(value: unknown, field: string, file: string, issues: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${file} ${field} must be an object keyed by policy rule id`);
    return;
  }
  for (const [rule, ruleValue] of Object.entries(value as JsonObject)) {
    if (isRetiredDependencyPolicyRule(rule)) continue;
    if (isImmutableSafetyRule(rule)) {
      issues.push(`${file} ${field}.${rule} is an immutable safety invariant and cannot be overridden`);
      continue;
    }
    if (!isQualityPolicyRule(rule)) {
      issues.push(`${file} ${field} contains unknown rule ${rule}; quality rules are ${QUALITY_POLICY_RULES.join(", ")}`);
      continue;
    }
    validatePolicyRuleValue(rule, ruleValue, `${field}.${rule}`, file, issues);
  }
}

function validPolicyDate(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validatePolicyConfig(
  raw: JsonObject,
  options: { allowLegacyCompatible?: boolean; file?: string } = {},
): string[] {
  if (!owns(raw, "policy")) return [];
  const file = options.file ?? "hy-workflow.json";
  const issues: string[] = [];
  const candidate = raw.policy;
  const policy = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as JsonObject : {};
  if (policy !== candidate) issues.push(`${file} policy must be an object; got ${policyTypeName(candidate)}`);
  const unknown = Object.keys(policy).filter(key => !["profile", "rules", "overrides", "exceptions"].includes(key));
  if (unknown.length) issues.push(`${file} policy has unknown fields: ${unknown.join(", ")}`);
  if (owns(policy, "profile") && !isPolicyProfile(policy.profile)
    && !(options.allowLegacyCompatible && policy.profile === LEGACY_COMPATIBLE_POLICY_PROFILE)) {
    issues.push(`${file} policy.profile must be one of ${POLICY_PROFILES.join(", ")}`);
  }
  if (owns(policy, "rules")) validatePolicyRules(policy.rules, "policy.rules", file, issues);
  if (owns(policy, "overrides")) {
    if (!Array.isArray(policy.overrides)) issues.push(`${file} policy.overrides must be an array`);
    else policy.overrides.forEach((entry: unknown, index: number) => {
      const field = `policy.overrides[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push(`${file} ${field} must be an object`);
        return;
      }
      const override = entry as JsonObject;
      const extra = Object.keys(override).filter(key => !["files", "rules"].includes(key));
      if (extra.length) issues.push(`${file} ${field} has unknown fields: ${extra.join(", ")}`);
      validatePolicyFiles(override.files, `${field}.files`, file, issues);
      validatePolicyRules(override.rules, `${field}.rules`, file, issues);
    });
  }
  if (owns(policy, "exceptions")) {
    if (!Array.isArray(policy.exceptions)) issues.push(`${file} policy.exceptions must be an array`);
    else policy.exceptions.forEach((entry: unknown, index: number) => {
      const field = `policy.exceptions[${index}]`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        issues.push(`${file} ${field} must be an object`);
        return;
      }
      const exception = entry as JsonObject;
      const extra = Object.keys(exception).filter(key => !["rule", "files", "reason", "owner", "issue", "expires", "severity"].includes(key));
      if (extra.length) issues.push(`${file} ${field} has unknown fields: ${extra.join(", ")}`);
      if (isImmutableSafetyRule(exception.rule)) issues.push(`${file} ${field}.rule is immutable and cannot be excepted: ${exception.rule}`);
      else if (!isQualityPolicyRule(exception.rule) && !isRetiredDependencyPolicyRule(exception.rule)) issues.push(`${file} ${field}.rule must name a configurable quality rule`);
      validatePolicyFiles(exception.files, `${field}.files`, file, issues);
      for (const key of ["reason", "owner"] as const) {
        const value = exception[key];
        if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\0\r\n]/.test(value)) {
          issues.push(`${file} ${field}.${key} must be a non-empty trimmed single-line string`);
        }
      }
      if (owns(exception, "issue") && (typeof exception.issue !== "string" || !exception.issue.trim() || /[\0\r\n]/.test(exception.issue))) {
        issues.push(`${file} ${field}.issue must be a non-empty single-line string when configured`);
      }
      if (!validPolicyDate(exception.expires)) issues.push(`${file} ${field}.expires must be a real YYYY-MM-DD date`);
      if (owns(exception, "severity") && !["off", "advisory", "warning"].includes(exception.severity)) {
        issues.push(`${file} ${field}.severity must be off, advisory, or warning`);
      }
    });
  }
  return issues;
}

export function publicPolicyProfiles(): typeof POLICY_PROFILES {
  return POLICY_PROFILES;
}
