/**
 * The turnout / draw-out log — Form F.
 *
 * A secretary pulls the official turnout list no earlier than three hours
 * before a performance and writes down, for every no-show, which kind it was
 * and whether it costs the contestant money:
 *
 *   TO   turnout                 — did not compete, no notice
 *   NTO  notified turnout        — notice given in time, not fineable
 *   PTO  partial / permit turnout
 *   DR   doctor release          — documented, excused
 *   VI   visible injury          — judged in the arena, excused
 *   DO   draw-out                — pulled before the draw
 *
 * The one number that matters is fineable-or-not, because a turnout inside the
 * notice window carries a fine and a documented medical release does not. This
 * mirrors classifyTurnout() in entries/fees.ts but works on the LOG row a
 * secretary is filling in by hand, and it adds the team-roping rule Form F
 * calls out by name.
 *
 * Integer cents throughout, same as every other money path in the package.
 */

import type { ValidationIssue } from '../types/index.ts';

export type TurnoutLogType = 'TO' | 'NTO' | 'PTO' | 'DR' | 'VI' | 'DO';

/** Types that are excused: they never carry a fine and the fee comes back. */
const EXCUSED_TYPES = new Set<TurnoutLogType>(['DR', 'VI', 'DO']);

export interface TurnoutLogInput {
  log_type: TurnoutLogType;
  /** ISO timestamp the notice reached the office, if any. */
  notified_at?: string | null;
  /** ISO timestamp the performance starts. */
  performance_at?: string | null;
  /** PRCA wants 30 hours; producers may set their own ground rule. */
  required_notice_hours?: number;
  /** The fee at stake, in cents. */
  entry_fee_cents?: number;
  /** The fine the ground rules attach to a fineable turnout, in cents. */
  fine_amount_cents?: number;
  /**
   * Team roping only. The remaining partner must notify the secretary before
   * the cattle draw or the team still owes fees (Form F).
   */
  is_team_roping?: boolean;
  partner_notified?: boolean;
}

export interface TurnoutLogResult {
  log_type: TurnoutLogType;
  /** True when this turnout carries a fine under the ground rules. */
  fineable: boolean;
  /** Hours of notice given, or null when no notice time was recorded. */
  hours_notice: number | null;
  /** What the contestant still owes: unrefunded fee plus any fine. */
  fee_owed_cents: number;
  fine_cents: number;
  /** Whether the entry fee comes back to the contestant. */
  refund_due: boolean;
  issues: ValidationIssue[];
}

/**
 * Classify a single turnout-log row.
 *
 * A doctor release, visible injury or draw-out is excused: no fine, fee
 * refunded. A plain turnout is fineable unless notice was given in time; a
 * notified turnout (NTO) is never fineable. When a team roper turns out and the
 * partner did not tell the office before the cattle draw, the fee stands even
 * though the run did not happen.
 */
export function classifyTurnoutLog(input: TurnoutLogInput): TurnoutLogResult {
  const issues: ValidationIssue[] = [];
  const required = input.required_notice_hours ?? 30;
  const fee = Math.max(0, Math.round(input.entry_fee_cents ?? 0));
  const fine = Math.max(0, Math.round(input.fine_amount_cents ?? 0));

  let hours: number | null = null;
  if (input.notified_at && input.performance_at) {
    const ms = Date.parse(input.performance_at) - Date.parse(input.notified_at);
    if (Number.isFinite(ms)) hours = Math.round((ms / 3_600_000) * 10) / 10;
    else
      issues.push({
        field: 'notified_at',
        code: 'BAD_TIMESTAMP',
        severity: 'error',
        message: 'Could not read the notice or performance time.',
      });
  }

  const excused = EXCUSED_TYPES.has(input.log_type);
  const inTime =
    input.log_type === 'NTO' || (hours !== null && hours >= required);

  let fineable = false;
  if (!excused && input.log_type !== 'NTO') {
    // A plain turnout with no notice time recorded is treated as no notice,
    // which is fineable — the secretary can add a time to change that.
    fineable = !inTime;
  }

  if (fineable && !input.fine_amount_cents) {
    issues.push({
      field: 'fine_amount_cents',
      code: 'FINE_NOT_SET',
      severity: 'warning',
      message:
        'This turnout is fineable but no fine amount is set in the ground rules.',
    });
  }

  if (fineable && hours !== null) {
    issues.push({
      field: 'notified_at',
      code: 'SHORT_NOTICE',
      severity: 'warning',
      message:
        `${hours} hours' notice, ${required} required. This turnout is fineable.`,
    });
  }

  // Team-roping partner rule (Form F). If the surviving partner never told the
  // office before the cattle draw, the fee is owed regardless of the release.
  const partnerFeeStands =
    Boolean(input.is_team_roping) && input.partner_notified === false;
  if (partnerFeeStands) {
    issues.push({
      field: 'partner_notified',
      code: 'PARTNER_NOT_NOTIFIED',
      severity: 'warning',
      message:
        'Team roping: the remaining partner did not notify the office before ' +
        'the cattle draw, so the entry fee still stands.',
    });
  }

  const refundDue = (excused || inTime) && !partnerFeeStands;
  const feeOwed = (refundDue ? 0 : fee) + (fineable ? fine : 0);

  return {
    log_type: input.log_type,
    fineable,
    hours_notice: hours,
    fee_owed_cents: feeOwed,
    fine_cents: fineable ? fine : 0,
    refund_due: refundDue,
    issues,
  };
}

export interface TurnoutSummaryRow {
  log_type: TurnoutLogType;
  fineable?: boolean;
  fee_owed_cents?: number;
  fine_cents?: number;
}

export interface TurnoutSummary {
  total: number;
  by_type: Record<TurnoutLogType, number>;
  fineable_count: number;
  total_fees_owed_cents: number;
  total_fines_cents: number;
}

/**
 * Add up a turnout log for the fines list that travels with the results.
 */
export function summarizeTurnoutLog(rows: TurnoutSummaryRow[]): TurnoutSummary {
  const by_type: Record<TurnoutLogType, number> = {
    TO: 0,
    NTO: 0,
    PTO: 0,
    DR: 0,
    VI: 0,
    DO: 0,
  };
  let fineable_count = 0;
  let fees = 0;
  let fines = 0;

  for (const r of rows) {
    if (r.log_type in by_type) by_type[r.log_type] += 1;
    if (r.fineable) fineable_count += 1;
    fees += Math.max(0, Math.round(r.fee_owed_cents ?? 0));
    fines += Math.max(0, Math.round(r.fine_cents ?? 0));
  }

  return {
    total: rows.length,
    by_type,
    fineable_count,
    total_fees_owed_cents: fees,
    total_fines_cents: fines,
  };
}
