import fs from 'fs';
import https from 'https';

// OK: verification stays on and a private CA is trusted explicitly
export const secureAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: true,
  ca: fs.readFileSync('/etc/ssl/corp-ca.pem'),
});

// OK: near-miss - a different option set to false
export const requestOptions = {
  host: 'api.example.com',
  followRedirects: false,
  rejectUnauthorized: true,
};

// OK: near-miss - the identifier appears as a type field, not as a false value
export interface TlsOptions {
  rejectUnauthorized: boolean;
}

// OK: near-miss - the option name appears only as a string in an array
export const documentedOptions = ['rejectUnauthorized', 'ca'];

// OK: near-miss - the env var is set to a non-disabling value
export function enableGlobally(): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
}
