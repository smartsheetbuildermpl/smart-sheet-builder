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

**Optimize for Print** analyzes the active artwork at native resolution in Auto / Print-safe, regardless of PPI. Only the explicit Force smooth enhance mode runs the premultiplied-alpha Lanczos-2 upscale (2×). Physical size stays unchanged. Source-detail PPI remains honest after interpolation; added pixels are not restored detail. The isolated-dot pass removes only detached 1–4-pixel dots with at most a 2×2 bounding box, beyond a safety band around the larger connected components. That dot pass preserves connected shadows, lines and soft alpha. The separate connected-fringe pass is described below. Dense detached textures are left alone. Small isolated intentional marks can still resemble dust; inspect and Cancel or Undo if needed. Canvas bounds and physical placement remain unchanged by optimization. Existing upload trimming remains separate.

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
node tests/incremental-layout.test.cjs
```

The print optimizer suite checks unchanged clean high-resolution pixels, isolated corner ghosts, connected soft edges, explicit upscale, original-detail PPI, Undo/Reset, full-resolution inspection, responsive dialog geometry, and memory limits. It downloads an actual 3-inch / 300-DPI PNG and TIFFs at 900×900 and compares opaque source pixels with the PNG and RGB+W1 raster despite invalidated thumbnail data and a 40px CSS sheet preview. It checks DTF RGB/CMYK, UV RGB/CMYK Photoshop spot resource names and sample counts, and Tarpaulin alpha TIFF. The background editor and zero-spacing suites cover alpha-bearing PNG/TIFF output. These tests do not run Photoshop or MainTop or assess physical print quality.

Background removal is optional, uses a dominant edge color and connected flood fill with feathered transitions, and keeps the canvas dimensions. It cannot segment arbitrary photographic backgrounds and can affect artwork connected to an edge. Optional speck removal preserves surviving alpha but can remove small intentional details.

**Add to layout** is incremental: it keeps every existing placement, including manual moves, and fills the best available gap on existing sheets before creating another sheet. It applies the configured spacing and **Auto-layout edge allowance** (0.30 in by default) only to the new automatic pieces. **Arrange on sheet** intentionally rebuilds every design's current quantity and size as a new layout. Packing preserves dimensions to the export pixel grid and rounds spacing up to the next pixel so it is never smaller than requested. Manual placement, rotation, and resizing can still use the real physical sheet edge. Automatic rotation and additional sheets respect their checkboxes. Oversized pieces, or pieces left when additional sheets are disabled, are reported as skipped. Packing is heuristic; it does not guarantee the mathematical minimum number of sheets.

Incremental packing compares three complete deterministic plans: compact batch blocks, blocks that preserve larger rectangular gaps, and single-copy best-short-side fit. It sorts incoming sizes by area/longest side, evaluates available free rectangles and allowed rotations across every sheet, and favors placing all copies on existing sheets, fewer new/touched sheets, a compact batch footprint, then larger remaining rectangles. Each block evaluates its row/column count for the pending quantity, penalizing incomplete rows and thin leftovers. Only actual pieces reserve space; the partial last row is not reserved as an empty block. The card reports added/requested quantities, additions per sheet, and the largest remaining rectangle after spacing and automatic margins. Gap dimensions are rounded down in the current unit.

Original orientation is the first automatic-packing pass. On a blank or newly created sheet, equal-count batches prefer the lowest used bottom edge and then the widest row, so a 2.7 × 1.15 inch design on a 23-inch sheet with 0.10-inch spacing packs 8 / 8 / 4 across three rows (3.65 inches of artwork height) rather than forming narrow vertical columns. With **Allow auto-rotate to fill gaps** enabled, rotation is considered only if it places more copies in existing gaps or avoids opening another sheet; it is never selected solely because a rotated BSSF score is slightly lower. On sheets that already contain locked placements, cohesive batch/free-rectangle use remains ahead of shortening the new batch alone, so incidental early holes do not scatter a larger incoming group.

`incremental-layout.test.cjs` includes a generated 23 × 39 inch sheet at 100 DPI with 200 locked 1-inch Print pieces, forty isolated holes, and a larger open region. Adding forty 1-inch Jerseys leaves all Print positions, rotations, instances, and sheets unchanged. The new batch footprint is 45.99 square inches versus 190.75 with single-copy scoring, and the independently verified largest remaining gap is 22.4 × 22.94 inches. Tests also cover mixed sizes/source-order independence, all-sheet scoring, rotation/extension limits, exact partial quantities, repeated Add, horizontal 8 / 8 / 4 orientation priority, mobile feedback, and full-sheet source rendering. The user's actual design dimensions and sheet arrangement were not supplied; this is a reproducible quantity-matching fixture, not a reconstruction of their sheet.

The synthetic PNG checks do not diagnose a particular customer's exported file. A matching original PNG and actual exported PNG/TIFF are still needed to compare the reported pixelation at native pixel scale. Photoshop compatibility, RIP behavior, physical print size in a specific downstream application, and final printed quality were not tested.

### Interactive print comparison checks

Run `node tests/print-preview-ui.test.cjs`. This verifies true original/candidate pixel differences, linked hover and touch lenses, Fit/100/200/400 zoom, drag panning, keyboard/draggable swipe, rendered swipe transparency, mobile stacking, immutable original, and exact applied-candidate equality. Explicit smooth upscale prepares its result before Apply so it can be inspected; Apply publishes that candidate without recomputing it. Identical candidates show **No visual change required** and **Close — no changes**, with no image-edit callback. The old Compare original active source / Show optimized preview toggles are absent.

### Optional Force smooth enhance

Image enhancement is separate from edge cleanup. Auto / Print-safe remains the default and always keeps native resolution, including at low PPI. The old optional-upscale checkbox has been removed; only Force smooth enhance increases resolution. Force smooth enhance explicitly runs at 2× even at 300 PPI, from the full-resolution cleaned session source. It uses the existing premultiplied-alpha Lanczos-2 resampler followed by a local source-envelope clamp that excludes hidden transparent RGB and constrains alpha overshoot. A mild bounded unsharp pass affects only fully opaque 3×3 neighborhoods with at most 24 levels of per-channel variation: strength 0.12, at most two RGB levels, clamped to local color bounds. Alpha and transparent edges are never sharpened. The forced result uses a stable CPU-backed candidate canvas for comparison and Apply. Physical size and honest original-detail PPI remain unchanged. Existing 2×/16-megapixel/8192-side limits and a larger per-operation memory estimate apply; Force is not a memory-limit bypass. Smooth enhancement cannot recreate lost detail.

Run `node tests/force-enhance.test.cjs` for 300-PPI Auto no-op versus forced 2×, rendered 200%/400% differences, colored transparent edges, source-color overshoot bounds, mode reversal, Cancel, immutable source and exact selected-candidate Apply. `print-optimizer.test.cjs` additionally applies Force through the real design card and compares its full-resolution PNG and alpha-TIFF exports pixel by pixel. Existing DTF RGB/CMYK and UV spot-resource checks remain. These synthetic/browser checks do not assess physical print quality or MainTop/Photoshop operation.

### Optimizer memory scheduling

Run `node tests/optimizer-memory.test.cjs`. It loads the frozen optimizer at commit `3ffdc5b` through a browser-only route and compares every resulting RGBA pixel against the new implementation. Tests require that commit in local git history. Cleanup strengths and decision thresholds have not changed. The test covers all three modes on 2048×2048 and 4096×4096 sources, optional Force producing 4096×4096, a decoded 5000×3000 transparent PNG in Strong, oversized rejection before any source read, bounded comparison rasters, 100/200/400 pan synchronization, simulated post-cleanup enhancement failure, recovery, Cancel and exact candidate Apply. Lanczos at 1.37× and 2× and Force refinement are compared across stripe boundaries on arbitrary colored/alpha data.

The previous estimator mixed unrelated retained designs with flat 36/40-byte-per-pixel multipliers. A forced 2048×2048 → 4096×4096 result also exceeded its decimal 16,000,000-pixel ceiling; the error handler then exposed the partial cleanup result as valid. The optimizer now checks its selected operation before processing, never enables Apply after failure, and never silently selects a weaker mode.

Peak accounting uses maximum simultaneous phases, not the sum of all phases. Traversal now recycles consumed entries through a bounded 4 MiB frontier instead of retaining a uint32 for every source pixel. Dot classification is 9 bytes per source pixel plus that frontier; fringe classification is 14 plus the frontier. Output peaks at 13 bytes per pixel and reuses the owned dot candidate, never the session original. Accepted fringe components are traversed twice to avoid retaining their full pixel-index lists; thresholds, support rays, connectivity, and decisions are unchanged. Queues/distance are released before output; 128-row strips read immutable RGBA and retained decision bits, preserving cross-stripe analysis. Work yields between batches and during expensive edge classification. Lanczos retains four Float32 rows. Comparison rasters remain bounded, with native inspection tiles. An additional 24 MiB covers previews, strips and headroom. Extremely complex connected fronts that exceed the bounded queue fail explicitly without publishing partial results.

Estimated peaks: 2048×2048 Safe 76 MiB; Balanced/Strong 84 MiB; explicit Force approximately 205 MiB. At 4096×4096, Safe is 232 MiB and Balanced/Strong are 252 MiB; all complete under the 256 MiB cap. The 5000×3000 Strong fixture estimates 229 MiB, cleans 1,104 fringe pixels and five isolated dots, and retained native dimensions. A measured run completed in 6.6 seconds with 387 UI timer ticks (longest timer gap 200 ms). These are synthetic fixtures and live-buffer estimates, not browser process RSS guarantees. No source downsampling, weaker edge mode, or output-quality approximation is used to meet the budget.

### Builder stability and session history

Run `node tests/stability.test.cjs`. The 200-piece drag fixture asserts zero full-sheet raster redraws and zero placement-overlay rebuilds across 100 pointer movements, no committed coordinate mutation until release, and exactly one sheet redraw after release. A bounded preview follows requestAnimationFrame; only the moving rectangles are checked against stationary pieces and spacing. Pointer cancellation/Escape leave coordinates unchanged. Manual placement still reaches the physical edge. The final render continues using the full-resolution design sources.

Main **Undo layout / Redo layout** buttons and Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z track moves, rotations, additions, full arrangement, size/quantity edits, removals, and associated sheet changes. Editor dialogs and text inputs retain their own shortcuts. Snapshots store geometry and shared design references, not cloned image buffers. History is capped at 32 states / 100,000 instance records; older entries retaining deleted-image buffers are evicted above 128 MiB, keeping the most recent action recoverable. Restored placements resolve current active image sources so layout history never reverses a separately applied image edit. New actions discard the redo branch.

Automatic background removal formerly let its feather range (twice the requested color tolerance) propagate the flood fill, allowing it through faint outlines into same-colored foreground. Propagation now uses only the requested color distance and four-connected outside-border seeds. Its mask appears as a selection preview before Apply. The regression fixtures use white and black backgrounds separated from same-colored interiors by thin near-background outlines: each removes exactly 3,900 exterior pixels and preserves all 2,500 interior pixels. Manual Magic Wand (including deliberate global mode), brushes, selection-mask application, and editor history remain separate. Same-colored artwork physically connected to the exterior cannot be semantically distinguished by color connectivity; inspect the preview and use the manual tools for that case.

### Background selection application

Run `node tests/background-selection.test.cjs`. The default fixture contains white/off-white/gray dirt around a blue logo with enclosed white glyphs and a white line. Optional `BG_LOGO_PATH` points to a local internet-logo PNG; verification also used the public [Python logo](https://www.python.org/static/community_logos/python-logo.png), downloaded into a temporary directory, composited onto noisy white background. No network request is made by the test itself and no downloaded logo is added to the repository. The test compares the Magic Wand/coverage code with commit `729540d` to ensure tolerance and selection detection have not changed.

Erase selection and Apply now share one mask-application function. Every selected pixel is fully transparent unless both anti-aliasing is enabled and fractional mask coverage lies immediately beside unselected, nontransparent foreground (the 8-neighbor, one-pixel boundary). Only those boundary pixels retain the existing fractional coverage. Unselected RGBA is untouched. This replaces alpha multiplication throughout the selected background, which previously left opaque and off-white selected dirt partially visible.

The synthetic fixture verifies 46,900 selected pixels become alpha zero, including 492 fractional-coverage pixels. The Python fixture verifies 61,694 selected pixels become alpha zero, 51 immediate boundary pixels retain their expected feathering, and all 2,255 unselected pixels remain identical. Representative selected dirt samples are exactly alpha 0. Tests compare Erase selection with direct Apply, verify Undo/Redo, Restore Brush, Reset editor changes, Cancel and Reset image, inspect the full-resolution applied result before cropping, and compare the active crop and downloaded PNG/TIFF RGBA. Actual encoded-PNG composites over black, red and checkerboard are written to the reported temporary artifact directory; known exterior dirt regions exactly match the backdrop. This tests selection application, not removal of unselected matte coloration or downstream printer behavior.

### Native PNG processing limits

Run `node tests/native-image-limit.test.cjs` with Playwright available. It uploads a generated 2048×2048 RGBA PNG through the actual card, instruments canvas and ImageData allocations, opens/cancels Edit Background, checks Auto Safe/Balanced/Strong at native resolution, checks explicit Force, returns to Auto, tests low PPI without resampling, and arranges using the same active source. Optional `NATIVE_PNG_PATH` accepts the reported original 2048×2048 PNG for the same checks.

The builder previously charged all other designs' retained original/edit/undo canvases against each per-image operation. It also used a decimal 16,000,000-pixel cap, rejecting even native 4096×4096 uploads before any enhancement. Its guard now counts per-operation buffers plus 16 MiB headroom, uses the same 16,777,216-pixel ceiling as the optimizer, and reports the operation/dimensions/estimated memory. Existing editor history limits remain. No source pixels are downscaled to fit a budget.

Measured allocation sizes for the 2048×2048 fixture: upload/readback 2048×2048, thumbnail 160×160; editor source/display/readbacks 2048×2048 and overlay 1800×1800; Auto readbacks 2048×2048 and 2048×128 strips with bounded comparison previews; only Force allocates 4096×4096 RGBA/canvases and 4096×128 refinement strips. Optimizer estimated peaks are 76 MiB Safe, 96 MiB Balanced/Strong and about 205 MiB Force. These are buffer estimates, not process RSS measurements. At 4096×4096, larger optional operations can still exceed the real budget; their failure must not publish a partial candidate.

The available Downloads copy of `fsdf.png` was separately inspected: its actual PNG IHDR is 4096×4096, 8-bit RGBA, 609,754 bytes. It is not the reported 2048×2048 / ~397 KB original. Browser testing confirmed upload and native trim to 3333×3641, followed by Auto Balanced (3 isolated pixels removed, 445 fringe pixels cleaned). Force correctly rejected the 6666×7282 candidate before processing (estimated 539 MiB); Edit Background correctly reported its larger working-set requirement (491 MiB). The generated 2048×2048 fixture passes these operations, including Force. The actual 2048 original was not available for content-specific verification.
