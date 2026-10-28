import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { APP_CONFIG, AppConfig } from '../../src/config/configuration';
import { api, createTestApp, TestCtx } from '../helpers';

/** OWASP A05: security headers, CORS policy, no API docs in production. */
describe('Security: headers, CORS and production hardening', () => {
  let ctx: TestCtx;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());

  it('sends hardened security headers and hides the framework', async () => {
    const res = await ctx.http().get(api('/health')).expect(200);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000; includeSubDomains/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS only for the configured portal origin', async () => {
    const ok = await ctx.http().options(api('/auth/login')).set('Origin', 'https://portal.example.gov.in').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('https://portal.example.gov.in');
    const evil = await ctx.http().options(api('/auth/login')).set('Origin', 'https://evil.example.com').set('Access-Control-Request-Method', 'POST');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not expose Swagger docs in production', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    configureApp(app, { ...app.get<AppConfig>(APP_CONFIG), env: 'production' });
    await app.init();
    await request(app.getHttpServer()).get('/api/docs').expect(404);
    await app.close();
    await ctx.http().get('/api/docs').expect(200); // available outside production
  });
});
