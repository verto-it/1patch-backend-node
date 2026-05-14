import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  enrollmentToken?: string;
  dragonflyUrl?: string;
  caCert?: string;
};

type CompleteEnrollmentJson = Required<Omit<EnrollmentJson, 'dragonflyUrl' | 'caCert'>> & Pick<EnrollmentJson, 'dragonflyUrl' | 'caCert'>;

const envPath = '.env';
const defaultBackendNodePort = process.env.DEFAULT_BACKEND_NODE_PORT || '4200';


/**
 * Resolves console setup configuration.
 */
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
  console.log('Node will register with the management server on startup.');
}

/**
 * Loads env file data.
 */
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

/**
 * Handles the has required config operation.
 * @returns The result produced by the operation.
 */
function hasRequiredConfig() {
  return Boolean(
    process.env.NODE_ID &&
      process.env.NODE_ENROLLMENT_TOKEN &&
      process.env.NODE_PUBLIC_URL &&
      process.env.MANAGEMENT_URL &&
      process.env.DRAGONFLY_URL,
  );
}

/**
 * Handles the prompt for config operation.
 * @returns The result produced by the operation.
 */
async function promptForConfig(): Promise<BackendNodeConfig> {
  const rl = createInterface({ input, output });
  try {
    console.log('');
    console.log('1Patch Backend Node Setup');
    console.log('---------------------------------');
    console.log('Create a node enrollment in the management dashboard, then paste the JSON below.');
    console.log('');

    const mode = await chooseSetupMode(rl);
    if (mode === 'json') {
      const enrollment = await promptForEnrollmentJson(rl);

      if (!enrollment.dragonflyUrl) {
        enrollment.dragonflyUrl = await question(rl, 'DragonflyDB URL', process.env.DRAGONFLY_URL || 'redis://localhost:6380');
      }

      if (sameOrigin(enrollment.managementUrl, enrollment.nodePublicUrl)) {
        console.log('Note: node public URL matches the management URL — the backend node needs its own address.');
        enrollment.nodePublicUrl = await question(
          rl,
          'Node public URL',
          process.env.NODE_PUBLIC_URL || backendNodeUrlFromManagement(enrollment.managementUrl),
        );
      }

      const config = configFromEnrollment(enrollment);
      persistCaCert(enrollment.caCert);
      console.log('');
      console.log(`  Node ID:         ${config.nodeId}`);
      console.log(`  Management URL:  ${config.managementUrl}`);
      console.log(`  Node public URL: ${config.nodePublicUrl}`);
      console.log(`  DragonflyDB:     ${config.dragonflyUrl}`);
      console.log('');
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
      corsAllowedOrigins: await question(rl, 'CORS allowed origins (comma-separated, blank to skip)', process.env.CORS_ALLOWED_ORIGINS ?? ''),
    };
  } finally {
    rl.close();
  }
}

/**
 * Handles the backend node url from management operation.
 *
 * @param managementUrl URL used by the operation.
 * @returns The result produced by the operation.
 */
function backendNodeUrlFromManagement(managementUrl: string) {
  try {
    const url = new URL(managementUrl);
    url.port = defaultBackendNodePort;
    return url.origin;
  } catch {
    return `http://localhost:${defaultBackendNodePort}`;
  }
}

/**
 * Handles the config from enrollment operation.
 *
 * @param enrollment enrollment supplied to the function.
 * @returns The result produced by the operation.
 */
function configFromEnrollment(enrollment: CompleteEnrollmentJson): BackendNodeConfig {
  return {
    port: portFromUrl(enrollment.nodePublicUrl) || process.env.PORT || '4200',
    managementUrl: enrollment.managementUrl,
    nodeId: enrollment.nodeId,
    nodeEnrollmentToken: enrollment.enrollmentToken,
    nodePublicUrl: enrollment.nodePublicUrl,
    dragonflyUrl: enrollment.dragonflyUrl ?? '',
    tenantId: process.env.TENANT_ID || 'default',
    packageCachePath: process.env.PACKAGE_CACHE_PATH || './package-cache',
    corsAllowedOrigins: process.env.CORS_ALLOWED_ORIGINS ?? '',
  };
}

/**
 * Handles the port from url operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function portFromUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.port) return url.port;
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return undefined;
  }
}

/**
 * Handles the same origin operation.
 *
 * @param left left supplied to the function.
 * @param right right supplied to the function.
 * @returns The result produced by the operation.
 */
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
    console.log('');
  }
}

async function readJsonBlock(rl: ReturnType<typeof createInterface>) {
  console.log('Paste enrollment JSON from the management dashboard:');
  const lines: string[] = [];
  while (true) {
    const line = await rl.question(lines.length === 0 ? 'Enrollment JSON: ' : '');
    if (line.length === 0 && lines.length > 0) break;
    if (line.length === 0) continue;
    lines.push(line);
    if (looksCompleteJson(lines.join('\n'))) break;
  }
  return lines.join('\n');
}

/**
 * Returns true when value contains a syntactically complete JSON object.
 *
 * @param value Value to check.
 * @returns The result produced by the operation.
 */
function looksCompleteJson(value: string) {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  try {
    JSON.parse(value.slice(start, end + 1));
    return true;
  } catch {
    return false;
  }
}

/**
 * Parses enrollment json input.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
function parseEnrollmentJson(value: string): CompleteEnrollmentJson | undefined {
  const trimmed = extractJsonObject(value);
  if (!trimmed) {
    console.log('No JSON object found in the pasted text.');
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as EnrollmentJson;
    const missing = (['managementUrl', 'nodeId', 'enrollmentToken', 'nodePublicUrl'] as const).filter((k) => !parsed[k]);
    if (missing.length > 0) {
      console.log(`Enrollment JSON is missing required fields: ${missing.join(', ')}`);
      return undefined;
    }
    return { ...parsed, dragonflyUrl: parsed.dragonflyUrl ?? '' } as CompleteEnrollmentJson;
  } catch {
    console.log('Could not parse pasted text as JSON.');
    return undefined;
  }
}

/**
 * Handles the extract json object operation.
 *
 * @param value Value to read, render, or store.
 * @returns The result produced by the operation.
 */
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

/**
 * Handles the question operation.
 *
 * @param rl rl supplied to the function.
 * @param label label supplied to the function.
 * @param defaultValue default value supplied to the function.
 * @returns The result produced by the operation.
 */
async function question(rl: ReturnType<typeof createInterface>, label: string, defaultValue = '') {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

/**
 * Handles the write config operation.
 *
 * @param config Configuration object used by the operation.
 */
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

/**
 * Handles the apply config operation.
 *
 * @param config Configuration object used by the operation.
 */
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

function persistCaCert(caCert: string | undefined) {
  if (!caCert) return;
  try {
    const tlsDir = join(process.cwd(), 'tls');
    mkdirSync(tlsDir, { recursive: true });
    writeFileSync(join(tlsDir, 'ca.crt'), caCert, { encoding: 'utf8', mode: 0o644 });
  } catch { /* non-fatal */ }
}
