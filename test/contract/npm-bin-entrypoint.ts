import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseNpmPackEntries } from "../../src/npm/package.js";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    shell: false,
  });
  assert(!result.error, `${command} failed to start: ${result.error?.message ?? "unknown error"}`);
  assert(
    result.status === 0,
    `${command} ${args.join(" ")} exited ${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

if (process.platform === "win32") {
  process.stdout.write("npm bin entrypoint symlink contract skipped on Windows; scripts/windows-smoke.mjs covers the native shim.\n");
} else {
  const packageRoot = process.cwd();
  const workspace = mkdtempSync(join(tmpdir(), "hy-npm-bin-entrypoint-"));
  const packDirectory = join(workspace, "pack");
  const installRoot = join(workspace, "install");
  mkdirSync(packDirectory, { recursive: true });
  mkdirSync(installRoot, { recursive: true });

  try {
    const npmEnvironment = {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    };
    const pack = run(
      "npm",
      ["pack", "--json", "--pack-destination", packDirectory],
      packageRoot,
      npmEnvironment,
    );
    const packEntries = parseNpmPackEntries(JSON.parse(pack.stdout));
    const archiveName = packEntries[0]?.filename;
    assert(typeof archiveName === "string" && archiveName.length > 0, "npm pack must return the package archive filename");
    const archive = join(packDirectory, archiveName);

    run(
      "npm",
      [
        "install",
        "--prefix",
        installRoot,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--offline",
        archive,
      ],
      packageRoot,
      npmEnvironment,
    );

    const executable = join(installRoot, "node_modules", ".bin", "hy-workflow");
    const installedMain = join(installRoot, "node_modules", "@voxstudio", "hy-workflow", "dist", "main.js");
    assert(lstatSync(executable).isSymbolicLink(), "POSIX npm install must create the hy-workflow .bin symlink");
    assert(realpathSync(executable) === realpathSync(installedMain), "the npm bin symlink must resolve to the installed CLI entrypoint");

    const executableEnvironment = {
      ...process.env,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    };
    const version = run(executable, ["--version"], installRoot, executableEnvironment);
    const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
    assert(version.stdout.trim() === packageVersion, "the npm-created .bin symlink must execute the CLI and print its version");

    const importProbe = [
      `const imported = await import(${JSON.stringify(pathToFileURL(installedMain).href)});`,
      `if (typeof imported.main !== "function") throw new Error("installed main export missing");`,
      `process.stdout.write("import-ok\\n");`,
    ].join("\n");
    const imported = run(
      process.execPath,
      ["--input-type=module", "--eval", importProbe],
      installRoot,
      executableEnvironment,
    );
    assert(imported.stdout === "import-ok\n", "importing the installed entrypoint must not execute the CLI");
    assert(imported.stderr === "", "importing the installed entrypoint must not write to stderr");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
