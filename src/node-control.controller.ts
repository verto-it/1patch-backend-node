import { Body, Controller, Logger, Post } from '@nestjs/common';
import { IsString } from 'class-validator';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

class DecommissionDto {
  @IsString()
  nodeId!: string;
}

@Controller('/node')
export class NodeControlController {
  private readonly logger = new Logger(NodeControlController.name);

  @Post('/decommission')
  async decommission(@Body() dto: DecommissionDto) {
    if (process.env.NODE_ID && dto.nodeId !== process.env.NODE_ID) {
      this.logger.warn(`Rejected decommission request for node ${dto.nodeId}; this node is ${process.env.NODE_ID}`);
      return { cleared: false, reason: 'node_id_mismatch' };
    }
    this.logger.warn(`Decommission requested for node ${dto.nodeId}. Clearing local node registration config.`);
    await clearNodeConfiguration();
    process.env.NODE_ID = '';
    process.env.NODE_ENROLLMENT_TOKEN = '';
    process.env.MANAGEMENT_URL = '';
    process.env.NODE_PUBLIC_URL = '';
    this.logger.warn('Local node registration config cleared. Restart this backend node before enrolling it again.');
    return { cleared: true, restartRecommended: true };
  }
}

async function clearNodeConfiguration() {
  const envPath = join(process.cwd(), '.env');
  const existing = await readFile(envPath, 'utf8').catch(() => '');
  const keysToClear = new Set(['NODE_ID', 'NODE_ENROLLMENT_TOKEN', 'NODE_PUBLIC_URL', 'MANAGEMENT_URL']);
  const seen = new Set<string>();
  const lines = existing
    .split(/\r?\n/)
    .filter((line, index, all) => line.length > 0 || index < all.length - 1)
    .map((line) => {
      const match = /^([^=#\s]+)=/.exec(line);
      if (!match) return line;
      const key = match[1];
      if (!keysToClear.has(key)) return line;
      seen.add(key);
      return `${key}=`;
    });
  for (const key of keysToClear) {
    if (!seen.has(key)) lines.push(`${key}=`);
  }
  await writeFile(envPath, `${lines.join('\n')}\n`, 'utf8');
}
