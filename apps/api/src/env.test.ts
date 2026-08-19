import { describe, expect, it } from 'vitest';
import { loadEnv } from './env';

/** The minimum a real deployment must set; everything else has a defensible default. */
const REQUIRED = {
  MEILI_MASTER_KEY: 'master-key',
  SESSION_SECRET: 'a'.repeat(32),
};

describe('loadEnv', () => {
  it('fills in defaults for everything optional', () => {
    const env = loadEnv({ ...REQUIRED });
    expect(env.PORT).toBe(3000);
    expect(env.HOST).toBe('0.0.0.0');
    expect(env.MEILI_HOST).toBe('http://localhost:7700');
    expect(env.CACHE_DIR).toBe('.cache');
    expect(env.LOG_LEVEL).toBe('info');
    // Defaults closed: enabling trust in the proxy is an explicit opt-in, never ambient.
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('coerces PORT from the string the environment always gives it', () => {
    expect(loadEnv({ ...REQUIRED, PORT: '8080' }).PORT).toBe(8080);
  });

  it('parses TRUST_PROXY=true, unlike z.coerce.boolean() which would also accept "false"', () => {
    expect(loadEnv({ ...REQUIRED, TRUST_PROXY: 'true' }).TRUST_PROXY).toBe(true);
    expect(loadEnv({ ...REQUIRED, TRUST_PROXY: 'false' }).TRUST_PROXY).toBe(false);
    expect(loadEnv({ ...REQUIRED, TRUST_PROXY: 'nonsense' }).TRUST_PROXY).toBe(false);
  });

  it('names the offending variable when one is missing', () => {
    // A server that boots with half a configuration fails later, in a request, at 3am.
    expect(() => loadEnv({ SESSION_SECRET: 'a'.repeat(32) })).toThrow(/MEILI_MASTER_KEY/);
  });

  it('rejects a session secret too short to sign a cookie with', () => {
    expect(() => loadEnv({ ...REQUIRED, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects a malformed MEILI_HOST rather than failing on first query', () => {
    expect(() => loadEnv({ ...REQUIRED, MEILI_HOST: 'not-a-url' })).toThrow(/MEILI_HOST/);
  });
});
