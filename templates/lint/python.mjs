import { spawnSync } from "node:child_process";

const PYTHON_SCANNER = String.raw`
import ast
import io
import json
import sys
import tokenize

payload = json.load(sys.stdin)
results = []
errors = []

for item in payload.get("files", []):
    file_path = item.get("path", "")
    source = item.get("source", "")
    imports = []
    effective = set()
    try:
        tree = ast.parse(source, filename=file_path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.append({
                        "kind": "import",
                        "module": alias.name,
                        "level": 0,
                        "names": [],
                        "line": getattr(node, "lineno", 1),
                    })
            elif isinstance(node, ast.ImportFrom):
                imports.append({
                    "kind": "from",
                    "module": node.module or "",
                    "level": node.level or 0,
                    "names": [alias.name for alias in node.names],
                    "line": getattr(node, "lineno", 1),
                })
    except SyntaxError as error:
        errors.append({
            "path": file_path,
            "line": error.lineno or 1,
            "message": "Python syntax error: " + (error.msg or str(error)),
        })
    except Exception as error:
        errors.append({
            "path": file_path,
            "line": 1,
            "message": "Python AST failure: " + type(error).__name__ + ": " + str(error),
        })

    try:
        ignored = {
            tokenize.ENCODING,
            tokenize.ENDMARKER,
            tokenize.INDENT,
            tokenize.DEDENT,
            tokenize.NEWLINE,
            tokenize.NL,
            tokenize.COMMENT,
        }
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type in ignored:
                continue
            start_line, end_line = token.start[0], token.end[0]
            for line in range(start_line, end_line + 1):
                effective.add(line)
    except (tokenize.TokenError, IndentationError, SyntaxError) as error:
        line = 1
        if getattr(error, "args", None) and len(error.args) > 1 and isinstance(error.args[1], tuple):
            line = error.args[1][0] or 1
        errors.append({
            "path": file_path,
            "line": line,
            "message": "Python tokenize error: " + str(error),
        })
    except Exception as error:
        errors.append({
            "path": file_path,
            "line": 1,
            "message": "Python tokenize failure: " + type(error).__name__ + ": " + str(error),
        })

    imports.sort(key=lambda value: (
        value.get("line", 0),
        value.get("level", 0),
        value.get("module", ""),
        ",".join(value.get("names", [])),
    ))
    results.append({
        "path": file_path,
        "effectiveLines": len(effective),
        "imports": imports,
    })

results.sort(key=lambda value: value["path"])
errors.sort(key=lambda value: (value["path"], value["line"], value["message"]))
json.dump({"version": 1, "results": results, "errors": errors}, sys.stdout, ensure_ascii=False)
`;

function commandCandidates(pythonCommand) {
  if (typeof pythonCommand === "string" && pythonCommand.trim()) return [pythonCommand.trim()];
  return process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
}

function protocolFailure(message) {
  return { command: null, results: [], errors: [{ path: ".", line: 1, message }] };
}

export function scanPython(files, options = {}) {
  const payload = JSON.stringify({
    version: 1,
    files: files.map(file => ({ path: file.path, source: file.source })),
  });

  let lastMissing = null;
  for (const command of commandCandidates(options.pythonCommand)) {
    const child = spawnSync(command, ["-I", "-c", PYTHON_SCANNER], {
      input: payload,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
      timeout: options.timeoutMs ?? 30_000,
      windowsHide: true,
    });
    if (child.error?.code === "ENOENT") {
      lastMissing = child.error;
      continue;
    }
    if (child.error) return protocolFailure(`Python scanner could not start: ${child.error.message}`);
    if (child.status !== 0) {
      const detail = String(child.stderr || "").trim();
      return protocolFailure(`Python scanner exited with status ${String(child.status)}${detail ? `: ${detail}` : ""}`);
    }
    try {
      const parsed = JSON.parse(child.stdout);
      if (parsed?.version !== 1 || !Array.isArray(parsed.results) || !Array.isArray(parsed.errors)) {
        return protocolFailure("Python scanner returned an invalid protocol envelope");
      }
      return {
        command,
        results: parsed.results,
        errors: parsed.errors,
      };
    } catch (error) {
      return protocolFailure(`Python scanner returned invalid JSON: ${error?.message ?? String(error)}`);
    }
  }
  return protocolFailure(`Python interpreter is unavailable${lastMissing ? `: ${lastMissing.message}` : ""}`);
}
