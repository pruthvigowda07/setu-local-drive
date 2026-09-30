import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';

export const CHUNK = 4 * 1024 * 1024;
export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
export function safePath(value) {
  if (typeof value !== 'string' || value.length > 700) fail(400, 'Invalid file path.');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.length > 20 || parts.some(p => !p || p === '.' || p === '..' || p.length > 180 || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) fail(400, 'This file name or folder path is not supported.');
  return parts.join('/');
}
export function inside(root, relative) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) fail(400, 'Invalid destination path.');
  return target;
}
export function seal(value, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function unseal(value, key) {
  const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}
export async function body(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) fail(413, 'Request exceeds the size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function jsonBody(req) {
  try { return JSON.parse((await body(req)).toString()); }
  catch (e) { if (e.status) throw e; fail(400, 'Invalid JSON.'); }
}
