import { memo } from "react";
import { highlightLine, type Lang } from "../../state/highlight";

// One line of source rendered through the hand-rolled tokenizer in
// state/highlight.ts. Extracted out of DiffReviewScreen (Task A3) so the diff
// screen and the read-only code viewer share ONE implementation — including
// the long-line bail below, which would otherwise be easy to get subtly
// different between the two.
//
// ponytail: bail to plain text past 400 chars — an extra-long single line
// (minified bundle, huge JSON blob) would turn into hundreds of tok-* spans
// for a line no one reads token-by-token anyway.
export const HighlightedText = memo(function HighlightedText({
  text,
  lang,
}: {
  text: string;
  lang: Lang;
}) {
  if (text.length > 400) return <>{text}</>;
  return (
    <>
      {highlightLine(text, lang).map((t, i) => (
        <span className={`tok-${t.kind}`} key={i}>
          {t.text}
        </span>
      ))}
    </>
  );
});
