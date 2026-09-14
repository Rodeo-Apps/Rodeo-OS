import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPETITORS,
  DEFAULT_PLATFORM_FEES,
  PERCENTAGE_MODEL_FEES,
  PASS_THROUGH_FEES,
  PRODUCER_PLANS,
  RODEOAPPS_SUBSCRIPTION,
  compareModels,
  recommendPlan,
  calculatePlatformFee,
  compareAllIn,
  modelContestant,
  subscriptionBreakEven,
  toCents,
} from '../src/index.ts';

const entry = (dollars: number, subscriber = false) =>
  calculatePlatformFee({ entry_total_cents: toCents(dollars), subscriber });

// ---------------------------------------------------------------------------
// The active model: OS free to producers, we take NOTHING on the money flow.
// ---------------------------------------------------------------------------
describe('active model — pass-through, zero markup', () => {
  it('the default charges the contestant no platform fee', () => {
    assert.equal(entry(100).platform_fee_cents, 0);
    assert.equal(entry(100).platform_net_cents, 0);
  });

  it('a subscriber is treated the same on the money flow — also zero', () => {
    // The membership is not a fee-avoidance tool anymore; nobody pays a cut.
    assert.equal(entry(100, true).platform_fee_cents, 0);
    assert.equal(entry(100, true).saved_vs_standard_cents, 0);
  });

  it('the producer receives the full entry; the contestant pays only card cost', () => {
    const r = entry(100);
    assert.equal(r.producer_receives_cents, toCents(100));
    assert.equal(
      r.contestant_pays_cents,
      toCents(100) + r.processing_fee_cents,
      'entry + what the card actually costs, and not one cent more',
    );
  });

  it('the processor cut is never counted as our revenue', () => {
    const r = entry(100);
    assert.ok(r.processing_fee_cents > 0);
    assert.equal(r.platform_net_cents, 0);
    assert.notEqual(r.platform_net_cents, r.processing_fee_cents);
  });

  it('the DEFAULT config is the pass-through config', () => {
    assert.equal(DEFAULT_PLATFORM_FEES.standard_percent, 0);
    assert.equal(DEFAULT_PLATFORM_FEES.standard_fixed_cents, 0);
    assert.equal(DEFAULT_PLATFORM_FEES.subscriber_percent, 0);
    const a = entry(137);
    const b = calculatePlatformFee({
      entry_total_cents: toCents(137),
      subscriber: false,
      config: PASS_THROUGH_FEES,
    });
    assert.deepEqual(a, b);
  });

  it('a zero-dollar entry carries no fee at all', () => {
    const r = entry(0);
    assert.equal(r.platform_fee_cents, 0);
    assert.equal(r.processing_fee_cents, 0);
    assert.equal(r.contestant_pays_cents, 0);
  });

  it('refuses a negative total', () => {
    const r = calculatePlatformFee({ entry_total_cents: -100, subscriber: false });
    assert.ok(r.issues.some((i) => i.code === 'NEGATIVE_TOTAL'));
  });
});

// ---------------------------------------------------------------------------
// The membership: one price, all apps + OS.
// ---------------------------------------------------------------------------
describe('Rodeo Apps membership', () => {
  it('is $4.99/mo and $49.99/yr', () => {
    assert.equal(RODEOAPPS_SUBSCRIPTION.monthly_cents, 499);
    assert.equal(RODEOAPPS_SUBSCRIPTION.annual_cents, 4999);
  });

  it('annual is cheaper than twelve months', () => {
    assert.ok(
      RODEOAPPS_SUBSCRIPTION.annual_cents <
        RODEOAPPS_SUBSCRIPTION.monthly_cents * 12,
    );
  });

  it('under the active model there is no fee to avoid — it stands on app value', () => {
    // Break-even on fees is infinite because we take nothing. The membership
    // is a consumer product (nine apps, the draw in your pocket, career
    // record), not a discount on a convenience fee.
    const b = subscriptionBreakEven(toCents(150));
    assert.equal(b.per_entry_saving_cents, 0);
    assert.equal(b.entries, Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// Competitive position: cheapest place in the sport to enter a rodeo.
// ---------------------------------------------------------------------------
describe('competitive position', () => {
  it('everyone pays LESS all-in than RodeoReady, at every entry size', () => {
    for (const size of [25, 50, 100, 150, 300, 500]) {
      const rows = compareAllIn(toCents(size), false);
      const ours = rows.find((r) => r.name === 'RodeoApps')!;
      const theirs = rows.find((r) => r.name === 'RodeoReady')!;
      assert.ok(
        ours.contestant_pays_cents < theirs.contestant_pays_cents,
        `at $${size} we charge ${ours.contestant_pays_cents} vs their ${theirs.contestant_pays_cents}`,
      );
    }
  });

  it('pass-through is the cheapest entry in the sport, at every size', () => {
    for (const size of [25, 50, 100, 150, 300, 500]) {
      const rows = compareAllIn(toCents(size), false);
      const ours = rows.find((r) => r.name === 'RodeoApps')!;
      for (const other of rows.filter((r) => r.name !== 'RodeoApps')) {
        assert.ok(
          ours.contestant_pays_cents < other.contestant_pays_cents,
          `${other.name} is cheaper than pass-through at $${size}`,
        );
      }
    }
  });

  it('the comparison accounts for who pays card processing', () => {
    // RodeoReady's rate includes it; Rodeo Producer's does not. Comparing the
    // headline numbers without that is how the first draft set the rate too high.
    const rr = COMPETITORS.find((c) => c.name === 'RodeoReady')!;
    const rp = COMPETITORS.find((c) => c.name === 'Rodeo Producer')!;
    assert.equal(rr.includes_processing, true);
    assert.equal(rp.includes_processing, false);
  });
});

// ---------------------------------------------------------------------------
// DEFERRED — the percentage model and producer ladder, retained for modelling
// only. Not what the platform charges today.
// ---------------------------------------------------------------------------
describe('deferred percentage model (comparison only)', () => {
  const pctEntry = (dollars: number, subscriber = false) =>
    calculatePlatformFee({
      entry_total_cents: toCents(dollars),
      subscriber,
      config: PERCENTAGE_MODEL_FEES,
    });

  it('would charge 2% to a non-subscriber', () => {
    assert.equal(pctEntry(100).platform_fee_cents, toCents(2));
  });

  it('would charge a subscriber nothing', () => {
    const r = pctEntry(100, true);
    assert.equal(r.platform_fee_cents, 0);
    assert.equal(r.saved_vs_standard_cents, toCents(2));
  });

  it('the processor takes its cut of the platform fee too', () => {
    const r = pctEntry(100);
    const chargedToCard = toCents(100) + r.platform_fee_cents;
    assert.equal(r.processing_fee_cents, Math.round(chargedToCard * 0.029) + 30);
  });

  it('would cap the fee so a big entry is not gouged', () => {
    const r = pctEntry(2000); // 2% would be $40
    assert.equal(r.platform_fee_cents, toCents(15), 'capped at $15');
  });

  it('has a real subscription break-even under the percentage model', () => {
    assert.ok(
      subscriptionBreakEven(toCents(150), RODEOAPPS_SUBSCRIPTION, PERCENTAGE_MODEL_FEES)
        .entries <= 20,
    );
    assert.ok(
      subscriptionBreakEven(toCents(50), RODEOAPPS_SUBSCRIPTION, PERCENTAGE_MODEL_FEES)
        .entries > 40,
    );
  });

  it('a heavy competitor would cost less as a subscriber than as a payer', () => {
    const paying = modelContestant(
      { label: 'pro', entries_per_year: 120, avg_entry_cents: toCents(150), subscriber: false },
      RODEOAPPS_SUBSCRIPTION,
      PERCENTAGE_MODEL_FEES,
    );
    const subbed = modelContestant(
      { label: 'pro subbed', entries_per_year: 120, avg_entry_cents: toCents(150), subscriber: true },
      RODEOAPPS_SUBSCRIPTION,
      PERCENTAGE_MODEL_FEES,
    );
    assert.ok(subbed.contestant_cost_cents < paying.contestant_cost_cents);
    assert.equal(subbed.transaction_net_cents, 0);
    assert.ok(subbed.subscription_cents > 0, 'and all of it recurs');
  });

  it('modelling is deterministic', () => {
    const p = { label: 'x', entries_per_year: 40, avg_entry_cents: toCents(100), subscriber: false };
    assert.deepEqual(
      modelContestant(p, RODEOAPPS_SUBSCRIPTION, PERCENTAGE_MODEL_FEES),
      modelContestant(p, RODEOAPPS_SUBSCRIPTION, PERCENTAGE_MODEL_FEES),
    );
  });
});

describe('deferred producer ladder (comparison only)', () => {
  it('the ladder still has reachable rungs for modelling', () => {
    assert.equal(recommendPlan(60).code, 'grassroots');
    assert.equal(recommendPlan(1_200).code, 'starter');
    assert.equal(recommendPlan(2_400).code, 'pro');
    assert.equal(recommendPlan(50_000).code, 'association');
  });

  it('exactly one plan is free, and it is the smallest', () => {
    const free = PRODUCER_PLANS.filter((p) => p.monthly_cents === 0);
    assert.equal(free.length, 1);
    assert.equal(free[0].code, 'grassroots');
    assert.ok(free[0].entry_limit !== null, 'the free tier must be capped');
  });

  it('annual is cheaper than twelve months', () => {
    for (const p of PRODUCER_PLANS) {
      if (p.monthly_cents === 0) continue;
      assert.ok(p.annual_cents < p.monthly_cents * 12, `${p.code} annual is not a discount`);
    }
  });

  it('each rung includes everything the one below it does', () => {
    for (let i = 1; i < PRODUCER_PLANS.length; i++) {
      const lower = new Set(PRODUCER_PLANS[i - 1].modules);
      for (const m of lower) {
        assert.ok(
          PRODUCER_PLANS[i].modules.includes(m),
          `${PRODUCER_PLANS[i].code} drops '${m}' that ${PRODUCER_PLANS[i - 1].code} has`,
        );
      }
    }
  });

  it('compareModels defaults to the percentage model as the "what a cut would cost" side', () => {
    // The flat ladder was designed to beat a 2% cut for the producer at every size.
    for (const [entries, avg] of [
      [200, 50], [1_200, 50], [300, 100], [2_400, 125], [10_000, 150],
    ] as [number, number][]) {
      const c = compareModels(entries, toCents(avg));
      assert.ok(
        c.producer_saves_cents > 0,
        `at ${entries} entries of $${avg} the flat plan costs more`,
      );
    }
  });
});
