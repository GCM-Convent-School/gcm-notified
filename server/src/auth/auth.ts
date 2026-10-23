import { Body, CanActivate, Controller, ExecutionContext, Get, HttpCode, Injectable, Post, Req, Res, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { config } from '../config';
import { safeEqual, signToken, verifyToken } from '../common/token';
import { Public } from './public.decorator';

export { Public } from './public.decorator';
export const COOKIE = 'gcm_session';
const TTL_MS = 12 * 60 * 60 * 1000; // 12 h

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>('public', [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const user = verifyToken<{ u: string }>(req.cookies?.[COOKIE], config.sessionSecret);
    if (!user) throw new UnauthorizedException();
    return true;
  }
}

// Simple in-memory brute-force protection: 5 failures per IP → 15 min lockout.
const failures = new Map<string, { n: number; until: number }>();

@Controller('auth')
export class AuthController {
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: { username?: string; password?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = req.ip ?? 'unknown';
    const f = failures.get(ip);
    if (f && f.until > Date.now()) throw new UnauthorizedException('Too many attempts. Try again in 15 minutes.');
    const ok = safeEqual(body.username ?? '', config.adminUsername) && safeEqual(body.password ?? '', config.adminPassword);
    if (!ok) {
      const n = (f?.n ?? 0) + 1;
      failures.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60_000 : 0 });
      throw new UnauthorizedException('Invalid username or password');
    }
    failures.delete(ip);
    res.cookie(COOKIE, signToken({ u: config.adminUsername, exp: Date.now() + TTL_MS }, config.sessionSecret), {
      httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https'), maxAge: TTL_MS, path: '/',
    });
    return { ok: true, username: config.adminUsername };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me() {
    return { username: config.adminUsername };
  }
}
