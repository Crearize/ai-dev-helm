import crypto, { createHash, createHmac } from 'crypto';

// OK: SHA-256 is a current, acceptable digest
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// OK: near-miss - sha512 contains neither "md5" nor a bare "sha1"
export function sha512(value: string): string {
  return createHash('sha512').update(value).digest('hex');
}

// OK: near-miss - the algorithm name appears only as data, not as a call
export const legacyAlgorithms = ['md5', 'sha1'];

// OK: near-miss - HMAC with a modern digest
export function sign(value: string, key: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}
