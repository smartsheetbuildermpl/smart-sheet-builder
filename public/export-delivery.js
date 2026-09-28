/* Delivery accounting only. The encoder's full-resolution bytes pass through unchanged. */
(function (root) {
  'use strict';
  function create(options) {
    var sourceIds = new WeakMap(), attempts = new Map(), inFlight = new Set();
    function sourceId(canvas) {
      if (!sourceIds.has(canvas)) sourceIds.set(canvas, crypto.randomUUID());
      return sourceIds.get(canvas);
    }
    async function fingerprint(canvas, variant) {
      var recipe = JSON.stringify([canvas._ssbExportRecipe || sourceId(canvas), canvas.width, canvas.height, variant]);
      var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(recipe));
      return Array.from(new Uint8Array(bytes), function(b) { return b.toString(16).padStart(2, '0'); }).join('');
    }
    async function ask(kind, operation) {
      var result;
      // Never create a new operation for an uncertain debit. Both guest and
      // registered retries are bound to the same database receipt.
      for (var i = 0; i < (operation.action === 'consume' ? 1 : 3); i++) {
        result = await options.gate(kind, operation);
        if (result.allowed || !['transport_error', 'access_check_failed'].includes(result.reason)) return result;
      }
      return result;
    }
    async function prepare(kind, canvas, variant) {
      var key = await fingerprint(canvas, variant || kind);
      var attempt = attempts.get(key);
      if (!attempt || Date.now() - attempt.created > 110000) {
        attempt = { requestKey: crypto.randomUUID(), fingerprint: key, created: Date.now() };
        attempts.set(key, attempt);
        if (attempts.size > 32) attempts.delete(attempts.keys().next().value);
      }
      var access = await ask(kind, { requestKey: attempt.requestKey, fingerprint: key, action: 'prepare' });
      if (access.allowed !== true || !access.authorization) return null;
      return { requestKey: attempt.requestKey, fingerprint: key, authorization: access.authorization };
    }
    async function deliver(blob, filename, picker, kind, canvas, variant, ticket) {
      if (!blob || !blob.size || picker === false) return false;
      // Encoding is reached only through the builder's authorized entry point.
      if (!ticket || inFlight.has(ticket.requestKey)) return false;
      inFlight.add(ticket.requestKey);
      try {
      var key = ticket.fingerprint;
      // Only a complete Blob can consume; the server rechecks the live balance.
      var operation = Object.assign({}, ticket, { action: 'consume' });
      var access = await ask(kind, operation);
      if (access.allowed !== true) { if (access.reason === 'retry_expired') attempts.delete(key); return false; }
      try {
        var saved = await options.save(blob, filename, picker, kind === 'png' ? 'image/png' : 'image/tiff');
        if (saved === false) throw new Error('Export saving was cancelled.');
      } catch (error) {
        if (access.receipt) {
          var refund = await ask(kind, Object.assign({}, operation, { action: 'refund', receipt: access.receipt }));
          if (!refund.allowed) throw new Error('Saving failed. Your credit return is queued and will retry when this account reconnects. Export reference: ' + access.receipt + '.');
        }
        attempts.delete(key);
        throw error;
      }
      if (access.receipt) {
        // Delivery succeeded. A lost acknowledgement must never refund a saved file.
        var ack = await ask(kind, Object.assign({}, operation, { action: 'saved', receipt: access.receipt }));
        if (!ack.allowed && options.notice) options.notice('File saved; delivery acknowledgement is pending. Keep export reference ' + access.receipt + '.');
      }
      attempts.delete(key);
      return true;
      } finally { inFlight.delete(ticket.requestKey); }
    }
    return { sourceId: sourceId, prepare: prepare, deliver: deliver, fingerprint: fingerprint };
  }
  root.SmartSheetExportDelivery = { create: create };
})(typeof window !== 'undefined' ? window : globalThis);
