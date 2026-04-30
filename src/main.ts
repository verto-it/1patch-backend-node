import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableCors({ origin: true });

  const config = new DocumentBuilder()
    .setTitle('1Patch Backend Node')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('/docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(Number(process.env.PORT ?? 4200));
}

void bootstrap();
