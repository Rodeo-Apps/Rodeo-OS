import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDaySheet,
  dragMarks,
  renderDaySheetText,
  type DaySheetEntry,
  type DaySheetEvent,
  type DaySheetInput,
} from '../src/index.ts';

const bareback: DaySheetEvent = {
  rodeo_event_id: 'ev-bb',
  event_type: 'bareback',
  event_label: 'Bareback Riding',
  scoring_mode: 'judged',
  is_roughstock: true,
  sort_order: 1,
};

const barrels: DaySheetEvent = {
  rodeo_event_id: 'ev-br',
  event_type: 'barrel_racing',
  event_label: 'Barrel Racing',
  scoring_mode: 'timed',
  is_roughstock: false,
  sort_order: 5,
  drag_every: 5,
};

function entry(over: Partial<DaySheetEntry> & { entry_id: string }): DaySheetEntry {
  return {
    rodeo_event_id: 'ev-br',
    contestant_id: `c-${over.entry_id}`,
    contestant_name: 'Jane Roper',
    go_round: 1,
    draw_position: 1,
    status: 'confirmed',
    performance_id: 'perf-1',
    ...over,
  };
}

function input(over: Partial<DaySheetInput> = {}): DaySheetInput {
  return {
    rodeo_id: 'r1',
    rodeo_name: 'Ada Roundup',
    venue: 'Pontotoc County Arena',
    sanctioned_by: ['PRCA'],
    performance: {
      id: 'perf-1',
      name: 'Friday Night',
      type: 'performance',
      date: '2026-09-11',
      scheduled_start: '7:00 PM',
    },
    events: [bareback, barrels],
    entries: [],
    ...over,
  };
}

describe('day sheet', () => {
  it('orders runs by the draw', () => {
    const sheet = buildDaySheet(
      input({
        entries: [
          entry({ entry_id: 'a', contestant_name: 'Carter', draw_position: 3 }),
          entry({ entry_id: 'b', contestant_name: 'Adams', draw_position: 1 }),
          entry({ entry_id: 'c', contestant_name: 'Baker', draw_position: 2 }),
        ],
      }),
    );
    const names = sheet.sections[0].runs.map((r) => r.contestant_name);
    assert.deepEqual(names, ['Adams', 'Baker', 'Carter']);
    assert.deepEqual(sheet.sections[0].runs.map((r) => r.position), [1, 2, 3]);
  });

  it('never drops an undrawn entry, and sorts it last', () => {
    // A sheet that silently omits somebody is how a contestant gets left out
    // of a performance.
    const sheet = buildDaySheet(
      input({
        entries: [
          entry({ entry_id: 'a', contestant_name: 'Drawn', draw_position: 1 }),
          entry({ entry_id: 'b', contestant_name: 'Undrawn', draw_position: null }),
        ],
      }),
    );
    const runs = sheet.sections[0].runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[1].contestant_name, 'Undrawn');
  });

  it('is deterministic when two entries share a draw position', () => {
    const rows = [
      entry({ entry_id: 'a', contestant_name: 'Zeta', draw_position: 2 }),
      entry({ entry_id: 'b', contestant_name: 'Alpha', draw_position: 2 }),
    ];
    const first = buildDaySheet(input({ entries: rows }));
    const second = buildDaySheet(input({ entries: [...rows].reverse() }));
    assert.deepEqual(
      first.sections[0].runs.map((r) => r.contestant_name),
      second.sections[0].runs.map((r) => r.contestant_name),
    );
  });

  it('shows a scratch but does not give it a running number', () => {
    const sheet = buildDaySheet(
      input({
        entries: [
          entry({ entry_id: 'a', contestant_name: 'Ran', draw_position: 1 }),
          entry({
            entry_id: 'b',
            contestant_name: 'Gone',
            draw_position: 2,
            status: 'turned_out',
          }),
          entry({ entry_id: 'c', contestant_name: 'Also Ran', draw_position: 3 }),
        ],
      }),
    );
    const runs = sheet.sections[0].runs;
    assert.equal(runs[1].is_scratched, true);
    assert.equal(runs[1].position, 0, 'a scratch takes no running number');
    assert.equal(runs[2].position, 2, 'the next live run is 2, not 3');
    assert.ok(runs[1].flags.includes('turned_out'));
    assert.equal(sheet.sections[0].live_count, 2);
    assert.equal(sheet.sections[0].entered_count, 3);
  });

  it('a medical or vet release is out: no running number, not live, and no drag moves', () => {
    // classifyTurnout stores 'medical_release' for every excused reason.
    const names = ['One', 'Medic', 'Two', 'Vet', 'Three', 'Four', 'Five', 'Six'];
    const sheet = buildDaySheet(
      input({
        events: [barrels],
        entries: names.map((name, i) =>
          entry({
            entry_id: `e${i}`,
            contestant_name: name,
            draw_position: i + 1,
            ...(name === 'Medic' ? { status: 'medical_release', release_type: 'medical' } : {}),
            ...(name === 'Vet' ? { status: 'medical_release', release_type: 'vet_release' } : {}),
          }),
        ),
      }),
    );
    const section = sheet.sections[0];
    const run = (n: string) => section.runs.find((r) => r.contestant_name === n)!;

    for (const out of ['Medic', 'Vet']) {
      assert.equal(run(out).is_scratched, true, `${out} is out`);
      assert.equal(run(out).position, 0, `${out} takes no running number`);
    }
    assert.deepEqual(run('Medic').flags, ['medical_release']);
    assert.deepEqual(run('Vet').flags, ['vet_release']);

    // Still entered: the numbers count past the releases.
    assert.equal(run('One').position, 1);
    assert.equal(run('Two').position, 2);
    assert.equal(run('Six').position, 6);

    assert.equal(section.live_count, 6, 'eight entered, six running');
    assert.equal(sheet.total_runs, 6);
    // Drag every 5 LIVE runs: after Five, the fifth one running — not after
    // the fifth line on the paper.
    assert.deepEqual(section.drags, [{ after_position: 5, condensed: false }]);

    const text = renderDaySheetText(sheet);
    const lines = text.split('\n');
    assert.match(lines.find((l) => l.includes('Vet'))!, /^--\s+Vet\s+VET RELEASE$/);
    assert.match(lines.find((l) => l.includes('Medic'))!, /^--\s+Medic\s+MEDICAL RELEASE$/);
    assert.match(lines.find((l) => l.includes('Two'))!, /^2\s+Two\s*$/);
    const five = lines.findIndex((l) => l.includes('Five'));
    assert.match(lines[five + 1], /drag/i, 'the drag falls after the fifth live run');
    assert.match(text, /\(6 up\)/);
  });

  it('a stock issue or weather release is out too, and prints its stored reason', () => {
    const sheet = buildDaySheet(
      input({
        events: [barrels],
        entries: [
          entry({ entry_id: 'a', contestant_name: 'Ran', draw_position: 1 }),
          entry({
            entry_id: 'b', contestant_name: 'Rained Out', draw_position: 2,
            status: 'medical_release', release_type: 'weather',
          }),
          entry({
            entry_id: 'c', contestant_name: 'Bad Steer', draw_position: 3,
            status: 'medical_release', release_type: 'stock_issue',
          }),
          entry({ entry_id: 'd', contestant_name: 'Also Ran', draw_position: 4 }),
        ],
      }),
    );
    const runs = sheet.sections[0].runs;
    assert.deepEqual(runs.map((r) => r.position), [1, 0, 0, 2]);
    assert.deepEqual(runs[1].flags, [], 'no new flag type');
    assert.equal(sheet.sections[0].live_count, 2);

    const lines = renderDaySheetText(sheet).split('\n');
    assert.match(lines.find((l) => l.includes('Rained Out'))!, /^--\s+Rained Out\s+WEATHER$/);
    assert.match(lines.find((l) => l.includes('Bad Steer'))!, /^--\s+Bad Steer\s+STOCK ISSUE$/);
  });

  it('counts drags over live runs, not entered runs', () => {
    // A scratch does not stir up the ground. Counting it would put the tractor
    // out early and every later drag in the wrong place.
    assert.deepEqual(dragMarks(12, 5), [
      { after_position: 5, condensed: false },
      { after_position: 10, condensed: false },
    ]);
    // No drag after the final run — the crew is dragging anyway.
    assert.deepEqual(dragMarks(10, 5).length, 1);
    assert.deepEqual(dragMarks(4, 5), []);
    assert.deepEqual(dragMarks(20, null), []);
    assert.deepEqual(dragMarks(20, 0), []);
  });

  it('carries drawn stock for a roughstock event', () => {
    const sheet = buildDaySheet(
      input({
        events: [bareback],
        entries: [
          entry({
            entry_id: 'a',
            rodeo_event_id: 'ev-bb',
            contestant_name: 'Tyler Hayes',
            draw_position: 1,
          }),
        ],
        stock: [
          { entry_id: 'a', go_round: 1, animal_name: 'Night Crawler', brand_number: '214' },
        ],
      }),
    );
    assert.equal(sheet.sections[0].runs[0].stock_name, 'Night Crawler');
    assert.equal(sheet.sections[0].runs[0].stock_brand, '214');
  });

  it('separates go-rounds into their own sections', () => {
    const sheet = buildDaySheet(
      input({
        events: [barrels],
        entries: [
          entry({ entry_id: 'a', go_round: 2, draw_position: 1 }),
          entry({ entry_id: 'b', go_round: 1, draw_position: 1 }),
        ],
      }),
    );
    assert.deepEqual(sheet.sections.map((s) => s.go_round), [1, 2]);
  });

  it('scopes to one performance, and shows the whole rodeo when asked', () => {
    const rows = [
      entry({ entry_id: 'a', performance_id: 'perf-1' }),
      entry({ entry_id: 'b', performance_id: 'perf-2', draw_position: 2 }),
    ];
    const one = buildDaySheet(input({ entries: rows }));
    assert.equal(one.total_runs, 1);

    const all = buildDaySheet(
      input({
        entries: rows,
        performance: {
          id: null,
          name: 'All performances',
          type: 'performance',
          date: '2026-09-11',
        },
      }),
    );
    assert.equal(all.total_runs, 2);
  });

  it('flags slack so the gate man knows what he is looking at', () => {
    const sheet = buildDaySheet(
      input({
        performance: {
          id: 'perf-1',
          name: 'Saturday Slack',
          type: 'slack',
          date: '2026-09-12',
        },
        entries: [entry({ entry_id: 'a' })],
      }),
    );
    assert.ok(sheet.sections[0].runs[0].flags.includes('slack'));
  });

  it('renders to fixed-width text with the drags in it', () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      entry({
        entry_id: `e${i}`,
        contestant_name: `Rider ${i + 1}`,
        draw_position: i + 1,
        horse_name: 'Dash',
      }),
    );
    const text = renderDaySheetText(
      buildDaySheet(input({ events: [barrels], entries })),
    );
    assert.match(text, /ADA ROUNDUP/);
    assert.match(text, /BARREL RACING/);
    assert.match(text, /DRAG/);
    assert.match(text, /Rider 7/);
    assert.match(text, /Total runs: 7/);
  });

  it('renders with no entries at all rather than throwing', () => {
    const text = renderDaySheetText(buildDaySheet(input()));
    assert.match(text, /Total runs: 0/);
  });
});
