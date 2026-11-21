import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { buildDemo } from '../scripts/build-demo.mjs';
import { createDemoPreview } from '../scripts/preview-static-demo.mjs';
import { initialMode } from '../public/demo.js';
import { parsePublicOrigin } from '../lib/web-origin.mjs';
import { createApp } from '../server.mjs';
import { acquireAppLock } from '../lib/app-lock.mjs';

async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'kero-deployment-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const project = new URL('../', import.meta.url);

test('static demo is forced, uses current shared sources and contains only deployable public files', async t => {
  const root = await temporary(t), output = join(root, 'site');
  await mkdir(output); await writeFile(join(output, 'stale.env'), 'must not be published');
  const result = await buildDemo({ outputRoot: root, outputDir: output });
  const html = await readFile(join(output, 'index.html'), 'utf8');
  assert.match(html, /<html[^>]+data-demo-only="true"/); assert.match(html, /connect-src 'none'/);
  assert.equal(initialMode('?mode=local', 'local', html.includes('data-demo-only="true"')), 'demo');
  assert.doesNotMatch(html, /(?:src|href)="\/(?!\/)/);
  assert.match(html, /data-mode-choice="local" hidden aria-hidden="true" tabindex="-1"><\/button>/);
  for (const file of result.files.filter(file => /\.(js|css)$/.test(file))) assert.equal(await readFile(join(output, file), 'utf8'), await readFile(new URL('public/' + file, project), 'utf8'));
  assert.ok(result.files.includes('assets/favicon.svg')); assert.ok(result.files.includes('assets/favicon.ico')); assert.ok(result.files.includes('.nojekyll'));
  const names = await readdir(output); for (const name of ['.env', 'stale.env', 'server.mjs', 'data', 'lib', '.git']) assert.equal(names.includes(name), false);
  await assert.rejects(buildDemo({ outputRoot: root, outputDir: root }), /direct child/);
  await assert.rejects(buildDemo({ outputRoot: root, outputDir: join(root, '../outside') }), /direct child/);
  assert.match(await readFile(join(output, 'index.html'), 'utf8'), /data-demo-only/);
});

test('demo assets and module imports resolve under a GitHub Pages repository path without a backend', async t => {
  const root = await temporary(t), result = await buildDemo({ outputRoot: root, outputDir: join(root, 'site') });
  const server = createDemoPreview(result.directory, '/repo-name/'); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/repo-name/`, response = await fetch(base + '?mode=local');
    assert.equal(response.status, 200); const html = await response.text();
    for (const match of html.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)) assert.equal((await fetch(new URL(match[1], base))).status, 200, match[1]);
    for (const file of result.files.filter(file => file.endsWith('.js'))) {
      const module = await (await fetch(new URL(file, base))).text();
      for (const match of module.matchAll(/\bfrom\s+['"](\.\/[^'"]+)['"]/g)) assert.equal((await fetch(new URL(match[1], new URL(file, base)))).status, 200, `${file}: ${match[1]}`);
    }
    assert.equal((await fetch(base + 'api/auth/session')).status, 404);
    assert.equal((await fetch(base + 'api/import', { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(new URL('/repo-name', base), { redirect: 'manual' })).status, 308);
    assert.equal((await fetch(new URL('/outside', base))).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('public origins accept Docker port mappings and HTTPS proxies while rejecting untrusted hosts and origins', async t => {
  for (const origin of ['ftp://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?query=1']) assert.throws(() => parsePublicOrigin(origin), /PUBLIC_ORIGIN/);
  assert.equal(parsePublicOrigin('https://covers.example.com/'), 'https://covers.example.com');
  const root = await temporary(t), server = await createApp(root, { publicOrigin: 'https://covers.example.com' }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = (headers, input) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: input ? '/api/auth/register' : '/api/auth/session', method: input ? 'POST' : 'GET', headers: { ...headers, ...(input ? { 'Content-Type': 'application/json' } : {}) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })); });
    req.on('error', reject); req.end(input ? JSON.stringify(input) : undefined);
  });
  try {
    const registered = await call({ Host: 'covers.example.com', Origin: 'https://covers.example.com' }, { login: 'deployment_test', password: 'Deployment test password' });
    assert.equal(registered.status, 200); assert.match(registered.headers['set-cookie'][0], /; Secure$/);
    assert.equal((await call({ Host: 'covers.example.com', Origin: 'https://other.example' })).status, 403);
    assert.equal((await call({ Host: 'other.example', Origin: 'https://covers.example.com' })).status, 403);
    assert.equal((await call({ Host: 'other.example', 'X-Forwarded-Host': 'covers.example.com' })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/auth/session`)).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('startup recovers a reused PID while protecting the current server on Windows and Linux', { skip: !['linux', 'win32'].includes(process.platform) }, async t => {
  const root = await temporary(t); await mkdir(join(root, 'data'));
  await writeFile(join(root, 'data/app.lock'), JSON.stringify({ pid: process.pid, nonce: 'old', instanceId: 'old-container-process' }));
  const release = acquireAppLock(root);
  try { assert.throws(() => acquireAppLock(root), error => error.code === 'APP_ALREADY_RUNNING'); }
  finally { release(); }
});
