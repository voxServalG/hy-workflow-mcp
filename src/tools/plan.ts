import { readState, writeState, transition, assertPhase } from "../state.js";
import type { ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";
import { execSync } from "node:child_process";

export async function handlePlan(args: { task: string; plan: PlanDoc }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "plan");

  // Run garden-scan to get baseline
  let baseline = {};
  try {
    const raw = execSync("npx --yes docs-gardener garden-scan", {
      encoding: "utf-8", timeout: 30_000, stdio: ["pipe","pipe","pipe"]
    });
    baseline = JSON.parse(raw || "{}");
  } catch {
    baseline = {};
  }

  // ── Gate 1: required top-level fields ──────────────────────
  const p = args.plan;
  if (!p.task || !p.scope || !p.boundary || !p.verify || !p.risks || p.discussion === undefined) {
    return { next: "plan", error: "PlanDoc 必须包含: task, scope, boundary, verify, risks, discussion" };
  }

  // ── Helpers ──────────────────────────────────────────────────
  const EXECUTABLE_PREFIXES = new Set([
    "sh","bash","zsh","fish","dash",
    "node","npx","npm","yarn","pnpm","bun","deno","tsx","tsc","jest","vitest","mocha","ava",
    "python","python3","py","pip","pip3","pytest","tox","mypy","ruff","black","isort","flake8","pylint",
    "uvicorn","gunicorn","flask","django-admin","celery","fastapi",
    "cargo","rustc","go","gofmt",
    "gcc","g++","clang","clang++","cmake","make","ninja","meson",
    "java","javac","mvn","gradle","dotnet",
    "git","gh","git-lfs",
    "docker","kubectl","helm","podman",
    "curl","wget","ssh","scp","rsync",
    "psql","mysql","sqlite3","redis-cli",
    "ruby","gem","bundle","rake","rails","rspec",
    "php","composer",
    "perl","lua","elixir","mix","iex","ghc","cabal","stack",
    "swift","xcodebuild","R","Rscript",
    "echo","cat","touch","mkdir","rm","cp","mv","chmod",
    "grep","sed","awk","find","xargs","head","tail","wc","sort","diff","tar","gzip","zip","unzip",
    "env","export","which","type","jq",
  ]);
  const hasExecutable = (cmd: string): boolean => {
    const firstWord = cmd.trim().split(/\s+/)[0];
    if (EXECUTABLE_PREFIXES.has(firstWord)) return true;
    if (cmd.includes("/") || cmd.includes("\\")) return true;
    return false;
  };
  const hollow = new Set(["echo ok","echo \"ok\"","echo 'ok'","echo test","echo \"test\"","echo 'test'"]);

  // ── Gate 2: scope not all-empty ─────────────────────────────
  const hasChanges = (p.scope.changes?.length ?? 0) > 0;
  const hasNew = (p.scope.new_files?.length ?? 0) > 0;
  const hasDelete = (p.scope.delete?.length ?? 0) > 0;
  if (!hasChanges && !hasNew && !hasDelete) {
    return { next: "plan", error: "scope 全空 — changes / new_files / delete 至少一项非空" };
  }

  // ── Gate 3: boundary has substance ──────────────────────────
  if (!p.boundary.dependency_dag) {
    return { next: "plan", error: "boundary.dependency_dag 不能为空，哪怕只改一个文件也要说明" };
  }
  if (!p.boundary.entry_points?.length) {
    return { next: "plan", error: "boundary.entry_points 至少需要 1 条命令" };
  }
  for (const ep of p.boundary.entry_points) {
    if (!hasExecutable(ep)) {
      return { next: "plan", error: `boundary.entry_points: "${ep}" 不是可执行命令。请使用 npx/python/node/git 等可执行前缀。` };
    }
  }

  // ── Gate 4: verify has substance ────────────────────────────
  if (!p.verify.platform?.python_version) {
    return { next: "plan", error: "verify.platform.python_version 不能为空" };
  }
  if (!p.verify.smoke?.length) {
    return { next: "plan", error: "verify.smoke 至少需要 1 条" };
  }
  if (!p.verify.tests?.length) {
    return { next: "plan", error: "verify.tests 至少需要 1 条" };
  }

  // ── Gate 5: risks & discussion non-empty ────────────────────
  if (!p.risks.length) {
    return { next: "plan", error: "risks 至少需要 1 条风险" };
  }
  if (p.discussion === "") {
    return { next: "plan", error: "discussion 不能为空，说明方案选择原因" };
  }

  // ── Gate 6: no hollow or non-executable commands ────────────
  for (const ep of p.boundary.entry_points) {
    if (hollow.has(ep.trim())) {
      return { next: "plan", error: `boundary.entry_points 含空洞命令 "${ep}"。echo 不验证任何东西，请写有效入口点。` };
    }
  }
  for (const s of p.verify.smoke) {
    if (hollow.has(s.command.trim())) {
      return { next: "plan", error: `verify.smoke 含空洞命令 "${s.command}"。echo 不验证任何东西，请写实质性检查。` };
    }
    if (!hasExecutable(s.command)) {
      return { next: "plan", error: `verify.smoke: "${s.command}" 不是可执行命令。` };
    }
  }
  for (const t of p.verify.tests) {
    if (hollow.has(t.command.trim())) {
      return { next: "plan", error: `verify.tests 含空洞命令 "${t.command}"。` };
    }
    if (!hasExecutable(t.command)) {
      return { next: "plan", error: `verify.tests: "${t.command}" 不是可执行命令。` };
    }
  }

  const next = transition(state, "plan"); // stays in plan until approve
  next.phase = "plan";
  next.plan = p;
  writeState(next);

  return {
    next: "approve",
    baseline,
    plan: p,
    message: "Plan written. Review the plan, then call hy_approve to proceed or provide feedback to revise.",
  };
}
