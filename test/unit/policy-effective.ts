import {
  explainEffectivePolicy,
  findingSeverity,
  resolveEffectivePolicy,
  resolveEffectivePolicyRule,
} from "../../src/policy/effective.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const layered = {
  project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
  codelint: { lintDirs: ["src"] },
  policy: {
    profile: "standard",
    rules: {
      "code.max-lines": { severity: "error", warning: 400, error: 900 },
    },
    overrides: [
      {
        files: ["test/**"],
        rules: { "code.max-lines": { severity: "warning", warning: 1000, error: 2000 } },
      },
    ],
    exceptions: [
      {
        rule: "code.max-lines",
        files: ["test/legacy.ts"],
        reason: "Tracked debt",
        owner: "platform",
        issue: "#421",
        expires: "2026-12-31",
      },
    ],
  },
};

const source = explainEffectivePolicy(layered, "code.max-lines", { file: "src/main.ts", now: "2026-07-30" });
assert(source.effective.warning === 400 && source.effective.error === 900 && source.effective.severity === "error", "project rule must override the selected profile");
assert(source.sources.map(item => item.layer).join(",") === "profile,project", `unexpected project precedence: ${JSON.stringify(source.sources)}`);

const testFile = explainEffectivePolicy(layered, "code.max-lines", { file: "test/example.ts", now: "2026-07-30" });
assert(testFile.effective.warning === 1000 && testFile.effective.error === 2000 && testFile.effective.severity === "warning", "matching path override must win after project rule");
assert(testFile.sources.at(-1)?.layer === "override", "explanation must identify the winning path override");

const excepted = explainEffectivePolicy(layered, "code.max-lines", { file: "test/legacy.ts", now: "2026-07-30" });
assert(excepted.effective.severity === "off" && excepted.sources.at(-1)?.layer === "exception", "active dated exception must be the final layer");
const expired = explainEffectivePolicy(layered, "code.max-lines", { file: "test/legacy.ts", now: "2027-01-01" });
assert(expired.effective.severity === "warning" && expired.diagnostics.some(item => item.includes("expired")), "expired exception must be ignored and explained");

const immutable = resolveEffectivePolicyRule({
  policy: { profile: "relaxed", rules: { "workflow.project-identity": { severity: "off" } } },
}, "workflow.project-identity").rule;
assert(immutable.immutable && immutable.severity === "error" && immutable.sources.length === 1, "immutable safety rules must ignore project attempts to disable them");

const legacy = resolveEffectivePolicy({
  codelint: { maxLines: 731 },
  doclint: { maxLines: 149 },
  policy: { profile: "legacy-compatible" },
});
assert(legacy.profile === "legacy-compatible", "detected legacy policy must be explainable by name");
assert(legacy.rules["code.max-lines"].warning === 300 && legacy.rules["code.max-lines"].error === 731, "legacy code maxLines must remain the hard threshold without changing its warning default");
assert(legacy.rules["docs.max-lines"].warning === 149 && legacy.rules["docs.max-lines"].error === 149, "effective warning must clamp to a lower legacy hard threshold");

const relaxed = resolveEffectivePolicyRule({ policy: { profile: "relaxed" } }, "docs.max-lines").rule;
assert(relaxed.severity === "advisory" && findingSeverity(relaxed, "error") === "advisory", "relaxed line limits must remain visible without blocking");
assert(findingSeverity({ severity: "off" }, "error") === null, "disabled quality rule must emit no finding");

console.log("policy-effective: profiles, immutable safety, precedence, explanations, and expiring exceptions pass");
