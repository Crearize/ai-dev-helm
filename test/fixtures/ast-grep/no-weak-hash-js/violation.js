import crypto, { createHash, createHmac } from 'crypto';

// Violation 1: MD5 via a namespaced receiver
export function md5(value) {
  return crypto.createHash('md5').update(value).digest('hex');
}

// Violation 2: SHA-1 via a directly imported createHash
export function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

// Violation 3: uppercase algorithm name, double quotes
export function md5Upper(value) {
  return crypto.createHash("MD5").update(value).digest('hex');
}

// Violation 4: SHA-1 HMAC is just as broken
export function signSha1(value, key) {
  return createHmac('sha1', key).update(value).digest('hex');
}

// Violation 5: MD5 via the newer crypto.hash one-shot API
export function hashMd5(value) {
  return crypto.hash('md5', value);
}
