import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class DragonflyService implements OnModuleDestroy {
  private readonly logger = new Logger(DragonflyService.name);
  private client?: Redis;
  private readonly url?: string;
  private lastError?: string;
  private lastWarningAt = 0;
  private hasEverConnected = false;
  private isConnected = false;

  /**
   * Creates a DragonflyService instance with its required collaborators.
   */
  constructor() {
    this.url = process.env.DRAGONFLY_URL;
    if (!this.url) {
      this.logger.warn('DRAGONFLY_URL is not configured; backend node queue will be unavailable');
      return;
    }
    this.client = this.createClient();
  }

  /**
   * Creates a client record.
   * @returns The result produced by the operation.
   */
  private createClient() {
    const client = new Redis(this.url!, {
      connectTimeout: 2000,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      /**
       * Handles the retry strategy operation for DragonflyService.
       */
      retryStrategy: () => null,
    });
    client.on('error', (error) => {
      this.lastError = error.message || 'Connection failed';
    });
    return client;
  }

  /**
   * Handles the lpush json operation for DragonflyService.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   */
  async lpushJson(key: string, value: unknown) {
    if (!this.client) return;
    if (!(await this.ensureConnected())) return;
    try {
      await this.client.lpush(key, JSON.stringify(value));
      this.lastError = undefined;
    } catch (error) {
      this.recordUnavailable(error);
    }
  }

  /**
   * Handles the rpop json operation for DragonflyService.
   *
   * @param key key supplied to the function.
   * @returns The result produced by the operation.
   */
  async rpopJson<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;
    if (!(await this.ensureConnected())) return undefined;
    try {
      const raw = await this.client.rpop(key);
      this.lastError = undefined;
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch (error) {
      this.recordUnavailable(error);
      return undefined;
    }
  }

  /**
   * Handles the llen operation for DragonflyService.
   *
   * @param key key supplied to the function.
   * @returns The result produced by the operation.
   */
  async llen(key: string) {
    if (!this.client) return 0;
    if (!(await this.ensureConnected())) return 0;
    try {
      const size = await this.client.llen(key);
      this.lastError = undefined;
      return size;
    } catch (error) {
      this.recordUnavailable(error);
      return 0;
    }
  }

  /**
   * Sets the json value.
   *
   * @param key key supplied to the function.
   * @param value Value to read, render, or store.
   */
  async setJson(key: string, value: unknown) {
    if (!this.client) return;
    if (!(await this.ensureConnected())) return;
    try {
      await this.client.set(key, JSON.stringify(value));
      this.lastError = undefined;
    } catch (error) {
      this.recordUnavailable(error);
    }
  }

  /**
   * Gets the json value.
   *
   * @param key key supplied to the function.
   * @returns The result produced by the operation.
   */
  async getJson<T>(key: string): Promise<T | undefined> {
    if (!this.client) return undefined;
    if (!(await this.ensureConnected())) return undefined;
    try {
      const raw = await this.client.get(key);
      this.lastError = undefined;
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch (error) {
      this.recordUnavailable(error);
      return undefined;
    }
  }

  /**
   * Handles the health operation for DragonflyService.
   * @returns The result produced by the operation.
   */
  async health() {
    const ready = await this.ensureConnected();
    return {
      configured: Boolean(this.url),
      ready,
      status: this.client?.status ?? 'unconfigured',
      lastError: this.lastError,
    };
  }

  /**
   * Handles the on module destroy operation for DragonflyService.
   */
  async onModuleDestroy() {
    if (this.client?.status === 'ready') await this.client.quit();
  }

  /**
   * Resolves connected configuration.
   * @returns The result produced by the operation.
   */
  private async ensureConnected() {
    if (!this.client) return false;
    if (this.client.status === 'ready') return true;
    if (this.client.status === 'end') this.client = this.createClient();
    if (this.client.status !== 'wait' && this.client.status !== 'end') return false;
    try {
      await this.client.connect();
      if (this.hasEverConnected && !this.isConnected) {
        this.logger.log(`Reconnected to Dragonfly at ${this.url}`);
      } else {
        this.logger.log(`Connected to Dragonfly at ${this.url}`);
      }
      this.hasEverConnected = true;
      this.isConnected = true;
      this.lastError = undefined;
      return true;
    } catch (error) {
      this.recordUnavailable(error);
      return false;
    }
  }

  /**
   * Handles the record unavailable operation for DragonflyService.
   *
   * @param error Error raised by the preceding operation.
   */
  private recordUnavailable(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.isConnected = false;
    const now = Date.now();
    if (now - this.lastWarningAt < 30000) return;
    this.lastWarningAt = now;
    this.logger.warn(`Dragonfly is not available yet: ${this.lastError}`);
  }
}
