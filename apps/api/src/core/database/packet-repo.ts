/**
 * The rodeo packet — what the secretary's browser takes with it when the wifi
 * is about to die.
 *
 * Read-only. Everything here is something she already has on paper before the
 * performance: the draw and the day sheet, who has paid, the ground rules
 * (the scoring config), the payout table, the judges working the night and
 * whatever has already been scored. The packet adds nothing she could not
 * have printed; it only lets the laptop keep doing the arithmetic.
 */

import type { Tx } from './client.ts';
import { loadPayoutContext } from './repositories.ts';

export interface PacketEvent {
  id: string;
  event_type: string;
  label: string | null;
  scoring_mode: 'judged' | 'timed';
  is_roughstock: boolean;
  num_go_rounds: number;
  is_d_format: boolean;
  d_format_config: unknown | null;
  scoring_config_id: string | null;
  scoring_config: unknown | null;
  payout_config_id: string | null;
  payout_config: unknown | null;
  /** The payout inputs that do not come from tonight's runs. */
  payout: {
    added_money_cents: number;
    entry_fee_cents: number;
    entries: { contestant_id: string; status: string; entry_fee_cents?: number }[];
  } | null;
  results_official: boolean;
  /** Whether this event's winners have already been paid. */
  disbursed: boolean;
}

export async function loadPacketEvents(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<PacketEvent[]> {
  const rows = await tx<Omit<PacketEvent, 'payout'>[]>`
    select e.id, e.event_type, o.label, e.scoring_mode, e.is_roughstock,
           e.num_go_rounds, e.is_d_format, e.d_format_config,
           e.scoring_config_id, sc.config as scoring_config,
           e.payout_config_id, pc.config as payout_config,
           exists (select 1 from results r
                    where r.rodeo_event_id = e.id and r.is_official) as results_official,
           exists (select 1 from financial_transactions ft
                    where ft.org_id = e.org_id
                      and ft.idempotency_key like 'disburse-' || e.id || ':%') as disbursed
      from rodeo_events e
      left join scoring_configs sc on sc.id = e.scoring_config_id
      left join payout_configs pc on pc.id = e.payout_config_id
      left join reference_options o
             on o.domain = 'event_type' and o.code = e.event_type
            and (o.org_id = ${orgId} or o.org_id is null)
     where e.org_id = ${orgId} and e.rodeo_id = ${rodeoId} and e.status = 'active'
     order by e.sort_order
  `;

  const out: PacketEvent[] = [];
  for (const row of rows) {
    const ctx = row.payout_config_id ? await loadPayoutContext(tx, orgId, row.id) : null;
    out.push({
      ...row,
      payout: ctx
        ? {
            added_money_cents: ctx.added_money_cents,
            entry_fee_cents: ctx.entry_fee_cents,
            entries: ctx.entries,
          }
        : null,
    });
  }
  return out;
}

export interface PacketEntry {
  entry_id: string;
  rodeo_event_id: string;
  contestant_id: string;
  contestant_name: string;
  partner_id: string | null;
  partner_name: string | null;
  back_number: string | null;
  go_round: number;
  performance_number: number | null;
  draw_position: number | null;
  status: string;
  entry_fee_amount: string | null;
  fees_paid: boolean;
  release_type: string | null;
  turnout_notified_at: string | null;
}

/** Who is entered, where they are drawn, and who has paid. */
export async function loadPacketEntries(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<PacketEntry[]> {
  return tx<PacketEntry[]>`
    select en.id as entry_id, en.rodeo_event_id, en.contestant_id,
           trim(u.first_name || ' ' || u.last_name) as contestant_name,
           en.partner_id,
           case when p.id is null then null
                else trim(p.first_name || ' ' || p.last_name) end as partner_name,
           b.back_number,
           en.go_round_number as go_round,
           en.performance_number, en.draw_position, en.status,
           en.entry_fee_amount::text as entry_fee_amount, en.fees_paid,
           en.release_type,
           to_char(en.turnout_notified_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as turnout_notified_at
      from entries en
      join users u on u.id = en.contestant_id
      left join users p on p.id = en.partner_id
      left join back_numbers b
             on b.rodeo_id = en.rodeo_id and b.contestant_id = en.contestant_id
     where en.org_id = ${orgId} and en.rodeo_id = ${rodeoId}
     order by en.rodeo_event_id, en.go_round_number, en.performance_number nulls last,
              en.draw_position nulls last
  `;
}

export interface PacketScore {
  id: string;
  entry_id: string;
  rodeo_event_id: string;
  go_round: number;
  status: string;
  source: string;
  version: number;
  raw_time: number | null;
  time_penalties: unknown;
  final_time: number | null;
  judge_scores: unknown;
  final_score: number | null;
  cross_check: unknown;
}

/** Live scores already on the server, with the version an edit is made against. */
export async function loadPacketScores(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<PacketScore[]> {
  const rows = await tx<
    (Omit<PacketScore, 'raw_time' | 'final_time' | 'final_score'> & {
      raw_time: string | null;
      final_time: string | null;
      final_score: string | null;
    })[]
  >`
    select id, entry_id, rodeo_event_id, go_round, status, source,
           jsonb_array_length(edit_history) as version,
           raw_time, time_penalties, final_time, judge_scores, final_score,
           cross_check
      from scores
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
       and status in ('provisional', 'official', 'no_time', 'dq')
  `;
  const num = (v: string | null) => (v === null ? null : Number(v));
  return rows.map((r) => ({
    ...r,
    raw_time: num(r.raw_time),
    final_time: num(r.final_time),
    final_score: num(r.final_score),
  }));
}

/** The judges working this rodeo, whose cards she will be handed. */
export async function loadPacketJudges(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<{ user_id: string; name: string; role: string }[]> {
  return tx`
    select rp.user_id, rp.role,
           trim(u.first_name || ' ' || u.last_name) as name
      from rodeo_personnel rp
      join users u on u.id = rp.user_id
     where rp.org_id = ${orgId} and rp.rodeo_id = ${rodeoId}
       and rp.role in ('judge', 'flag_judge', 'barrier_judge')
     order by rp.created_at, rp.id
  `;
}

/** The release reasons the database accepts on a turnout. */
export async function loadReleaseReasons(
  tx: Tx,
  orgId: string,
): Promise<{ code: string; label: string; counts_as_turnout: boolean }[]> {
  return tx`
    select code, label,
           coalesce((metadata ->> 'counts_as_turnout')::boolean, true) as counts_as_turnout
      from reference_options
     where domain = 'release_reason' and is_active
       and (org_id = ${orgId} or org_id is null)
     order by sort_order, code
  `;
}

/** Each performance and the instant it starts — what a turnout's notice is measured to. */
export async function loadPacketPerformances(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<
  { performance_number: number; name: string | null; performance_type: string; performance_at: string | null }[]
> {
  return tx`
    select performance_number, name, performance_type,
           to_char(scheduled_start at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as performance_at
      from performances
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by performance_number
  `;
}
