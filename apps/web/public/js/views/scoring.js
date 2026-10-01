/**
 * Scoring.
 *
 * ---------------------------------------------------------------------------
 * ONE RUN AT A TIME, IN DRAW ORDER, WITHOUT LOOKING AWAY FROM THE ARENA.
 * ---------------------------------------------------------------------------
 * The person typing here is watching the run happen, or reading the paper a
 * runner just handed her. So the list is the day sheet's order, Enter saves
 * the run and moves to the next contestant, and nothing is more than one
 * field wide.
 *
 * A valid run is stored as the engine scores it — official for a time or a
 * marked ride, no-time, or DQ. What keeps a wrong number off the scoreboard and
 * out of an envelope is the event, not the run: an event cannot be made
 * official, or paid, until every run's two pieces of paper agree. On a timed
 * event that is the timer sheet against the flag judge's card; on a judged
 * event it is the judges' cards against the total she typed. Make official is
 * a separate, deliberate action, and she confirms she compared them.
 *
 * With no signal, every save goes to this laptop's queue and is marked NOT ON
 * THE SERVER until sync accepts it. Enter still moves to the next run.
 */

import { api } from '../api.js';
import * as offline from '../offline.js';
import {
  crossCheck, eventBlockers, eventConfig, keyOf, nightState, scoreRowFromChange,
} from '../night.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';
import { deskPanel, loadNight, notOnServer } from './desk.js';

// A release means he is not running: nothing to score.
const OUT = new Set(['scratched', 'turned_out', 'no_show', 'medical_release']);

/** The run she pressed Trade on, kept across a redraw of the screen. */
let trading = null;

/** "NT" — the paper says no time. Blank — not entered yet. */
export function readTime(value) {
  const v = String(value ?? '').trim();
  if (v === '') return { entered: false };
  if (/^n\.?t\.?$/i.test(v)) return { entered: true, time: null };
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? { entered: true, time: n } : { entered: true, bad: true };
}

/**
 * Save one run's score: live when the server can be reached and nothing is
 * waiting ahead of it, otherwise to this laptop's queue.
 */
export async function saveRun(rodeoId, { existing, body, rodeo_event_id, label }) {
  const data = { ...body, rodeo_id: rodeoId, rodeo_event_id };
  if (existing && existing.on_server === false && existing.queue_state === 'queued') {
    // Still waiting on this laptop: the corrected paper replaces it in the queue.
    return offline.replaceQueued(existing.seq, data);
  }
  if (existing && existing.on_server === false && existing.queue_state === 'rejected') {
    // She re-entered the paper on a run the server refused: that is her choice.
    // The new score goes against the version the server said it holds.
    const rows = await offline.queued(rodeoId);
    const refused = rows.find((r) => r.seq === existing.seq);
    await offline.resolveRejected(existing.seq, 'drop');
    return offline.sendNow(rodeoId, {
      entity_type: 'score', action: 'update', data, label,
      base_version: refused?.conflict?.server_version?.version,
    });
  }
  if (existing) {
    // An edit of what the server holds, made against the version she saw. If
    // this screen wrote it a moment ago it does not know the version yet, so
    // it asks the server — while there is one to ask.
    let version = existing.on_server ? existing.version : undefined;
    if (existing.on_server && version == null) {
      try {
        const fresh = await api.offlinePacket(rodeoId);
        version = fresh.scores.find((x) => x.id === existing.id)?.version;
      } catch { /* no signal: the server will ask her to choose */ }
    }
    return offline.sendNow(rodeoId, {
      entity_type: 'score', action: 'update', data, label, base_version: version,
    });
  }
  return offline.record(rodeoId, {
    live: () => api.submitScore(rodeoId, rodeo_event_id, body),
    change: { entity_type: 'score', data, label },
  });
}

export async function scoringView(rodeoId) {
  showPrint(null);
  const night = await loadNight(rodeoId);
  const state = nightState(night.packet, night.queue);
  const { packet } = night;
  const rodeo = packet.rodeo;

  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Scoring' },
  );

  const rerender = () => scoringView(rodeoId).catch((e) => toast(e.message, true));
  const whole = packet.day_sheets.find((s) => s.performance_number === null)?.sheet;
  if (trading && trading.rodeo_id !== rodeoId) trading = null;

  const sections = (whole?.sections ?? []).map((section) => {
    const event = packet.events.find((e) => e.id === section.rodeo_event_id);
    const config = eventConfig(packet, section.rodeo_event_id);
    const timed = section.scoring_mode === 'timed';
    const rules = config?.timed_penalties ?? [];
    const components = config?.components ?? [];
    const firstInputs = [];
    const cardInputs = [];

    // Draw order as it stands on this laptop, trades and turnouts included.
    const runs = section.runs
      .map((run) => ({ run, entry: state.entries.get(run.entry_id) }))
      .filter(({ entry, run }) => !(entry ? OUT.has(entry.status) : run.is_scratched))
      .sort((a, b) =>
        (a.entry?.performance_number ?? 0) - (b.entry?.performance_number ?? 0)
        || (a.entry?.draw_position ?? 0) - (b.entry?.draw_position ?? 0));

    const blockerBox = h('div');
    function paintBlockers() {
      const blockers = eventBlockers(state, section.rodeo_event_id);
      blockerBox.replaceChildren(blockers.length
        ? h('div', { class: 'issue warning' },
            h('div', { class: 'where' }, `${blockers.length} run(s) not ready to be official`),
            h('div', {}, blockers.slice(0, 5).map((b) => `${b.contestant_name}: ${b.message}`).join(' · ')))
        : '');
      return blockers;
    }

    const rows = runs.map(({ run, entry }, i) => {
      const scoreKey = keyOf(run.entry_id, run.go_round);
      let existing = state.scores.get(scoreKey);

      // ---- penalties ------------------------------------------------------
      const penaltyControls = (prefix, saved) => rules.map((rule) => {
        const have = (saved ?? []).find((p) => p.type === rule.type);
        // A stored penalty carries its seconds, not its count: two knockdowns
        // at 5s are stored as 10s. Read the count back from that.
        const count = have ? (have.count ?? (have.seconds ? Math.round(have.seconds / rule.seconds) : 1)) : 0;
        const input = rule.repeatable
          ? h('input', {
              class: 'scoreinput', type: 'number', min: '0', max: '9', step: '1',
              style: 'width:3.2em', 'aria-label': `${prefix} ${rule.type}`,
              title: `${rule.type.replace(/_/g, ' ')} +${rule.seconds}s each`,
              value: count ? String(count) : '',
            })
          : h('input', { type: 'checkbox', checked: have ? true : null, 'aria-label': `${prefix} ${rule.type}` });
        return {
          rule,
          input,
          node: h('label', { class: 'small', style: 'display:inline;white-space:nowrap' },
            input, ` ${rule.type.replace(/_/g, ' ')} +${rule.seconds}`),
        };
      });
      const readPenalties = (controls) => controls.flatMap(({ rule, input }) => {
        if (!rule.repeatable) return input.checked ? [{ type: rule.type }] : [];
        const n = Number(input.value);
        return Number.isInteger(n) && n > 0 ? [{ type: rule.type, count: n }] : [];
      });

      // ---- the two pieces of paper ----------------------------------------
      let cells;
      let collect;
      if (timed) {
        const card = existing?.cross_check?.judge_card;
        const timer = h('input', {
          class: 'scoreinput', inputmode: 'decimal', placeholder: 'timer sheet',
          'aria-label': `${run.contestant_name} timer sheet time`,
          value: existing && existing.status !== 'invalid'
            ? (existing.raw_time === null ? 'NT' : String(existing.raw_time ?? '')) : '',
          onkeydown: (e) => enter(e, () => firstInputs[i + 1]),
        });
        const flag = h('input', {
          class: 'scoreinput', inputmode: 'decimal', placeholder: 'flag card',
          'aria-label': `${run.contestant_name} flag judge card time`,
          value: card ? (card.raw_time === null ? 'NT' : String(card.raw_time)) : '',
          onkeydown: (e) => enter(e, () => cardInputs[i + 1]),
        });
        const timerPen = penaltyControls('timer sheet', existing?.time_penalties);
        const cardPen = penaltyControls('flag card', card?.penalties);
        firstInputs.push(timer);
        cardInputs.push(flag);
        cells = [
          h('td', {}, timer, h('div', {}, timerPen.map((c) => c.node))),
          h('td', {}, flag, h('div', {}, cardPen.map((c) => c.node))),
        ];
        collect = (noTime) => {
          const t = noTime ? { entered: true, time: null } : readTime(timer.value);
          const c = readTime(flag.value);
          if (!t.entered) return { error: 'Enter the timer-sheet time, or NT.' };
          if (t.bad || c.bad) return { error: 'A time is a number of seconds, or NT.' };
          return {
            raw_time: t.time,
            penalties: readPenalties(timerPen),
            ...(c.entered
              ? { cross_check: { kind: 'timed', judge_card: { raw_time: c.time, penalties: readPenalties(cardPen) } } }
              : {}),
          };
        };
      } else {
        const judgeInputs = packet.judges.map((j, jIdx) =>
          components.map((comp) => h('input', {
            class: 'scoreinput', type: 'number', min: String(comp.min ?? 0), max: String(comp.max ?? 100),
            step: String(config?.increment ?? 0.5), inputmode: 'decimal',
            style: 'width:4.2em', placeholder: `${comp.name} ${jIdx + 1}`,
            'aria-label': `${run.contestant_name} judge ${jIdx + 1} ${comp.name}`,
            value: String(
              existing?.judge_scores?.[jIdx]?.components?.find((x) => x.name === comp.name)?.value ?? ''),
          })));
        const total = h('input', {
          class: 'scoreinput', inputmode: 'decimal', placeholder: 'total',
          'aria-label': `${run.contestant_name} total typed off the cards`,
          value: existing?.cross_check?.typed_total != null ? String(existing.cross_check.typed_total) : '',
          onkeydown: (e) => enter(e, () => firstInputs[i + 1]),
        });
        firstInputs.push(judgeInputs[0]?.[0] ?? total);
        cells = [
          h('td', {}, packet.judges.length
            ? judgeInputs.map((set, jIdx) => h('div', { class: 'small' }, `${jIdx + 1} `, set))
            : h('span', { class: 'muted small' }, 'No judges assigned — their cards cannot be entered.')),
          h('td', {}, total),
        ];
        collect = () => {
          if (!packet.judges.length) return { error: 'Assign the judges before scoring a judged event.' };
          const judges = packet.judges.map((j, jIdx) => ({
            judge_id: j.user_id,
            judge_position: jIdx + 1,
            components: components.map((comp, cIdx) => ({
              name: comp.name, value: Number(judgeInputs[jIdx][cIdx].value),
            })),
          }));
          if (judges.some((j) => j.components.some((c) => !Number.isFinite(c.value)))) {
            return { error: 'Every judge mark is a number.' };
          }
          const typed = readTime(total.value);
          if (typed.bad) return { error: 'The total is a number.' };
          return {
            judges,
            ...(typed.entered ? { cross_check: { kind: 'judged', typed_total: typed.time } } : {}),
          };
        };
      }

      // ---- where this run stands ------------------------------------------
      const statusCell = h('td', { class: 'small' });
      function paint() {
        const verdict = existing ? crossCheck(config, existing) : null;
        statusCell.replaceChildren(...(existing
          ? [
              existing.status === 'invalid'
                ? h('span', { class: 'muted' }, 'the engine refused this')
                : String(timed ? (existing.final_time ?? 'NT') : (existing.final_score ?? existing.status)),
              ' ',
              verdict
                ? h('span', { class: verdict.ok ? 'pill ok' : 'pill', title: verdict.message },
                    verdict.ok ? 'card = sheet' : verdict.code === 'NOT_COMPARED' ? 'not compared' : 'DISAGREE')
                : '',
              ' ',
              notOnServer(existing) ?? '',
            ]
          : []));
      }
      paint();

      function enter(e, next) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        // Enter moves on at once; the save finishes behind her.
        next()?.focus();
        save(false);
      }

      async function save(noTime) {
        if (!event?.scoring_config_id) return toast('This event has no scoring configuration.', true);
        const fields = collect(noTime);
        if (fields.error) return toast(fields.error, true);
        const body = {
          entry_id: run.entry_id,
          contestant_id: run.contestant_id,
          go_round: run.go_round,
          scoring_config_id: event.scoring_config_id,
          source: 'secretary',
          ...fields,
        };
        try {
          const out = await saveRun(rodeoId, {
            existing,
            body,
            rodeo_event_id: section.rodeo_event_id,
            label: `${run.contestant_name} — ${section.event_label}`,
          });
          // Repaint this run only: a redraw of the screen would take the
          // cursor away from the run she has already moved on to.
          if (out.where === 'server') {
            const r = out.result ?? {};
            existing = {
              ...scoreRowFromChange(packet, {
                change: { id: r.id ?? existing?.id, data: { ...body, rodeo_event_id: section.rodeo_event_id } },
              }),
              id: r.id ?? existing?.id,
              on_server: true,
              version: r.id ? 0 : undefined,
            };
            toast(`${run.contestant_name} saved on the server.`);
          } else {
            const row = out.row;
            existing = { ...scoreRowFromChange(packet, row), on_server: false, queue_state: row.state, seq: row.seq };
            if (out.where === 'refused') toast(`${run.contestant_name}: ${out.explanation}`, true);
            else toast(`${run.contestant_name} saved ON THIS LAPTOP ONLY — not on the server yet.`, true);
          }
          state.scores.set(scoreKey, existing);
          paint();
          paintBlockers();
        } catch (err) {
          toast(err.message, true);
        }
      }

      // ---- trading --------------------------------------------------------
      const canTradeWith = trading && entry && trading.entry.entry_id !== entry.entry_id
        && trading.event_id === section.rodeo_event_id && trading.go_round === run.go_round;
      const tradeButton = !entry || entry.draw_position == null
        ? null
        : canTradeWith
          ? h('button', { class: 'ghost', onclick: () => trade(trading, { entry, run }) }, 'Trade with')
          : h('button', {
              class: 'ghost',
              onclick: () => {
                trading = { rodeo_id: rodeoId, entry, run, event_id: section.rodeo_event_id, go_round: run.go_round };
                toast(`${run.contestant_name}: now press "Trade with" on the other run.`);
                rerender();
              },
            }, 'Trade');

      return h('tr', {},
        h('td', { class: 'pos' },
          entry?.performance_number ? h('span', { class: 'muted small' }, `P${entry.performance_number} `) : null,
          entry?.draw_position ?? run.position),
        h('td', {}, run.contestant_name,
          run.partner_name ? h('span', { class: 'muted small' }, ` / ${run.partner_name}`) : null,
          entry && entry.on_server === false ? [' ', notOnServer(entry)] : null),
        h('td', { class: 'muted small' },
          section.is_roughstock ? run.stock_name ?? '' : run.horse_name ?? ''),
        ...cells,
        statusCell,
        h('td', {},
          h('button', { class: 'ghost', onclick: () => save(false) }, 'Save'),
          timed ? h('button', { class: 'ghost', onclick: () => save(true) }, 'No time') : null,
          tradeButton,
        ),
      );
    });

    paintBlockers();
    const official = state.finalized.get(section.rodeo_event_id);

    return h('section', { class: 'card' },
      h('h2', {},
        section.event_label,
        section.go_round > 1 ? ` — Round ${section.go_round}` : '',
        h('span', { class: 'muted small' }, `   ${runs.length} up`),
        official ? [' ', h('span', { class: 'pill ok' }, 'official'), ' ', notOnServer(official)] : null,
      ),
      h('table', { class: 'sheet' },
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, 'Contestant'), h('th', {}, ''),
          h('th', {}, timed ? 'Timer sheet' : 'Judge cards'),
          h('th', {}, timed ? 'Flag judge card' : 'Total typed'),
          h('th', {}, ''), h('th', {}, ''))),
        h('tbody', {}, rows),
      ),
      blockerBox,
      h('div', { class: 'actions' },
        h('button', {
          class: 'ghost',
          onclick: async () => {
            try {
              await api.finalize(rodeoId, section.rodeo_event_id, false);
              toast('Placings computed. Look them over, then make them official.');
            } catch (err) {
              toast(offline.isUnreachable(err)
                ? 'No signal: placings are computed on the server. Make official can still be recorded here.'
                : err.message, true);
            }
          },
        }, 'Compute placings'),
        h('button', {
          onclick: async () => {
            if (paintBlockers().length) {
              return toast('Not until every judge card agrees with its timer sheet.', true);
            }
            if (!confirm('Have you compared every judge card with its timer sheet for this event?')) return;
            try {
              const out = await offline.record(rodeoId, {
                live: () => api.finalize(rodeoId, section.rodeo_event_id, true, true),
                change: {
                  entity_type: 'finalize',
                  data: { rodeo_id: rodeoId, rodeo_event_id: section.rodeo_event_id, official: true, confirm: true },
                  label: `Make official — ${section.event_label}`,
                },
              });
              toast(out.where === 'server'
                ? 'Official. This is what contestants and the public now see.'
                : 'Official ON THIS LAPTOP ONLY — it goes to the server when the link is back.',
              out.where !== 'server');
            } catch (err) { toast(err.message, true); }
            rerender();
          },
        }, 'Make official'),
      ),
    );
  });

  async function trade(a, b) {
    if (!confirm(`Trade ${a.run.contestant_name} and ${b.run.contestant_name}? Each takes the other's run; the drawn stock stays with each contestant.`)) {
      trading = null;
      return rerender();
    }
    const slot = (e) => ({ performance_number: e.performance_number ?? null, draw_position: e.draw_position });
    const data = {
      rodeo_id: rodeoId,
      rodeo_event_id: a.event_id,
      a: { entry_id: a.entry.entry_id, ...slot(a.entry) },
      b: { entry_id: b.entry.entry_id, ...slot(b.entry) },
    };
    try {
      const out = await offline.record(rodeoId, {
        live: () => api.trade(rodeoId, a.event_id, {
          a_entry_id: data.a.entry_id,
          b_entry_id: data.b.entry_id,
          expect: { a: slot(a.entry), b: slot(b.entry) },
        }),
        change: { entity_type: 'trade', data, label: `Trade ${a.run.contestant_name} ⇄ ${b.run.contestant_name}` },
      });
      toast(out.where === 'server' ? 'Traded.' : 'Traded ON THIS LAPTOP ONLY — not on the server yet.',
        out.where !== 'server');
    } catch (err) { toast(err.message, true); }
    trading = null;
    rerender();
  }

  function draw() {
    render(
      h('div', {},
        h('h1', {}, 'Scoring'),
        deskPanel(rodeoId, { source: night.source, onChange: rerender }),
        h('p', { class: 'muted' },
          'Type the time, press Enter, it saves and moves down. NT for a no-time. A valid run is '
          + 'stored as scored; the event goes official only when every judge card agrees with its '
          + 'timer sheet.'),
        sections.length
          ? sections
          : h('div', { class: 'card' },
              h('p', { class: 'muted' }, 'Nothing drawn yet.')),
      ),
    );
  }
  draw();
}
