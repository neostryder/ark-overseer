import { URL } from 'node:url';
import { redact } from '../util/redact.js';

// Only the app's own files run. Outside sources are Google Fonts (its stylesheet and the font files it
// points to) and Steam's image servers, for map pictures.
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://*.steamstatic.com; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
};
function send(res, status, value) {
  if (res.writableEnded) return;
  for (const [key, val] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, val);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}
function httpError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}
async function bodyOf(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
    throw httpError(415, 'badJson', 'The request body must be JSON.');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) throw httpError(413, 'tooLarge', 'The request is too large.');
    chunks.push(chunk);
  }
  if (!length) throw httpError(415, 'badJson', 'The request body must be JSON.');
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw httpError(415, 'badJson', 'The request body must be JSON.');
  }
}
export function createRouter({ log = console.error } = {}) {
  const routes = [];
  function add(method, pattern, handler) {
    const keys = [];
    const expression = new RegExp(
      `^${pattern
        .split('/')
        .map((part) => {
          if (part.startsWith(':')) {
            keys.push(part.slice(1));
            return '([^/]+)';
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/')}/?$`,
    );
    routes.push({ method: method.toUpperCase(), expression, keys, handler });
  }
  async function handle(req, res, user = null) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const route = routes.find((item) => item.method === req.method && item.expression.test(pathname));
    if (!route) return false;
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
    try {
      const match = pathname.match(route.expression),
        params = {};
      route.keys.forEach((key, i) => {
        const decoded = decodeURIComponent(match[i + 1]);
        params[key] = /^\d+$/.test(decoded) ? Number(decoded) : decoded;
      });
      const result = await route.handler({
        req,
        res,
        params,
        query: Object.fromEntries(new URL(req.url, 'http://localhost').searchParams),
        body: await bodyOf(req),
        user,
      });
      if (!res.writableEnded && !res.headersSent && result !== undefined) send(res, 200, result);
    } catch (error) {
      if (error.status) {
        const payload = { error: error.message };
        for (const key of ['code', 'errors', 'conflicts', 'script', 'modId', 'map'])
          if (error[key] !== undefined) payload[key] = error[key];
        if (!res.headersSent) send(res, error.status, payload);
      } else {
        try {
          log(redact(error?.stack || String(error)));
        } catch {
          /* logging cannot prevent the response */
        }
        if (!res.headersSent)
          send(res, 500, { error: 'Something went wrong in ARK Overseer. The details are in its log.' });
      }
    }
    return true;
  }
  return { add, handle };
}
