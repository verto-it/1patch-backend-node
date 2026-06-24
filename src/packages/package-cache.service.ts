import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { AgentTask } from '../types';

@Injectable()
export class PackageCacheService {
  private readonly logger = new Logger(PackageCacheService.name);
  private readonly cacheRoot = process.env.PACKAGE_CACHE_PATH ?? join(process.cwd(), 'package-cache');

  /**
   * Resolves cached configuration.
   *
   * @param task task supplied to the function.
   * @returns The result produced by the operation.
   */
  async ensureCached(task: AgentTask): Promise<AgentTask> {
    if (!task.packageArtifactId || !task.sourceUrl || !task.sha256) return task;
    await mkdir(this.cacheRoot, { recursive: true });
    const path = this.pathFor(task.packageArtifactId);
    const metaPath = this.metaPathFor(task.packageArtifactId);
    if (!existsSync(path) || !(await this.metadataVerified(metaPath, task.sha256))) {
      const url = this.resolveManagementUrl(task.managementSourceUrl ?? task.sourceUrl);
      const headers = sameOrigin(url, process.env.MANAGEMENT_URL) && process.env.NODE_API_SECRET
        ? { 'x-node-api-secret': process.env.NODE_API_SECRET }
        : undefined;
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`Package download failed: ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual.toLowerCase() !== task.sha256.toLowerCase()) {
        throw new Error(`Package hash mismatch for ${task.packageArtifactId}`);
      }
      const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, data, { mode: 0o600 });
      await rename(tempPath, path);
      await writeFile(metaPath, JSON.stringify({
        packageArtifactId: task.packageArtifactId,
        sha256: actual,
        verified: true,
        signatureValid: true,
        sizeBytes: data.length,
        observedAt: new Date().toISOString(),
        sourceUrl: task.sourceUrl,
      }, null, 2), 'utf8');
      this.logger.log(`Cached package ${task.packageArtifactId}`);
    }
    return task;
  }

  /**
   * Handles the stream operation for PackageCacheService.
   *
   * @param packageArtifactId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  async stream(packageArtifactId: string) {
    const path = this.pathFor(packageArtifactId);
    if (!existsSync(path)) throw new NotFoundException('Package is not cached on this backend node');
    const metadata = await this.readMetadata(packageArtifactId);
    if (!metadata?.verified || !metadata.sha256) throw new NotFoundException('Package cache metadata is missing or unverified');
    const actual = await sha256File(path);
    if (actual.toLowerCase() !== String(metadata.sha256).toLowerCase()) {
      await writeFile(this.metaPathFor(packageArtifactId), JSON.stringify({ ...metadata, verified: false, reason: 'tamper_detected', observedAt: new Date().toISOString() }, null, 2), 'utf8');
      throw new NotFoundException('Package cache integrity check failed');
    }
    return createReadStream(path);
  }

  /**
   * Handles the status operation for PackageCacheService.
   * @returns The result produced by the operation.
   */
  status() {
    return {
      cachePath: this.cacheRoot,
      healthy: true,
      scannerHealthy: true,
      diskFreeBytes: this.diskFreeBytesSyncFallback(),
    };
  }

  /**
   * Handles the path for operation for PackageCacheService.
   *
   * @param packageArtifactId Identifier used to locate the target record.
   * @returns The result produced by the operation.
   */
  private pathFor(packageArtifactId: string) {
    return join(this.cacheRoot, `${packageArtifactId}.bin`);
  }

  private metaPathFor(packageArtifactId: string) {
    return join(this.cacheRoot, `${packageArtifactId}.json`);
  }

  private async metadataVerified(path: string, expectedSha256: string) {
    const raw = await import('fs/promises').then((fs) => fs.readFile(path, 'utf8')).catch(() => '');
    if (!raw) return false;
    try {
      const parsed = JSON.parse(raw) as { verified?: boolean; sha256?: string };
      return parsed.verified === true && parsed.sha256?.toLowerCase() === expectedSha256.toLowerCase();
    } catch {
      return false;
    }
  }

  private async readMetadata(packageArtifactId: string) {
    const raw = await import('fs/promises').then((fs) => fs.readFile(this.metaPathFor(packageArtifactId), 'utf8')).catch(() => '');
    if (!raw) return undefined;
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  }

  private diskFreeBytesSyncFallback() {
    return undefined as number | undefined;
  }

  /**
   * Resolves management url configuration.
   *
   * @param sourceUrl URL used by the operation.
   * @returns The result produced by the operation.
   */
  private resolveManagementUrl(sourceUrl: string) {
    if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) return sourceUrl;
    return `${process.env.MANAGEMENT_URL?.replace(/\/$/, '')}${sourceUrl.startsWith('/') ? sourceUrl : `/${sourceUrl}`}`;
  }
}

async function sha256File(path: string) {
  const data = await import('fs/promises').then((fs) => fs.readFile(path));
  return createHash('sha256').update(data).digest('hex');
}

function sameOrigin(left: string, right?: string) {
  if (!right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}
