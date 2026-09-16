/**
 * Two-timer reconciliation — Form D.
 *
 * Every timed run is caught on two watches (Timer 1 and Timer 2), and often an
 * electric eye as well. The official time is not "whichever the announcer
 * liked": there is a rule, and this applies it the same way every time so a
 * contestant cannot argue the office rounded against them.
 *
 *   * If the electric eye recorded a valid time, that is the official base
 *     time. The two hand watches are the backup that proves the eye.
 *   * With no eye (or a failed eye), the base time is the AVERAGE of the two
 *     hand watches, carried to the thousandth.
 *   * With only one watch and no eye, that single watch is used, but it is
 *     flagged — a time on one watch is a time nobody can check.
 *   * The barrier penalty (ten seconds at most rodeos) and any other field
 *     penalty are added to the base to make the official time.
 *   * A no-time (broke the barrier and missed, no catch, etc.) has no official
 *     time at all.
 *
 * The two watches disagreeing by more than a small margin is the single most
 * common timing dispute, so a discrepancy over the threshold is surfaced for
 * the barrier judge to settle rather than silently averaged away.
 *
 * Seconds are handled as numbers rounded to the thousandth. The database column
 * is numeric(7,3); nothing here ever lets a floating-point tail reach it.
 */

import type { ValidationIssue } from '../types/index.ts';

/** Round to milliseconds without a binary floating-point tail. */
function toMillis(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

export interface TimerReconcileInput {
  /** Timer 1 raw seconds, before penalties. */
  timer1_seconds?: number | null;
  /** Timer 2 raw seconds, before penalties. */
  timer2_seconds?: number | null;
  /** Electric-eye seconds, when a working eye caught the run. */
  electric_eye_seconds?: number | null;

  /** Barrier penalty in seconds (typically 10). Defaults to 0. */
  barrier_penalty_seconds?: number;
  /** Any other field penalties in seconds (e.g. broken pattern time adds). */
  other_penalty_seconds?: number;

  /** No official time: no catch, missed, disqualified run. */
  no_time?: boolean;
  /** The contestant turned out — recorded, no time. */
  turnout?: boolean;

  /**
   * Watches disagreeing by more than this many seconds is flagged for the
   * barrier judge. Defaults to 0.1s, which is the common hand-timing tolerance.
   */
  discrepancy_threshold_seconds?: number;
}

export interface TimerReconcileResult {
  /** The base time before penalties: eye time, or the average of two watches. */
  base_seconds: number | null;
  /** How the base was arrived at. */
  base_source: 'electric_eye' | 'two_watch_average' | 'single_watch' | 'none';
  penalty_seconds: number;
  /** base + penalties, or null for a no-time. */
  official_seconds: number | null;
  /** Absolute difference between the two hand watches, when both are present. */
  watch_spread_seconds: number | null;
  /** True when the two watches are within tolerance (or not both present). */
  watches_agree: boolean;
  no_time: boolean;
  issues: ValidationIssue[];
}

/**
 * Reconcile the two watches and the eye into one official time.
 */
export function reconcileTimers(
  input: TimerReconcileInput,
): TimerReconcileResult {
  const issues: ValidationIssue[] = [];
  const threshold = input.discrepancy_threshold_seconds ?? 0.1;

  const t1 =
    input.timer1_seconds != null && input.timer1_seconds >= 0
      ? toMillis(input.timer1_seconds)
      : null;
  const t2 =
    input.timer2_seconds != null && input.timer2_seconds >= 0
      ? toMillis(input.timer2_seconds)
      : null;
  const eye =
    input.electric_eye_seconds != null && input.electric_eye_seconds >= 0
      ? toMillis(input.electric_eye_seconds)
      : null;

  const barrier = Math.max(0, toMillis(input.barrier_penalty_seconds ?? 0));
  const other = Math.max(0, toMillis(input.other_penalty_seconds ?? 0));
  const penalty = toMillis(barrier + other);

  // A no-time or turnout has no official time regardless of the watches.
  if (input.no_time || input.turnout) {
    const spread = t1 != null && t2 != null ? toMillis(Math.abs(t1 - t2)) : null;
    return {
      base_seconds: null,
      base_source: 'none',
      penalty_seconds: penalty,
      official_seconds: null,
      watch_spread_seconds: spread,
      watches_agree: true,
      no_time: true,
      issues,
    };
  }

  // Watch spread and agreement.
  let spread: number | null = null;
  let watchesAgree = true;
  if (t1 != null && t2 != null) {
    spread = toMillis(Math.abs(t1 - t2));
    if (spread > threshold) {
      watchesAgree = false;
      issues.push({
        field: 'timer2_seconds',
        code: 'WATCH_DISCREPANCY',
        severity: 'warning',
        message:
          `The two watches differ by ${spread.toFixed(3)}s ` +
          `(over the ${threshold}s tolerance). The barrier judge should settle it.`,
      });
    }
  }

  // Base time: eye first, then the average of two watches, then a single watch.
  let base: number | null = null;
  let source: TimerReconcileResult['base_source'] = 'none';

  if (eye != null) {
    base = eye;
    source = 'electric_eye';
    if (t1 != null && t2 != null) {
      const avg = toMillis((t1 + t2) / 2);
      if (Math.abs(avg - eye) > Math.max(threshold, 0.05)) {
        issues.push({
          field: 'electric_eye_seconds',
          code: 'EYE_WATCH_MISMATCH',
          severity: 'warning',
          message:
            `The electric eye (${eye.toFixed(3)}s) and the watch average ` +
            `(${avg.toFixed(3)}s) disagree. Confirm the eye before it is official.`,
        });
      }
    }
  } else if (t1 != null && t2 != null) {
    base = toMillis((t1 + t2) / 2);
    source = 'two_watch_average';
  } else if (t1 != null || t2 != null) {
    base = (t1 ?? t2) as number;
    source = 'single_watch';
    issues.push({
      field: 'timer2_seconds',
      code: 'SINGLE_WATCH',
      severity: 'warning',
      message:
        'Only one watch has a time and there is no electric eye. A time on ' +
        'one watch cannot be checked — record the second watch if you can.',
    });
  } else {
    issues.push({
      field: 'timer1_seconds',
      code: 'NO_TIME_RECORDED',
      severity: 'error',
      message: 'No watch time and no electric-eye time were recorded.',
    });
  }

  const official = base == null ? null : toMillis(base + penalty);

  return {
    base_seconds: base,
    base_source: source,
    penalty_seconds: penalty,
    official_seconds: official,
    watch_spread_seconds: spread,
    watches_agree: watchesAgree,
    no_time: false,
    issues,
  };
}
