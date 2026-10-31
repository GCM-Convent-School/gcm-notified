import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatements, DEFAULT_LINES, DEFAULT_RULES, incompleteTests, Result, shiftFrappeTime, standings } from './marks';

const res = (student: string, plan: string, total: number, max = 20, extra: Partial<Result> = {}): Result => ({
  name: `${student}-${plan}`, student, student_name: `${student} Kumar`, assessment_plan: plan, course: plan === 'P1' ? 'Maths' : 'English',
  assessment_group: 'FA1', student_group: '7TH A', total_score: total, maximum_score: max, creation: '2026-10-30 10:00:00', ...extra,
});
const section = (scores: number[], plan = 'P1') => scores.map((s, i) => res(`S${i + 1}`, plan, s));

test('equal scores share a rank (1, 2, 2, 4) and a tie at the cut-off stays on top', () => {
  // 10 students, top 70% = 7 → ranks 1..7 top; S7 and S8 tie at rank 7 → both top
  const st = standings(section([20, 18, 18, 15, 14, 13, 12, 12, 5, 3]), ['P1'], 10, DEFAULT_RULES);
  assert.deepEqual([1, 2, 3, 4].map((i) => st.get(`S${i}`)!.rank), [1, 2, 2, 4]);
  assert.equal(st.get('S7')!.band, 'top');
  assert.equal(st.get('S8')!.band, 'top');
  assert.equal(st.get('S8')!.rank, 7);
  assert.equal(st.get('S9')!.band, 'bottom');
  assert.equal(st.get('S10')!.of, 10);
});

test('no rank for anyone when too few students are ranked', () => {
  const small = standings(section([20, 18, 15, 12, 10]), ['P1'], 5, DEFAULT_RULES);       // 5 < 8
  assert.ok([...small.values()].every((s) => s.band === 'none'));
  const half = standings(section([20, 18, 15, 12, 10, 9, 8, 7, 6]), ['P1'], 20, DEFAULT_RULES); // 9 of 20 < 70%
  assert.ok([...half.values()].every((s) => s.band === 'none'));
});

test('absent (zero) students get marks but no rank, and are left out of the ranking', () => {
  const st = standings(section([20, 18, 15, 12, 10, 9, 8, 7, 6, 0]), ['P1'], 10, DEFAULT_RULES);
  assert.equal(st.get('S10')!.band, 'none');
  assert.equal(st.get('S10')!.reason, 'absent');
  assert.equal(st.get('S1')!.of, 9);
});

test('several tests: score for the day is total over total; absent in one test → not ranked', () => {
  const cohort = [...section([10, 20, 15, 15, 15, 15, 15, 15]), ...section([20, 0, 15, 15, 15, 15, 15, 15], 'P2')];
  const st = standings(cohort, ['P1', 'P2'], 8, { ...DEFAULT_RULES, minRanked: 5 });
  assert.equal(st.get('S2')!.band, 'none');
  assert.equal(st.get('S1')!.rank, 1);   // 10 + 20 = 30/40, same as 15 + 15 → shared rank 1
  assert.equal(st.get('S3')!.rank, 1);
});

test('statement: lists the tests, total and the right line per band', () => {
  const cohort = section([20, 18, 17, 16, 15, 14, 13, 12, 5, 3]);
  const out = buildStatements({ items: cohort, cohort, sectionSizes: new Map([['7TH A', 10]]), rules: DEFAULT_RULES, lines: DEFAULT_LINES, period: 'Marks added on 30 Oct 2026' });
  const top = out.get('S2')!;
  assert.equal(top.vars.marks, '• Maths – FA1: 18/20');
  assert.equal(top.vars.rank_line, '🏅 Class rank: *2* of 10 in 7TH A');
  assert.equal(top.summary, '18/20 · 90% · #2/10');
  const bottom = out.get('S10')!;
  assert.match(String(bottom.vars.rank_line), /^S10's scores were below most of the class/);
  assert.equal(bottom.vars.rank, '');
});

test('statement shows the test date when Frappe gives it', () => {
  const cohort = section([20, 18, 17, 16, 15, 14, 13, 12]).map((r) => ({ ...r, held_on: '2026-10-24' }));
  const out = buildStatements({ items: cohort, cohort, sectionSizes: new Map([['7TH A', 8]]), rules: DEFAULT_RULES, lines: DEFAULT_LINES, period: 'x' });
  assert.equal(out.get('S1')!.vars.marks, '• Maths – FA1 (24 Oct): 20/20');
});

test('incomplete tests and Frappe time shifting', () => {
  const inc = incompleteTests(section([20, 18, 15]), new Map([['7TH A', 10]]), 70);
  assert.deepEqual(inc.get('P1'), { name: 'Maths – FA1', section: '7TH A', entered: 3, size: 10 });
  assert.equal(incompleteTests(section([20, 18, 15]), new Map([['7TH A', 4]]), 70).size, 0);
  assert.equal(shiftFrappeTime('2026-11-01 01:02:03.123', -1), '2026-10-31 01:02:03');
});
