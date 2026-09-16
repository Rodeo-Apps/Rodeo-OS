import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOperationalOverlay,
  type OverlayableEntry,
  type TradeOverlayRow,
  type TurnoutOverlayRow,
} from '../src/index.ts';

function entry(over: Partial<OverlayableEntry> & { entry_id: string }): OverlayableEntry {
  return {
    contestant_id: `c-${over.entry_id}`,
    rodeo_event_id: 'ev-1',
    go_round: 1,
    draw_position: 1,
    performance_number: 1,
    status: 'confirmed',
    ...over,
  };
}

describe('applyOperationalOverlay — turnouts', () => {
  it('flags an entry turned out when a turnout log names its entry_id', () => {
    const entries = [entry({ entry_id: 'e1' }), entry({ entry_id: 'e2' })];
    const turnouts: TurnoutOverlayRow[] = [
      { entry_id: 'e1', contestant_id: null, rodeo_event_id: null },
    ];
    const out = applyOperationalOverlay(entries, turnouts, []);
    assert.equal(out.find((e) => e.entry_id === 'e1')?.status, 'turned_out');
    assert.equal(out.find((e) => e.entry_id === 'e2')?.status, 'confirmed');
  });

  it('matches on contestant + event when the log has no entry_id', () => {
    const entries = [entry({ entry_id: 'e1', contestant_id: 'cowboy' })];
    const turnouts: TurnoutOverlayRow[] = [
      { entry_id: null, contestant_id: 'cowboy', rodeo_event_id: 'ev-1' },
    ];
    const out = applyOperationalOverlay(entries, turnouts, []);
    assert.equal(out[0].status, 'turned_out');
  });

  it('does not downgrade a harder scratch to turned_out', () => {
    const entries = [entry({ entry_id: 'e1', status: 'scratched' })];
    const turnouts: TurnoutOverlayRow[] = [
      { entry_id: 'e1', contestant_id: null, rodeo_event_id: null },
    ];
    const out = applyOperationalOverlay(entries, turnouts, []);
    assert.equal(out[0].status, 'scratched');
  });

  it('never mutates the input array', () => {
    const entries = [entry({ entry_id: 'e1' })];
    applyOperationalOverlay(
      entries,
      [{ entry_id: 'e1', contestant_id: null, rodeo_event_id: null }],
      [],
    );
    assert.equal(entries[0].status, 'confirmed');
  });
});

describe('applyOperationalOverlay — confirmed trades', () => {
  const twoSided: TradeOverlayRow = {
    rodeo_event_id: 'ev-1',
    go_round_number: 1,
    contestant_a_id: 'c-e1',
    contestant_b_id: 'c-e2',
    is_open: false,
    from_performance_number: 1,
    from_position: 3,
    to_performance_number: 2,
    to_position: 7,
  };

  it('swaps both contestants into their new slots', () => {
    const entries = [
      entry({ entry_id: 'e1', draw_position: 3, performance_number: 1 }),
      entry({ entry_id: 'e2', draw_position: 7, performance_number: 2 }),
    ];
    const out = applyOperationalOverlay(entries, [], [twoSided]);
    const a = out.find((e) => e.entry_id === 'e1')!;
    const b = out.find((e) => e.entry_id === 'e2')!;
    assert.equal(a.draw_position, 7);
    assert.equal(a.performance_number, 2);
    assert.equal(b.draw_position, 3);
    assert.equal(b.performance_number, 1);
  });

  it('an open trade moves only contestant A into the vacated slot', () => {
    const entries = [entry({ entry_id: 'e1', draw_position: 3 })];
    const open: TradeOverlayRow = {
      ...twoSided,
      contestant_b_id: null,
      is_open: true,
      to_position: 9,
      to_performance_number: null,
    };
    const out = applyOperationalOverlay(entries, [], [open]);
    assert.equal(out[0].draw_position, 9);
    // performance untouched when the trade does not specify one
    assert.equal(out[0].performance_number, 1);
  });

  it('applies trades in the order given', () => {
    const entries = [entry({ entry_id: 'e1', draw_position: 1 })];
    const t1: TradeOverlayRow = {
      ...twoSided,
      contestant_b_id: null,
      is_open: true,
      to_position: 5,
      to_performance_number: null,
    };
    const t2: TradeOverlayRow = { ...t1, to_position: 12 };
    const out = applyOperationalOverlay(entries, [], [t1, t2]);
    assert.equal(out[0].draw_position, 12);
  });
});
