import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiService } from './public-api';

function mockDb(rows: any[] = [], queryHandler?: (sql: string, params?: any[]) => any) {
  return {
    async query(sql: string, params?: any[]) {
      if (queryHandler) return queryHandler(sql, params);
      return rows;
    },
    async one(sql: string, params?: any[]) {
      if (queryHandler) return queryHandler(sql, params);
      return rows[0] ?? null;
    },
    async event() {},
  } as any;
}

const mockSettings = {
  async get() {
    return {
      api: { perMinute: 60 },
      quietHours: { enabled: false, start: '21:00', end: '07:00' },
      optOutKeywords: ['stop'],
    };
  },
} as any;

test('createKey generates key with autosend_ prefix', async () => {
  let inserted: any = null;
  const db = {
    async one(sql: string, params?: any[]) {
      inserted = params;
      return { id: 1, name: params?.[0], prefix: params?.[1], created_at: new Date() };
    },
    async event() {},
  } as any;

  const api = new ApiService(db, mockSettings);
  const result = await api.createKey('Test Webhook');

  assert.ok(result.key.startsWith('autosend_'));
  assert.equal(result.prefix.startsWith('autosend_'), true);
  assert.equal(inserted[1].startsWith('autosend_'), true);
});

test('authenticate works with Bearer header, X-API-Key, and query token', async () => {
  const storedKey = 'autosend_secret123';
  const { createHash } = await import('crypto');
  const keyHash = createHash('sha256').update(storedKey).digest('hex');

  const db = {
    async one(sql: string, params?: any[]) {
      if (params?.[0] === keyHash) {
        return { id: 1, name: 'Webhook Client', prefix: 'autosend_sec', created_at: new Date(), revoked_at: null };
      }
      return null;
    },
    async query() {},
  } as any;

  const api = new ApiService(db, mockSettings);

  // 1. Authorization: Bearer
  const k1 = await api.authenticate('Bearer autosend_secret123');
  assert.equal(k1.id, 1);

  // 2. x-api-key header
  const k2 = await api.authenticate(undefined, 'autosend_secret123');
  assert.equal(k2.id, 1);

  // 3. Query token (?token=...)
  const k3 = await api.authenticate(undefined, undefined, 'autosend_secret123');
  assert.equal(k3.id, 1);
});

test('pickNumber performs smart load balancing across available numbers', async () => {
  // Three connected numbers with different daily caps and sent counts:
  // Number 1: cap 100, sent 80 -> remaining 20
  // Number 2: cap 100, sent 10 -> remaining 90 (BEST)
  // Number 3: cap 100, sent 50 -> remaining 50
  // Number 4: cap 200, but paused -> ignored
  const numbers = [
    { id: 1, label: 'Office 1', session: 's1', phone: '919876543211', status: 'WORKING', paused: false, auto_use: true, daily_cap: 100, max_cap: 100, sent_today: 80, ramp_enabled: false },
    { id: 2, label: 'Office 2', session: 's2', phone: '919876543212', status: 'WORKING', paused: false, auto_use: true, daily_cap: 100, max_cap: 100, sent_today: 10, ramp_enabled: false },
    { id: 3, label: 'Office 3', session: 's3', phone: '919876543213', status: 'WORKING', paused: false, auto_use: true, daily_cap: 100, max_cap: 100, sent_today: 50, ramp_enabled: false },
    { id: 4, label: 'Office 4', session: 's4', phone: '919876543214', status: 'WORKING', paused: true, auto_use: true, daily_cap: 200, max_cap: 200, sent_today: 0, ramp_enabled: false },
  ];

  const db = mockDb(numbers);
  const api = new ApiService(db, mockSettings);

  // Without specifying a sender number (or passing 'any'), smart load balancing should pick Number 2 (remaining 90)
  const pickedAuto = await api.pickNumber(undefined);
  assert.equal(pickedAuto.id, 2);

  const pickedAny = await api.pickNumber('any');
  assert.equal(pickedAny.id, 2);

  // When asking for a specific number explicitly, it should pick that specific number
  const pickedSpecific = await api.pickNumber('1');
  assert.equal(pickedSpecific.id, 1);
});

test('send accepts mobile/phone and message/text flexibly', async () => {
  const number = { id: 5, label: 'Main', session: 's5', phone: '919876543215', status: 'WORKING', paused: false, auto_use: true, daily_cap: 100, max_cap: 100, sent_today: 0, ramp_enabled: false };

  let insertedMessage: any = null;
  const db = {
    async query(sql: string) {
      if (sql.includes('from wa_numbers')) return [number];
      return [];
    },
    async one(sql: string, params?: any[]) {
      if (sql.includes('from wa_numbers')) return number;
      if (sql.includes('from opt_outs')) return null;
      if (sql.includes('from phone_checks')) return null;
      if (sql.includes('insert into messages')) {
        insertedMessage = params;
        return { id: 42 };
      }
      if (sql.includes('from messages m left join wa_numbers')) {
        return { id: 42, status: 'queued', phone: '919876543210', client_ref: null, created_at: new Date(), number_id: 5, label: 'Main', number_phone: '919876543215' };
      }
      return null;
    },
    async event() {},
  } as any;

  const api = new ApiService(db, mockSettings);
  const key = { id: 9, name: 'ERP Webhook', prefix: 'autosend_erp', created_at: new Date(), last_used_at: null, revoked_at: null };

  // Call with `mobile` and `text` (instead of `phone` and `message`)
  const res = await api.send(key, {
    mobile: '9876543210',
    text: 'Test notification',
  });

  assert.equal(res.id, 42);
  assert.equal(res.status, 'queued');
  assert.equal(insertedMessage[0], 5); // Picked number 5
  assert.equal(insertedMessage[2], '919876543210'); // Normalized phone
  assert.equal(insertedMessage[4], 'Test notification'); // Body
});
