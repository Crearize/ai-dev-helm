// Violation 1: hardcoded database host address
export const DB_HOST = '10.0.3.42';

// Violation 2: hardcoded upstream service address
export const UPSTREAM = "192.168.10.7";

// Violation 3: hardcoded public resolver address in a config object
export const resolverConfig = {
  primary: '8.8.8.8',
  timeoutMs: 2000,
};
