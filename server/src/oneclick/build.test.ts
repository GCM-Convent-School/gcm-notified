import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFees, feesSchedule } from './build';
import { occursOn } from '../campaigns/schedule';

test('fees: sums outstanding, lists by due date, due-by and minimum filters', () => {
  const rows = [
    { name: 'F1', student: 'S1', outstanding_amount: 6000, due_date: '2026-10-15', academic_term: 'Term 2' },
    { name: 'F2', student: 'S1', outstanding_amount: 2500.5, due_date: '2026-07-15', academic_term: 'Term 1' },
    { name: 'F3', student: 'S2', outstanding_amount: 0, due_date: '2026-07-15' },
    { name: 'F4', student: 'S3', outstanding_amount: 300, due_date: '2026-12-01' },
  ];
  const all = buildFees(rows);
  assert.equal(all.get('S1')!.vars.amount, '₹8,500.5');
  assert.equal(all.get('S1')!.vars.fee_list, '• Term 1 — ₹2,500.5 (due 15 Jul 2026)\n• Term 2 — ₹6,000 (due 15 Oct 2026)');
  assert.equal(all.get('S1')!.vars.due_date, '15 Jul 2026');
  assert.ok(!all.has('S2'));
  const due = buildFees(rows, { dueBy: '2026-10-04' });
  assert.equal(due.get('S1')!.vars.amount, '₹2,500.5');
  assert.ok(!due.has('S3'));
  assert.ok(!buildFees(rows, { minAmount: 500 }).has('S3'));
});

test('fee reminder schedule: chosen weekdays, or every N days from the start date, skipping holidays', () => {
  const base = { time: '10:00', startDate: '2026-11-02', skipHolidays: true, days: [1, 4], every: 3 };
  const weekly = feesSchedule({ ...base, repeat: 'weekly' }, '2026-11-01');
  assert.deepEqual(['2026-11-02', '2026-11-03', '2026-11-05'].map((d) => occursOn(weekly, d, new Set())), [true, false, true]); // Mon, Tue, Thu
  assert.equal(occursOn(weekly, '2026-11-02', new Set(['2026-11-02'])), false);
  const every = feesSchedule({ ...base, repeat: 'every' }, '2026-11-01');
  assert.deepEqual(['2026-11-02', '2026-11-04', '2026-11-05', '2026-11-08'].map((d) => occursOn(every, d, new Set())), [true, false, true, true]);
  assert.equal(occursOn(every, '2026-11-01', new Set()), false); // before the start date
});
