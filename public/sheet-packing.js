/* Shared deterministic Standard and Max Fill packing for the builder. */
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

  function packSheetMaxFill(items, binW, binH, gapPx, allowRotation, occupied) {
    var starts = [
      function(a, b){ return (b.baseW * b.baseH - a.baseW * a.baseH) || (Math.max(b.baseW, b.baseH) - Math.max(a.baseW, a.baseH)) || (a.id - b.id); },
      function(a, b){ return (Math.max(b.baseW, b.baseH) - Math.max(a.baseW, a.baseH)) || (b.baseW * b.baseH - a.baseW * a.baseH) || (a.id - b.id); },
      function(a, b){ return (b.baseH - a.baseH) || (b.baseW - a.baseW) || (a.id - b.id); },
      function(a, b){ return (b.baseW - a.baseW) || (b.baseH - a.baseH) || (a.id - b.id); },
      function(a, b){ return ((b.baseW + b.baseH) - (a.baseW + a.baseH)) || (b.baseW * b.baseH - a.baseW * a.baseH) || (a.id - b.id); }
    ];
    var heuristics = ['short', 'area', 'bottom', 'long'];

    function run(order, heuristic) {
      var freeRects = [{ x: 0, y: 0, w: binW + gapPx, h: binH + gapPx }];
      (occupied || []).forEach(function(p){
        freeRects = subtractOccupiedRect(freeRects, { x: p.x, y: p.y, w: p.w + gapPx, h: p.h + gapPx });
      });
      var placements = [], unplaced = [], rotations = 0;
      order.forEach(function(inst){
        var best = null;
        for (var fi = 0; fi < freeRects.length; fi++) {
          var fr = freeRects[fi];
          var orientations = [{ w: inst.baseW + gapPx, h: inst.baseH + gapPx, rot: 0 }];
          if (allowRotation && inst.baseW !== inst.baseH) orientations.push({ w: inst.baseH + gapPx, h: inst.baseW + gapPx, rot: 90 });
          orientations.forEach(function(o){
            if (o.w > fr.w || o.h > fr.h) return;
            var shortSide = Math.min(fr.w - o.w, fr.h - o.h);
            var longSide = Math.max(fr.w - o.w, fr.h - o.h);
            var areaWaste = fr.w * fr.h - o.w * o.h;
            var bottom = fr.y + o.h;
            var score;
            if (heuristic === 'area') score = [areaWaste, shortSide, longSide, bottom, fr.x, o.rot ? 1 : 0];
            else if (heuristic === 'bottom') score = [bottom, fr.x, shortSide, longSide, areaWaste, o.rot ? 1 : 0];
            else if (heuristic === 'long') score = [longSide, shortSide, areaWaste, bottom, fr.x, o.rot ? 1 : 0];
            else score = [shortSide, longSide, areaWaste, bottom, fr.x, o.rot ? 1 : 0];
            var better = !best;
            if (best) {
              for (var si = 0; si < score.length; si++) {
                if (score[si] === best.score[si]) continue;
                better = score[si] < best.score[si]; break;
              }
            }
            if (better) best = { x: fr.x, y: fr.y, w: o.w, h: o.h, rot: o.rot, score: score };
          });
        }
        if (!best) { unplaced.push(inst); return; }
        inst.rotation = best.rot;
        if (best.rot) rotations++;
        placements.push({ inst: inst, x: best.x, y: best.y,
          w: best.rot ? inst.baseH : inst.baseW, h: best.rot ? inst.baseW : inst.baseH });
        freeRects = subtractOccupiedRect(freeRects, { x: best.x, y: best.y, w: best.w, h: best.h });
      });
      var placedArea = placements.reduce(function(sum, p){ return sum + p.w * p.h; }, 0);
      var usedBottom = placements.reduce(function(bottom, p){ return Math.max(bottom, p.y + p.h); }, 0);
      return { placements: placements, unplaced: unplaced, rotations: rotations, placedArea: placedArea, usedBottom: usedBottom };
    }

    function betterResult(next, best) {
      if (!best) return true;
      if (next.placements.length !== best.placements.length) return next.placements.length > best.placements.length;
      if (next.placedArea !== best.placedArea) return next.placedArea > best.placedArea;
      if (next.usedBottom !== best.usedBottom) return next.usedBottom < best.usedBottom;
      if (next.rotations !== best.rotations) return next.rotations < best.rotations;
      var nextKey = next.placements.map(function(p){ return [p.inst.id, p.x, p.y, p.inst.rotation].join(':'); }).join('|');
      var bestKey = best.placements.map(function(p){ return [p.inst.id, p.x, p.y, p.inst.rotation].join(':'); }).join('|');
      return nextKey < bestKey;
    }

    var best = null;
    starts.forEach(function(sorter){
      heuristics.forEach(function(heuristic){
        // Each start receives fresh instance wrappers so discarded trials do
        // not leak rotation into the winning plan.
        var order = items.map(function(inst){ return Object.assign({}, inst); }).sort(sorter);
        var result = run(order, heuristic);
        if (betterResult(result, best)) best = result;
      });
    });
    if (!best) return { placements: [], unplaced: items.slice(), rotations: 0 };
    var originalById = new Map(items.map(function(inst){ return [inst.id, inst]; }));
    best.placements.forEach(function(p){
      var original = originalById.get(p.inst.id);
      original.rotation = p.inst.rotation;
      p.inst = original;
    });
    best.unplaced = best.unplaced.map(function(inst){ return originalById.get(inst.id); });
    return best;
  }


const api={packSheet,packSheetMaxFill,pruneContained,subtractOccupiedRect};if(typeof module!=="undefined")module.exports=api;else root.SmartSheetPacking=api;
})(typeof window!=="undefined"?window:globalThis);
