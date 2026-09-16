/**
 * Rule infractions and field fines — Form G.
 *
 * Barrier breaks, field fines, conduct calls. The rules that matter for the
 * office are procedural, not arithmetic:
 *
 *   * Barrier and field fines are verified with the barrier judge after each
 *     section. An unverified barrier fine is a draft, not a posted fine.
 *   * The sheet is posted in the office (except on the last performance), and
 *     "a contestant may not talk a posted mark off the sheet" — so once a fine
 *     is posted it is immutable. A correction is a NEW infraction that
 *     references the posted one, exactly the way the money ledger records a
 *     correction as a new row. The database enforces the immutability; this
 *     engine decides whether a fine is ready to post and whether it may still
 *     be edited.
 *
 * Cents throughout.
 */

import type { ValidationIssue } from '../types/index.ts';

export type InfractionType = 'barrier' | 'field' | 'conduct' | 'stock' | 'other';

/** Fine types that the barrier judge has to verify before they can post. */
const BARRIER_JUDGE_VERIFIES = new Set<InfractionType>(['barrier', 'field']);

export interface InfractionInput {
  infraction_type: InfractionType;
  fine_cents?: number;
  rule_code?: string | null;
  /** The judge making the call. */
  judge_id?: string | null;
  /** Set true when the barrier judge has signed off after the section. */
  verified_by_barrier_judge?: boolean;
  /** Already posted — used to answer canEdit. */
  posted_at?: string | null;
}

export interface InfractionValidation {
  /** No errors — the draft is well-formed. */
  valid: boolean;
  /** Well-formed AND cleared to go on the posted sheet. */
  can_post: boolean;
  /** False once posted_at is set: a posted fine is immutable. */
  can_edit: boolean;
  issues: ValidationIssue[];
}

/**
 * Validate an infraction, and say whether it is ready to post.
 */
export function validateInfraction(
  input: InfractionInput,
): InfractionValidation {
  const issues: ValidationIssue[] = [];
  const fine = Math.round(input.fine_cents ?? 0);

  if (fine < 0) {
    issues.push({
      field: 'fine_cents',
      code: 'NEGATIVE_FINE',
      severity: 'error',
      message: 'A fine cannot be negative.',
    });
  }

  if (!input.judge_id) {
    issues.push({
      field: 'judge_id',
      code: 'NO_JUDGE',
      severity: 'warning',
      message: 'No judge is recorded against this call.',
    });
  }

  // A fineable infraction with no rule cited is the kind that gets protested.
  if (fine > 0 && !input.rule_code) {
    issues.push({
      field: 'rule_code',
      code: 'NO_RULE_CITED',
      severity: 'warning',
      message: 'A fine with no rule number cited is hard to defend on protest.',
    });
  }

  const needsBarrierJudge = BARRIER_JUDGE_VERIFIES.has(input.infraction_type);
  const verified = Boolean(input.verified_by_barrier_judge);
  if (needsBarrierJudge && !verified) {
    issues.push({
      field: 'verified_by_barrier_judge',
      code: 'BARRIER_JUDGE_UNVERIFIED',
      severity: 'warning',
      message:
        'Barrier and field fines are verified with the barrier judge after ' +
        'the section before they can be posted.',
    });
  }

  const valid = !issues.some((i) => i.severity === 'error');
  const alreadyPosted = Boolean(input.posted_at);

  // Ready to post when it is well-formed and, for barrier/field fines, the
  // barrier judge has verified it.
  const canPost =
    valid && !alreadyPosted && (!needsBarrierJudge || verified);

  return {
    valid,
    can_post: canPost,
    // Once posted, immutable. Correct it with a new referencing row.
    can_edit: !alreadyPosted,
    issues,
  };
}

export interface InfractionSummaryRow {
  infraction_type?: InfractionType | string;
  fine_cents?: number;
  posted_at?: string | null;
}

export interface InfractionSummary {
  total: number;
  posted: number;
  drafts: number;
  total_fines_cents: number;
  posted_fines_cents: number;
  by_type: Record<string, { count: number; fines_cents: number }>;
}

/**
 * Add up the infraction sheet for the fines list that leaves with results.
 * Only posted fines count towards money owed; drafts are shown separately so a
 * secretary knows what is still hanging.
 */
export function summarizeInfractions(
  rows: InfractionSummaryRow[],
): InfractionSummary {
  const by_type: Record<string, { count: number; fines_cents: number }> = {};
  let posted = 0;
  let totalFines = 0;
  let postedFines = 0;

  for (const r of rows) {
    const type = r.infraction_type ?? 'other';
    const fine = Math.max(0, Math.round(r.fine_cents ?? 0));
    const isPosted = Boolean(r.posted_at);

    by_type[type] ??= { count: 0, fines_cents: 0 };
    by_type[type].count += 1;
    by_type[type].fines_cents += fine;

    totalFines += fine;
    if (isPosted) {
      posted += 1;
      postedFines += fine;
    }
  }

  return {
    total: rows.length,
    posted,
    drafts: rows.length - posted,
    total_fines_cents: totalFines,
    posted_fines_cents: postedFines,
    by_type,
  };
}
