import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Background worker process (no HTTP): video transcoding, push dispatch, SLA sweeps,
 * auto-close and media purge. Run with PROCESS_ROLE=worker; scale replicas for peak events.
 */
async function bootstrap() {
  process.env.PROCESS_ROLE ??= 'worker';
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

bootstrap();
