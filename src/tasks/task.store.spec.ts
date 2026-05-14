import { TaskStore } from './task.store';
import { SignedEnvelope, TaskBundle } from '../types';
import { computePayloadHash } from '../node-signing.service';

class FakeDragonfly {
  items: unknown[] = [];
  /**
   * Handles the lpush json operation for FakeDragonfly.
   *
   * @param _key key supplied to the function.
   * @param value Value to read, render, or store.
   */
  async lpushJson(_key: string, value: unknown) { this.items.unshift(value); }
  /**
   * Handles the rpop json operation for FakeDragonfly.
   *
   * @param _key key supplied to the function.
   * @returns The result produced by the operation.
   */
  async rpopJson<T>(_key: string) { return this.items.pop() as T | undefined; }
  /**
   * Handles the llen operation for FakeDragonfly.
   * @returns The result produced by the operation.
   */
  async llen() { return this.items.length; }
}

/**
 * Handles the envelope operation.
 *
 * @param deviceId Identifier used to locate the target record.
 */
const envelope = (deviceId: string): SignedEnvelope<TaskBundle> => {
  const payload: TaskBundle = {
    tasks: [{ id: `task-${deviceId}`, deviceId, type: 'refresh_inventory', targetVersion: 'latest', createdAt: '2026-05-03T00:00:00.000Z' }],
    ledgerEntry: {
      ledgerId: `ledger-${deviceId}`,
      taskId: `task-${deviceId}`,
      tenantId: 'default',
      createdBy: 'user-1',
      createdAt: '2026-05-03T00:00:00.000Z',
      visibleInDashboard: true,
      taskHash: 'hash',
      riskScore: 0,
      notBefore: '2026-05-03T00:00:00.000Z',
      expiresAt: '2026-05-03T00:10:00.000Z',
      algorithm: 'ES256',
      scope: 'task_ledger',
      issuedAt: '2026-05-03T00:00:00.000Z',
      nonce: `ledger-${deviceId}`,
      payloadHash: 'ledger-hash',
      keyId: 'main',
      signature: 'ledger-signature',
      state: 'active',
    },
  };
  return {
    algorithm: 'ES256',
    keyId: 'main',
    scope: 'task_bundle',
    payloadType: 'task_bundle',
    tenantId: 'default',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    nonce: deviceId,
    payloadHash: computePayloadHash(payload),
    payload,
    signature: 'signature',
  };
};

describe('TaskStore signed relay', () => {
  it('stores and returns signed envelopes unchanged for the matching device', async () => {
    const dragonfly = new FakeDragonfly();
    const store = new TaskStore(dragonfly as never);
    const signed = envelope('device-1');
    await store.addMany([signed, envelope('device-2')]);

    await expect(store.nextForDevice('device-1')).resolves.toEqual([signed]);
  });
});
