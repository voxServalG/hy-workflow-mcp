import * as prompts from "@clack/prompts";
import { runHelperCli } from "./cli.js";
import { HELPER_CLI_CLIENTS, type HelperCliDependencies, type HelperCliEnvelope } from "./cli-contract.js";

export type HelperTuiPrompts = {
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  select<T extends string>(options: { message: string; options: Array<prompts.Option<T>> }): Promise<T | symbol>;
  multiselect<T extends string>(options: { message: string; options: Array<prompts.Option<T>>; required?: boolean }): Promise<T[] | symbol>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
  isCancel(value: unknown): value is symbol;
};

const defaultPrompts: HelperTuiPrompts = {
  intro: prompts.intro,
  outro: prompts.outro,
  cancel: prompts.cancel,
  note: prompts.note,
  select: options => prompts.select(options),
  multiselect: options => prompts.multiselect(options),
  confirm: options => prompts.confirm(options),
  isCancel: prompts.isCancel,
};

function summarize(envelope: HelperCliEnvelope): string {
  const skills = envelope.skills;
  const lines = [
    `状态: ${String(skills.status)}`,
    `Skills: ${String(skills.skillCount ?? 0)}`,
    `Agents: ${envelope.clients.join(", ") || "none"}`,
  ];
  if (envelope.changedPaths.length) lines.push(`变更: ${envelope.changedPaths.length} 个用户级路径`);
  const findings = Array.isArray(skills.findings) ? skills.findings : [];
  if (findings.length) lines.push(`问题: ${findings.length}`);
  return lines.join("\n");
}

function cancelled(ui: HelperTuiPrompts): number {
  ui.cancel("已取消，未执行任何变更。");
  return 0;
}

export async function runHelperTui(
  dependencies: HelperCliDependencies = {},
  ui: HelperTuiPrompts = defaultPrompts,
): Promise<number> {
  ui.intro("hy-workflow Skill 管理");
  const status = (await runHelperCli(["status"], dependencies)).envelope;
  ui.note(summarize(status), "当前状态");
  const action = await ui.select({
    message: "选择操作",
    options: [
      { value: "install" as const, label: "安装", hint: "安装恰好三个 hy-workflow Skills" },
      { value: "update" as const, label: "更新 / 修复", hint: "核对所有权并收敛缺失投影" },
      { value: "status" as const, label: "仅检查状态" },
      { value: "remove" as const, label: "移除", hint: "只移除有精确所有权的资源" },
    ],
  });
  if (ui.isCancel(action)) return cancelled(ui);
  if (action === "status") {
    ui.outro("检查完成，未执行变更。");
    return status.status === "failed" ? 1 : 0;
  }

  const argv: string[] = [action];
  if (action === "install") {
    const clients = await ui.multiselect({
      message: "选择要注入 Skill 的 Agent",
      options: HELPER_CLI_CLIENTS.map(value => ({ value, label: value })),
      required: true,
    });
    if (ui.isCancel(clients)) return cancelled(ui);
    argv.push("--clients", clients.join(","));
    const mode = await ui.select({
      message: "选择投影方式",
      options: [
        { value: "auto" as const, label: "自动（推荐）", hint: "优先符号链接，不可用时复制" },
        { value: "symlink" as const, label: "符号链接" },
        { value: "copy" as const, label: "复制" },
      ],
    });
    if (ui.isCancel(mode)) return cancelled(ui);
    argv.push("--mode", mode);
  }
  const confirmed = await ui.confirm({
    message: action === "remove" ? "确认移除所有精确拥有的 Skill 投影？" : `确认执行 ${action}？`,
    initialValue: action !== "remove",
  });
  if (ui.isCancel(confirmed) || !confirmed) return cancelled(ui);
  const result = (await runHelperCli(argv, dependencies)).envelope;
  ui.note(summarize(result), result.ok ? "执行结果" : "执行失败");
  ui.outro(result.ok ? "完成。" : "未完成，请根据上方错误处理。");
  return result.ok ? 0 : 1;
}
