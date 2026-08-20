// Violation 1: hardcoded private-range database host address
export const DB_HOST = '10.0.3.42';

// Violation 2: hardcoded private-range upstream service address
export const UPSTREAM = '192.168.10.7';

// Violation 3: public IPv4 host baked into a URL
export const METRICS_URL = 'http://8.8.8.8:9090/metrics';

// Violation 4: credential DSN with a hardcoded private-range host
export const DATABASE_DSN = 'postgres://user:pass@10.0.0.1/db';
