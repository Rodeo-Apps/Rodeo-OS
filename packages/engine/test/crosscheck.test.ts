import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareJudgedTotal, compareTimedCard } from '../src/scoring/crosscheck.ts';
import type { JudgeScoreInput, ScoringConfig } from '../src/types/index.ts';

// ---------------------------------------------------------------------------
// The judge card against the timer sheet. Nobody is paid off one record.
// ---------------------------------------------------------------------------

const TIE_DOWN: ScoringConfig = {
  mode: 'timed',
  time_precision: 1,
  timed_penalties: [{ type: 'barrier_break', seconds: 10 }],
  dq_triggers: ['no_catch'],
};

const BARRELS: ScoringConfig = {
  mode: 'timed',
  time_precision: 3,
  timed_penalties: [{ type: 'barrel_knockdown', seconds: 5, repeatable: true }],
};

const BRONC: ScoringConfig = {
  mode: 'judged',
  max_score: 100,
  components: [
    { name: 'rider', min: 0, max: 25, judges: 2 },
    { name: 'animal', min: 0, max: 25, judges: 2 },
  ],
  increment: 0.5,
  mark_out_required: true,
  dq_triggers: ['mark_out_violation'],
};

const cards = (r1: number, a1: number, r2: number, a2: number): JudgeScoreInput[] => [
  { judge_id: 'j1', judge_position: 1, components: [{ name: 'rider', value: r1 }, { name: 'animal', value: a1 }] },
  { judge_id: 'j2', judge_position: 2, components: [{ name: 'rider', value: r2 }, { name: 'animal', value: a2 }] },
];

describe('timer sheet against the flag judge card', () => {
  const sheet = (raw: number | null, penalties: { type: string; seconds: number }[] = []) => ({
    status: raw === null ? 'no_time' : 'official',
    raw_time: raw,
    penalties_applied: penalties,
  });

  it('agrees when the time and the penalties are the same', () => {
    const r = compareTimedCard(TIE_DOWN, sheet(8.4, [{ type: 'barrier_break', seconds: 10 }]), {
      raw_time: 8.4,
      penalties: [{ type: 'barrier_break' }],
    });
    assert.equal(r.ok, true);
  });

  it('compares at the event\'s precision, not to the last float bit', () => {
    assert.equal(compareTimedCard(TIE_DOWN, sheet(8.4), { raw_time: 8.40000001 }).ok, true);
    assert.equal(compareTimedCard(TIE_DOWN, sheet(8.4), { raw_time: 8.5 }).code, 'TIME_DIFFERS');
  });

  it('a penalty on one paper and not the other is a disagreement', () => {
    const r = compareTimedCard(TIE_DOWN, sheet(8.4), {
      raw_time: 8.4,
      penalties: [{ type: 'barrier_break' }],
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'PENALTIES_DIFFER');
  });

  it('counts repeatable penalties: two knockdowns are not one', () => {
    const r = compareTimedCard(BARRELS, sheet(16.2, [{ type: 'barrel_knockdown', seconds: 10 }]), {
      raw_time: 16.2,
      barrels_knocked: 1,
    });
    assert.equal(r.code, 'PENALTIES_DIFFER');
  });

  it('a no-time must be a no-time on both', () => {
    assert.equal(compareTimedCard(TIE_DOWN, sheet(null), { raw_time: null }).ok, true);
    assert.equal(compareTimedCard(TIE_DOWN, sheet(null), { raw_time: 9 }).code, 'NO_TIME_DIFFERS');
  });

  it('no card entered is not a match', () => {
    assert.equal(compareTimedCard(TIE_DOWN, sheet(8.4), null).code, 'NOT_COMPARED');
  });

  it('a card the engine refuses is refused here too — one scoring path', () => {
    const r = compareTimedCard(TIE_DOWN, sheet(8.4), {
      raw_time: 8.4,
      penalties: [{ type: 'made_up_penalty' }],
    });
    assert.equal(r.code, 'CARD_INVALID');
  });
});

describe('judge cards against the total she typed', () => {
  it('agrees when the typed total is what the cards add up to', () => {
    const r = compareJudgedTotal(BRONC, cards(21, 21.5, 20.5, 22), {
      typed_total: 85,
      marked_out: true,
    });
    assert.equal(r.ok, true, r.message);
  });

  it('a misread card is caught', () => {
    const r = compareJudgedTotal(BRONC, cards(21, 21.5, 20.5, 22), {
      typed_total: 86,
      marked_out: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'TOTAL_DIFFERS');
    assert.match(r.message, /add up to 85/);
  });

  it('a missed mark-out has no score on the cards, so a typed total disagrees', () => {
    const r = compareJudgedTotal(BRONC, cards(21, 21.5, 20.5, 22), {
      typed_total: 85,
      marked_out: false,
    });
    assert.equal(r.code, 'TOTAL_DIFFERS');
    assert.equal(
      compareJudgedTotal(BRONC, cards(21, 21.5, 20.5, 22), { typed_total: null, marked_out: false }).ok,
      true,
    );
  });

  it('no typed total is not a match', () => {
    assert.equal(compareJudgedTotal(BRONC, cards(21, 21.5, 20.5, 22), null).code, 'NOT_COMPARED');
  });
});
