const FENCE_RE = /^(?: {0,3})(`{3,}|~{3,})/;
const HEADING_RE = /^(?: {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const REFERENCE_DEFINITION_RE = /^\s{0,3}\[([^\]]+)\]:\s*(.+)$/;
const REFERENCE_LINK_RE = /\[((?:\\.|[^\]\\])*)\]\[([^\]]*)\]/g;

function stripInlineCode(line) {
  let result = "";
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== "`") {
      result += line[index];
      continue;
    }
    let count = 1;
    while (line[index + count] === "`") count++;
    const marker = "`".repeat(count);
    const end = line.indexOf(marker, index + count);
    if (end === -1) {
      result += line.slice(index);
      break;
    }
    result += " ".repeat(end + count - index);
    index = end + count - 1;
  }
  return result;
}

function extractTarget(raw) {
  const target = raw.trim();
  if (!target) return "";
  if (target.startsWith("<")) {
    const close = target.indexOf(">");
    return close < 0 ? "" : target.slice(1, close).trim();
  }
  let depth = 0;
  for (let index = 0; index < target.length; index++) {
    const character = target[index];
    if (character === "\\") {
      index++;
    } else if (character === "(") {
      depth++;
    } else if (character === ")" && depth > 0) {
      depth--;
    } else if (/\s/.test(character) && depth === 0) {
      return target.slice(0, index);
    }
  }
  return target;
}

function referenceLabel(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

function inlineLinks(line, lineNumber) {
  const links = [];
  let search = 0;
  while (search < line.length) {
    const open = line.indexOf("[", search);
    if (open < 0) break;
    if (open > 0 && line[open - 1] === "!") {
      search = open + 1;
      continue;
    }
    const close = line.indexOf("]", open + 1);
    if (close < 0) break;
    if (line[close + 1] !== "(") {
      search = close + 1;
      continue;
    }
    const targetStart = close + 2;
    let depth = 0;
    let targetEnd = -1;
    for (let index = targetStart; index < line.length; index++) {
      const character = line[index];
      if (character === "\\") index++;
      else if (character === "(") depth++;
      else if (character === ")" && depth > 0) depth--;
      else if (character === ")") {
        targetEnd = index;
        break;
      }
    }
    if (targetEnd < 0) break;
    const target = extractTarget(line.slice(targetStart, targetEnd));
    if (target) links.push({ target, line: lineNumber });
    search = targetEnd + 1;
  }
  return links;
}

export function githubSlug(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

export function parseMarkdown(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const scannable = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const match = FENCE_RE.exec(raw);
    if (match) {
      const marker = match[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence === null) scannable.push({ text: stripInlineCode(raw), line: index + 1 });
  }

  const definitions = new Map();
  for (const item of scannable) {
    const match = REFERENCE_DEFINITION_RE.exec(item.text);
    if (!match) continue;
    const target = extractTarget(match[2]);
    if (target) definitions.set(referenceLabel(match[1]), target);
  }

  const headings = [];
  const anchors = new Set();
  const slugCounts = new Map();
  const links = [];
  const structure = [];
  let previousHeading = 0;
  let h1Count = 0;
  let secondH1Line = null;
  for (const item of scannable) {
    const heading = HEADING_RE.exec(item.text);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      if (!title) structure.push({ line: item.line, message: "heading text is empty" });
      if (headings.length === 0 && level !== 1) structure.push({ line: item.line, message: "the first heading must be level 1" });
      if (previousHeading > 0 && level > previousHeading + 1) {
        structure.push({ line: item.line, message: `heading level jumps from ${previousHeading} to ${level}` });
      }
      if (level === 1) {
        h1Count++;
        if (h1Count === 2) secondH1Line = item.line;
      }
      previousHeading = level;
      const base = githubSlug(title);
      const duplicate = slugCounts.get(base) ?? 0;
      slugCounts.set(base, duplicate + 1);
      const anchor = duplicate === 0 ? base : `${base}-${duplicate}`;
      anchors.add(anchor);
      headings.push({ level, title, anchor, line: item.line });
    }
    links.push(...inlineLinks(item.text, item.line));
    REFERENCE_LINK_RE.lastIndex = 0;
    for (const match of item.text.matchAll(REFERENCE_LINK_RE)) {
      const label = referenceLabel(match[2] || match[1]);
      const target = definitions.get(label);
      if (target) links.push({ target, line: item.line });
    }
    for (const match of item.text.matchAll(/<a\s+(?:[^>]*?\s)?(?:id|name)=["']([^"']+)["'][^>]*>/gi)) {
      anchors.add(match[1]);
    }
  }
  if (h1Count > 1) structure.push({ line: secondH1Line ?? 1, message: "document contains more than one level-1 heading" });
  if (headings.length === 0) structure.push({ line: 1, message: "document must contain a heading" });

  const effectiveLines = lines.filter(line => line.trim() !== "").length;
  return { headings, anchors, links, structure, effectiveLines, unterminatedFence: fence !== null };
}
