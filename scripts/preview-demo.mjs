// Isolated UI verification: no changes to the real config/ or cache/.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createApp } from '../server.mjs';
import { saveImage, digest, writeJSON, defaults } from '../lib/storage.mjs';
const root = await mkdtemp(join(tmpdir(), 'kero-preview-'));
function crc32(buf) { let c = -1; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }
function chunk(type, data) { const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([size, name, data, crc]); }
function sample(n) {
  const width = 320, height = n % 2 ? 400 : 240, pixels = Buffer.alloc((width * 3 + 1) * height);
  const colors = [[189, 218, 144], [229, 167, 144], [160, 185, 217], [224, 208, 144]];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const circle = (x - 160) ** 2 + (y - height / 2) ** 2 < (70 + n * 2) ** 2;
    const stripe = (x + y + n * 20) % 95 < 14;
    const rgb = circle ? [41, 53, 39] : stripe ? [246, 243, 228] : colors[n % 4];
    const offset = y * (width * 3 + 1) + 1 + x * 3; rgb.forEach((v, i) => pixels[offset + i] = v);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const photos = {};
for (let n = 0; n < 12; n++) { const data = sample(n), id = `local_${digest(data)}`; photos[id] = { id, source: 'local', title: `Тестовый кадр ${n + 1}`, ...await saveImage(root, id, data) }; }
await writeJSON(join(root, 'cache/library.json'), { photos });
await writeJSON(join(root, 'config/settings.json'), defaults);
const app = await createApp(root);
app.listen(3211, '127.0.0.1', () => console.log('Isolated preview: http://localhost:3211'));
