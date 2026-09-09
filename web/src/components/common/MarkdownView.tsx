import ReactMarkdown from "react-markdown";

// Renders a documentation/proposal deliverable as its intended prose instead
// of raw diff text — the first slice of "Glimmer artifacts". react-markdown
// renders to React elements (never innerHTML) and raw HTML in the source is
// NOT enabled (no rehype-raw), so an untrusted repo document cannot inject
// markup or script. Links open in a new tab and are stripped of any opener
// reference to this window.
export function MarkdownView({ content }: { content: string }) {
  return (
    <div className="markdown-view">
      <ReactMarkdown
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
