import * as agentsRules from "../../src/setup/agents-rules.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(agentsRules.AGENTS_INJECTION_RETIRED, "the retired module must identify itself as a permanent tombstone");
assert(
  JSON.stringify(Object.keys(agentsRules).sort()) === JSON.stringify(["AGENTS_INJECTION_RETIRED"]),
  `the published tombstone must not expose legacy marker, parser, hash, or migration APIs: ${Object.keys(agentsRules).join(", ")}`,
);

console.log("agents-rules: published module is a marker-free parser-free tombstone");
