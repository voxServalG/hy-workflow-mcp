import * as p from "@clack/prompts";
import type { ClientName, DeploymentMode } from "../runtime/deployment.js";
import type { ClientDetection, SetupAction, SetupOptions } from "./types.js";

type Copy = {
  title: string;
  language: string;
  action: string;
  install: string;
  unset: string;
  clients: string;
  noClients: string;
  mode: string;
  local: string;
  shared: string;
  removeGlobal: string;
  confirm: string;
  cancelled: string;
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
    mode: "选择部署模式",
    local: "本机模式（项目零改动）",
    shared: "共享模式（写入 hy-workflow.json 和 CI workflow）",
    removeGlobal: "若这是最后一个项目，同时移除全局 MCP 配置？",
    confirm: "确认执行？",
    cancelled: "已取消，未做任何改动。",
  },
  en: {
    title: "hy-workflow setup and maintenance",
    language: "Choose language / 选择语言",
    action: "What would you like to do?",
    install: "Install / update",
    unset: "Unset this project",
    clients: "Select AI clients to configure",
    noClients: "Codex, Claude Code, and OpenCode were not detected. Install at least one client first.",
    mode: "Choose deployment mode",
    local: "Local mode (zero project changes)",
    shared: "Shared mode (write hy-workflow.json and CI workflow)",
    removeGlobal: "If this is the last project, also remove global MCP configuration?",
    confirm: "Proceed?",
    cancelled: "Cancelled. No changes were made.",
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
): Promise<SetupOptions | null> {
  p.intro(COPY.zh.title);
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

  const installed = detections.filter(item => item.installed);
  if (!installed.length) {
    p.cancel(copy.noClients);
    return null;
  }
  const clientValue = await p.multiselect({
    message: copy.clients,
    options: installed.map(item => ({
      value: item.name,
      label: item.name === "opencode" ? "OpenCode" : item.name === "claude" ? "Claude Code" : "Codex",
      hint: [item.version, item.configured.length ? `MCP: ${item.configured.join(", ")}` : null].filter(Boolean).join(" · "),
    })),
    initialValues: installed.map(item => item.name),
    required: true,
  });
  if (cancelled(clientValue, copy.cancelled)) return null;

  let mode: DeploymentMode = "local";
  if (action === "setup") {
    const modeValue = await p.select({
      message: copy.mode,
      options: [
        { value: "local", label: copy.local },
        { value: "shared", label: copy.shared },
      ],
      initialValue: "local",
    });
    if (cancelled(modeValue, copy.cancelled)) return null;
    mode = modeValue as DeploymentMode;
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
    mode,
    clients: clientValue as ClientName[],
    language,
    yes: false,
    dryRun: false,
    json: false,
    removeGlobal,
  };
}

export function finishPrompt(message: string): void {
  p.outro(message);
}
