import { Injectable } from '@nestjs/common';
import { v4 as uuid } from 'uuid';
import { DragonflyService } from '../storage/dragonfly.service';
import { QueueEvent } from '../types';

@Injectable()
export class EventQueueService {
  private readonly key = '1patch:backend-node:events';

  /**
   * Creates a EventQueueService instance with its required collaborators.
   *
   * @param dragonfly dragonfly supplied to the function.
   */
  constructor(private readonly dragonfly: DragonflyService) {}

  /**
   * Manages enqueue queue entries.
   *
   * @param type type supplied to the function.
   * @param payload Request payload or data transfer object.
   * @returns The result produced by the operation.
   */
  async enqueue(type: QueueEvent['type'], payload: unknown) {
    const event = { id: uuid(), type, payload, createdAt: new Date().toISOString() };
    await this.dragonfly.lpushJson(this.key, event);
    return event;
  }

  /**
   * Manages drain queue entries.
   *
   * @param max max supplied to the function.
   * @returns The result produced by the operation.
   */
  async drain(max = 100) {
    const events: QueueEvent[] = [];
    for (let index = 0; index < max; index += 1) {
      const event = await this.dragonfly.rpopJson<QueueEvent>(this.key);
      if (!event) break;
      events.push(event);
    }
    return events;
  }

  /**
   * Manages requeue queue entries.
   *
   * @param events events supplied to the function.
   */
  async requeue(events: QueueEvent[]) {
    for (const event of events.reverse()) {
      await this.dragonfly.lpushJson(this.key, event);
    }
  }

  /**
   * Handles the size operation for EventQueueService.
   * @returns The result produced by the operation.
   */
  async size() {
    return this.dragonfly.llen(this.key);
  }
}
