// Turns Frappe rows into per-student message variables for 1-Click notifications.

export interface FeeRow {
  name: string; student: string; outstanding_amount?: number | null; grand_total?: number | null; due_date?: string | null;
  academic_term?: string | null; fee_structure?: string | null; fee_schedule?: string | null; posting_date?: string | null;
}
export interface StudentVars { summary: string; vars: Record<string, unknown> }

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
export const rupees = (n: number) => `₹${inr.format(Math.round(n * 100) / 100)}`;
export const num = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));
export const fmtDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** One message per student: everything still outstanding (optionally only what is due by a date). */
export function buildFees(rows: FeeRow[], opts: { dueBy?: string | null; minAmount?: number } = {}): Map<string, StudentVars> {
  const by = new Map<string, FeeRow[]>();
  for (const r of rows) {
    if (!r.student || !(Number(r.outstanding_amount) > 0)) continue;
    if (opts.dueBy && r.due_date && r.due_date > opts.dueBy) continue;
    by.set(r.student, [...(by.get(r.student) ?? []), r]);
  }
  const out = new Map<string, StudentVars>();
  for (const [student, list] of by) {
    list.sort((a, b) => String(a.due_date ?? '').localeCompare(String(b.due_date ?? '')));
    const amount = list.reduce((a, r) => a + Number(r.outstanding_amount), 0);
    if (opts.minAmount && amount < opts.minAmount) continue;
    const label = (r: FeeRow) => String(r.academic_term || r.fee_structure || r.fee_schedule || 'Fees').trim();
    const feeList = list.map((r) => `• ${label(r)} — ${rupees(Number(r.outstanding_amount))}${r.due_date ? ` (due ${fmtDate(r.due_date)})` : ''}`).join('\n');
    const due = list.find((r) => r.due_date)?.due_date ?? null;
    out.set(student, {
      summary: `${rupees(amount)}${list.length > 1 ? ` · ${list.length} fees` : ''}`,
      vars: {
        amount: rupees(amount), amount_number: num(amount), fee_list: feeList, fee_count: String(list.length),
        due_date: due ? fmtDate(due) : '', fees: list.map((r) => ({ name: label(r), amount: rupees(Number(r.outstanding_amount)), due_date: r.due_date ? fmtDate(r.due_date) : '' })),
      },
    });
  }
  return out;
}
