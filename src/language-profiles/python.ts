import type { LanguageProfile } from "./types.js";
import { PYTHON_CODE_EXTS } from "../code_ext.js";
import * as path from "node:path";
import * as fs from "node:fs";

function walk(root: string, dir: string, exts: Set<string>): string[] {
  const result: string[] = [];
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return result;
  for (const entry of fs.readdirSync(abs, { encoding: "utf8" })) {
    const full = path.join(abs, entry);
    if (fs.statSync(full).isDirectory()) {
      result.push(...walk(root, path.join(dir, entry), exts));
    } else if (exts.has(path.extname(entry).toLowerCase())) {
      result.push(path.join(dir, entry));
    }
  }
  return result;
}

export const PythonProfile: LanguageProfile = {
  name: "python",
  extensions: [".py", ".pyw", ".pyi"],

  detect(root: string): boolean {
    const markers = ["pyproject.toml", "setup.py", "setup.cfg"];
    return markers.some(f => fs.existsSync(path.join(root, f)));
  },

  compileCommands(root: string, config) {
    const hasPy = config.exts.some(e => PYTHON_CODE_EXTS.has(e));
    if (!hasPy) return [];
    const pyExts = new Set(PYTHON_CODE_EXTS);
    const files = config.codeDirs.flatMap(d => walk(root, d, pyExts)).filter((v, i, a) => a.indexOf(v) === i);
    if (!files.length) {
      return [{
        command: "echo skip", successDetail: "No Python files in configured codeDirs",
        failDetail: "", hard: false, layer: "compile", name: "compile: python (no files)",
      }];
    }
    return [{
      command: { file: "python3", args: ["-m", "py_compile", ...files] },
      successDetail: `${files.length} Python file(s) compiled`,
      failDetail: "Python compile failed",
      hard: true, layer: "compile", name: "compile: python",
    }];
  },

  manifestFiles: [
    "pyproject.toml", "setup.cfg", "setup.py",
    "requirements.txt", "Pipfile", "Pipfile.lock",
    "poetry.lock", "uv.lock",
  ],

  defaultTest: () => "python -m pytest",
};
