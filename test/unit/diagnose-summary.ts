import { McpHarness } from "../harness.js";
import { resolve } from "node:path";

const SAMPLE_PLAN = {
  task: "修复 approve 不校验 plan 就切 phase 的问题",
  scope: {
    changes: ["src/tools/approve.ts", "src/state.ts"],
    new_files: ["tests/approve.test.ts"],
    delete: [],
  },
  boundary: {
    dependency_dag: "approve.ts 依赖 state.ts；server.ts 引用不变；无其他模块受波及",
    entry_points: ["npx tsc --noEmit", "npx vitest run tests/approve.test.ts"],
    no_new_external: true,
  },
  verify: {
    platform: {
      python_version: "3.11",
      setup: ["npm install"],
    },
    smoke: [
      { command: "npx tsc --noEmit", expected_exit: 0, description: "TypeScript 编译检查" },
      { command: "node -e \"console.log('ok')\"", expected_exit: 0, description: "Node 运行检查" },
    ],
    tests: [
      { command: "npx vitest run", expected_exit: 0, description: "单元测试套件" },
    ],
  },
  risks: [
    "场景：approve 跳过 plan 校验直接切 phase。影响：未审核的 plan 可能进入 branch 阶段。缓解：assertPhase 守卫确保只在 plan/approve 阶段可调用。",
    "场景：空 approved 值。影响：误操作。缓解：trim 后只有 \"approve\" / \"true\" 放行。",
  ],
  discussion: "选择在 approve.ts 中增加 plan 存在性校验。备选方案：在 state.ts transition 中增加条件逻辑。否定理由：state.ts 应保持纯粹的状态转换逻辑，业务校验应在工具 handler 中完成。",
};

// ── Test 1: buildSummary() direct output check ─────────────────────

async function test1_buildSummaryDirect() {
  console.log("=".repeat(60));
  console.log("TEST 1: Direct buildSummary() output");
  console.log("=".repeat(60));

  const { handlePlan } = await import("../../dist/tools/plan.js");

  // We call handlePlan, which internally calls buildSummary.
  // But we need to be in "plan" phase. Let's hack the state.
  const mod = await import("../../dist/state.js");
  const p = mod.statePath();
  const { unlinkSync, writeFileSync, mkdirSync, existsSync, readFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");

  const priorState = existsSync(p) ? readFileSync(p, "utf8") : null;

  // Overwrite state to be in "plan" phase
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, JSON.stringify({
    version: "1",
    phase: "plan",
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
    documentReads: {
      beforePlan: {
        stage: "before_plan",
        purpose: "test baseline",
        time: new Date().toISOString(),
        task: SAMPLE_PLAN.task,
        planHash: null,
        docsDir: "docs",
        digest: "test",
        files: [],
        findings: [],
      },
    },
  }, null, 2));

  try {
    const result = await handlePlan({ task: SAMPLE_PLAN.task, plan: SAMPLE_PLAN });

    console.log("\n[RAW handlePlan return keys]:", Object.keys(result));
    console.log("\n[next]:", result.next);
    console.log("[message]:", result.message);
    console.log("[warnings]:", result.warnings ?? "(none)");

    console.log("\n[has summary field]:", "summary" in result);
    console.log("[summary length]:", result.summary?.length ?? 0, "chars");
    console.log("[summary empty?]:", !result.summary || result.summary.trim() === "");

    // Check all required sections present
    const s = result.summary ?? "";
    const checks = [
      { name: "## Plan", test: s.includes("## Plan") },
      { name: "现在状态", test: s.includes("**现在状态**") },
      { name: "期望状态", test: s.includes("**期望状态**") },
      { name: "### Scope", test: s.includes("### Scope") },
      { name: "将要增加", test: s.includes("**将要增加**") },
      { name: "将要改动", test: s.includes("**将要改动**") },
      { name: "将要删除", test: s.includes("**将要删除**") },
      { name: "path reason", test: s.includes("`src/tools/approve.ts`: 调整运行时代码行为") },
      { name: "### Boundary", test: s.includes("### Boundary") },
      { name: "影响范围", test: s.includes("**影响范围**") },
      { name: "外部依赖", test: s.includes("**外部依赖**") },
      { name: "关键检查入口", test: s.includes("**关键检查入口**") },
      { name: "### Verify", test: s.includes("### Verify") },
      { name: "测试平台搭建", test: s.includes("**测试平台搭建**") },
      { name: "Unit Test", test: s.includes("**单元测试 (Unit Test)**") },
      { name: "Integration Test", test: s.includes("**集成测试 (Integration Test)**") },
      { name: "System Test", test: s.includes("**系统测试 (System Test)**") },
      { name: "Acceptance Test", test: s.includes("**验收测试 (Acceptance Test)**") },
      { name: "command", test: s.includes("command: `npx vitest run`") },
      { name: "thing to test", test: s.includes("thing to test: 单元测试套件") },
      { name: "expectation", test: s.includes("expectation: exit 0") },
      { name: "### Risks", test: s.includes("### Risks") },
      { name: "### Discussion", test: s.includes("### Discussion") },
    ];

    console.log("\n[Section presence check]:");
    let allOk = true;
    for (const c of checks) {
      const status = c.test ? "PASS" : "FAIL";
      console.log(`  ${status}: ${c.name}`);
      if (!c.test) allOk = false;
    }

    console.log("\n[SUMMARY CONTENT (250 chars)]:");
    console.log(s.substring(0, 250) + "...");
    console.log("\n[FULL SUMMARY BELOW]");
    console.log("--BEGIN--");
    console.log(s);
    console.log("--END--");

    console.log("\nTest 1 result:", allOk ? "ALL SECTIONS PRESENT" : "SOME SECTIONS MISSING");
    return { allOk, summary: s };
  } finally {
    // Restore the workflow state that was active before this diagnostic test.
    if (priorState === null) {
      try { unlinkSync(p); } catch {}
    } else {
      writeFileSync(p, priorState);
    }
  }
}

// ── Test 2: MCP roundtrip — raw JSON response ─────────────────────

async function test2_mcpRoundtrip() {
  console.log("\n" + "=".repeat(60));
  console.log("TEST 2: MCP roundtrip — raw JSON response");
  console.log("=".repeat(60));

  const mod = await import("../../dist/state.js");
  const p = mod.statePath();
  const { unlinkSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const priorState = existsSync(p) ? readFileSync(p, "utf8") : null;
  const harness = new McpHarness();
  await harness.init();

  try {
    // Reset to plan phase and create the required before_plan document baseline.
    await harness.call("hy_reset");
    await harness.call("hy_read_docs", {
      stage: "before_plan",
      task: SAMPLE_PLAN.task,
    });

    // Now call hy_plan
    const raw = await harness.call("hy_plan", {
      task: SAMPLE_PLAN.task,
      plan: SAMPLE_PLAN,
    });

    console.log("\n[RAW MCP response type]:", typeof raw);
    console.log("[RAW MCP response keys]:", typeof raw === "object" ? Object.keys(raw) : "N/A");

    if (typeof raw === "object" && raw !== null) {
      console.log("\n[next]:", raw.next);
      console.log("[message]:", raw.message);
      console.log("[has summary field]:", "summary" in raw);
      console.log("[summary type]:", typeof raw.summary);
      console.log("[summary length]:", raw.summary?.length ?? 0, "chars");
      console.log("[summary empty?]:", !raw.summary || raw.summary.trim() === "");

      if (raw.summary) {
        const s = raw.summary;
        console.log("\n[SUMMARY first 200 chars]:");
        console.log(s.substring(0, 200));
        console.log("\n[SUMMARY last 100 chars]:");
        console.log(s.substring(s.length - 100));
      }

      console.log("\n[has plan field]:", "plan" in raw);
      if (raw.plan) {
        console.log("[plan.task]:", raw.plan.task);
        console.log("[plan.scope.changes]:", raw.plan.scope?.changes);
      }
    }

    console.log("\nTest 2 result:", raw?.summary ? "SUMMARY FIELD PRESENT" : "SUMMARY FIELD MISSING");
    return raw;
  } finally {
    await harness.close();
    if (priorState === null) {
      try { unlinkSync(p); } catch {}
    } else {
      writeFileSync(p, priorState);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("=== DIAGNOSING: buildSummary() → hy_plan → LLM display ===\n");

  await test1_buildSummaryDirect();
  await test2_mcpRoundtrip();

  console.log("\n" + "=".repeat(60));
  console.log("DIAGNOSIS COMPLETE");
  console.log("=".repeat(60));
}

main().catch(e => { console.error("DIAGNOSIS CRASHED:", e.message); process.exit(1); });
