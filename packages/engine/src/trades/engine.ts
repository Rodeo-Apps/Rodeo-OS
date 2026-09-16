/**
 * Position trades — Form E.
 *
 * A contestant can sometimes swap the performance or slack they are drawn into
 * for another one. The rule book is strict about when, and getting it wrong is
 * how a rodeo ends up with two people in one position or a trade that should
 * never have been allowed:
 *
 *   * Only where the book permits it — performance-preference rodeos, and
 *     second and later go-rounds. Never in a first go-round unless the ground
 *     rules say so.
 *   * Never inside the same performance or the same slack. A trade moves a
 *     contestant BETWEEN sections; it is not a re-order within one.
 *   * Riding events are due before the stock draw for the section being traded
 *     into. Timed events are due when the last time of the first head is
 *     recorded (or earlier if the book says so).
 *   * At PRCA and WPRA, two trades per contestant per go-round.
 *
 * This validates a proposed trade against those rules. It never reads a clock:
 * the caller passes `now`, the draw/first-head deadline, and how many trades
 * the contestant has already made this go-round.
 */

import type { ValidationIssue } from '../types/index.ts';

export type TradeDiscipline = 'riding' | 'timed';

export interface TradeSection {
  /** Performance number, or null for slack. */
  performance_number: number | null;
  /** True when the section is slack rather than a numbered performance. */
  is_slack?: boolean;
  position?: number | null;
}

export interface TradeInput {
  discipline: TradeDiscipline;
  go_round_number: number;

  from: TradeSection;
  to: TradeSection;

  /** Ground rules allow trades at all for this rodeo/event. */
  trades_allowed: boolean;

  /**
   * The deadline for the section being traded into: the riding-event stock
   * draw time, or the timed-event first-head last-time. ISO timestamp.
   */
  deadline_at?: string | null;
  /** ISO timestamp of the trade request. The engine never reads a clock. */
  now?: string | null;

  /** How many trades this contestant has already made this go-round. */
  existing_trades_this_go?: number;
  /** PRCA / WPRA default of two. */
  max_trades_per_go?: number;

  /** True when trading into an OPEN position freed by a TO/DR/VI/DO. */
  is_open?: boolean;
}

export interface TradeValidation {
  ok: boolean;
  /** The 1-based number of this trade in the go-round (1 or 2 at PRCA/WPRA). */
  trade_number: number;
  trades_remaining: number;
  issues: ValidationIssue[];
}

function sameSection(a: TradeSection, b: TradeSection): boolean {
  const aSlack = Boolean(a.is_slack);
  const bSlack = Boolean(b.is_slack);
  if (aSlack || bSlack) {
    // Two slack sections in the same perf slot are "the same slack"; a slack
    // and a performance are never the same section.
    return aSlack && bSlack && a.performance_number === b.performance_number;
  }
  return a.performance_number === b.performance_number;
}

/**
 * Check a proposed trade.
 *
 * Every problem is reported at once so the secretary fixes the whole thing in
 * one pass rather than being told one rule at a time.
 */
export function validateTrade(input: TradeInput): TradeValidation {
  const issues: ValidationIssue[] = [];
  const max = Math.max(1, input.max_trades_per_go ?? 2);
  const already = Math.max(0, input.existing_trades_this_go ?? 0);

  if (!input.trades_allowed) {
    issues.push({
      field: 'trades_allowed',
      code: 'TRADES_NOT_ALLOWED',
      severity: 'error',
      message:
        'The ground rules and the book do not allow a position trade here.',
    });
  }

  if (input.go_round_number < 1) {
    issues.push({
      field: 'go_round_number',
      code: 'BAD_GO_ROUND',
      severity: 'error',
      message: 'The go-round number must be 1 or more.',
    });
  }

  // The core rule: a trade moves a contestant between sections.
  if (sameSection(input.from, input.to)) {
    issues.push({
      field: 'to',
      code: 'SAME_SECTION',
      severity: 'error',
      message:
        'A trade cannot be inside the same performance or the same slack. ' +
        'It has to move the contestant to a different section.',
    });
  }

  // The deadline. Riding events close at the stock draw; timed events at the
  // first-head last time. Same field, different meaning by discipline.
  if (input.deadline_at && input.now) {
    const now = Date.parse(input.now);
    const deadline = Date.parse(input.deadline_at);
    if (Number.isFinite(now) && Number.isFinite(deadline) && now > deadline) {
      issues.push({
        field: 'deadline_at',
        code: input.discipline === 'riding' ? 'PAST_STOCK_DRAW' : 'PAST_FIRST_HEAD',
        severity: 'error',
        message:
          input.discipline === 'riding'
            ? 'Riding-event trades are due before the stock draw for that section.'
            : 'Timed-event trades are due by the last time of the first head.',
      });
    }
  }

  // The limit.
  const remainingBefore = max - already;
  if (remainingBefore <= 0) {
    issues.push({
      field: 'existing_trades_this_go',
      code: 'TRADE_LIMIT_REACHED',
      severity: 'error',
      message: `Already used ${already} of ${max} trades allowed this go-round.`,
    });
  }

  const ok = !issues.some((i) => i.severity === 'error');
  const tradeNumber = ok ? already + 1 : already;
  const remaining = Math.max(0, max - (ok ? tradeNumber : already));

  return {
    ok,
    trade_number: tradeNumber,
    trades_remaining: remaining,
    issues,
  };
}

/** How many trades a contestant has left this go-round. */
export function tradesRemaining(
  existing_trades_this_go: number,
  max_trades_per_go = 2,
): number {
  return Math.max(0, max_trades_per_go - Math.max(0, existing_trades_this_go));
}
