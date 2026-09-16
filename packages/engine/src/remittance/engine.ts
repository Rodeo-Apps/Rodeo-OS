/**
 * Close-out remittance — Form M.
 *
 * ---------------------------------------------------------------------------
 * THE MOMENT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * The rodeo is over. The cash box is on the table, the payoff checks are
 * signed, and before the secretary drives home she has to say, on one cover
 * sheet, where every dollar went: what came in, what was paid out, what was
 * sent to the association, and what she is depositing. If the cover sheet does
 * not tie out to the cash in the box she does not get to leave — she gets to
 * count it again at midnight.
 *
 * So this module answers one question and answers it exactly: **does the money
 * balance, and if not, by how much and where.** It is deliberately small and
 * it does no I/O. "Cash in the box" is a number passed in, so the arithmetic
 * is testable and reproducible.
 *
 * ---------------------------------------------------------------------------
 * THE ACCOUNTING (all integer cents)
 * ---------------------------------------------------------------------------
 * Money that came IN across the secretary's desk:
 *     fees_collected + fines_collected + stalls_camp_gate
 *
 * Money that went OUT of the desk before the deposit:
 *     prize_paid + assn_cut_sent + unclaimed_sent
 *
 * What should therefore be left to deposit:
 *     expected_deposit = money_in - money_out
 *
 * And the reconciliation the secretary actually cares about:
 *     over_short = actual_deposit - expected_deposit
 *
 * over_short of zero is a balanced book. Positive is "more in the bag than the
 * math says" (an over); negative is a shortage. Either way it is surfaced with
 * the exact figure, never rounded away — a book that balances by rounding is a
 * book that does not balance.
 */

import type { ValidationIssue } from '../types/index.ts';

/** The money lines off Form M, in integer cents. */
export interface RemittanceInput {
  /** Entry fees taken in. */
  fees_collected_cents: number;
  /** Barrier / field / conduct fines taken in. */
  fines_collected_cents: number;
  /** Stalls, camping and gate receipts handled at the desk. */
  stalls_camp_gate_cents: number;

  /** Prize / day money paid out from the desk. */
  prize_paid_cents: number;
  /** The association's cut remitted with the results. */
  assn_cut_sent_cents: number;
  /** Unclaimed checks sent to the association office. */
  unclaimed_sent_cents: number;

  /**
   * What was actually deposited (counted into the bag / slip). Null when the
   * deposit has not been made yet — the sheet still shows the expected figure.
   */
  deposit_cents?: number | null;

  /**
   * Optional cross-check against the books. When the payout engine and the
   * close-out engine were fed the same rodeo they must agree; a mismatch here
   * means one of the two was edited by hand.
   */
  ledger?: RemittanceLedger | null;
}

/** Expected figures from the books, for the optional cross-check. */
export interface RemittanceLedger {
  /** Net purse actually paid out, from the payout engine. */
  prize_paid_cents?: number | null;
  /** Association deduction the books engine computed. */
  assn_cut_cents?: number | null;
  /** Entry fees the books say were collected. */
  fees_collected_cents?: number | null;
}

export interface RemittanceResult {
  money_in_cents: number;
  money_out_cents: number;
  /** money_in - money_out: what should be in the deposit. */
  expected_deposit_cents: number;
  /** actual deposit - expected, or null when no deposit is recorded yet. */
  over_short_cents: number | null;
  /** True only when a deposit is recorded and ties out to the cent. */
  balanced: boolean;
  issues: ValidationIssue[];
}

const CATEGORIES: {
  field: keyof RemittanceInput;
  label: string;
  direction: 'in' | 'out';
}[] = [
  { field: 'fees_collected_cents', label: 'Fees collected', direction: 'in' },
  { field: 'fines_collected_cents', label: 'Fines collected', direction: 'in' },
  { field: 'stalls_camp_gate_cents', label: 'Stalls / camp / gate', direction: 'in' },
  { field: 'prize_paid_cents', label: 'Prize money paid', direction: 'out' },
  { field: 'assn_cut_sent_cents', label: 'Association cut sent', direction: 'out' },
  { field: 'unclaimed_sent_cents', label: 'Unclaimed sent', direction: 'out' },
];

/**
 * Reconcile the close-out cover sheet.
 *
 * Every money line is expected to be a whole, non-negative number of cents. A
 * negative line is a data-entry error (you cannot collect negative fees) and
 * is reported rather than quietly netted off against another line.
 */
export function reconcileRemittance(input: RemittanceInput): RemittanceResult {
  const issues: ValidationIssue[] = [];

  const val = (field: keyof RemittanceInput): number => {
    const raw = input[field];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  };

  for (const c of CATEGORIES) {
    const v = val(c.field);
    if (!Number.isInteger(v)) {
      issues.push({
        field: c.field,
        code: 'NON_INTEGER_CENTS',
        severity: 'error',
        message: `${c.label} must be a whole number of cents.`,
      });
    }
    if (v < 0) {
      issues.push({
        field: c.field,
        code: 'NEGATIVE_AMOUNT',
        severity: 'error',
        message: `${c.label} cannot be negative.`,
      });
    }
  }

  const moneyIn =
    val('fees_collected_cents') +
    val('fines_collected_cents') +
    val('stalls_camp_gate_cents');
  const moneyOut =
    val('prize_paid_cents') +
    val('assn_cut_sent_cents') +
    val('unclaimed_sent_cents');
  const expected = moneyIn - moneyOut;

  if (expected < 0) {
    issues.push({
      field: 'prize_paid_cents',
      code: 'PAID_OVER_TAKEN',
      severity: 'warning',
      message:
        'More money left the desk than came across it. That is normal when ' +
        'added money is paid from the producer account, but confirm the ' +
        'deposit is meant to be negative.',
    });
  }

  const deposit =
    input.deposit_cents != null && Number.isFinite(input.deposit_cents)
      ? input.deposit_cents
      : null;

  let overShort: number | null = null;
  let balanced = false;

  if (deposit == null) {
    issues.push({
      field: 'deposit_cents',
      code: 'DEPOSIT_MISSING',
      severity: 'warning',
      message: `No deposit recorded yet. Expecting ${cents(expected)}.`,
    });
  } else {
    if (!Number.isInteger(deposit)) {
      issues.push({
        field: 'deposit_cents',
        code: 'NON_INTEGER_CENTS',
        severity: 'error',
        message: 'Deposit must be a whole number of cents.',
      });
    }
    overShort = deposit - expected;
    balanced = overShort === 0;
    if (!balanced) {
      const word = overShort > 0 ? 'over' : 'short';
      issues.push({
        field: 'deposit_cents',
        code: 'OUT_OF_BALANCE',
        severity: 'error',
        message:
          `Deposit is ${cents(Math.abs(overShort))} ${word}: counted ` +
          `${cents(deposit)} against an expected ${cents(expected)}.`,
      });
    }
  }

  // Optional cross-check against the books. These are warnings, not blockers —
  // a difference is a flag to look, not a refusal to file.
  const led = input.ledger;
  if (led) {
    compareLedger(
      issues,
      'prize_paid_cents',
      'Prize money paid',
      val('prize_paid_cents'),
      led.prize_paid_cents,
    );
    compareLedger(
      issues,
      'assn_cut_sent_cents',
      'Association cut',
      val('assn_cut_sent_cents'),
      led.assn_cut_cents,
    );
    compareLedger(
      issues,
      'fees_collected_cents',
      'Fees collected',
      val('fees_collected_cents'),
      led.fees_collected_cents,
    );
  }

  return {
    money_in_cents: moneyIn,
    money_out_cents: moneyOut,
    expected_deposit_cents: expected,
    over_short_cents: overShort,
    balanced,
    issues,
  };
}

function compareLedger(
  issues: ValidationIssue[],
  field: string,
  label: string,
  entered: number,
  expected: number | null | undefined,
): void {
  if (expected == null || !Number.isFinite(expected)) return;
  if (entered !== expected) {
    issues.push({
      field,
      code: 'LEDGER_MISMATCH',
      severity: 'warning',
      message:
        `${label} on the cover sheet (${cents(entered)}) does not match the ` +
        `books (${cents(expected)}). Check which one is right before sending.`,
    });
  }
}

function cents(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(
    abs % 100,
  ).padStart(2, '0')}`;
}
