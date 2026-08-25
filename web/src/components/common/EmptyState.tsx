// Designed empty state: centered, muted, small icon + one-line hint. `text`
// is always an existing honesty string carried in verbatim — this component
// only adds presentation, never changes what's said. `action` is optional and
// only wired up at call sites with an obvious next step (e.g. "New Task").
export function EmptyState({
  icon,
  text,
  action,
}: {
  icon: string;
  text: string;
  action?: { label: string; onAction(): void };
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="empty-state__text">{text}</span>
      {action && (
        <button type="button" className="empty-state__action" onClick={action.onAction}>
          {action.label}
        </button>
      )}
    </div>
  );
}
