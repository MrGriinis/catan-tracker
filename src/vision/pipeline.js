// Browser glue: video element -> cropped frame -> motion + dice reader -> state machine.
// Camera, video file and simulator all arrive through the same <video> element, so the
// simulator exercises the same path as a real camera.
import { detectDice } from './dice.js';
import { createMotionMeter } from './motion.js';
import { createRollDetector } from './rollDetector.js';

const MAX_WORK_WIDTH = 640;
const TICK_MS = 66;

export function createPipeline({ video, overlay, onFrame, onEvent }) {
  const work = document.createElement('canvas');
  const workCtx = work.getContext('2d', { willReadFrequently: true });
  const overlayCtx = overlay.getContext('2d');
  let timer = null;
  let meter = createMotionMeter();
  let detector = createRollDetector();
  let roi = { x: 0, y: 0, w: 1, h: 1 };
  let showDebug = true;
  let draftRoi = null;
  let lastReading = null;
  let scale = 1;
  let crop = { x: 0, y: 0 };

  function reset() {
    const { motionThreshold, stableFrames } = detector.options;
    meter = createMotionMeter();
    detector = createRollDetector({ motionThreshold, stableFrames });
    lastReading = null;
  }

  function drawOverlay() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (overlay.width !== vw || overlay.height !== vh) {
      overlay.width = vw;
      overlay.height = vh;
    }
    const ctx = overlayCtx;
    ctx.clearRect(0, 0, vw, vh);
    const line = Math.max(2, vw / 320);
    const area = draftRoi ?? roi;
    if (area.w < 1 || area.h < 1) {
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, vw, vh);
      ctx.clearRect(area.x * vw, area.y * vh, area.w * vw, area.h * vh);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = line;
      ctx.strokeRect(area.x * vw, area.y * vh, area.w * vw, area.h * vh);
    }
    if (!showDebug || !lastReading) return;
    const toVideo = (x, y) => [crop.x + x / scale, crop.y + y / scale];
    ctx.lineWidth = line;
    ctx.font = `600 ${Math.round(vw / 26)}px system-ui, sans-serif`;
    for (const die of lastReading.dice ?? []) {
      const { rect } = die;
      const good = die.value != null;
      ctx.strokeStyle = good ? '#3ddc6e' : '#fab219';
      ctx.beginPath();
      [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, b], i) => {
        const u = (a * rect.w) / 2;
        const v = (b * rect.h) / 2;
        const [x, y] = toVideo(rect.cx + u * rect.ux - v * rect.uy, rect.cy + u * rect.uy + v * rect.ux);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = '#ff3d8a';
      for (const pip of die.pips ?? []) {
        const [x, y] = toVideo(pip.x, pip.y);
        ctx.beginPath();
        ctx.arc(x, y, line * 1.2, 0, Math.PI * 2);
        ctx.fill();
      }
      const [lx, ly] = toVideo(rect.cx, rect.cy - die.side * 0.62);
      const label = good ? String(die.value) : '?';
      ctx.fillStyle = 'rgba(0,0,0,.75)';
      ctx.fillRect(lx - vw / 44, ly - vw / 24, vw / 22, vw / 20);
      ctx.fillStyle = good ? '#3ddc6e' : '#fab219';
      ctx.textAlign = 'center';
      ctx.fillText(label, lx, ly);
    }
  }

  function tick() {
    if (video.readyState < 2 || !video.videoWidth) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    crop = { x: roi.x * vw, y: roi.y * vh };
    const cw = Math.max(16, roi.w * vw);
    const ch = Math.max(16, roi.h * vh);
    scale = Math.min(1, MAX_WORK_WIDTH / cw);
    const w = Math.round(cw * scale);
    const h = Math.round(ch * scale);
    if (work.width !== w || work.height !== h) {
      work.width = w;
      work.height = h;
    }
    workCtx.drawImage(video, crop.x, crop.y, cw, ch, 0, 0, w, h);
    const frame = workCtx.getImageData(0, 0, w, h);
    const motion = meter.update(frame);
    // Read every frame: on a handheld camera the picture never stops moving.
    const reading = detectDice(frame);
    lastReading = reading;
    const { state, event } = detector.update({ motion, reading });
    drawOverlay();
    onFrame({ motion, reading, state, threshold: detector.options.motionThreshold });
    if (event) {
      event.snapshot = event.type === 'ignored' ? null : work.toDataURL('image/jpeg', 0.6);
      onEvent(event);
    }
  }

  return {
    start() {
      reset();
      clearInterval(timer);
      timer = setInterval(tick, TICK_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
      lastReading = null;
      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    },
    running: () => timer != null,
    setRoi(next) {
      roi = next;
      draftRoi = null;
      reset();
    },
    setDraftRoi(next) {
      draftRoi = next;
      if (video.videoWidth) drawOverlay();
    },
    getRoi: () => roi,
    setDebug(on) { showDebug = on; },
    configure(next) { detector.configure(next); },
  };
}
