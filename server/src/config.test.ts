jest.mock('dotenv', () => ({ config: jest.fn() }));

const BASE = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 's', PROMETHEUS_TOKEN: 't' };

// Importing config.ts runs loadConfig(process.env), so give it a valid environment first.
process.env = { ...process.env, ...BASE, NODE_ENV: 'test' };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadConfig } = require('./config') as typeof import('./config');

const prod = (extra: Record<string, string> = {}) =>
  loadConfig({ ...BASE, NODE_ENV: 'production', APP_ORIGIN: 'https://example.com', ...extra });

describe('loadConfig: TRUST_PROXY_HOPS', () => {
  it('defaults to 1 in production and 0 elsewhere', () => {
    expect(prod().trustProxyHops).toBe(1);
    expect(loadConfig({ ...BASE, NODE_ENV: 'development' }).trustProxyHops).toBe(0);
  });

  it.each(['', '   '])('treats %j as unset', (value) => {
    expect(prod({ TRUST_PROXY_HOPS: value }).trustProxyHops).toBe(1);
  });

  it('uses an explicit value, including 0', () => {
    expect(prod({ TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    expect(prod({ TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
  });

  it.each(['-1', '1.5', 'abc'])('rejects %j', (value) => {
    expect(() => prod({ TRUST_PROXY_HOPS: value })).toThrow(/TRUST_PROXY_HOPS/);
  });
});
