import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class DragonflyService implements OnModuleDestroy {
  private readonly logger = new Logger(DragonflyService.name);
  private readonly client?: Redis;

  constructor() {
    const url = process.env.DRAGONFLY_URL;
    if (!url) {
      this.logger.warn('DRAGONFLY_URL is not configured; backend node queue will be unavailable');
      return;
    }
    this.client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.client.on('error', (error) => this.logger.warn(`Dragonfly connection issue: ${error.message}`));
  }

  async lpushJson(key: string, value: unknown) {
    if (!this.client) return;
    await this.ensureConnected();
    await this.client.lpush(key, JSON.stringify(value));
  }

  async rpopJson<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;
    await this.ensureConnected();
    const raw = await this.client.rpop(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async llen(key: string) {
    if (!this.client) return 0;
    await this.ensureConnected();
    return this.client.llen(key);
  }

  async setJson(key: string, value: unknown) {
    if (!this.client) return;
    await this.ensureConnected();
    await this.client.set(key, JSON.stringify(value));
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;
    await this.ensureConnected();
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async onModuleDestroy() {
    await this.client?.quit();
  }

  private async ensureConnected() {
    if (this.client?.status === 'wait') await this.client.connect();
  }
}
