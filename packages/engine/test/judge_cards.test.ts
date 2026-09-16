import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { combineJudgeCards, type JudgeCard } from '../src/index.ts';

function card(over: Partial<JudgeCard> & { judge_position: number }): JudgeCard {
  return {
    rider_score: 22,
    animal_score: 21,
    signed: true,
    ...over,
  };
}

describe('combineJudgeCards', () => {
  it('is incomplete with only one signed card', () => {
    const r = combineJudgeCards([card({ judge_position: 1 })]);
    assert.equal(r.complete, false);
    assert.equal(r.signed_count, 1);
    assert.deepEqual(r.missing_positions, [2]);
    assert.equal(r.final_score, null);
  });

  it('does not count an unsigned card toward completeness', () => {
    const r = combineJudgeCards([
      card({ judge_position: 1 }),
      card({ judge_position: 2, signed: false }),
    ]);
    assert.equal(r.complete, false);
    assert.deepEqual(r.missing_positions, [2]);
  });

  it('sums both judges once both cards are signed', () => {
    const r = combineJudgeCards([
      card({ judge_position: 1, rider_score: 22, animal_score: 21 }),
      card({ judge_position: 2, rider_score: 23, animal_score: 20 }),
    ]);
    assert.equal(r.complete, true);
    assert.equal(r.rider_score, 45);
    assert.equal(r.animal_score, 41);
    assert.equal(r.final_score, 86);
  });

  it('a mark-out on either card makes the run a no-score', () => {
    const r = combineJudgeCards([
      card({ judge_position: 1, marked_out: true }),
      card({ judge_position: 2 }),
    ]);
    assert.equal(r.is_no_score, true);
    assert.equal(r.final_score, null);
  });

  it('surfaces a re-ride flag from any signed card', () => {
    const r = combineJudgeCards([
      card({ judge_position: 1, reride_flag: true }),
      card({ judge_position: 2 }),
    ]);
    assert.equal(r.reride, true);
  });

  it('de-duplicates a resubmitted card for the same chair', () => {
    const r = combineJudgeCards([
      card({ judge_position: 1, rider_score: 10, animal_score: 10 }),
      card({ judge_position: 1, rider_score: 22, animal_score: 21 }),
      card({ judge_position: 2, rider_score: 23, animal_score: 20 }),
    ]);
    assert.equal(r.complete, true);
    // The later position-1 card wins: 22+21 + 23+20 = 86.
    assert.equal(r.final_score, 86);
  });

  it('handles floating-point marks without noise', () => {
    const r = combineJudgeCards([
      card({ judge_position: 1, rider_score: 22.1, animal_score: 21.2 }),
      card({ judge_position: 2, rider_score: 23.3, animal_score: 20.4 }),
    ]);
    assert.equal(r.final_score, 87);
  });
});
