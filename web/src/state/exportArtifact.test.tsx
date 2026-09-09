import { describe, it, expect } from "vitest";
import { buildArtifactHtml } from "./exportArtifact";

describe("buildArtifactHtml", () => {
  const html = buildArtifactHtml(
    "# Deliverable Title\n\nSome **bold** prose and `code`.\n",
    "spec.md",
  );

  it("produces a self-contained HTML document with inlined styles", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<style>");
    // No external stylesheet or script references.
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toContain("<script");
  });

  it("renders the markdown body, not raw source", () => {
    expect(html).toContain("<h1>Deliverable Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>code</code>");
  });

  it("titles the document from the first heading", () => {
    expect(html).toContain("<title>Deliverable Title</title>");
  });

  it("falls back to the file name when there is no heading, and escapes it", () => {
    const plain = buildArtifactHtml("just prose, no heading\n", "a<b>.md");
    expect(plain).toContain("<title>a&lt;b&gt;.md</title>");
  });

  it("does not pass raw HTML in the source through to the output", () => {
    const withRaw = buildArtifactHtml("# T\n\n<img src=x onerror=alert(1)>\n", "x.md");
    // react-markdown with raw HTML disabled renders the markup as visible text,
    // never as a live element.
    expect(withRaw).not.toContain("<img src=x");
    expect(withRaw).toContain("&lt;img");
  });
});
