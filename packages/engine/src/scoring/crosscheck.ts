/**
 * The judge card against the timer sheet.
 *
 * ---------------------------------------------------------------------------
 * NOBODY IS PAID UNTIL THE TWO PIECES OF PAPER AGREE
 * ---------------------------------------------------------------------------
 * The secretary does not pay an event off one record. On a timed event the
 * timer sheet says what the clock read and the flag judge's card says what he
 * flagged and what he called; on a judged event the cards ARE the score, and
 * the total she typed off them has to be what the cards add up to. When the
 * two disagree, somebody misheard a runner or misread a card, and the envelope
 * waits until it is sorted out.
 *
 * Both comparisons run the ordinary scoring functions over both records.
 * There is no second scoring path: a penalty the config does not know, a time
 * the engine refuses, an out-of-range mark — each fails here exactly as it
 * fails when the score is entered.
 * ---------------------------------------------------------------------------
 */

import type { JudgeScoreInput, ScoringConfig } from '../types/index.ts';
import { calculateJudgedScore } from './judged.ts';
import { calculateTimedScore } from './timed.ts';

/** What the flag judge wrote on his card for one timed run. */
export interface JudgeCardTime {
  /** null when he flagged no time. */
  raw_time: number | null;
  penalties?: { type: string; count?: number }[];
  barrels_knocked?: number;
  dq_triggers?: string[];
}

/** Stored on `scores.cross_check`. */
export type CrossCheck =
  | { kind: 'timed'; judge_card: JudgeCardTime }
  | {
      kind: 'judged';
      /** The total she typed off the cards. */
      typed_total: number | null;
      marked_out?: boolean;
      dq_triggers?: string[];
    };

export type CrossCheckCode =
  | 'MATCH'
  | 'NOT_COMPARED'
  | 'CARD_INVALID'
  | 'TIME_DIFFERS'
  | 'PENALTIES_DIFFER'
  | 'NO_TIME_DIFFERS'
  | 'TOTAL_DIFFERS';

export interface CrossCheckResult {
  ok: boolean;
  code: CrossCheckCode;
  message: string;
}

/** The timer sheet as it is stored on the score row. */
export interface StoredTimedRun {
  status: string;
  raw_time: number | null;
  penalties_applied: { type: string; seconds: number }[];
}

const MATCH: CrossCheckResult = { ok: true, code: 'MATCH', message: 'Card and sheet agree.' };

function penaltyKey(p: { type: string; seconds: number }[]): string {
  return p
    .map((x) => `${x.type}:${x.seconds}`)
    .sort()
    .join('|');
}

/**
 * Timed: the timer sheet (what is stored and what will be paid on) against the
 * flag judge's card time and penalties.
 */
export function compareTimedCard(
  config: ScoringConfig,
  sheet: StoredTimedRun,
  card: JudgeCardTime | null | undefined,
): CrossCheckResult {
  if (!card) {
    return {
      ok: false,
      code: 'NOT_COMPARED',
      message: 'The flag judge\'s card has not been entered for this run.',
    };
  }

  const fromCard = calculateTimedScore(
    {
      raw_time: card.raw_time,
      penalties: card.penalties,
      barrels_knocked: card.barrels_knocked,
      dq_triggers: card.dq_triggers,
    },
    config,
  );
  if (!fromCard.valid) {
    return {
      ok: false,
      code: 'CARD_INVALID',
      message: fromCard.issues.map((i) => i.message).join(' ') || 'The card does not score.',
    };
  }

  const sheetNoTime = sheet.status === 'no_time' || sheet.raw_time === null;
  const cardNoTime = fromCard.status === 'no_time';
  if (sheetNoTime !== cardNoTime) {
    return {
      ok: false,
      code: 'NO_TIME_DIFFERS',
      message: sheetNoTime
        ? `Timer sheet is a no-time; the card has ${card.raw_time}.`
        : `Card is a no-time; the timer sheet has ${sheet.raw_time}.`,
    };
  }
  if (sheetNoTime) return MATCH;

  const precision = config.time_precision ?? 2;
  const scale = 10 ** precision;
  const a = Math.round(Number(sheet.raw_time) * scale);
  const b = Math.round(Number(fromCard.raw_time) * scale);
  if (a !== b) {
    return {
      ok: false,
      code: 'TIME_DIFFERS',
      message: `Timer sheet ${sheet.raw_time}, card ${card.raw_time}.`,
    };
  }

  if (penaltyKey(sheet.penalties_applied ?? []) !== penaltyKey(fromCard.penalties_applied)) {
    const fmt = (p: { type: string; seconds: number }[]) =>
      p.length ? p.map((x) => `${x.type} ${x.seconds}s`).join(', ') : 'none';
    return {
      ok: false,
      code: 'PENALTIES_DIFFER',
      message:
        `Timer sheet penalties: ${fmt(sheet.penalties_applied ?? [])}; ` +
        `card: ${fmt(fromCard.penalties_applied)}.`,
    };
  }

  return MATCH;
}

/**
 * Judged: the total she typed against what the engine makes of the cards.
 */
export function compareJudgedTotal(
  config: ScoringConfig,
  cards: JudgeScoreInput[],
  check: { typed_total: number | null; marked_out?: boolean; dq_triggers?: string[] } | null | undefined,
): CrossCheckResult {
  if (!check) {
    return {
      ok: false,
      code: 'NOT_COMPARED',
      message: 'No typed total has been entered against these cards.',
    };
  }

  const fromCards = calculateJudgedScore(
    { judges: cards, marked_out: check.marked_out, dq_triggers: check.dq_triggers },
    config,
  );
  if (!fromCards.valid) {
    return {
      ok: false,
      code: 'CARD_INVALID',
      message: fromCards.issues.map((i) => i.message).join(' ') || 'The cards do not score.',
    };
  }

  const engine = fromCards.final_score;
  const typed = check.typed_total;
  const same =
    engine === null || typed === null
      ? engine === typed
      : Math.round(engine * 100) === Math.round(typed * 100);

  if (!same) {
    return {
      ok: false,
      code: 'TOTAL_DIFFERS',
      message: `Typed total ${typed ?? 'none'}, the cards add up to ${engine ?? 'no score'}.`,
    };
  }
  return MATCH;
}
