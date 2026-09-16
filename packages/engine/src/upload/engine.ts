/**
 * The results packet — Form M checklist and the filing deadline.
 *
 * ---------------------------------------------------------------------------
 * THE MOMENT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * A packet that goes to the association missing one signed judge sheet comes
 * straight back, and now the secretary is chasing a judge who is three hours
 * down the highway. The cost of a missing item is not the item — it is the day
 * spent recovering it after everyone has gone home. So this module does two
 * dull, high-value things:
 *
 *   1. Says exactly which items THIS association wants in the packet, so the
 *      secretary checks them off against the right list, not a generic one.
 *   2. Says exactly when the packet is due, doing the working-day and
 *      wall-clock arithmetic that people get wrong by an hour or a day.
 *
 * It never invents a requirement or a deadline. Where an association publishes
 * no fixed deadline ("sheets as published"), it says so rather than making one
 * up — a made-up deadline shown as if it were the association's is worse than
 * no deadline at all.
 *
 * No clock, no I/O: "now" is passed in so the arithmetic is testable.
 *
 * Sources for the lists and deadlines: PRCA Official Rodeo Rules R4.13;
 * WPRA 10.11; NHSRA rule book / nhsra.com; IPRA secretary mail list;
 * PSRA §15 secretarial packet; Cajun RA Official's Handbook remittance list.
 * Because these are transcribed from secondary sources, every deadline result
 * carries a note telling the secretary to confirm against the current packet.
 */

// ---------------------------------------------------------------------------
// The catalogue of packet items
// ---------------------------------------------------------------------------

export type PacketItemCode =
  | 'results_master'
  | 'judge_sheets'
  | 'timer_sheets'
  | 'stock_draw'
  | 'position_draw'
  | 'turnout_fines_list'
  | 'infraction_sheets'
  | 'personnel_names'
  | 'payoff_sheets'
  | 'check_distribution'
  | 'insurance_forms'
  | 'ground_rules'
  | 'measurements'
  | 'humane_report'
  | 'youth_blanks'
  | 'membership_permits'
  | 'arena_director_sheet'
  | 'stock_contractor_report'
  | 'receivables_report'
  | 'barrel_pattern'
  | 'contestant_list';

/** Human labels, taken from the Form M checklist wording. */
export const PACKET_ITEM_LABELS: Record<PacketItemCode, string> = {
  results_master: 'Official results / master sheet',
  judge_sheets: 'Judge sheets (signed originals)',
  timer_sheets: 'Timer sheets (signed originals)',
  stock_draw: 'Stock draw',
  position_draw: 'Position draw',
  turnout_fines_list: 'TO / DR / VI / DO + fines list',
  infraction_sheets: 'Infraction / field-fine sheets',
  personnel_names: 'Personnel names',
  payoff_sheets: 'Payoff sheets (signed)',
  check_distribution: 'Check distribution / unclaimed',
  insurance_forms: 'Insurance / walk-on forms',
  ground_rules: 'Ground rules copy',
  measurements: "Judges' check / arena measurements",
  humane_report: 'Humane / livestock report',
  youth_blanks: 'Youth: points + national blanks',
  membership_permits: 'Membership / permit forms',
  arena_director_sheet: 'Arena-director sheet',
  stock_contractor_report: 'Stock-contractor report',
  receivables_report: 'Receivables report',
  barrel_pattern: 'Barrel-pattern sheet',
  contestant_list: 'Contestant list',
};

/**
 * What each association wants in the packet.
 *
 * These are the published lists, transcribed as data. They are the starting
 * checklist, not gospel: the secretary confirms against the packet that
 * actually arrived, which is why `checkPacket` always carries the "confirm"
 * note.
 */
const PACKET_REQUIREMENTS: Record<string, PacketItemCode[]> = {
  // Results upload, plus paper backups; unclaimed checks and the
  // check-distribution sheet still travel on paper.
  PRCA: [
    'results_master',
    'judge_sheets',
    'timer_sheets',
    'stock_draw',
    'turnout_fines_list',
    'infraction_sheets',
    'personnel_names',
    'payoff_sheets',
    'check_distribution',
    'insurance_forms',
  ],
  WPRA: [
    'results_master',
    'infraction_sheets',
    'contestant_list',
    'judge_sheets',
    'timer_sheets',
    'barrel_pattern',
  ],
  IPRA: [
    'results_master',
    'judge_sheets',
    'timer_sheets',
    'insurance_forms',
    'humane_report',
    'measurements',
    'ground_rules',
    'personnel_names',
    'payoff_sheets',
  ],
  PSRA: ['results_master', 'timer_sheets', 'judge_sheets', 'payoff_sheets'],
  NHSRA: ['results_master', 'judge_sheets', 'youth_blanks'],
  CAJUN_RA: [
    'receivables_report',
    'membership_permits',
    'judge_sheets',
    'arena_director_sheet',
    'timer_sheets',
    'payoff_sheets',
    'stock_draw',
    'measurements',
    'infraction_sheets',
    'stock_contractor_report',
  ],
};

/** A generic backstop for an association we do not have a published list for. */
const GENERIC_PACKET: PacketItemCode[] = [
  'results_master',
  'judge_sheets',
  'timer_sheets',
  'stock_draw',
  'payoff_sheets',
  'personnel_names',
];

/** Normalise 'Cajun RA', 'cajun_ra', 'PRCA ' etc. to a lookup key. */
function normalizeCode(association: string | null | undefined): string {
  return (association ?? '').trim().toUpperCase().replace(/[^A-Z]+/g, '_');
}

/**
 * The items THIS association wants in the packet.
 *
 * Falls back to a generic backstop list for an unknown association rather than
 * an empty one, because "no list" reads as "nothing required" and that is the
 * one answer that gets a packet rejected.
 */
export function requiredPacketItems(
  association: string | null | undefined,
): PacketItemCode[] {
  const key = normalizeCode(association);
  return [...(PACKET_REQUIREMENTS[key] ?? GENERIC_PACKET)];
}

// ---------------------------------------------------------------------------
// The deadline
// ---------------------------------------------------------------------------

export type DeadlineMode =
  | 'walltime' // a fixed wall-clock time on a day offset from the last perf
  | 'calendar_days' // N calendar days after the last perf
  | 'working_days' // N working days (Mon–Fri) after the last perf
  | 'as_published'; // no fixed deadline; the association publishes it per event

interface DeadlineRule {
  mode: DeadlineMode;
  /** For 'walltime'. */
  local_time?: string;
  day_offset?: number;
  /** For calendar_days / working_days. */
  days?: number;
  note: string;
}

const DEADLINE_RULES: Record<string, DeadlineRule> = {
  PRCA: {
    mode: 'walltime',
    local_time: '23:59',
    day_offset: 0,
    note: 'PRCA upload 11:59 p.m. Mountain Time. Confirm against the Secretary System.',
  },
  WPRA: {
    mode: 'as_published',
    note: 'WPRA sheets are turned in as published for the event. No fixed clock here.',
  },
  IPRA: {
    mode: 'working_days',
    days: 3,
    note: 'IPRA packet mailed within 3 working days of the last performance.',
  },
  PSRA: {
    mode: 'calendar_days',
    days: 5,
    note: 'PSRA originals within 5 days; bond is at risk if the packet is late.',
  },
  NHSRA: {
    mode: 'calendar_days',
    days: 5,
    note: 'NHSRA state results / national blanks within 5 days.',
  },
};

export interface PacketDeadlineInput {
  association: string | null | undefined;
  /** Last performance date, 'YYYY-MM-DD'. */
  last_performance_date: string;
  now_ms: number;
  /**
   * Timezone for the exact instant. Defaults to America/Denver for PRCA
   * (Mountain Time is published); for others it is the local arena zone the
   * caller supplies. When omitted for a day-based deadline, the due DATE is
   * still returned but the exact instant (due_at) is left null.
   */
  timezone?: string | null;
}

export interface PacketDeadline {
  mode: DeadlineMode;
  /** The due calendar date, 'YYYY-MM-DD', or null when as-published. */
  due_date: string | null;
  /** The exact instant, ISO, or null (as-published, or no zone for a day rule). */
  due_at: string | null;
  /** Negative once passed. Null when there is no computable instant. */
  ms_remaining: number | null;
  passed: boolean;
  /** Always present: tells the secretary what to confirm. */
  note: string;
}

/**
 * When the packet is due for this association.
 *
 * The working-day and calendar-day rules land the packet on a due DATE; the
 * exact instant is the end of that day (23:59) in the supplied zone. PRCA's
 * 11:59 p.m. Mountain is a wall clock and gets the full timezone treatment so
 * it does not file an hour late every summer.
 */
export function associationPacketDeadline(
  input: PacketDeadlineInput,
): PacketDeadline {
  const key = normalizeCode(input.association);
  const rule = DEADLINE_RULES[key] ?? {
    mode: 'as_published' as DeadlineMode,
    note: 'No published deadline on file for this association. Confirm with the office.',
  };

  if (rule.mode === 'as_published') {
    return {
      mode: 'as_published',
      due_date: null,
      due_at: null,
      ms_remaining: null,
      passed: false,
      note: rule.note,
    };
  }

  let dueDate: string;
  if (rule.mode === 'walltime') {
    dueDate = addCalendarDays(input.last_performance_date, rule.day_offset ?? 0);
  } else if (rule.mode === 'working_days') {
    dueDate = addWorkingDays(input.last_performance_date, rule.days ?? 0);
  } else {
    dueDate = addCalendarDays(input.last_performance_date, rule.days ?? 0);
  }

  // The wall time of the deadline: PRCA's published 11:59 p.m., or the end of
  // the due day for a mailing deadline.
  const localTime = rule.mode === 'walltime' ? (rule.local_time ?? '23:59') : '23:59';
  const zone =
    input.timezone ?? (rule.mode === 'walltime' ? 'America/Denver' : null);

  if (!zone) {
    // A day-based deadline with no arena zone: the date is certain, the
    // instant is not, so we do not pretend to a precise ms_remaining.
    return {
      mode: rule.mode,
      due_date: dueDate,
      due_at: null,
      ms_remaining: null,
      passed: false,
      note: rule.note,
    };
  }

  const dueMs = wallTimeToUtcMs(dueDate, localTime, zone);
  return {
    mode: rule.mode,
    due_date: dueDate,
    due_at: new Date(dueMs).toISOString(),
    ms_remaining: dueMs - input.now_ms,
    passed: input.now_ms > dueMs,
    note: rule.note,
  };
}

// ---------------------------------------------------------------------------
// Checking the packet
// ---------------------------------------------------------------------------

export interface PacketCheckItem {
  code: PacketItemCode;
  label: string;
  present: boolean;
}

export interface PacketCheck {
  /** True when every required item is present. */
  ready: boolean;
  items: PacketCheckItem[];
  missing: PacketItemCode[];
  /** Present items that this association does not ask for — kept, just noted. */
  extra: PacketItemCode[];
  note: string;
}

/**
 * Check a set of gathered items against what the association requires.
 *
 * `have` is the set of item codes the secretary has ready. The result lists
 * every required item with a present/absent flag (so the UI renders the whole
 * checklist, not just the gaps), plus the missing codes for a quick blocker
 * count and any extras that are not on this association's list.
 */
export function checkPacket(
  association: string | null | undefined,
  have: PacketItemCode[],
): PacketCheck {
  const required = requiredPacketItems(association);
  const haveSet = new Set(have);
  const requiredSet = new Set(required);

  const items: PacketCheckItem[] = required.map((code) => ({
    code,
    label: PACKET_ITEM_LABELS[code],
    present: haveSet.has(code),
  }));
  const missing = required.filter((code) => !haveSet.has(code));
  const extra = have.filter((code) => !requiredSet.has(code));

  return {
    ready: missing.length === 0,
    items,
    missing,
    extra,
    note:
      'This is the transcribed list. Confirm it against the packet that ' +
      'actually arrived from the association before you seal the envelope.',
  };
}

// ---------------------------------------------------------------------------
// Date arithmetic (standalone — no dependency on the books engine)
// ---------------------------------------------------------------------------

/** Add whole calendar days to a 'YYYY-MM-DD' date, returning 'YYYY-MM-DD'. */
function addCalendarDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Add whole working days (Mon–Fri) to a date. Day 0 is the date itself if it is
 * a working day, else the next working day. "Within 3 working days" counts the
 * three working days after the last performance.
 */
function addWorkingDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  let added = 0;
  while (added < days) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return cursor.toISOString().slice(0, 10);
}

/** Offset in ms between a zone's wall clock and UTC at a given instant. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - utcMs;
}

/** The instant at which a local wall time falls in a zone (DST-correct). */
function wallTimeToUtcMs(
  dateISO: string,
  localTime: string,
  timeZone: string,
): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  const [hh, mm] = localTime.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    throw new Error(`Invalid date or time: '${dateISO}' '${localTime}'`);
  }
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}
