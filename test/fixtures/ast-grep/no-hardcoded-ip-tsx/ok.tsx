// OK: the address comes from configuration
export const DB_HOST = process.env.DB_HOST ?? 'localhost';

// OK: loopback is not environment-specific and is not a private-range host
export const LOCAL_DEV_HOST = '127.0.0.1';

// OK: wildcard bind address is not environment-specific
export const BIND_ADDRESS = '0.0.0.0';

// OK: broadcast address is not environment-specific
export const BROADCAST = '255.255.255.255';

// OK: near-miss - a four-part version string, NOT a private IP and no URL
export const APP_VERSION = '1.2.3.4';

// OK: near-miss - a semantic version, not an IPv4 address
export const SCHEMA_VERSION = '10.0.3';

// OK: near-miss - four dotted parts but out of octet range
export const BUILD_ID = '2024.10.300.1';

// OK: near-miss - an address embedded in prose, not the whole literal
export const HELP_TEXT = 'Set DB_HOST, for example 10.0.3.42, before starting.';

// OK: a hostname rather than a literal address
export const UPSTREAM = 'upstream.internal.example.com';
