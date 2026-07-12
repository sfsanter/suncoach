#!/usr/bin/env node
/**
 * Récepteur debug SunCoach — écoute POST /capture depuis le téléphone (même WiFi).
 * Usage : node test-receiver.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SUNCOACH_RECEIVER_PORT || '39281', 10);
const CAPTURES_DIR = path.join(__dirname, 'test-captures');

const CORS_ORIGINS = [
  'https://sfsanter.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

function localAddresses() {
  const addrs = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addrs.push({ name, address: iface.address });
      }
    }
  }
  return addrs;
}

function corsHeaders(origin) {
  const allowOrigin =
    !origin ||
    CORS_ORIGINS.some((o) => origin === o || origin.startsWith(o)) ||
    origin.endsWith('.github.io')
      ? origin || '*'
      : '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function timestampSlug() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  ].join('-') + '_' + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join('-');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function statusHtml() {
  const addrs = localAddresses();
  const ipList = addrs.length
    ? addrs.map((a) => `<li><code>${a.address}</code> (${a.name})</li>`).join('')
    : '<li>Aucune IPv4 locale détectée</li>';
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>SunCoach receiver</title></head>
<body style="font-family:monospace;background:#111;color:#0f0;padding:2rem">
  <h1>SunCoach receiver actif</h1>
  <p>Port <strong>${PORT}</strong> · POST <code>/capture</code></p>
  <p>IP à saisir sur le téléphone :</p>
  <ul>${ipList}</ul>
  <p>Dossier captures : <code>${CAPTURES_DIR}</code></p>
</body>
</html>`;
}

async function handleCapture(req, res, origin) {
  const raw = await readBody(req);
  let data;
  try {
    data = JSON.parse(raw.toString('utf8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  fs.mkdirSync(CAPTURES_DIR, { recursive: true });
  const slug = timestampSlug();
  const jsonPath = path.join(CAPTURES_DIR, `${slug}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf8');

  let jpgPath = null;
  const jpeg = data.minimapJpeg;
  if (typeof jpeg === 'string' && jpeg.startsWith('data:image/')) {
    const b64 = jpeg.split(',')[1];
    if (b64) {
      jpgPath = path.join(CAPTURES_DIR, `${slug}.jpg`);
      fs.writeFileSync(jpgPath, Buffer.from(b64, 'base64'));
    }
  }

  console.log(`[capture] ${jsonPath}${jpgPath ? ' + ' + path.basename(jpgPath) : ''}`);
  res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders(origin) });
  res.end(JSON.stringify({ ok: true, file: path.basename(jsonPath), jpg: jpgPath ? path.basename(jpgPath) : null }));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
    res.end(statusHtml());
    return;
  }

  if (req.method === 'POST' && req.url === '/capture') {
    try {
      await handleCapture(req, res, origin);
    } catch (err) {
      console.error('[error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ error: String(err.message) }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain', ...cors });
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('=== SunCoach test receiver ===');
  console.log(`Écoute 0.0.0.0:${PORT}`);
  console.log(`Captures → ${CAPTURES_DIR}`);
  console.log('');
  const addrs = localAddresses();
  if (addrs.length) {
    console.log('IP à saisir sur le téléphone :');
    for (const a of addrs) console.log(`  ${a.address}  (${a.name})`);
  } else {
    console.log('Aucune IPv4 locale — vérifie la connexion WiFi.');
  }
  console.log('');
  console.log(`Status : http://127.0.0.1:${PORT}/`);
});
