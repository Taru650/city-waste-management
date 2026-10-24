import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ClientInfo } from '../modules/auth/session.service';

export const Client = createParamDecorator((_data: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest();
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
});
