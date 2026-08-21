// Hand-rolled, dependency-free line tokenizer for diff syntax highlighting.
// Deliberately per-line and stateless: no lexer state carries across lines.
// ponytail: a /* ... */ block comment spanning multiple lines will mis-render
// (each line is tokenized independently) — acceptable ceiling; a real fix
// needs a multi-line lexer that threads "inside block comment" state through
// DiffView's line list, not worth it for a diff viewer. Same ceiling covers:
// CSS pseudo-selectors (`:hover`, `::before`) mislexed as a property/value
// pair by tokenizeCss's `prop:` regex; apostrophes inside prose strings
// (e.g. a comment reading "it's fine") throwing off the ts/rs `'` quote
// scanner; and identifiers like `123abc` being split into a number token
// plus a trailing word rather than lexed as one identifier.

export type TokenKind = "code" | "keyword" | "string" | "comment" | "number" | "type";
export interface Token {
  text: string;
  kind: TokenKind;
}
export type Lang = "ts" | "py" | "css" | "json" | "rs" | "plain";

export function langFromPath(path: string): Lang {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "ts":
    case "js":
    case "tsx":
    case "jsx":
      return "ts";
    case "py":
      return "py";
    case "css":
      return "css";
    case "json":
      return "json";
    case "rs":
      return "rs";
    default:
      return "plain";
  }
}

const KEYWORDS: Record<"ts" | "py" | "rs", Set<string>> = {
  ts: new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
    "switch", "case", "break", "continue", "class", "extends", "implements", "interface",
    "type", "import", "export", "from", "default", "new", "this", "super", "typeof",
    "instanceof", "async", "await", "try", "catch", "finally", "throw", "yield",
  ]),
  py: new Set([
    "def", "return", "if", "elif", "else", "for", "while", "class", "import", "from",
    "as", "with", "try", "except", "finally", "raise", "yield", "lambda", "pass",
    "break", "continue", "global", "nonlocal", "and", "or", "not", "in", "is", "None",
    "True", "False", "async", "await",
  ]),
  rs: new Set([
    "fn", "let", "mut", "const", "static", "return", "if", "else", "match", "for",
    "while", "loop", "break", "continue", "struct", "enum", "impl", "trait", "pub",
    "use", "mod", "crate", "self", "Self", "async", "await", "move", "ref", "where",
    "dyn", "as",
  ]),
};

// Order matters: try string/comment openers first (scanning char by char),
// then numbers, then bareword runs (checked against the keyword set).
function tokenizeGeneric(line: string, lang: "ts" | "py" | "rs"): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  const push = (text: string, kind: TokenKind) => {
    if (text.length > 0) tokens.push({ text, kind });
  };
  let code = ""; // accumulator for plain "code" runs between recognized tokens

  const lineComment = lang === "py" ? "#" : "//";

  while (i < n) {
    const ch = line[i];

    // line comment: rest of line
    if (line.startsWith(lineComment, i)) {
      push(code, "code");
      code = "";
      push(line.slice(i), "comment");
      i = n;
      break;
    }

    // block comment /* ... */ (ts/rs only; may not close on this line)
    if (lang !== "py" && ch === "/" && line[i + 1] === "*") {
      push(code, "code");
      code = "";
      const end = line.indexOf("*/", i + 2);
      if (end === -1) {
        push(line.slice(i), "comment");
        i = n;
      } else {
        push(line.slice(i, end + 2), "comment");
        i = end + 2;
      }
      continue;
    }

    // string literal: " ' or ` (ts) — handles escapes, unterminated strings
    if (ch === '"' || ch === "'" || (lang === "ts" && ch === "`")) {
      push(code, "code");
      code = "";
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, j), "string");
      i = j;
      continue;
    }

    // number: digits, optional decimal point, optional exponent
    // (no "preceded by a letter" guard needed — the identifier branch below
    // already consumes every trailing digit of a word like "a2b", so a
    // digit only reaches here when it starts a fresh token)
    if (/[0-9]/.test(ch)) {
      push(code, "code");
      code = "";
      let j = i;
      while (j < n && /[0-9.eExXbBoOa-fA-F_]/.test(line[j])) j++;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }

    // identifier / keyword run
    if (/[A-Za-z_$]/.test(ch)) {
      push(code, "code");
      code = "";
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      push(word, KEYWORDS[lang].has(word) ? "keyword" : "code");
      i = j;
      continue;
    }

    code += ch;
    i++;
  }
  push(code, "code");
  return tokens;
}

function tokenizeCss(line: string): Token[] {
  // property names before ':' get "type"; rest stays code (comments still
  // recognized so /* ... */ inside a value or standalone doesn't look raw).
  const commentStart = line.indexOf("/*");
  if (commentStart !== -1) {
    const before = tokenizeCss(line.slice(0, commentStart));
    const commentEnd = line.indexOf("*/", commentStart + 2);
    const commentEndIdx = commentEnd === -1 ? line.length : commentEnd + 2;
    const comment = line.slice(commentStart, commentEndIdx);
    const after = tokenizeCss(line.slice(commentEndIdx));
    return [...before, { text: comment, kind: "comment" }, ...after];
  }
  const m = line.match(/^(\s*)([-a-zA-Z]+)(\s*:)/);
  if (m) {
    const [, indent, prop, colon] = m;
    const rest = line.slice(indent.length + prop.length + colon.length);
    const parts: Token[] = [
      { text: indent, kind: "code" },
      { text: prop, kind: "type" },
      { text: colon, kind: "code" },
      ...tokenizeGenericStringsAndNumbers(rest),
    ];
    return parts.filter((t) => t.text.length > 0);
  }
  return tokenizeGenericStringsAndNumbers(line);
}

function tokenizeJson(line: string): Token[] {
  // JSON key: leading whitespace + quoted string immediately followed by ':'
  const m = line.match(/^(\s*)("(?:\\.|[^"\\])*")(\s*:)/);
  if (m) {
    const [, indent, key, colon] = m;
    const rest = line.slice(indent.length + key.length + colon.length);
    const parts: Token[] = [
      { text: indent, kind: "code" },
      { text: key, kind: "type" },
      { text: colon, kind: "code" },
      ...tokenizeGenericStringsAndNumbers(rest),
    ];
    return parts.filter((t) => t.text.length > 0);
  }
  return tokenizeGenericStringsAndNumbers(line);
}

// Shared helper for JSON values: still highlight strings/numbers without a
// keyword set (JSON has none).
function tokenizeGenericStringsAndNumbers(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;
  let code = "";
  const push = (text: string, kind: TokenKind) => {
    if (text.length > 0) tokens.push({ text, kind });
  };
  while (i < n) {
    const ch = line[i];
    if (ch === '"') {
      push(code, "code");
      code = "";
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, j), "string");
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(code.slice(-1) || "")) {
      push(code, "code");
      code = "";
      let j = i;
      while (j < n && /[0-9.eE+-]/.test(line[j])) j++;
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }
    code += ch;
    i++;
  }
  push(code, "code");
  return tokens;
}

export function highlightLine(line: string, lang: Lang): Token[] {
  if (line.length === 0) return [];
  switch (lang) {
    case "ts":
      return tokenizeGeneric(line, "ts");
    case "py":
      return tokenizeGeneric(line, "py");
    case "rs":
      return tokenizeGeneric(line, "rs");
    case "css":
      return tokenizeCss(line);
    case "json":
      return tokenizeJson(line);
    case "plain":
    default:
      return line.length > 0 ? [{ text: line, kind: "code" }] : [];
  }
}
