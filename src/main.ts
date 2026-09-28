import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { DATA_DIR } from './common/paths';
import { runtime } from './common/runtime';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableShutdownHooks();
  app.useBodyParser('json', { limit: '5mb' });

  const port = process.env.PORT ? Number(process.env.PORT) : 3002;
  // Localhost only by default: this server can start agents on your machine.
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  // Agent tool servers call back on loopback, whichever interface the UI is served on.
  runtime.apiBase = `http://127.0.0.1:${port}`;
  logger.log(`Agent Canvas on http://${host}:${port} · data in ${DATA_DIR}`);
}

void bootstrap();
