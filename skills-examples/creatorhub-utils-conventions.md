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
  `type`. A single `export default` alongside them shows up sometimes
  (`errorMessages.ts`), but named exports carry the actual API.
- Types/interfaces are declared before the logic that uses them, with
  real field-level types (no `any` observed) — `errorMessages.ts`'s
  `ErrorContext`/`ErrorMessage`/`ErrorSeverity` sit up top.
- Runtime code wraps browser API access (`sessionStorage`/`window`) in
  `try/catch`, degrading quietly — see `lazyWithRetry.ts`'s
  `getReloadCount`/`setReloadCount`.

Follow this shape for new files in this directory: short header comment
explaining intent, named exports, real types declared up front, and
defensive handling around anything that can throw in a browser context.
