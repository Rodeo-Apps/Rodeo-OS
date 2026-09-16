import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  associationPacketDeadline,
  checkPacket,
  classifyTurnoutLog,
  reconcileRemittance,
  reconcileTimers,
  requiredPacketItems,
  summarizeInfractions,
  summarizeTurnoutLog,
  tradesRemaining,
  validateInfraction,
  validateTrade,
  type TurnoutSummaryRow,
} from '../src/index.ts';

// ---------------------------------------------------------------------------
// Turnout log (Form F)
// ---------------------------------------------------------------------------

describe('turnout log', () => {
  it('excuses a doctor release: no fine, fee refunded', () => {
    const r = classifyTurnoutLog({ log_type: 'DR', entry_fee_cents: 15000 });
    assert.equal(r.fineable, false);
    assert.equal(r.refund_due, true);
    assert.equal(r.fine_cents, 0);
    assert.equal(r.fee_owed_cents, 0);
  });

  it('fines a plain turnout with no notice and keeps the fee', () => {
    const r = classifyTurnoutLog({
      log_type: 'TO',
      entry_fee_cents: 15000,
      fine_amount_cents: 5000,
    });
    assert.equal(r.fineable, true);
    assert.equal(r.refund_due, false);
    assert.equal(r.fine_cents, 5000);
    assert.equal(r.fee_owed_cents, 20000);
  });

  it('a notified turnout in time is not fineable', () => {
    const r = classifyTurnoutLog({
      log_type: 'NTO',
      notified_at: '2026-09-10T00:00:00Z',
      performance_at: '2026-09-12T00:00:00Z',
      required_notice_hours: 30,
    });
    assert.equal(r.fineable, false);
  });

  it('team roping fee stands when the partner did not notify before the draw', () => {
    const r = classifyTurnoutLog({
      log_type: 'TO',
      entry_fee_cents: 20000,
      is_team_roping: true,
      partner_notified: false,
    });
    assert.equal(r.fee_owed_cents >= 20000, true);
  });

  it('summarizes a fines list', () => {
    const rows: TurnoutSummaryRow[] = [
      { log_type: 'TO', fineable: true, fee_owed_cents: 20000, fine_cents: 5000 },
      { log_type: 'DR', fineable: false, fee_owed_cents: 0, fine_cents: 0 },
    ];
    const s = summarizeTurnoutLog(rows);
    assert.equal(s.total, 2);
    assert.equal(s.fineable_count, 1);
    assert.equal(s.total_fines_cents, 5000);
    assert.equal(s.by_type.TO, 1);
    assert.equal(s.by_type.DR, 1);
  });
});

// ---------------------------------------------------------------------------
// Trades (Form E)
// ---------------------------------------------------------------------------

describe('trades', () => {
  it('allows a valid riding trade before the stock draw', () => {
    const r = validateTrade({
      discipline: 'riding',
      go_round_number: 1,
      from: { performance_number: 1 },
      to: { performance_number: 2 },
      trades_allowed: true,
      deadline_at: '2026-09-12T18:00:00Z',
      now: '2026-09-12T12:00:00Z',
      existing_trades_this_go: 0,
    });
    assert.equal(r.ok, true);
    assert.equal(r.trade_number, 1);
  });

  it('rejects a trade into the same section', () => {
    const r = validateTrade({
      discipline: 'timed',
      go_round_number: 1,
      from: { performance_number: 3 },
      to: { performance_number: 3 },
      trades_allowed: true,
    });
    assert.equal(r.ok, false);
  });

  it('rejects once the two-per-go limit is used', () => {
    const r = validateTrade({
      discipline: 'riding',
      go_round_number: 1,
      from: { performance_number: 1 },
      to: { performance_number: 2 },
      trades_allowed: true,
      existing_trades_this_go: 2,
    });
    assert.equal(r.ok, false);
  });

  it('rejects a trade past the deadline', () => {
    const r = validateTrade({
      discipline: 'riding',
      go_round_number: 1,
      from: { performance_number: 1 },
      to: { performance_number: 2 },
      trades_allowed: true,
      deadline_at: '2026-09-12T10:00:00Z',
      now: '2026-09-12T12:00:00Z',
    });
    assert.equal(r.ok, false);
  });

  it('counts trades remaining', () => {
    assert.equal(tradesRemaining(0), 2);
    assert.equal(tradesRemaining(1), 1);
    assert.equal(tradesRemaining(2), 0);
    assert.equal(tradesRemaining(5), 0);
  });
});

// ---------------------------------------------------------------------------
// Infractions (Form G)
// ---------------------------------------------------------------------------

describe('infractions', () => {
  it('a barrier fine cannot post until the barrier judge verifies it', () => {
    const draft = validateInfraction({
      infraction_type: 'barrier',
      fine_cents: 2500,
      judge_id: 'j1',
      verified_by_barrier_judge: false,
    });
    assert.equal(draft.can_post, false);

    const verified = validateInfraction({
      infraction_type: 'barrier',
      fine_cents: 2500,
      judge_id: 'j1',
      verified_by_barrier_judge: true,
    });
    assert.equal(verified.can_post, true);
  });

  it('a posted infraction is immutable', () => {
    const r = validateInfraction({
      infraction_type: 'conduct',
      fine_cents: 5000,
      judge_id: 'j1',
      posted_at: '2026-09-12T20:00:00Z',
    });
    assert.equal(r.can_edit, false);
  });

  it('summary counts only posted fines toward money owed', () => {
    const s = summarizeInfractions([
      { infraction_type: 'barrier', fine_cents: 2500, posted_at: '2026-09-12T20:00:00Z' },
      { infraction_type: 'field', fine_cents: 5000, posted_at: null },
    ]);
    assert.equal(s.total, 2);
    assert.equal(s.posted, 1);
    assert.equal(s.drafts, 1);
    assert.equal(s.posted_fines_cents, 2500);
  });
});

// ---------------------------------------------------------------------------
// Timer reconciliation (Form D)
// ---------------------------------------------------------------------------

describe('timer reconciliation', () => {
  it('prefers the electric eye as the base time', () => {
    const r = reconcileTimers({
      timer1_seconds: 8.51,
      timer2_seconds: 8.53,
      electric_eye_seconds: 8.52,
      barrier_penalty_seconds: 0,
    });
    assert.equal(r.base_source, 'electric_eye');
    assert.equal(r.base_seconds, 8.52);
    assert.equal(r.official_seconds, 8.52);
  });

  it('averages two watches with no eye', () => {
    const r = reconcileTimers({ timer1_seconds: 8.5, timer2_seconds: 8.6 });
    assert.equal(r.base_source, 'two_watch_average');
    assert.equal(r.base_seconds, 8.55);
  });

  it('adds the barrier penalty', () => {
    const r = reconcileTimers({
      electric_eye_seconds: 12.3,
      barrier_penalty_seconds: 10,
    });
    assert.equal(r.official_seconds, 22.3);
  });

  it('flags watches that disagree beyond tolerance', () => {
    const r = reconcileTimers({ timer1_seconds: 8.5, timer2_seconds: 9.2 });
    assert.equal(r.watches_agree, false);
    assert.equal(r.issues.some((i) => i.code === 'WATCH_DISCREPANCY'), true);
  });

  it('a no-time has no official time', () => {
    const r = reconcileTimers({ timer1_seconds: 8.5, no_time: true });
    assert.equal(r.official_seconds, null);
    assert.equal(r.no_time, true);
  });
});

// ---------------------------------------------------------------------------
// Remittance (Form M)
// ---------------------------------------------------------------------------

describe('remittance', () => {
  it('balances when the deposit ties out', () => {
    const r = reconcileRemittance({
      fees_collected_cents: 500000,
      fines_collected_cents: 10000,
      stalls_camp_gate_cents: 40000,
      prize_paid_cents: 300000,
      assn_cut_sent_cents: 50000,
      unclaimed_sent_cents: 20000,
      deposit_cents: 180000,
    });
    assert.equal(r.money_in_cents, 550000);
    assert.equal(r.money_out_cents, 370000);
    assert.equal(r.expected_deposit_cents, 180000);
    assert.equal(r.over_short_cents, 0);
    assert.equal(r.balanced, true);
  });

  it('reports a shortage exactly', () => {
    const r = reconcileRemittance({
      fees_collected_cents: 100000,
      fines_collected_cents: 0,
      stalls_camp_gate_cents: 0,
      prize_paid_cents: 0,
      assn_cut_sent_cents: 0,
      unclaimed_sent_cents: 0,
      deposit_cents: 99500,
    });
    assert.equal(r.over_short_cents, -500);
    assert.equal(r.balanced, false);
    assert.equal(r.issues.some((i) => i.code === 'OUT_OF_BALANCE'), true);
  });

  it('flags a negative amount', () => {
    const r = reconcileRemittance({
      fees_collected_cents: -100,
      fines_collected_cents: 0,
      stalls_camp_gate_cents: 0,
      prize_paid_cents: 0,
      assn_cut_sent_cents: 0,
      unclaimed_sent_cents: 0,
    });
    assert.equal(r.issues.some((i) => i.code === 'NEGATIVE_AMOUNT'), true);
  });

  it('warns when the books disagree with the cover sheet', () => {
    const r = reconcileRemittance({
      fees_collected_cents: 100000,
      fines_collected_cents: 0,
      stalls_camp_gate_cents: 0,
      prize_paid_cents: 60000,
      assn_cut_sent_cents: 0,
      unclaimed_sent_cents: 0,
      deposit_cents: 40000,
      ledger: { prize_paid_cents: 65000 },
    });
    assert.equal(r.issues.some((i) => i.code === 'LEDGER_MISMATCH'), true);
  });
});

// ---------------------------------------------------------------------------
// Packet + deadline (Form M)
// ---------------------------------------------------------------------------

describe('association packet', () => {
  it('gives a per-association required list', () => {
    const prca = requiredPacketItems('PRCA');
    assert.equal(prca.includes('results_master'), true);
    assert.equal(prca.includes('check_distribution'), true);
    const cajun = requiredPacketItems('Cajun RA');
    assert.equal(cajun.includes('receivables_report'), true);
  });

  it('falls back to a generic list for an unknown association', () => {
    const items = requiredPacketItems('Some Local Assn');
    assert.equal(items.length > 0, true);
  });

  it('flags missing items', () => {
    const check = checkPacket('PRCA', ['results_master', 'judge_sheets']);
    assert.equal(check.ready, false);
    assert.equal(check.missing.length > 0, true);
    assert.equal(check.items.length, requiredPacketItems('PRCA').length);
  });

  it('is ready when everything required is present', () => {
    const check = checkPacket('PSRA', requiredPacketItems('PSRA'));
    assert.equal(check.ready, true);
    assert.equal(check.missing.length, 0);
  });

  it('computes the PRCA 11:59pm Mountain deadline', () => {
    const d = associationPacketDeadline({
      association: 'PRCA',
      last_performance_date: '2026-07-04',
      now_ms: Date.parse('2026-07-04T12:00:00Z'),
    });
    assert.equal(d.mode, 'walltime');
    assert.ok(d.due_at);
    // 23:59 MDT on 2026-07-04 is 05:59Z on 2026-07-05.
    assert.equal(d.due_at, '2026-07-05T05:59:00.000Z');
    assert.equal(d.passed, false);
  });

  it('computes an IPRA 3-working-day deadline skipping the weekend', () => {
    // 2026-07-02 is a Thursday; +3 working days = Tuesday 2026-07-07.
    const d = associationPacketDeadline({
      association: 'IPRA',
      last_performance_date: '2026-07-02',
      now_ms: Date.parse('2026-07-02T12:00:00Z'),
      timezone: 'America/Chicago',
    });
    assert.equal(d.mode, 'working_days');
    assert.equal(d.due_date, '2026-07-07');
  });

  it('returns no fixed deadline for WPRA', () => {
    const d = associationPacketDeadline({
      association: 'WPRA',
      last_performance_date: '2026-07-04',
      now_ms: Date.now(),
    });
    assert.equal(d.mode, 'as_published');
    assert.equal(d.due_at, null);
  });
});
