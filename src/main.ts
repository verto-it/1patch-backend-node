import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ensureConsoleSetup } from './console-setup';

async function bootstrap() {
  await ensureConsoleSetup();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.use(helmet());

  const requestBodyLimit = process.env.REQUEST_BODY_LIMIT ?? '10mb';
  app.useBodyParser('json', { limit: requestBodyLimit });
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
