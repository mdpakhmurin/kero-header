import { readFile, writeFile, mkdir, readdir, copyFile, rm, lstat } from 'node:fs/promises';
import { dirname, join, resolve, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export async function buildDemo({ outputRoot = join(projectRoot, 'dist'), outputDir = join(outputRoot, 'demo') } = {}) {
  const root = resolve(outputRoot), target = resolve(outputDir), source = join(projectRoot, 'public');
  if (!target.startsWith(root + sep) || relative(root, target).includes(sep)) throw new Error('Demo output must be a direct child of its output directory');
  for (const path of [root, target]) {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error('Demo output cannot be a symbolic link');
  }
  await mkdir(root, { recursive: true }); await rm(target, { recursive: true, force: true }); await mkdir(target);
  const files = new Set(['app.js', 'style.css']);
  async function collect(file) {
    if (!resolve(source, file).startsWith(resolve(source) + sep)) throw new Error('Demo imports must stay within public');
    const text = await readFile(join(source, file), 'utf8');
    for (const match of text.matchAll(/\bfrom\s+['"]\.\/([^'"]+\.js)['"]/g)) if (!files.has(match[1])) { files.add(match[1]); await collect(match[1]); }
  }
  await collect('app.js');
  async function assets(directory = 'assets') {
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await assets(file);
      else if (entry.isFile() && /\.(svg|png|jpe?g|webp|ico)$/i.test(entry.name)) files.add(file);
    }
  }
  await assets();
  for (const file of files) { await mkdir(dirname(join(target, file)), { recursive: true }); await copyFile(join(source, file), join(target, file)); }
  let html = await readFile(join(source, 'index.html'), 'utf8');
  html = html.replace('<html lang="ru">', '<html lang="ru" data-demo-only="true">');
  if (!html.includes('data-demo-only="true"')) throw new Error('Could not force demo-only mode');
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
  html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
  html = html.replace(/\b(href|src)="\/(?!\/)/g, '$1="./');
  html = html.replace(/<button\b[^>]*data-mode-choice="local"[^>]*>[^<]*<\/button>/, '<button type="button" data-mode-choice="local" hidden aria-hidden="true" tabindex="-1"></button>');
  html = html.replace('id="demo-badge" class="demo-badge" hidden', 'id="demo-badge" class="demo-badge"');
  await writeFile(join(target, 'index.html'), html);
  await writeFile(join(target, '.nojekyll'), '');
  return { directory: target, files: [...files, 'index.html', '.nojekyll'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDemo(); console.log(`Демо-сборка: ${result.directory}`);
}
