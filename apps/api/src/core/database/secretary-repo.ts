/**
 * The secretary's desk — the working sheets from migration 0030.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS
 * ---------------------------------------------------------------------------
 * One repository for the Secretary Module (Phase 1): the turnout / draw-out log
 * (Form F), position trades (Form E), rule infractions and field fines
 * (Form G), the two-timer sheet (Form D), contract-personnel sign-in (Form I),
 * the close-out remittance (Form M), the association packet, and the live
 * performance state that keeps the arena screen and the office screen in step.
 *
 * Same house rules as every other repository here:
 *   * RLS does the tenant isolation. Every function runs inside asUser(), so a
 *     query that is wrong returns too few rows, never somebody else's.
 *   * Every value is bound through a postgres.js tagged template. There is no
 *     string concatenation into SQL anywhere in this file.
 *   * The RULES live in @rodeo-os/engine (pure, tested). This file records what
 *     the engine decided; it does not re-decide it. The one exception is the
 *     posted-infraction immutability, which is enforced by a database trigger
 *     because it is a promise the database has to keep even if a second caller
 *     forgets to ask the engine.
 */

import type { Json, Tx } from './client.ts';

// ===========================================================================
// Form F — Turnout / draw-out log
// ===========================================================================

export interface TurnoutRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  rodeo_event_id: string | null;
  entry_id: string | null;
  contestant_id: string | null;
  member_number: string | null;
  performance_number: number | null;
  log_type: string;
  notified_how: string | null;
  notified_at: string | null;
  is_team_roping: boolean;
  partner_notified: boolean;
  fee_owed_cents: number;
  fine_cents: number;
  fineable: boolean;
  animal_note: string | null;
  notes: string | null;
  created_at: string;
}

export interface NewTurnout {
  rodeo_event_id?: string | null;
  entry_id?: string | null;
  contestant_id?: string | null;
  member_number?: string | null;
  performance_number?: number | null;
  log_type: string;
  notified_how?: string | null;
  notified_at?: string | null;
  is_team_roping?: boolean;
  partner_notified?: boolean;
  /** Computed by the engine before the row is written. */
  fee_owed_cents: number;
  fine_cents: number;
  fineable: boolean;
  animal_note?: string | null;
  notes?: string | null;
  created_by?: string | null;
}


export async function listTurnouts(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<TurnoutRow[]> {
  return tx<TurnoutRow[]>`
    select *
      from turnout_log
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by created_at desc
  `;
}

export async function createTurnout(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewTurnout,
): Promise<TurnoutRow> {
  const [row] = await tx<TurnoutRow[]>`
    insert into turnout_log
      (org_id, rodeo_id, rodeo_event_id, entry_id, contestant_id, member_number,
       performance_number, log_type, notified_how, notified_at, is_team_roping,
       partner_notified, fee_owed_cents, fine_cents, fineable, animal_note,
       notes, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.rodeo_event_id ?? null},
       ${input.entry_id ?? null}, ${input.contestant_id ?? null},
       ${input.member_number ?? null}, ${input.performance_number ?? null},
       ${input.log_type}, ${input.notified_how ?? null},
       ${input.notified_at ?? null}, ${input.is_team_roping ?? false},
       ${input.partner_notified ?? false}, ${input.fee_owed_cents},
       ${input.fine_cents}, ${input.fineable}, ${input.animal_note ?? null},
       ${input.notes ?? null}, ${input.created_by ?? null})
    returning *
  `;
  return row;
}

// ===========================================================================
// Form E — Position trades
// ===========================================================================

export interface TradeRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  rodeo_event_id: string;
  event_discipline: string;
  go_round_number: number;
  contestant_a_id: string;
  contestant_b_id: string | null;
  is_open: boolean;
  from_performance_number: number | null;
  from_position: number | null;
  to_performance_number: number | null;
  to_position: number | null;
  trade_number: number;
  status: string;
  confirmed_at: string | null;
  day_sheet_updated: boolean;
  posted: boolean;
  notes: string | null;
  created_at: string;
}

export interface NewTrade {
  rodeo_event_id: string;
  event_discipline?: string;
  go_round_number?: number;
  contestant_a_id: string;
  contestant_b_id?: string | null;
  is_open?: boolean;
  from_performance_number?: number | null;
  from_position?: number | null;
  to_performance_number?: number | null;
  to_position?: number | null;
  /** The 1-based trade number the engine assigned. */
  trade_number: number;
  status?: string;
  notes?: string | null;
  created_by?: string | null;
}


export async function listTrades(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<TradeRow[]> {
  return tx<TradeRow[]>`
    select *
      from trades
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by created_at desc
  `;
}

/** How many trades this contestant already has this go — for the engine. */
export async function countTradesThisGo(
  tx: Tx,
  orgId: string,
  rodeoEventId: string,
  goRound: number,
  contestantId: string,
): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from trades
     where org_id = ${orgId}
       and rodeo_event_id = ${rodeoEventId}
       and go_round_number = ${goRound}
       and contestant_a_id = ${contestantId}
       and status <> 'rejected'
  `;
  return n;
}

export async function createTrade(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewTrade,
): Promise<TradeRow> {
  const [row] = await tx<TradeRow[]>`
    insert into trades
      (org_id, rodeo_id, rodeo_event_id, event_discipline, go_round_number,
       contestant_a_id, contestant_b_id, is_open, from_performance_number,
       from_position, to_performance_number, to_position, trade_number, status,
       notes, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.rodeo_event_id},
       ${input.event_discipline ?? 'timed'}, ${input.go_round_number ?? 1},
       ${input.contestant_a_id}, ${input.contestant_b_id ?? null},
       ${input.is_open ?? false}, ${input.from_performance_number ?? null},
       ${input.from_position ?? null}, ${input.to_performance_number ?? null},
       ${input.to_position ?? null}, ${input.trade_number},
       ${input.status ?? 'proposed'}, ${input.notes ?? null},
       ${input.created_by ?? null})
    returning *
  `;
  return row;
}

// ===========================================================================
// Form G — Infractions / field fines
// ===========================================================================

export interface InfractionRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  rodeo_event_id: string | null;
  contestant_id: string | null;
  member_number: string | null;
  infraction_type: string;
  rule_code: string | null;
  fine_cents: number;
  judge_id: string | null;
  verified_by_barrier_judge: boolean;
  posted_at: string | null;
  corrects_infraction_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface NewInfraction {
  rodeo_event_id?: string | null;
  contestant_id?: string | null;
  member_number?: string | null;
  infraction_type: string;
  rule_code?: string | null;
  fine_cents?: number;
  judge_id?: string | null;
  verified_by_barrier_judge?: boolean;
  corrects_infraction_id?: string | null;
  notes?: string | null;
  created_by?: string | null;
}


export async function listInfractions(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<InfractionRow[]> {
  return tx<InfractionRow[]>`
    select *
      from infractions
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by created_at desc
  `;
}

export async function createInfraction(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewInfraction,
): Promise<InfractionRow> {
  const [row] = await tx<InfractionRow[]>`
    insert into infractions
      (org_id, rodeo_id, rodeo_event_id, contestant_id, member_number,
       infraction_type, rule_code, fine_cents, judge_id,
       verified_by_barrier_judge, corrects_infraction_id, notes, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.rodeo_event_id ?? null},
       ${input.contestant_id ?? null}, ${input.member_number ?? null},
       ${input.infraction_type}, ${input.rule_code ?? null},
       ${input.fine_cents ?? 0}, ${input.judge_id ?? null},
       ${input.verified_by_barrier_judge ?? false},
       ${input.corrects_infraction_id ?? null}, ${input.notes ?? null},
       ${input.created_by ?? null})
    returning *
  `;
  return row;
}

/**
 * Post an infraction — the moment it goes on the office sheet and freezes.
 *
 * Only a draft (posted_at is null) can be posted, and only when the barrier
 * judge has verified it if the type requires that. The database trigger from
 * 0030 makes the row immutable the instant posted_at is set; this just sets it.
 * Returns null when there was no draft to post.
 */
export async function postInfraction(
  tx: Tx,
  orgId: string,
  infractionId: string,
): Promise<InfractionRow | null> {
  const [row] = await tx<InfractionRow[]>`
    update infractions
       set posted_at = now()
     where org_id = ${orgId} and id = ${infractionId}
       and posted_at is null
    returning *
  `;
  return row ?? null;
}

/** Mark the barrier judge's sign-off on a draft infraction. */
export async function verifyInfraction(
  tx: Tx,
  orgId: string,
  infractionId: string,
): Promise<InfractionRow | null> {
  const [row] = await tx<InfractionRow[]>`
    update infractions
       set verified_by_barrier_judge = true
     where org_id = ${orgId} and id = ${infractionId}
       and posted_at is null
    returning *
  `;
  return row ?? null;
}

// ===========================================================================
// Form I — Contract personnel sign-in
// ===========================================================================

export interface PersonnelSigninRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  role: string;
  printed_name: string;
  card_or_phone: string | null;
  user_id: string | null;
  signature_method: string;
  signed_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface NewPersonnelSignin {
  role: string;
  printed_name: string;
  card_or_phone?: string | null;
  user_id?: string | null;
  signature_method?: string;
  signed_at?: string | null;
  notes?: string | null;
  created_by?: string | null;
}


export async function listPersonnelSignins(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<PersonnelSigninRow[]> {
  return tx<PersonnelSigninRow[]>`
    select *
      from personnel_signins
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by role, printed_name
  `;
}

export async function createPersonnelSignin(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewPersonnelSignin,
): Promise<PersonnelSigninRow> {
  const [row] = await tx<PersonnelSigninRow[]>`
    insert into personnel_signins
      (org_id, rodeo_id, role, printed_name, card_or_phone, user_id,
       signature_method, signed_at, notes, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.role}, ${input.printed_name},
       ${input.card_or_phone ?? null}, ${input.user_id ?? null},
       ${input.signature_method ?? 'paper'}, ${input.signed_at ?? null},
       ${input.notes ?? null}, ${input.created_by ?? null})
    returning *
  `;
  return row;
}

export async function deletePersonnelSignin(
  tx: Tx,
  orgId: string,
  signinId: string,
): Promise<boolean> {
  const rows = await tx`
    delete from personnel_signins
     where org_id = ${orgId} and id = ${signinId}
    returning id
  `;
  return rows.length > 0;
}

// ===========================================================================
// Form D — Timer readings
// ===========================================================================

export interface TimerReadingRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  rodeo_event_id: string;
  entry_id: string | null;
  performance_number: number | null;
  run_position: number | null;
  timer_number: number;
  raw_seconds: string | null;
  barrier_penalty_seconds: string;
  field_seconds: string | null;
  official_seconds: string | null;
  electric_eye: boolean;
  no_time: boolean;
  turnout: boolean;
  flag_note: string | null;
  created_at: string;
}

export interface NewTimerReading {
  rodeo_event_id: string;
  entry_id?: string | null;
  performance_number?: number | null;
  run_position?: number | null;
  timer_number: number;
  raw_seconds?: number | null;
  barrier_penalty_seconds?: number;
  field_seconds?: number | null;
  electric_eye?: boolean;
  no_time?: boolean;
  turnout?: boolean;
  flag_note?: string | null;
  recorded_by?: string | null;
}


export async function listTimerReadings(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  rodeoEventId?: string | null,
): Promise<TimerReadingRow[]> {
  return tx<TimerReadingRow[]>`
    select *
      from timer_readings
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
       ${rodeoEventId ? tx`and rodeo_event_id = ${rodeoEventId}` : tx``}
     order by performance_number, run_position, timer_number
  `;
}

/**
 * Record (or re-record) one watch for one run.
 *
 * One reading per timer per run: re-timing a watch updates the same row rather
 * than stacking a second reading nobody can tell apart. The conflict target is
 * the partial unique index from 0030.
 */
export async function upsertTimerReading(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewTimerReading,
): Promise<TimerReadingRow> {
  const [row] = await tx<TimerReadingRow[]>`
    insert into timer_readings
      (org_id, rodeo_id, rodeo_event_id, entry_id, performance_number,
       run_position, timer_number, raw_seconds, barrier_penalty_seconds,
       field_seconds, electric_eye, no_time, turnout, flag_note, recorded_by)
    values
      (${orgId}, ${rodeoId}, ${input.rodeo_event_id}, ${input.entry_id ?? null},
       ${input.performance_number ?? null}, ${input.run_position ?? null},
       ${input.timer_number}, ${input.raw_seconds ?? null},
       ${input.barrier_penalty_seconds ?? 0}, ${input.field_seconds ?? null},
       ${input.electric_eye ?? false}, ${input.no_time ?? false},
       ${input.turnout ?? false}, ${input.flag_note ?? null},
       ${input.recorded_by ?? null})
    on conflict (rodeo_event_id, performance_number, run_position, entry_id, timer_number)
      where entry_id is not null
      do update set
        raw_seconds = excluded.raw_seconds,
        barrier_penalty_seconds = excluded.barrier_penalty_seconds,
        field_seconds = excluded.field_seconds,
        electric_eye = excluded.electric_eye,
        no_time = excluded.no_time,
        turnout = excluded.turnout,
        flag_note = excluded.flag_note,
        recorded_by = excluded.recorded_by
    returning *
  `;
  return row;
}

/** Write the reconciled official time back onto every watch for a run. */
export async function writeOfficialTime(
  tx: Tx,
  orgId: string,
  rodeoEventId: string,
  performanceNumber: number | null,
  runPosition: number | null,
  entryId: string | null,
  officialSeconds: number | null,
): Promise<number> {
  const rows = await tx`
    update timer_readings
       set official_seconds = ${officialSeconds}
     where org_id = ${orgId}
       and rodeo_event_id = ${rodeoEventId}
       and performance_number is not distinct from ${performanceNumber}
       and run_position is not distinct from ${runPosition}
       and entry_id is not distinct from ${entryId}
    returning id
  `;
  return rows.length;
}

// ===========================================================================
// Form M — Remittance items
// ===========================================================================

export interface RemittanceItemRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  category: string;
  amount_cents: number;
  deposit_slip: string | null;
  note: string | null;
  created_at: string;
}


export async function listRemittance(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<RemittanceItemRow[]> {
  return tx<RemittanceItemRow[]>`
    select *
      from remittance_items
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by category
  `;
}

/** Set one money category for the rodeo. Re-entering a category updates it. */
export async function upsertRemittanceItem(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: {
    category: string;
    amount_cents: number;
    deposit_slip?: string | null;
    note?: string | null;
    created_by?: string | null;
  },
): Promise<RemittanceItemRow> {
  const [row] = await tx<RemittanceItemRow[]>`
    insert into remittance_items
      (org_id, rodeo_id, category, amount_cents, deposit_slip, note, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.category}, ${input.amount_cents},
       ${input.deposit_slip ?? null}, ${input.note ?? null},
       ${input.created_by ?? null})
    on conflict (org_id, rodeo_id, category)
      do update set
        amount_cents = excluded.amount_cents,
        deposit_slip = excluded.deposit_slip,
        note = excluded.note
    returning *
  `;
  return row;
}

// ===========================================================================
// Association packet / upload
// ===========================================================================

export interface AssociationUploadRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  association_code: string;
  method: string;
  packet_items: Record<string, unknown>;
  deadline_at: string | null;
  submitted_at: string | null;
  submission_reference: string | null;
  status: string;
  notes: string | null;
  created_at: string;
}


export async function getAssociationUpload(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<AssociationUploadRow | null> {
  const [row] = await tx<AssociationUploadRow[]>`
    select *
      from association_uploads
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by created_at desc
     limit 1
  `;
  return row ?? null;
}

export async function createAssociationUpload(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: {
    association_code: string;
    method?: string;
    packet_items?: Record<string, unknown>;
    deadline_at?: string | null;
    notes?: string | null;
    created_by?: string | null;
  },
): Promise<AssociationUploadRow> {
  const [row] = await tx<AssociationUploadRow[]>`
    insert into association_uploads
      (org_id, rodeo_id, association_code, method, packet_items, deadline_at,
       notes, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.association_code},
       ${input.method ?? 'upload'}, ${tx.json((input.packet_items ?? {}) as unknown as Json)},
       ${input.deadline_at ?? null}, ${input.notes ?? null},
       ${input.created_by ?? null})
    returning *
  `;
  return row;
}

export async function updateAssociationUpload(
  tx: Tx,
  orgId: string,
  uploadId: string,
  input: {
    packet_items?: Record<string, unknown>;
    status?: string;
    submitted_at?: string | null;
    submission_reference?: string | null;
    deadline_at?: string | null;
    notes?: string | null;
  },
): Promise<AssociationUploadRow | null> {
  const [row] = await tx<AssociationUploadRow[]>`
    update association_uploads
       set packet_items = coalesce(${
         input.packet_items != null ? tx.json(input.packet_items as unknown as Json) : null
       }, packet_items),
           status = coalesce(${input.status ?? null}, status),
           submitted_at = coalesce(${input.submitted_at ?? null}::timestamptz, submitted_at),
           submission_reference = coalesce(${
             input.submission_reference ?? null
           }, submission_reference),
           deadline_at = coalesce(${input.deadline_at ?? null}::timestamptz, deadline_at),
           notes = coalesce(${input.notes ?? null}, notes)
     where org_id = ${orgId} and id = ${uploadId}
    returning *
  `;
  return row ?? null;
}

// ===========================================================================
// Live performance state
// ===========================================================================

export interface PerformanceStateRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  performance_number: number;
  state: string;
  current_event_id: string | null;
  current_run_position: number | null;
  started_at: string | null;
  ended_at: string | null;
  updated_at: string;
}


export async function listPerformanceStates(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<PerformanceStateRow[]> {
  return tx<PerformanceStateRow[]>`
    select *
      from live_performance_state
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by performance_number
  `;
}

/**
 * Set the live state of a performance.
 *
 * One row per (rodeo, performance_number): moving a performance forward updates
 * the same row so the arena screen and the office screen never disagree about
 * what is up. started_at is stamped the first time it goes in_progress;
 * ended_at when it closes.
 */
export async function upsertPerformanceState(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  performanceNumber: number,
  input: {
    state: string;
    current_event_id?: string | null;
    current_run_position?: number | null;
    updated_by?: string | null;
  },
): Promise<PerformanceStateRow> {
  const [row] = await tx<PerformanceStateRow[]>`
    insert into live_performance_state
      (org_id, rodeo_id, performance_number, state, current_event_id,
       current_run_position, started_at, ended_at, updated_by)
    values
      (${orgId}, ${rodeoId}, ${performanceNumber}, ${input.state},
       ${input.current_event_id ?? null}, ${input.current_run_position ?? null},
       ${input.state === 'in_progress' ? tx`now()` : null},
       ${input.state === 'closed' ? tx`now()` : null},
       ${input.updated_by ?? null})
    on conflict (org_id, rodeo_id, performance_number)
      do update set
        state = excluded.state,
        current_event_id = excluded.current_event_id,
        current_run_position = excluded.current_run_position,
        started_at = coalesce(
          live_performance_state.started_at,
          case when excluded.state = 'in_progress' then now() end
        ),
        ended_at = case when excluded.state = 'closed' then now()
                        else live_performance_state.ended_at end,
        updated_by = excluded.updated_by
    returning *
  `;
  return row;
}


// ===========================================================================
// Form H — Check-in / fee receipt (migration 0031)
// ===========================================================================

export interface CheckInRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  entry_id: string | null;
  contestant_id: string | null;
  contestant_name: string;
  member_number: string | null;
  checked_in_at: string;
  fees_due_cents: number;
  fees_paid_cents: number;
  payment_method: string;
  receipt_number: string | null;
  check_number: string | null;
  taken_by: string | null;
  notes: string | null;
  created_at: string;
}

export interface NewCheckIn {
  entry_id?: string | null;
  contestant_id?: string | null;
  contestant_name: string;
  member_number?: string | null;
  fees_due_cents?: number;
  fees_paid_cents?: number;
  payment_method?: string;
  receipt_number?: string | null;
  check_number?: string | null;
  taken_by?: string | null;
  notes?: string | null;
}

export async function listCheckIns(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<CheckInRow[]> {
  return tx<CheckInRow[]>`
    select *
      from check_ins
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by checked_in_at desc
  `;
}

export async function createCheckIn(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: NewCheckIn,
): Promise<CheckInRow> {
  const [row] = await tx<CheckInRow[]>`
    insert into check_ins
      (org_id, rodeo_id, entry_id, contestant_id, contestant_name, member_number,
       fees_due_cents, fees_paid_cents, payment_method, receipt_number,
       check_number, taken_by, notes)
    values
      (${orgId}, ${rodeoId}, ${input.entry_id ?? null},
       ${input.contestant_id ?? null}, ${input.contestant_name},
       ${input.member_number ?? null}, ${input.fees_due_cents ?? 0},
       ${input.fees_paid_cents ?? 0}, ${input.payment_method ?? 'cash'},
       ${input.receipt_number ?? null}, ${input.check_number ?? null},
       ${input.taken_by ?? null}, ${input.notes ?? null})
    returning *
  `;
  return row;
}

// ===========================================================================
// Form K — Arena measurement / judges' check (table from migration 0030)
// ===========================================================================

export interface ArenaMeasurementRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  box_length_l: string | null;
  box_length_r: string | null;
  scoreline_length: string | null;
  barrier_height: string | null;
  electric_eye: boolean;
  even_cattle_marked: boolean;
  cloverleaf_measured: boolean;
  pattern: string | null;
  flagger_position: string | null;
  backup_watches: boolean;
  num_bareback: number | null;
  num_saddle_bronc: number | null;
  num_bull: number | null;
  timed_cattle_count: number | null;
  fresh_used_note: string | null;
  humane_issues: string | null;
  judge1_id: string | null;
  judge2_id: string | null;
  measured_at: string | null;
  posted_with_draw: boolean;
  notes: string | null;
  created_by: string | null;
  created_at: string;
}

export interface ArenaMeasurementInput {
  box_length_l?: string | null;
  box_length_r?: string | null;
  scoreline_length?: string | null;
  barrier_height?: string | null;
  electric_eye?: boolean;
  even_cattle_marked?: boolean;
  cloverleaf_measured?: boolean;
  pattern?: string | null;
  flagger_position?: string | null;
  backup_watches?: boolean;
  num_bareback?: number | null;
  num_saddle_bronc?: number | null;
  num_bull?: number | null;
  timed_cattle_count?: number | null;
  fresh_used_note?: string | null;
  humane_issues?: string | null;
  measured_at?: string | null;
  posted_with_draw?: boolean;
  notes?: string | null;
  created_by?: string | null;
}

/**
 * The arena check is one sheet per rodeo (it covers every event's setup on the
 * one morning), so the row is fetched — and written — as a singleton.
 */
export async function getArenaMeasurement(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<ArenaMeasurementRow | null> {
  const [row] = await tx<ArenaMeasurementRow[]>`
    select *
      from arena_measurements
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     order by created_at desc
     limit 1
  `;
  return row ?? null;
}

export async function upsertArenaMeasurement(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: ArenaMeasurementInput,
): Promise<ArenaMeasurementRow> {
  const existing = await getArenaMeasurement(tx, orgId, rodeoId);
  if (existing) {
    const [row] = await tx<ArenaMeasurementRow[]>`
      update arena_measurements set
        box_length_l = ${input.box_length_l ?? existing.box_length_l},
        box_length_r = ${input.box_length_r ?? existing.box_length_r},
        scoreline_length = ${input.scoreline_length ?? existing.scoreline_length},
        barrier_height = ${input.barrier_height ?? existing.barrier_height},
        electric_eye = ${input.electric_eye ?? existing.electric_eye},
        even_cattle_marked = ${input.even_cattle_marked ?? existing.even_cattle_marked},
        cloverleaf_measured = ${input.cloverleaf_measured ?? existing.cloverleaf_measured},
        pattern = ${input.pattern ?? existing.pattern},
        flagger_position = ${input.flagger_position ?? existing.flagger_position},
        backup_watches = ${input.backup_watches ?? existing.backup_watches},
        num_bareback = ${input.num_bareback ?? existing.num_bareback},
        num_saddle_bronc = ${input.num_saddle_bronc ?? existing.num_saddle_bronc},
        num_bull = ${input.num_bull ?? existing.num_bull},
        timed_cattle_count = ${input.timed_cattle_count ?? existing.timed_cattle_count},
        fresh_used_note = ${input.fresh_used_note ?? existing.fresh_used_note},
        humane_issues = ${input.humane_issues ?? existing.humane_issues},
        measured_at = ${input.measured_at ?? existing.measured_at},
        posted_with_draw = ${input.posted_with_draw ?? existing.posted_with_draw},
        notes = ${input.notes ?? existing.notes}
      where org_id = ${orgId} and id = ${existing.id}
      returning *
    `;
    return row;
  }
  const [row] = await tx<ArenaMeasurementRow[]>`
    insert into arena_measurements
      (org_id, rodeo_id, box_length_l, box_length_r, scoreline_length,
       barrier_height, electric_eye, even_cattle_marked, cloverleaf_measured,
       pattern, flagger_position, backup_watches, num_bareback, num_saddle_bronc,
       num_bull, timed_cattle_count, fresh_used_note, humane_issues, measured_at,
       posted_with_draw, notes, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.box_length_l ?? null},
       ${input.box_length_r ?? null}, ${input.scoreline_length ?? null},
       ${input.barrier_height ?? null}, ${input.electric_eye ?? false},
       ${input.even_cattle_marked ?? false}, ${input.cloverleaf_measured ?? false},
       ${input.pattern ?? null}, ${input.flagger_position ?? null},
       ${input.backup_watches ?? false}, ${input.num_bareback ?? null},
       ${input.num_saddle_bronc ?? null}, ${input.num_bull ?? null},
       ${input.timed_cattle_count ?? null}, ${input.fresh_used_note ?? null},
       ${input.humane_issues ?? null}, ${input.measured_at ?? null},
       ${input.posted_with_draw ?? false}, ${input.notes ?? null},
       ${input.created_by ?? null})
    returning *
  `;
  return row;
}

// ===========================================================================
// Form L — Ground rules (table from migration 0030, one row per rodeo)
// ===========================================================================

export interface GroundRulesRow {
  id: string;
  org_id: string;
  rodeo_id: string;
  city_state: string | null;
  sanction: string | null;
  added_money_by_event: string | null;
  performances_note: string | null;
  slack_note: string | null;
  walkup_replacement: boolean;
  local_events: string | null;
  special_rules: string | null;
  committee_contact: string | null;
  posted_by: string | null;
  posted_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface GroundRulesInput {
  city_state?: string | null;
  sanction?: string | null;
  added_money_by_event?: string | null;
  performances_note?: string | null;
  slack_note?: string | null;
  walkup_replacement?: boolean;
  local_events?: string | null;
  special_rules?: string | null;
  committee_contact?: string | null;
  post?: boolean;
  posted_by?: string | null;
  created_by?: string | null;
}

export async function getGroundRules(
  tx: Tx,
  orgId: string,
  rodeoId: string,
): Promise<GroundRulesRow | null> {
  const [row] = await tx<GroundRulesRow[]>`
    select *
      from ground_rules
     where org_id = ${orgId} and rodeo_id = ${rodeoId}
     limit 1
  `;
  return row ?? null;
}

export async function upsertGroundRules(
  tx: Tx,
  orgId: string,
  rodeoId: string,
  input: GroundRulesInput,
): Promise<GroundRulesRow> {
  const existing = await getGroundRules(tx, orgId, rodeoId);
  const postedAt = input.post ? new Date().toISOString() : null;
  if (existing) {
    const [row] = await tx<GroundRulesRow[]>`
      update ground_rules set
        city_state = ${input.city_state ?? existing.city_state},
        sanction = ${input.sanction ?? existing.sanction},
        added_money_by_event = ${input.added_money_by_event ?? existing.added_money_by_event},
        performances_note = ${input.performances_note ?? existing.performances_note},
        slack_note = ${input.slack_note ?? existing.slack_note},
        walkup_replacement = ${input.walkup_replacement ?? existing.walkup_replacement},
        local_events = ${input.local_events ?? existing.local_events},
        special_rules = ${input.special_rules ?? existing.special_rules},
        committee_contact = ${input.committee_contact ?? existing.committee_contact},
        posted_at = ${input.post ? postedAt : existing.posted_at},
        posted_by = ${input.post ? (input.posted_by ?? null) : existing.posted_by},
        updated_at = now()
      where org_id = ${orgId} and id = ${existing.id}
      returning *
    `;
    return row;
  }
  const [row] = await tx<GroundRulesRow[]>`
    insert into ground_rules
      (org_id, rodeo_id, city_state, sanction, added_money_by_event,
       performances_note, slack_note, walkup_replacement, local_events,
       special_rules, committee_contact, posted_at, posted_by, created_by)
    values
      (${orgId}, ${rodeoId}, ${input.city_state ?? null}, ${input.sanction ?? null},
       ${input.added_money_by_event ?? null}, ${input.performances_note ?? null},
       ${input.slack_note ?? null}, ${input.walkup_replacement ?? false},
       ${input.local_events ?? null}, ${input.special_rules ?? null},
       ${input.committee_contact ?? null}, ${postedAt},
       ${input.post ? (input.posted_by ?? null) : null}, ${input.created_by ?? null})
    returning *
  `;
  return row;
}
