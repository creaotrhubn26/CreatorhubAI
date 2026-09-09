import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownView } from "../components/common/MarkdownView";

// "Glimmer artifact" export: turn a markdown deliverable into a self-contained,
// shareable HTML file — the piece that lets a doc/proposal leave the app. The
// body is produced by the SAME renderer the in-app preview uses
// (react-markdown → static markup, raw HTML disabled), so an untrusted repo
// document cannot smuggle markup or script into the exported file, and what
// the recipient opens matches what was reviewed.

// Light, self-contained stylesheet: the file must read well opened cold in any
// browser or printed, with no dependency on the app's theme.
const ARTIFACT_CSS = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #f7f7f5;
    color: #1c1c22;
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    max-width: 46rem;
    margin: 0 auto;
    padding: 3rem 1.5rem 5rem;
    overflow-wrap: break-word;
  }
  h1, h2, h3 { line-height: 1.25; margin: 1.4em 0 0.5em; }
  h1 { font-size: 2rem; border-bottom: 1px solid #e2e2dd; padding-bottom: 0.3em; }
  h2 { font-size: 1.5rem; }
  h3 { font-size: 1.2rem; }
  p, ul, ol { margin: 0.6em 0; }
  a { color: #2563eb; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em;
    background: #ececff;
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  pre {
    background: #1c1c22;
    color: #e6e6ea;
    padding: 0.9rem 1rem;
    border-radius: 8px;
    overflow-x: auto;
  }
  pre code { background: none; padding: 0; color: inherit; }
  blockquote {
    margin: 0.8em 0;
    padding-left: 1rem;
    border-left: 3px solid #d4d4cd;
    color: #55555f;
  }
  table { border-collapse: collapse; margin: 0.8em 0; }
  th, td { border: 1px solid #e2e2dd; padding: 0.4em 0.7em; }
  footer {
    max-width: 46rem;
    margin: 0 auto;
    padding: 0 1.5rem 3rem;
    color: #8b8b96;
    font-size: 0.8rem;
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Title from the first markdown heading, else the file name. */
function deriveTitle(content: string, fallback: string): string {
  const heading = content.match(/^\s{0,3}#\s+(.+?)\s*#*\s*$/m);
  return (heading?.[1] ?? fallback).trim() || fallback;
}

/** Pure, testable: the full self-contained HTML document for a deliverable. */
export function buildArtifactHtml(content: string, fileName: string): string {
  const title = deriveTitle(content, fileName);
  const body = renderToStaticMarkup(<MarkdownView content={content} />);
  const exportedAt = new Date().toISOString().slice(0, 10);
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${escapeHtml(title)}</title>\n` +
    `<style>${ARTIFACT_CSS}</style>\n` +
    `</head>\n<body>\n<main>${body}</main>\n` +
    `<footer>${escapeHtml(fileName)} · exported from Glimmer ${exportedAt}</footer>\n` +
    `</body>\n</html>\n`
  );
}

/** Builds the artifact and hands it to the browser as a download, using the
 * same Blob + anchor mechanism the support-bundle export already relies on
 * (proven to work inside the Tauri webview). */
export function exportMarkdownArtifact(path: string, content: string): string {
  const fileName = path.split("/").pop() || path;
  const htmlName = fileName.replace(/\.(md|markdown|mdx)$/i, "") + ".html";
  const html = buildArtifactHtml(content, fileName);
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = htmlName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return htmlName;
}
