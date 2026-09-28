# Workspace UI verification — 28 September 2026

The redesign is a presentation layer over the existing React shell and persistent builder iframe. Existing controls are moved into the dock as the same DOM nodes, preserving their handlers, values, image sources, and layout state. Shared CSS tokens theme existing components instead of duplicating their business logic.

## Control locations

| Area | Existing controls |
| --- | --- |
| Slim header | Brand, Master PrintLab byline, measurement unit, language, right-aligned Account & exports reveal/menu |
| Account reveal | Existing credit/trial status, Client Portal entry/badge, account/settings, sign-in/out and owner controls |
| Designs | Design Library, file picker, all design cards, dimensions, quantity, vibrance, background editor, optimizer, reset and Add to layout |
| Sheet | Machine preset, customer name, physical dimensions, continuation, rotation, edge allowance and spacing |
| Output | DPI, pricing/unit, source-quality help and links that focus the existing per-sheet PNG/TIFF buttons |
| Dock footer | Existing Arrange on sheet action and errors; always outside the scrolling tab content |
| Canvas toolbar | Magnifier, Undo/Redo; rotate/remove appear when their existing enabled state permits the action |
| Client Portal | Existing compact submissions/details; gear beside Close retains settings and sharing |

Tab selection supports arrows/Home/End. The dock collapses without altering placements. On small screens it stacks above the canvas; its content scrolls independently without covering actions. Existing account hover/focus/tap reveal behavior remains intact, anchored at the top right.

## Changed application files

- `app/layout.jsx` — imports shared theme and account shell styles.
- `app/workspace-shell.css` (new) — right-attached account reveal/modal and responsive spacing.
- `public/workspace-theme.css` (new) — typography, color, spacing, borders, buttons, forms, focus, status, library/admin/auth/editor/portal styling.
- `public/builder-shell.css` (new) — compact header, dock, canvas surroundings, contextual toolbar and responsive layout.
- `public/builder-shell.js` (new) — view-only dock/tabs/collapse, existing-node relocation, selection visibility and output navigation.
- `public/builder.html` — three asset references only; original inline application code is unchanged.

## Changed test and documentation files

- `tests/workspace-design-ui.test.cjs` (new) — actual upload/arrange, before/after captures, tabs/collapse preserving exact state, keyboard operation, output navigation, modal/account and desktop/mobile/short-height geometry.
- `tests/client-jobs-ui.test.cjs` — configurable screenshot directory; public and owner overview captures.
- `tests/workspace-ui.test.cjs` — use Output/Sheet/Designs tabs to reach the existing controls.
- `tests/auth-callback-ui.test.cjs` — reveal account status before reading visible text.
- `tests/export-enforcement-ui.test.cjs` — reveal account status before reading visible text.
- `tests/builder.test.cjs` — serve the new presentation assets in the isolated browser fixture.
- `tests/background-editor.test.cjs` — serve the new presentation assets.
- `tests/native-image-limit.test.cjs` — serve the new presentation assets.
- `tests/rgb-w1-tiff.test.cjs` — serve the new presentation assets.
- `tests/incremental-layout.test.cjs` — serve presentation assets; wait for the attached DPI input while its tab is inactive.
- `tests/stability.test.cjs` — serve presentation assets; switch to Sheet for customer-name input.
- `tests/zero-spacing.test.cjs` — serve presentation assets; navigate Sheet/Output tabs.
- `tests/print-optimizer.test.cjs` — serve presentation assets; navigate Sheet/Designs tabs.
- `tests/edge-fringe.test.cjs` — serve presentation assets; navigate tabs; repair the old standalone encoder fixture to use explicit test-only authorization, matching the other encoder tests. Actual authorization remains covered by the API/SQL export-enforcement suite.
- `WORKSPACE-UI-VERIFICATION.md` (new) — this report.

## Verification results

Build and lint pass. Five pre-existing lint warnings remain: two library `<img>` warnings, one auth-hook ref warning, and two page-hook dependency warnings. Webpack reports a cache snapshot warning but completes the production build.

The following 16 suites passed with their assertions retained:

| Suite | Evidence |
| --- | --- |
| workspace-design-ui | Guest upload/arrange, exact placements retained across tabs/collapse, keyboard tabs, output focus, optimizer/account, no horizontal overflow, reachable dock controls at 1280×480 and 390×600 |
| client-jobs-ui | Production-build browser test: single/multiple PNGs, delayed/failed upload and retry, quantities, preview/confirmation, owner-only access, settings/link actions, mobile/short-height scrolling, expired submissions, real PNG/TIFF output and quota checks |
| workspace-ui | Library permissions, real drag/drop at Fit/200%, collision rejection, dimensions/quantity/rotation/removal, mobile tabs and focus return |
| user-management-ui | Registration, profile, Basic isolation, owner list/details, permission changes/confirmation, owner protection, mobile/focus |
| password-ui | Request/cooldown, valid/invalid recovery, validation, current-password failure/change, no password storage, mobile |
| auth-callback-ui | Real handlers/SDK with test Auth service, confirmation/resend/reset, used/invalid links, no blank pages |
| export-enforcement-ui | Actual API/SQL gates: guest 2→1→0 across reloads, registered exhaustion, owner/Unlimited, denied exports do not encode, failed saves/encoding do not charge |
| builder | Protected TIFF blocks unchanged; full-resolution sources; 4,000 packed pieces across 100 seeded trials; responsive bounds |
| incremental-layout | 200 locked + 40 new pieces; no movement; gaps/margins; 20 horizontal copies = rows 8/8/4, zero rotations, 3.65-inch artwork row height |
| stability | 200-piece drag: zero full-sheet redraws/overlay rebuilds during movement; local p95 frame interval 8.1 ms (7.2 ms with full-resolution sheet); exact Undo/Redo; internal background details preserved |
| background-editor | Wand/brush/restore/undo/reset/cancel/apply, crop mapping, exported source alpha, memory error, keyboard/mobile |
| zero-spacing | 0.30-inch automatic allowance, manual flush edges, spacing, exact quantities, multi-sheet, decoded PNG/TIFF identical RGBA |
| rgb-w1-tiff | RGB/300 DPI, W1 Photoshop resources, exact artwork RGB and unchanged CMYK blank-background behavior |
| native-image-limit | Native 2048² upload/trim/editor/Auto; no hidden 2× canvas; explicit Force enhancement uses 4096² |
| edge-fringe | Black/white/gray halo cleanup and linked comparison, Cancel/Apply/Undo/Reset, exact cleaned-source PNG/TIFF pixels |
| print-optimizer | Immutable source, opt-in enhancement, responsive inspection, exact 900² PNG/TIFF, RGB/CMYK and spot-channel outputs |

Browser/API tests use isolated fixtures and local PostgreSQL/PGlite. External Supabase Auth, storage, and email services are substituted in these tests; no real customer account, production credits, storage or email was changed. This is not a live delivery/deployment verification. Photoshop was not manually tested.

## Screenshots

Local review artifacts are under:

`C:/Users/Rogem Battung/.codex/visualizations/2026/09/13/01a098b1-9e23-7640-b495-355e0f864006/`

Open `workspace-review.html` for paired before/after screenshots of the builder, Optimize for Print modal, Client Portal, and public upload portal. The `workspace-after` directory also includes account, mobile builder, mobile owner and public upload screenshots.

Before captures use the original unchanged styles and disable only the newly added presentation assets. Both sets use real rendered fixture uploads/submissions, not mockup content or fabricated UI records. Screenshots are local artifacts rather than files shipped to customers.

## Scope confirmation

No Supabase schema/RLS, server/API, authentication/password, quotas, portal expiry/cron, email, storage, source images, background-removal/optimization algorithms, packing, physical dimensions or export encoders were changed. No existing function was removed. Only contextual disabled selection actions and the old large version/subtitle presentation are hidden. All functional controls remain reachable in their documented areas.

Not committed or deployed as part of this review.
