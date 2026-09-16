-- ============================================================================
-- 0030_secretary_module.sql
-- Secretary Module, Phase 1: the paper the office actually runs on.
--
-- Architecture ref: §2.2.5, §2.2.6, §2.2.8.
--
-- These are the working sheets a rodeo secretary keeps by hand today and then
-- re-types into three different places at midnight: the turnout / draw-out log
-- (Form F), position trades (Form E), the field-fine / infraction sheet
-- (Form G), the two-timer sheet (Form D), contract-personnel sign-in
-- (Form I, PRCA R4.13.4), the arena measurement / judges' check (Form K),
-- ground-rules posting (Form L), and the close-out / remittance cover
-- (Form M) — plus the live state of a performance so the arena screen and the
-- office screen agree on which run is up.
--
-- Every table follows the house rules: `unique (org_id, id)` so it can be a
-- composite-FK target, tenant-scoped composite FKs to rodeos / entries /
-- events, an index on `(org_id, rodeo_id)`, and RLS derived from the caller's
-- verified identity (0008_rls.sql) rather than an asserted org id.
--
-- Money is INTEGER CENTS, matching the payout engine and the ledger.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Form F — Turnout / Doctor-release / Visible-injury / Draw-out log
--
-- Pulled no earlier than three hours before a performance. Records who called,
-- how, and when, because a turnout inside the notice window is fineable and a
-- documented medical release is not, and the difference is money.
-- ----------------------------------------------------------------------------
create table turnout_log (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid,
    entry_id        uuid,
    contestant_id   uuid references users (id),

    member_number   text,
    performance_number int,

    log_type        text not null check (log_type in (
                        'TO',   -- turnout
                        'NTO',  -- notified turnout (in time)
                        'PTO',  -- partial / permit turnout
                        'DR',   -- doctor release
                        'VI',   -- visible injury
                        'DO'    -- draw-out
                    )),

    -- How the notice reached the office, and when. Free text on purpose: it is
    -- "Procom 5:02 p.m." or "called the cell", and pretending it is an enum
    -- loses the one detail that settles a dispute.
    notified_how    text,
    notified_at     timestamptz,

    -- The team-roping rule on Form F: the remaining partner must notify the
    -- secretary before the cattle draw or the team still owes fees.
    is_team_roping  boolean not null default false,
    partner_notified boolean not null default false,

    fee_owed_cents  integer not null default 0 check (fee_owed_cents >= 0),
    fine_cents      integer not null default 0 check (fine_cents >= 0),
    fineable        boolean not null default false,

    animal_note     text,
    notes           text,

    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    foreign key (org_id, entry_id) references entries (org_id, id) on delete set null
);

create index idx_turnout_log_rodeo on turnout_log (org_id, rodeo_id);
create index idx_turnout_log_type on turnout_log (org_id, rodeo_id, log_type);

-- ----------------------------------------------------------------------------
-- Form E — Position trade
--
-- Allowed only where the book permits it (performance-preference; second and
-- later go-rounds). Cannot trade inside the same perf or same slack. Riding
-- events are due before the stock draw; timed events by the last time of the
-- first head. Limit is two trades per go-round at PRCA / WPRA. The engine
-- enforces all of that; the table records the paperwork.
-- ----------------------------------------------------------------------------
create table trades (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid not null,

    -- 'riding' events trade before the stock draw; 'timed' before the first
    -- head time. Kept on the row so the office copy stands on its own.
    event_discipline text not null default 'timed' check (event_discipline in (
                        'riding', 'timed'
                    )),
    go_round_number int not null default 1 check (go_round_number >= 1),

    -- Contestant A gives the position. Contestant B receives it, unless the
    -- position is OPEN from a TO/DR/VI/DO, in which case is_open is true and
    -- contestant_b_id is null.
    contestant_a_id uuid not null references users (id),
    contestant_b_id uuid references users (id),
    is_open         boolean not null default false,

    from_performance_number int,
    from_position   int,
    to_performance_number   int,
    to_position     int,

    -- Which of the two allowed trades this is, this go-round.
    trade_number    int not null default 1 check (trade_number >= 1),

    status          text not null default 'proposed' check (status in (
                        'proposed', 'confirmed', 'rejected'
                    )),
    confirmed_at    timestamptz,

    day_sheet_updated boolean not null default false,
    posted          boolean not null default false,

    notes           text,
    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    constraint trade_open_has_no_partner
        check (not is_open or contestant_b_id is null)
);

create index idx_trades_rodeo on trades (org_id, rodeo_id);
create index idx_trades_event_go on trades (org_id, rodeo_event_id, go_round_number);

-- ----------------------------------------------------------------------------
-- Form G — Rule infraction / field fine
--
-- Posted in the office except on the last performance. Barrier and field fines
-- are verified with the barrier judge after each section. A contestant may not
-- talk a posted mark off the sheet — so once posted_at is set, the row is
-- immutable (trigger below). A correction is a new row referencing this one.
-- ----------------------------------------------------------------------------
create table infractions (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete restrict,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid,

    contestant_id   uuid references users (id),
    member_number   text,

    infraction_type text not null default 'field' check (infraction_type in (
                        'barrier', 'field', 'conduct', 'stock', 'other'
                    )),
    rule_code       text,
    fine_cents      integer not null default 0 check (fine_cents >= 0),

    judge_id        uuid references users (id),
    -- Set by the barrier judge sign-off. Until it is set the row is a draft the
    -- secretary can still fix.
    verified_by_barrier_judge boolean not null default false,

    -- The moment it goes on the posted sheet. After this the row is immutable.
    posted_at       timestamptz,
    corrects_infraction_id uuid,

    notes           text,
    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id),
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id),
    foreign key (org_id, corrects_infraction_id) references infractions (org_id, id)
);

create index idx_infractions_rodeo on infractions (org_id, rodeo_id);
create index idx_infractions_event on infractions (org_id, rodeo_event_id);

-- ----------------------------------------------------------------------------
-- Form I — Contract personnel sign-in  (PRCA R4.13.4)
--
-- Names of the announcer, secretary, timers, specialty acts, bullfighters,
-- barrelman, pickup men, flank man, arena director. No card numbers required
-- on that list. A missing sign-in has carried a $25 fine.
-- ----------------------------------------------------------------------------
create table personnel_signins (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,

    role            text not null,
    printed_name    text not null,
    card_or_phone   text,

    -- Linked to a user when we know who it is; the paper form only needs the
    -- printed name and a signature.
    user_id         uuid references users (id),

    signature_method text not null default 'paper' check (signature_method in (
                        'paper', 'typed', 'imported'
                    )),
    signed_at       timestamptz,

    notes           text,
    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_personnel_signins_rodeo on personnel_signins (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Form K — Judges' check / arena measurement
--
-- Measured before the first competition stock and posted with the draw. Stored
-- as text where the paper form is text ("L ___ R ___"): the value on the wall
-- is what has to be reproducible, units and all.
-- ----------------------------------------------------------------------------
create table arena_measurements (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,

    box_length_l    text,
    box_length_r    text,
    scoreline_length text,
    barrier_height  text,
    electric_eye    boolean not null default false,
    even_cattle_marked boolean not null default false,

    cloverleaf_measured boolean not null default false,
    pattern         text,
    flagger_position text,
    backup_watches  boolean not null default false,

    num_bareback    int check (num_bareback >= 0),
    num_saddle_bronc int check (num_saddle_bronc >= 0),
    num_bull        int check (num_bull >= 0),
    timed_cattle_count int check (timed_cattle_count >= 0),
    fresh_used_note text,
    humane_issues   text,

    judge1_id       uuid references users (id),
    judge2_id       uuid references users (id),
    measured_at     timestamptz,
    posted_with_draw boolean not null default false,

    notes           text,
    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_arena_measurements_rodeo on arena_measurements (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Form D — Timed-event timer sheet  (two timers)
--
-- Every run gets one row per timer (timer_number 1 and 2). The reconcile
-- engine compares the two watches, applies a barrier penalty, and produces the
-- official time; the barrier judge verifies fines after the section.
-- ----------------------------------------------------------------------------
create table timer_readings (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid not null,
    entry_id        uuid,

    performance_number int,
    run_position    int,
    -- Two timers per run.
    timer_number    int not null check (timer_number in (1, 2)),

    -- Seconds, to the thousandth. numeric(7,3) reaches 9999.999s and never
    -- carries a floating-point error into an official time.
    raw_seconds     numeric(7, 3) check (raw_seconds >= 0),
    barrier_penalty_seconds numeric(7, 3) not null default 0
                        check (barrier_penalty_seconds >= 0),
    field_seconds   numeric(7, 3) check (field_seconds >= 0),
    -- Written back by the reconcile engine.
    official_seconds numeric(7, 3) check (official_seconds >= 0),

    electric_eye    boolean not null default false,
    no_time         boolean not null default false,
    turnout         boolean not null default false,
    flag_note       text,

    recorded_by     uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    foreign key (org_id, entry_id) references entries (org_id, id) on delete set null
);

create index idx_timer_readings_rodeo on timer_readings (org_id, rodeo_id);
create index idx_timer_readings_run
    on timer_readings (org_id, rodeo_event_id, performance_number, run_position);

-- One reading per timer per run. Re-recording a watch updates the same row.
create unique index idx_timer_readings_unique
    on timer_readings (rodeo_event_id, performance_number, run_position, entry_id, timer_number)
    where entry_id is not null;

-- ----------------------------------------------------------------------------
-- Close-out — Association upload / packet
--
-- The results leave the office as an upload (PRCA) or a mailed packet (IPRA,
-- PSRA). This tracks the checklist, the deadline the engine computed, and
-- whether it actually went.
-- ----------------------------------------------------------------------------
create table association_uploads (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,

    association_code text not null,
    method          text not null default 'upload' check (method in (
                        'upload', 'mail'
                    )),

    -- The Form M checklist, item -> included boolean, plus any note.
    packet_items    jsonb not null default '{}'::jsonb,

    deadline_at     timestamptz,
    submitted_at    timestamptz,
    submission_reference text,

    status          text not null default 'pending' check (status in (
                        'pending', 'ready', 'submitted', 'accepted', 'rejected'
                    )),

    notes           text,
    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_association_uploads_rodeo on association_uploads (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Form M — Close-out / remittance money
--
-- One row per money category on the remittance cover. The remittance engine
-- reconciles these against the ledger so what left the office matches what the
-- books say. Money is official, so org deletion is restricted.
-- ----------------------------------------------------------------------------
create table remittance_items (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete restrict,
    rodeo_id        uuid not null,

    category        text not null check (category in (
                        'fees_collected',
                        'assn_cut_sent',
                        'prize_paid',
                        'unclaimed_sent',
                        'fines_collected',
                        'stalls_camp_gate',
                        'deposit'
                    )),
    amount_cents    integer not null default 0 check (amount_cents >= 0),

    deposit_slip    text,
    note            text,
    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    -- One figure per category per rodeo; re-entering a category updates it.
    unique (org_id, rodeo_id, category),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id)
);

create index idx_remittance_items_rodeo on remittance_items (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Form L — Ground-rules posting
--
-- Stays on the office wall all weekend; a copy travels with some results
-- packets. One posting per rodeo.
-- ----------------------------------------------------------------------------
create table ground_rules (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,

    city_state      text,
    sanction        text,
    added_money_by_event text,
    performances_note text,
    slack_note      text,
    walkup_replacement boolean not null default false,
    local_events    text,
    special_rules   text,

    committee_contact text,
    posted_by       uuid references users (id),
    posted_at       timestamptz,

    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (org_id, id),
    unique (org_id, rodeo_id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_ground_rules_rodeo on ground_rules (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- Live performance state
--
-- The one row that lets the arena screen and the office screen agree on what
-- is happening right now: which performance, which event, which run is up, and
-- whether the section has been reconciled and closed.
-- ----------------------------------------------------------------------------
create table live_performance_state (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    performance_number int not null,

    state           text not null default 'not_started' check (state in (
                        'not_started',
                        'in_progress',
                        'section_complete',
                        'reconciled',
                        'closed'
                    )),

    current_event_id uuid,
    current_run_position int,

    started_at      timestamptz,
    ended_at        timestamptz,

    updated_by      uuid references users (id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    unique (org_id, id),
    unique (org_id, rodeo_id, performance_number),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, current_event_id) references rodeo_events (org_id, id) on delete set null
);

create index idx_live_perf_state_rodeo on live_performance_state (org_id, rodeo_id);

-- ============================================================================
-- Immutability: a posted infraction cannot be talked off the sheet
-- ============================================================================
-- Form G is explicit: "Contestant may not talk a posted mark off the sheet."
-- Once posted_at is set, the row is frozen. A change is a correcting row that
-- references it through corrects_infraction_id, exactly as the ledger records a
-- correction as a new entry rather than an edit.
create or replace function reject_posted_infraction_change()
returns trigger
language plpgsql
as $$
begin
    if tg_op = 'DELETE' then
        if old.posted_at is not null then
            raise exception
                'Infraction % is posted and cannot be deleted. Record a correcting infraction instead.',
                old.id
                using errcode = 'restrict_violation';
        end if;
        return old;
    end if;

    -- UPDATE
    if old.posted_at is not null then
        raise exception
            'Infraction % is posted and is immutable. Record a correcting infraction instead.',
            old.id
            using errcode = 'restrict_violation';
    end if;
    return new;
end;
$$;

create trigger infractions_no_change_once_posted
    before update or delete on infractions
    for each row execute function reject_posted_infraction_change();

-- updated_at maintenance for the two tables that legitimately change in place.
create trigger ground_rules_touch
    before update on ground_rules
    for each row execute function touch_updated_at();

create trigger live_performance_state_touch
    before update on live_performance_state
    for each row execute function touch_updated_at();

-- ============================================================================
-- Row-level security
-- ============================================================================
-- Same model as 0008_rls.sql: isolation is derived from the caller's verified
-- identity, not an asserted org id. Read for any org member; write for staff
-- (owner / admin / secretary). Timer readings additionally allow the scoring
-- roles to write, since a timer operator records them.
do $$
declare t text;
begin
    foreach t in array array[
        'turnout_log', 'trades', 'infractions', 'personnel_signins',
        'arena_measurements', 'timer_readings', 'association_uploads',
        'remittance_items', 'ground_rules', 'live_performance_state'
    ]
    loop
        execute format('alter table %I enable row level security', t);
        execute format('alter table %I force row level security', t);
    end loop;
end $$;

do $$
declare t text;
begin
    foreach t in array array[
        'turnout_log', 'trades', 'infractions', 'personnel_signins',
        'arena_measurements', 'association_uploads',
        'remittance_items', 'ground_rules', 'live_performance_state'
    ]
    loop
        execute format($f$
            create policy %1$I_member_read on %1$I
                for select using (app_is_org_member(org_id));
            create policy %1$I_staff_write on %1$I
                for all
                using (app_is_org_staff(org_id))
                with check (app_is_org_staff(org_id));
        $f$, t);
    end loop;
end $$;

-- Timer readings: read for any member, written by anyone who may record a
-- score (secretary, judge, timer operator).
create policy timer_readings_member_read on timer_readings
    for select using (app_is_org_member(org_id));

create policy timer_readings_score_write on timer_readings
    for all
    using (app_can_score(org_id))
    with check (app_can_score(org_id));
