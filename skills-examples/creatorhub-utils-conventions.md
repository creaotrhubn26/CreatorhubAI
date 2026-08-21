---
name: creatorhub-utils-conventions
areas: frontend
filetypes: .ts
---
# frontend/client/src/utils/ conventions

Observed pattern across this directory's known-good files
(`lazyWithRetry.ts`, `errorMessages.ts`, `accessibilityUtils.ts`,
`animation-variants.ts`, `auditLogger.ts`):

- Every file opens with a `/** ... */` block comment: a short title
  line, then 1-3 lines of plain-language description (not a full API
  listing). `lazyWithRetry.ts`'s header explains the *why*
  (stale-chunk-on-deploy failures), not just the *what*.
- Named exports are the norm: `export function`/`const`/`interface`/
  `type`. A single `export default` alongside them is common (3 of the
  5 files here — `errorMessages.ts`, `accessibilityUtils.ts`,
  `auditLogger.ts` — have one), but named exports carry the actual API.
- Types/interfaces declared before the logic that uses them —
  `errorMessages.ts`'s `ErrorContext`/`ErrorMessage`/`ErrorSeverity` sit
  up top. `any`/casts still appear for real edge cases, not banned
  outright: `lazyWithRetry.ts`'s `ComponentType<any>`, `auditLogger.ts`'s
  `(x as any)` casts around `performance`/dynamic sort keys/CSV export —
  sparing use, not a default escape hatch.
- Runtime code wraps browser API access (`sessionStorage`/`window`) in
  `try/catch`, degrading quietly — see `lazyWithRetry.ts`'s
  `getReloadCount`/`setReloadCount`.

Follow this shape for new files in this directory: short header comment
explaining intent, named exports, real types declared up front, and
defensive handling around anything that can throw in a browser context.
