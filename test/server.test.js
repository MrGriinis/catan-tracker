import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createTrackerServer } from '../serve.js';

const running = [];

async function start(options) {
  const server = createTrackerServer(options);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  running.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

after(() => {
  for (const server of running) {
    server.closeAllConnections();
    server.close();
  }
});

const isRemote = { isLocalRequest: () => false };
const body = JSON.stringify({ game: { id: 'g1', name: 'Test' }, events: [{ id: 'a' }] });
const post = (base, headers = {}, payload = body) => fetch(`${base}/api/live`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: payload,
});

/** Reads one server-sent message from an open stream. */
async function nextMessage(reader) {
  const { value } = await reader.read();
  return JSON.parse(new TextDecoder().decode(value).replace(/^data: /, ''));
}

test('another device can load the dashboard and nothing else', async () => {
  const base = await start(isRemote);
  for (const path of ['/dashboard.html', '/styles.css', '/dashboard.css', '/src/dashboard.js']) {
    assert.equal((await fetch(base + path)).status, 200, path);
  }
  for (const path of ['/index.html', '/package.json', '/serve.js', '/README.md', '/.claude/launch.json', '/api/info', '/test/server.test.js']) {
    assert.equal((await fetch(base + path)).status, 403, path);
  }
});

test('another device opening the root address lands on the dashboard', async () => {
  const base = await start(isRemote);
  const res = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/dashboard.html');
});

test('another device cannot publish game data', async () => {
  const base = await start(isRemote);
  assert.equal((await post(base)).status, 403);
});

test('another website open on this computer cannot publish game data', async () => {
  const base = await start();
  assert.equal((await post(base, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(base, { Origin: 'null' })).status, 403);
  assert.equal((await post(base, { Origin: base })).status, 204);
});

test('publishing rejects malformed data', async () => {
  const base = await start();
  assert.equal((await post(base, {}, 'not json')).status, 400);
  assert.equal((await post(base, {}, '{"game":{},"events":[]}')).status, 400);
  assert.equal((await post(base, { 'Content-Type': 'text/plain' })).status, 415);
});

test('oversized data is refused and the server keeps working', async () => {
  const base = await start();
  const huge = JSON.stringify({ game: { id: 'g' }, events: ['x'.repeat(6 * 1024 * 1024)] });
  assert.equal((await post(base, {}, huge)).status, 400);
  assert.equal((await post(base)).status, 204);
});

test('path tricks cannot escape the project or crash the server', async () => {
  const base = await start();
  const { hostname, port } = new URL(base);
  const raw = (path) => new Promise((done, fail) => {
    const req = request({ hostname, port, path }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', fail);
    req.end();
  });
  assert.equal(await raw('/%E0%A4%A'), 400);
  assert.equal(await raw('/..%2f..%2fwindows%2fwin.ini'), 403);
  assert.equal(await raw('/index.html'), 200);
});

test('the file server only accepts reads', async () => {
  const base = await start();
  assert.equal((await fetch(`${base}/index.html`, { method: 'DELETE' })).status, 405);
  assert.equal((await fetch(`${base}/api/live`)).status, 405);
});

test('the stream sends the current game on connect and every later update', async () => {
  const base = await start(isRemote);
  const reader = (await fetch(`${base}/api/live/stream`)).body.getReader();
  assert.equal(await nextMessage(reader), null);
  await reader.cancel();

  const local = await start();
  const stream = (await fetch(`${local}/api/live/stream`)).body.getReader();
  assert.equal(await nextMessage(stream), null);
  await post(local);
  assert.equal((await nextMessage(stream)).game.name, 'Test');
  const late = (await fetch(`${local}/api/live/stream`)).body.getReader();
  assert.deepEqual((await nextMessage(late)).events, [{ id: 'a' }]);
  await stream.cancel();
  await late.cancel();
});

test('info reports sharing status to this computer', async () => {
  const base = await start({ sharing: true, urls: ['http://192.168.1.5:5173'] });
  assert.deepEqual(await (await fetch(`${base}/api/info`)).json(), {
    sharing: true,
    urls: ['http://192.168.1.5:5173'],
  });
});
