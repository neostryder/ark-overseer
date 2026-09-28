import fs from 'node:fs';
import path from 'node:path';
import { SECURITY_HEADERS } from './router.js';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
export async function serveStatic(publicDir, req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return false;
  }
  const root = path.resolve(publicDir),
    relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  res.statusCode = 200;
  res.setHeader('Content-Type', TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(target);
    stream.on('error', reject);
    res.on('finish', resolve);
    stream.pipe(res);
  });
  return true;
}
