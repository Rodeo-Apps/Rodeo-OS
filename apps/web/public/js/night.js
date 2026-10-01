/**
 * The night, as this browser knows it.
 *
 * ---------------------------------------------------------------------------
 * THE PACKET, PLUS EVERYTHING SHE HAS DONE SINCE
 * ---------------------------------------------------------------------------
 * The packet is what the server knew when she downloaded it. The queue is what
 * she has done since that the server has not yet accepted. This module lays
 * one over the other so every screen shows the night as she is running it —
 * and marks every value that exists only on this laptop.
 *
 * All arithmetic is the engine's, imported from /engine/ (served by
 * apps/web/server.ts with the types stripped). Scores, the judge card against
 * the timer sheet, turnout classification, placings and the payout are the
 * same functions the server runs. What lives here is only the bookkeeping of
 * which rows go into them, written to match the server's loaders
 * (loadPayoutContext, loadScoresForResults) so the laptop's envelope and the
 * server's recalculation agree to the cent.
 * ---------------------------------------------------------------------------
 */

import * as engine from '/engine/index.ts';

export { engine };

const LIVE = new Set(['pending', 'confirmed', 'drawn']);

export const keyOf = (entryId, goRound) => `${entryId}:${goRound ?? 1}`;

/** The engine call the server's scoreRun() makes. */
export function computeScore(config, body) {
  return config.mode === 'judged'
    ? engine.calculateJudgedScore(
        { judges: body.judges ?? [], marked_out: body.marked_out, dq_triggers: body.dq_triggers },
        config,
      )
    : engine.calculateTimedScore(
        {
          raw_time: body.raw_time ?? null,
          penalties: body.penalties,
          barrels_knocked: body.barrels_knocked,
          tie_held_seconds: body.tie_held_seconds,
          source: body.source,
          dq_triggers: body.dq_triggers,
        },
        config,
      );
}

/** A queued score change turned into the row the server would store. */
export function scoreRowFromChange(packet, row) {
  const d = row.change.data;
  const event = packet.events.find((e) => e.id === d.rodeo_event_id);
  const config = event?.scoring_config ? { ...event.scoring_config, id: event.scoring_config_id } : null;
  const r = config ? computeScore(config, d) : null;
  const judged = r?.kind === 'judged';
  return {
    id: row.change.id,
    entry_id: d.entry_id,
    rodeo_event_id: d.rodeo_event_id,
    go_round: d.go_round ?? 1,
    status: r?.valid ? r.status : 'invalid',
    source: d.source ?? 'secretary',
    raw_time: judged ? null : (r?.raw_time ?? null),
    time_penalties: judged ? [] : (r?.penalties_applied ?? []),
    final_time: judged ? null : (r?.final_time ?? null),
    judge_scores: judged ? (r?.judge_scores ?? []) : [],
    final_score: judged ? (r?.final_score ?? null) : null,
    cross_check: d.cross_check ?? null,
    on_server: false,
    queue_state: row.state,
    seq: row.seq,
  };
}

/**
 * The night: packet + queue.
 *
 * Returns maps and lists every screen reads from. A value with
 * `on_server: false` exists only on this laptop.
 */
export function nightState(packet, queueRows) {
  const rows = queueRows.filter((r) => r.rodeo_id === packet.rodeo_id);

  const scores = new Map();
  for (const s of packet.scores) {
    if (['provisional', 'official', 'no_time', 'dq'].includes(s.status)) {
      scores.set(keyOf(s.entry_id, s.go_round), { ...s, on_server: true });
    }
  }

  const entries = new Map(packet.entries.map((e) => [e.entry_id, { ...e, on_server: true }]));
  const finalized = new Map(); // event id -> { official, on_server }
  const paid = new Map(); // event id -> { total_cents, on_server }
  for (const ev of packet.events) {
    if (ev.results_official) finalized.set(ev.id, { official: true, on_server: true });
    if (ev.disbursed) paid.set(ev.id, { on_server: true });
  }

  for (const row of rows) {
    const { entity_type, data } = row.change;
    if (entity_type === 'score') {
      scores.set(keyOf(data.entry_id, data.go_round), scoreRowFromChange(packet, row));
    } else if (entity_type === 'turnout') {
      const e = entries.get(data.entry_id);
      if (e) {
        const verdict = engine.classifyTurnout({
          notified_at: data.notified_at,
          performance_at: data.performance_at,
          release_type: data.release_type,
        });
        entries.set(data.entry_id, {
          ...e,
          status: verdict.status,
          release_type: data.release_type,
          turnout: verdict,
          on_server: false,
          queue_state: row.state,
        });
      }
    } else if (entity_type === 'trade') {
      const a = entries.get(data.a.entry_id);
      const b = entries.get(data.b.entry_id);
      if (a && b) {
        entries.set(a.entry_id, {
          ...a,
          performance_number: data.b.performance_number,
          draw_position: data.b.draw_position,
          on_server: false,
          queue_state: row.state,
        });
        entries.set(b.entry_id, {
          ...b,
          performance_number: data.a.performance_number,
          draw_position: data.a.draw_position,
          on_server: false,
          queue_state: row.state,
        });
      }
    } else if (entity_type === 'finalize') {
      if (data.official) {
        finalized.set(data.rodeo_event_id, { official: true, on_server: false, queue_state: row.state });
      }
    } else if (entity_type === 'cash') {
      paid.set(data.rodeo_event_id, {
        total_cents: data.envelope_total_cents,
        on_server: false,
        queue_state: row.state,
      });
    }
  }

  return { packet, rows, scores, entries, finalized, paid };
}

export function eventConfig(packet, eventId) {
  const ev = packet.events.find((e) => e.id === eventId);
  if (!ev?.scoring_config) return null;
  return { ...ev.scoring_config, id: ev.scoring_config_id };
}

/** The judge card against the timer sheet for one stored or queued score. */
export function crossCheck(config, score) {
  if (!config || !score) return null;
  const check = score.cross_check;
  if (config.mode === 'judged') {
    return engine.compareJudgedTotal(config, score.judge_scores ?? [], check?.kind === 'judged' ? check : null);
  }
  return engine.compareTimedCard(
    config,
    { status: score.status, raw_time: score.raw_time, penalties_applied: score.time_penalties ?? [] },
    check?.kind === 'timed' ? check.judge_card : null,
  );
}

/** Every run in the event that stops it going official or being paid. */
export function eventBlockers(state, eventId) {
  const config = eventConfig(state.packet, eventId);
  const out = [];
  for (const s of state.scores.values()) {
    if (s.rodeo_event_id !== eventId) continue;
    if (!['provisional', 'official', 'no_time'].includes(s.status)) continue;
    const verdict = crossCheck(config, s);
    if (verdict && !verdict.ok) {
      const e = state.entries.get(s.entry_id);
      out.push({ ...verdict, entry_id: s.entry_id, contestant_name: e?.contestant_name ?? '' });
    }
  }
  return out;
}

const cents = (v) => Math.round(Number(v ?? 0) * 100);

/**
 * The payout for one event from this laptop's runs: the same rows the
 * server's loadPayoutContext() reads, handed to the same engine function.
 */
export function eventPayout(state, eventId) {
  const ev = state.packet.events.find((e) => e.id === eventId);
  if (!ev || !ev.payout_config || !ev.payout) return { ok: false, reason: 'This event has no payout table.' };

  const config = ev.payout_config;
  const judged = ev.scoring_mode === 'judged';
  const isTeamEvent = config.team_payout !== undefined;

  const entryRows = [...state.entries.values()].filter((e) => e.rodeo_event_id === eventId);
  const partnerOf = new Map(entryRows.map((e) => [e.entry_id, e.partner_id]));
  const scoreRows = [...state.scores.values()]
    .filter((s) => s.rodeo_event_id === eventId && ['official', 'no_time', 'dq'].includes(s.status))
    .map((s) => ({ ...s, contestant_id: state.entries.get(s.entry_id)?.contestant_id }))
    .filter((s) => s.contestant_id)
    .sort((a, b) => a.go_round - b.go_round || String(a.id).localeCompare(String(b.id)));

  const toRankable = (r) => ({
    contestant_id: isTeamEvent ? r.entry_id : r.contestant_id,
    status: r.status,
    final_score: judged && r.final_score !== null ? Number(r.final_score) : null,
    final_time: !judged && r.final_time !== null ? Number(r.final_time) : null,
    ...(isTeamEvent
      ? {
          team_members: partnerOf.get(r.entry_id)
            ? [r.contestant_id, partnerOf.get(r.entry_id)]
            : [r.contestant_id],
        }
      : {}),
  });

  const byRound = new Map();
  for (const r of scoreRows) {
    const bucket = byRound.get(r.go_round) ?? [];
    bucket.push(toRankable(r));
    byRound.set(r.go_round, bucket);
  }

  // The average comes from results, which Make official writes on the server.
  // Here it is computed the same way, from the same runs.
  const computed = engine.computeResults({
    scores: scoreRows.map((s) => ({
      contestant_id: isTeamEvent ? s.entry_id : s.contestant_id,
      entry_id: s.entry_id,
      team_members: isTeamEvent
        ? partnerOf.get(s.entry_id) ? [s.contestant_id, partnerOf.get(s.entry_id)] : [s.contestant_id]
        : undefined,
      go_round: s.go_round,
      status: s.status,
      final_score: s.final_score === null ? null : Number(s.final_score),
      final_time: s.final_time === null ? null : Number(s.final_time),
    })),
    scoring_config: ev.scoring_config ?? { mode: ev.scoring_mode },
    num_go_rounds: ev.num_go_rounds,
    d_format: ev.is_d_format ? ev.d_format_config : null,
  });
  const averages = engine
    .expandTeamResults(computed.results)
    .filter((r) => r.result_type === 'average')
    .map((a) => ({
      contestant_id: a.contestant_id,
      status: 'official',
      final_score: judged ? Number(a.aggregate_score ?? 0) : null,
      final_time: judged ? null : Number(a.aggregate_score ?? 0),
    }));

  const input = {
    payout_config: config,
    scoring_mode: ev.scoring_mode,
    entries: entryRows.map((e) => ({
      contestant_id: e.contestant_id,
      status: e.status,
      entry_fee_cents: e.entry_fee_amount !== null && e.entry_fee_amount !== undefined
        ? cents(e.entry_fee_amount)
        : undefined,
    })),
    added_money_cents: ev.payout.added_money_cents,
    entry_fee_cents: ev.payout.entry_fee_cents,
  };

  const result = config.go_round_average_split
    ? engine.calculateMultiRoundPayout({
        ...input,
        results_by_round: byRound,
        average_results: averages,
      })
    : engine.calculatePayout({ ...input, results: (byRound.get(1) ?? []).slice() });

  if (!result.ok) {
    return { ok: false, reason: result.issues.map((i) => i.message).join(' '), result };
  }
  const paidOut = result.payouts.reduce((s, p) => s + p.amount_cents, 0);
  if (paidOut + result.unpaid_cents + result.escrow_cents !== result.net_purse_cents) {
    return { ok: false, reason: 'The payout does not reconcile. Nothing should be paid from it.' };
  }
  return { ok: true, result };
}

/** The envelopes: one line per person handed money, as the server's envelopeLines(). */
export function envelopes(state, result) {
  const nameOf = new Map();
  for (const e of state.entries.values()) {
    nameOf.set(e.contestant_id, e.contestant_name);
    if (e.partner_id && e.partner_name) nameOf.set(e.partner_id, e.partner_name);
  }
  const lines = result.payouts
    .filter((p) => p.contestant_id && p.amount_cents > 0)
    .map((p) => ({
      contestant_id: p.contestant_id,
      name: nameOf.get(p.contestant_id) ?? p.contestant_id,
      place: p.place ?? null,
      type: p.type,
      go_round: p.go_round ?? null,
      amount_cents: p.amount_cents,
    }));
  return { lines, total_cents: lines.reduce((s, l) => s + l.amount_cents, 0) };
}

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n).slice(-n);
const dollars = (c) => `$${(c / 100).toFixed(2)}`;

/** The payoff list she fills envelopes from. Fixed width, like the day sheet. */
export function renderEnvelopeText(rodeoName, eventLabel, env, note) {
  const out = [];
  out.push(`${rodeoName}`);
  out.push(`PAYOFF — ${eventLabel}`);
  if (note) out.push(note);
  out.push('');
  out.push(`${pad('NAME', 28)} ${pad('PLACE', 6)} ${padL('AMOUNT', 11)}  PAID`);
  out.push('-'.repeat(54));
  for (const l of env.lines) {
    const place = l.place ? `${l.place}${l.go_round ? ` R${l.go_round}` : ''}` : l.type.replace(/_/g, ' ');
    out.push(`${pad(l.name, 28)} ${pad(place, 6)} ${padL(dollars(l.amount_cents), 11)}  CASH`);
  }
  out.push('-'.repeat(54));
  out.push(`${pad('TOTAL IN ENVELOPES', 35)} ${padL(dollars(env.total_cents), 11)}`);
  return out.join('\n');
}

/** Whether an entry can still be turned out or traded. */
export const isLive = (e) => LIVE.has(e.status);

// The day sheet engine's own rules (packages/engine/src/daysheet/engine.ts),
// so a sheet re-rendered on the laptop reads exactly like the server's.
const SCRATCHED = new Set(['scratched', 'turned_out', 'no_show']);

/**
 * A packet day sheet with what she has done since applied: a turnout marks
 * the run, a trade moves it — across performances, if that is the trade.
 * Returns null when nothing on this laptop touches the sheet, so the packet's
 * own text is printed unchanged.
 */
export function localSheet(state, performanceNumber) {
  const whole = state.packet.day_sheets.find((s) => s.performance_number === null);
  const target = state.packet.day_sheets.find((s) => s.performance_number === performanceNumber);
  if (!whole || !target) return null;

  const touched = state.rows.some((r) => ['turnout', 'trade'].includes(r.change.entity_type));
  if (!touched) return null;

  const pool = new Map();
  for (const sec of whole.sheet.sections) {
    pool.set(`${sec.rodeo_event_id}:${sec.go_round}`, sec.runs);
  }

  const sheet = structuredClone(target.sheet);
  let total = 0;
  for (const sec of sheet.sections) {
    const runs = (pool.get(`${sec.rodeo_event_id}:${sec.go_round}`) ?? sec.runs)
      .map((run) => ({ run, entry: state.entries.get(run.entry_id) }))
      .filter(({ entry }) =>
        performanceNumber === null || !entry || entry.performance_number === performanceNumber)
      .sort((a, b) => {
        const ap = a.entry?.draw_position ?? null;
        const bp = b.entry?.draw_position ?? null;
        if (ap === null && bp === null) return a.run.contestant_name.localeCompare(b.run.contestant_name);
        if (ap === null) return 1;
        if (bp === null) return -1;
        if (ap !== bp) return ap - bp;
        return a.run.contestant_name.localeCompare(b.run.contestant_name);
      });

    let position = 0;
    sec.runs = runs.map(({ run, entry }) => {
      const status = entry?.status;
      const scratched = status ? SCRATCHED.has(status) : run.is_scratched;
      if (!scratched) position += 1;
      const flags = run.flags.filter((f) => !['turned_out', 'scratched', 'no_show', 'medical_release'].includes(f));
      if (status === 'turned_out') flags.unshift('turned_out');
      if (status === 'scratched') flags.unshift('scratched');
      if (status === 'no_show') flags.unshift('no_show');
      if ((entry?.release_type ?? null) === 'medical') flags.push('medical_release');
      return { ...run, position: scratched ? 0 : position, is_scratched: scratched, flags };
    });
    sec.live_count = position;
    sec.entered_count = sec.runs.length;
    total += position;
  }
  sheet.total_runs = total;
  return sheet;
}
