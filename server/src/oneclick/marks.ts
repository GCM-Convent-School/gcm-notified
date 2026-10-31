// Marks statements: one message per student covering a set of tests, with a fair section rank.
//
// Used by the Daily Marks Report (everything added since the last run) and by manual 1-Click marks.
// Pure functions only — fetching from Frappe and sending live in marks-report.service.ts / oneclick.service.ts.

import { fmtDate, num, StudentVars } from './build';

/** One submitted Assessment Result from Frappe (one student, one test). */
export interface Result {
  name: string; student: string; student_name?: string | null; assessment_plan: string; assessment_group?: string | null;
  course?: string | null; student_group?: string | null; program?: string | null;
  total_score?: number | null; maximum_score?: number | null; creation: string; amended_from?: string | null; comment?: string | null;
  held_on?: string | null;   // the test's date (Assessment Plan schedule_date) when Frappe lets us read it
}

export interface RankRules {
  minRanked: number;       // at least this many students must be ranked in the section…
  minEnteredPct: number;   // …and at least this share of the section, otherwise no rank line for anyone
  topPct: number;          // top share that sees its rank; the rest get the encouragement note
}
export const DEFAULT_RULES: RankRules = { minRanked: 8, minEnteredPct: 70, topPct: 70 };

export type Band = 'top' | 'bottom' | 'none';
export interface Standing { band: Band; rank?: number; of?: number; reason?: string }


const score = (r: Result) => Number(r.total_score ?? 0);
const maxOf = (r: Result) => Number(r.maximum_score ?? 0);
/** A zero (or a comment saying absent) counts as absent: the marks are shown, but the student is not ranked. */
export const isAbsent = (r: Result) => !(score(r) > 0) || /absent|\bab\b/i.test(String(r.comment ?? ''));
export const testName = (r: Result) => [r.course, r.assessment_group].filter(Boolean).join(' – ') || r.assessment_plan;

/**
 * Section rank of every student for the tests in `plans`, against everyone in the same section
 * who sat all of those tests (absent in any → not ranked). Equal scores share a rank (1, 2, 2, 4).
 * The whole section gets no rank when too few were ranked to be fair.
 */
export function standings(cohort: Result[], plans: string[], sectionSize: number, rules: RankRules): Map<string, Standing> {
  const want = new Set(plans);
  const by = new Map<string, Result[]>();
  for (const r of cohort) if (want.has(r.assessment_plan)) by.set(r.student, [...(by.get(r.student) ?? []), r]);
  const ranked: { student: string; pct: number }[] = [];
  const out = new Map<string, Standing>();
  for (const [student, list] of by) {
    const sat = new Set(list.filter((r) => !isAbsent(r)).map((r) => r.assessment_plan));
    if (sat.size < want.size) { out.set(student, { band: 'none', reason: 'absent' }); continue; }
    const max = list.reduce((a, r) => a + maxOf(r), 0);
    ranked.push({ student, pct: max ? list.reduce((a, r) => a + score(r), 0) / max : 0 });
  }
  const size = Math.max(sectionSize, by.size);
  if (ranked.length < rules.minRanked || ranked.length * 100 < size * rules.minEnteredPct) {
    for (const r of ranked) out.set(r.student, { band: 'none', reason: `only ${ranked.length} of ${size} ranked` });
    return out;
  }
  ranked.sort((a, b) => b.pct - a.pct);
  const cut = Math.ceil((ranked.length * rules.topPct) / 100);
  let rank = 0;
  ranked.forEach((r, i) => {
    if (i === 0 || Math.abs(r.pct - ranked[i - 1].pct) > 1e-9) rank = i + 1;
    // A tie at the cut-off stays on top: equal scores are always treated the same
    out.set(r.student, { band: rank <= cut ? 'top' : 'bottom', rank, of: ranked.length });
  });
  return out;
}

export interface Lines { rankLine: string; bottomLine: string }
export const DEFAULT_LINES: Lines = {
  rankLine: '🏅 Class rank: *{{rank}}* of {{of}} in {{section}}',
  bottomLine: "{{first_name}}'s scores were below most of the class. Please spend some time revising these topics at home.",
};
const fill = (t: string, v: Record<string, string | number>) => t.replace(/{{\s*(\w+)\s*}}/g, (_, k) => String(v[k] ?? ''));

export interface StatementOptions {
  items: Result[];                              // what each student's message lists (e.g. not yet sent)
  cohort: Result[];                             // every result of those tests, for ranking
  sectionSizes: Map<string, number>;            // section (Frappe student group) → active students
  rules: RankRules; lines: Lines; period: string;
}

/** One statement per Frappe student: the tests, total, percent and the rank line (or the note, or nothing). */
export function buildStatements(o: StatementOptions): Map<string, StudentVars & { standing: Standing; results: string[] }> {
  const by = new Map<string, Result[]>();
  for (const r of o.items) by.set(r.student, [...(by.get(r.student) ?? []), r]);
  const cache = new Map<string, Map<string, Standing>>();
  const out = new Map<string, StudentVars & { standing: Standing; results: string[] }>();
  for (const [student, list] of by) {
    list.sort((a, b) => testName(a).localeCompare(testName(b)));
    const section = list[0].student_group ?? '';
    const plans = [...new Set(list.map((r) => r.assessment_plan))].sort();
    const key = `${section}|${plans.join(',')}`;
    if (!cache.has(key)) {
      const peers = o.cohort.filter((r) => (r.student_group ?? '') === section);
      cache.set(key, standings(peers, plans, o.sectionSizes.get(section) ?? 0, o.rules));
    }
    const st = cache.get(key)!.get(student) ?? { band: 'none' as const };
    const total = list.reduce((a, r) => a + score(r), 0);
    const max = list.reduce((a, r) => a + maxOf(r), 0);
    const percent = max ? Math.round((total / max) * 1000) / 10 : 0;
    const first = String(list[0].student_name ?? '').split(/\s+/)[0] || 'Your child';
    const v = { rank: st.rank ?? '', of: st.of ?? '', section, first_name: first };
    const rankLine = st.band === 'top' ? fill(o.lines.rankLine, v) : st.band === 'bottom' ? fill(o.lines.bottomLine, v) : '';
    const marks = list.map((r) => `• ${testName(r)}${r.held_on ? ` (${shortDate(r.held_on)})` : ''}: ${num(score(r))}/${num(maxOf(r))}`).join('\n');
    out.set(student, {
      standing: st, results: list.map((r) => r.name),
      summary: `${num(total)}/${num(max)} · ${percent}%${st.band === 'top' ? ` · #${st.rank}/${st.of}` : st.band === 'bottom' ? ` · bottom ${100 - o.rules.topPct}%` : ''}`,
      vars: {
        period: o.period, exam: o.period, marks, total: num(total), max: num(max), percent: String(percent), test_count: String(list.length),
        // Only the top band ever sees a number, even if a custom template uses {{rank}} directly
        rank: st.band === 'top' ? String(st.rank) : '', rank_of: st.band === 'top' ? String(st.of) : '', rank_line: rankLine,
        tests: list.map((r) => ({ name: testName(r), date: r.held_on ? shortDate(r.held_on) : '', score: num(score(r)), max: num(maxOf(r)) })),
      },
    });
  }
  return out;
}

const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** "Marks added today (30 Oct 2026)" / "Marks added 24 Oct – 30 Oct 2026" */
export function periodLabel(from: string, to: string, what: 'added' | 'held'): string {
  const verb = what === 'held' ? 'Tests held' : 'Marks added';
  return from === to ? `${verb} on ${fmtDate(from)}` : `${verb} ${fmtDate(from)} – ${fmtDate(to)}`;
}

/** Tests whose marks look half-entered (fewer than `pct`% of the section has a result). */
export function incompleteTests(cohort: Result[], sectionSizes: Map<string, number>, pct: number): Map<string, { name: string; section: string; entered: number; size: number }> {
  const by = new Map<string, Result[]>();
  for (const r of cohort) by.set(r.assessment_plan, [...(by.get(r.assessment_plan) ?? []), r]);
  const out = new Map<string, { name: string; section: string; entered: number; size: number }>();
  for (const [plan, list] of by) {
    const section = list[0].student_group ?? '';
    const size = sectionSizes.get(section) ?? 0;
    const entered = new Set(list.map((r) => r.student)).size;
    if (size && entered * 100 < size * pct) out.set(plan, { name: testName(list[0]), section, entered, size });
  }
  return out;
}

/** Frappe datetime string ("2026-10-29 11:14:16.566") shifted by whole days, same format. */
export function shiftFrappeTime(t: string, days: number): string {
  const d = new Date(`${t.slice(0, 19).replace(' ', 'T')}Z`);
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
}
