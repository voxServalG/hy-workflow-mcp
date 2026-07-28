function isIdentifierStart(character) {
  return character === "_" || /[A-Za-z]/.test(character) || (character && character.codePointAt(0) > 127);
}

function isIdentifierPart(character) {
  return isIdentifierStart(character) || /[0-9]/.test(character);
}

function rawStringStart(source, index) {
  let cursor = index;
  if (source[cursor] === "b" || source[cursor] === "c") cursor++;
  if (source[cursor] !== "r") return null;
  cursor++;
  let hashes = 0;
  while (source[cursor] === "#") {
    hashes++;
    cursor++;
  }
  if (source[cursor] !== '"') return null;
  return { contentStart: cursor + 1, hashes, prefixLength: cursor + 1 - index };
}

export function tokenizeRust(source) {
  const tokens = [];
  const errors = [];
  const effective = new Set();
  const delimiters = [];
  let index = 0;
  let line = 1;

  const advance = () => {
    if (source[index] === "\n") line++;
    index++;
  };
  const mark = (start, end) => {
    for (let current = start; current <= end; current++) effective.add(current);
  };
  const token = (value, tokenLine, type = "punctuation") => {
    tokens.push({ value, line: tokenLine, type });
    effective.add(tokenLine);
  };

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/.test(character)) {
      advance();
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (character === "/" && next === "*") {
      const startLine = line;
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth++;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth--;
          index += 2;
        } else {
          advance();
        }
      }
      if (depth > 0) errors.push({ line: startLine, message: "unterminated Rust block comment" });
      continue;
    }

    const raw = rawStringStart(source, index);
    if (raw) {
      const startLine = line;
      const terminator = `"${"#".repeat(raw.hashes)}`;
      index = raw.contentStart;
      const end = source.indexOf(terminator, index);
      if (end < 0) {
        while (index < source.length) advance();
        mark(startLine, line);
        errors.push({ line: startLine, message: "unterminated Rust raw string" });
      } else {
        while (index < end + terminator.length) advance();
        mark(startLine, line);
      }
      tokens.push({ value: "<literal>", line: startLine, type: "literal" });
      continue;
    }

    let stringPrefix = 0;
    if ((character === "b" || character === "c") && next === '"') stringPrefix = 1;
    if (character === '"' || stringPrefix > 0) {
      const startLine = line;
      if (stringPrefix) index++;
      index++;
      let escaped = false;
      let closed = false;
      while (index < source.length) {
        const current = source[index];
        if (escaped) {
          escaped = false;
          advance();
        } else if (current === "\\") {
          escaped = true;
          advance();
        } else if (current === '"') {
          advance();
          closed = true;
          break;
        } else {
          advance();
        }
      }
      mark(startLine, line);
      tokens.push({ value: "<literal>", line: startLine, type: "literal" });
      if (!closed) errors.push({ line: startLine, message: "unterminated Rust string" });
      continue;
    }

    if (character === "'") {
      const startLine = line;
      let cursor = index + 1;
      let escaped = false;
      let close = -1;
      while (cursor < source.length && source[cursor] !== "\n" && cursor - index <= 12) {
        if (escaped) escaped = false;
        else if (source[cursor] === "\\") escaped = true;
        else if (source[cursor] === "'") {
          close = cursor;
          break;
        }
        cursor++;
      }
      if (close > index + 1) {
        while (index <= close) advance();
        mark(startLine, line);
        tokens.push({ value: "<literal>", line: startLine, type: "literal" });
      } else {
        token("'", line);
        index++;
      }
      continue;
    }

    if (isIdentifierStart(character)) {
      const start = index;
      const tokenLine = line;
      while (isIdentifierPart(source[index])) index++;
      token(source.slice(start, index), tokenLine, "identifier");
      continue;
    }
    if (/[0-9]/.test(character)) {
      const start = index;
      const tokenLine = line;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index++;
      token(source.slice(start, index), tokenLine, "number");
      continue;
    }
    if (character === ":" && next === ":") {
      token("::", line);
      index += 2;
      continue;
    }

    token(character, line);
    if ("([{".includes(character)) {
      delimiters.push({ value: character, line });
    } else if (")]}".includes(character)) {
      const expected = character === ")" ? "(" : character === "]" ? "[" : "{";
      const opened = delimiters.pop();
      if (!opened || opened.value !== expected) {
        errors.push({ line, message: `unbalanced Rust delimiter: unexpected ${character}` });
        if (opened) delimiters.push(opened);
      }
    }
    index++;
  }

  for (const opened of delimiters) errors.push({ line: opened.line, message: `unclosed Rust delimiter: ${opened.value}` });
  errors.sort((a, b) => a.line - b.line || a.message.localeCompare(b.message, "en"));
  return { tokens, errors, effectiveLines: effective.size };
}

function parseUseTree(tokens, start, base = []) {
  let index = start;
  const segments = [];
  if (tokens[index]?.value === "::") index++;

  while (index < tokens.length) {
    const current = tokens[index]?.value;
    if (current === "{") {
      const paths = [];
      index++;
      while (index < tokens.length && tokens[index].value !== "}") {
        if (tokens[index].value === ",") {
          index++;
          continue;
        }
        const child = parseUseTree(tokens, index, [...base, ...segments]);
        paths.push(...child.paths);
        if (child.index <= index) index++;
        else index = child.index;
      }
      if (tokens[index]?.value === "}") index++;
      return { paths, index };
    }
    if (current === "*" || current === "self") {
      index++;
      return { paths: [[...base, ...segments]], index };
    }
    if (current === "as") {
      index += 2;
      return { paths: [[...base, ...segments]], index };
    }
    if (current === "," || current === "}" || current === ";") break;
    if (tokens[index]?.type !== "identifier") {
      index++;
      continue;
    }
    segments.push(current);
    index++;
    if (tokens[index]?.value === "::") {
      index++;
      continue;
    }
    break;
  }
  return { paths: segments.length > 0 ? [[...base, ...segments]] : [], index };
}

export function scanRustFile(filePath, source) {
  const lexical = tokenizeRust(source);
  const imports = [];
  const modules = [];
  const tokens = lexical.tokens;

  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value === "use") {
      const parsed = parseUseTree(tokens, index + 1);
      for (const segments of parsed.paths) {
        if (segments.length > 0) imports.push({ segments, line: tokens[index].line });
      }
      index = Math.max(index, parsed.index - 1);
      continue;
    }
    if (tokens[index].value === "mod" && tokens[index + 1]?.type === "identifier") {
      const terminator = tokens[index + 2]?.value;
      if (terminator === ";") modules.push({ name: tokens[index + 1].value, line: tokens[index].line });
    }
  }

  imports.sort((a, b) => a.line - b.line || a.segments.join("::").localeCompare(b.segments.join("::"), "en"));
  modules.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name, "en"));
  return {
    path: filePath,
    effectiveLines: lexical.effectiveLines,
    imports,
    modules,
    errors: lexical.errors.map(error => ({ path: filePath, ...error })),
  };
}
