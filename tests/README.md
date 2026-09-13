# Builder regression checks

Run from the repository root with Node.js, Playwright and an installed Chrome:

```sh
node tests/builder.test.cjs
```

Playwright can be provided externally through `NODE_PATH`; no application dependencies were changed. Set `CHROME_EXECUTABLE` to use a different Chromium executable. Screenshots go to a temporary directory unless `BUILDER_TEST_OUTPUT` names an output directory.

The test serves the current builder HTML through a browser-local route and exposes internal functions only in that test page. It uploads a synthetic transparent PNG, exercises the actual image tools and Add/Arrange controls, checks responsive geometry at 1440/375/320 px, round-trips rendered PNG pixels, and validates 4,000 packed pieces across 100 seeded trials. It never calls login, usage-consumption, or download-access endpoints.

`protected-builder-blocks.json` fingerprints the user's uncommitted starting implementation of the export gate, export profiles, TIFF encoder, Photoshop resources, spot channels, and color assets. These checks detect changes; they do not verify Photoshop compatibility.

## Verification on 2026-09-13

- Production build passed.
- Browser regression checks passed with installed Chrome; narrow and desktop screenshots were visually inspected.
- Inline builder JavaScript syntax check passed.
- `npm run lint` requires an initial ESLint configuration and stops at the setup prompt. Explicit ESLint with a temporary `next/core-web-vitals` configuration passed with no errors and two existing hook-dependency warnings in unchanged `app/page.jsx` (lines 247 and 457).
- Localhost returned HTTP 200 for the main app and builder.

## Image and layout behavior

Uploads preserve the complete decoded source, including transparent padding and low-alpha pixels. Only card thumbnails are reduced. Each instance references its full-resolution source; the shared full-size sheet raster used by PNG and TIFF is rendered directly from that source, so changing print dimensions does not repeatedly resize an intermediate image. Existing TIFF encoding and color processing remain unchanged.

Enhancement performs one optional 2× smooth interpolation, preserves physical size and transparency, and supports Undo. It does not restore detail. The source PPI readout continues to use original pixels after enhancement. Limits are 16 million output pixels, 8192 pixels per side, and an estimated 256 MiB retained-image/operation budget; this is not a bound on total browser or sheet/export memory. Undo stores one prior image state; Restore original clears all image edits.

Background removal is optional, uses a dominant edge color and connected flood fill with feathered transitions, and keeps the canvas dimensions. It cannot segment arbitrary photographic backgrounds and can affect artwork connected to an edge. Optional speck removal preserves surviving alpha but can remove small intentional details.

Add and Arrange rebuild all uploaded designs' current quantities and sizes together. Packing preserves dimensions to the export pixel grid and rounds spacing up to the next pixel so it is never smaller than requested. The header area remains reserved. Automatic rotation and additional sheets respect their checkboxes. Oversized pieces, or pieces left when additional sheets are disabled, are reported as skipped. Packing is heuristic; it does not guarantee the mathematical minimum number of sheets.

The synthetic PNG checks do not diagnose a particular customer's exported file. A matching original PNG and actual exported PNG/TIFF are still needed to compare the reported pixelation at native pixel scale. Photoshop compatibility, RIP behavior, physical print size in a specific downstream application, and final printed quality were not tested.
