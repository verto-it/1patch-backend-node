import { Injectable, Logger, OnApplicationBootstrap, ServiceUnavailableException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { Agent, fetch as undiciFetch } from 'undici';
import { EventQueueService } from '../queue/event-queue.service';
import { PackageCacheService } from '../packages/package-cache.service';
import { TaskStore } from '../tasks/task.store';
import { SignedEnvelope, TaskBundle } from '../types';

/**
 * Directory where the Vault-issued mTLS cert and key are persisted on this node.
 * The CA cert (used to verify the management server's own cert) is stored here too.
 */
const TLS_DIR = process.env.NODE_TLS_DIR ?? join(process.cwd(), 'tls');
const CERT_PATH = join(TLS_DIR, 'node.crt');
const KEY_PATH  = join(TLS_DIR, 'node.key');
const CA_PATH   = join(TLS_DIR, 'ca.crt');

@Injectable()
export class ManagementService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ManagementService.name);
  private flushInFlight = false;
  private flushAgain = false;

  /**
   * Undici dispatcher that presents our Vault-issued client cert on every
   * connection to the management server. Rebuilt whenever the cert is renewed.
   * Falls back to undefined (plain HTTPS, no client cert) if no cert is stored yet.
   */
  private mtlsAgent: Agent | undefined;

  constructor(
    private readonly queue: EventQueueService,
    private readonly tasks: TaskStore,
    private readonly packages: PackageCacheService,
  ) {}

  async onApplicationBootstrap() {
    const missing = ['NODE_ID', 'NODE_ENROLLMENT_TOKEN', 'MANAGEMENT_URL'].filter((k) => !process.env[k]);
    if (missing.length > 0) {
      this.logger.warn(`Backend node is not fully configured (missing: ${missing.join(', ')}). Restart in an interactive console to run setup.`);
      return;
    }

    if (!process.env.NODE_API_SECRET || process.env.NODE_API_SECRET.length < 32) {
      this.logger.error('NODE_API_SECRET is not set or is less than 32 characters — sync to management server will be rejected.');
      process.exit(1);
    }

    // Load any previously persisted mTLS cert so we use it from the first heartbeat
    await this.loadMtlsAgent();

    try {
      const result = await this.register();
      if (result.alreadyRegistered) {
        this.logger.log(`Management registration confirmed for existing nodeId=${result.nodeId}`);
      } else {
        this.logger.log(`Registered with management server as nodeId=${result.nodeId}`);
      }
    } catch (error) {
      this.logger.warn(`Management registration failed: ${error instanceof Error ? error.message : String(error)}`);
      const result = await this.heartbeat();
      if (result.accepted) this.logger.log(`Management heartbeat accepted for existing nodeId=${process.env.NODE_ID}`);
    }
  }

  async register() {
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!managementUrl) throw new ServiceUnavailableException('MANAGEMENT_URL is not configured');
    this.logger.log(`Registering node ${process.env.NODE_ID} with management server at ${managementUrl}`);

    const res = await this.managementFetch(`${managementUrl}/nodes/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-node-api-secret': process.env.NODE_API_SECRET ?? '',
      },
      body: JSON.stringify({
        nodeId: process.env.NODE_ID,
        enrollmentToken: process.env.NODE_ENROLLMENT_TOKEN,
        version: '0.1.0',
        capacity: { queue: await this.queue.size(), packageCache: 'local' },
      }),
    });

    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }

    if (!res.ok) {
      const message = typeof body.message === 'string' ? body.message : text;
      this.logger.error(`Management registration failed: HTTP ${res.status} — ${message}`);
      throw new ServiceUnavailableException(`Management registration failed: ${res.status} ${message}`);
    }

    // If the management server returned a Vault-issued mTLS cert, persist it and
    // rebuild the mTLS agent so all subsequent calls use it.
    const tls = body.tls as { certificate?: string; privateKey?: string; caCert?: string } | null | undefined;
    if (tls?.certificate && tls.privateKey && tls.caCert) {
      await this.persistCert(tls.certificate, tls.privateKey, tls.caCert);
      this.logger.log('mTLS certificate received from management server and persisted');
    }

    return body as { nodeId: string; accepted: boolean; alreadyRegistered?: boolean };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async heartbeat() {
    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) {
      this.logger.debug('Heartbeat skipped — NODE_ID or MANAGEMENT_URL not configured');
      return { accepted: false };
    }
    try {
      const res = await this.managementFetch(`${managementUrl}/nodes/heartbeat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-node-api-secret': process.env.NODE_API_SECRET ?? '',
        },
        body: JSON.stringify({
          nodeId,
          capacity: { queue: await this.queue.size(), packageCache: 'local' },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`heartbeat failed: HTTP ${res.status} — ${body}`);
      }
      return res.json();
    } catch (error) {
      this.logger.warn(`Management heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      return { accepted: false, error: String(error) };
    }
  }

  requestFlush() {
    void this.flushQueue();
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async flushQueue() {
    if (this.flushInFlight) { this.flushAgain = true; return { synced: 0, deferred: true }; }
    this.flushInFlight = true;
    try {
      let result: { synced: number; queued?: number; error?: string } = { synced: 0 };
      do { this.flushAgain = false; result = await this.flushQueueBatch(); } while (this.flushAgain);
      return result;
    } finally {
      this.flushInFlight = false;
    }
  }

  private async flushQueueBatch() {
    const events = await this.queue.drain();
    if (events.length === 0) { this.logger.debug('Event queue flush: nothing to sync'); return { synced: 0 }; }
    this.logger.log(`Flushing ${events.length} event(s) to management server`);
    try {
      const res = await this.managementFetch(`${process.env.MANAGEMENT_URL}/sync/node-events`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-node-api-secret': process.env.NODE_API_SECRET ?? '',
        },
        body: JSON.stringify({ nodeId: process.env.NODE_ID, events }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`sync failed: HTTP ${res.status} — ${body}`);
      }
      this.logger.log(`Successfully synced ${events.length} event(s) to management server`);
      return { synced: events.length };
    } catch (error) {
      this.logger.error(`Event sync failed — requeueing ${events.length} event(s): ${error instanceof Error ? error.message : String(error)}`);
      await this.queue.requeue(events);
      return { synced: 0, queued: await this.queue.size(), error: String(error) };
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async pullTasks() {
    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) { this.logger.debug('Task pull skipped — NODE_ID or MANAGEMENT_URL not configured'); return { pulled: 0 }; }
    this.logger.debug(`Pulling pending tasks for nodeId=${nodeId}`);
    try {
      const res = await this.managementFetch(`${managementUrl}/tasks/node/${nodeId}/pending`, {
        headers: { 'x-node-api-secret': process.env.NODE_API_SECRET ?? '' },
      });
      if (!res.ok) { const body = await res.text(); throw new Error(`task pull failed: HTTP ${res.status} — ${body}`); }
      const body = (await res.json()) as { tasks?: SignedEnvelope<TaskBundle>[] };
      const incoming = body.tasks ?? [];
      const tasks = incoming.flatMap((envelope) => envelope.payload.tasks ?? []);
      if (incoming.length === 0 || tasks.length === 0) { this.logger.debug('No pending tasks from management server'); return { pulled: 0 }; }
      this.logger.log(`Pulled ${tasks.length} signed task(s) from management server — caching packages without mutating signed payloads`);
      for (const task of tasks) {
        try { await this.packages.ensureCached(task); }
        catch (err) { this.logger.error(`Failed to cache package for taskId=${task.id}: ${err instanceof Error ? err.message : String(err)}`); }
      }
      const pulled = await this.tasks.addMany(incoming);
      this.logger.log(`${pulled} task(s) queued for device delivery`);
      return { pulled };
    } catch (error) {
      this.logger.error(`Task pull failed: ${error instanceof Error ? error.message : String(error)}`);
      return { pulled: 0, error: String(error) };
    }
  }

  // ── mTLS helpers ──────────────────────────────────────────────────────────

  /**
   * Wraps every outbound call to the management server.
   * When an mTLS agent is available (cert was issued by Vault) it is used as
   * the undici dispatcher, presenting our client certificate automatically.
   * Falls back to the global fetch (plain TLS, no client cert) before the first
   * cert is issued.
   */
  private managementFetch(url: string, init?: RequestInit): Promise<Response> {
    if (this.mtlsAgent) {
      // undici fetch accepts a `dispatcher` option that is not in the standard
      // RequestInit type — cast to any for the extra property only.
      return undiciFetch(url, { ...init, dispatcher: this.mtlsAgent } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
    }
    return fetch(url, init);
  }

  /** Reads cert/key/ca from disk and builds a fresh undici mTLS Agent. */
  private async loadMtlsAgent(): Promise<void> {
    if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH) || !existsSync(CA_PATH)) {
      this.logger.debug('No persisted mTLS cert found — using plain TLS until first registration');
      return;
    }
    try {
      const [cert, key, ca] = await Promise.all([
        readFile(CERT_PATH, 'utf8'),
        readFile(KEY_PATH,  'utf8'),
        readFile(CA_PATH,   'utf8'),
      ]);
      this.mtlsAgent = new Agent({
        connect: {
          cert,
          key,
          ca,
          // Only trust our internal CA — rejects any cert not signed by it
          rejectUnauthorized: true,
        },
      });
      this.logger.log('mTLS agent loaded from persisted certificate');
    } catch (err) {
      this.logger.warn(`Failed to load mTLS cert: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Persists a new Vault-issued cert to disk and rebuilds the mTLS agent. */
  private async persistCert(certificate: string, privateKey: string, caCert: string): Promise<void> {
    await mkdir(TLS_DIR, { recursive: true });
    await Promise.all([
      writeFile(CERT_PATH, certificate, { encoding: 'utf8', mode: 0o600 }),
      writeFile(KEY_PATH,  privateKey,  { encoding: 'utf8', mode: 0o600 }),
      writeFile(CA_PATH,   caCert,      { encoding: 'utf8', mode: 0o644 }),
    ]);
    // Rebuild the agent so the new cert is used immediately (old cert is now revoked)
    this.mtlsAgent = new Agent({
      connect: {
        cert: certificate,
        key:  privateKey,
        ca:   caCert,
        rejectUnauthorized: true,
      },
    });
    this.logger.log(`mTLS cert persisted to ${TLS_DIR} and agent rebuilt`);
  }
}
