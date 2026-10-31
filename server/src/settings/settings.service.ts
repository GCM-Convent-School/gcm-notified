import { BadRequestException, Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';
import type { RecipientMode } from '../campaigns/render';
import { cleanRule, NumberRule, PRIMARY_RULE } from '../contacts/rules';
import { checkTemplate } from '../campaigns/render';
import { DEFAULT_LINES, DEFAULT_RULES, Lines, RankRules } from '../oneclick/marks';

export interface SpeedPreset { delayMinMs: number; delayMaxMs: number; burstMin: number; burstMax: number; burstPauseMinMs: number; burstPauseMaxMs: number }

/** What a message is for. Decides which number(s) are used, speed, quiet hours and whether STOP is overridden. */
export interface MessageType {
  key: string; name: string; icon: string;
  rule: NumberRule;                 // own lists: default number rule (lists and people can override)
  school: RecipientMode;            // school (Frappe) students: which parent(s)
  speed: 'urgent' | 'normal' | 'safe';
  quietHours: boolean;              // respect quiet hours
  overrideOptOut: boolean;          // also send to people who replied STOP (emergencies only)
}

export interface AppSettings {
  quietHours: { enabled: boolean; start: string; end: string };
  speedPresets: Record<'urgent' | 'normal' | 'safe', SpeedPreset>;
  defaultMaxCap: number;
  primaryParent: 'father' | 'mother';
  optOutKeywords: string[];
  optOutReply: string;
  alerts: { adminPhone: string; email: string; whatsapp: boolean; emailEnabled: boolean };
  frappe: { academicYear: string; excludePrograms: string[]; syncEveryHours: number };
  autoPause: { failureRatePct: number; minSamples: number };
  privacy: { maskPhones: boolean; rehideSeconds: number };
  messageTypes: MessageType[];
  frequencyCap: { perDay: number };   // messages per person per day across all campaigns (0 = off; emergencies exempt)
  holidays: string[];                  // extra holidays (YYYY-MM-DD) on top of Frappe's Holiday List
  waCheck: { enabled: boolean; everyDays: number; perHour: number };   // background "is this number on WhatsApp?" check
  api: { perMinute: number };          // public send API: messages per key per minute
  oneClick: { marks: { template: string }; fees: { template: string } };
  marksReport: MarksReportSettings;    // Daily Marks Report + the marks statement used by manual 1-Click marks
  seededTypes: string[];               // default message types already added once (a removed one is not re-added)
}

/** Daily Marks Report: runs at `time` on `days`, sends every result added since the last successful run. */
export interface MarksReportSettings {
  enabled: boolean;
  time: string;                        // HH:MM, app timezone
  days: number[];                      // 0 = Sunday
  skipHolidays: boolean;
  startFrom: string;                   // Frappe datetime: the first run reads results added after this (set when first switched on)
  rules: RankRules;
  lines: Lines;
  template: string;
}

export const STATEMENT_TEMPLATE = `Dear Parent,

*{{student_name}}* ({{section}}) — {{period}}:

{{marks}}

*Total: {{total}} / {{max}} ({{percent}}%)*
{{rank_line}}

— GCM Convent School`;

export const MARKS_TEMPLATE = `Dear Parent,

*{{student_name}}* ({{class}}) — *{{exam}}* result:

{{marks}}

*Total: {{total}} / {{max}} ({{percent}}%)*

— GCM Convent School`;

export const FEES_TEMPLATE = `Dear Parent,

This is a gentle reminder that fees of *{{amount}}* are pending for *{{student_name}}* ({{class}}).

{{fee_list}}

Please pay at the school office at the earliest. Kindly ignore this message if already paid.

— GCM Convent School`;

export const DEFAULT_SETTINGS: AppSettings = {
  quietHours: { enabled: true, start: '22:00', end: '06:00' },
  speedPresets: {
    urgent: { delayMinMs: 1000, delayMaxMs: 3000, burstMin: 40, burstMax: 60, burstPauseMinMs: 30_000, burstPauseMaxMs: 60_000 },
    normal: { delayMinMs: 3000, delayMaxMs: 8000, burstMin: 25, burstMax: 40, burstPauseMinMs: 60_000, burstPauseMaxMs: 180_000 },
    safe: { delayMinMs: 8000, delayMaxMs: 20000, burstMin: 20, burstMax: 30, burstPauseMinMs: 120_000, burstPauseMaxMs: 300_000 },
  },
  defaultMaxCap: 1000,
  primaryParent: 'father',
  optOutKeywords: ['stop', 'unsubscribe'],
  optOutReply: 'You have been unsubscribed and will not receive further messages from this number.',
  alerts: { adminPhone: '', email: '', whatsapp: true, emailEnabled: true },
  frappe: { academicYear: '', excludePrograms: ['Dummy', 'Dummy class'], syncEveryHours: 6 },
  autoPause: { failureRatePct: 5, minSamples: 20 },
  privacy: { maskPhones: true, rehideSeconds: 30 },
  frequencyCap: { perDay: 3 },
  holidays: [],
  waCheck: { enabled: true, everyDays: 7, perHour: 200 },
  api: { perMinute: 60 },
  oneClick: { marks: { template: MARKS_TEMPLATE }, fees: { template: FEES_TEMPLATE } },
  marksReport: { enabled: false, time: '19:00', days: [1, 2, 3, 4, 5, 6], skipHolidays: true, startFrom: '', rules: DEFAULT_RULES, lines: DEFAULT_LINES, template: STATEMENT_TEMPLATE },
  seededTypes: ['notice', 'invitation', 'fees', 'greeting', 'reminder', 'sos', 'academic'],
  messageTypes: [
    { key: 'notice', name: 'Notice', icon: '📢', rule: PRIMARY_RULE, school: 'primary', speed: 'normal', quietHours: true, overrideOptOut: false },
    { key: 'invitation', name: 'Invitation', icon: '💌', rule: PRIMARY_RULE, school: 'primary', speed: 'normal', quietHours: true, overrideOptOut: false },
    { key: 'academic', name: 'Academic', icon: '📝', rule: PRIMARY_RULE, school: 'primary', speed: 'normal', quietHours: true, overrideOptOut: false },
    { key: 'fees', name: 'Fees', icon: '💰', rule: PRIMARY_RULE, school: 'primary', speed: 'normal', quietHours: true, overrideOptOut: false },
    { key: 'greeting', name: 'Greeting', icon: '🎉', rule: PRIMARY_RULE, school: 'primary', speed: 'safe', quietHours: true, overrideOptOut: false },
    { key: 'reminder', name: 'Reminder', icon: '⏰', rule: PRIMARY_RULE, school: 'primary', speed: 'normal', quietHours: true, overrideOptOut: false },
    { key: 'sos', name: 'SOS / Emergency', icon: '🚨', rule: { use: 'all' }, school: 'all', speed: 'urgent', quietHours: false, overrideOptOut: true },
  ],
};

const SCHOOL_MODES: RecipientMode[] = ['primary', 'father', 'mother', 'both', 'student', 'all'];
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

/** Validates edited message types; keeps keys stable so campaigns and list rules stay linked. */
export function cleanMessageTypes(list: unknown): MessageType[] {
  if (!Array.isArray(list) || !list.length) throw new BadRequestException('Keep at least one message type');
  const seen = new Set<string>();
  return list.slice(0, 30).map((raw: any) => {
    const name = String(raw?.name ?? '').trim().slice(0, 40);
    if (!name) throw new BadRequestException('Every message type needs a name');
    let key = slug(String(raw?.key || name)) || 'type';
    for (let i = 2; seen.has(key); i++) key = `${slug(String(raw?.key || name))}-${i}`;
    seen.add(key);
    return {
      key, name, icon: String(raw?.icon ?? '').trim().slice(0, 4) || '✉️',
      rule: cleanRule(raw?.rule) ?? PRIMARY_RULE,
      school: SCHOOL_MODES.includes(raw?.school) ? raw.school : 'primary',
      speed: ['urgent', 'normal', 'safe'].includes(raw?.speed) ? raw.speed : 'normal',
      quietHours: raw?.quietHours !== false,
      overrideOptOut: raw?.overrideOptOut === true,
    };
  });
}

@Injectable()
export class SettingsService {
  private cache: AppSettings | null = null;
  constructor(private readonly db: Db) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const row = await this.db.one<{ value: Partial<AppSettings> }>(`select value from settings where key = 'app'`);
    const merged = deepMerge(DEFAULT_SETTINGS, row?.value ?? {}) as AppSettings;
    // Saved settings keep their own list of types: add new default types once (e.g. Academic), never re-add a removed one
    const seeded = new Set(row?.value?.seededTypes ?? ['notice', 'invitation', 'fees', 'greeting', 'reminder', 'sos']);
    for (const t of DEFAULT_SETTINGS.messageTypes) {
      if (!seeded.has(t.key) && !merged.messageTypes.some((x) => x.key === t.key)) merged.messageTypes.push(t);
    }
    merged.seededTypes = DEFAULT_SETTINGS.seededTypes;
    this.cache = merged;
    return this.cache;
  }

  async messageType(key: string | null | undefined): Promise<MessageType | null> {
    const s = await this.get();
    return s.messageTypes.find((t) => t.key === key) ?? null;
  }

  /** A type the app itself relies on (1-Click uses academic / fees): the saved one, else its default. */
  async builtInType(key: 'academic' | 'fees'): Promise<MessageType> {
    return (await this.messageType(key)) ?? DEFAULT_SETTINGS.messageTypes.find((t) => t.key === key)!;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = deepMerge(await this.get(), patch) as AppSettings;
    next.optOutKeywords = next.optOutKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
    next.messageTypes = cleanMessageTypes(next.messageTypes);
    next.frequencyCap = { perDay: Math.max(0, Math.min(50, Math.round(Number(next.frequencyCap?.perDay) || 0))) };
    next.waCheck = {
      enabled: next.waCheck?.enabled !== false,
      everyDays: Math.max(1, Math.min(90, Math.round(Number(next.waCheck?.everyDays) || 7))),
      perHour: Math.max(10, Math.min(1000, Math.round(Number(next.waCheck?.perHour) || 200))),
    };
    next.api = { perMinute: Math.max(1, Math.min(600, Math.round(Number(next.api?.perMinute) || 60))) };
    for (const k of ['marks', 'fees'] as const) {
      const t = String(next.oneClick?.[k]?.template ?? '').trim();
      try { checkTemplate(t); } catch (e) { throw new BadRequestException(`${k === 'marks' ? 'Marks' : 'Fees'} message: ${(e as Error).message}`); }
      next.oneClick[k] = { template: t || (k === 'marks' ? MARKS_TEMPLATE : FEES_TEMPLATE) };
    }
    next.marksReport = cleanMarksReport(next.marksReport);
    next.holidays = [...new Set((next.holidays ?? []).map((d) => String(d).trim()).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    await this.db.query(
      `insert into settings(key, value, updated_at) values ('app', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(next)],
    );
    this.cache = next;
    return next;
  }
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => Math.max(lo, Math.min(hi, Math.round(Number(v) || d)));

export function cleanMarksReport(m: any): MarksReportSettings {
  const time = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(m?.time)) ? String(m.time).padStart(5, '0') : '19:00';
  const days = [...new Set((Array.isArray(m?.days) ? m.days : []).map(Number).filter((d: number) => d >= 0 && d <= 6))].sort() as number[];
  if (m?.enabled && !days.length) throw new BadRequestException('Daily Marks Report: pick at least one day');
  const template = String(m?.template ?? '').trim() || STATEMENT_TEMPLATE;
  const lines = { rankLine: String(m?.lines?.rankLine ?? '').trim() || DEFAULT_LINES.rankLine, bottomLine: String(m?.lines?.bottomLine ?? '').trim() || DEFAULT_LINES.bottomLine };
  for (const [what, t] of [['message', template], ['rank line', lines.rankLine], ['note', lines.bottomLine]]) {
    try { checkTemplate(t); } catch (e) { throw new BadRequestException(`Daily Marks Report ${what}: ${(e as Error).message}`); }
  }
  return {
    enabled: !!m?.enabled, time, days, skipHolidays: m?.skipHolidays !== false,
    startFrom: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(m?.startFrom)) ? String(m.startFrom).slice(0, 19) : '',
    rules: {
      minRanked: clamp(m?.rules?.minRanked, 2, 100, DEFAULT_RULES.minRanked),
      minEnteredPct: clamp(m?.rules?.minEnteredPct, 0, 100, DEFAULT_RULES.minEnteredPct),
      topPct: clamp(m?.rules?.topPct, 1, 100, DEFAULT_RULES.topPct),
    },
    lines, template,
  };
}

function deepMerge(base: any, patch: any): any {
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== 'object' || typeof patch !== 'object' || !base || !patch) {
    return patch === undefined ? base : patch;
  }
  const out: any = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}
