// Frame differencing on a box-averaged thumbnail. Averaging suppresses sensor noise,
// which lets the threshold stay low enough to catch small dice in a wide view.
const THUMB_WIDTH = 160;
const PIXEL_DELTA = 14;

export function createMotionMeter() {
  let prev = null;
  let thumbW = 0;
  let thumbH = 0;

  return {
    /** Returns the fraction of thumbnail cells that changed since the previous frame. */
    update({ data, width, height }) {
      const cell = Math.max(1, Math.floor(width / THUMB_WIDTH));
      const w = Math.floor(width / cell);
      const h = Math.floor(height / cell);
      const thumb = new Uint8Array(w * h);
      const area = cell * cell;
      for (let ty = 0; ty < h; ty++) {
        for (let tx = 0; tx < w; tx++) {
          let sum = 0;
          for (let y = ty * cell; y < (ty + 1) * cell; y++) {
            let p = (y * width + tx * cell) * 4;
            for (let x = 0; x < cell; x++, p += 4) sum += data[p + 1]; // green tracks luma closely
          }
          thumb[ty * w + tx] = sum / area;
        }
      }
      let changed = 0;
      const comparable = prev && thumbW === w && thumbH === h;
      if (comparable) {
        for (let i = 0; i < thumb.length; i++) {
          if (Math.abs(thumb[i] - prev[i]) > PIXEL_DELTA) changed++;
        }
      }
      prev = thumb;
      thumbW = w;
      thumbH = h;
      return comparable ? changed / thumb.length : 0;
    },
    reset() { prev = null; },
  };
}
