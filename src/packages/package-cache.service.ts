import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { createReadStream, existsSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { AgentTask } from '../types';

@Injectable()
export class PackageCacheService {
  private readonly logger = new Logger(PackageCacheService.name);
  private readonly cacheRoot = process.env.PACKAGE_CACHE_PATH ?? join(process.cwd(), 'package-cache');

  async ensureCached(task: AgentTask): Promise<AgentTask> {
    if (!task.packageArtifactId || !task.sourceUrl || !task.sha256) return task;
    await mkdir(this.cacheRoot, { recursive: true });
    const path = this.pathFor(task.packageArtifactId);
    if (!existsSync(path)) {
      const url = this.resolveManagementUrl(task.sourceUrl);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Package download failed: ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      const actual = createHash('sha256').update(data).digest('hex');
      if (actual.toLowerCase() !== task.sha256.toLowerCase()) {
        throw new Error(`Package hash mismatch for ${task.packageArtifactId}`);
      }
      await writeFile(path, data);
      this.logger.log(`Cached package ${task.packageArtifactId}`);
    }
    return {
      ...task,
      sourceUrl: `${process.env.NODE_PUBLIC_URL?.replace(/\/$/, '') ?? ''}/packages/cache/${task.packageArtifactId}`,
    };
  }

  stream(packageArtifactId: string) {
    const path = this.pathFor(packageArtifactId);
    if (!existsSync(path)) throw new NotFoundException('Package is not cached on this backend node');
    return createReadStream(path);
  }

  status() {
    return { cachePath: this.cacheRoot };
  }

  private pathFor(packageArtifactId: string) {
    return join(this.cacheRoot, `${packageArtifactId}.bin`);
  }

  private resolveManagementUrl(sourceUrl: string) {
    if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) return sourceUrl;
    return `${process.env.MANAGEMENT_URL?.replace(/\/$/, '')}${sourceUrl.startsWith('/') ? sourceUrl : `/${sourceUrl}`}`;
  }
}
