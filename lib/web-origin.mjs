export function parsePublicOrigin(value) {
  if (!value) return null;
  let url; try { url = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN должен быть адресом сайта, например https://editor.example.com'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN должен содержать только протокол, домен и необязательный порт');
  return url.origin;
}

export function allowedRequest(req, port, publicOrigin) {
  const origins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  if (publicOrigin) origins.add(publicOrigin);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  return hosts.has(req.headers.host) && (!req.headers.origin || origins.has(req.headers.origin));
}
