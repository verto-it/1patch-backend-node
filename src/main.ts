import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ensureConsoleSetup } from './console-setup';

/**
 * Handles the print banner operation.
 *
 * @param subtitle subtitle supplied to the function.
 */
function printBanner(subtitle: string) {
  const g = '\x1b[38;2;164;220;0m';   // lime green
  const d = '\x1b[38;2;90;130;0m';    // dark green
  const b = '\x1b[1m';
  const r = '\x1b[0m';
  const baseIndent = '  ';
  const rows = [
    [g, '   _ ',  ' ____       _       _     '],
    [g, '  / |',  '|  _ \\ __ _| |_ ___| |__  '],
    [g, '  | |',  '| |_) / _` | __/ __| \'_ \\ '],
    [d, '  | |',  '|  __/ (_| | || (__| | | |'],
    [d, '  |_|',  '|_|   \\__,_|\\__\\___|_| |_|'],
  ];
  const width = Math.max(subtitle.length, ...rows.map(([, one, patch]) => one.length + patch.length));
  /**
   * Handles the center operation.
   *
   * @param value Value to read, render, or store.
   */
  const center = (value: string) => ' '.repeat(Math.max(0, Math.floor((width - value.length) / 2)));

  console.log('');
  for (const [oneColor, one, patch] of rows) {
    console.log(`${baseIndent}${center(one + patch)}${oneColor}${b}${one}${r}${b}${patch}${r}`);
  }
  console.log('');
  console.log(`${baseIndent}${center(subtitle)}${g}${subtitle}${r}`);
  console.log('');
}

/**
 * Handles the bootstrap operation.
 */
async function bootstrap() {
  printBanner('Backend Node  ·  v0.9  ·  AGPL-3.0');
  await ensureConsoleSetup();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(helmet());

  const requestBodyLimit = process.env.REQUEST_BODY_LIMIT ?? '10mb';
  /**
   * Handles the raw body verify operation.
   *
   * @param req Incoming HTTP request context.
   * @param _res res supplied to the function.
   * @param buf buf supplied to the function.
   */
  const rawBodyVerify = (req: import("http").IncomingMessage & { rawBody?: Buffer }, _res: import("http").ServerResponse, buf: Buffer) => { req.rawBody = buf; };
  app.useBodyParser('json', { limit: requestBodyLimit, verify: rawBodyVerify });
  app.useBodyParser('urlencoded', { limit: requestBodyLimit, extended: true });

  // FIX #12: explicit CORS origin allowlist instead of wildcard reflect
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);


  if (allowedOrigins.length === 0) {
    console.warn('[WARN] CORS_ALLOWED_ORIGINS is not set — CORS is disabled for browser clients.');
    app.enableCors({ origin: false });
  } else {
    app.enableCors({ origin: allowedOrigins });
    console.log(`[INFO] CORS enabled for: ${allowedOrigins.join(', ')}`);
  }

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = Number(process.env.PORT ?? 4200);
  await app.listen(port);
  console.log(`[INFO] 1Patch backend node API listening on port ${port}`);
  console.log(`[INFO] Request body limit: ${requestBodyLimit}`);
}

void bootstrap();
