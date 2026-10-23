import packing from '../../public/sheet-packing';

// Accounting markers only. They never create sheets or change placements.
export const METER_LENGTH_IN = 39.37007874;

export function rollLayout(items, settings) {
  const dpi = settings.dpi;
  const width = Math.round(settings.widthIn * dpi);
  const edge = Math.ceil(settings.edgeIn * dpi);
  const lead = Math.ceil(settings.leadIn * dpi);
  const trail = Math.ceil(settings.trailIn * dpi);
  const gap = Math.ceil(settings.gapIn * dpi);
  const usableWidth = width - 2 * edge;
  for (const item of items) {
    if (item.baseW > usableWidth && (!settings.rotate || item.baseH > usableWidth)) {
      throw Error(`Artwork cannot fit the printable roll width. Maximum allowed artwork width is ${(usableWidth / dpi).toFixed(4)} in (${settings.widthIn} in roll width minus left/right allowances).${settings.rotate ? ' Neither allowed orientation fits.' : ' Rotation is disabled.'} Request a narrower design; artwork is never scaled or cropped.`);
    }
  }
  // A vertical stack is a finite upper bound for every width-eligible item.
  // No arbitrary one-meter/39-inch height ceiling or meter-page packing.
  const maxLength = items.reduce((sum, item) => sum + Math.max(item.baseW, item.baseH) + gap, 0);
  const packed = packing.packSheet(items, usableWidth, maxLength, gap, settings.rotate);
  if (packed.unplaced.length) throw Error('The roll layout could not place every requested piece. Please retry.');
  const placements = packed.placements.map(p => ({
    assetId: p.inst.assetId, x: p.x + edge, y: p.y + lead,
    w: p.w, h: p.h, baseW: p.inst.baseW, baseH: p.inst.baseH, rotation: p.inst.rotation
  }));
  // Spacing is only between pieces, never an extra trailing margin.
  const artworkEnd = Math.max(...placements.map(p => p.y + p.h));
  const height = artworkEnd + trail;
  const lengthIn = height / dpi;
  const meters = lengthIn * 0.0254;
  const fullMeters = Math.floor(meters + 1e-10);
  const remainder = Math.max(0, meters - fullMeters);
  const area = placements.reduce((sum, p) => sum + p.w * p.h, 0);
  const sheet = {
    widthPx: width, heightPx: height, widthIn: width / dpi, heightIn: lengthIn,
    headerHeightPx: 0, gapPx: gap, autoEdgeAllowancePx: edge, placements
  };
  return {
    version: 1, config: settings, mediaMode: 'continuous', dpi, sheets: [sheet],
    totalPieces: items.length, meters,
    roll: {
      widthIn: width / dpi, usableWidthIn: usableWidth / dpi, lengthIn, meters,
      segmentLengthIn: METER_LENGTH_IN, fullMeters,
      nextMeterPercent: remainder * 100, nextMeterLengthIn: remainder / 0.0254,
      efficiency: area / (width * height) * 100
    }
  };
}
