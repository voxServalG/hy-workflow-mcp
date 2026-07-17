import * as p from "@clack/prompts";
import type { ClientName } from "../runtime/deployment.js";
import { SetupFailure, type ArtifactChange, type ClientDetection, type SetupAction, type SetupOptions } from "./types.js";

type Copy = {
  title: string;
  language: string;
  action: string;
  install: string;
  unset: string;
  clients: string;
  noClients: string;
  removeGlobal: string;
  confirm: string;
  cancelled: string;
  detecting: string;
  detected: string;
  applying: string;
  applied: string;
  successInstall: string;
  successUnset: string;
  successNoChange: string;
  ciSuggested: string;
  ciCustom: string;
  acceptCi: string;
  artifacts: string;
  acceptArtifacts: string;
};

const COPY: Record<"zh" | "en", Copy> = {
  zh: {
    title: "hy-workflow 安装与维护",
    language: "选择语言 / Choose language",
    action: "要执行什么？",
    install: "安装 / 更新",
    unset: "解除当前项目部署",
    clients: "选择要配置的 AI 客户端",
    noClients: "未检测到 Codex、Claude Code 或 OpenCode。请先安装至少一个客户端。",
    removeGlobal: "若这是最后一个项目，同时移除全局 MCP 配置？",
    confirm: "确认执行？",
    cancelled: "已取消，未做任何改动。",
    detecting: "正在检测客户端与有效配置…",
    detected: "客户端检测完成",
    applying: "正在写入配置并更新客户端…",
    applied: "配置完成",
    successInstall: "hy-workflow 配置成功！请重启你的 MCP 客户端（Codex / Claude Code / OpenCode）以加载新工具。",
    successUnset: "当前项目的 hy-workflow 部署已解除。",
    successNoChange: "配置已是最新状态，无需改动。",
    ciSuggested: "检测到以下原生 CI 命令",
    ciCustom: "未检测到可靠的原生 CI 命令。请输入一个已验证的 CI 命令",
    acceptCi: "确认将这些命令写入 hy-workflow.json？",
    artifacts: "现有团队产物将发生变化",
    acceptArtifacts: "已审阅以上 diff，允许覆盖这些团队产物？",
  },
  en: {
    title: "hy-workflow setup and maintenance",
    language: "Choose language / 选择语言",
    action: "What would you like to do?",
    install: "Install / update",
    unset: "Unset this project",
    clients: "Select AI clients to configure",
    noClients: "Codex, Claude Code, and OpenCode were not detected. Install at least one client first.",
    removeGlobal: "If this is the last project, also remove global MCP configuration?",
    confirm: "Proceed?",
    cancelled: "Cancelled. No changes were made.",
    detecting: "Inspecting clients and effective configuration…",
    detected: "Client inspection complete",
    applying: "Writing configuration and updating clients…",
    applied: "Configuration applied",
    successInstall: "hy-workflow configured successfully! Restart your MCP client (Codex / Claude Code / OpenCode) to load the new tools.",
    successUnset: "hy-workflow deployment for this project has been removed.",
    successNoChange: "Configuration already up to date; no changes needed.",
    ciSuggested: "Detected native CI commands",
    ciCustom: "No safe native CI command was detected. Enter one verified CI command",
    acceptCi: "Write these commands to hy-workflow.json?",
    artifacts: "Existing team artifacts would change",
    acceptArtifacts: "I reviewed the diff and allow these team artifacts to be replaced",
  },
};

function cancelled(value: unknown, message: string): boolean {
  if (!p.isCancel(value)) return false;
  p.cancel(message);
  return true;
}

export async function promptSetupOptions(
  invokedAction: SetupAction,
  detections: ClientDetection[],
  context: {
    introShown?: boolean;
    ciCandidates?: string[];
    hasCiCommands?: boolean;
    artifactChanges?: ArtifactChange[];
    artifactChangesForCi?: (commands?: string[]) => ArtifactChange[];
    readinessIssues?: Array<{ code: string; message: string; recovery: string }>;
  } = {},
): Promise<SetupOptions | null> {
  if (!context.introShown) p.intro(COPY.zh.title);
  const languageValue = await p.select({
    message: COPY.zh.language,
    options: [
      { value: "zh", label: "中文" },
      { value: "en", label: "English" },
    ],
    initialValue: "zh",
  });
  if (cancelled(languageValue, COPY.zh.cancelled)) return null;
  const language = languageValue as "zh" | "en";
  const copy = COPY[language];

  let action: SetupAction = invokedAction;
  if (invokedAction === "setup") {
    const actionValue = await p.select({
      message: copy.action,
      options: [
        { value: "setup", label: copy.install },
        { value: "unset", label: copy.unset },
      ],
      initialValue: "setup",
    });
    if (cancelled(actionValue, copy.cancelled)) return null;
    action = actionValue as SetupAction;
  }

  if (action === "setup" && context.readinessIssues?.length) {
    p.note(context.readinessIssues.map(issue => `${issue.code}: ${issue.message}\n${issue.recovery}`).join("\n\n"), "Project readiness failed");
    throw new SetupFailure(
      "preflight",
      "SETUP_PREFLIGHT_FAILED",
      context.readinessIssues.map(issue => issue.message).join("; "),
      context.readinessIssues[0].recovery,
      { issues: context.readinessIssues },
    );
  }

  const installed = detections.filter(item => item.installed);
  if (action === "setup" && !installed.length) {
    throw new SetupFailure(
      "client_missing",
      "SETUP_CLIENT_NOT_INSTALLED",
      copy.noClients,
      "Install Codex, Claude Code, or OpenCode, then rerun hy-workflow setup.",
      { detections },
    );
  }
  let clientValue: ClientName[] = [];
  if (installed.length) {
    const selected = await p.multiselect({
      message: copy.clients,
      options: installed.map(item => ({
        value: item.name,
        label: item.name === "opencode" ? "OpenCode" : item.name === "claude" ? "Claude Code" : "Codex",
        hint: [item.version, item.configured.length ? `MCP: ${item.configured.join(", ")}` : null].filter(Boolean).join(" · "),
      })),
      initialValues: installed.map(item => item.name),
      required: action === "setup",
    });
    if (cancelled(selected, copy.cancelled)) return null;
    clientValue = selected as ClientName[];
  }

  let acceptCiCommands = false;
  let ciCommands: string[] | undefined;
  if (action === "setup" && !context.hasCiCommands) {
    const candidates = context.ciCandidates ?? [];
    if (candidates.length) {
      p.note(candidates.map(command => `• ${command}`).join("\n"), copy.ciSuggested);
      const accepted = await p.confirm({ message: copy.acceptCi, initialValue: true });
      if (cancelled(accepted, copy.cancelled)) return null;
      if (!accepted) { p.cancel(copy.cancelled); return null; }
      acceptCiCommands = true;
      ciCommands = [...candidates];
    } else {
      const custom = await p.text({ message: copy.ciCustom, placeholder: "npm test", validate: value => value?.trim() ? undefined : "A CI command is required" });
      if (cancelled(custom, copy.cancelled)) return null;
      ciCommands = [String(custom).trim()];
    }
  }

  let acceptArtifactChanges = false;
  let reviewedArtifactChanges: SetupOptions["reviewedArtifactChanges"];
  const exactChanges = context.artifactChangesForCi
    ? context.artifactChangesForCi(ciCommands)
    : context.artifactChanges ?? [];
  const drift = exactChanges.filter(item => item.requiresAcceptance);
  if (action === "setup" && drift.length) {
    p.note(drift.map(item => `${item.file} [${item.changeKind}]\n${item.diff}`).join("\n\n"), copy.artifacts);
    const accepted = await p.confirm({ message: copy.acceptArtifacts, initialValue: false });
    if (cancelled(accepted, copy.cancelled)) return null;
    if (!accepted) { p.cancel(copy.cancelled); return null; }
    acceptArtifactChanges = true;
    reviewedArtifactChanges = drift.map(({ file, beforeHash, afterHash }) => ({ file, beforeHash, afterHash }));
  }

  let removeGlobal = false;
  if (action === "unset") {
    const removeValue = await p.confirm({ message: copy.removeGlobal, initialValue: false });
    if (cancelled(removeValue, copy.cancelled)) return null;
    removeGlobal = Boolean(removeValue);
  }
  const confirmed = await p.confirm({ message: copy.confirm, initialValue: true });
  if (cancelled(confirmed, copy.cancelled)) return null;
  if (!confirmed) {
    p.cancel(copy.cancelled);
    return null;
  }
  return {
    action,
    mode: "shared",
    clients: clientValue,
    language,
    yes: false,
    dryRun: false,
    json: false,
    removeGlobal,
    acceptArtifactChanges,
    reviewedArtifactChanges,
    acceptCiCommands,
    ciCommands,
  };
}

export function beginSetupPrompt(): void {
  p.intro(COPY.zh.title);
}

export function detectWithPrompt<T>(work: () => T): T {
  const spinner = p.spinner();
  spinner.start(COPY.zh.detecting);
  try {
    const result = work();
    spinner.stop(COPY.zh.detected);
    return result;
  } catch (error) {
    spinner.stop(COPY.zh.detected);
    throw error;
  }
}

export async function runWithSpinner<T>(message: string, doneMessage: string, work: () => Promise<T>): Promise<T> {
  const spinner = p.spinner();
  spinner.start(message);
  try {
    const result = await work();
    spinner.stop(doneMessage);
    return result;
  } catch (error) {
    spinner.stop("失败 / Failed");
    throw error;
  }
}

export function successMessage(action: SetupAction, changedFiles: string[], language: SetupOptions["language"]): string {
  const copy = COPY[language ?? "zh"];
  if (action === "unset") return copy.successUnset;
  if (!changedFiles.length) return copy.successNoChange;
  return copy.successInstall;
}

export function failureMessage(language: SetupOptions["language"]): string {
  return language === "en" ? "Setup failed. See error above." : "配置失败，请查看上方错误信息。";
}

export function finishPrompt(message: string): void {
  p.outro(message);
}
