import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeDeployment } from "../../src/runtime/deployment.js";
import { projectPaths } from "../../src/runtime/user-paths.js";
import { helperSkillPaths } from "../../src/helper/skills.js";
import { createClientAdapters } from "../../src/setup/operations.js";
import { MCP_DEFINITIONS } from "../../src/setup/types.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA, projectRuntimeConfigSource } from "../../src/config.js";
import { ACCEPTANCE_SKILL_NAMES, assertProjectBoundary, parseJsonOutput, run, type AcceptanceWorkspace } from "./harness.js";
import { writeFixture } from "./baseline-harness.js";
import { runMergeRecoveryIncident } from "./merge-recovery-incident.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function overlayEnvironment(environment: NodeJS.ProcessEnv): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function bytes(file: string): Buffer | null {
  return existsSync(file) ? readFileSync(file) : null;
}

function assertSameBytes(file: string, expected: Buffer | null, message: string): void {
  const actual = bytes(file);
  assert(actual === null ? expected === null : expected !== null && actual.equals(expected), message + ": " + file);
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function artifactEvidence(content: string): { sha256: string; size: number } {
  const value = Buffer.from(content);
  return { sha256: createHash("sha256").update(value).digest("hex"), size: value.byteLength };
}

function assertByteMap(expected: Map<string, Buffer | null>, message: string): void {
  for (const [file, content] of expected) assertSameBytes(file, content, message);
}

async function initializeFixtureGit(workspace: AcceptanceWorkspace, root: string, branch: string): Promise<void> {
  await run("git", ["init", "-b", branch], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: root, env: workspace.env });
  await run("git", ["config", "user.name", "Acceptance"], { cwd: root, env: workspace.env });
  await run("git", ["remote", "add", "origin", "https://example.invalid/read-only.git"], { cwd: root, env: workspace.env });
  await run("git", ["add", "."], { cwd: root, env: workspace.env });
  await run("git", ["commit", "-m", "fixture"], { cwd: root, env: workspace.env });
  await run("git", ["update-ref", "refs/remotes/origin/" + branch, "HEAD"], { cwd: root, env: workspace.env });
  await run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/" + branch], { cwd: root, env: workspace.env });
}

function assertHelper(envelope: any, command: string): void {
  assert(envelope.schema === "hy-workflow.helper.v1" && envelope.version === 1, command + " helper schema drift");
  assert(envelope.command === command && envelope.ok === true, command + " helper failed: " + JSON.stringify(envelope.error));
  assert(Array.isArray(envelope.projectFilesChanged) && envelope.projectFilesChanged.length === 0, command + " helper changed project files");
}

async function runSeamlessUpgradeIncident(workspace: AcceptanceWorkspace, fixture: any): Promise<Record<string, unknown>> {
  const started = Date.now();
  const root = join(workspace.repos, fixture.id);
  const clients = ["codex", "claude", "opencode"] as const;
  const unrelatedSkillName = "acceptance-unowned";
  const unrelatedDefinition = { command: "unrelated-command", args: ["--flag"] };
  const definitions: Record<string, { command: string; args: string[] }> = {
    "hy-workflow": MCP_DEFINITIONS["hy-workflow"],
    "docs-gardener": MCP_DEFINITIONS["docs-gardener"],
    unrelated: unrelatedDefinition,
  };
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });

  const legacyProjectConfig = JSON.stringify({
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
    ci: { commands: ["npm test"] },
  }, null, 2) + "\n";
  const legacyFiles = new Map<string, string>([
    ["src/index.ts", "export const value = 1;\n"],
    ["docs/index.md", "# Legacy project\n\nAcceptance baseline fact.\n"],
    ["hy-workflow.json", legacyProjectConfig],
    [".github/workflows/hy-workflow.yml", "name: legacy injected workflow\non: [push]\n"],
    ["AGENTS.md", "<!-- hy-workflow-rules -->\nlegacy injected rules\n<!-- /hy-workflow-rules -->\n"],
    ["codelint.json", "{\"legacy\":true}\n"],
    ["doclint.json", "{\"legacy\":true}\n"],
    ["docs-gardener.json", "{\"legacy\":true}\n"],
  ]);
  for (const [file, content] of legacyFiles) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  await initializeFixtureGit(workspace, root, "main");

  const planHash = createHash("sha256").update("public-v0.4.0-active-plan").digest("hex");
  const verifyHash = createHash("sha256").update("public-v0.4.0-verified-exam").digest("hex");
  const evidenceTime = "2026-07-16T12:00:00.000Z";
  const documentReads = {
    beforePlan: {
      stage: "before_plan",
      status: "current",
      snapshotHash: createHash("sha256").update("before-plan-docs").digest("hex"),
      time: evidenceTime,
    },
    beforeApprove: {
      stage: "before_approve",
      status: "current",
      snapshotHash: createHash("sha256").update("before-approve-docs").digest("hex"),
      time: evidenceTime,
    },
    afterEdit: {
      stage: "after_edit",
      status: "current",
      snapshotHash: createHash("sha256").update("after-edit-docs").digest("hex"),
      time: evidenceTime,
    },
  };
  const approvalEvidence = {
    approved: true,
    decision: "approve",
    decisionId: "legacy-approved-decision",
    planHash,
    time: evidenceTime,
  };
  const verificationEvidence = {
    status: "verified",
    verified: true,
    verifyHash,
    expectedExit: 0,
    actualExit: 0,
    time: evidenceTime,
  };
  const syncDocsEvidence = {
    status: "current",
    synced: true,
    snapshotHash: createHash("sha256").update("synced-docs").digest("hex"),
    time: evidenceTime,
  };
  const workflowEvidence = {
    version: "1",
    phase: "commit",
    stage: "commit.prepare",
    planHash,
    approval: approvalEvidence,
    verification: verificationEvidence,
    verifyHash,
    documentReads,
    syncDocs: syncDocsEvidence,
  };
  const scopeEvidence = {
    version: "1",
    planHash,
    scope: { changes: ["src/index.ts"], new_files: [], delete: [] },
    approval: approvalEvidence,
    verification: verificationEvidence,
    documentReads,
    syncDocs: syncDocsEvidence,
  };
  assert(
    workflowEvidence.approval.approved
      && workflowEvidence.verification.verified
      && workflowEvidence.documentReads.beforePlan.status === "current"
      && workflowEvidence.documentReads.beforeApprove.status === "current"
      && workflowEvidence.documentReads.afterEdit.status === "current"
      && workflowEvidence.syncDocs.synced,
    "legacy workflow fixture lacks approval, verification, or documentation evidence",
  );
  assert(
    scopeEvidence.scope.changes.includes("src/index.ts")
      && scopeEvidence.approval.approved
      && scopeEvidence.verification.verified
      && scopeEvidence.syncDocs.synced,
    "legacy scope fixture lacks active approved and verified evidence",
  );

  let paths: ReturnType<typeof projectPaths>;
  let legacyOwnership: any;
  const setupRestore = overlayEnvironment(workspace.env);
  try {
    paths = projectPaths(root);
    writeDeployment(root, {
      setupVersion: "2026.07.16.1",
      mode: "shared",
      clients: [...clients],
      projectFiles: ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"],
      tools: {
        "hy-workflow": { command: "hy-workflow", executable: "hy-workflow", version: "0.4.0" },
        "docs-gardener": { command: "docs-gardener", executable: "docs-gardener", version: "legacy" },
      },
      artifacts: Object.fromEntries(
        ["hy-workflow.json", ".github/workflows/hy-workflow.yml", "AGENTS.md"].map(file => [
          file,
          artifactEvidence(legacyFiles.get(file)!),
        ]),
      ),
    });
    mkdirSync(dirname(paths.workflowState), { recursive: true });
    writeFileSync(paths.workflowState, JSON.stringify(workflowEvidence, null, 2) + "\n");
    writeFileSync(paths.scope, JSON.stringify(scopeEvidence, null, 2) + "\n");

    const deployment = JSON.parse(readFileSync(paths.deployment, "utf8"));
    assert(
      deployment.schemaVersion === "3"
        && Object.keys(deployment.artifacts ?? {}).length === 3
        && JSON.stringify([...deployment.clients].sort()) === JSON.stringify([...clients].sort()),
      "legacy deployment is not a non-empty schema-3 three-client deployment",
    );

    const adapters = createClientAdapters(root);
    assert(
      JSON.stringify(adapters.map(adapter => adapter.name).sort()) === JSON.stringify([...clients].sort()),
      "production adapter catalog did not expose exactly the three expected clients",
    );

    const ownershipClients: Record<string, any> = {};
    for (const adapter of adapters) {
      assert(adapter.detect().installed, adapter.name + " production adapter did not detect the acceptance client");
      const previousByServer: Record<string, any> = {};
      for (const server of Object.keys(definitions)) {
        const previous = adapter.inspect(server as any);
        assert(!previous.definition, adapter.name + " unexpectedly had a pre-existing " + server + " MCP entry");
        previousByServer[server] = previous;
        adapter.install(server as any, definitions[server], previous);
        assertJsonEqual(
          adapter.inspect(server as any).definition,
          definitions[server],
          adapter.name + " production adapter did not seed " + server,
        );
      }
      ownershipClients[adapter.name] = {
        "hy-workflow": {
          desired: MCP_DEFINITIONS["hy-workflow"],
          previous: previousByServer["hy-workflow"],
          applied: adapter.inspect("hy-workflow"),
        },
        "docs-gardener": {
          desired: MCP_DEFINITIONS["docs-gardener"],
          previous: previousByServer["docs-gardener"],
          applied: adapter.inspect("docs-gardener"),
        },
      };
    }

    legacyOwnership = { schemaVersion: "1", revision: 1, clients: ownershipClients };
    mkdirSync(dirname(paths.clientOwnership), { recursive: true });
    writeFileSync(paths.clientOwnership, JSON.stringify(legacyOwnership, null, 2) + "\n");
  } finally {
    setupRestore();
  }

  const skillPaths = helperSkillPaths({ env: workspace.env, home: workspace.home });
  const skillRoots: Record<(typeof clients)[number], string> = {
    codex: join(workspace.env.CODEX_HOME!, "skills"),
    claude: join(workspace.home, ".claude", "skills"),
    opencode: join(dirname(workspace.env.OPENCODE_CONFIG!), "skills"),
  };
  const unownedSkillBytes = new Map<string, Buffer>();
  for (const client of clients) {
    const manifest = join(skillRoots[client], unrelatedSkillName, "SKILL.md");
    const content = Buffer.from([
      "---",
      "name: " + unrelatedSkillName,
      "description: Unowned sentinel Skill for " + client + ".",
      "---",
      "",
      "This Skill is outside hy-workflow ownership and must remain byte-for-byte unchanged.",
      "",
    ].join("\n"));
    mkdirSync(dirname(manifest), { recursive: true });
    writeFileSync(manifest, content);
    unownedSkillBytes.set(manifest, content);
  }

  const inspectClientMcp = (): Record<string, Record<string, any>> => {
    const restore = overlayEnvironment(workspace.env);
    try {
      return Object.fromEntries(createClientAdapters(root).map(adapter => [
        adapter.name,
        Object.fromEntries(Object.keys(definitions).map(server => [server, adapter.inspect(server as any)])),
      ]));
    } finally {
      restore();
    }
  };

  const assertMcpState = (includeWorkflow: boolean, context: string): void => {
    const snapshots = inspectClientMcp();
    for (const client of clients) {
      assertJsonEqual(
        snapshots[client]["hy-workflow"].definition,
        includeWorkflow ? definitions["hy-workflow"] : null,
        context + " " + client + " hy-workflow MCP state drifted",
      );
      assertJsonEqual(
        snapshots[client]["docs-gardener"].definition,
        definitions["docs-gardener"],
        context + " " + client + " docs-gardener MCP changed",
      );
      assertJsonEqual(
        snapshots[client].unrelated.definition,
        definitions.unrelated,
        context + " " + client + " unrelated MCP changed",
      );
    }

    const expectedNames = [
      ...(includeWorkflow ? ["hy-workflow"] : []),
      "docs-gardener",
      "unrelated",
    ].sort();
    const stubState = JSON.parse(readFileSync(workspace.env.HY_ACCEPTANCE_CLIENT_STATE!, "utf8"));
    for (const client of ["codex", "claude"] as const) {
      assertJsonEqual(
        Object.keys(stubState[client] ?? {}).sort(),
        expectedNames,
        context + " " + client + " MCP name set drifted",
      );
    }
    const openCodeConfig = JSON.parse(readFileSync(workspace.env.OPENCODE_CONFIG!, "utf8"));
    assertJsonEqual(
      Object.keys(openCodeConfig.mcp ?? {}).sort(),
      expectedNames,
      context + " opencode MCP name set drifted",
    );
  };

  assertMcpState(true, "legacy seed");
  for (const client of clients) {
    assert(
      legacyOwnership.clients[client]?.["hy-workflow"]
        && legacyOwnership.clients[client]?.["docs-gardener"]
        && !legacyOwnership.clients[client]?.unrelated,
      "legacy ownership did not own exactly hy-workflow and docs-gardener for " + client,
    );
  }

  const projectBefore = new Map(
    [...legacyFiles.keys()].map(file => [join(root, file), bytes(join(root, file))]),
  );
  const externalFiles = [paths.deployment, paths.registry, paths.workflowState, paths.scope];
  const externalBefore = new Map(externalFiles.map(file => [file, bytes(file)]));
  assert(bytes(paths.config) === null, "public v0.4.0 fixture must begin without an external config");
  const gitBefore = (await run("git", ["status", "--porcelain=v1", "-uall"], {
    cwd: root,
    env: workspace.env,
  })).stdout;

  const installed = parseJsonOutput((await run("hy-workflow", [
    "helper", "install", "--json",
  ], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 90_000,
  })).stdout);
  assertHelper(installed, "install");
  assertJsonEqual(installed.clients, [...clients], "automatic helper install did not select all three clients");
  assert(
    installed.layers?.skills?.status === "installed"
      && installed.layers.skills.skillCount === ACCEPTANCE_SKILL_NAMES.length
      && installed.layers.skills.targets?.length === clients.length,
    "helper did not install the automatic 3 x 12 Skill projection",
  );
  assert(installed.layers?.project?.status === "preserved", "helper rewrote the legacy deployment");
  assertJsonEqual(
    installed.layers.project.localFilesChanged,
    [paths.config],
    "helper created more than the external authority marker",
  );
  assert(
    installed.layers?.mcp?.status === "retired"
      && installed.layers.mcp.remainingWorkflowMcpClients?.length === 0,
    "helper did not retire all three exactly owned hy-workflow MCP entries",
  );
  assertJsonEqual(
    JSON.parse(readFileSync(paths.config, "utf8")),
    projectRuntimeConfigSource(),
    "helper did not create the exact project-authority marker",
  );

  assertByteMap(projectBefore, fixture.id + " install changed a legacy project file");
  assertByteMap(externalBefore, fixture.id + " install changed preserved external state");
  assert(
    (await run("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: root,
      env: workspace.env,
    })).stdout === gitBefore,
    fixture.id + " install changed Git state",
  );
  assertMcpState(false, "migrated state");

  const migratedOwnership = JSON.parse(readFileSync(paths.clientOwnership, "utf8"));
  for (const client of clients) {
    assert(!migratedOwnership.clients?.[client]?.["hy-workflow"], "helper left " + client + " hy-workflow ownership");
    assertJsonEqual(
      migratedOwnership.clients?.[client]?.["docs-gardener"],
      legacyOwnership.clients[client]["docs-gardener"],
      "helper changed " + client + " docs-gardener ownership",
    );
    assert(!migratedOwnership.clients?.[client]?.unrelated, "helper adopted the unrelated " + client + " MCP entry");
  }

  const canonicalSkillFiles = ACCEPTANCE_SKILL_NAMES.map(name => join(skillPaths.ssotRoot, name, "SKILL.md"));
  const projectedSkillFiles = clients.flatMap(client =>
    ACCEPTANCE_SKILL_NAMES.map(name => join(skillRoots[client], name, "SKILL.md"))
  );
  const managedSkillFiles = [...canonicalSkillFiles, ...projectedSkillFiles];
  for (const file of managedSkillFiles) assert(existsSync(file), "helper omitted managed Skill file: " + file);
  assert(
    projectedSkillFiles.length === clients.length * ACCEPTANCE_SKILL_NAMES.length,
    "managed Skill projection count is not 3 x 12",
  );
  assertByteMap(unownedSkillBytes, "helper changed an unowned Skill during install");

  const skillManifest = JSON.parse(readFileSync(skillPaths.manifestPath, "utf8"));
  assertJsonEqual(
    skillManifest.skills?.map((skill: any) => skill.name).sort(),
    [...ACCEPTANCE_SKILL_NAMES].sort(),
    "Skill ownership manifest does not contain the exact twelve Skills",
  );
  assertJsonEqual(
    skillManifest.targets?.map((target: any) => target.agent).sort(),
    [...clients].sort(),
    "Skill ownership manifest does not contain the exact three clients",
  );
  assert(
    skillManifest.skills.every((skill: any) => skill.projections?.length === clients.length),
    "a managed Skill lacks one of the three projections",
  );
  assert(
    !skillManifest.skills.some((skill: any) => skill.name === unrelatedSkillName),
    "helper adopted the unowned sentinel Skill",
  );

  const clientStateFiles = [
    workspace.env.HY_ACCEPTANCE_CLIENT_STATE!,
    join(workspace.env.CODEX_HOME!, "config.toml"),
    workspace.env.OPENCODE_CONFIG!,
  ];
  const stableInstalledFiles = [
    paths.config,
    ...externalFiles,
    paths.clientOwnership,
    ...clientStateFiles,
    skillPaths.manifestPath,
    ...managedSkillFiles,
    ...unownedSkillBytes.keys(),
  ];
  const stableInstalledBytes = new Map(stableInstalledFiles.map(file => [file, bytes(file)]));

  const repeatedInstall = parseJsonOutput((await run("hy-workflow", [
    "helper", "install", "--json",
  ], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 90_000,
  })).stdout);
  assertHelper(repeatedInstall, "install");
  assert(
    repeatedInstall.layers?.skills?.status === "unchanged"
      && repeatedInstall.layers?.project?.status === "preserved"
      && repeatedInstall.layers?.mcp?.status === "unchanged",
    "second automatic helper install was not a complete no-op",
  );
  assert(
    Array.isArray(repeatedInstall.layers.project.localFilesChanged)
      && repeatedInstall.layers.project.localFilesChanged.length === 0,
    "second helper install rewrote project registration state",
  );
  assertByteMap(stableInstalledBytes, "second helper install changed key installed state");
  assertByteMap(projectBefore, "second helper install changed a project file");
  assertByteMap(externalBefore, "second helper install changed preserved external state");
  assertByteMap(unownedSkillBytes, "second helper install changed an unowned Skill");
  assertMcpState(false, "second install");

  const status = parseJsonOutput((await run("hy-workflow", [
    "helper", "status", "--json",
  ], { cwd: root, env: workspace.env })).stdout);
  assertHelper(status, "status");
  assert(
    status.layers?.skills?.status === "healthy"
      && status.layers?.project?.status === "registered"
      && status.layers?.mcp?.status === "unchanged",
    "migrated helper status was not healthy",
  );
  assertJsonEqual(status.clients, [...clients].sort(), "healthy status lost a selected client");
  assertByteMap(stableInstalledBytes, "helper status mutated installed state");

  const persistentFiles = [
    paths.config,
    ...externalFiles,
    paths.clientOwnership,
    ...clientStateFiles,
    ...unownedSkillBytes.keys(),
  ];
  const persistentBeforeRemove = new Map(persistentFiles.map(file => [file, bytes(file)]));

  const removed = parseJsonOutput((await run("hy-workflow", [
    "helper", "remove", "--json",
  ], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 90_000,
  })).stdout);
  assertHelper(removed, "remove");
  assert(
    removed.layers?.skills?.status === "removed"
      && removed.layers?.project?.status === "preserved"
      && removed.layers?.mcp?.status === "preserved",
    "helper remove crossed its Skill-only ownership boundary",
  );
  assertByteMap(persistentBeforeRemove, "helper remove changed marker, project state, MCP state, or MCP ownership");
  assertByteMap(projectBefore, "helper remove changed a project file");
  assertByteMap(externalBefore, "helper remove changed preserved external state");
  assertByteMap(unownedSkillBytes, "helper remove changed an unowned Skill");
  assert(!existsSync(skillPaths.manifestPath), "helper remove left Skill ownership state");
  assert(!existsSync(skillPaths.ssotRoot), "helper remove left the owned canonical Skill bundle");
  for (const file of projectedSkillFiles) assert(!existsSync(file), "helper remove left an owned Skill projection: " + file);
  assertMcpState(false, "helper remove");

  const secondRemove = parseJsonOutput((await run("hy-workflow", [
    "helper", "remove", "--json",
  ], {
    cwd: root,
    env: workspace.env,
    timeoutMs: 90_000,
  })).stdout);
  assertHelper(secondRemove, "remove");
  assert(
    secondRemove.layers?.skills?.status === "unchanged"
      && secondRemove.layers?.project?.status === "preserved"
      && secondRemove.layers?.mcp?.status === "preserved",
    "second helper remove was not a no-op",
  );
  assertByteMap(persistentBeforeRemove, "second helper remove changed persistent state");
  assertByteMap(projectBefore, "second helper remove changed a project file");
  assertByteMap(externalBefore, "second helper remove changed preserved external state");
  assertByteMap(unownedSkillBytes, "second helper remove changed an unowned Skill");
  assert(!existsSync(skillPaths.manifestPath), "second helper remove recreated Skill ownership state");
  assert(!existsSync(skillPaths.ssotRoot), "second helper remove recreated the canonical Skill bundle");
  for (const file of projectedSkillFiles) assert(!existsSync(file), "second helper remove recreated an owned Skill projection: " + file);
  assertMcpState(false, "second helper remove");

  assert(
    (await assertProjectBoundary(root, workspace.env)).length === 0,
    fixture.id + " helper lifecycle dirtied the project",
  );
  assert(
    (await run("git", ["status", "--porcelain=v1", "-uall"], {
      cwd: root,
      env: workspace.env,
    })).stdout === gitBefore,
    fixture.id + " helper lifecycle changed Git state",
  );

  return {
    name: fixture.id,
    incident: fixture.incident,
    legacyFiles: "byte-for-byte",
    externalState: "byte-for-byte",
    deploymentSchema: 3,
    workflowEvidence: "approved-verified-docs-current",
    workflowMcp: "retired-three-clients",
    docsGardener: "preserved-three-clients",
    unrelatedMcp: "preserved-three-clients",
    skillProjections: clients.length * ACCEPTANCE_SKILL_NAMES.length,
    unownedSkills: "preserved",
    repeatedInstall: "no-op",
    removeBoundary: "skills-only",
    repeatedRemove: "no-op",
    durationMs: Date.now() - started,
  };
}

async function runProjectShapeFixture(workspace: AcceptanceWorkspace, fixture: any): Promise<Record<string, unknown>> {
  const started = Date.now();
  const root = join(workspace.repos, fixture.id);
  mkdirSync(root, { recursive: true });
  writeFixture(root, fixture);
  await initializeFixtureGit(workspace, root, fixture.branch);

  let explicitConfigPath: string | null = null;
  let explicitConfigBefore: Buffer | null = null;
  if (fixture.explicitConfig === true) {
    const restore = overlayEnvironment(workspace.env);
    try {
      explicitConfigPath = projectPaths(root).config;
      mkdirSync(dirname(explicitConfigPath), { recursive: true });
      writeFileSync(explicitConfigPath, JSON.stringify({
        project: { baseBranch: fixture.branch, codeExt: fixture.codeExt, codeDirs: fixture.codeDirs, docsDir: fixture.docsDir },
        codelint: { lintDirs: fixture.codeDirs, maxLinesWarning: 300, maxLinesError: 500 },
        doclint: { maxLinesWarning: 200, maxLinesError: 500 },
        docsGardener: { catalogs: {} },
        policy: { profile: "standard" },
      }, null, 2) + "\n");
      explicitConfigBefore = bytes(explicitConfigPath);
    } finally {
      restore();
    }
  }

  const before = (await run("git", ["status", "--porcelain=v1", "-uall"], { cwd: root, env: workspace.env })).stdout;
  const installed = parseJsonOutput((await run("hy-workflow", [
    "helper", "install", "--clients", "codex", "--mode", "copy", "--json",
  ], { cwd: root, env: workspace.env, timeoutMs: 60_000 })).stdout);
  assertHelper(installed, "install");
  assert(installed.layers?.skills?.skillCount === 12, fixture.id + " did not install twelve Skills");
  const configPath = installed.layers?.project?.configPath;
  assert(typeof configPath === "string" && relative(root, configPath).startsWith(".."), fixture.id + " config was not external");
  if (explicitConfigPath !== null) {
    assert(configPath === explicitConfigPath && explicitConfigBefore !== null, fixture.id + " did not select the explicit external config");
    assertSameBytes(configPath, explicitConfigBefore, fixture.id + " changed the explicit external config during install");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  assert(config.project?.baseBranch === fixture.branch, fixture.id + " base branch drifted");
  assert(config.project?.docsDir === fixture.docsDir, fixture.id + " docs root drifted");
  for (const extension of fixture.codeExt) {
    const configured = Array.isArray(config.project?.codeExt) ? config.project.codeExt : [config.project?.codeExt];
    assert(configured.includes(extension), fixture.id + " missed code extension " + extension);
  }
  for (const directory of fixture.codeDirs) assert(config.project?.codeDirs?.includes(directory), fixture.id + " missed code directory " + directory);
  assert((await assertProjectBoundary(root, workspace.env)).length === 0 && before === "", fixture.id + " helper changed project files");

  const status = parseJsonOutput((await run("hy-workflow", ["helper", "status", "--json"], { cwd: root, env: workspace.env })).stdout);
  assertHelper(status, "status");
  const lint = await run("hy-workflow", ["lint", "--json"], { cwd: root, env: workspace.env, allowFailure: true });
  const lintReport = parseJsonOutput(lint.stdout);
  assert(lintReport.schema === "hy-workflow.lint.v1" && lintReport.version === 1, fixture.id + " lint schema drift");
  assert(Array.isArray(lintReport.checks) && lintReport.checks.length === 10, fixture.id + " lint did not report D001-D005/C001-C005");
  for (const runtime of [".hy", ".codex", ".mcp.json", "codelint.json", "doclint.json", "docs-gardener.json"]) {
    assert(!existsSync(join(root, runtime)), fixture.id + " created project-local runtime artifact " + runtime);
  }

  const removed = parseJsonOutput((await run("hy-workflow", ["helper", "remove", "--json"], { cwd: root, env: workspace.env })).stdout);
  assertHelper(removed, "remove");
  await assertProjectBoundary(root, workspace.env);
  if (explicitConfigPath !== null) {
    assertSameBytes(explicitConfigPath, explicitConfigBefore, fixture.id + " changed the explicit external config during remove");
  }
  return {
    name: fixture.id,
    incident: fixture.incident,
    projectFilesChanged: installed.projectFilesChanged,
    lint: lintReport.counts,
    durationMs: Date.now() - started,
  };
}

export async function runBaselineFixture(workspace: AcceptanceWorkspace, fixture: any): Promise<Record<string, unknown>> {
  if (fixture.kind === "merge-recovery") {
    return runMergeRecoveryIncident({
      ...workspace,
      env: { ...workspace.env, [RUNTIME_CONFIG_SOURCE_ENV]: RUNTIME_CONFIG_SOURCE_SCHEMA },
    }, fixture);
  }
  if (fixture.kind === "seamless-upgrade") return runSeamlessUpgradeIncident(workspace, fixture);
  if (fixture.kind !== undefined && fixture.kind !== "project-shape") throw new Error("Unknown baseline fixture kind: " + fixture.kind);
  return runProjectShapeFixture(workspace, fixture);
}
