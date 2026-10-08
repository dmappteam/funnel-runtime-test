import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './args';

describe('parseCliArgs', () => {
  it('uses the documented defaults', () => {
    expect(parseCliArgs([], {}, '/repo/configs')).toEqual({
      url: 'http://localhost:3000',
      sessions: 120,
      seed: 42,
      concurrency: 8,
      scenario: 'generate',
      admin: undefined,
      configsDir: '/repo/configs',
      report: undefined,
      verify: true,
      help: false,
    });
  });

  it('reads flags and falls back to ADMIN_USER and ADMIN_PASSWORD, with the user admin by default', () => {
    const argv = ['--scenario', 'demo', '--sessions', '200', '--seed=-3', '--no-verify', '--url', 'http://x:1/', '--report', 'r.json'];
    expect(parseCliArgs(argv, { ADMIN_PASSWORD: 'pw' }, '/c')).toMatchObject({
      scenario: 'demo',
      sessions: 200,
      seed: -3,
      verify: false,
      url: 'http://x:1',
      report: 'r.json',
      admin: { user: 'admin', password: 'pw' },
    });
    const flags = ['--admin-user', 'ops', '--admin-password', 'x'];
    expect(parseCliArgs(flags, { ADMIN_USER: 'env', ADMIN_PASSWORD: 'env' }, '/c').admin).toEqual({ user: 'ops', password: 'x' });
    expect(parseCliArgs(['-h'], {}, '/c').help).toBe(true);
  });

  it('rejects bad values with a readable message', () => {
    expect(() => parseCliArgs(['--sessions', '0'], {}, '/c')).toThrow('--sessions must be an integer of at least 1, got "0"');
    expect(() => parseCliArgs(['--concurrency', '2.5'], {}, '/c')).toThrow('--concurrency must be an integer');
    expect(() => parseCliArgs(['--scenario', 'chaos'], {}, '/c')).toThrow('--scenario must be one of generate, demo, iteration2');
    expect(() => parseCliArgs(['--sesions', '5'], {}, '/c')).toThrow();
  });
});
