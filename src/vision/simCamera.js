// A fake camera: renders synthetic dice to a canvas and exposes it as a MediaStream.
// It lets the whole pipeline run with no camera attached, and it knows the true values
// so the app can report agreement. Rolls made here are tagged origin "simulated".
import { makeRng, placeDice, renderScene } from './synth.js';

const WIDTH = 640;
const HEIGHT = 480;
const SIDE = 58;
const FPS = 15;

export function createSimCamera() {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(WIDTH, HEIGHT);
  const rng = makeRng((Date.now() % 100000) + 1);
  const face = () => 1 + Math.floor(rng() * 6);

  let dice = placeDice(WIDTH, HEIGHT, SIDE, rng, [face(), face()]);
  let tumble = 0;
  let handX = null;
  let queued = null;

  function draw() {
    if (tumble > 0) {
      tumble--;
      dice = placeDice(WIDTH, HEIGHT, SIDE, rng, [face(), face()]);
      if (tumble === 0) {
        dice = placeDice(WIDTH, HEIGHT, SIDE, rng, queued ?? [face(), face()]);
        queued = null;
      }
    }
    const blobs = [];
    if (handX != null) {
      blobs.push({ cx: handX, cy: HEIGHT / 2, r: 80, level: 150 });
      handX += 70;
      if (handX > WIDTH + 100) handX = null;
    }
    renderScene({
      width: WIDTH, height: HEIGHT, table: 48, gradient: 22, noise: 4, dice, blobs,
    }, rng, image.data);
    ctx.putImageData(image, 0, 0);
  }

  draw();
  const timer = setInterval(draw, 1000 / FPS);

  return {
    stream: canvas.captureStream(FPS),
    /** Throw the dice. Pass values to force a result, such as a repeat of the last roll. */
    roll(values = null) {
      queued = values;
      tumble = 12;
    },
    passHand() { handX = -100; },
    truth: () => dice.map((d) => d.value).sort((a, b) => a - b),
    stop() { clearInterval(timer); },
  };
}
