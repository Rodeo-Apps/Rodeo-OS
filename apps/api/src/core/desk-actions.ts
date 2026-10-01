/**
 * What the secretary does at the desk during a performance.
 *
 * ---------------------------------------------------------------------------
 * ONE PATH PER ACTION, WHETHER THE WIFI IS UP OR NOT
 * ---------------------------------------------------------------------------
 * Every action here is called by two things: the live route the screen posts
 * to while there is a signal, and POST /sync draining the queue she built up
 * while there was not. They are the same functions on purpose. A score that
 * arrives by sync goes through the same engine call as a score typed online; a
 * turnout recorded at 7:40 with no signal is classified against 7:40, not
 * against the moment the link came back; a cash envelope is recalculated on
 * the server and never taken on the laptop's word.
 *
 * Nothing here opens a transaction. Each function runs inside whatever the
 * caller holds — a request's transaction, or one change's savepoint inside a
 * sync batch — so a refusal rolls back only what it touched.
 * ---------------------------------------------------------------------------
 */

import {
  calculateJudgedScore,
  calculateMultiRoundPayout,
  calculatePayout,
  calculateTimedScore,
  classifyTurnout,
  compareJudgedTotal,
  compareTimedCard,
  computeResults,
  expandTeamResults,
  type CrossCheck,
  type CrossCheckResult,
  type JudgeScoreInput,
  type PayoutResult,
  type PointsConfig,
  type ScoreResult,
  type ScoringConfig,
  type TurnoutResult,
  type ValidationIssue,
} from '@rodeo-os/engine';

import type { Tx } from './database/client.ts';
import * as entriesRepo from './database/entries-repo.ts';
import * as repo from './database/repositories.ts';
import { refundEntry, settleBatch } from './settlement.ts';

// ===========================================================================
// Scoring a run
// ===========================================================================

export interface RunSubmission {
  entry_id: string;
  contestant_id: string;
  go_round?: number;
  performance?: number;
  animal_id?: string;
  scoring_config_id: string;
  source?: string;
  hardware_timestamp?: number;

  judges?: JudgeScoreInput[];
  marked_out?: boolean;

  raw_time?: number | null;
  penalties?: { type: string; count?: number }[];
  barrels_knocked?: number;
  tie_held_seconds?: number;

  dq_triggers?: string[];

  /** The second piece of paper. See packages/engine/src/scoring/crosscheck.ts. */
  cross_check?: CrossCheck;
}

/** The engine call the live score route has always made. */
export function computeScore(config: ScoringConfig, body: RunSubmission): ScoreResult {
  return config.mode === 'judged'
    ? calculateJudgedScore(
        {
          judges: body.judges ?? [],
          marked_out: body.marked_out,
          dq_triggers: body.dq_triggers,
        },
        config,
      )
    : calculateTimedScore(
        {
          raw_time: body.raw_time ?? null,
          penalties: body.penalties,
          barrels_knocked: body.barrels_knocked,
          tie_held_seconds: body.tie_held_seconds,
          source: body.source as never,
          dq_triggers: body.dq_triggers,
        },
        config,
      );
}

export type ScoreRunOutcome =
  | { kind: 'no_config' }
  | { kind: 'invalid'; issues: ValidationIssue[] }
  | { kind: 'written'; id: string; result: ScoreResult; replaced: boolean };

/**
 * Score one run: load the config, run the engine, store it.
 *
 * `replace` names an existing live score for the same run that this
 * submission has already been judged (by the sync authority rule) to
 * supersede. It is corrected in place, so the edit-history trigger records
 * what it was; a second row would collide with idx_scores_one_live_per_entry.
 */
export async function scoreRun(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_id: string;
    rodeo_event_id: string;
    score_id: string;
    actor_id: string;
    body: RunSubmission;
    replace?: string;
    reason?: string;
  },
): Promise<ScoreRunOutcome> {
  const { body } = input;
  const config = await repo.loadScoringConfig(tx, body.scoring_config_id);
  if (!config) return { kind: 'no_config' };

  const result = computeScore(config, body);
  if (!result.valid) return { kind: 'invalid', issues: result.issues };

  if (input.replace) {
    await repo.replaceScore(tx, {
      org_id: input.org_id,
      score_id: input.replace,
      scoring_config_id: body.scoring_config_id,
      source: body.source ?? 'manual',
      actor_id: input.actor_id,
      reason: input.reason ?? 'superseded by the secretary',
      cross_check: body.cross_check ?? null,
      result,
    });
    return { kind: 'written', id: input.replace, result, replaced: true };
  }

  await repo.persistScore(tx, {
    id: input.score_id,
    org_id: input.org_id,
    rodeo_id: input.rodeo_id,
    rodeo_event_id: input.rodeo_event_id,
    entry_id: body.entry_id,
    contestant_id: body.contestant_id,
    go_round: body.go_round ?? 1,
    performance: body.performance,
    animal_id: body.animal_id,
    scoring_config_id: body.scoring_config_id,
    source: body.source ?? 'manual',
    hardware_timestamp: body.hardware_timestamp,
    entered_by: input.actor_id,
    cross_check: body.cross_check ?? null,
    result,
  });
  return { kind: 'written', id: input.score_id, result, replaced: false };
}

// ===========================================================================
// The judge card against the timer sheet
// ===========================================================================

export interface CrossCheckBlocker {
  score_id: string;
  entry_id: string;
  contestant_name: string;
  go_round: number;
  code: CrossCheckResult['code'];
  message: string;
}

/**
 * Every run in the event whose judge card and timer sheet do not agree, or
 * have not been compared. Empty means the event may go official and be paid.
 *
 * A DQ has no time and no score to compare and is left out; a re-ride is
 * superseded and is left out.
 */
export async function crossCheckBlockers(
  tx: Tx,
  orgId: string,
  eventId: string,
): Promise<CrossCheckBlocker[] | null> {
  const event = await entriesRepo.loadEventForResults(tx, orgId, eventId);
  if (!event) return null;
  const config = (event.scoring_config as ScoringConfig | null) ?? {
    mode: event.scoring_mode,
  };

  const rows = await repo.loadCrossCheckRows(tx, orgId, eventId);
  const blockers: CrossCheckBlocker[] = [];

  for (const r of rows) {
    const check = r.cross_check as CrossCheck | null;
    const verdict: CrossCheckResult =
      config.mode === 'judged'
        ? compareJudgedTotal(
            config,
            (r.judge_scores ?? []) as JudgeScoreInput[],
            check?.kind === 'judged' ? check : null,
          )
        : compareTimedCard(
            config,
            {
              status: r.status,
              raw_time: r.raw_time,
              penalties_applied: (r.time_penalties ?? []) as { type: string; seconds: number }[],
            },
            check?.kind === 'timed' ? check.judge_card : null,
          );
    if (!verdict.ok) {
      blockers.push({
        score_id: r.id,
        entry_id: r.entry_id,
        contestant_name: r.contestant_name,
        go_round: r.go_round,
        code: verdict.code,
        message: verdict.message,
      });
    }
  }
  return blockers;
}

function describeBlockers(blockers: CrossCheckBlocker[]): string {
  const head = blockers
    .slice(0, 3)
    .map((b) => `${b.contestant_name}: ${b.message}`)
    .join(' ');
  const more = blockers.length > 3 ? ` And ${blockers.length - 3} more.` : '';
  return `${blockers.length} run(s) where the judge card and the timer sheet do not agree. ${head}${more}`;
}

// ===========================================================================
// Make official
// ===========================================================================

export type FinalizeOutcome =
  | { kind: 'not_found' }
  | { kind: 'no_scores' }
  | { kind: 'failed'; issues: ValidationIssue[] }
  | { kind: 'unconfirmed' }
  | { kind: 'blocked'; blockers: CrossCheckBlocker[]; message: string }
  | {
      kind: 'ok';
      written: number;
      official: boolean;
      summary: Record<string, number>;
      warnings: ValidationIssue[];
    };

/**
 * Recompute an event's results from its scores, and optionally make them
 * official. Results are derived: finalising twice replaces what was there.
 *
 * Official is refused while any run's judge card and timer sheet disagree,
 * and refused unless she confirmed she compared them. Computing provisional
 * placings to look at is never refused.
 */
export async function finalizeEvent(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_event_id: string;
    official: boolean;
    confirm?: boolean;
    points?: PointsConfig;
  },
): Promise<FinalizeOutcome> {
  const { org_id, rodeo_event_id: event_id, official } = input;

  const event = await entriesRepo.loadEventForResults(tx, org_id, event_id);
  if (!event) return { kind: 'not_found' };

  if (official) {
    if (input.confirm !== true) return { kind: 'unconfirmed' };
    const blockers = (await crossCheckBlockers(tx, org_id, event_id)) ?? [];
    if (blockers.length > 0) {
      return { kind: 'blocked', blockers, message: describeBlockers(blockers) };
    }
  }

  const payoutConfig = event.payout_config as { team_payout?: string } | null;
  const isTeamEvent = payoutConfig?.team_payout !== undefined;

  const scores = await entriesRepo.loadScoresForResults(tx, org_id, event_id, isTeamEvent);
  if (scores.length === 0) return { kind: 'no_scores' };

  // Money-based points need what has already been paid. On a first pass
  // there is no payout yet and the points are zero — finalise again after
  // disbursement to credit them.
  const earnings =
    input.points?.basis === 'money'
      ? await entriesRepo.loadEarnings(tx, org_id, event_id)
      : undefined;

  const computed = computeResults({
    scores: scores.map((s) => ({
      contestant_id: s.contestant_id,
      entry_id: s.entry_id,
      team_members: s.team_members ?? undefined,
      go_round: s.go_round,
      status: s.status,
      final_score: s.final_score,
      final_time: s.final_time,
    })),
    scoring_config: (event.scoring_config as ScoringConfig | null) ?? {
      mode: event.scoring_mode,
    },
    num_go_rounds: event.num_go_rounds,
    d_format: event.is_d_format ? (event.d_format_config as never) : null,
    points: input.points,
    earnings_cents: earnings,
  });

  if (computed.issues.some((i) => i.severity === 'error')) {
    return { kind: 'failed', issues: computed.issues };
  }

  // A team places once; the standings track individuals. Fan the placing out
  // to the ends before writing, or the rows name an entry id that no
  // contestant can be found under.
  const rows = expandTeamResults(computed.results);

  const written = await entriesRepo.writeResults(tx, {
    org_id,
    rodeo_id: event.rodeo_id,
    rodeo_event_id: event_id,
    results: rows.map((r) => ({
      contestant_id: r.contestant_id,
      result_type: r.result_type,
      go_round: r.go_round,
      d_division: r.d_division,
      aggregate_score: r.aggregate_score,
      place: r.place,
      tied_with: r.tied_with,
      points_earned: r.points_earned,
    })),
    official,
  });

  const summary: Record<string, number> = {};
  for (const r of rows) summary[r.result_type] = (summary[r.result_type] ?? 0) + 1;

  return {
    kind: 'ok',
    written,
    official,
    summary,
    warnings: computed.issues.filter((i) => i.severity === 'warning'),
  };
}

// ===========================================================================
// The payout, and the cash envelope
// ===========================================================================

export type PayoutOutcome =
  | { kind: 'no_context' }
  | { kind: 'failed'; issues: ValidationIssue[] }
  | { kind: 'unreconciled'; accounted: number; net: number }
  | { kind: 'ok'; result: PayoutResult };

/** The one payout calculation every route and the sync path use. */
export function calculateEventPayout(ctx: repo.PayoutContext | null): PayoutOutcome {
  if (!ctx) return { kind: 'no_context' };

  const result: PayoutResult = ctx.config.go_round_average_split
    ? calculateMultiRoundPayout({
        payout_config: ctx.config,
        scoring_mode: ctx.scoring_mode,
        entries: ctx.entries,
        added_money_cents: ctx.added_money_cents,
        entry_fee_cents: ctx.entry_fee_cents,
        results_by_round: ctx.results_by_round,
        average_results: ctx.average_results,
      })
    : calculatePayout({
        payout_config: ctx.config,
        scoring_mode: ctx.scoring_mode,
        entries: ctx.entries,
        added_money_cents: ctx.added_money_cents,
        entry_fee_cents: ctx.entry_fee_cents,
        results: ctx.results,
      });

  if (!result.ok) return { kind: 'failed', issues: result.issues };

  // A reconciliation failure is a bug, not a user error. Refuse to return
  // numbers that do not add up rather than let anybody pay them.
  const disbursed = result.payouts.reduce((s, p) => s + p.amount_cents, 0);
  const accounted = disbursed + result.unpaid_cents + result.escrow_cents;
  if (accounted !== result.net_purse_cents) {
    return { kind: 'unreconciled', accounted, net: result.net_purse_cents };
  }
  return { kind: 'ok', result };
}

/** Lines that put money in somebody's hand. Everything else is not in an envelope. */
export function envelopeLines(result: PayoutResult) {
  return result.payouts
    .filter((p) => p.contestant_id && p.amount_cents > 0)
    .map((p) => ({
      contestant_id: p.contestant_id as string,
      amount_cents: p.amount_cents,
      type: p.type,
      place: p.place,
      go_round: p.go_round,
      d_division: p.d_division,
    }));
}

/** Same key whether the event is paid live or from the queue: it pays once. */
export const disburseKey = (eventId: string) => `disburse-${eventId}`;

export interface EnvelopeClaim {
  /** What she counted into the envelopes, in cents. */
  envelope_total_cents: number;
  lines?: { contestant_id: string; amount_cents: number }[];
}

export type PayEnvelopeOutcome =
  | { kind: 'not_found' }
  | { kind: 'unconfirmed' }
  | { kind: 'blocked'; blockers: CrossCheckBlocker[]; message: string }
  | { kind: 'not_official'; message: string }
  | { kind: 'failed'; issues: ValidationIssue[] }
  | { kind: 'unreconciled' }
  | {
      kind: 'mismatch';
      server_total_cents: number;
      envelope_total_cents: number;
      message: string;
      server_lines: ReturnType<typeof envelopeLines>;
    }
  | {
      kind: 'paid';
      total_cents: number;
      transactions: number;
      settled: number;
      already_paid: boolean;
      lines: ReturnType<typeof envelopeLines>;
    };

/**
 * Pay an event's winners in cash: calculate on the server, write the ledger,
 * settle it as cash.
 *
 * Refused until every run's card and sheet agree, the event's results are
 * official, and she has confirmed. If she says what she put in the envelopes,
 * a total — or a contestant's amount — that differs from the server's
 * calculation is refused rather than paid: either the laptop was working from
 * a different set of runs, or the count is wrong, and somebody has to look.
 */
export async function payEnvelope(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_id: string;
    rodeo_event_id: string;
    actor_id: string;
    confirm?: boolean;
    payment_method?: string;
    reference?: string;
    claim?: EnvelopeClaim;
  },
): Promise<PayEnvelopeOutcome> {
  const { org_id, rodeo_event_id: event_id } = input;

  if (input.confirm !== true) return { kind: 'unconfirmed' };

  const blockers = await crossCheckBlockers(tx, org_id, event_id);
  if (blockers === null) return { kind: 'not_found' };
  if (blockers.length > 0) {
    return { kind: 'blocked', blockers, message: describeBlockers(blockers) };
  }

  if (!(await repo.eventResultsOfficial(tx, org_id, event_id))) {
    return {
      kind: 'not_official',
      message: 'This event is not official yet. Make it official before filling the envelopes.',
    };
  }

  const calc = calculateEventPayout(await repo.loadPayoutContext(tx, org_id, event_id));
  if (calc.kind === 'no_context') return { kind: 'not_found' };
  if (calc.kind === 'failed') return { kind: 'failed', issues: calc.issues };
  if (calc.kind === 'unreconciled') return { kind: 'unreconciled' };

  const lines = envelopeLines(calc.result);
  const serverTotal = lines.reduce((s, l) => s + l.amount_cents, 0);

  if (input.claim) {
    const differs = envelopeDifference(lines, input.claim);
    if (differs) {
      return {
        kind: 'mismatch',
        server_total_cents: serverTotal,
        envelope_total_cents: input.claim.envelope_total_cents,
        message: differs,
        server_lines: lines,
      };
    }
  }

  const key = disburseKey(event_id);
  const out = await repo.disburse(tx, org_id, input.rodeo_id, key, input.actor_id, lines);

  if (out.already_disbursed && out.total_cents !== serverTotal) {
    return {
      kind: 'mismatch',
      server_total_cents: out.total_cents,
      envelope_total_cents: input.claim?.envelope_total_cents ?? serverTotal,
      message:
        `This event was already disbursed for ${cents(out.total_cents)}, and the ` +
        `scores now calculate to ${cents(serverTotal)}. Nothing more was paid.`,
      server_lines: lines,
    };
  }

  if (out.transactions_written === 0 && !out.already_disbursed) {
    return {
      kind: 'paid',
      total_cents: 0,
      transactions: 0,
      settled: 0,
      already_paid: false,
      lines,
    };
  }

  const settled = await settleBatch(tx, {
    org_id,
    idempotency_key: key,
    to_status: 'completed',
    payment_method: input.payment_method ?? 'cash',
    reference: input.reference ?? 'cash envelope',
    actor_id: input.actor_id,
  });

  return {
    kind: 'paid',
    total_cents: out.total_cents,
    transactions: out.transactions_written,
    settled: settled.settled,
    already_paid: out.already_disbursed && settled.settled === 0,
    lines,
  };
}

const cents = (n: number) => `$${(n / 100).toFixed(2)}`;

/** Null when the envelope matches the server; otherwise what differs, in words. */
export function envelopeDifference(
  server: { contestant_id: string; amount_cents: number }[],
  claim: EnvelopeClaim,
): string | null {
  const serverTotal = server.reduce((s, l) => s + l.amount_cents, 0);
  if (claim.envelope_total_cents !== serverTotal) {
    return (
      `Her envelopes total ${cents(claim.envelope_total_cents)}; the server ` +
      `calculates ${cents(serverTotal)} from the runs it holds.`
    );
  }
  if (!claim.lines) return null;

  const sum = (rows: { contestant_id: string; amount_cents: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.contestant_id, (m.get(r.contestant_id) ?? 0) + r.amount_cents);
    return m;
  };
  const a = sum(server);
  const b = sum(claim.lines);
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    if ((a.get(id) ?? 0) !== (b.get(id) ?? 0)) {
      return (
        `The total matches but the envelopes do not: one contestant has ` +
        `${cents(b.get(id) ?? 0)} in hand and the server pays ${cents(a.get(id) ?? 0)}.`
      );
    }
  }
  return null;
}

// ===========================================================================
// Turnouts
// ===========================================================================

export type TurnoutOutcome =
  | { kind: 'not_live' }
  | { kind: 'ok'; verdict: TurnoutResult; refund: { refunded_cents: number; rows: number } };

/**
 * Record a turnout. `notified_at` is when she was told — on the night that is
 * the moment she wrote it down, not the moment it reached the server — and it
 * is what decides whether the turnout is fineable.
 */
export async function recordTurnout(
  tx: Tx,
  input: {
    org_id: string;
    entry_id: string;
    release_type: string;
    performance_at: string;
    notified_at: string;
    actor_id: string;
  },
): Promise<TurnoutOutcome> {
  const verdict = classifyTurnout({
    notified_at: input.notified_at,
    performance_at: input.performance_at,
    release_type: input.release_type,
  });

  const ok = await entriesRepo.scratchEntry(tx, {
    org_id: input.org_id,
    entry_id: input.entry_id,
    status: verdict.status,
    release_type: input.release_type,
    notified_at: input.notified_at,
  });
  if (!ok) return { kind: 'not_live' };

  const refund = verdict.refund_due
    ? await refundEntry(tx, {
        org_id: input.org_id,
        entry_id: input.entry_id,
        reason: `${verdict.status}: ${input.release_type}`,
        actor_id: input.actor_id,
      })
    : { refunded_cents: 0, rows: 0 };

  return { kind: 'ok', verdict, refund };
}

// ===========================================================================
// Trading a run
// ===========================================================================

export interface DrawSlot {
  performance_number: number | null;
  draw_position: number;
}

export type TradeOutcome =
  | { kind: 'refused'; message: string }
  | { kind: 'stale'; message: string; current: { a: DrawSlot; b: DrawSlot } }
  | { kind: 'already'; a: DrawSlot; b: DrawSlot }
  | { kind: 'traded'; a: DrawSlot; b: DrawSlot };

const LIVE_FOR_TRADE = new Set(['pending', 'confirmed', 'drawn']);

/**
 * Two contestants in the same event trade runs: same performance or across
 * performances. Each takes the other's slot exactly — no position is created,
 * none is left empty. The drawn animal is tied to the ENTRY (stock_draws), so
 * it travels with the contestant and the witnessed stock draw is not redone.
 *
 * `expect` is where she saw them when she made the trade. If they are no
 * longer there, somebody else moved them and the trade is refused rather than
 * applied to positions she never looked at. If they are already swapped, the
 * trade was applied before — a retried sync — and nothing moves again.
 */
export async function tradeRuns(
  tx: Tx,
  input: {
    org_id: string;
    rodeo_event_id: string;
    a_entry_id: string;
    b_entry_id: string;
    expect?: { a: DrawSlot; b: DrawSlot };
  },
): Promise<TradeOutcome> {
  if (input.a_entry_id === input.b_entry_id) {
    return { kind: 'refused', message: 'A contestant cannot trade with themselves.' };
  }

  const rows = await repo.lockEntriesForTrade(tx, input.org_id, [
    input.a_entry_id,
    input.b_entry_id,
  ]);
  const a = rows.find((r) => r.id === input.a_entry_id);
  const b = rows.find((r) => r.id === input.b_entry_id);

  if (!a || !b) return { kind: 'refused', message: 'One of those entries does not exist.' };
  if (a.rodeo_event_id !== input.rodeo_event_id || b.rodeo_event_id !== input.rodeo_event_id) {
    return { kind: 'refused', message: 'A trade is between two runs in the same event.' };
  }
  if (a.go_round_number !== b.go_round_number) {
    return { kind: 'refused', message: 'A trade is between two runs in the same go-round.' };
  }
  if (a.draw_position === null || b.draw_position === null) {
    return {
      kind: 'refused',
      message: 'Both contestants must already be drawn. A trade cannot create a position.',
    };
  }
  if (!LIVE_FOR_TRADE.has(a.status) || !LIVE_FOR_TRADE.has(b.status)) {
    return { kind: 'refused', message: 'A scratched or turned-out entry cannot trade.' };
  }

  const slotA: DrawSlot = { performance_number: a.performance_number, draw_position: a.draw_position };
  const slotB: DrawSlot = { performance_number: b.performance_number, draw_position: b.draw_position };
  const same = (x: DrawSlot, y: DrawSlot) =>
    x.performance_number === y.performance_number && x.draw_position === y.draw_position;

  if (input.expect) {
    if (same(slotA, input.expect.b) && same(slotB, input.expect.a)) {
      return { kind: 'already', a: slotA, b: slotB };
    }
    if (!same(slotA, input.expect.a) || !same(slotB, input.expect.b)) {
      return {
        kind: 'stale',
        message: 'These runs have moved since the trade was made. Look at the draw again.',
        current: { a: slotA, b: slotB },
      };
    }
  }

  await repo.setDrawSlot(tx, input.org_id, a.id, slotB);
  await repo.setDrawSlot(tx, input.org_id, b.id, slotA);
  return { kind: 'traded', a: slotB, b: slotA };
}

