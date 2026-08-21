// Designed empty state: centered, muted, small icon + one-line hint. `text`
// is always an existing honesty string carried in verbatim — this component
// only adds presentation, never changes what's said.
export function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">{icon}</span>
      <span className="empty-state__text">{text}</span>
    </div>
  );
}
