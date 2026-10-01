/**
 * The offline desk, end to end: one secretary, one browser, the wifi gone
 * after the draw is posted, and POST /sync when it comes back.
 *
 * These go through the real Fastify app and a real database with RLS on,
 * because what is being asserted is what the server DOES with a queue that
 * spent the night on a laptop — which changes land, which are refused, and
 * that a refusal is one change's and not the whole night's.
 *
 * Requires: TEST_DATABASE_URL, as for the other integration tests.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { calculatePayout, type ScoringConfig } from '@rodeo-os/engine';

import { buildApp } from '../src/app.ts';
import { Database, createSql } from '../src/core/database/client.ts';

const url = process.env.TEST_DATABASE_URL;

describe('offline desk sync', { skip: url ? false : 'TEST_DATABASE_URL not set' }, () => {
  let db: Database;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let plainApp: Awaited<ReturnType<typeof buildApp>>;

  const org = randomUUID();
  const auth = randomUUID();
  const sec = randomUUID();
  const rodeo = randomUUID();
  const scoringConfig = randomUUID();
  const payoutConfig = randomUUID();

  // One event per concern, so no test depends on another's runs.
  const evScore = randomUUID(); // scoring, authority, idempotency, turnouts, trades
  const evCheck = randomUUID(); // judge card against timer sheet
  const evPay = randomUUID(); // finalize then cash
  const evMismatch = randomUUID(); // an envelope that is not the server's

  const people = Array.from({ length: 16 }, () => randomUUID());
  const entries: Record<string, { id: string; contestant: string; event: string }> = {};

  // Performance 1 starts in two days: enough notice for a turnout told now.
  const perf1At = new Date(Date.now() + 48 * 3_600_000);
  perf1At.setUTCMilliseconds(0);
  const perf2At = new Date(perf1At.getTime() + 24 * 3_600_000);

  const TIMED: ScoringConfig = {
    mode: 'timed',
    time_precision: 2,
    timed_penalties: [{ type: 'barrier_break', seconds: 10 }],
    dq_triggers: ['no_catch'],
  };
  const LADDER = {
    fee_structure: { admin_pct: 0.06, office_fee_flat: 500 },
    payout_rules: [
      { min_entries: 1, max_entries: 99, places_paid: 2, splits: [0.6, 0.4] },
    ],
    ground_money_rule: 'combine_and_split',
  };

  let clock = Date.parse('2026-10-01T19:00:00.000Z');
  const ts = () => new Date((clock += 1000)).toISOString();

  const headers = { authorization: 'Bearer test' };

  function verifier(permissions: string[]) {
    return {
      verify: async () => ({
        sub: auth,
        exp: 9e9,
        iat: 0,
        email: 'sam@example.com',
        app_metadata: {
          user_id: sec,
          org_memberships: [{ org_id: org, role: 'secretary', permissions }],
        },
      }),
    } as never;
  }

  async function sync(changes: unknown[], through = app) {
    const res = await through.inject({
      method: 'POST',
      url: `/v1/orgs/${org}/sync`,
      headers,
      payload: {
        client_id: 'desk-test-laptop',
        last_sync_at: '2026-01-01T00:00:00.000Z',
        changes,
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body).data as {
      accepted: string[];
      rejected: { client_change_id: string; resolution: string; reason: string; explanation: string }[];
    };
  }

  function scoreChange(
    key: string,
    raw: number | null,
    card: number | null | undefined,
    extra: Record<string, unknown> = {},
  ) {
    const e = entries[key];
    return {
      id: randomUUID(),
      entity_type: 'score',
      action: 'create',
      timestamp: ts(),
      source: 'secretary',
      data: {
        rodeo_id: rodeo,
        rodeo_event_id: e.event,
        entry_id: e.id,
        contestant_id: e.contestant,
        go_round: 1,
        scoring_config_id: scoringConfig,
        source: 'secretary',
        raw_time: raw,
        ...(card !== undefined
          ? { cross_check: { kind: 'timed', judge_card: { raw_time: card } } }
          : {}),
      },
      ...extra,
    };
  }

  const scoresFor = (key: string) => db.raw<{ id: string; source: string; final_time: string | null }[]>`
    select id, source, final_time from scores where entry_id = ${entries[key].id}
  `;

  before(async () => {
    db = new Database(createSql({ connectionString: url!, max: 5 }));

    let n = 0;
    const add = (key: string, event: string, perf: number | null, pos: number | null) => {
      entries[key] = { id: randomUUID(), contestant: people[n++], event };
      return { ...entries[key], perf, pos };
    };
    const rows = [
      add('live', evScore, 1, 1),
      add('once', evScore, 1, 2),
      add('hardware', evScore, 1, 3),
      add('equal', evScore, 1, 4),
      add('good1', evScore, 1, 5),
      add('bad', evScore, 1, 6),
      add('good2', evScore, 1, 7),
      add('turnout', evScore, 1, 8),
      add('tradeA', evScore, 1, 9),
      add('tradeB', evScore, 2, 1),
      add('check', evCheck, 1, 1),
      add('pay1', evPay, 1, 1),
      add('pay2', evPay, 1, 2),
      add('mis1', evMismatch, 1, 1),
      add('mis2', evMismatch, 1, 2),
    ];

    await db.asService('offline desk sync fixture', async (tx) => {
      await tx`insert into organizations (id, name, slug, type)
               values (${org}, 'Desk Co', ${'desk-' + org.slice(0, 8)}, 'producer')`;
      await tx`insert into users (id, first_name, last_name, supabase_auth_id)
               values (${sec}, 'Sam', 'Secretary', ${auth})`;
      for (let i = 0; i < people.length; i++) {
        await tx`insert into users (id, first_name, last_name)
                 values (${people[i]}, ${'Roper'}, ${'Number ' + (i + 1)})`;
      }
      await tx`insert into org_members (org_id, user_id, role, accepted_at)
               values (${org}, ${sec}, 'secretary', now())`;
      await tx`insert into scoring_configs (id, org_id, name, is_system, config)
               values (${scoringConfig}, ${org}, 'Desk Timed', false,
                       ${tx.json(TIMED as unknown as Record<string, unknown>)})`;
      await tx`insert into payout_configs (id, org_id, name, is_system, config)
               values (${payoutConfig}, ${org}, 'Desk Ladder', false, ${tx.json(LADDER)})`;
      await tx`insert into rodeos (id, org_id, name, slug, start_date, end_date,
                                   rodeo_type, status)
               values (${rodeo}, ${org}, 'Desk Jackpot', ${'dj-' + rodeo.slice(0, 8)},
                       '2026-10-03', '2026-10-04', 'jackpot', 'in_progress')`;
      await tx`insert into performances (org_id, rodeo_id, performance_number, name, scheduled_start)
               values (${org}, ${rodeo}, 1, 'Friday', ${perf1At.toISOString()}),
                      (${org}, ${rodeo}, 2, 'Saturday', ${perf2At.toISOString()})`;
      const types = ['breakaway_roping', 'steer_wrestling', 'goat_tying', 'chute_dogging'];
      for (const [i, ev] of [evScore, evCheck, evPay, evMismatch].entries()) {
        await tx`insert into rodeo_events (id, org_id, rodeo_id, event_type, scoring_mode,
                                           entry_fee, added_money, scoring_config_id,
                                           payout_config_id, sort_order)
                 values (${ev}, ${org}, ${rodeo}, ${types[i]}, 'timed',
                         100, 500, ${scoringConfig}, ${payoutConfig}, ${i})`;
      }
      for (const r of rows) {
        await tx`insert into entries (id, org_id, rodeo_id, rodeo_event_id, contestant_id,
                                      status, entry_fee_amount, fees_paid,
                                      performance_number, draw_position)
                 values (${r.id}, ${org}, ${rodeo}, ${r.event}, ${r.contestant},
                         'drawn', 100, true, ${r.perf}, ${r.pos})`;
      }
      // A hardware time already on the server, and a secretary's own score.
      await tx`insert into scores (org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id,
                                   go_round, raw_time, final_time, status, source,
                                   scoring_config_id)
               values (${org}, ${rodeo}, ${evScore}, ${entries.hardware.id},
                       ${entries.hardware.contestant}, 1, 9.10, 9.10, 'official',
                       'timer_hardware', ${scoringConfig}),
                      (${org}, ${rodeo}, ${evScore}, ${entries.equal.id},
                       ${entries.equal.contestant}, 1, 11.00, 11.00, 'official',
                       'secretary', ${scoringConfig})`;
    });

    // She is the secretary; the producer has granted her the cash box.
    app = await buildApp({ db, logger: false, verifier: verifier(['payout.disburse']) });
    // The same secretary without that grant.
    plainApp = await buildApp({ db, logger: false, verifier: verifier([]) });
  });

  after(async () => {
    if (app) await app.close();
    if (plainApp) await plainApp.close();
    if (!db) return;
    await db.raw.begin(async (tx) => {
      await tx`set local session_replication_role = 'replica'`;
      await tx`delete from transaction_status_events where org_id = ${org}`;
      await tx`delete from financial_transactions where org_id = ${org}`;
      await tx`delete from results where org_id = ${org}`;
      await tx`delete from scores where org_id = ${org}`;
      await tx`delete from entries where org_id = ${org}`;
      await tx`delete from performances where org_id = ${org}`;
      await tx`delete from rodeo_events where org_id = ${org}`;
      await tx`delete from rodeos where org_id = ${org}`;
      await tx`delete from scoring_configs where org_id = ${org}`;
      await tx`delete from payout_configs where org_id = ${org}`;
      await tx`delete from org_members where org_id = ${org}`;
      await tx`delete from users where id in ${tx([sec, ...people])}`;
      await tx`delete from organizations where id = ${org}`;
    });
    await db.close();
  });

  // =========================================================================

  it('the live score path is the real route and needs scoring_config_id', async () => {
    const e = entries.live;
    const path = `/v1/orgs/${org}/rodeos/${rodeo}/events/${evScore}/scores`;
    const body = {
      entry_id: e.id,
      contestant_id: e.contestant,
      go_round: 1,
      scoring_config_id: scoringConfig,
      source: 'secretary',
      raw_time: 8.4,
      cross_check: { kind: 'timed', judge_card: { raw_time: 8.4 } },
    };

    const without = await app.inject({
      method: 'POST', url: path, headers,
      payload: { ...body, scoring_config_id: undefined },
    });
    assert.equal(without.statusCode, 400, 'scoring_config_id is required');

    const res = await app.inject({ method: 'POST', url: path, headers, payload: body });
    assert.equal(res.statusCode, 201, res.body);

    const [row] = await db.raw<{ source: string; final_time: string; cross_check: unknown }[]>`
      select source, final_time, cross_check from scores where entry_id = ${e.id}
    `;
    assert.equal(row.source, 'secretary', 'her score is stored as hers, rank 30');
    assert.equal(Number(row.final_time), 8.4);
    assert.deepEqual(row.cross_check, { kind: 'timed', judge_card: { raw_time: 8.4 } });
  });

  it('reconnect accepts a queued score once; the same change id writes no second score', async () => {
    const change = scoreChange('once', 10.25, 10.25);

    const first = await sync([change]);
    assert.deepEqual(first.accepted, [change.id]);

    const again = await sync([change]);
    assert.deepEqual(again.accepted, [change.id], 'a retried drain is still accepted');

    const rows = await scoresFor('once');
    assert.equal(rows.length, 1, 'one score, not two');
    assert.equal(rows[0].id, change.id);
    assert.equal(Number(rows[0].final_time), 10.25);
  });

  it('a hardware time already on the server is not replaced by the laptop', async () => {
    const change = scoreChange('hardware', 12.0, 12.0);
    const out = await sync([change]);

    assert.equal(out.accepted.length, 0);
    assert.equal(out.rejected[0].resolution, 'server_wins');
    assert.match(out.rejected[0].explanation, /timer_hardware/);

    const rows = await scoresFor('hardware');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].final_time), 9.1, 'the hardware time stands');
    assert.equal(rows[0].source, 'timer_hardware');
  });

  it('two secretary scores with different base versions come back manual_required', async () => {
    // The server holds a secretary's score at version 0; this laptop edited
    // a version the server does not hold.
    const stale = scoreChange('equal', 11.5, 11.5, { base_version: 3, action: 'update' });
    const out = await sync([stale]);
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0].resolution, 'manual_required');

    let [row] = await scoresFor('equal');
    assert.equal(Number(row.final_time), 11, 'nothing was overwritten');

    // Once she has looked and keeps hers, it goes against the version the
    // server holds, and applies — in place, with the history recorded.
    const chosen = scoreChange('equal', 11.5, 11.5, { base_version: 0, action: 'update' });
    const second = await sync([chosen]);
    assert.deepEqual(second.accepted, [chosen.id]);
    const rows = await scoresFor('equal');
    assert.equal(rows.length, 1, 'still one live score for the run');
    [row] = rows;
    assert.equal(Number(row.final_time), 11.5);
  });

  it('one invalid change is rejected alone; the rest of the batch lands', async () => {
    const good1 = scoreChange('good1', 9.9, 9.9);
    const bad = scoreChange('bad', -4, -4); // the engine refuses a negative time
    const good2 = scoreChange('good2', 10.1, 10.1);

    const out = await sync([good1, bad, good2]);
    assert.deepEqual(out.accepted.sort(), [good1.id, good2.id].sort());
    assert.equal(out.rejected.length, 1);
    assert.equal(out.rejected[0].client_change_id, bad.id);
    assert.equal(out.rejected[0].reason, 'validation_error');
    assert.match(out.rejected[0].explanation, /engine refused/);

    assert.equal((await scoresFor('good1')).length, 1);
    assert.equal((await scoresFor('bad')).length, 0);
    assert.equal((await scoresFor('good2')).length, 1);
  });

  it('a result is never accepted from the laptop', async () => {
    const out = await sync([{
      id: randomUUID(), entity_type: 'result', action: 'create', timestamp: ts(),
      source: 'secretary', data: { rodeo_event_id: evScore, place: 1 },
    }]);
    assert.equal(out.accepted.length, 0);
    assert.equal(out.rejected[0].resolution, 'server_wins');
  });

  it('official is refused while the judge card and the timer sheet disagree', async () => {
    const score = scoreChange('check', 10.0, 10.5); // the flag judge wrote 10.5
    const finalize = {
      id: randomUUID(), entity_type: 'finalize', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: { rodeo_id: rodeo, rodeo_event_id: evCheck, official: true, confirm: true },
    };
    const out = await sync([score, finalize]);
    assert.deepEqual(out.accepted, [score.id], 'the score itself is recorded');
    const refused = out.rejected.find((r) => r.client_change_id === finalize.id)!;
    assert.equal(refused.resolution, 'manual_required');
    assert.equal(refused.reason, 'desk_rule');
    assert.match(refused.explanation, /judge card and the timer sheet do not agree/);

    // The live route refuses the same way, and without her confirmation.
    const path = `/v1/orgs/${org}/rodeos/${rodeo}/events/${evCheck}/finalize`;
    const unconfirmed = await app.inject({ method: 'POST', url: path, headers, payload: { official: true } });
    assert.equal(unconfirmed.statusCode, 400);
    const blocked = await app.inject({
      method: 'POST', url: path, headers, payload: { official: true, confirm: true },
    });
    assert.equal(blocked.statusCode, 409);
    assert.equal(JSON.parse(blocked.body).error.code, 'CARDS_DISAGREE');

    const official = await db.raw`select 1 from results where rodeo_event_id = ${evCheck} and is_official`;
    assert.equal(official.length, 0, 'nothing went official');
  });

  it('a queued Make official then a queued cash payout does not calculate to $0', async () => {
    const s1 = scoreChange('pay1', 8.1, 8.1);
    const s2 = scoreChange('pay2', 9.2, 9.2);
    const finalize = {
      id: randomUUID(), entity_type: 'finalize', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: { rodeo_id: rodeo, rodeo_event_id: evPay, official: true, confirm: true },
    };

    // What the laptop figured, with the same engine function.
    const offline = calculatePayout({
      payout_config: LADDER as never,
      scoring_mode: 'timed',
      entries: [
        { contestant_id: entries.pay1.contestant, status: 'drawn', entry_fee_cents: 10000 },
        { contestant_id: entries.pay2.contestant, status: 'drawn', entry_fee_cents: 10000 },
      ],
      results: [
        { contestant_id: entries.pay1.contestant, status: 'official', final_time: 8.1 },
        { contestant_id: entries.pay2.contestant, status: 'official', final_time: 9.2 },
      ],
      added_money_cents: 50000,
      entry_fee_cents: 10000,
    });
    const lines = offline.payouts.filter((p) => p.contestant_id && p.amount_cents > 0);
    const envelopeTotal = lines.reduce((s, l) => s + l.amount_cents, 0);
    assert.ok(envelopeTotal > 0);
    assert.equal(
      envelopeTotal + offline.unpaid_cents + offline.escrow_cents,
      offline.net_purse_cents,
      'the laptop\'s lines add up to the net purse',
    );

    const cash = {
      id: randomUUID(), entity_type: 'cash', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: {
        rodeo_id: rodeo, rodeo_event_id: evPay, confirm: true, payment_method: 'cash',
        envelope_total_cents: envelopeTotal,
        lines: lines.map((l) => ({ contestant_id: l.contestant_id, amount_cents: l.amount_cents })),
      },
    };

    const out = await sync([s1, s2, finalize, cash]);
    assert.deepEqual(out.rejected, []);
    assert.deepEqual(out.accepted, [s1.id, s2.id, finalize.id, cash.id]);

    const [ledger] = await db.raw<{ total: string; n: string }[]>`
      select sum(amount) as total, count(*) as n from financial_transactions
       where org_id = ${org} and idempotency_key like ${'disburse-' + evPay + ':%'}
    `;
    assert.equal(Math.round(Number(ledger.total) * 100), envelopeTotal, 'paid to the cent');
    assert.ok(Number(ledger.n) > 0);

    const statuses = await db.raw<{ to_status: string }[]>`
      select distinct on (e.transaction_id) e.to_status
        from transaction_status_events e
        join financial_transactions t on t.id = e.transaction_id
       where t.idempotency_key like ${'disburse-' + evPay + ':%'}
       order by e.transaction_id, e.created_at desc, e.id desc
    `;
    assert.ok(statuses.every((s) => s.to_status === 'completed'), 'settled as cash on the spot');

    // A retried drain pays nobody twice.
    const again = await sync([cash]);
    assert.deepEqual(again.accepted, [cash.id]);
    const [count] = await db.raw<{ n: string }[]>`
      select count(*) as n from financial_transactions
       where org_id = ${org} and idempotency_key like ${'disburse-' + evPay + ':%'}
    `;
    assert.equal(count.n, ledger.n);
  });

  it('an envelope total different from the server\'s is manual_required, and nothing is paid', async () => {
    const s1 = scoreChange('mis1', 7.7, 7.7);
    const s2 = scoreChange('mis2', 8.8, 8.8);
    const finalize = {
      id: randomUUID(), entity_type: 'finalize', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: { rodeo_id: rodeo, rodeo_event_id: evMismatch, official: true, confirm: true },
    };
    const cash = {
      id: randomUUID(), entity_type: 'cash', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: {
        rodeo_id: rodeo, rodeo_event_id: evMismatch, confirm: true, payment_method: 'cash',
        envelope_total_cents: 999_999,
      },
    };

    const out = await sync([s1, s2, finalize, cash]);
    assert.deepEqual(out.accepted, [s1.id, s2.id, finalize.id]);
    const refused = out.rejected.find((r) => r.client_change_id === cash.id)!;
    assert.equal(refused.resolution, 'manual_required');
    assert.match(refused.explanation, /envelopes total \$9999\.99/);

    const paid = await db.raw`
      select 1 from financial_transactions
       where org_id = ${org} and idempotency_key like ${'disburse-' + evMismatch + ':%'}
    `;
    assert.equal(paid.length, 0);
  });

  it('cash needs its own permission; without it only that change is refused', async () => {
    const turn = {
      id: randomUUID(), entity_type: 'cash', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: { rodeo_id: rodeo, rodeo_event_id: evPay, confirm: true, envelope_total_cents: 1 },
    };
    const out = await sync([turn], plainApp);
    assert.equal(out.accepted.length, 0);
    assert.match(out.rejected[0].explanation, /payout\.disburse/);
  });

  it('a turnout is classified by the time she recorded it, and applies once', async () => {
    // Told 40 hours before the performance — in time — but synced later.
    const toldAt = new Date(perf1At.getTime() - 40 * 3_600_000).toISOString();
    const change = {
      id: randomUUID(), entity_type: 'turnout', action: 'create', timestamp: ts(),
      source: 'secretary',
      data: {
        rodeo_id: rodeo, entry_id: entries.turnout.id, release_type: 'personal',
        performance_at: perf1At.toISOString(), notified_at: toldAt,
      },
    };
    const out = await sync([change]);
    assert.deepEqual(out.accepted, [change.id]);

    const [row] = await db.raw<{ status: string; turnout_notified_at: Date }[]>`
      select status, turnout_notified_at from entries where id = ${entries.turnout.id}
    `;
    assert.equal(row.status, 'turned_out');
    assert.equal(row.turnout_notified_at.toISOString(), toldAt, 'her time, not the sync time');

    const again = await sync([change]);
    assert.deepEqual(again.accepted, [change.id], 'the same turnout is accepted once');
  });

  it('a trade swaps two drawn positions across performances, once, and never blind', async () => {
    const a = { entry_id: entries.tradeA.id, performance_number: 1, draw_position: 9 };
    const b = { entry_id: entries.tradeB.id, performance_number: 2, draw_position: 1 };
    const change = {
      id: randomUUID(), entity_type: 'trade', action: 'create', timestamp: ts(),
      source: 'secretary', data: { rodeo_id: rodeo, rodeo_event_id: evScore, a, b },
    };

    const out = await sync([change]);
    assert.deepEqual(out.accepted, [change.id]);
    const slots = async () => Object.fromEntries((await db.raw<
      { id: string; performance_number: number; draw_position: number }[]
    >`select id, performance_number, draw_position from entries
       where id in (${entries.tradeA.id}, ${entries.tradeB.id})`)
      .map((r) => [r.id, [r.performance_number, r.draw_position]]));

    assert.deepEqual(await slots(), {
      [entries.tradeA.id]: [2, 1],
      [entries.tradeB.id]: [1, 9],
    });

    // Retried: already applied, so nothing swaps back.
    await sync([change]);
    assert.deepEqual((await slots())[entries.tradeA.id], [2, 1]);

    // Made against positions they no longer hold: refused, for her to look at.
    const stale = { ...change, id: randomUUID(), timestamp: ts(),
      data: { ...change.data, a: { ...a, draw_position: 4 } } };
    const refused = await sync([stale]);
    assert.equal(refused.rejected[0].resolution, 'manual_required');
  });

  it('the packet is one read with the day sheet, its text, the configs and who has paid', async () => {
    const res = await app.inject({
      method: 'GET', url: `/v1/orgs/${org}/rodeos/${rodeo}/offline-packet`, headers,
    });
    assert.equal(res.statusCode, 200, res.body);
    const p = JSON.parse(res.body).data;
    assert.equal(p.packet_version, 1);
    assert.equal(p.rodeo_id, rodeo);
    assert.ok(p.day_sheets.length >= 3, 'the whole rodeo and each performance');
    assert.ok(p.day_sheets.every((s: { text: string }) => s.text.includes('Desk Jackpot')));
    const ev = p.events.find((e: { id: string }) => e.id === evScore);
    assert.deepEqual(ev.scoring_config.timed_penalties, TIMED.timed_penalties);
    assert.ok(ev.payout_config.payout_rules);
    assert.ok(p.entries.every((e: { fees_paid: boolean }) => typeof e.fees_paid === 'boolean'));
    assert.ok(p.rodeo.performances.every((x: { performance_at: string }) => x.performance_at));
    assert.ok(p.day_sheets[0].sheet.sections[0].runs[0].entry_id, 'runs carry their entry');
  });
});
