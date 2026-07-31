import * as os from "node:os";
import * as path from "node:path";
import { lstat } from "./skill-fs.js";
import type {
  DetectedHelperSkillTarget,
  EnvironmentOptions,
  HelperSkillAgent,
  HelperSkillPaths,
} from "./skill-types.js";

function pathFromEnv(value: string | undefined, fallback: string): string {
  return path.resolve(value?.trim() || fallback);
}

function executableOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const pathValue = env.PATH;
  if (!pathValue) return false;
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  return pathValue.split(path.delimiter).some(directory => extensions.some(extension => {
    const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
    const alternate = path.join(directory, `${command}${extension.toUpperCase()}`);
    return Boolean(lstat(candidate) ?? lstat(alternate));
  }));
}

export function detectGlobalSkillTargets(options: EnvironmentOptions = {}): DetectedHelperSkillTarget[] {
  const env = options.env ?? process.env;
  const home = path.resolve(options.home ?? os.homedir());
  const platform = options.platform ?? process.platform;
  const xdgConfig = pathFromEnv(env.XDG_CONFIG_HOME, path.join(home, ".config"));
  const codexRoot = pathFromEnv(env.CODEX_HOME, path.join(home, ".codex"));
  const claudeRoot = pathFromEnv(env.CLAUDE_CONFIG_DIR, path.join(home, ".claude"));
  const openCodeRoot = env.OPENCODE_CONFIG_DIR
    ? path.resolve(env.OPENCODE_CONFIG_DIR)
    : env.OPENCODE_CONFIG
      ? path.dirname(path.resolve(env.OPENCODE_CONFIG))
      : path.join(xdgConfig, "opencode");

  const candidates: Array<{ agent: HelperSkillAgent; root: string; explicit: boolean; command: string }> = [
    { agent: "codex", root: codexRoot, explicit: Boolean(env.CODEX_HOME), command: "codex" },
    { agent: "claude", root: claudeRoot, explicit: Boolean(env.CLAUDE_CONFIG_DIR), command: "claude" },
    {
      agent: "opencode",
      root: openCodeRoot,
      explicit: Boolean(env.OPENCODE_CONFIG_DIR || env.OPENCODE_CONFIG),
      command: "opencode",
    },
  ];

  return candidates.map(candidate => {
    const evidence: string[] = [];
    if (candidate.explicit) evidence.push("explicit_environment");
    if (lstat(candidate.root)) evidence.push("config_directory");
    if (executableOnPath(candidate.command, env, platform)) evidence.push("executable_on_path");
    return {
      agent: candidate.agent,
      skillsDir: path.join(candidate.root, "skills"),
      detected: evidence.length > 0,
      evidence,
    };
  });
}

export function helperSkillPaths(options: EnvironmentOptions = {}): HelperSkillPaths {
  const env = options.env ?? process.env;
  const home = path.resolve(options.home ?? os.homedir());
  const platform = options.platform ?? process.platform;
  let dataRoot: string;
  let stateRoot: string;

  if (platform === "win32") {
    const local = pathFromEnv(env.LOCALAPPDATA, path.join(home, "AppData", "Local"));
    dataRoot = path.join(local, "hy-workflow");
    stateRoot = path.join(local, "hy-workflow", "state");
  } else if (platform === "darwin") {
    dataRoot = path.join(home, "Library", "Application Support", "hy-workflow");
    stateRoot = path.join(dataRoot, "state");
  } else {
    dataRoot = path.join(pathFromEnv(env.XDG_DATA_HOME, path.join(home, ".local", "share")), "hy-workflow");
    stateRoot = path.join(pathFromEnv(env.XDG_STATE_HOME, path.join(home, ".local", "state")), "hy-workflow");
  }

  return {
    dataRoot,
    stateRoot,
    ssotRoot: path.join(dataRoot, "skills"),
    manifestPath: path.join(stateRoot, "skill-ownership.json"),
    lockPath: path.join(stateRoot, "skill-projector.lock"),
  };
}
