import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const project = readFileSync("src/helper/project.ts", "utf-8");
for (const token of ["resolveRuntimeConfig(root)", "completeExternalConfig", "projectPaths(root)", "writeDeployment", "atomicWriteJson(paths.config"]) {
  assert(project.includes(token), `helper project registration is missing deterministic external configuration token ${token}`);
}
for (const forbidden of [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "npm ci",
  "cargo test",
  "go test",
  "pytest",
  ".github/workflows",
]) {
  assert(!project.includes(forbidden), `helper registration must not infer an ecosystem or inject CI from ${forbidden}`);
}

console.log("setup-workflow-ecosystems: helper registers external project facts without ecosystem-specific CI injection");
