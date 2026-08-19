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
