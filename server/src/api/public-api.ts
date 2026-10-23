import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, Headers, HttpCode, HttpException, Injectable,
  NotFoundException, Param, ParseIntPipe, Post, Query, Req, ServiceUnavailableException, UnauthorizedException, UnprocessableEntityException,
} from '@nestjs/common';
import type { Request } from 'express';
import { createHash, randomBytes } from 'crypto';
import { Db } from '../db/db.service';
import { Public } from '../auth/public.decorator';
import { SettingsService } from '../settings/settings.service';
import { NumberRow } from '../numbers/numbers.service';
import { effectiveCap } from '../numbers/warmup';
import { normalizePhone, toChatId } from '../common/phone';

const hash = (key: string) => createHash('sha256').update(key).digest('hex');
const fail = (status: number, error: string, message: string) => new HttpException({ error, message }, status);
const MAX_TEXT = 4096;

interface KeyRow { id: number; name: string; prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }

@Injectable()
export class ApiService {
  private hits = new Map<number, number[]>();
  constructor(private readonly db: Db, private readonly settings: SettingsService) {}

  // ---------- keys (managed from Settings → API) ----------
  keys() {
    return this.db.query<KeyRow & { sent: number }>(
      `select k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at,
              (select count(*)::int from messages m where m.api_key_id = k.id) as sent
       from api_keys k order by k.revoked_at nulls first, k.id desc`);
  }

  async createKey(name: string) {
    const n = String(name ?? '').trim().slice(0, 60);
    if (!n) throw new BadRequestException('Give the key a name, e.g. "School ERP"');
    const key = `autosend_${randomBytes(24).toString('base64url')}`;
    const row = await this.db.one<KeyRow>(
      'insert into api_keys(name, prefix, key_hash) values ($1,$2,$3) returning id, name, prefix, created_at, last_used_at, revoked_at',
      [n, key.slice(0, 17), hash(key)]);
    await this.db.event('api', `API key "${n}" created`);
    return { ...row!, key }; // the only time the full key is returned
  }

  async revokeKey(id: number) {
    const row = await this.db.one<{ name: string }>('update api_keys set revoked_at=now() where id=$1 and revoked_at is null returning name', [id]);
    if (!row) throw new NotFoundException('Key not found or already revoked');
    await this.db.event('api', `API key "${row.name}" revoked`, 'warn');
    return { ok: true };
  }

  recent() {
    return this.db.query(
      `select m.id, m.phone, m.status, m.error, m.created_at, m.sent_at, m.client_ref, k.name as key_name, n.label as number_label
       from messages m left join api_keys k on k.id = m.api_key_id left join wa_numbers n on n.id = m.number_id
       where m.api_key_id is not null order by m.id desc limit 50`);
  }

  // ---------- public side ----------
  async authenticate(authorization?: string, xApiKey?: string, queryToken?: string): Promise<KeyRow> {
    const key = (queryToken || xApiKey || authorization?.replace(/^Bearer\s+/i, '') || '').trim();
    if (!key) {
      throw new UnauthorizedException({
        error: 'missing_api_key',
        message: 'Send your key as "Authorization: Bearer <key>", "x-api-key" header, or "?token=<key>" query parameter',
      });
    }
    const k = await this.db.one<KeyRow>('select * from api_keys where key_hash=$1', [hash(key)]);
    if (!k || k.revoked_at) {
      throw new UnauthorizedException({ error: 'invalid_api_key', message: 'This API key is not valid (or was revoked)' });
    }
    // Rate limit per key (sliding minute)
    const limit = (await this.settings.get()).api.perMinute;
    const now = Date.now();
    const recent = (this.hits.get(k.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) throw fail(429, 'rate_limited', `At most ${limit} requests per minute per key`);
    recent.push(now);
    this.hits.set(k.id, recent);
    this.db.query('update api_keys set last_used_at=now() where id=$1', [k.id]).catch(() => undefined);
    return k;
  }

  /**
   * Which number sends:
   * - If a specific sender is requested (id, session name, or phone): validates and uses it.
   * - Otherwise, applies Smart Load Balancing across any available number:
   *   Filters for WORKING, unpaused, auto-use numbers.
   *   Picks the number with the most remaining daily quota (effectiveCap - sent_today),
   *   cycling messages evenly across all connected numbers.
   */
  async pickNumber(sel: unknown): Promise<NumberRow & { auto_use: boolean }> {
    const rows = await this.db.query<NumberRow & { auto_use: boolean }>('select * from wa_numbers order by status_at desc, id desc');
    if (sel !== undefined && sel !== null && String(sel).trim() !== '' && String(sel).trim().toLowerCase() !== 'any' && String(sel).trim().toLowerCase() !== 'auto') {
      const s = String(sel).trim();
      const digits = s.replace(/\D/g, '');
      const n = rows.find((r) => String(r.id) === s || r.session === s || (digits.length >= 10 && !!r.phone && r.phone.endsWith(digits.slice(-10))));
      if (!n) throw fail(404, 'number_not_found', `No WhatsApp number "${s}" in GCM Notified`);
      if (n.status !== 'WORKING') throw fail(409, 'number_not_active', `Number "${n.label}" is not connected right now (${n.status})`);
      if (n.paused) throw fail(409, 'number_paused', `Number "${n.label}" is paused${n.pause_reason ? `: ${n.pause_reason}` : ''}`);
      return n;
    }

    // Smart load balancing across all working, unpaused numbers marked for auto_use
    const active = rows.filter((r) => r.status === 'WORKING' && !r.paused && r.auto_use);
    if (!active.length) {
      throw new ServiceUnavailableException({ error: 'no_active_number', message: 'No current active WhatsApp number available to send messages' });
    }

    // Compute remaining quota for each active number
    const scored = active.map((r) => {
      const cap = effectiveCap(r);
      const remaining = cap - (r.sent_today ?? 0);
      return { r, cap, remaining, sentToday: r.sent_today ?? 0 };
    });

    // Prefer numbers that still have quota left today (remaining > 0),
    // choosing the one with the highest remaining quota.
    // In case of a tie, pick the one that has sent fewer messages today.
    const withQuota = scored.filter((s) => s.remaining > 0);
    if (withQuota.length > 0) {
      withQuota.sort((a, b) => b.remaining - a.remaining || a.sentToday - b.sentToday);
      return withQuota[0].r;
    }

    // If all numbers reached their daily cap, pick the one with lowest sentToday / highest cap
    scored.sort((a, b) => a.sentToday - b.sentToday || b.cap - a.cap);
    return scored[0].r;
  }

  async send(key: KeyRow, b: { phone?: unknown; mobile?: unknown; to?: unknown; message?: unknown; text?: unknown; body?: unknown; number?: unknown; from?: unknown; ref?: unknown; client_ref?: unknown }) {
    const rawText = b?.message ?? b?.text ?? b?.body;
    const text = typeof rawText === 'string' ? rawText.replace(/\r\n/g, '\n').trim() : '';
    if (!text) throw fail(400, 'message_required', '"message" (or "text") is required (WhatsApp formatting like *bold* and _italic_ works)');
    if (text.length > MAX_TEXT) throw fail(400, 'message_too_long', `"message" can be at most ${MAX_TEXT} characters`);

    const rawPhone = b?.phone ?? b?.mobile ?? b?.to;
    const phone = normalizePhone(rawPhone);
    if (!phone) throw fail(400, 'invalid_phone', '"phone" (or "mobile") must be a valid mobile number, e.g. 9876543210 or +919876543210');

    const rawRef = b?.ref ?? b?.client_ref;
    const ref = rawRef === undefined || rawRef === null || rawRef === '' ? null : String(rawRef).slice(0, 100);

    if (ref) {
      const dup = await this.db.one<{ id: number }>('select id from messages where api_key_id=$1 and client_ref=$2', [key.id, ref]);
      if (dup) return { ...(await this.status(key, dup.id)), duplicate: true };
    }
    if (await this.db.one('select 1 from opt_outs where phone=$1', [phone])) {
      throw new ConflictException({ error: 'opted_out', message: 'This person replied STOP and does not receive messages' });
    }
    const check = await this.db.one<{ on_whatsapp: boolean }>(`select on_whatsapp from phone_checks where phone=$1 and checked_at > now() - interval '30 days'`, [phone]);
    if (check && !check.on_whatsapp) throw new UnprocessableEntityException({ error: 'not_on_whatsapp', message: 'This number is not on WhatsApp' });

    // Pick sender number (smart load balancing across any available number if not explicitly specified)
    const senderSel = b?.from ?? b?.number;
    const n = await this.pickNumber(senderSel);
    const row = await this.db.one<{ id: number }>(
      `insert into messages(number_id, fixed_number, chat_id, phone, recipient, body, priority, api_key_id, client_ref)
       values ($1,true,$2,$3,$4,$5,10,$6,$7) on conflict do nothing returning id`,
      [n.id, toChatId(phone), phone, `API · ${key.name}`, text, key.id, ref]);
    if (!row) { // same ref sent twice at the same moment
      const dup = await this.db.one<{ id: number }>('select id from messages where api_key_id=$1 and client_ref=$2', [key.id, ref]);
      return { ...(await this.status(key, dup!.id)), duplicate: true };
    }
    const out: Record<string, unknown> = await this.status(key, row.id);
    if (n.sent_today >= effectiveCap(n)) out.warning = `"${n.label}" reached its safe daily limit — the message waits until tomorrow`;
    return out;
  }

  async status(key: KeyRow, id: number) {
    const m = await this.db.one<any>(
      `select m.id, m.status, m.error, m.phone, m.client_ref, m.created_at, m.sent_at, m.ack_at, n.id as number_id, n.label, n.phone as number_phone
       from messages m left join wa_numbers n on n.id = m.number_id where m.id=$1 and m.api_key_id=$2`, [id, key.id]);
    if (!m) throw fail(404, 'message_not_found', 'No message with this id for this key');
    return {
      id: Number(m.id), status: m.status, error: m.error ?? null, phone: m.phone, ref: m.client_ref ?? null,
      from: m.number_id ? { id: m.number_id, label: m.label, phone: m.number_phone } : null,
      created_at: m.created_at, sent_at: m.sent_at, delivered_at: ['delivered', 'read'].includes(m.status) ? m.ack_at : null,
    };
  }

  async activeNumbers() {
    const rows = await this.db.query<NumberRow & { auto_use: boolean }>('select * from wa_numbers order by status_at desc, id desc');
    const active = rows.filter((r) => r.status === 'WORKING' && !r.paused && r.auto_use);
    const best = active
      .map((r) => ({ r, remaining: effectiveCap(r) - (r.sent_today ?? 0) }))
      .sort((a, b) => b.remaining - a.remaining)[0]?.r;
    return rows.filter((r) => r.status === 'WORKING' && !r.paused).map((r) => ({
      id: r.id, label: r.label, phone: r.phone, session: r.session, default: r.id === best?.id, remaining_today: Math.max(0, effectiveCap(r) - r.sent_today),
    }));
  }
}

/** Public API & Webhooks — authenticated with an API key / token. */
@Controller('v1')
export class PublicApiController {
  constructor(private readonly api: ApiService) {}

  @Public()
  @Post('messages')
  @HttpCode(202)
  async send(
    @Headers('authorization') auth: string | undefined,
    @Headers('x-api-key') x: string | undefined,
    @Query('token') token: string | undefined,
    @Query('api_key') apiKey: string | undefined,
    @Req() req: Request,
    @Body() b: any,
  ) {
    const payload = { ...(req.query as Record<string, any>), ...(b ?? {}) };
    return this.api.send(await this.api.authenticate(auth, x, token || apiKey), payload);
  }

  @Public()
  @Post('webhook')
  @HttpCode(202)
  async webhook(
    @Headers('authorization') auth: string | undefined,
    @Headers('x-api-key') x: string | undefined,
    @Query('token') token: string | undefined,
    @Query('api_key') apiKey: string | undefined,
    @Req() req: Request,
    @Body() b: any,
  ) {
    const payload = { ...(req.query as Record<string, any>), ...(b ?? {}) };
    return this.api.send(await this.api.authenticate(auth, x, token || apiKey), payload);
  }

  @Public()
  @Post('webhook/send')
  @HttpCode(202)
  async webhookSend(
    @Headers('authorization') auth: string | undefined,
    @Headers('x-api-key') x: string | undefined,
    @Query('token') token: string | undefined,
    @Query('api_key') apiKey: string | undefined,
    @Req() req: Request,
    @Body() b: any,
  ) {
    const payload = { ...(req.query as Record<string, any>), ...(b ?? {}) };
    return this.api.send(await this.api.authenticate(auth, x, token || apiKey), payload);
  }

  @Public()
  @Get('messages/:id')
  async status(
    @Headers('authorization') auth: string | undefined,
    @Headers('x-api-key') x: string | undefined,
    @Query('token') token: string | undefined,
    @Query('api_key') apiKey: string | undefined,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.api.status(await this.api.authenticate(auth, x, token || apiKey), id);
  }

  @Public()
  @Get('numbers')
  async numbers(
    @Headers('authorization') auth: string | undefined,
    @Headers('x-api-key') x: string | undefined,
    @Query('token') token: string | undefined,
    @Query('api_key') apiKey: string | undefined,
  ) {
    await this.api.authenticate(auth, x, token || apiKey);
    return this.api.activeNumbers();
  }
}

/** Dashboard side: manage keys, see recent API messages. */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly api: ApiService) {}
  @Get() keys() { return this.api.keys(); }
  @Post() create(@Body('name') name: string) { return this.api.createKey(name); }
  @Delete(':id') revoke(@Param('id', ParseIntPipe) id: number) { return this.api.revokeKey(id); }
  @Get('recent') recent() { return this.api.recent(); }
  @Get('numbers') numbers() { return this.api.activeNumbers(); }
}
