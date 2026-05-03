import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

type BackendNodeConfig = {
  port: string;
  managementUrl: string;
  nodeId: string;
  nodeEnrollmentToken: string;
  nodePublicUrl: string;
  dragonflyUrl: string;
  tenantId: string;
  packageCachePath: string;
  corsAllowedOrigins: string;
};

type EnrollmentJson = {
  managementUrl?: string;
  nodePublicUrl?: string;
  nodeId?: string;
  nodeEnrollmentToken?: string;
  dragonflyUrl?: string;
};

type CompleteEnrollmentJson = Required<Omit<EnrollmentJson, 'dragonflyUrl'>> & Pick<EnrollmentJson, 'dragonflyUrl'>;

const envPath = '.env';
const defaultBackendNodePort = process.env.DEFAULT_BACKEND_NODE_PORT || '4200';


export async function ensureConsoleSetup() {
  console.log('Checking backend node configuration...');
  loadEnvFile();
  if (hasRequiredConfig()) {
    console.log(`Backend node configuration found for node ${process.env.NODE_ID}.`);
    console.log(`Management URL: ${process.env.MANAGEMENT_URL}`);
    return;
  }

  console.log('Backend node configuration is missing.');

  if (!process.stdin.isTTY) {
    console.error(
      [
        '1Patch Backend Node is not configured.',
        'Set NODE_ID, NODE_ENROLLMENT_TOKEN, NODE_PUBLIC_URL, MANAGEMENT_URL, and DRAGONFLY_URL in .env.',
        'Create an enrollment from the management dashboard, then restart this process.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const config = await promptForConfig();
  console.log('Writing backend node configuration...');
  writeConfig(config);
  console.log('Applying backend node configuration to this process...');
  applyConfig(config);

  const shouldRegister = await promptYesNo('Register this backend node with management now?', true);
  if (shouldRegister) await registerConfiguredNode();
}

function loadEnvFile() {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const match = /^([^=#\s]+)=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (!process.env[key]) process.env[key] = value;
  }
}

function hasRequiredConfig() {
  return Boolean(
    process.env.NODE_ID &&
      process.env.NODE_ENROLLMENT_TOKEN &&
      process.env.NODE_PUBLIC_URL &&
      process.env.MANAGEMENT_URL &&
      process.env.DRAGONFLY_URL,
  );
}

async function promptForConfig(): Promise<BackendNodeConfig> {
  const rl = createInterface({ input, output });
  try {
    console.log('');
    console.log('1Patch Backend Node Console Setup');
    console.log('---------------------------------');
    console.log('Create an enrollment in the management dashboard, then choose how to enter it.');
    console.log('');

    const mode = await chooseSetupMode(rl);
    if (mode === 'json') {
      const enrollment = await promptForEnrollmentJson(rl);

      if (sameOrigin(enrollment.managementUrl, enrollment.nodePublicUrl)) {
        console.log('Node public URL matches the management URL. The backend node needs its own URL.');
        enrollment.nodePublicUrl = await question(
          rl,
          'Node public URL',
          process.env.NODE_PUBLIC_URL || backendNodeUrlFromManagement(enrollment.managementUrl),
        );
      }

      if (!enrollment.dragonflyUrl) {
        enrollment.dragonflyUrl = await question(rl, 'DragonflyDB URL', process.env.DRAGONFLY_URL || 'redis://localhost:6380');
      }

      const config = configFromEnrollment(enrollment);

      console.log('');
      console.log('Enrollment accepted:');
      console.log(`  Node ID:         ${config.nodeId}`);
      console.log(`  Management URL:  ${config.managementUrl}`);
      console.log(`  Node public URL: ${config.nodePublicUrl}`);
      console.log(`  DragonflyDB:     ${config.dragonflyUrl}`);
      console.log(`  Port:            ${config.port}`);
      console.log('');
      console.log('The node will receive a Vault-issued mTLS certificate on first registration.');
      console.log('All management server calls will use that certificate — no shared secrets required.');
      return config;
    }

    // Individual-field mode
    return {
      port: await question(rl, 'Port', process.env.PORT || '4200'),
      managementUrl: await question(rl, 'Management URL', process.env.MANAGEMENT_URL || 'http://localhost:4100'),
      nodeId: await question(rl, 'Node ID', process.env.NODE_ID ?? ''),
      nodeEnrollmentToken: await question(rl, 'Enrollment token', process.env.NODE_ENROLLMENT_TOKEN ?? ''),
      nodePublicUrl: await question(rl, 'Node public URL', process.env.NODE_PUBLIC_URL || `http://localhost:${defaultBackendNodePort}`),
      dragonflyUrl: await question(rl, 'DragonflyDB URL', process.env.DRAGONFLY_URL || 'redis://localhost:6380'),
      tenantId: process.env.TENANT_ID || 'default',
      packageCachePath: process.env.PACKAGE_CACHE_PATH || './package-cache',
      corsAllowedOrigins: await question(rl, 'CORS_ALLOWED_ORIGINS (comma-separated, leave blank to disable)', process.env.CORS_ALLOWED_ORIGINS ?? ''),
    };
  } finally {
    rl.close();
  }
}

function backendNodeUrlFromManagement(managementUrl: string) {
  try {
    const url = new URL(managementUrl);
    url.port = defaultBackendNodePort;
    return url.origin;
  } catch {
    return `http://localhost:${defaultBackendNodePort}`;
  }
}

function configFromEnrollment(enrollment: CompleteEnrollmentJson): BackendNodeConfig {
  return {
    port: portFromUrl(enrollment.nodePublicUrl) || process.env.PORT || '4200',
    managementUrl: enrollment.managementUrl,
    nodeId: enrollment.nodeId,
    nodeEnrollmentToken: enrollment.nodeEnrollmentToken,
    nodePublicUrl: enrollment.nodePublicUrl,
    dragonflyUrl: enrollment.dragonflyUrl ?? '',
    tenantId: process.env.TENANT_ID || 'default',
    packageCachePath: process.env.PACKAGE_CACHE_PATH || './package-cache',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? '',
  };
}

function portFromUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return undefined;
  }
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

async function chooseSetupMode(rl: ReturnType<typeof createInterface>) {
  while (true) {
    const answer = (await rl.question('Enter enrollment as JSON or individual fields? [json/individual]: ')).trim().toLowerCase();
    if (!answer || answer === 'json' || answer === 'j') return 'json';
    if (answer === 'individual' || answer === 'i') return 'individual';
    console.log('Please type "json" or "individual".');
  }
}

async function promptForEnrollmentJson(rl: ReturnType<typeof createInterface>): Promise<CompleteEnrollmentJson> {
  while (true) {
    const pasted = await readJsonBlock(rl);
    const enrollment = parseEnrollmentJson(pasted);
    if (enrollment) return enrollment;
    console.log('Could not parse enrollment JSON. Paste the full JSON object again, then press Enter on a blank line.');
  }
}

async function readJsonBlock(rl: ReturnType<typeof createInterface>) {
  const lines: string[] = [];
  console.log('Paste enrollment JSON (from the management dashboard), then press Enter on a blank line.');
  while (true) {
    const line = await rl.question(lines.length === 0 ? 'Enrollment JSON: ' : '');
    if (!line.trim() && lines.length > 0) return lines.join('\n');
    lines.push(line);
  }
}

function parseEnrollmentJson(value: string): CompleteEnrollmentJson | undefined {
  const trimmed = extractJsonObject(value);
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as EnrollmentJson;
    if (!parsed.managementUrl || !parsed.nodeId || !parsed.nodeEnrollmentToken || !parsed.nodePublicUrl) {
      return undefined;
    }
    return { ...parsed, dragonflyUrl: parsed.dragonflyUrl ?? '' } as CompleteEnrollmentJson;
  } catch {
    return undefined;
  }
}

function extractJsonObject(value: string) {
  const start = value.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && inString) { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return undefined;
}

async function question(rl: ReturnType<typeof createInterface>, label: string, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function promptYesNo(label: string, defaultValue: boolean) {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${label} [${suffix}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

function writeConfig(config: BackendNodeConfig) {
  writeFileSync(
    envPath,
    [
      `PORT=${config.port}`,
      `NODE_ID=${config.nodeId}`,
      `NODE_ENROLLMENT_TOKEN=${config.nodeEnrollmentToken}`,
      `NODE_PUBLIC_URL=${config.nodePublicUrl}`,
      `MANAGEMENT_URL=${config.managementUrl}`,
      `TENANT_ID=${config.tenantId}`,
      `DRAGONFLY_URL=${config.dragonflyUrl}`,
      `PACKAGE_CACHE_PATH=${config.packageCachePath}`,
      `CORS_ALLOWED_ORIGINS=${config.corsAllowedOrigins}`,
      `# NODE_DECOMMISSION_TOKEN_HASH is written automatically after first registration`,
      `NODE_DECOMMISSION_TOKEN_HASH=`,
      '',
    ].join('\n'),
    'utf8',
  );
  console.log('Wrote backend node .env successfully.');
}

function applyConfig(config: BackendNodeConfig) {
  process.env.PORT = config.port;
  process.env.NODE_ID = config.nodeId;
  process.env.NODE_ENROLLMENT_TOKEN = config.nodeEnrollmentToken;
  process.env.NODE_PUBLIC_URL = config.nodePublicUrl;
  process.env.MANAGEMENT_URL = config.managementUrl;
  process.env.TENANT_ID = config.tenantId;
  process.env.DRAGONFLY_URL = config.dragonflyUrl;
  process.env.PACKAGE_CACHE_PATH = config.packageCachePath;
  process.env.CORS_ALLOWED_ORIGINS = config.corsAllowedOrigins;
}

async function registerConfiguredNode() {
  const managementUrl = process.env.MANAGEMENT_URL;
  if (!managementUrl) return;
  const registerUrl = `${managementUrl.replace(/\/$/, '')}/nodes/register`;
  console.log(`Registering backend node with management at ${registerUrl}...`);
  console.log('Note: no shared secret is sent — the enrollment token is the sole credential for this call.');
  try {
    const res = await fetch(registerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nodeId: process.env.NODE_ID,
        enrollmentToken: process.env.NODE_ENROLLMENT_TOKEN,
        version: '0.1.0',
        capacity: { packageCache: 'local' },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text || res.statusText}`);
    const body = JSON.parse(text) as { nodeId?: string; tls?: unknown; decommissionToken?: string };
    console.log('Registration succeeded. Management accepted this backend node.');
    if (body.tls) {
      console.log('mTLS certificate received — it will be persisted to ./tls/ on next full startup.');
    }
    if (body.decommissionToken) {
      console.log('Per-node decommission token received — it will be stored in .env on next full startup.');
    }
  } catch (error) {
    console.error(`Registration failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error('The node will start and retry automatic registration on startup.');
  }
}
