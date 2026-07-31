export const POLICY_PROFILES = ["relaxed", "standard", "strict"] as const;
export type PolicyProfileName = typeof POLICY_PROFILES[number];
export const LEGACY_COMPATIBLE_POLICY_PROFILE = "legacy-compatible" as const;
export type EffectivePolicyProfileName = PolicyProfileName | typeof LEGACY_COMPATIBLE_POLICY_PROFILE;

export const POLICY_SEVERITIES = ["off", "advisory", "warning", "error"] as const;
export type PolicySeverity = typeof POLICY_SEVERITIES[number];

export const QUALITY_POLICY_RULES = [
  "docs.reachability",
  "docs.links",
  "docs.structure",
  "docs.max-lines",
  "code.max-lines",
  "code.tier-dependency",
  "code.dependency-cycle",
] as const;
export type QualityPolicyRuleId = typeof QUALITY_POLICY_RULES[number];

export const IMMUTABLE_SAFETY_RULES = [
  "docs.scan-integrity",
  "code.scan-integrity",
  "code.parser-integrity",
  "project.path-boundary",
  "workflow.scope-boundary",
  "workflow.evidence-current",
  "workflow.project-identity",
] as const;
export type ImmutableSafetyRuleId = typeof IMMUTABLE_SAFETY_RULES[number];
export type PolicyRuleId = QualityPolicyRuleId | ImmutableSafetyRuleId;

export type ProfileRule = {
  severity: Exclude<PolicySeverity, "off">;
  warning?: number;
  error?: number;
};

export const LINT_RULE_TO_POLICY_RULE = {
  D001: "docs.scan-integrity",
  D002: "docs.reachability",
  D003: "docs.links",
  D004: "docs.structure",
  D005: "docs.max-lines",
  C001: "code.scan-integrity",
  C002: "code.max-lines",
  C003: "code.tier-dependency",
  C004: "code.dependency-cycle",
  C005: "code.parser-integrity",
} as const satisfies Record<string, PolicyRuleId>;

export const POLICY_RULE_TO_LINT_RULE = Object.fromEntries(
  Object.entries(LINT_RULE_TO_POLICY_RULE).map(([lintRule, policyRule]) => [policyRule, lintRule]),
) as Record<PolicyRuleId, keyof typeof LINT_RULE_TO_POLICY_RULE>;

const SAFETY_DEFAULTS: Record<ImmutableSafetyRuleId, ProfileRule> = {
  "docs.scan-integrity": { severity: "error" },
  "code.scan-integrity": { severity: "error" },
  "code.parser-integrity": { severity: "error" },
  "project.path-boundary": { severity: "error" },
  "workflow.scope-boundary": { severity: "error" },
  "workflow.evidence-current": { severity: "error" },
  "workflow.project-identity": { severity: "error" },
};

export const PROFILE_RULES: Record<EffectivePolicyProfileName, Record<PolicyRuleId, ProfileRule>> = {
  relaxed: {
    ...SAFETY_DEFAULTS,
    "docs.reachability": { severity: "warning" },
    "docs.links": { severity: "warning" },
    "docs.structure": { severity: "warning" },
    "docs.max-lines": { severity: "advisory", warning: 300, error: 800 },
    "code.max-lines": { severity: "advisory", warning: 500, error: 1200 },
    "code.tier-dependency": { severity: "warning" },
    "code.dependency-cycle": { severity: "warning" },
  },
  standard: {
    ...SAFETY_DEFAULTS,
    "docs.reachability": { severity: "error" },
    "docs.links": { severity: "error" },
    "docs.structure": { severity: "error" },
    "docs.max-lines": { severity: "error", warning: 200, error: 500 },
    "code.max-lines": { severity: "error", warning: 300, error: 500 },
    "code.tier-dependency": { severity: "error" },
    "code.dependency-cycle": { severity: "error" },
  },
  strict: {
    ...SAFETY_DEFAULTS,
    "docs.reachability": { severity: "error" },
    "docs.links": { severity: "error" },
    "docs.structure": { severity: "error" },
    "docs.max-lines": { severity: "error", warning: 120, error: 300 },
    "code.max-lines": { severity: "error", warning: 200, error: 350 },
    "code.tier-dependency": { severity: "error" },
    "code.dependency-cycle": { severity: "error" },
  },
  "legacy-compatible": {
    ...SAFETY_DEFAULTS,
    "docs.reachability": { severity: "error" },
    "docs.links": { severity: "error" },
    "docs.structure": { severity: "error" },
    "docs.max-lines": { severity: "error", warning: 200, error: 500 },
    "code.max-lines": { severity: "error", warning: 300, error: 500 },
    "code.tier-dependency": { severity: "error" },
    "code.dependency-cycle": { severity: "error" },
  },
};

export function isPolicyProfile(value: unknown): value is PolicyProfileName {
  return typeof value === "string" && (POLICY_PROFILES as readonly string[]).includes(value);
}

export function isEffectivePolicyProfile(value: unknown): value is EffectivePolicyProfileName {
  return isPolicyProfile(value) || value === LEGACY_COMPATIBLE_POLICY_PROFILE;
}

export function isPolicySeverity(value: unknown): value is PolicySeverity {
  return typeof value === "string" && (POLICY_SEVERITIES as readonly string[]).includes(value);
}

export function isQualityPolicyRule(value: unknown): value is QualityPolicyRuleId {
  return typeof value === "string" && (QUALITY_POLICY_RULES as readonly string[]).includes(value);
}

export function isImmutableSafetyRule(value: unknown): value is ImmutableSafetyRuleId {
  return typeof value === "string" && (IMMUTABLE_SAFETY_RULES as readonly string[]).includes(value);
}
