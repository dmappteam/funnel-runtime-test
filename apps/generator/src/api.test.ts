import { describe, expect, it } from 'vitest';
import { ApiClient, FUNNEL_ID, UnconfirmedError } from './api';
import { FakeServer, type Fault } from './fakeServer';
import { ADMIN, rawConfig } from './testing';

/** v1, v2 and v3 are published, so one rollback activates v2 and a second one v1. The first rollback request gets `fault`. */
function rollbackWith(fault: Fault) {
  let rollbacks = 0;
  const server = new FakeServer({
    configs: [rawConfig(1), rawConfig(2), rawConfig(3)],
    admin: ADMIN,
    fault: (req) => (req.path.endsWith('/rollback') && rollbacks++ === 0 ? fault : null),
  });
  const api = new ApiClient(server, { admin: ADMIN, sleep: async () => {} });
  return { server, result: api.rollback(FUNNEL_ID), sent: () => rollbacks };
}

describe('rollback', () => {
  it('is sent once, and the release log confirms it when the answer is lost', async () => {
    const { server, result, sent } = rollbackWith('lost');
    await expect(result).resolves.toEqual({ activeVersion: 2, rolledBackFrom: 3 });
    expect(server.activeVersion).toBe(2);
    expect(sent()).toBe(1);
  });

  it.each(['network', 503] as const)('fails without a re-send when it was not applied (%s)', async (fault) => {
    const { server, result, sent } = rollbackWith(fault);
    await expect(result).rejects.toThrow(UnconfirmedError);
    await expect(result).rejects.toThrow('The release log shows it was not applied. It was not re-sent');
    expect(server.activeVersion).toBe(3);
    expect(sent()).toBe(1);
  });
});
