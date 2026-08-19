import crypto, { createHash } from 'crypto';

// Violation 1: MD5 via a namespaced receiver
export function md5(value: string): string {
  return crypto.createHash('md5').update(value).digest('hex');
}

// Violation 2: SHA-1 via a directly imported createHash
export function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

// Violation 3: uppercase algorithm name, double quotes
export function md5Upper(value: string): string {
  return crypto.createHash("MD5").update(value).digest('hex');
}
