import https from 'https';

// Violation 1: TLS verification disabled on a shared agent
export const insecureAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
});

// Violation 2: TLS verification disabled inline in request options
export const requestOptions = {
  host: 'api.example.com',
  port: 443,
  rejectUnauthorized: false,
};

// Violation 3: nested inside a client configuration object
export const clientConfig = {
  timeoutMs: 5000,
  tls: { rejectUnauthorized: false },
};

// Violation 4: quoted key still disables verification
export const quotedOptions = {
  'rejectUnauthorized': false,
};

// Violation 5: computed key still disables verification
export const computedOptions = {
  ['rejectUnauthorized']: false,
};

// Violation 6: numeric 0 is falsy and disables verification
export const numericOptions = {
  rejectUnauthorized: 0,
};

// Violation 7: process-wide environment override
export function disableGlobally() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
