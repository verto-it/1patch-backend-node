import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventQueueService } from '../queue/event-queue.service';
import { PackageCacheService } from '../packages/package-cache.service';
import { TaskStore } from '../tasks/task.store';
import { AgentTask } from '../types';

@Injectable()
export class ManagementService {
  constructor(
    private readonly queue: EventQueueService,
    private readonly tasks: TaskStore,
    private readonly packages: PackageCacheService,
  ) {}

  async register() {
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!managementUrl) throw new ServiceUnavailableException('MANAGEMENT_URL is not configured');
    const res = await fetch(`${managementUrl}/nodes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: process.env.NODE_ID,
        enrollmentToken: process.env.NODE_ENROLLMENT_TOKEN,
        version: '0.1.0',
        capacity: { queue: await this.queue.size(), packageCache: 'local' },
      }),
    });
    if (!res.ok) throw new ServiceUnavailableException(`Management registration failed: ${res.status}`);
    return res.json();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async flushQueue() {
    const events = await this.queue.drain();
    if (events.length === 0) return { synced: 0 };
    try {
      const res = await fetch(`${process.env.MANAGEMENT_URL}/sync/node-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: process.env.NODE_ID, events }),
      });
      if (!res.ok) throw new Error(`sync failed: ${res.status}`);
      return { synced: events.length };
    } catch (error) {
      await this.queue.requeue(events);
      return { synced: 0, queued: await this.queue.size(), error: String(error) };
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async pullTasks() {
    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) return { pulled: 0 };
    try {
      const res = await fetch(`${managementUrl}/tasks/node/${nodeId}/pending`);
      if (!res.ok) throw new Error(`task pull failed: ${res.status}`);
      const body = (await res.json()) as { tasks: AgentTask[] };
      const cachedTasks: AgentTask[] = [];
      for (const task of body.tasks ?? []) {
        cachedTasks.push(await this.packages.ensureCached(task));
      }
      return { pulled: await this.tasks.addMany(cachedTasks) };
    } catch (error) {
      return { pulled: 0, error: String(error) };
    }
  }
}
