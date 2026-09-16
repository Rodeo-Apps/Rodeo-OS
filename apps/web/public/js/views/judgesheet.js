/**
 * Form C — Riding-event judge cards.
 *
 * ---------------------------------------------------------------------------
 * ONE CHAIR AT A TIME. TWO JUDGES, TWO CARDS, ONE COMBINED SCORE.
 * ---------------------------------------------------------------------------
 * A judged event (broncs, bulls, bareback) is scored by two judges who each
 * watch the same run and mark the ride and the animal on their own sheet. The
 * run's score is the sum of both cards. This screen stages one judge's card at
 * a time: the person keying picks their chair, then goes down the draw entering
 * ride + animal, pressing Enter to save and drop to the next contestant —
 * exactly the rhythm of scoring.js, because it is the same job seen from the
 * judges' stand.
 *
 * Cards land staged and signed on their own. The combined total only appears
 * once BOTH chairs have turned in a signed card; until then the run shows what
 * is still missing. Nothing here is official — combining the two signed cards
 * into a posted score is still done deliberately from the scoring screen.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

export async function judgeSheetView(rodeoId) {
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Judge cards' },
  );

  // The chair being keyed and how many chairs a run needs. Two is the near
  // universal case; a third or fourth judge is offered for the rare event that
  // uses one. These persist for the session so a judge does not reselect their
  // chair on every reload.
  let chair = Number(localStorage.getItem('rodeo.judge.chair')) || 1;
  let requiredJudges = Number(localStorage.getItem('rodeo.judge.required')) || 2;

  async function draw() {
    // The draw order comes from the day sheet, so this list matches the paper
    // in the arena run for run. Only judged events carry cards.
    const sheet = await api.daySheet(rodeoId, null);
    const judged = sheet.sections.filter((s) => s.scoring_mode === 'judged');

    // Pull every staged card once per judged event and index the combined
    // result by run, so each row can show where the pair stands.
    const combinedByRun = new Map();
    for (const section of judged) {
      try {
        const res = await api.judgeCards(rodeoId, section.rodeo_event_id, {
          go_round: String(section.go_round),
          required_judges: String(requiredJudges),
        });
        for (const run of res.runs) {
          combinedByRun.set(`${run.entry_id}:${run.go_round}`, run);
        }
      } catch {
        // A brand-new event has no cards yet; treat as empty.
      }
    }

    const sections = judged.map((section) => {
      const inputs = [];

      const rows = section.runs
        .filter((r) => !r.is_scratched)
        .map((run, i) => {
          const staged = combinedByRun.get(`${run.entry_id}:${run.go_round}`);
          const combined = staged?.combined;
          const mine = staged?.cards?.find((c) => c.judge_position === chair);

          const ride = h('input', {
            class: 'scoreinput',
            type: 'number',
            step: '0.5',
            min: '0',
            max: '25',
            inputmode: 'decimal',
            placeholder: 'ride',
            value: mine?.rider_score ?? '',
            'aria-label': `${run.contestant_name} ride`,
          });
          const animal = h('input', {
            class: 'scoreinput',
            type: 'number',
            step: '0.5',
            min: '0',
            max: '25',
            inputmode: 'decimal',
            placeholder: 'animal',
            value: mine?.animal_score ?? '',
            'aria-label': `${run.contestant_name} animal`,
            onkeydown: (e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              save(run, section, ride, animal, true);
              inputs[i + 1]?.focus();
            },
          });
          inputs.push(ride);

          return h('tr', {},
            h('td', { class: 'pos' }, run.position),
            h('td', {}, run.contestant_name,
              run.back_number ? h('span', { class: 'muted small' }, ` #${run.back_number}`) : null),
            h('td', { class: 'muted small' }, run.stock_name ?? ''),
            h('td', {}, ride),
            h('td', {}, animal),
            h('td', {}, statusCell(combined, chair)),
            h('td', {},
              h('button', {
                class: 'ghost',
                onclick: () => save(run, section, ride, animal, true),
              }, mine ? 'Update' : 'Sign in'),
            ),
            h('td', {},
              h('button', {
                class: 'ghost',
                onclick: () => save(run, section, ride, animal, true, true),
                title: 'Bucked off / no mark-out — this chair rules the ride out',
              }, 'No score'),
            ),
          );
        });

      return h('section', { class: 'card' },
        h('h2', {},
          section.event_label,
          section.go_round > 1 ? ` — Round ${section.go_round}` : '',
          h('span', { class: 'muted small' }, `   ${section.live_count} up`),
        ),
        h('table', { class: 'sheet' },
          h('thead', {},
            h('tr', {},
              h('th', {}, '#'),
              h('th', {}, 'Contestant'),
              h('th', {}, 'Stock'),
              h('th', {}, 'Ride'),
              h('th', {}, 'Animal'),
              h('th', {}, 'Run total'),
              h('th', {}, ''),
              h('th', {}, ''),
            ),
          ),
          h('tbody', {}, rows),
        ),
      );
    });

    async function save(run, section, ride, animal, signed, markedOut = false) {
      const rider_score = ride.value === '' ? null : Number(ride.value);
      const animal_score = animal.value === '' ? null : Number(animal.value);
      if (!markedOut && rider_score === null && animal_score === null) {
        return toast('Enter a ride and animal score, or use No score.', true);
      }
      try {
        await api.saveJudgeCard(rodeoId, section.rodeo_event_id, {
          entry_id: run.entry_id,
          contestant_id: run.contestant_id,
          go_round: run.go_round,
          judge_position: chair,
          rider_score: markedOut ? null : rider_score,
          animal_score: markedOut ? null : animal_score,
          marked_out: markedOut,
          signed: Boolean(signed),
        });
        ride.style.borderColor = 'var(--ok)';
        animal.style.borderColor = 'var(--ok)';
        toast(`${run.contestant_name} — chair ${chair} in`);
        // Refresh so the combined total and the other chair's status update.
        await draw();
      } catch (err) {
        ride.style.borderColor = 'var(--stop)';
        toast(err.message, true);
      }
    }

    render(
      h('div', {},
        h('h1', {}, 'Judge cards'),
        h('p', { class: 'muted' },
          'One judge, one chair. Type the ride and the animal, press Enter, it '
          + 'saves signed and moves down. The run total shows only once both '
          + 'chairs are in.'),
        controls(),
        sections.length
          ? sections
          : h('div', { class: 'card' },
              h('p', { class: 'muted' },
                'No judged events drawn yet. Judge cards cover riding events — '
                + 'broncs, bulls and bareback.')),
      ),
    );
  }

  function controls() {
    const chairSelect = h('select', {
      'aria-label': 'Which chair you are keying',
      onchange: (e) => {
        chair = Number(e.target.value);
        localStorage.setItem('rodeo.judge.chair', String(chair));
        draw();
      },
    },
    ...[1, 2, 3, 4].map((n) =>
      h('option', { value: n, selected: n === chair ? '' : null }, `Chair ${n}`)));

    const requiredSelect = h('select', {
      'aria-label': 'Chairs this event needs',
      onchange: (e) => {
        requiredJudges = Number(e.target.value);
        localStorage.setItem('rodeo.judge.required', String(requiredJudges));
        draw();
      },
    },
    ...[1, 2, 3, 4].map((n) =>
      h('option', { value: n, selected: n === requiredJudges ? '' : null },
        `${n} judge${n > 1 ? 's' : ''}`)));

    return h('div', { class: 'card' },
      h('div', { class: 'actions' },
        h('label', { class: 'hint' }, 'You are keying: ', chairSelect),
        h('label', { class: 'hint' }, 'Chairs required: ', requiredSelect),
      ),
    );
  }

  function statusCell(combined, chairKeying) {
    if (!combined) return h('span', { class: 'muted small' }, '—');
    if (combined.is_no_score) {
      return h('span', { class: 'pill stop' }, 'No score');
    }
    if (combined.complete) {
      return h('span', {},
        h('span', { class: 'num' }, String(combined.final_score)),
        combined.reride ? h('span', { class: 'pill stop' }, ' reride') : null);
    }
    const missing = combined.missing_positions
      .map((p) => `chair ${p}`)
      .join(', ');
    return h('span', { class: 'muted small' },
      `${combined.signed_count}/${combined.required_judges} in`,
      missing ? h('span', { class: 'muted small' }, ` — need ${missing}`) : null);
  }

  showPrint(() => window.print());
  await draw();
}
