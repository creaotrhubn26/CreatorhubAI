---
name: creatorhub-norwegian-ui
areas: frontend
filetypes: .tsx
---
# User-facing UI text is Norwegian

CreatorHub's product surface is Norwegian-language. User-facing strings —
button labels, headings, dialog copy, toasts, form labels — are written
in Norwegian, not English. Observed real examples in this codebase:

- `components/BusinessBrandingSettings.tsx`: a confirm-delete dialog uses
  `<Button onClick={...}>Avbryt</Button>` (Cancel) and
  `<Button ... color="error">Slett</Button>` (Delete).
- `components/ExtraImagePricingDialog.tsx`: `<Button onClick={onClose}>Lukk</Button>`
  (Close).

When adding or editing `.tsx` UI copy in this area, match this: write
new user-facing text in Norwegian, following the existing tone/wording
of nearby components rather than inventing new phrasing.

Keep technical identifiers in English as usual — variable/prop/function
names, TypeScript types, CSS classes, code comments. Only the text a
user actually reads on screen is Norwegian.
