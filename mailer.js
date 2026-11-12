'use strict';
/*
 * E-mail notifications of the bridge: a minimal SMTP client (no dependencies) and the queue that groups the page's notices into
 * one e-mail. Made for Gmail with an app password (smtp.gmail.com:465, implicit TLS); 587 uses STARTTLS. The recipient and the
 * credentials come only from the bridge's environment (or the .env next to server.js), never from the page or the workspace.
 *
 *   SQUAD_SMTP_USER      account that sends (Gmail address)
 *   SQUAD_SMTP_PASS      app password (Gmail shows it in groups of 4; spaces are dropped)
 *   SQUAD_NOTIFY_EMAIL   recipient (default: SQUAD_SMTP_USER)
 *   SQUAD_SMTP_HOST      default smtp.gmail.com
 *   SQUAD_SMTP_PORT      default 465 (implicit TLS); any other port uses STARTTLS
 *   SQUAD_SMTP_TLS       implicit | starttls overrides the port's choice; off = plain SMTP, accepted only for a loopback host (tests)
 *   SQUAD_MAIL_DELAY_MS  how long notices wait to go out together (default 60000)
 *   SQUAD_MAIL_MAX_HOUR  e-mails per hour at most (default 20); beyond it notices stay in the app only
 */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[^\s@<>()",;:\\[\]]{1,190}$/;
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];
const MAX_ITEMS = 20, MAX_PENDING = 60;
const clip = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').slice(0, max).trim();
const oneLine = (v, max) => clip(String(v ?? '').replace(/[\r\n]+/g, ' '), max);

function mailConfig(env = process.env) {
  const host = String(env.SQUAD_SMTP_HOST || 'smtp.gmail.com').trim().toLowerCase();
  const port = Number(env.SQUAD_SMTP_PORT) || 465;
  const user = String(env.SQUAD_SMTP_USER || '').trim();
  let pass = String(env.SQUAD_SMTP_PASS || '');
  if (host === 'smtp.gmail.com') pass = pass.replace(/\s+/g, '');
  const to = String(env.SQUAD_NOTIFY_EMAIL || user).trim();
  const loopback = LOOPBACK.includes(host);
  const delay = Number(env.SQUAD_MAIL_DELAY_MS), max = Number(env.SQUAD_MAIL_MAX_HOUR);
  let error = '';
  if (!user && !pass) error = 'E-mail não configurado: defina SQUAD_SMTP_USER e SQUAD_SMTP_PASS no ambiente do bridge (ou no .env).';
  else if (!user || !pass) error = `Falta ${user ? 'SQUAD_SMTP_PASS (senha de app)' : 'SQUAD_SMTP_USER'} no ambiente do bridge.`;
  else if (!EMAIL_RE.test(user)) error = 'SQUAD_SMTP_USER não parece um endereço de e-mail.';
  else if (!EMAIL_RE.test(to)) error = 'SQUAD_NOTIFY_EMAIL não parece um endereço de e-mail.';
  else if (!Number.isInteger(port) || port < 1 || port > 65535) error = 'SQUAD_SMTP_PORT inválida.';
  else if (env.SQUAD_SMTP_TLS === 'off' && !loopback) error = 'SQUAD_SMTP_TLS=off só vale para um servidor SMTP local (testes).';
  return {
    configured: !error, error, host, port, user, pass, to,
    tls: env.SQUAD_SMTP_TLS === 'off' ? 'none' : ['implicit', 'starttls'].includes(env.SQUAD_SMTP_TLS) ? env.SQUAD_SMTP_TLS : port === 465 ? 'implicit' : 'starttls',
    delayMs: Number.isFinite(delay) && delay >= 0 && delay <= 600000 ? delay : 60000,
    maxPerHour: Number.isInteger(max) && max >= 1 && max <= 500 ? max : 20,
  };
}

/* RFC 2047 encoded words of at most ~45 bytes each, split on character boundaries. */
function encodeHeader(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words = [];
  let cur = '';
  for (const ch of text) {
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

function buildMessage({ from, to, subject, text, date = new Date() }) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: "SQUAD/CODE" <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(oneLine(subject, 180))}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@squad-code.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: SQUAD/CODE bridge',
    '',
    body,
  ].join('\r\n');
}

class SmtpError extends Error {}

/* One SMTP connection: reads complete (multi-line) replies and survives the STARTTLS upgrade. */
class Conn {
  constructor(sock) { this.buf = ''; this.cur = []; this.replies = []; this.waiters = []; this.err = null; this.attach(sock); }
  attach(sock) {
    if (this.sock) this.sock.removeAllListeners('data');
    this.sock = sock;
    sock.on('data', d => { this.buf += d.toString('utf8'); this.pump(); });
    sock.on('error', e => this.fail(e));
    sock.on('close', () => this.fail(new SmtpError('O servidor SMTP fechou a conexão.')));
  }
  pump() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.cur.push(line);
      if (/^\d{3}(?!-)/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines: this.cur.map(l => l.slice(4)) };
        this.cur = [];
        const w = this.waiters.shift();
        if (w) w.resolve(reply); else this.replies.push(reply);
      }
    }
  }
  fail(e) { this.err ??= e; for (const w of this.waiters.splice(0)) w.reject(this.err); }
  read() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  async expect(codes, step) {
    const r = await this.read();
    if (!codes.includes(r.code)) throw Object.assign(new SmtpError(`${step}: ${r.code} ${r.lines.join(' ').slice(0, 300)}`), { code: r.code, step });
    return r;
  }
  cmd(line, codes, step = line.split(' ')[0]) { this.sock.write(line + '\r\n'); return this.expect(codes, step); }
}

// SNI takes a host name only (an IP address there is deprecated in Node).
const sni = host => net.isIP(host) ? undefined : host;
const caps = reply => reply.lines.slice(1).map(l => l.toUpperCase());

// Network and TLS failures in Portuguese, with the code for whoever needs to look it up.
function netMessage(e, cfg) {
  const at = `${cfg.host}:${cfg.port}`, code = e.code || '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return `Não encontrei ${cfg.host} (${code}). Confira a internet ou SQUAD_SMTP_HOST.`;
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)) return `Não consegui conectar a ${at} (${code}). Confira a internet, a porta (465 ou 587) e se algum firewall bloqueia SMTP.`;
  if (/CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS|SSL/i.test(code + ' ' + e.message)) return `A conexão segura com ${at} falhou: ${e.message}${code ? ` (${code})` : ''}.`;
  return `Falha ao falar com ${at}: ${e.message}`;
}

/** Sends one e-mail. Never puts the password in an error. */
async function sendMail(cfg, { subject, text }, { timeoutMs = 20000 } = {}) {
  if (!cfg.configured) throw new SmtpError(cfg.error);
  const sock = cfg.tls === 'implicit' ? tls.connect({ host: cfg.host, port: cfg.port, servername: sni(cfg.host) }) : net.connect({ host: cfg.host, port: cfg.port });
  const conn = new Conn(sock);
  const timer = setTimeout(() => { conn.fail(new SmtpError(`O servidor SMTP não respondeu em ${Math.round(timeoutMs / 1000)} s.`)); conn.sock.destroy(); }, timeoutMs);
  try {
    await conn.expect([220], 'Conexão');
    let ehlo = await conn.cmd('EHLO [127.0.0.1]', [250]);
    if (cfg.tls === 'starttls') {
      if (!caps(ehlo).some(c => c.startsWith('STARTTLS'))) throw new SmtpError('O servidor SMTP não oferece STARTTLS. Use a porta 465.');
      await conn.cmd('STARTTLS', [220]);
      const secure = tls.connect({ socket: conn.sock, servername: sni(cfg.host) });
      await new Promise((resolve, reject) => { secure.once('secureConnect', resolve); secure.once('error', reject); });
      conn.attach(secure);
      ehlo = await conn.cmd('EHLO [127.0.0.1]', [250]);
    }
    const auth = caps(ehlo).find(c => c.startsWith('AUTH')) || '';
    try {
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) await conn.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, [235], 'AUTH');
      else {
        await conn.cmd('AUTH LOGIN', [334], 'AUTH');
        await conn.cmd(Buffer.from(cfg.user).toString('base64'), [334], 'AUTH');
        await conn.cmd(Buffer.from(cfg.pass).toString('base64'), [235], 'AUTH');
      }
    } catch (e) {
      if (e.code === 535 || e.code === 534) throw new SmtpError(`O servidor recusou o login de ${cfg.user}. No Gmail, use uma senha de app (myaccount.google.com/apppasswords, com a verificação em duas etapas ligada), não a senha da conta.`);
      throw e;
    }
    await conn.cmd(`MAIL FROM:<${cfg.user}>`, [250], 'MAIL FROM');
    await conn.cmd(`RCPT TO:<${cfg.to}>`, [250, 251], 'RCPT TO');
    await conn.cmd('DATA', [354]);
    conn.sock.write(buildMessage({ from: cfg.user, to: cfg.to, subject, text }) + '\r\n.\r\n');
    await conn.expect([250], 'Envio');
    conn.sock.write('QUIT\r\n');
    await conn.read().catch(() => {});
    return { to: cfg.to };
  } catch (e) {
    if (e instanceof SmtpError) throw e;
    throw new SmtpError(netMessage(e, cfg));
  } finally {
    clearTimeout(timer);
    conn.sock.end();
    conn.sock.destroy();
  }
}

/** Notices from the page, kept to plain short text. Throws on anything that is not a list of 1..20 notices. */
function validateItems(value) {
  if (!Array.isArray(value) || !value.length) throw Object.assign(new Error('Envie items: uma lista de avisos.'), { status: 400 });
  if (value.length > MAX_ITEMS) throw Object.assign(new Error(`No máximo ${MAX_ITEMS} avisos por envio.`), { status: 400 });
  return value.map(it => {
    const title = oneLine(it?.title, 160);
    if (!title) throw Object.assign(new Error('Cada aviso precisa de um título.'), { status: 400 });
    const at = new Date(it?.at || Date.now());
    return { title, text: clip(it?.text, 1500), project: oneLine(it?.project, 120), action: it?.action === true, at: Number.isNaN(at.getTime()) ? new Date() : at };
  });
}

const hhmm = d => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** One e-mail for a batch: the subject names the first notice that needs the person. */
function digest(items, appUrl) {
  const lead = items.find(i => i.action) || items[0];
  const subject = `[SQUAD/CODE] ${items.length > 1 ? `${items.length} avisos: ${lead.title} e mais ${items.length - 1}` : lead.title}`;
  const blocks = items.map(i => [`${hhmm(i.at)}${i.project ? ` · ${i.project}` : ''}`, `${i.action ? '[AÇÃO] ' : ''}${i.title}`, i.text].filter(Boolean).join('\n'));
  const text = [`SQUAD/CODE: ${items.length > 1 ? `${items.length} avisos da squad` : 'aviso da squad'}`, '', blocks.join('\n\n'), '', appUrl ? `Abra ${appUrl} para agir.` : '', 'Enviado pelo bridge do SQUAD/CODE no seu computador.'].join('\n');
  return { subject, text };
}

/** Groups notices for cfg.delayMs, sends one e-mail per batch and keeps at most cfg.maxPerHour e-mails per hour. */
function createMailQueue(cfg, { appUrl = '', send = sendMail, log = console } = {}) {
  let pending = [], timer = null, chain = Promise.resolve();
  const sentAt = [];
  const st = { sent: 0, dropped: 0, lastSentAt: '', lastError: '' };
  const room = () => { const hour = Date.now() - 3600e3; while (sentAt.length && sentAt[0] < hour) sentAt.shift(); return sentAt.length < cfg.maxPerHour; };
  async function deliver(items) {
    if (!room()) {
      st.dropped += items.length;
      st.lastError = `Limite de ${cfg.maxPerHour} e-mails por hora atingido: ${items.length} aviso(s) ficaram só no app.`;
      log.warn?.(`E-mail: ${st.lastError}`);
      return { dropped: items.length };
    }
    sentAt.push(Date.now());
    try {
      const res = await send(cfg, digest(items, appUrl));
      st.sent++; st.lastSentAt = new Date().toISOString(); st.lastError = '';
      return { sent: items.length, to: res.to };
    } catch (e) {
      st.dropped += items.length; st.lastError = e.message;
      log.warn?.(`E-mail não enviado: ${e.message}`);
      throw e;
    }
  }
  function flush() {
    clearTimeout(timer); timer = null;
    const batch = pending.splice(0);
    if (!batch.length) return chain;
    chain = chain.then(() => deliver(batch)).catch(() => {});
    return chain;
  }
  return {
    add(items) {
      pending.push(...items);
      if (pending.length > MAX_PENDING) { st.dropped += pending.length - MAX_PENDING; pending = pending.slice(-MAX_PENDING); }
      if (!timer) { timer = setTimeout(flush, cfg.delayMs); timer.unref?.(); }
      return pending.length;
    },
    flush,
    // The test e-mail goes now and reports its error to the page.
    sendNow(items) { const run = chain.then(() => deliver(items)); chain = run.catch(() => {}); return run; },
    pending: () => pending.length,
    status: () => ({ ...st, pending: pending.length }),
  };
}

module.exports = { mailConfig, sendMail, buildMessage, encodeHeader, validateItems, digest, createMailQueue, SmtpError };
