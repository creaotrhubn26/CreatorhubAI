import { describe, it, expect } from "vitest";
import { highlightLine, langFromPath, type Lang } from "./highlight";

const NASTY_FIXTURES: Array<{ line: string; lang: Lang }> = [
  { line: 'const url = "http://example.com"; // not a line comment marker inside the string', lang: "ts" },
  { line: "const s = \"unterminated string that never closes", lang: "ts" },
  { line: "\t\tconst\ttabbed = 1;\t// trailing tab\t", lang: "ts" },
  { line: "const emoji = \"café 😀 unicode\";", lang: "ts" },
  { line: "/* unterminated block comment starts here", lang: "ts" },
  { line: "const x = /* inline */ 5;", lang: "ts" },
  { line: "", lang: "ts" },
  { line: "   ", lang: "ts" },
  { line: "def f(): return '#not a comment inside quotes' # actual comment", lang: "py" },
  { line: "  color: red; /* comment */", lang: "css" },
  { line: '  "key": "value with \\"escaped\\" quotes",', lang: "json" },
  { line: "let s = `template ${x} literal`;", lang: "ts" },
  { line: "fn main() { let x: i32 = -5; }", lang: "rs" },
  { line: "constant is not const, constructor is not const either", lang: "ts" },
  { line: "a2b3 = 0x1F + 3.14e10;", lang: "ts" },
  { line: "no special chars at all here", lang: "plain" },
];

describe("highlightLine — concat invariant", () => {
  for (const { line, lang } of NASTY_FIXTURES) {
    it(`reconstructs "${line}" (${lang}) byte-identical from its tokens`, () => {
      const tokens = highlightLine(line, lang);
      expect(tokens.map((t) => t.text).join("")).toBe(line);
    });
  }

  it("holds for every language on the same tricky line", () => {
    const line = 'weird "line" with # // /* mixed */ markers and 123 numbers';
    (["ts", "py", "css", "json", "rs", "plain"] as Lang[]).forEach((lang) => {
      const tokens = highlightLine(line, lang);
      expect(tokens.map((t) => t.text).join("")).toBe(line);
    });
  });
});

describe("highlightLine — keyword matching", () => {
  it("does not match a keyword substring inside a longer identifier", () => {
    const tokens = highlightLine("constant constructor const", "ts");
    const kinds = tokens.filter((t) => t.text.trim().length > 0).map((t) => `${t.text}:${t.kind}`);
    expect(kinds).toContain("constant:code");
    expect(kinds).toContain("constructor:code");
    expect(kinds).toContain("const:keyword");
  });

  it("classifies strings, comments, and numbers on a representative ts line", () => {
    const tokens = highlightLine('const x = "hi" + 42; // note', "ts");
    expect(tokens.find((t) => t.text === "const")?.kind).toBe("keyword");
    expect(tokens.find((t) => t.text === '"hi"')?.kind).toBe("string");
    expect(tokens.find((t) => t.text === "42")?.kind).toBe("number");
    expect(tokens.find((t) => t.text.startsWith("//"))?.kind).toBe("comment");
  });

  it("classifies python comments and keywords", () => {
    const tokens = highlightLine("def f(): return None  # done", "py");
    expect(tokens.find((t) => t.text === "def")?.kind).toBe("keyword");
    expect(tokens.find((t) => t.text === "return")?.kind).toBe("keyword");
    expect(tokens.find((t) => t.text === "None")?.kind).toBe("keyword");
    expect(tokens.find((t) => t.text.startsWith("#"))?.kind).toBe("comment");
  });

  it("classifies css property names as type, not values", () => {
    const tokens = highlightLine("  background-color: red;", "css");
    expect(tokens.find((t) => t.text === "background-color")?.kind).toBe("type");
  });

  it("highlights numbers and strings inside css values too", () => {
    const line = '  margin: 10px; content: "hi";';
    const tokens = highlightLine(line, "css");
    expect(tokens.find((t) => t.text === "10")?.kind).toBe("number");
    expect(tokens.find((t) => t.text === '"hi"')?.kind).toBe("string");
    expect(tokens.map((t) => t.text).join("")).toBe(line);
  });

  it("classifies json keys as type", () => {
    const tokens = highlightLine('  "path": "src/index.ts",', "json");
    expect(tokens.find((t) => t.text === '"path"')?.kind).toBe("type");
    expect(tokens.find((t) => t.text === '"src/index.ts"')?.kind).toBe("string");
  });

  it("plain lang never highlights, returns the whole line as one code token", () => {
    const tokens = highlightLine('const x = "hi"; // whatever', "plain");
    expect(tokens).toEqual([{ text: 'const x = "hi"; // whatever', kind: "code" }]);
  });
});

describe("langFromPath", () => {
  it.each([
    ["src/index.ts", "ts"],
    ["src/index.tsx", "ts"],
    ["src/index.js", "ts"],
    ["src/index.jsx", "ts"],
    ["scripts/build.py", "py"],
    ["src/theme.css", "css"],
    ["package.json", "json"],
    ["src/main.rs", "rs"],
    ["README.md", "plain"],
    ["Dockerfile", "plain"],
  ] as const)("%s -> %s", (path, lang) => {
    expect(langFromPath(path)).toBe(lang);
  });
});
