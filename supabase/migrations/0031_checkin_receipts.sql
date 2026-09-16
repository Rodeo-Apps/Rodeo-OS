-- ============================================================================
-- 0031_checkin_receipts.sql
-- Form H — Check-in / Fee Receipt.
--
-- The secretary's arrival desk. A contestant walks up, the secretary confirms
-- they are entered, takes whatever fees are owed, and hands back a receipt. The
-- running total of what has been taken in is the number the close-out (Form M,
-- migration 0030) reconciles against, so every dollar that crosses the desk is
-- recorded here the moment it does.
--
-- Same house rules as 0030: org_id is on every row, tenant isolation is by RLS,
-- and money is integer cents (never a float). A receipt is a record of a moment
-- and is not edited after the fact — a correction is a new row with a note.
-- ============================================================================

create table check_ins (
    id              uuid primary key default gen_random_uuid(),
    org_id          uuid not null references organizations (id) on delete cascade,
    rodeo_id        uuid not null,

    entry_id        uuid,
    contestant_id   uuid,
    contestant_name text not null,
    member_number   text,

    checked_in_at   timestamptz not null default now(),

    -- Money is cents. fees_due is what the desk expected; fees_paid is what
    -- actually crossed the desk this transaction. A partial payment is a real
    -- thing at the desk, so they are stored separately and never assumed equal.
    fees_due_cents  int not null default 0 check (fees_due_cents >= 0),
    fees_paid_cents int not null default 0 check (fees_paid_cents >= 0),

    payment_method  text not null default 'cash' check (payment_method in (
                        'cash', 'check', 'card', 'account', 'comp'
                    )),
    receipt_number  text,
    check_number    text,

    taken_by        uuid references users (id),
    notes           text,
    created_at      timestamptz not null default now(),

    unique (org_id, id),
    foreign key (org_id, rodeo_id) references rodeos (org_id, id) on delete cascade
);

create index idx_check_ins_rodeo on check_ins (org_id, rodeo_id);

-- ----------------------------------------------------------------------------
-- RLS — same member-read / staff-write shape as the Secretary Module tables in
-- migration 0030. The service role the API connects with bypasses RLS; these
-- policies are the backstop for any other connection.
-- ----------------------------------------------------------------------------
alter table check_ins enable row level security;
alter table check_ins force row level security;

create policy check_ins_member_read on check_ins
    for select using (app_is_org_member(org_id));

create policy check_ins_staff_write on check_ins
    for all
    using (app_is_org_staff(org_id))
    with check (app_is_org_staff(org_id));
