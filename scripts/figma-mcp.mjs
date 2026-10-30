#!/usr/bin/env node
// Figma MCP server of SQUAD/CODE: read-only, no dependencies, over stdio (one JSON-RPC message per line).
// It talks to the Figma REST API with a personal access token (FIGMA_TOKEN), so it works on every plan, without Dev Mode.
// Only GET requests are ever made: nothing here can change a Figma file. The bridge starts it for the agents that have it
// (server.js, BUILTIN_MCP) and hands the token over from its own environment; it is never written to a file.
import { createInterface } from 'node:readline';

const VERSION = '1.0.0';
const TOKEN = process.env.FIGMA_TOKEN || '';
const MAX_OUT = 60000;
const MAX_IDS = 20;
const MAX_SVGS = 5;
const MAX_SVG_CHARS = 20000;
const MAX_LIST = 300;
const TIMEOUT_MS = 30000;

// The token only ever goes to api.figma.com. FIGMA_API_BASE exists for the tests and must be a loopback address.
const BASE = (() => {
  const die = () => { process.stderr.write('FIGMA_API_BASE só aceita http://127.0.0.1 ou http://localhost.\n'); process.exit(1); };
  const raw = process.env.FIGMA_API_BASE;
  if (!raw) return 'https://api.figma.com';
  let url;
  try { url = new URL(raw); } catch { die(); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) die();
  return url.origin;
})();

const KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const NODE_RE = /^[A-Za-z0-9:;_-]{1,100}$/;
const clamp = (value, min, max, fallback) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };

// Links write node ids as 1-2, the API wants 1:2.
function nodeId(id) {
  const s = String(id).trim(), v = /^\d+-\d+$/.test(s) ? s.replace('-', ':') : s;
  if (!NODE_RE.test(v)) throw new Error(`Id de nó inválido: ${s.slice(0, 40)}`);
  return v;
}

// A file key or a Figma link (design or file, with an optional branch and node-id).
function parseFile(input) {
  const text = String(input || '').trim();
  const m = text.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  const key = m ? (m[2] || m[1]) : text;
  if (!KEY_RE.test(key)) throw new Error('Arquivo inválido: informe a chave do arquivo ou o link do Figma (figma.com/design/<chave>/...).');
  const node = text.match(/[?&]node-id=([^&#]+)/);
  return { key, nodeId: node ? nodeId(decodeURIComponent(node[1])) : '' };
}

function idsOf(ids, fromLink) {
  const list = (Array.isArray(ids) && ids.length ? ids : fromLink ? [fromLink] : []).map(nodeId);
  if (!list.length) throw new Error('Informe ids de nós (ex.: "1:2") ou um link com node-id.');
  if (list.length > MAX_IDS) throw new Error(`Até ${MAX_IDS} nós por chamada.`);
  return list;
}

function httpError(res) {
  switch (res.status) {
    case 400: return 'O Figma recusou o pedido (400): confira a chave do arquivo e os ids dos nós.';
    case 403: return 'Acesso negado (403): o token não tem o escopo necessário, expirou, ou o arquivo não está acessível para a conta do token.';
    case 404: return 'Não encontrado (404): confira a chave do arquivo e os ids dos nós.';
    case 429: { const wait = res.headers.get('retry-after'); return `Limite de requisições do Figma atingido (429).${wait ? ` Tente de novo em ${wait} s.` : ''}`; }
    default: return `O Figma respondeu ${res.status}.`;
  }
}

async function figma(path, params = {}) {
  if (!TOKEN) throw new Error('FIGMA_TOKEN não está definido no ambiente do bridge. Gere um token em Figma > Settings > Security > Personal access tokens e inicie o bridge com FIGMA_TOKEN exportado.');
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { 'X-Figma-Token': TOKEN }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(httpError(res));
  return res.json();
}

// What a designer reads from a node: size, layout, color, type and text. Everything else in the raw tree is noise for the model.
const byte = x => Math.round(x * 255).toString(16).padStart(2, '0');
function paint(p) {
  if (!p || p.visible === false) return null;
  if (p.type !== 'SOLID' || !p.color) return p.type;
  const a = p.opacity ?? p.color.a ?? 1;
  return `#${byte(p.color.r)}${byte(p.color.g)}${byte(p.color.b)}${a < 1 ? ` @${Math.round(a * 100)}%` : ''}`;
}

function summarize(n, levels) {
  const o = { id: n.id, name: n.name, type: n.type };
  if (n.visible === false) o.hidden = true;
  const box = n.absoluteBoundingBox;
  if (box) { o.size = [Math.round(box.width), Math.round(box.height)]; o.at = [Math.round(box.x), Math.round(box.y)]; }
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    o.layout = { dir: n.layoutMode, gap: n.itemSpacing, align: [n.primaryAxisAlignItems, n.counterAxisAlignItems] };
    const pad = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map(x => x || 0);
    if (pad.some(Boolean)) o.layout.pad = pad;
  }
  const fills = (n.fills || []).map(paint).filter(Boolean);
  if (fills.length) o.fill = fills;
  const strokes = (n.strokes || []).map(paint).filter(Boolean);
  if (strokes.length) o.stroke = { paints: strokes, weight: n.strokeWeight };
  if (n.cornerRadius) o.radius = n.cornerRadius;
  if (n.opacity !== undefined && n.opacity < 1) o.opacity = n.opacity;
  if (n.effects?.length) o.effects = n.effects.filter(e => e.visible !== false).map(e => e.type);
  if (n.type === 'TEXT') {
    o.text = String(n.characters || '').slice(0, 500);
    const s = n.style;
    if (s) o.font = { family: s.fontFamily, size: s.fontSize, weight: s.fontWeight, lineHeight: s.lineHeightPx ? Math.round(s.lineHeightPx) : undefined };
  }
  if (n.componentId) o.component = n.componentId;
  if (n.children) {
    if (levels > 0) o.children = n.children.map(c => summarize(c, levels - 1));
    else o.childCount = n.children.length;
  }
  return o;
}

async function svgText(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.origin !== BASE) return null; // the image host is whatever Figma answered; never plain http
  const res = await fetch(u, { signal: AbortSignal.timeout(TIMEOUT_MS) }); // no token: the image URL is already signed
  if (!res.ok) return null;
  const text = await res.text();
  return text.length > MAX_SVG_CHARS ? text.slice(0, MAX_SVG_CHARS) + '\n<!-- truncado -->' : text;
}

const FILE = { type: 'string', description: 'Chave do arquivo do Figma ou o link completo (figma.com/design/<chave>/...).' };
const IDS = { type: 'array', items: { type: 'string' }, description: 'Ids de nós, como "1:2". Se faltar, vale o node-id do link.' };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: 'figma_whoami', title: 'Conta do token do Figma', annotations: READ_ONLY,
    description: 'Confirma que o token do Figma funciona e devolve o nome da conta. Use para diagnosticar acesso.',
    inputSchema: { type: 'object', properties: {} },
    async run() { const me = await figma('/v1/me'); return { handle: me.handle, id: me.id }; },
  },
  {
    name: 'figma_get_file', title: 'Estrutura de um arquivo do Figma', annotations: READ_ONLY,
    description: 'Lê um arquivo do Figma e devolve as páginas e as telas de cada uma, resumidas (tamanho, layout, cores, textos, fontes). Comece por aqui, com depth 2, e aprofunde com figma_get_nodes.',
    inputSchema: { type: 'object', properties: { file: FILE, depth: { type: 'integer', minimum: 1, maximum: 4, description: '1 = só páginas, 2 = páginas e telas (padrão), 3 e 4 descem mais.' } }, required: ['file'] },
    async run({ file, depth }) {
      const { key } = parseFile(file), d = Math.round(clamp(depth, 1, 4, 2));
      const data = await figma(`/v1/files/${key}`, { depth: d });
      return { name: data.name, lastModified: data.lastModified, version: data.version, pages: (data.document?.children || []).map(p => summarize(p, d - 1)) };
    },
  },
  {
    name: 'figma_get_nodes', title: 'Nós específicos de um arquivo do Figma', annotations: READ_ONLY,
    description: 'Lê telas ou componentes pelo id e devolve a árvore resumida: tamanho, posição, auto layout, espaçamentos, cores, bordas, raio, sombras, textos e fontes. Use detail "full" para o JSON bruto do Figma.',
    inputSchema: { type: 'object', properties: { file: FILE, ids: IDS, depth: { type: 'integer', minimum: 1, maximum: 6, description: 'Quantos níveis abaixo de cada nó (padrão 3).' }, detail: { type: 'string', enum: ['summary', 'full'] } }, required: ['file'] },
    async run({ file, ids, depth, detail }) {
      const { key, nodeId: fromLink } = parseFile(file), list = idsOf(ids, fromLink), d = Math.round(clamp(depth, 1, 6, 3));
      const data = await figma(`/v1/files/${key}/nodes`, { ids: list.join(','), depth: d });
      const nodes = {};
      for (const id of list) {
        const doc = data.nodes?.[id]?.document;
        nodes[id] = doc ? (detail === 'full' ? doc : summarize(doc, d)) : null;
      }
      return { name: data.name, lastModified: data.lastModified, nodes };
    },
  },
  {
    name: 'figma_export_images', title: 'Exportar nós do Figma como imagem', annotations: READ_ONLY,
    description: 'Exporta nós como png, jpg, svg ou pdf. Para svg, devolve o código inline (até 5 nós), pronto para gravar em um arquivo do projeto; nos outros formatos devolve URLs temporárias.',
    inputSchema: { type: 'object', properties: { file: FILE, ids: IDS, format: { type: 'string', enum: ['png', 'jpg', 'svg', 'pdf'] }, scale: { type: 'number', minimum: 0.01, maximum: 4, description: 'Escala de 0,01 a 4 (padrão 1).' } }, required: ['file'] },
    async run({ file, ids, format, scale }) {
      const { key, nodeId: fromLink } = parseFile(file), list = idsOf(ids, fromLink);
      const fmt = ['png', 'jpg', 'svg', 'pdf'].includes(format) ? format : 'png';
      const data = await figma(`/v1/images/${key}`, { ids: list.join(','), format: fmt, scale: clamp(scale, 0.01, 4, 1) });
      if (data.err) throw new Error(`O Figma não exportou: ${String(data.err).slice(0, 200)}`);
      const out = { images: data.images || {} };
      if (fmt === 'svg') {
        out.svg = {};
        for (const [id, url] of Object.entries(out.images).filter(([, u]) => u).slice(0, MAX_SVGS)) out.svg[id] = await svgText(url).catch(() => null);
      }
      return out;
    },
  },
  {
    name: 'figma_get_design_system', title: 'Componentes e estilos de um arquivo do Figma', annotations: READ_ONLY,
    description: 'Lista os componentes e os estilos (cor, texto, efeito) publicados no arquivo, com nome, descrição e id do nó. Use o id em figma_get_nodes para ver os detalhes. Variáveis não estão disponíveis (a API só as libera no plano Enterprise).',
    inputSchema: { type: 'object', properties: { file: FILE }, required: ['file'] },
    async run({ file }) {
      const { key } = parseFile(file);
      const [components, styles] = await Promise.allSettled([figma(`/v1/files/${key}/components`), figma(`/v1/files/${key}/styles`)]);
      const part = (r, map) => r.status === 'fulfilled' ? (r.value.meta?.[map.key] || []).slice(0, MAX_LIST).map(map.fn) : { error: explain(r.reason) };
      return {
        components: part(components, { key: 'components', fn: c => ({ name: c.name, description: c.description || undefined, node: c.node_id, frame: c.containing_frame?.name }) }),
        styles: part(styles, { key: 'styles', fn: s => ({ name: s.name, type: s.style_type, description: s.description || undefined, node: s.node_id }) }),
      };
    },
  },
];

const text = value => {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n[truncado: ${s.length - MAX_OUT} caracteres omitidos. Use um depth menor ou peça nós específicos com figma_get_nodes.]` : s;
};

function explain(e) {
  if (e?.name === 'TimeoutError') return `O Figma não respondeu em ${TIMEOUT_MS / 1000} s.`;
  if (e instanceof TypeError) return 'Não foi possível falar com o Figma (rede).';
  return String(e?.message || e);
}

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return; // notifications get no answer
  switch (method) {
    case 'initialize': {
      // Tools only, and that part of the protocol is the same in every revision: answer with the version the client speaks.
      const asked = String(params?.protocolVersion || '');
      return reply(id, { protocolVersion: /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'squad-figma', version: VERSION } });
    }
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: TOOLS.map(({ run, ...tool }) => tool) });
    case 'tools/call': {
      const tool = TOOLS.find(t => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Ferramenta desconhecida: ${String(params?.name).slice(0, 60)}`);
      try { return reply(id, { content: [{ type: 'text', text: text(await tool.run(params.arguments || {})) }] }); }
      catch (e) { return reply(id, { isError: true, content: [{ type: 'text', text: explain(e) }] }); }
    }
    default: return fail(id, -32601, `Método não suportado: ${String(method).slice(0, 60)}`);
  }
}

let pending = 0, closed = false;
const done = () => { if (closed && !pending) process.exit(0); };
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'JSON inválido.'); }
  for (const m of Array.isArray(msg) ? msg : [msg]) {
    pending++;
    handle(m).catch(e => { if (m?.id !== undefined && m?.id !== null) fail(m.id, -32603, explain(e)); }).finally(() => { pending--; done(); });
  }
});
rl.on('close', () => { closed = true; done(); });
