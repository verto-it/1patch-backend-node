import { TaskStore } from './task.store';
import { SignedEnvelope, TaskBundle } from '../types';

class FakeDragonfly {
  items: unknown[] = [];
  async lpushJson(_key: string, value: unknown) { this.items.unshift(value); }
  async rpopJson<T>(_key: string) { return this.items.pop() as T | undefined; }
  async llen() { return this.items.length; }
}

const envelope = (deviceId: string): SignedEnvelope<TaskBundle> => ({
  algorithm: 'ES256',
  keyId: 'main',
  payloadType: 'task_bundle',
  tenantId: 'default',
  issuedAt: '2026-05-03T00:00:00.000Z',
  expiresAt: '2026-05-03T00:10:00.000Z',
  nonce: deviceId,
  payload: {
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
      keyId: 'main',
      signature: 'ledger-signature',
      state: 'active',
    },
  },
  signature: 'signature',
});

describe('TaskStore signed relay', () => {
  it('stores and returns signed envelopes unchanged for the matching device', async () => {
    const dragonfly = new FakeDragonfly();
    const store = new TaskStore(dragonfly as never);
    const signed = envelope('device-1');
    await store.addMany([signed, envelope('device-2')]);

    await expect(store.nextForDevice('device-1')).resolves.toEqual([signed]);
  });
});
