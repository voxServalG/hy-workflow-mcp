import * as path from "node:path";
import { countGenericEffectiveLines, listFiles, normalizeRelative, readTextFile, slashPath } from "./fs.mjs";
import { scanPython } from "./python.mjs";
import { scanRustFile } from "./rust.mjs";

const JAVASCRIPT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const DEPENDENCY_EXTENSIONS = new Set([".py", ".rs", ...JAVASCRIPT_EXTENSIONS]);

function finding(rule, severity, filePath, message, line) {
  return {
    rule,
    severity,
    path: filePath,
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
    message,
  };
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

function candidateFile(fileSet, base, knownExtensions) {
  const normalized = slashPath(path.normalize(base));
  const explicitExtension = path.extname(normalized).toLowerCase();
  const stems = [normalized];
  if (JAVASCRIPT_EXTENSIONS.has(explicitExtension)) stems.push(normalized.slice(0, -explicitExtension.length));
  const candidates = stems.flatMap(stem => [
    stem,
    ...knownExtensions.map(extension => `${stem}${extension}`),
    ...knownExtensions.map(extension => `${stem}/index${extension}`),
  ]);
  return candidates.find(candidate => fileSet.has(candidate)) ?? null;
}

function resolveJavaScript(file, specifier, fileSet, knownExtensions) {
  if (!specifier.startsWith(".")) return null;
  const base = slashPath(path.join(path.dirname(file), specifier));
  return candidateFile(fileSet, base, knownExtensions);
}

function moduleRoots(files, roots, extension) {
  const mappings = [];
  for (const root of roots) {
    const normalizedRoot = normalizeRelative(root);
    if (normalizedRoot === null) continue;
    for (const file of files.filter(candidate => path.extname(candidate).toLowerCase() === extension)) {
      if (normalizedRoot !== "." && file !== normalizedRoot && !file.startsWith(`${normalizedRoot}/`)) continue;
      const relative = normalizedRoot === "." ? file : file.slice(normalizedRoot.length + 1);
      let module = relative.slice(0, -extension.length).split("/");
      const init = module.at(-1) === "__init__";
      if (init) module = module.slice(0, -1);
      mappings.push({ root: normalizedRoot, file, module, init });
    }
  }
  return mappings;
}

function findModule(mappings, segments, root) {
  const scoped = mappings.filter(mapping => mapping.root === root);
  for (let length = segments.length; length > 0; length--) {
    const target = segments.slice(0, length).join(".");
    const match = scoped.find(mapping => mapping.module.join(".") === target);
    if (match) return match.file;
  }
  return null;
}

function resolvePython(file, imported, mappings) {
  const current = mappings.find(mapping => mapping.file === file);
  if (!current) return [];
  const results = new Set();
  if (imported.kind === "import") {
    const target = findModule(mappings, imported.module.split(".").filter(Boolean), current.root);
    if (target) results.add(target);
    return [...results];
  }
  const packageSegments = current.init ? current.module : current.module.slice(0, -1);
  const base = imported.level > 0
    ? packageSegments.slice(0, Math.max(0, packageSegments.length - imported.level + 1))
    : [];
  const moduleSegments = imported.module.split(".").filter(Boolean);
  const prefix = imported.level > 0 ? [...base, ...moduleSegments] : moduleSegments;
  const direct = findModule(mappings, prefix, current.root);
  if (direct) results.add(direct);
  for (const name of imported.names ?? []) {
    if (name === "*") continue;
    const child = findModule(mappings, [...prefix, ...name.split(".")], current.root);
    if (child) results.add(child);
  }
  return [...results];
}

function rustMappings(files, roots) {
  const mappings = [];
  for (const root of roots) {
    const normalizedRoot = normalizeRelative(root);
    if (normalizedRoot === null) continue;
    for (const file of files.filter(candidate => path.extname(candidate).toLowerCase() === ".rs")) {
      if (normalizedRoot !== "." && file !== normalizedRoot && !file.startsWith(`${normalizedRoot}/`)) continue;
      const relative = normalizedRoot === "." ? file : file.slice(normalizedRoot.length + 1);
      let module = relative.slice(0, -3).split("/");
      if (module.at(-1) === "lib" || module.at(-1) === "main" || module.at(-1) === "mod") module = module.slice(0, -1);
      mappings.push({ root: normalizedRoot, file, module });
    }
  }
  return mappings;
}

function findRustModule(mappings, root, segments) {
  const scoped = mappings.filter(mapping => mapping.root === root);
  for (let length = segments.length; length > 0; length--) {
    const target = segments.slice(0, length).join("::");
    const match = scoped.find(mapping => mapping.module.join("::") === target);
    if (match) return match.file;
  }
  return null;
}

function resolveRust(file, imported, mappings) {
  const current = mappings.find(mapping => mapping.file === file);
  if (!current) return null;
  const segments = [...imported.segments];
  let base = [];
  if (segments[0] === "crate") {
    segments.shift();
  } else if (segments[0] === "self") {
    segments.shift();
    base = current.module;
  } else {
    base = current.module.slice(0, -1);
    while (segments[0] === "super") {
      segments.shift();
      base = base.slice(0, -1);
    }
  }
  return findRustModule(mappings, current.root, [...base, ...segments])
    ?? (base.length > 0 ? findRustModule(mappings, current.root, segments) : null);
}

function resolveRustModule(file, module, mappings) {
  const current = mappings.find(mapping => mapping.file === file);
  if (!current) return null;
  return findRustModule(mappings, current.root, [...current.module, module.name]);
}

function normalizeTiers(config, findings) {
  const raw = config?.codelint?.tiers;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return { configured: false, tiers: [] };
  if (!Array.isArray(raw)) {
    findings.push(finding("C003", "error", "hy-workflow.json", "codelint.tiers must be an array"));
    return { configured: true, tiers: [] };
  }
  const tiers = [];
  const names = new Set();
  const paths = [];
  for (let index = 0; index < raw.length; index++) {
    const tier = raw[index];
    if (!tier || typeof tier !== "object" || typeof tier.name !== "string" || !tier.name.trim() || !Array.isArray(tier.paths) || tier.paths.length === 0) {
      findings.push(finding("C003", "error", "hy-workflow.json", `codelint.tiers[${index}] must contain a non-empty name and paths`));
      continue;
    }
    if (names.has(tier.name)) findings.push(finding("C003", "error", "hy-workflow.json", `duplicate tier name: ${tier.name}`));
    names.add(tier.name);
    const normalizedPaths = [];
    for (const rawPath of tier.paths) {
      const normalized = normalizeRelative(rawPath);
      if (normalized === null) {
        findings.push(finding("C003", "error", "hy-workflow.json", `unsafe tier path: ${String(rawPath)}`));
        continue;
      }
      if (paths.some(existing => existing === normalized || existing.startsWith(`${normalized}/`) || normalized.startsWith(`${existing}/`))) {
        findings.push(finding("C003", "error", "hy-workflow.json", `tier paths must not overlap: ${normalized}`));
        continue;
      }
      paths.push(normalized);
      normalizedPaths.push(normalized);
    }
    tiers.push({ name: tier.name, paths: normalizedPaths, index });
  }
  return { configured: true, tiers };
}

function tierFor(file, tiers) {
  return tiers.find(tier => tier.paths.some(prefix => prefix === "." || file === prefix || file.startsWith(`${prefix}/`))) ?? null;
}

function stronglyConnected(graph) {
  const components = [];
  const indexByNode = new Map();
  const lowByNode = new Map();
  const stack = [];
  const onStack = new Set();
  let nextIndex = 0;
  const visit = node => {
    indexByNode.set(node, nextIndex);
    lowByNode.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);
    for (const target of [...(graph.get(node) ?? [])].sort((a, b) => a.localeCompare(b, "en"))) {
      if (!indexByNode.has(target)) {
        visit(target);
        lowByNode.set(node, Math.min(lowByNode.get(node), lowByNode.get(target)));
      } else if (onStack.has(target)) {
        lowByNode.set(node, Math.min(lowByNode.get(node), indexByNode.get(target)));
      }
    }
    if (lowByNode.get(node) !== indexByNode.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const current = stack.pop();
      onStack.delete(current);
      component.push(current);
      if (current === node) break;
    }
    components.push(component.sort((a, b) => a.localeCompare(b, "en")));
  };
  for (const node of [...graph.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
    if (!indexByNode.has(node)) visit(node);
  }
  return components;
}

export function lintCode({ root, config, pythonCommand }) {
  const findings = [];
  const codeExtensions = extensions(config);
  const roots = lintDirectories(config);
  if (codeExtensions.length === 0) findings.push(finding("C001", "error", "hy-workflow.json", "project.codeExt must configure at least one extension"));
  if (roots.length === 0) findings.push(finding("C001", "error", "hy-workflow.json", "codelint.lintDirs must configure at least one directory"));

  const listed = listFiles(root, roots, { extensions: codeExtensions });
  for (const issue of listed.issues) findings.push(finding("C001", "error", issue.path, issue.message));
  if (listed.files.length === 0) findings.push(finding("C001", "error", roots[0] ?? ".", "configured code scan contains no files"));
  for (const extension of codeExtensions) {
    if (!listed.files.some(file => path.extname(file).toLowerCase() === extension)) {
      findings.push(finding("C001", "error", roots[0] ?? ".", `configured extension has no scanned files: ${extension}`));
    }
  }

  const sources = new Map();
  for (const file of listed.files) {
    const read = readTextFile(root, file);
    if (!read.ok) findings.push(finding("C005", "error", file, read.error));
    else sources.set(file, read.text);
  }

  const scans = new Map();
  const pythonFiles = [...sources]
    .filter(([file]) => path.extname(file).toLowerCase() === ".py")
    .map(([file, source]) => ({ path: file, source }));
  if (pythonFiles.length > 0) {
    const python = scanPython(pythonFiles, { pythonCommand });
    for (const result of python.results) scans.set(result.path, { language: "python", ...result });
    for (const issue of python.errors) findings.push(finding("C005", "error", issue.path, issue.message, issue.line));
    for (const file of pythonFiles) {
      if (!scans.has(file.path)) findings.push(finding("C005", "error", file.path, "Python scanner omitted a configured file"));
    }
  }
  for (const [file, source] of sources) {
    const extension = path.extname(file).toLowerCase();
    if (extension === ".py") continue;
    if (extension === ".rs") {
      const result = scanRustFile(file, source);
      scans.set(file, { language: "rust", ...result });
      for (const issue of result.errors) findings.push(finding("C005", "error", issue.path, issue.message, issue.line));
    } else if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      const result = scanJavaScript(file, source);
      scans.set(file, { language: "javascript", ...result });
      for (const issue of result.errors) findings.push(finding("C005", "error", issue.path, issue.message, issue.line));
    } else {
      scans.set(file, { language: "generic", path: file, effectiveLines: countGenericEffectiveLines(source), imports: [], errors: [] });
    }
  }

  const limits = thresholds(config);
  for (const issue of limits.issues) findings.push(finding("C002", "error", "hy-workflow.json", issue));
  for (const [file, scan] of scans) {
    if (scan.effectiveLines > limits.error) {
      findings.push(finding("C002", "error", file, `code file has ${scan.effectiveLines} effective lines; error threshold is ${limits.error}`));
    } else if (scan.effectiveLines > limits.warning) {
      findings.push(finding("C002", "warning", file, `code file has ${scan.effectiveLines} effective lines; warning threshold is ${limits.warning}`));
    }
  }

  const graph = new Map(listed.files.map(file => [file, new Set()]));
  const knownExtensions = codeExtensions.filter(extension => JAVASCRIPT_EXTENSIONS.has(extension));
  const pythonMappings = moduleRoots(listed.files, roots, ".py");
  const rustModuleMappings = rustMappings(listed.files, roots);
  for (const [file, scan] of scans) {
    const targets = graph.get(file);
    if (!targets) continue;
    if (scan.language === "javascript") {
      for (const imported of scan.imports) {
        const target = resolveJavaScript(file, imported.specifier, new Set(listed.files), knownExtensions);
        if (target && target !== file) targets.add(target);
      }
    } else if (scan.language === "python") {
      for (const imported of scan.imports) {
        for (const target of resolvePython(file, imported, pythonMappings)) if (target !== file) targets.add(target);
      }
    } else if (scan.language === "rust") {
      for (const imported of scan.imports) {
        const target = resolveRust(file, imported, rustModuleMappings);
        if (target && target !== file) targets.add(target);
      }
      for (const module of scan.modules) {
        const target = resolveRustModule(file, module, rustModuleMappings);
        if (target && target !== file) targets.add(target);
      }
    }
  }

  const tierConfig = normalizeTiers(config, findings);
  if (tierConfig.configured) {
    for (const [source, targets] of graph) {
      const sourceTier = tierFor(source, tierConfig.tiers);
      if (!sourceTier) continue;
      for (const target of targets) {
        const targetTier = tierFor(target, tierConfig.tiers);
        if (targetTier && targetTier.index < sourceTier.index) {
          findings.push(finding("C003", "error", source, `tier ${sourceTier.name} must not depend on higher tier ${targetTier.name}: ${target}`));
        }
      }
    }
  }

  const supportsDependencies = listed.files.some(file => DEPENDENCY_EXTENSIONS.has(path.extname(file).toLowerCase()));
  if (supportsDependencies) {
    for (const component of stronglyConnected(graph)) {
      if (component.length > 1) {
        findings.push(finding("C004", "error", component[0], `dependency cycle component: ${component.join(", ")}`));
      }
    }
  }

  return {
    files: listed.files,
    findings,
    graph,
    scans,
    tierConfigured: tierConfig.configured,
    supportsDependencies,
  };
}
