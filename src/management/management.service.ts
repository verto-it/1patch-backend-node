import { Injectable, Logger, OnApplicationBootstrap, ServiceUnavailableException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { freemem, totalmem, release as osRelease } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { Agent, fetch as undiciFetch } from 'undici';
import { EventQueueService } from '../queue/event-queue.service';
import { PackageCacheService } from '../packages/package-cache.service';
import { TaskStore } from '../tasks/task.store';
import { NodeCapability, NodeHealthComponent, NodeHealthReport, NodeSecurityFinding, SignedEnvelope, TaskBundle } from '../types';
import { NodeSigningService } from '../node-signing.service';

/**
 * Directory where the Vault-issued mTLS cert and key are persisted on this node.
 * The CA cert (used to verify the management server certificate) is stored here too.
 */
const execAsync = promisify(exec);

const TLS_DIR = process.env.NODE_TLS_DIR ?? join(process.cwd(), 'tls');
const CERT_PATH = join(TLS_DIR, 'node.crt');
const KEY_PATH  = join(TLS_DIR, 'node.key');
const CA_PATH   = join(TLS_DIR, 'ca.crt');

/**
 * Renew the certificate this many milliseconds before it expires.
 * Default: 2 hours before expiry.
 */
const CERT_RENEW_BEFORE_EXPIRY_MS = 2 * 60 * 60_000;

@Injectable()
export class ManagementService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ManagementService.name);
  private flushInFlight = false;
  private flushAgain = false;

  /**
   * Undici dispatcher that presents our Vault-issued client cert on every
   * connection to the management server.  Rebuilt whenever the cert is renewed.
   * Falls back to undefined (plain HTTPS, no client cert) if no cert is stored yet.
   */
  private mtlsAgent: Agent | undefined;

  /**
   * CA-only undici dispatcher used before the node has received its mTLS cert.
   * Verifies the management server's TLS certificate against the Vault CA without
   * sending a client certificate — set when ca.crt exists but node.crt does not.
   */
  private caOnlyAgent: Agent | undefined;

  /** ISO timestamp of when the current cert expires — used by the renewal cron. */
  private certExpiresAt: string | undefined;

  
  /**
   * Creates a ManagementService instance with its required collaborators.
   *
   * @param queue queue supplied to the function.
   * @param tasks tasks supplied to the function.
   * @param packages packages supplied to the function.
   */
  constructor(
    private readonly queue: EventQueueService,
    private readonly tasks: TaskStore,
    private readonly packages: PackageCacheService,
    private readonly signing: NodeSigningService,
  ) {}

  /**
   * Handles the on application bootstrap operation for ManagementService.
   */
  async onApplicationBootstrap() {
    const missing = ['NODE_ID', 'NODE_ENROLLMENT_TOKEN', 'MANAGEMENT_URL'].filter((k) => !process.env[k]);
    if (missing.length > 0) {
      this.logger.warn(
        `Backend node is not fully configured (missing: ${missing.join(', ')}). ` +
        `Restart in an interactive console to run setup.`,
      );
      return;
    }

    if (process.env.NODE_ENV === 'production' && !existsSync(CERT_PATH)) {
      this.logger.warn(
        'No mTLS certificate found in ./tls/ — this node will not be able to authenticate ' +
        'to the management server until registration completes.',
      );
    }

    // Load any previously persisted mTLS cert so we use it from the first heartbeat
    await this.loadMtlsAgent();

    try {
      const result = await this.register();
      this.logger.log(`Registered with management server as nodeId=${result.nodeId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Management registration failed: ${message}`);

      // Fall back to heartbeat if this node was already registered. In local dev,
      // the management server may allow plain HTTP node calls via x-node-id.
      if (this.mtlsAgent || isDevPlainHttpNodeFallbackAllowed()) {
        const result = await this.heartbeat();
        if (result.accepted) {
          this.logger.log(`Management heartbeat accepted for existing nodeId=${process.env.NODE_ID}`);
        }
      } else if (message.includes('Enrollment token has already been used')) {
        this.logger.error(
          'Enrollment token has already been used and no persisted mTLS certificate was found. ' +
          'Re-enroll this backend node from the management server, update NODE_ENROLLMENT_TOKEN, and restart.',
        );
      }
    }
  }

  /**
   * Handles the register operation for ManagementService.
   * @returns The result produced by the operation.
   */
  async register() {
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!managementUrl) throw new ServiceUnavailableException('MANAGEMENT_URL is not configured');
    this.logger.log(`Registering node ${process.env.NODE_ID} with management server at ${managementUrl}`);

    // /nodes/register does not require a client cert — the enrollment token is the
    // sole credential. We still route through managementFetch so the CA cert (if
    // already saved from the enrollment JSON) is used to verify the server's TLS cert.
    const res = await this.managementFetch(`${managementUrl}/nodes/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: process.env.NODE_ID,
        enrollmentToken: process.env.NODE_ENROLLMENT_TOKEN,
        version: '0.1.0',
        capacity: { queue: await this.queue.size(), packageCache: 'local', capabilities: configuredCapabilities() },
        capabilities: configuredCapabilities(),
        signingPublicKeyPem: this.signing.publicKey(),
        publicUrl: process.env.NODE_PUBLIC_URL,
        region: process.env.NODE_REGION,
        site: process.env.NODE_SITE,
        updateChannel: process.env.NODE_UPDATE_CHANNEL ?? 'stable',
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

    // Persist the Vault-issued mTLS certificate so all subsequent calls use it.
    const tls = body.tls as {
      certificate?: string; privateKey?: string; caCert?: string; expiresAt?: string;
    } | null | undefined;
    if (tls?.certificate && tls.privateKey && tls.caCert) {
      await this.persistCert(tls.certificate, tls.privateKey, tls.caCert);
      if (tls.expiresAt) this.certExpiresAt = tls.expiresAt;
      this.logger.log(`mTLS certificate received and persisted (expires ${tls.expiresAt ?? 'unknown'})`);
    }

    // Persist the per-node decommission token hash so we can verify management
    // decommission calls later.
    const decommissionToken = typeof body.decommissionToken === 'string' ? body.decommissionToken : undefined;
    if (decommissionToken) {
      await this.persistDecommissionToken(decommissionToken);
      this.logger.log('Per-node decommission token stored');
    }

    return body as { nodeId: string; accepted: boolean };
  }

  /**
   * Handles the heartbeat operation for ManagementService.
   * @returns The result produced by the operation.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async heartbeat() {
    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) {
      this.logger.debug('Heartbeat skipped — NODE_ID or MANAGEMENT_URL not configured');
      return { accepted: false };
    }
    try {
      // Attempt the signed health report first. If it fails (e.g. no signing key
      // on record yet), fall through to the plain heartbeat which carries
      // signingPublicKeyPem so the management server can self-heal.
      try {
        const signed = await this.sendSignedHealthReport();
        if (signed.accepted) return signed;
      } catch (signedErr) {
        this.logger.debug(
          `Signed health report failed, falling back to plain heartbeat: ${signedErr instanceof Error ? signedErr.message : String(signedErr)}`,
        );
      }
        

      const res = await this.managementFetch(`${managementUrl}/nodes/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeId,
          capacity: { queue: await this.queue.size(), packageCache: 'local' },
          signingPublicKeyPem: this.signing.publicKey(),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`heartbeat failed: HTTP ${res.status} — ${body}`);
      }
      const result = (await res.json()) as { accepted: boolean; certExpiresAt?: string };
      // Management echoes back the cert expiry — keep it in sync
      if (result.certExpiresAt) this.certExpiresAt = result.certExpiresAt;
      return result;
    } catch (error) {
      this.logger.warn(`Management heartbeat failed: ${error instanceof Error ? error.message : String(error)}`);
      return { accepted: false, error: String(error) };
    }
  }

  async sendSignedHealthReport() {
    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) return { accepted: false };

    const challengeRes = await this.managementFetch(`${managementUrl}/nodes/challenge/node_health_report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    if (!challengeRes.ok) {
      const body = await challengeRes.text();
      throw new Error(`health challenge failed: HTTP ${challengeRes.status} - ${body}`);
    }
    const challenge = (await challengeRes.json()) as { nonce: string; serverTime: string; expiresAt: string };
    const report = await this.buildHealthReport(challenge.serverTime);
    const envelope = this.signing.signPayload('node_health_report', report, challenge.nonce);
    const res = await this.managementFetch(`${managementUrl}/nodes/health/signed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`signed health failed: HTTP ${res.status} - ${body}`);
    }
    const result = (await res.json()) as { accepted: boolean; certExpiresAt?: string };
    if (this.certExpiresAt) result.certExpiresAt = this.certExpiresAt;
    return result;
  }

  /**
   * Certificate renewal cron — runs every 30 minutes, renews when the cert
   * will expire within CERT_RENEW_BEFORE_EXPIRY_MS (default: 2 hours).
   * Uses the current (still-valid) mTLS cert to authenticate the renewal request.
   */
  @Cron('*/30 * * * *')
  async renewCertIfNeeded() {
    if (!this.certExpiresAt || !this.mtlsAgent) return;

    const expiresAt = new Date(this.certExpiresAt).getTime();
    if (!Number.isFinite(expiresAt)) return;

    const timeUntilExpiry = expiresAt - Date.now();
    if (timeUntilExpiry > CERT_RENEW_BEFORE_EXPIRY_MS) return;

    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) return;

    this.logger.log(
      `mTLS cert expires in ${Math.round(timeUntilExpiry / 60_000)} min — renewing now (nodeId=${nodeId})`,
    );

    try {
      const res = await this.managementFetch(`${managementUrl}/nodes/renew-cert`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`renew-cert failed: HTTP ${res.status} — ${body}`);
      }
      const body = (await res.json()) as {
        tls?: { certificate?: string; privateKey?: string; caCert?: string; expiresAt?: string };
      };
      const tls = body.tls;
      if (tls?.certificate && tls.privateKey && tls.caCert) {
        await this.persistCert(tls.certificate, tls.privateKey, tls.caCert);
        if (tls.expiresAt) this.certExpiresAt = tls.expiresAt;
        this.logger.log(`mTLS cert renewed successfully (expires ${tls.expiresAt ?? 'unknown'})`);
      }
    } catch (error) {
      this.logger.error(
        `mTLS cert renewal failed: ${error instanceof Error ? error.message : String(error)}. ` +
        `Will retry in 30 minutes.`,
      );
    }
  }

  /**
   * Handles the request flush operation for ManagementService.
   */
  requestFlush() {
    void this.flushQueue();
  }

  /**
   * Handles the flush queue operation for ManagementService.
   * @returns The result produced by the operation.
   */
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

  /**
   * Handles the flush queue batch operation for ManagementService.
   * @returns The result produced by the operation.
   */
  private async flushQueueBatch() {
    const events = await this.queue.drain();
    if (events.length === 0) { this.logger.debug('Event queue flush: nothing to sync'); return { synced: 0 }; }
    this.logger.log(`Flushing ${events.length} event(s) to management server`);
    try {
      const res = await this.managementFetch(`${process.env.MANAGEMENT_URL}/sync/node-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId: process.env.NODE_ID, events }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`sync failed: HTTP ${res.status} — ${body}`);
      }
      this.logger.log(`Successfully synced ${events.length} event(s) to management server`);
      return { synced: events.length };
    } catch (error) {
      this.logger.error(
        `Event sync failed — requeueing ${events.length} event(s): ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.queue.requeue(events);
      return { synced: 0, queued: await this.queue.size(), error: String(error) };
    }
  }

  async signedCacheAttestation(attestation: {
    packageArtifactId: string;
    sha256: string;
    verified: boolean;
    signatureValid?: boolean;
    sizeBytes?: number;
    expiresAt?: string;
    observedAt: string;
    reason?: string;
  }) {
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!managementUrl || !process.env.NODE_ID) return { accepted: false };
    const challengeRes = await this.managementFetch(`${managementUrl}/nodes/challenge/cache_artifact_attestation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    if (!challengeRes.ok) return { accepted: false };
    const challenge = (await challengeRes.json()) as { nonce: string };
    const envelope = this.signing.signPayload('cache_artifact_attestation', attestation, challenge.nonce);
    const res = await this.managementFetch(`${managementUrl}/nodes/cache/attestations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    return { accepted: res.ok };
  }

  /**
   * Handles the pull tasks operation for ManagementService.
   * @returns The result produced by the operation.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async pullTasks() {
    const nodeId = process.env.NODE_ID;
    const managementUrl = process.env.MANAGEMENT_URL;
    if (!nodeId || !managementUrl) {
      this.logger.debug('Task pull skipped — NODE_ID or MANAGEMENT_URL not configured');
      return { pulled: 0 };
    }
    this.logger.debug(`Pulling pending tasks for nodeId=${nodeId}`);
    try {
      const res = await this.managementFetch(`${managementUrl}/tasks/node/${nodeId}/pending`);
      if (!res.ok) { const body = await res.text(); throw new Error(`task pull failed: HTTP ${res.status} — ${body}`); }
      const body = (await res.json()) as { tasks?: SignedEnvelope<TaskBundle>[] };
      const incoming = body.tasks ?? [];
      const tasks = incoming.flatMap((envelope) => envelope.payload.tasks ?? []);
      if (incoming.length === 0 || tasks.length === 0) {
        this.logger.debug('No pending tasks from management server');
        return { pulled: 0 };
      }
      this.logger.log(`Pulled ${tasks.length} signed task(s) from management server`);
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
   * Wraps every outbound call to the management server with the mTLS agent
   * when a Vault-issued client certificate is available.
   * Falls back to plain fetch (no client cert) only before first registration.
   * NODE_API_SECRET / x-node-api-secret is never set on any request.
   */
  private managementFetch(url: string, init?: RequestInit): Promise<Response> {
    const requestInit = withNodeIdHeader(init);
    const dispatcher = this.mtlsAgent ?? this.caOnlyAgent;
    if (dispatcher) {
      return undiciFetch(
        url,
        { ...requestInit, dispatcher } as Parameters<typeof undiciFetch>[1],
      ) as unknown as Promise<Response>;
    }
    return fetch(url, requestInit);
  }

  private async buildHealthReport(serverTime?: string): Promise<NodeHealthReport> {
    const queueSize = await this.queue.size();
    const cacheStatus = this.packages.status();
    const now = new Date().toISOString();
    const memoryPressure = readMemoryPressure();
    const memoryPressurePercent = memoryPressure.pressurePercent;
    const clockSkewMs = serverTime ? Math.abs(Date.now() - Date.parse(serverTime)) : undefined;
    const components: NodeHealthComponent[] = [
      component('reachability', 'ok', now, 'node reached management over mTLS'),
      component('event_queue', queueSize > 1000 ? 'degraded' : 'ok', now, `queue=${queueSize}`, queueSize),
      component('database', 'ok', now, 'local node uses Dragonfly-backed queue'),
      component('certificate', certificateHealthyForCurrentMode(this.certExpiresAt) ? 'ok' : 'degraded', now, this.certExpiresAt ? `expires=${this.certExpiresAt}` : 'no mTLS cert'),
      component('scanner', cacheStatus.scannerHealthy ? 'ok' : 'degraded', now),
      component('disk', cacheStatus.diskFreeBytes && cacheStatus.diskFreeBytes < 1024 * 1024 * 1024 ? 'degraded' : 'ok', now, undefined, cacheStatus.diskFreeBytes),
      component('memory', memoryPressurePercent > 90 ? 'degraded' : 'ok', now, memoryPressure.message, memoryPressurePercent),
      component('clock', clockSkewMs && clockSkewMs > 60_000 ? 'degraded' : 'ok', now, undefined, clockSkewMs),
      component('update_source', 'ok', now),
      component('cache', cacheStatus.healthy ? 'ok' : 'degraded', now),
      component('package_verifier', 'ok', now),
    ];
    const securityFindings = shouldCollectOsSecurityFindings()
      ? await collectOsSecurityFindings().catch(() => [] as NodeSecurityFinding[])
      : [];

    return {
      nodeId: process.env.NODE_ID ?? '',
      reportedAt: now,
      managementUrl: process.env.MANAGEMENT_URL,
      publicUrl: process.env.NODE_PUBLIC_URL,
      version: '0.1.0',
      region: process.env.NODE_REGION,
      site: process.env.NODE_SITE,
      queueSize,
      queueLag: queueSize > 1000 ? 'high' : queueSize > 100 ? 'medium' : 'low',
      diskFreeBytes: cacheStatus.diskFreeBytes,
      memoryPressurePercent,
      clockSkewMs,
      certExpiresAt: this.certExpiresAt,
      scannerHealthy: cacheStatus.scannerHealthy,
      cacheHealthy: cacheStatus.healthy,
      packageVerifierHealthy: true,
      updateSourceReachable: true,
      components,
      capabilities: configuredCapabilities(),
      securityFindings,
      osInfo: { platform: process.platform, release: osRelease() },
    };
  }

  /** Reads cert/key/ca from disk and builds a fresh undici mTLS Agent. */
  private async loadMtlsAgent(): Promise<void> {
    const hasCa   = existsSync(CA_PATH);
    const hasCert = existsSync(CERT_PATH) && existsSync(KEY_PATH);

    if (!hasCa) {
      this.logger.debug('No persisted mTLS cert found — using plain TLS until first registration');
      return;
    }

    try {
      const ca = await readFile(CA_PATH, 'utf8');

      if (!hasCert) {
        // CA cert present but no client cert yet — verify server TLS without sending a client cert
        this.caOnlyAgent = new Agent({ connect: { ca, rejectUnauthorized: true } });
        this.logger.debug('CA cert found — server TLS verification enabled for initial registration');
        return;
      }

      const [cert, key] = await Promise.all([readFile(CERT_PATH, 'utf8'), readFile(KEY_PATH, 'utf8')]);
      this.mtlsAgent = new Agent({ connect: { cert, key, ca, rejectUnauthorized: true } });
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
    this.mtlsAgent = new Agent({ connect: { cert: certificate, key: privateKey, ca: caCert, rejectUnauthorized: true } });
    this.logger.log(`mTLS cert persisted to ${TLS_DIR} and agent rebuilt`);
  }

  /**
   * Persists a SHA-256 hash of the per-node decommission token to .env so it survives
   * restarts.  The token is unique per node — it is generated by the management
   * server at registration and only ever sent in one direction (management → node).
   */
  private async persistDecommissionToken(decommissionToken: string): Promise<void> {
    const KEY = 'NODE_DECOMMISSION_TOKEN_HASH';
    const tokenHash = createHash('sha256').update(decommissionToken).digest('hex');
    process.env[KEY] = tokenHash;

    const envPath = join(process.cwd(), '.env');
    const existing = await readFile(envPath, 'utf8').catch(() => '');

    if (existing.includes(`${KEY}=`)) {
      const updated = existing.replace(new RegExp(`^${KEY}=.*$`, 'm'), `${KEY}=${tokenHash}`);
      await writeFile(envPath, updated, 'utf8');
    } else {
      await writeFile(envPath, `${existing.trimEnd()}\n${KEY}=${tokenHash}\n`, 'utf8');
    }
  }
}

/**
 * Handles the with node id header operation.
 *
 * @param init init supplied to the function.
 * @returns The result produced by the operation.
 */
function withNodeIdHeader(init?: RequestInit): RequestInit | undefined {
  const nodeId = process.env.NODE_ID;
  if (!nodeId) return init;

  const headers = new Headers(init?.headers);
  if (!headers.has('x-node-id')) headers.set('x-node-id', nodeId);
  return { ...init, headers };
}

function isDevPlainHttpNodeFallbackAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.MTLS_DISABLED === 'true') return true;

  return !(process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH && process.env.TLS_CA_PATH);
}

function configuredCapabilities(): NodeCapability[] {
  const configured = (process.env.NODE_CAPABILITIES ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean) as NodeCapability[];
  if (configured.length > 0) return configured;
  const platformDefaults: NodeCapability[] = process.platform === 'win32'
    ? ['windows-patching', 'winget-cache', 'chocolatey-cache', 'regional-cache']
    : ['linux-patching', 'regional-cache'];
  if (process.env.YARA_PATH) platformDefaults.push('yara-scan');
  return platformDefaults;
}

function shouldCollectOsSecurityFindings() {
  if (process.env.NODE_COLLECT_OS_SECURITY_FINDINGS === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

type MemoryPressure = {
  pressurePercent: number;
  message: string;
};

type CgroupMemory = {
  currentBytes: number;
  maxBytes?: number;
};

function readMemoryPressure(): MemoryPressure {
  if (isContainerRuntime()) {
    const cgroup = readCgroupMemory();
    if (cgroup) return memoryPressureFromValues(cgroup.currentBytes, cgroup.maxBytes);
  }

  return memoryPressureFromValues(undefined, undefined, totalmem(), freemem());
}

export function memoryPressureFromValues(
  containerCurrentBytes?: number,
  containerMaxBytes?: number,
  hostTotalBytes = totalmem(),
  hostFreeBytes = freemem(),
): MemoryPressure {
  if (Number.isFinite(containerCurrentBytes) && (containerCurrentBytes ?? 0) >= 0) {
    let limitBytes = hostTotalBytes;
    if (typeof containerMaxBytes === 'number' && Number.isFinite(containerMaxBytes) && containerMaxBytes > 0) {
      limitBytes = containerMaxBytes;
    }
    return {
      pressurePercent: percentage(containerCurrentBytes ?? 0, limitBytes),
      message: `container memory ${formatBytes(containerCurrentBytes ?? 0)} / ${formatBytes(limitBytes)}`,
    };
  }

  const usedBytes = Math.max(0, hostTotalBytes - hostFreeBytes);
  return {
    pressurePercent: percentage(usedBytes, hostTotalBytes),
    message: `system memory ${formatBytes(usedBytes)} / ${formatBytes(hostTotalBytes)}`,
  };
}

function isContainerRuntime(): boolean {
  if (existsSync('/.dockerenv')) return true;
  const cgroup = readTextFile('/proc/1/cgroup');
  return /\b(docker|containerd|kubepods|podman)\b/i.test(cgroup);
}

function readCgroupMemory(): CgroupMemory | undefined {
  const currentV2 = readNumberFile('/sys/fs/cgroup/memory.current');
  if (currentV2 !== undefined) {
    return { currentBytes: currentV2, maxBytes: readLimitFile('/sys/fs/cgroup/memory.max') };
  }

  const currentV1 = readNumberFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (currentV1 !== undefined) {
    return { currentBytes: currentV1, maxBytes: readLimitFile('/sys/fs/cgroup/memory/memory.limit_in_bytes') };
  }

  return undefined;
}

function readNumberFile(path: string): number | undefined {
  const value = readTextFile(path).trim();
  if (!value || value === 'max') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readLimitFile(path: string): number | undefined {
  const limit = readNumberFile(path);
  if (!limit || limit >= Number.MAX_SAFE_INTEGER) return undefined;
  return limit;
}

function readTextFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function percentage(usedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((usedBytes / totalBytes) * 1000) / 10));
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

/** Run platform-specific OS security checks and return structured findings. */
async function collectOsSecurityFindings(): Promise<NodeSecurityFinding[]> {
  const findings: NodeSecurityFinding[] = [];
  if (process.platform === 'linux') {
    await checkLinux(findings);
  } else if (process.platform === 'win32') {
    await checkWindows(findings);
  }
  return findings;
}

async function run(cmd: string): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    return stdout.trim();
  } catch { return ''; }
}

async function checkLinux(findings: NodeSecurityFinding[]): Promise<void> {
  const sshConf = await run('sshd -T 2>/dev/null | grep -i permitrootlogin');
  if (sshConf && !/\bno\b/i.test(sshConf)) {
    findings.push({ code: 'SSH_ROOT_LOGIN_PERMITTED', severity: 'high', category: 'os_security',
      message: 'SSH PermitRootLogin is not set to "no"',
      remediationHint: 'Set PermitRootLogin no in /etc/ssh/sshd_config and restart sshd' });
  }
  const pwAuth = await run('sshd -T 2>/dev/null | grep -i passwordauthentication');
  if (pwAuth && /\byes\b/i.test(pwAuth)) {
    findings.push({ code: 'SSH_PASSWORD_AUTH_ENABLED', severity: 'medium', category: 'os_security',
      message: 'SSH PasswordAuthentication is enabled — key-only auth is recommended',
      remediationHint: 'Set PasswordAuthentication no in /etc/ssh/sshd_config' });
  }
  const ufw = await run('ufw status 2>/dev/null');
  const ipt = await run('iptables -L INPUT 2>/dev/null | head -3');
  if (!ufw.toLowerCase().includes('active') && ipt.split('\n').filter(l => l.trim() && !l.startsWith('Chain') && !l.startsWith('target')).length === 0) {
    findings.push({ code: 'NO_FIREWALL_DETECTED', severity: 'high', category: 'os_security',
      message: 'No active firewall (ufw/iptables) detected',
      remediationHint: 'Enable ufw: ufw enable && ufw default deny incoming' });
  }
  const unattended = await run('dpkg -l unattended-upgrades 2>/dev/null | grep ^ii');
  const dnfAuto = await run('systemctl is-active dnf-automatic 2>/dev/null');
  if (!unattended && dnfAuto !== 'active') {
    findings.push({ code: 'NO_AUTO_UPDATES', severity: 'medium', category: 'os_security',
      message: 'Automatic security updates not detected',
      remediationHint: 'Install unattended-upgrades (Debian/Ubuntu) or enable dnf-automatic (RHEL/Fedora)' });
  }
  const aa = await run('aa-status --json 2>/dev/null');
  const selinux = await run('getenforce 2>/dev/null');
  if (!aa.includes('"enabled":1') && selinux !== 'Enforcing') {
    findings.push({ code: 'NO_MAC_FRAMEWORK', severity: 'medium', category: 'os_security',
      message: 'Neither AppArmor (enforcing) nor SELinux (Enforcing) is active',
      remediationHint: 'Enable AppArmor or set SELinux to Enforcing mode' });
  }
  const passwdPerms = await run('stat -c %a /etc/passwd 2>/dev/null');
  if (isWorldWritableMode(passwdPerms)) {
    findings.push({ code: 'PASSWD_WORLD_WRITABLE', severity: 'critical', category: 'os_security',
      message: '/etc/passwd is world-writable',
      remediationHint: 'chmod 644 /etc/passwd' });
  }
}

export function isWorldWritableMode(mode: string): boolean {
  const permissions = mode.trim().match(/[0-7]+$/)?.[0];
  if (!permissions) return false;
  const worldDigit = Number.parseInt(permissions.at(-1) ?? '', 8);
  return Number.isFinite(worldDigit) && (worldDigit & 0o2) !== 0;
}

async function checkWindows(findings: NodeSecurityFinding[]): Promise<void> {
  const defender = await run('powershell -NonInteractive -Command "(Get-MpComputerStatus).RealTimeProtectionEnabled"');
  if (defender.trim().toLowerCase() === 'false') {
    findings.push({ code: 'DEFENDER_REALTIME_DISABLED', severity: 'high', category: 'os_security',
      message: 'Windows Defender real-time protection is disabled',
      remediationHint: 'Set-MpPreference -DisableRealtimeMonitoring $false' });
  }
  const fw = await run('powershell -NonInteractive -Command "(Get-NetFirewallProfile | Where-Object { $_.Enabled -ne $true }).Name"');
  if (fw.trim()) {
    findings.push({ code: 'WINDOWS_FIREWALL_PROFILE_DISABLED', severity: 'high', category: 'os_security',
      message: 'Windows Firewall disabled for profile(s): ' + fw.trim().replace(/\s+/g, ', '),
      remediationHint: 'Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True' });
  }
  const uac = await run('powershell -NonInteractive -Command "(Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System).EnableLUA"');
  if (uac.trim() === '0') {
    findings.push({ code: 'UAC_DISABLED', severity: 'high', category: 'os_security',
      message: 'User Account Control (UAC) is disabled',
      remediationHint: 'Re-enable UAC via secpol.msc or set EnableLUA=1 in the registry' });
  }
  const smbv1 = await run('powershell -NonInteractive -Command "(Get-SmbServerConfiguration).EnableSMB1Protocol"');
  if (smbv1.trim().toLowerCase() === 'true') {
    findings.push({ code: 'SMBV1_ENABLED', severity: 'high', category: 'os_security',
      message: 'SMBv1 is enabled — deprecated and exploitable (EternalBlue)',
      remediationHint: 'Set-SmbServerConfiguration -EnableSMB1Protocol $false' });
  }
  const rdp = await run('powershell -NonInteractive -Command "(Get-ItemProperty \"HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\").fDenyTSConnections"');
  if (rdp.trim() === '0') {
    findings.push({ code: 'RDP_ENABLED', severity: 'low', category: 'os_security',
      message: 'Remote Desktop (RDP) is enabled — ensure it is firewall-restricted',
      remediationHint: 'Disable RDP if not required via fDenyTSConnections=1 in the registry' });
  }
}


function component(
  name: NodeHealthComponent['name'],
  status: NodeHealthComponent['status'],
  observedAt: string,
  message?: string,
  value?: number | string | boolean,
): NodeHealthComponent {
  return { name, status, observedAt, message, value };
}

function certHealthy(expiresAt?: string) {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() > 60 * 60_000;
}

function certificateHealthyForCurrentMode(expiresAt?: string) {
  if (expiresAt) return certHealthy(expiresAt);
  return isDevPlainHttpNodeFallbackAllowed();
}
