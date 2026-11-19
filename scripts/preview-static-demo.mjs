import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemo } from './build-demo.mjs';

export function createDemoPreview(directory, basePath = '/') {
  const root = resolve(directory), prefix = '/' + basePath.replace(/^\/+|\/+$/g, '') + '/';
  const base = prefix === '//' ? '/' : prefix;
  return http.createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (path === base.slice(0, -1) && base !== '/') { res.writeHead(308, { Location: base }); res.end(); return; }
      if (!path.startsWith(base) || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
      const file = resolve(root, path.slice(base.length) || 'index.html');
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream';
      const bytes = await readFile(file); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch { res.writeHead(404); res.end(); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = await buildDemo(), server = createDemoPreview(demo.directory);
  server.listen(Number(process.env.DEMO_PORT || 3212), '127.0.0.1', () => console.log(`Демо: http://localhost:${server.address().port}`));
}
