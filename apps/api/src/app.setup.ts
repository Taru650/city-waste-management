import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppConfig } from './config/configuration';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the e2e tests so tests exercise the real security configuration. */
export function configureApp(app: INestApplication, config: AppConfig) {
  const express = app as NestExpressApplication;
  express.disable('x-powered-by');
  // Behind the load balancer / nginx: trust exactly one proxy hop for the client IP (rate limits, audit).
  express.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
  express.useBodyParser('json', { limit: '1mb' });

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // Browsers: only the configured portal origins. Mobile apps are not subject to CORS.
  app.enableCors({ origin: config.corsOrigins, credentials: false, methods: ['GET', 'POST', 'PATCH', 'DELETE'], maxAge: 600 });

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true, // reject unknown fields (mass-assignment guard, e.g. "role")
      transform: true,
      stopAtFirstError: false,
    }),
  );

  if (config.env !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('City Waste Management API')
      .setDescription('Single API for the Citizen app, Staff app and web portal')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));
  }
}
