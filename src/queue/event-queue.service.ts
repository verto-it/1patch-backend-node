import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DragonflyService } from '../storage/dragonfly.service';
import { QueueEvent } from '../types';

@Injectable()
export class EventQueueService {
  private readonly key = '1patch:backend-node:events';

  constructor(private readonly dragonfly: DragonflyService) {}

  async enqueue(type: QueueEvent['type'], payload: unknown) {
    const event = { id: uuid(), type, payload, createdAt: new Date().toISOString() };
    await this.dragonfly.lpushJson(this.key, event);
    return event;
  }

  async drain(max = 100) {
    const events: QueueEvent[] = [];
    for (let index = 0; index < max; index += 1) {
      const event = await this.dragonfly.rpopJson<QueueEvent>(this.key);
      if (!event) break;
      events.push(event);
    }
    return events;
  }

  async requeue(events: QueueEvent[]) {
    for (const event of events.reverse()) {
      await this.dragonfly.lpushJson(this.key, event);
    }
  }

  async size() {
    return this.dragonfly.llen(this.key);
  }
}
