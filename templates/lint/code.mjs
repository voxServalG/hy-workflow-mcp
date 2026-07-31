import * as path from "node:path";
import { countGenericEffectiveLines, listFiles, readTextFile } from "./fs.mjs";
import { scanPython } from "./python.mjs";
import { scanRustFile } from "./rust.mjs";

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const PARSER_EXTENSIONS = new Set([".py", ".rs", ...JAVASCRIPT_EXTENSIONS]);

function finding(rule, severity, filePath, message, line) {
  return {
    rule,
    severity,
    path: filePath,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    message,
  };
}

function addFinding(findings, resolvePolicyRule, rule, severity, filePath, message, line) {
  const policy = typeof resolvePolicyRule === "function" ? resolvePolicyRule(rule, filePath) : null;
  const configured = policy?.severity;
  const effective = configured === "off" ? null
    : configured === "advisory" ? "advisory"
      : configured === "warning" ? "warning"
        : severity;
  if (effective) findings.push(finding(rule, effective, filePath, message, line));
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function thresholds(config) {
  const lint = config?.codelint ?? {};
  const issues = [];
  for (const field of ["maxLines", "maxLinesWarning", "maxLinesError"]) {
    if (lint[field] !== undefined && positiveInteger(lint[field]) === null) issues.push(`codelint.${field} must be a positive integer`);
  }
  const legacyError = positiveInteger(lint.maxLines);
  const error = positiveInteger(lint.maxLinesError) ?? legacyError ?? 500;
  const warning = positiveInteger(lint.maxLinesWarning) ?? 300;
  if (legacyError !== null && positiveInteger(lint.maxLinesError) !== null && legacyError !== lint.maxLinesError) {
    issues.push("codelint.maxLinesError must equal legacy codelint.maxLines when both are configured");
  }
  if (warning > error) issues.push("codelint.maxLinesWarning must not exceed codelint.maxLinesError");
  return { warning, error, issues };
}

function extensions(config) {
  const raw = config?.project?.codeExt;
  const values = Array.isArray(raw) ? raw : [raw];
  return [...new Set(values
    .filter(value => typeof value === "string" && value.trim())
    .map(value => value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`))]
    .sort((a, b) => a.localeCompare(b, "en"));
}

function lintDirectories(config) {
  const raw = config?.codelint?.lintDirs ?? config?.project?.codeDirs;
  return Array.isArray(raw) ? raw.filter(value => typeof value === "string") : [];
}

function canStartRegularExpression(tokens) {
  const previous = tokens.at(-1);
  if (!previous) return true;
  if (previous.type === "punctuation") {
    return ["(", "[", "{", ":", ";", ",", "=", "!", "?", "=>", "&", "|", "+", "-", "*", "%", "^", "~", "<", ">"].includes(previous.value);
  }
  return previous.type === "identifier"
    && ["await", "case", "delete", "do", "else", "in", "instanceof", "new", "return", "throw", "typeof", "void", "yield"].includes(previous.value);
}


function tokenizeJavaScript(source) {
  const tokens = [];
  const errors = [];
  const effective = new Set();
  let index = 0;
  let line = 1;
  const mark = current => effective.add(current);

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === "\n") {
      line++;
      index++;
      continue;
    }
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (character === "/" && next === "*") {
      const startLine = line;
      index += 2;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\n") line++;
        if (source[index] === "*" && source[index + 1] === "/") {
          index += 2;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) errors.push({ line: startLine, message: "unterminated block comment" });
      continue;
    }
    if (character === "/" && canStartRegularExpression(tokens)) {
      const startLine = line;
      let escaped = false;
      let characterClass = false;
      let closed = false;
      index++;
      while (index < source.length && source[index] !== "\n") {
        const current = source[index];
        if (escaped) {
          escaped = false;
        } else if (current === "\\") {
          escaped = true;
        } else if (current === "[") {
          characterClass = true;
        } else if (current === "]") {
          characterClass = false;
        } else if (current === "/" && !characterClass) {
          index++;
          while (/[A-Za-z]/.test(source[index] ?? "")) index++;
          closed = true;
          break;
        }
        index++;
      }
      mark(startLine);
      tokens.push({ type: "literal", value: "<regexp>", line: startLine });
      if (!closed) errors.push({ line: startLine, message: "unterminated regular expression literal" });
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      const quote = character;
      const startLine = line;
      let value = "";
      let interpolated = false;
      let escaped = false;
      let closed = false;
      index++;
      while (index < source.length) {
        const current = source[index];
        if (escaped) {
          value += current;
          escaped = false;
          index++;
        } else if (current === "\\") {
          escaped = true;
          index++;
        } else if (current === quote) {
          index++;
          closed = true;
          break;
        } else if (quote !== "`" && current === "\n") {
          break;
        } else {
          if (quote === "`" && current === "$" && source[index + 1] === "{") interpolated = true;
          if (current === "\n") {
            line++;
            mark(line);
          }
          value += current;
          index++;
        }
      }
      mark(startLine);
      tokens.push({ type: interpolated ? "template" : "string", value, line: startLine });
      if (!closed) errors.push({ line: startLine, message: "unterminated string literal" });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      const tokenLine = line;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index++;
      tokens.push({ type: "identifier", value: source.slice(start, index), line: tokenLine });
      mark(tokenLine);
      continue;
    }
    const tokenLine = line;
    const combined = ["=>", "?.", "??", "===", "!=="].find(value => source.startsWith(value, index));
    if (combined) {
      tokens.push({ type: "punctuation", value: combined, line: tokenLine });
      index += combined.length;
    } else {
      tokens.push({ type: "punctuation", value: character, line: tokenLine });
      index++;
    }
    mark(tokenLine);
  }
  return { tokens, errors, effectiveLines: effective.size };
}

function scanJavaScript(filePath, source) {
  const lexical = tokenizeJavaScript(source);
  const imports = [];
  const tokens = lexical.tokens;
  const add = (specifier, line) => {
    if (typeof specifier === "string" && specifier) imports.push({ specifier, line });
  };
  for (let index = 0; index < tokens.length; index++) {
    const current = tokens[index];
    if (current.value === "import") {
      const typeOnly = tokens[index + 1]?.value === "type";
      if (tokens[index + 1]?.type === "string") add(tokens[index + 1].value, current.line);
      else if (tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string") add(tokens[index + 2].value, current.line);
      else {
        let cursor = index + 1;
        while (cursor < tokens.length && tokens[cursor].value !== ";" && tokens[cursor].value !== "from") cursor++;
        if (!typeOnly && tokens[cursor]?.value === "from" && tokens[cursor + 1]?.type === "string") add(tokens[cursor + 1].value, current.line);
      }
    } else if (current.value === "export") {
      const typeOnly = tokens[index + 1]?.value === "type";
      let cursor = index + 1;
      while (cursor < tokens.length && tokens[cursor].value !== ";" && tokens[cursor].value !== "from") cursor++;
      if (!typeOnly && tokens[cursor]?.value === "from" && tokens[cursor + 1]?.type === "string") add(tokens[cursor + 1].value, current.line);
    } else if (current.value === "require" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string") {
      add(tokens[index + 2].value, current.line);
    }
  }
  imports.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier, "en"));
  return {
    path: filePath,
    effectiveLines: lexical.effectiveLines,
    imports,
    errors: lexical.errors.map(error => ({ path: filePath, ...error })),
  };
}

export function lintCode({ root, config, pythonCommand, resolvePolicyRule }) {
  const findings = [];
  const codeExtensions = extensions(config);
  const roots = lintDirectories(config);
  if (codeExtensions.length === 0) addFinding(findings, resolvePolicyRule, "C001", "error", "hy-workflow.json", "project.codeExt must configure at least one extension");
  if (roots.length === 0) addFinding(findings, resolvePolicyRule, "C001", "error", "hy-workflow.json", "codelint.lintDirs must configure at least one directory");

  const listed = listFiles(root, roots, { extensions: codeExtensions });
  for (const issue of listed.issues) addFinding(findings, resolvePolicyRule, "C001", "error", issue.path, issue.message);
  if (listed.files.length === 0) addFinding(findings, resolvePolicyRule, "C001", "error", roots[0] ?? ".", "configured code scan contains no files");
  for (const extension of codeExtensions) {
    if (!listed.files.some(file => path.extname(file).toLowerCase() === extension)) {
      addFinding(findings, resolvePolicyRule, "C001", "error", roots[0] ?? ".", `configured extension has no scanned files: ${extension}`);
    }
  }

  const sources = new Map();
  for (const file of listed.files) {
    const read = readTextFile(root, file);
    if (!read.ok) addFinding(findings, resolvePolicyRule, "C005", "error", file, read.error);
    else sources.set(file, read.text);
  }

  const scans = new Map();
  const pythonFiles = [...sources]
    .filter(([file]) => path.extname(file).toLowerCase() === ".py")
    .map(([file, source]) => ({ path: file, source }));
  if (pythonFiles.length > 0) {
    const python = scanPython(pythonFiles, { pythonCommand });
    for (const result of python.results) scans.set(result.path, { language: "python", ...result });
    for (const issue of python.errors) addFinding(findings, resolvePolicyRule, "C005", "error", issue.path, issue.message, issue.line);
    for (const file of pythonFiles) {
      if (!scans.has(file.path)) addFinding(findings, resolvePolicyRule, "C005", "error", file.path, "Python scanner omitted a configured file");
    }
  }
  for (const [file, source] of sources) {
    const extension = path.extname(file).toLowerCase();
    if (extension === ".py") continue;
    if (extension === ".rs") {
      const result = scanRustFile(file, source);
      scans.set(file, { language: "rust", ...result });
      for (const issue of result.errors) addFinding(findings, resolvePolicyRule, "C005", "error", issue.path, issue.message, issue.line);
    } else if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      const result = scanJavaScript(file, source);
      scans.set(file, { language: "javascript", ...result });
      for (const issue of result.errors) addFinding(findings, resolvePolicyRule, "C005", "error", issue.path, issue.message, issue.line);
    } else {
      scans.set(file, { language: "generic", path: file, effectiveLines: countGenericEffectiveLines(source), imports: [], errors: [] });
    }
  }

  const limits = thresholds(config);
  for (const issue of limits.issues) findings.push(finding("C002", "error", "hy-workflow.json", issue));
  for (const [file, scan] of scans) {
    const policy = typeof resolvePolicyRule === "function" ? resolvePolicyRule("C002", file) : null;
    const error = policy?.error ?? limits.error;
    const warning = policy?.warning ?? limits.warning;
    if (scan.effectiveLines > error) {
      addFinding(findings, resolvePolicyRule, "C002", "error", file, `code file has ${scan.effectiveLines} effective lines; error threshold is ${error}`);
    } else if (scan.effectiveLines > warning) {
      addFinding(findings, resolvePolicyRule, "C002", "warning", file, `code file has ${scan.effectiveLines} effective lines; warning threshold is ${warning}`);
    }
  }

  const supportsParser = listed.files.some(file => PARSER_EXTENSIONS.has(path.extname(file).toLowerCase()));
  return { files: listed.files, findings, scans, supportsParser };
}
