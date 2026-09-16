-- ============================================================================
-- 0032_judge_cards.sql
-- Form C — Riding-event judge sheet, one judge per sheet.
--
-- A judged event (bareback, saddle bronc, bull riding) is marked by two judges
-- who each work from their OWN sheet, in ink, and sign it. The official score
-- is the sum of both judges' marks. Until now a secretary had to collect both
-- paper cards and key them in together; this table lets each judge's card be
-- staged on its own, the moment it is turned in, and the two are combined into
-- the run's score only once both are present and signed.
--
-- This is a STAGING record, not the official score. The official score still
-- lives in `scores` (migration 0005) and is what results and payouts read. A
-- judge card is the evidence behind one half of that score — the paper the
-- judge signed — and it is kept for the association packet (IPRA "judges'
-- cards", WPRA "judge sheets", Cajun RA "signed judge sheets").
--
-- House rules from 0030/0031: org_id on every row, RLS for tenant isolation,
-- and a card is not silently rewritten after a judge signs it.
-- ============================================================================

create table judge_cards (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,
    rodeo_event_id  uuid not null,
    entry_id        uuid not null,
    contestant_id   uuid,

    go_round        int not null default 1 check (go_round >= 1),
    performance     int,

    -- Which judge, and which chair. Position 1 / 2 is how the two cards pair up
    -- into one run; judge_id is who actually sat in that chair.
    judge_id        uuid references users (id),
    judge_position  int not null check (judge_position between 1 and 4),

    -- This judge's own marks. A judged run is scored ride + animal by each
    -- judge; the halves are kept apart because the animal half also feeds the
    -- stock standings. Decimals mirror the `scores` precision.
    rider_score     decimal(8, 2) check (rider_score >= 0),
    animal_score    decimal(8, 2) check (animal_score >= 0),

    marked_out      boolean,
    -- A judge can rule the ride out (buck-off, no mark-out, flop). The note is
    -- the reason in the judge's words; it does not compute, it documents.
    dq_note         text,
    reride_flag     boolean not null default false,

    -- A card is provisional until the judge signs it. Only signed cards count
    -- toward a complete run.
    signed          boolean not null default false,
    signed_at       timestamptz,
    notes           text,

    created_by      uuid references users (id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),

    -- One card per judge chair per run. A resubmission updates in place.
    unique (org_id, rodeo_event_id, entry_id, go_round, judge_position),
    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade,
    foreign key (org_id, rodeo_event_id) references rodeo_events (org_id, id) on delete cascade,
    foreign key (org_id, entry_id) references entries (org_id, id) on delete cascade
);

create index idx_judge_cards_event
    on judge_cards (org_id, rodeo_event_id, go_round);

-- ----------------------------------------------------------------------------
-- RLS — same member-read / staff-write shape as the Secretary Module tables in
-- migrations 0030 and 0031.
-- ----------------------------------------------------------------------------
alter table judge_cards enable row level security;
alter table judge_cards force row level security;

create policy judge_cards_member_read on judge_cards
    for select using (app_is_org_member(org_id));

create policy judge_cards_staff_write on judge_cards
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));
