// Portal-only limits. Preview geometry never allocates an output-sized bitmap.
// Values are saved with each upload profile so shops can set a smaller limit
// when their workflow requires it. These are safe fallbacks for old profiles.
export const DEFAULT_MAX_UPLOAD_MIB = 50;
export const DEFAULT_MAX_TOTAL_UPLOAD_MIB = 150;
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_PIECES = 500;
export const MAX_UPLOAD_BYTES = DEFAULT_MAX_UPLOAD_MIB * 1024 * 1024;
export const MAX_TOTAL_UPLOAD_BYTES = DEFAULT_MAX_TOTAL_UPLOAD_MIB * 1024 * 1024;
export const PROXY_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_SOURCE_SIDE = 32767;
export const MAX_SOURCE_PIXELS = 128000000;

const mib = (bytes) => `${(bytes / 1048576).toFixed(2)} MiB`;
const boundedMiB = (value, fallback, maximum) =>
  Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback;

export function uploadLimits(settings = {}) {
  const fileMiB = boundedMiB(settings.maxFileMiB, DEFAULT_MAX_UPLOAD_MIB, 100);
  const totalMiB = Math.max(
    fileMiB,
    boundedMiB(settings.maxTotalMiB, DEFAULT_MAX_TOTAL_UPLOAD_MIB, 300)
  );
  return {
    maxFileMiB: fileMiB,
    maxTotalMiB: totalMiB,
    maxFileBytes: fileMiB * 1024 * 1024,
    maxTotalBytes: totalMiB * 1024 * 1024,
    maxFiles: MAX_UPLOAD_FILES,
    maxPieces: MAX_UPLOAD_PIECES
  };
}

export function uploadProblem(name, size, reason, limits = uploadLimits(), usedBytes = 0) {
  const remaining = Math.max(0, limits.maxTotalBytes - Math.max(0, usedBytes));
  return `${name || 'PNG'} (${mib(size)}; per-file limit ${limits.maxFileMiB} MiB; ${mib(remaining)} remaining of ${limits.maxTotalMiB} MiB per submission): ${reason}`;
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
