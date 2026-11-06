// Zero-dependency server. Browsers only grant camera access and load ES modules from a
// secure origin, and http://localhost counts as one.
//
//   npm start      Private: only this computer can connect.
//   npm run share  Also serves the read-only dashboard to devices on the local network.
//
// Other devices can read the dashboard and live game data, and nothing else. Only a page
// on this computer can open the tracker or publish game data.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const HEARTBEAT_MS = 25000;
const REMOTE_FILES = /^\/(dashboard\.html|styles\.css|dashboard\.css|src\/[\w/.-]+\.js)$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function isLoopback(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

/** Blocks other websites open in this computer's browser from posting to the server. */
function isTrustedOrigin(req) {
  const { origin } = req.headers;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.host === req.headers.host && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function send(res, status, body = '', type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((done, fail) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) fail(new Error('too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

export function createTrackerServer({ urls = [], sharing = false, isLocalRequest = isLoopback } = {}) {
  let snapshot = 'null';
  const clients = new Set();
  const frame = () => `data: ${snapshot}\n\n`;

  async function publish(req, res) {
    if (!isLocalRequest(req) || !isTrustedOrigin(req)) return send(res, 403, 'Forbidden');
    if (!req.headers['content-type']?.startsWith('application/json')) return send(res, 415, 'JSON only');
    let data;
    try {
      data = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (typeof data?.game?.id !== 'string' || !Array.isArray(data.events)) return send(res, 400, 'Bad request');
    snapshot = JSON.stringify({ game: data.game, events: data.events });
    for (const client of clients) client.write(frame());
    return send(res, 204);
  }

  function stream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(frame());
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  async function serveFile(path, res) {
    const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return send(res, 403, 'Forbidden');
    try {
      const body = await readFile(file);
      return send(res, 200, body, TYPES[extname(file)] ?? 'application/octet-stream');
    } catch {
      return send(res, 404, 'Not found');
    }
  }

  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (path === '/api/live') {
      return req.method === 'POST' ? publish(req, res) : send(res, 405, 'Method not allowed');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (path === '/api/live/stream') return stream(req, res);

    const local = isLocalRequest(req);
    if (path === '/api/info') {
      return local
        ? send(res, 200, JSON.stringify({ sharing, urls }), 'application/json')
        : send(res, 403, 'Forbidden');
    }
    if (!local) {
      if (path === '/') {
        res.writeHead(302, { Location: '/dashboard.html' });
        return res.end();
      }
      if (!REMOTE_FILES.test(path)) return send(res, 403, 'Forbidden');
    }
    return serveFile(path, res);
  });

  // Keeps idle streams open through phones and routers that drop silent connections.
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': keep-alive\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return server;
}

function localNetworkUrls(port) {
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.'))
    .map((net) => net.address)
    .sort((a, b) => rank(a) - rank(b))
    .map((ip) => `http://${ip}:${port}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sharing = process.argv.includes('--share');
  const port = Number(process.env.PORT) || 5173;
  const urls = sharing ? localNetworkUrls(port) : [];
  const server = createTrackerServer({ sharing, urls });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop the other copy of the tracker first.`
      : error.message);
    process.exit(1);
  });
  server.listen(port, sharing ? '0.0.0.0' : '127.0.0.1', () => {
    console.log(`Tracker (this computer only): http://localhost:${port}`);
    if (sharing) {
      console.log(urls.length
        ? `Player dashboard for phones and tablets on the same network: ${urls[0]}`
        : 'No network connection found, so other devices cannot connect yet.');
      if (urls.length > 1) console.log(`If that address doesn't connect, try: ${urls.slice(1).join(', ')}`);
    }
  });
}
