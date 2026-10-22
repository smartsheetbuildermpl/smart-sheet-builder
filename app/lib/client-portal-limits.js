// Portal-only limits. Preview geometry never allocates an output-sized bitmap.
export const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
export const PROXY_UPLOAD_BYTES = 4 * 1024 * 1024;
export function uploadProblem(name, size, reason) {
  return `${name || 'PNG'} (${(size / 1048576).toFixed(2)} MiB; limit 32 MiB per file / submission): ${reason}`;
}
export function outputProblem(manifest, index, assets = []) {
  const sheet = manifest?.sheets?.[index];
  if (!sheet) return 'The selected print sheet is unavailable. Reopen this submission.';
  const pixels = sheet.widthPx * sheet.heightPx;
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 128000000 || sheet.widthPx > 32767 || sheet.heightPx > 32767) {
    return `Sheet ${index + 1} of ${manifest.sheets.length}: ${sheet.widthIn} × ${sheet.heightIn} in at ${manifest.dpi} PPI (${sheet.widthPx} × ${sheet.heightPx} px, ${(pixels / 1000000).toFixed(2)} MP). Final output supports 128 MP and 32767 pixels per side, per sheet. The preview is available; ask the shop to review its sheet preset before submitting a revised layout. Original artwork has not been reduced.`;
  }
  const referenced = new Set(sheet.placements.map(p => p.assetId));
  const sourcePixels = assets.filter(a => referenced.has(a.id)).reduce((sum, a) => sum + a.width * a.height, 0);
  if (sourcePixels > 33554432) return `Sheet ${index + 1} of ${manifest.sheets.length} references ${(sourcePixels / 1000000).toFixed(2)} MP of original source artwork; final processing supports 32 Mi pixels of distinct sources per sheet. Preview remains available. Ask the shop to split the artwork across submissions; originals have not been reduced.`;
  return '';
}
