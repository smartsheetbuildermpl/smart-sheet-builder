# Builder regression checks

Run from the repository root with Node.js, Playwright and an installed Chrome:

```sh
node tests/builder.test.cjs
```

Playwright can be provided externally through `NODE_PATH`; no application dependencies were changed. Set `CHROME_EXECUTABLE` to use a different Chromium executable. Screenshots go to a temporary directory unless `BUILDER_TEST_OUTPUT` names an output directory.

The test serves the current builder HTML through a browser-local route and exposes internal functions only in that test page. It uploads a synthetic transparent PNG, exercises the actual image tools and Add/Arrange controls, checks responsive geometry at 1440/375/320 px, round-trips rendered PNG pixels, and validates 4,000 packed pieces across 100 seeded trials. It never calls login, usage-consumption, or download-access endpoints.

`protected-builder-blocks.json` fingerprints the user's uncommitted starting implementation of the export gate, export profiles, TIFF encoder, Photoshop resources, spot channels, and color assets. These checks detect changes; they do not verify Photoshop compatibility.

Run the browser checks while the local Next app is running (default `http://localhost:3000`; override with `SMART_SHEET_TEST_URL`):

```sh
node tests/design-library-ui.test.cjs
node tests/auth-state.test.cjs
```

The library entry runs `workspace-ui.test.cjs`: browser-only mock auth/catalog responses, real full-resolution PNG loading, native drags at Fit and 200% with scrolling, invalid drops, repeated additions, selected size/quantity/rotation/removal, packing, reopening, mobile tabs, and admin visibility. It does not write to Supabase.

The auth suite exercises restored local admin access, guest gating, sign-in and registration continuation, persistent sign-out, account summary and empty credential fields, unchanged local 2/5 export limits and owner unlimited access. Supabase login, registration and restored-session responses are mocked; no live account credentials or Supabase data are used. Auth is shared through `app/hooks/useSmartSheetAuth.js`. Local sessions open the workspace directly, while catalog management requires the existing configured server and its authorization checks.

For manual testing: run `npm run dev -- --port 3000`, open localhost:3000, sign in, then use **Design Library** above the sidebar upload card. In local test mode the shared catalog is unavailable; the workspace still opens with the current sheet. Close and reopen to check state preservation. Sign out, open the library again, and sign in to check automatic continuation. No database/configuration changes are needed for this authentication fix.

## Verification on 2026-09-13

- Production build passed.
- Browser regression checks passed with installed Chrome; narrow and desktop screenshots were visually inspected.
- Inline builder JavaScript syntax check passed.
- `npm run lint` requires an initial ESLint configuration and stops at the setup prompt. Explicit ESLint with a temporary `next/core-web-vitals` configuration passed with no errors and two existing hook-dependency warnings in unchanged `app/page.jsx` (lines 247 and 457).
- Localhost returned HTTP 200 for the main app and builder.

## Image and layout behavior

Uploads preserve the complete decoded source, including transparent padding and low-alpha pixels. Only card thumbnails are reduced. Each instance references its full-resolution source; the shared full-size sheet raster used by PNG and TIFF is rendered directly from that source, so changing print dimensions does not repeatedly resize an intermediate image. Existing TIFF encoding and color processing remain unchanged.

**Optimize for Print** analyzes the active artwork and offers an explicit opt-in, premultiplied-alpha Lanczos-2 smooth upscale toward 300 raster PPI (at most 2×). At 300 source PPI or higher it leaves resolution alone. Physical size stays unchanged. Source-detail PPI remains honest after interpolation; added pixels are not restored detail. The isolated-dot pass removes only detached 1–4-pixel dots with at most a 2×2 bounding box, beyond a safety band around the larger connected components. That dot pass preserves connected shadows, lines and soft alpha. The separate connected-fringe pass is described below. Dense detached textures are left alone. Small isolated intentional marks can still resemble dust; inspect and Cancel or Undo if needed. Canvas bounds and physical placement remain unchanged by optimization. Existing upload trimming remains separate.

The **Original / Optimized preview** panes show distinct incoming-source and candidate rasters. Fit, 100%, 200%, and 400% use linked zoom and pan; integer inspection zoom uses nearest-pixel rendering. Zoom is measured against the candidate pixel grid and both images cover the same print area, so an upscaled candidate stays spatially aligned with its original. Hover/tap lenses sample the same normalized location in each actual raster. Mobile panes stack vertically. Swipe compare uses complementary clips: optimized transparent pixels reveal checkerboard, never the original underneath. **Undo last optimization** restores the source entering the last applied optimization. Card **Reset image** restores the complete original upload and removes all image edits. Optimizer limits are 16,777,216 output pixels, 8192 pixels per side, and an estimated 256 MiB per-card working peak, including its active source and bounded comparison buffers. This does not bound total browser or sheet/export memory. Large comparisons render bounded viewport tiles; the source and applied candidate remain full resolution. Hidden zero-alpha RGB cannot bleed into the resampler. Manual edge correction remains available in Edit Background.

### Connected edge fringe rule

The isolated-dot pass protects connected artwork, so it cannot remove connected blurry corners. Optimize for Print now offers **Safe**, **Balanced (default)**, and **Strong**. Safe runs only isolated-dot cleanup. Balanced and Strong additionally process the full-resolution exterior fringe before preview/upscaling. Every strength change starts from the immutable session original; changes never accumulate between previews, and only the selected candidate is applied.

1. Flood-fill alpha-zero pixels reachable from the perimeter. Only low-alpha components touching that exterior or the image perimeter qualify. Enclosed holes are excluded.
2. Balanced considers alpha 1–160 within eight source pixels of alpha ≥240. It preserves a component when more than 15% lies beyond that band, protecting broad shadows. Strong considers alpha 1–208 within fourteen pixels and can attenuate the nearby portions of broader shadows. Neither mode modifies the opaque core.
3. Require a rising-alpha ray that does not cross a transparent gap and reaches a coherent solid 2×2 support patch. Balanced permits four alpha levels of local decline and 40 RGB levels of support variation; Strong permits twelve and 48. A narrow ridge with same-color/coverage continuation along its axis is protected as a possible fine line.
4. Compare each candidate with the nearest supported artwork color. Require matte-like color divergence: at least 36 RGB levels for Balanced or 24 for Strong, plus a fit toward neutral black/gray/white (minimum matte contribution 35%/20%, residual 24/32), or a low-chroma tinted matte clearly differing from a more colorful core. Strong also considers coherent-color blur tails with alpha ≤64 at distance ≥4. Require at least three matching pixels in the component.
5. Balanced removes matching alpha ≤24 pixels and retains 25% alpha for other matches. Strong removes matching alpha ≤64 pixels or those at distance ≥4, retaining 10% alpha for other matches. Retained pixels receive the supported artwork color to reduce matte contamination. All unmatched pixels, dimensions, print size, and the original remain unchanged.

These local evidence rules are not semantic recognition: an intentional soft shadow or neutral highlight can resemble contamination. Strong deliberately permits more shadow reduction. Inspect the comparison before applying; Edit Background remains the manual fallback.

Run `node tests/edge-strength.test.cjs` for a six-pixel connected corner halo, black/white/tinted mattes, clean colored AA, 1–3 px colored lines, enclosed holes, broad shadows, mode switching, immutable Original, and exact selected-candidate Apply. Each black, white, and tinted halo fixture has 2,704 nonzero-alpha pixels after the four isolated dots are removed:

| Mode | Isolated dots removed | Fringe cleaned | Fringe removed | Fringe reduced/recolored | Nonzero alpha after |
| --- | ---: | ---: | ---: | ---: | ---: |
| Safe | 4 | 0 | 0 | 0 | 2,704 |
| Balanced | 4 | 768 | 204 | 564 | 2,500 |
| Strong | 4 | 1,104 | 588 | 516 | 2,116 |

Clean colored AA stays at 2,116 pixels with zero fringe changes in all modes. The broader intentional shadow stays at 3,600 pixels in Safe/Balanced; Strong cleans 1,924 pixels (1,428 removed, 496 reduced), leaving 2,172. Core pixels remain exact. These fixtures also check idempotence for repeated cleanup.

Run `node tests/edge-fringe.test.cjs` for the earlier smaller connected-corner fixtures, gray matte, hair/highlights, Cancel/Apply/Undo/Reset, and actual cleaned-source PNG/TIFF comparisons. Balanced still cleans 516 pixels on each smaller black/white/gray halo (180 removed, 336 reduced/recolored; 2,116 → 1,936 nonzero-alpha pixels).

Fixtures are generated in the browser, not reconstructed from screenshots. The reported real artwork still needs its original PNG for pixel-level diagnosis. No Photoshop, MainTop, or physical printing was exercised.

```sh
node tests/print-optimizer.test.cjs
node tests/rgb-w1-tiff.test.cjs
node tests/background-editor.test.cjs
node tests/zero-spacing.test.cjs
```

The print optimizer suite checks unchanged clean high-resolution pixels, isolated corner ghosts, connected soft edges, explicit upscale, original-detail PPI, Undo/Reset, full-resolution inspection, responsive dialog geometry, and memory limits. It downloads an actual 3-inch / 300-DPI PNG and TIFFs at 900×900 and compares opaque source pixels with the PNG and RGB+W1 raster despite invalidated thumbnail data and a 40px CSS sheet preview. It checks DTF RGB/CMYK, UV RGB/CMYK Photoshop spot resource names and sample counts, and Tarpaulin alpha TIFF. The background editor and zero-spacing suites cover alpha-bearing PNG/TIFF output. These tests do not run Photoshop or MainTop or assess physical print quality.

Background removal is optional, uses a dominant edge color and connected flood fill with feathered transitions, and keeps the canvas dimensions. It cannot segment arbitrary photographic backgrounds and can affect artwork connected to an edge. Optional speck removal preserves surviving alpha but can remove small intentional details.

Add and Arrange rebuild all uploaded designs' current quantities and sizes together. Packing preserves dimensions to the export pixel grid and rounds spacing up to the next pixel so it is never smaller than requested. Automatic packing reserves the customer-name header area and the configured **Auto-layout edge allowance** (0.30 in by default) on every sheet; the allowance is separate from inter-piece spacing. Manual placement, rotation, and resizing can still use the real physical sheet edge. Automatic rotation and additional sheets respect their checkboxes. Oversized pieces, or pieces left when additional sheets are disabled, are reported as skipped. Packing is heuristic; it does not guarantee the mathematical minimum number of sheets.

The synthetic PNG checks do not diagnose a particular customer's exported file. A matching original PNG and actual exported PNG/TIFF are still needed to compare the reported pixelation at native pixel scale. Photoshop compatibility, RIP behavior, physical print size in a specific downstream application, and final printed quality were not tested.

### Interactive print comparison checks

Run `node tests/print-preview-ui.test.cjs`. This verifies true original/candidate pixel differences, linked hover and touch lenses, Fit/100/200/400 zoom, drag panning, keyboard/draggable swipe, rendered swipe transparency, mobile stacking, immutable original, and exact applied-candidate equality. Explicit smooth upscale prepares its result before Apply so it can be inspected; Apply publishes that candidate without recomputing it. Identical candidates show **No visual change required** and **Close — no changes**, with no image-edit callback. The old Compare original active source / Show optimized preview toggles are absent.

### Optional Force smooth enhance

Image enhancement is separate from edge cleanup. Auto / Print-safe remains the default and retains its existing no-op at 300 source PPI and optional low-PPI upscale. Force smooth enhance explicitly runs at 2× even at 300 PPI, from the full-resolution cleaned session source. It uses the existing premultiplied-alpha Lanczos-2 resampler followed by a local source-envelope clamp that excludes hidden transparent RGB and constrains alpha overshoot. A mild bounded unsharp pass affects only fully opaque 3×3 neighborhoods with at most 24 levels of per-channel variation: strength 0.12, at most two RGB levels, clamped to local color bounds. Alpha and transparent edges are never sharpened. The forced result uses a stable CPU-backed candidate canvas for comparison and Apply. Physical size and honest original-detail PPI remain unchanged. Existing 2×/16-megapixel/8192-side limits and a larger per-operation memory estimate apply; Force is not a memory-limit bypass. Smooth enhancement cannot recreate lost detail.

Run `node tests/force-enhance.test.cjs` for 300-PPI Auto no-op versus forced 2×, rendered 200%/400% differences, colored transparent edges, source-color overshoot bounds, mode reversal, Cancel, immutable source and exact selected-candidate Apply. `print-optimizer.test.cjs` additionally applies Force through the real design card and compares its full-resolution PNG and alpha-TIFF exports pixel by pixel. Existing DTF RGB/CMYK and UV spot-resource checks remain. These synthetic/browser checks do not assess physical print quality or MainTop/Photoshop operation.

### Optimizer memory scheduling

Run `node tests/optimizer-memory.test.cjs`. It loads the frozen optimizer at commit `3ffdc5b` through a browser-only route and compares every resulting RGBA pixel against the new implementation. Tests require that commit in local git history. Cleanup strengths and decision thresholds have not changed. The test covers all three modes on a 2048×2048 source, optional Force producing 4096×4096, 4096×4096 Safe completion, Balanced rejection before any source read, bounded comparison rasters, 100/200/400 pan synchronization, simulated post-cleanup enhancement failure, recovery, Cancel and exact candidate Apply. Lanczos at 1.37× and 2× and Force refinement are compared across stripe boundaries on arbitrary colored/alpha data.

The previous estimator mixed unrelated retained designs with flat 36/40-byte-per-pixel multipliers. A forced 2048×2048 → 4096×4096 result also exceeded its decimal 16,000,000-pixel ceiling; the error handler then exposed the partial cleanup result as valid. The optimizer now checks its selected operation before processing, never enables Apply after failure, and never silently selects a weaker mode.

Peak accounting uses maximum simultaneous phases, not the sum of all phases: Safe classification is 13 bytes per source pixel; fringe classification is 18. Both include the borrowed source. Queues are released before output allocation; fringe flags share the visited byte, and output is written in 128-row strips from immutable classification data. Analysis reads strips. Lanczos retains only four Float32 rows with identical weights and summation order. Force refinement reads unchanged neighboring rows and writes strips to its final canvas. Both comparison rasters are capped at 1024×1024; inspection tiles and lenses read the actual source. Old candidates and temporary canvases are explicitly released on replacement, failure or Cancel; the adopted canvas survives Apply. An additional 24 MiB covers bounded previews, strip buffers and headroom.

Estimated peaks: 2048×2048 Safe 76 MiB; Balanced/Strong 96 MiB; explicit Force approximately 205 MiB. At 4096×4096, Safe is 232 MiB and completes; Balanced/Strong are 312 MiB and fail before processing under the 256 MiB cap. These are live-buffer estimates with headroom, not measurements of browser process RSS or guarantees about when JavaScript garbage collection occurs. No source downsampling, weaker edge mode, or output-quality approximation is used to meet the budget.

### Background selection application

Run `node tests/background-selection.test.cjs`. The default fixture contains white/off-white/gray dirt around a blue logo with enclosed white glyphs and a white line. Optional `BG_LOGO_PATH` points to a local internet-logo PNG; verification also used the public [Python logo](https://www.python.org/static/community_logos/python-logo.png), downloaded into a temporary directory, composited onto noisy white background. No network request is made by the test itself and no downloaded logo is added to the repository. The test compares the Magic Wand/coverage code with commit `729540d` to ensure tolerance and selection detection have not changed.

Erase selection and Apply now share one mask-application function. Every selected pixel is fully transparent unless both anti-aliasing is enabled and fractional mask coverage lies immediately beside unselected, nontransparent foreground (the 8-neighbor, one-pixel boundary). Only those boundary pixels retain the existing fractional coverage. Unselected RGBA is untouched. This replaces alpha multiplication throughout the selected background, which previously left opaque and off-white selected dirt partially visible.

The synthetic fixture verifies 46,900 selected pixels become alpha zero, including 492 fractional-coverage pixels. The Python fixture verifies 61,694 selected pixels become alpha zero, 51 immediate boundary pixels retain their expected feathering, and all 2,255 unselected pixels remain identical. Representative selected dirt samples are exactly alpha 0. Tests compare Erase selection with direct Apply, verify Undo/Redo, Restore Brush, Reset editor changes, Cancel and Reset image, inspect the full-resolution applied result before cropping, and compare the active crop and downloaded PNG/TIFF RGBA. Actual encoded-PNG composites over black, red and checkerboard are written to the reported temporary artifact directory; known exterior dirt regions exactly match the backdrop. This tests selection application, not removal of unselected matte coloration or downstream printer behavior.
