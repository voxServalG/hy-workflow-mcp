import { execFileSync } from "node:child_process";
import { inspectProject, type ProjectProfile } from "./project-profile.js";
import { redactGitRemote } from "./runtime/user-paths.js";

export type GitHistoryItem = {
  oid: string;
  authoredAt: string;
  subject: string;
  parents: number;
};

export type TestScaleContract = {
  scale: "small" | "medium" | "large";
  requiredWhen: string[];
  resourceBoundary: string;
  examples: string[];
};

export type ProjectCognition = {
  schema: "hy-workflow.project-cognition.v1";
  generatedFrom: "local-read-only";
  profile: Omit<ProjectProfile, "root" | "trackedFiles"> & { trackedFileCount: number };
  documentation: {
    entryPoints: string[];
    externalKnowledgeAccess: false;
    pullRequestReview: "skill-read-only";
  };
  repository: {
    branch: string | null;
    head: string | null;
    upstream: string | null;
    dirty: boolean;
    changedFiles: string[];
    origin: string | null;
    recentCommits: GitHistoryItem[];
    recentMerges: GitHistoryItem[];
  };
  verificationPlatform: {
    ecosystems: string[];
    candidateCommands: string[];
    scaleDecisionOwner: "skill";
    completenessAuthority: "cli";
    scales: TestScaleContract[];
  };
};

function git(root: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function gitRaw(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
  } catch {
    return null;
  }
}

function history(root: string, mergesOnly: boolean): GitHistoryItem[] {
  const separator = "\u001f";
  const record = "\u001e";
  const output = git(root, [
    "log",
    ...(mergesOnly ? ["--merges"] : []),
    "-n",
    "8",
    "--format=%H" + separator + "%aI" + separator + "%P" + separator + "%s" + record,
  ]);
  if (!output) return [];
  return output.split(record).map(item => item.trim()).filter(Boolean).flatMap(item => {
    const [oid, authoredAt, rawParents, ...subject] = item.split(separator);
    if (!oid || !authoredAt) return [];
    return [{
      oid,
      authoredAt,
      subject: subject.join(separator).slice(0, 500),
      parents: rawParents.trim() ? rawParents.trim().split(/\s+/).length : 0,
    }];
  });
}

function docsEntryPoints(profile: ProjectProfile): string[] {
  const files = profile.trackedFiles;
  const preferred = [
    "README.md",
    "README.rst",
    "CONTRIBUTING.md",
    "ARCHITECTURE.md",
    "docs/index.md",
    "docs/README.md",
    "documentation/index.md",
    "doc/index.md",
  ];
  const byCase = new Map(files.map(file => [file.toLowerCase(), file]));
  const selected = preferred.flatMap(file => {
    const match = byCase.get(file.toLowerCase());
    return match ? [match] : [];
  });
  if (profile.docsDir && profile.docsDir !== ".") {
    const prefix = profile.docsDir.replace(/\/$/, "") + "/";
    selected.push(...files.filter(file => file.startsWith(prefix) && /\.(?:md|mdx|rst|txt)$/i.test(file)).slice(0, 20));
  } else {
    selected.push(...files.filter(file => !file.includes("/") && /\.(?:md|mdx|rst|txt)$/i.test(file)).slice(0, 20));
  }
  return [...new Set(selected)].slice(0, 24);
}

export const TEST_SCALE_CONTRACTS: TestScaleContract[] = [
  {
    scale: "small",
    requiredWhen: [
      "always run for changed deterministic units and static contracts",
      "sufficient only when behavior stays inside one module with no process, filesystem, database, network, schema, public API, packaging, or migration boundary",
    ],
    resourceBoundary: "single process, hermetic, no real external service; normally seconds",
    examples: ["targeted unit tests", "type checking", "format and lint rules", "pure contract checks"],
  },
  {
    scale: "medium",
    requiredWhen: [
      "change crosses modules or a local process boundary",
      "change touches filesystem, local database, serialization, schema, public API, command line behavior, concurrency, or recovery state",
    ],
    resourceBoundary: "one machine with bounded local resources; fake or local services allowed; normally minutes",
    examples: ["component integration", "CLI subprocess tests", "local database tests", "multi-module repository tests"],
  },
  {
    scale: "large",
    requiredWhen: [
      "change affects installation, upgrade, packaging, release, CI, cross-platform behavior, external services, distributed workflows, security boundaries, or irreversible data compatibility",
      "a historical incident or project invariant can only be reproduced end to end",
    ],
    resourceBoundary: "representative installed artifact and production-like boundaries; network or real services may be required; normally minutes to hours",
    examples: ["installed-package acceptance", "upgrade migration fixture", "real CI/release pressure", "cross-platform end-to-end test"],
  },
];

export function collectProjectCognition(root: string): ProjectCognition {
  const profile = inspectProject(root);
  const status = gitRaw(root, ["status", "--porcelain=v1", "-z"]);
  const changedFiles = status
    ? status.split("\0").filter(Boolean).map(entry => entry.slice(3)).filter(Boolean).slice(0, 200)
    : [];
  const branch = git(root, ["branch", "--show-current"]);
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const upstream = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  const origin = redactGitRemote(git(root, ["remote", "get-url", "origin"]));
  const { root: _root, trackedFiles, ...publicProfile } = profile;
  return {
    schema: "hy-workflow.project-cognition.v1",
    generatedFrom: "local-read-only",
    profile: { ...publicProfile, trackedFileCount: trackedFiles.length },
    documentation: {
      entryPoints: docsEntryPoints(profile),
      externalKnowledgeAccess: false,
      pullRequestReview: "skill-read-only",
    },
    repository: {
      branch,
      head,
      upstream,
      dirty: changedFiles.length > 0,
      changedFiles,
      origin,
      recentCommits: history(root, false),
      recentMerges: history(root, true),
    },
    verificationPlatform: {
      ecosystems: [...profile.ecosystems],
      candidateCommands: [...profile.ciCandidates],
      scaleDecisionOwner: "skill",
      completenessAuthority: "cli",
      scales: TEST_SCALE_CONTRACTS.map(item => ({ ...item, requiredWhen: [...item.requiredWhen], examples: [...item.examples] })),
    },
  };
}
