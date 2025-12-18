// imageWorker.js - Offload image resizing to a Web Worker
self.onmessage = async (e) => {
  const { blob, width = 320, quality = 0.75 } = e.data || {};
  try {
    if (!blob) throw new Error('No blob provided');
    const bitmap = await createImageBitmap(blob);
    const targetW = width;
    const targetH = Math.round((bitmap.height / bitmap.width) * targetW);

    // Use OffscreenCanvas if available, fallback to regular canvas
    const offscreenSupported = typeof OffscreenCanvas !== 'undefined';
    const canvas = offscreenSupported ? new OffscreenCanvas(targetW, targetH) : new self.Canvas(targetW, targetH);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);

    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    // Return the resized blob to main thread
    self.postMessage({ ok: true, blob: outBlob }, [outBlob]);
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) });
  }
};
