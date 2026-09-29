import { createHash } from 'node:crypto';
import { z } from 'zod';

const namespaceSchema = z.string().uuid();

/**
 * RFC 9562 name-based (SHA-1) UUID, byte-for-byte identical to the `uuid`
 * package's `v5(name, namespace)`. Persisted message ids depend on it, so the
 * output must never change.
 */
export function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespaceSchema.parse(namespace).replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(nsBytes).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
