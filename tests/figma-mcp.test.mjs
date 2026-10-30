// Tests of scripts/figma-mcp.mjs over stdio against a fake Figma API: no network, no real token.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'figma-mcp.mjs');
const TOKEN = 'test-token-123';

const FRAME = {
  id: '1:2', name: 'Login', type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 375.4, height: 812 },
  layoutMode: 'VERTICAL', itemSpacing: 8, paddingTop: 24, paddingRight: 16, paddingBottom: 24, paddingLeft: 16,
  primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'CENTER',
  fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
  cornerRadius: 12,
  children: [
    { id: '1:3', name: 'Titulo', type: 'TEXT', characters: 'Olá', absoluteBoundingBox: { x: 16, y: 24, width: 100, height: 24 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.5 }], style: { fontFamily: 'Inter', fontSize: 16, fontWeight: 600, lineHeightPx: 24.2 } },
    { id: '1:4', name: 'Oculto', type: 'RECTANGLE', visible: false },
  ],
};
const DOC = { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [{ id: '0:1', name: 'Pagina 1', type: 'CANVAS', children: [FRAME] }] };

let fake, base;
const requests = [];

before(async () => {
  fake = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token: req.headers['x-figma-token'] });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg id="a"></svg>'); }
    if (req.headers['x-figma-token'] !== TOKEN) return send(403, { status: 403, err: 'Invalid token' });
    const p = url.pathname;
    if (p === '/v1/me') return send(200, { id: 'u1', handle: 'Ana', email: 'ana@example.com' });
    if (p === '/v1/files/DENIEDKEY123') return send(403, { status: 403 });
    if (p === '/v1/files/MISSINGKEY12') return send(404, { status: 404 });
    if (p === '/v1/files/BUSYKEY12345') return send(429, { status: 429 }, { 'retry-after': '7' });
    if (p === '/v1/files/FILEKEY12345') return send(200, { name: 'App', lastModified: '2026-10-27T00:00:00Z', version: '9', document: DOC });
    if (p === '/v1/files/FILEKEY12345/nodes') return send(200, { name: 'App', lastModified: '2026-10-27T00:00:00Z', nodes: { '1:2': { document: FRAME }, '9:9': null } });
    if (p === '/v1/images/FILEKEY12345') return send(200, { err: null, images: { '1:2': `${base}/img/a.svg`, '1:3': null } });
    if (p === '/v1/files/FILEKEY12345/components') return send(200, { meta: { components: [{ name: 'Button', description: 'Primário', node_id: '5:1', containing_frame: { name: 'Controles' } }] } });
    if (p === '/v1/files/FILEKEY12345/styles') return send(403, { status: 403 });
    return send(404, { status: 404 });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fake.address().port}`;
});
after(() => fake.close());

/** Starts the MCP server and talks to it like a client would. */
function client(env = {}) {
  const proc = spawn(process.execPath, [SCRIPT], { env: { ...process.env, FIGMA_API_BASE: base, FIGMA_TOKEN: TOKEN, FIGMA_CACHE_TTL_S: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(), lines = [];
  let seq = 0;
  createInterface({ input: proc.stdout }).on('line', line => { lines.push(line); const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`sem resposta a ${method}`)), 8000);
  });
  return {
    proc, lines, call,
    notify: (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'),
    async tool(name, args = {}) {
      const r = (await call('tools/call', { name, arguments: args })).result;
      const text = r.content[0].text;
      let json; try { json = JSON.parse(text); } catch {}
      return { isError: !!r.isError, text, json };
    },
    close: () => { proc.stdin.end(); return new Promise(r => proc.once('exit', r)); },
  };
}

test('handshake echoes the protocol version, lists five read-only tools and ignores notifications', async () => {
  const c = client();
  const init = (await c.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } })).result;
  assert.equal(init.protocolVersion, '2025-11-25');
  assert.deepEqual(init.capabilities, { tools: {} });
  c.notify('notifications/initialized');
  await c.call('ping');
  assert.equal(c.lines.length, 2, 'a notification gets no answer');
  const tools = (await c.call('tools/list')).result.tools;
  assert.deepEqual(tools.map(t => t.name), ['figma_whoami', 'figma_get_file', 'figma_get_nodes', 'figma_export_images', 'figma_get_design_system']);
  assert.ok(tools.every(t => t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false && t.inputSchema.type === 'object'));
  assert.ok(tools.every(t => !('run' in t)));
  assert.equal((await c.call('nope')).error.code, -32601);
  await c.close();
});

test('whoami confirms the token and returns the handle only', async () => {
  const c = client();
  const r = await c.tool('figma_whoami');
  assert.deepEqual(r.json, { handle: 'Ana', id: 'u1' });
  assert.ok(!r.text.includes('example.com'));
  await c.close();
});

test('get_file sends the depth, takes a link, and summarizes what a designer reads', async () => {
  const c = client();
  requests.length = 0;
  const shallow = await c.tool('figma_get_file', { file: 'https://www.figma.com/design/FILEKEY12345/App?node-id=1-2', depth: 2 });
  assert.equal(requests.at(-1).path, '/v1/files/FILEKEY12345');
  assert.equal(requests.at(-1).query.depth, '2');
  assert.deepEqual(shallow.json.pages[0].children[0].childCount, 2);
  assert.equal(shallow.json.pages[0].children[0].children, undefined);

  const deep = await c.tool('figma_get_file', { file: 'FILEKEY12345', depth: 3 });
  const frame = deep.json.pages[0].children[0];
  assert.deepEqual(frame.size, [375, 812]);
  assert.deepEqual(frame.layout, { dir: 'VERTICAL', gap: 8, align: ['MIN', 'CENTER'], pad: [24, 16, 24, 16] });
  assert.deepEqual(frame.fill, ['#ff0000']);
  assert.equal(frame.radius, 12);
  const [title, hidden] = frame.children;
  assert.equal(title.text, 'Olá');
  assert.deepEqual(title.font, { family: 'Inter', size: 16, weight: 600, lineHeight: 24 });
  assert.deepEqual(title.fill, ['#000000 @50%']);
  assert.equal(hidden.hidden, true);
  assert.equal(deep.json.name, 'App');
  await c.close();
});

test('get_nodes reads the node-id of a link (1-2 becomes 1:2), reports missing nodes as null and can return the raw JSON', async () => {
  const c = client();
  requests.length = 0;
  const viaLink = await c.tool('figma_get_nodes', { file: 'https://www.figma.com/design/FILEKEY12345/App?node-id=1-2' });
  assert.equal(requests.at(-1).query.ids, '1:2');
  assert.equal(requests.at(-1).query.depth, '3');
  assert.equal(viaLink.json.nodes['1:2'].name, 'Login');

  const both = await c.tool('figma_get_nodes', { file: 'FILEKEY12345', ids: ['1:2', '9:9'], detail: 'full' });
  assert.equal(both.json.nodes['9:9'], null);
  assert.equal(both.json.nodes['1:2'].layoutMode, 'VERTICAL', 'full detail is the raw node');
  await c.close();
});

test('export_images inlines svg code and only lists the temporary urls for other formats', async () => {
  const c = client();
  requests.length = 0;
  const svg = await c.tool('figma_export_images', { file: 'FILEKEY12345', ids: ['1:2', '1:3'], format: 'svg', scale: 9 });
  assert.equal(requests.find(r => r.path === '/v1/images/FILEKEY12345').query.scale, '4', 'scale is clamped');
  assert.deepEqual(svg.json.svg, { '1:2': '<svg id="a"></svg>' });
  assert.equal(svg.json.images['1:3'], null);
  const png = await c.tool('figma_export_images', { file: 'FILEKEY12345', ids: ['1:2'] });
  assert.equal(png.json.svg, undefined);
  assert.match(png.json.images['1:2'], /\/img\/a\.svg$/);
  assert.equal(requests.filter(r => r.path.startsWith('/img/')).length, 1, 'only svg is downloaded');
  assert.ok(requests.filter(r => r.path.startsWith('/img/')).every(r => r.token === undefined), 'the token never goes to the image host');
  await c.close();
});

test('get_design_system keeps the half that worked when the other is refused', async () => {
  const c = client();
  const r = await c.tool('figma_get_design_system', { file: 'FILEKEY12345' });
  assert.deepEqual(r.json.components, [{ name: 'Button', description: 'Primário', node: '5:1', frame: 'Controles' }]);
  assert.match(r.json.styles.error, /403/);
  await c.close();
});

test('errors are explained in Portuguese and the token never appears in any answer', async () => {
  const c = client();
  const denied = await c.tool('figma_get_file', { file: 'DENIEDKEY123' });
  assert.ok(denied.isError); assert.match(denied.text, /403/);
  const missing = await c.tool('figma_get_file', { file: 'MISSINGKEY12' });
  assert.ok(missing.isError); assert.match(missing.text, /404/);
  const busy = await c.tool('figma_get_file', { file: 'BUSYKEY12345' });
  assert.ok(busy.isError); assert.match(busy.text, /429.*7 s/);
  assert.match((await c.tool('figma_get_file', { file: 'abc' })).text, /Arquivo inválido/);
  assert.match((await c.tool('figma_get_nodes', { file: 'FILEKEY12345', ids: ['x y'] })).text, /Id de nó inválido/);
  assert.match((await c.tool('figma_get_nodes', { file: 'FILEKEY12345' })).text, /Informe ids/);
  assert.match((await c.tool('figma_get_nodes', { file: 'FILEKEY12345', ids: Array.from({ length: 21 }, (_, i) => `1:${i}`) })).text, /Até 20/);
  assert.equal((await c.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.ok(c.lines.every(l => !l.includes(TOKEN)));
  await c.close();
});

test('without FIGMA_TOKEN every tool says what to do and no request is made', async () => {
  const c = client({ FIGMA_TOKEN: '' });
  requests.length = 0;
  for (const name of ['figma_whoami', 'figma_get_file']) {
    const r = await c.tool(name, { file: 'FILEKEY12345' });
    assert.ok(r.isError); assert.match(r.text, /FIGMA_TOKEN não está definido/);
  }
  assert.equal(requests.length, 0);
  await c.close();
});

test('only GET reaches the API, and a remote FIGMA_API_BASE is refused at start', async () => {
  const c = client();
  requests.length = 0;
  for (const [name, args] of [['figma_whoami', {}], ['figma_get_file', { file: 'FILEKEY12345' }], ['figma_get_nodes', { file: 'FILEKEY12345', ids: ['1:2'] }], ['figma_export_images', { file: 'FILEKEY12345', ids: ['1:2'] }], ['figma_get_design_system', { file: 'FILEKEY12345' }]]) await c.tool(name, args);
  assert.ok(requests.length >= 6);
  assert.ok(requests.every(r => r.method === 'GET'));
  await c.close();
  const proc = spawn(process.execPath, [SCRIPT], { env: { ...process.env, FIGMA_API_BASE: 'https://api.example.com' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', d => { err += d; });
  const code = await new Promise(r => proc.once('exit', r));
  assert.equal(code, 1);
  assert.match(err, /FIGMA_API_BASE/);
});

test('cache: the same read costs one request, in this run and the next; fresh, another depth, errors and whoami skip it', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squad-figma-cache-'));
  const env = { FIGMA_CACHE_TTL_S: '300', FIGMA_CACHE_DIR: dir };
  const c = client(env), other = client(env);
  requests.length = 0;
  const first = await c.tool('figma_get_file', { file: 'FILEKEY12345', depth: 2 });
  const again = await c.tool('figma_get_file', { file: 'FILEKEY12345', depth: 2 });
  assert.equal(requests.length, 1);
  assert.equal(first.json.cached, undefined);
  assert.match(again.json.cached, /^\d{4}-\d{2}-\d{2}T/);
  delete again.json.cached;
  assert.deepEqual(again.json, first.json);

  // The next run is another process: it reads what this one kept.
  assert.match((await other.tool('figma_get_file', { file: 'FILEKEY12345', depth: 2 })).json.cached, /^\d{4}/);
  assert.equal(requests.length, 1);

  await c.tool('figma_get_file', { file: 'FILEKEY12345', depth: 3 });
  assert.equal(requests.length, 2, 'another depth is another request');
  assert.equal((await c.tool('figma_get_file', { file: 'FILEKEY12345', depth: 2, fresh: true })).json.cached, undefined);
  assert.equal(requests.length, 3, 'fresh asks Figma again');
  await c.tool('figma_whoami'); await c.tool('figma_whoami');
  assert.equal(requests.length, 5, 'whoami is a diagnosis and is never cached');
  await c.tool('figma_get_file', { file: 'DENIEDKEY123' }); await c.tool('figma_get_file', { file: 'DENIEDKEY123' });
  assert.equal(requests.length, 7, 'errors are not cached');

  // Another account never reads this one's entries (the key hashes the token).
  const stranger = client({ ...env, FIGMA_TOKEN: 'another-token' });
  const denied = await stranger.tool('figma_get_file', { file: 'FILEKEY12345', depth: 2 });
  assert.ok(denied.isError && /403/.test(denied.text));
  assert.equal(requests.length, 8);

  if (process.platform !== 'win32') {
    assert.equal(statSync(dir).mode & 0o077, 0, 'the folder is private to the user');
    for (const name of readdirSync(dir)) assert.equal(statSync(path.join(dir, name)).mode & 0o077, 0);
  }
  for (const x of [c, other, stranger]) await x.close();
  rmSync(dir, { recursive: true, force: true });
});

test('cache: entries expire, and a cache that cannot be written never breaks a call', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'squad-figma-cache-'));
  const c = client({ FIGMA_CACHE_TTL_S: '0.3', FIGMA_CACHE_DIR: dir });
  requests.length = 0;
  await c.tool('figma_get_file', { file: 'FILEKEY12345' });
  await new Promise(r => setTimeout(r, 450));
  assert.equal((await c.tool('figma_get_file', { file: 'FILEKEY12345' })).json.cached, undefined);
  assert.equal(requests.length, 2, 'a stale entry is asked again');
  await c.close();
  rmSync(dir, { recursive: true, force: true });

  const broken = client({ FIGMA_CACHE_TTL_S: '300', FIGMA_CACHE_DIR: '/dev/null/never' });
  const r = await broken.tool('figma_get_file', { file: 'FILEKEY12345' });
  assert.ok(!r.isError && r.json.name === 'App');
  await broken.close();
});
