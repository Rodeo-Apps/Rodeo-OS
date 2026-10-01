-- ============================================================================
-- 0030 — the offline desk: the secretary's own authority, and the two papers
-- ============================================================================
--
-- 1. scores.source gains 'secretary'.
--
--    The sync authority model (apps/api/src/core/sync.ts) ranks the
--    secretary's terminal at 30, above a judge's tablet and below timer
--    hardware. The column could not hold that value, so every score she typed
--    was stored as 'manual' (rank 10): a laptop coming back online outranked
--    her own earlier scores, and two secretaries who changed the same run
--    never reached the manual_required rule that exists for exactly that case.
--
-- 2. scores.cross_check holds the second piece of paper.
--
--    She does not pay an event until the flag judge's card has been compared
--    with the timer sheet. The live row already holds the timer sheet
--    (raw_time, time_penalties) and the judges' cards (judge_scores). It has
--    nowhere for the flag judge's card time and penalties on a timed run, nor
--    for the total she typed off the cards on a judged run. The comparison is
--    made by the engine (packages/engine/src/scoring/crosscheck.ts); this
--    column only keeps what it compares against, so the server can refuse to
--    make an event official, or pay an envelope, while they disagree.
--
--    Shape: {"kind":"timed","judge_card":{"raw_time":..,"penalties":[..]}}
--       or  {"kind":"judged","typed_total":..,"marked_out":..,"dq_triggers":[..]}
-- ============================================================================

alter table scores drop constraint scores_source_check;
alter table scores add constraint scores_source_check check (source in (
    'manual', 'timer_hardware', 'web_serial', 'import', 'timer_bridge',
    'secretary'
));

alter table scores add column cross_check jsonb
    check (cross_check is null or jsonb_typeof(cross_check) = 'object');

comment on column scores.cross_check is
    'The judge card (timed) or typed total (judged) the stored score is checked against before an event goes official or is paid.';
