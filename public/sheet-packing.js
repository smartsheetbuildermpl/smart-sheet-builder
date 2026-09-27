/* Shared unchanged horizontal-first packing for builder and locked client jobs. */
(function(root){
  function rectsOverlap(a, b) {
    return !(b.x >= a.x + a.w || b.x + b.w <= a.x || b.y >= a.y + a.h || b.y + b.h <= a.y);
  }

  function pruneContained(rects) {
    var result = [];
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.w <= 0 || r.h <= 0) continue;
      var contained = false;
      for (var j = 0; j < rects.length; j++) {
        if (i === j) continue;
        var o = rects[j];
        if (o.w <= 0 || o.h <= 0) continue;
        var sameRect = (r.x === o.x && r.y === o.y && r.w === o.w && r.h === o.h);
        if (!sameRect && r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h) {
          contained = true; break;
        }
        if (sameRect && j < i) { contained = true; break; }
      }
      if (!contained) result.push(r);
    }
    return result;
  }

  function subtractOccupiedRect(rects, used) {
    var remaining = [];
    rects.forEach(function(fr){
      if (!rectsOverlap(fr, used)) { remaining.push(fr); return; }
      if (used.x > fr.x) remaining.push({ x: fr.x, y: fr.y, w: used.x - fr.x, h: fr.h });
      if (used.x + used.w < fr.x + fr.w) remaining.push({ x: used.x + used.w, y: fr.y, w: fr.x + fr.w - used.x - used.w, h: fr.h });
      if (used.y > fr.y) remaining.push({ x: fr.x, y: fr.y, w: fr.w, h: used.y - fr.y });
      if (used.y + used.h < fr.y + fr.h) remaining.push({ x: fr.x, y: used.y + used.h, w: fr.w, h: fr.y + fr.h - used.y - used.h });
    });
    return pruneContained(remaining);
  }

  function packSheet(items, binW, binH, gapPx, allowRotation, occupied) {
    var freeRects = [{ x: 0, y: 0, w: binW + gapPx, h: binH + gapPx }];
    (occupied || []).forEach(function(p){
      freeRects = subtractOccupiedRect(freeRects, { x: p.x, y: p.y, w: p.w + gapPx, h: p.h + gapPx });
    });
    var placements = [];
    var unplaced = [];
    var sorted = items.slice().sort(function(a, b){
      var areaDifference = (b.baseW * b.baseH) - (a.baseW * a.baseH);
      return areaDifference || (Math.max(b.baseW, b.baseH) - Math.max(a.baseW, a.baseH));
    });
    sorted.forEach(function(inst){
      function isBetter(next, candidate, rowFirst) {
        if (!candidate) return true;
        if (rowFirst) {
          return next.y < candidate.y || (next.y === candidate.y &&
            (next.x < candidate.x || (next.x === candidate.x &&
              (next.shortSide < candidate.shortSide ||
                (next.shortSide === candidate.shortSide && next.longSide < candidate.longSide)))));
        }
        return next.shortSide < candidate.shortSide ||
          (next.shortSide === candidate.shortSide &&
            (next.longSide < candidate.longSide ||
              (next.longSide === candidate.longSide &&
                (next.areaWaste < candidate.areaWaste ||
                  (next.areaWaste === candidate.areaWaste &&
                    (next.y < candidate.y || (next.y === candidate.y && next.x < candidate.x)))))));
      }
      function findBest(orientations, rowFirst) {
        var candidate = null;
        for (var fi = 0; fi < freeRects.length; fi++) {
          var fr = freeRects[fi];
          orientations.forEach(function(o){
            if (o.w > fr.w || o.h > fr.h) return;
            var next = {
              w: o.w, h: o.h, rot: o.rot,
              shortSide: Math.min(fr.w - o.w, fr.h - o.h),
              longSide: Math.max(fr.w - o.w, fr.h - o.h),
              areaWaste: fr.w * fr.h - o.w * o.h, x: fr.x, y: fr.y
            };
            // The original orientation is packed in reading order: left to
            // right on the highest available row, then the next row. This
            // minimizes used film length for wide artwork before considering
            // any rotation-based gap recovery.
            if (isBetter(next, candidate, rowFirst)) candidate = next;
          });
        }
        return candidate;
      }
      // Rotation is deliberately a fallback. A design that fits unrotated is
      // never turned vertical merely because a BSSF score is slightly lower.
      var best = findBest([{ w: inst.baseW + gapPx, h: inst.baseH + gapPx, rot: 0 }], true);
      if (!best && allowRotation && inst.baseW !== inst.baseH) {
        best = findBest([{ w: inst.baseH + gapPx, h: inst.baseW + gapPx, rot: 90 }], false);
      }
      if (!best) { unplaced.push(inst); return; }
      inst.rotation = best.rot;
      var placedRect = { x: best.x, y: best.y, w: best.w, h: best.h };
      placements.push({
        inst: inst,
        x: best.x, y: best.y,
        w: best.rot === 0 ? inst.baseW : inst.baseH,
        h: best.rot === 0 ? inst.baseH : inst.baseW
      });
      var newFreeRects = [];
      freeRects.forEach(function(fr){
        if (!rectsOverlap(fr, placedRect)) { newFreeRects.push(fr); return; }
        if (placedRect.x > fr.x) newFreeRects.push({ x: fr.x, y: fr.y, w: placedRect.x - fr.x, h: fr.h });
        if (placedRect.x + placedRect.w < fr.x + fr.w) newFreeRects.push({ x: placedRect.x + placedRect.w, y: fr.y, w: (fr.x + fr.w) - (placedRect.x + placedRect.w), h: fr.h });
        if (placedRect.y > fr.y) newFreeRects.push({ x: fr.x, y: fr.y, w: fr.w, h: placedRect.y - fr.y });
        if (placedRect.y + placedRect.h < fr.y + fr.h) newFreeRects.push({ x: fr.x, y: placedRect.y + placedRect.h, w: fr.w, h: (fr.y + fr.h) - (placedRect.y + placedRect.h) });
      });
      freeRects = pruneContained(newFreeRects);
    });
    return { placements: placements, unplaced: unplaced };
  }


const api={packSheet,pruneContained,subtractOccupiedRect};if(typeof module!=="undefined")module.exports=api;else root.SmartSheetPacking=api;
})(typeof window!=="undefined"?window:globalThis);
