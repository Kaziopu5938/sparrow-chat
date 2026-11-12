import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function initSecret(dataDir, override) {
  if (override) return override;
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function visitorToken(secret, propertyId, sessionKey) {
  return createHmac('sha256', secret).update(`visitor:${propertyId}:${sessionKey}`).digest('base64url');
}

export function verifyVisitorToken(secret, propertyId, sessionKey, token) {
  if (!propertyId || !sessionKey || !token) return false;
  const expected = visitorToken(secret, propertyId, sessionKey);
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
