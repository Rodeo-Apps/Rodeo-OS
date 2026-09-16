/**
 * Form L — Ground rules.
 *
 * The one page posted with the draw: sanction, added money by event, the run of
 * performances and slack, walk-up / replacement policy, local events, special
 * rules, and who to call on the committee. Posting stamps the time so "it was
 * never posted" has an answer.
 */

import { api } from '../api.js';
import { crumbs, h, render, showPrint, toast } from '../ui.js';

export async function groundRulesView(rodeoId) {
  showPrint(() => window.print());
  const rodeo = await api.rodeo(rodeoId);
  crumbs(
    { label: 'Rodeos', href: '#/' },
    { label: rodeo.name, href: `#/rodeo/${rodeoId}` },
    { label: 'Ground rules' },
  );

  let gr = null;

  async function load() {
    gr = await api.groundRules(rodeoId).catch(() => null);
    draw();
  }

  function val(key) {
    return gr && gr[key] != null ? gr[key] : '';
  }

  async function save(post) {
    const g = (name) => {
      const el = document.querySelector(`[name="${name}"]`);
      if (!el) return undefined;
      if (el.type === 'checkbox') return el.checked;
      return el.value.trim() || null;
    };
    const body = {
      city_state: g('city_state'),
      sanction: g('sanction'),
      added_money_by_event: g('added_money_by_event'),
      performances_note: g('performances_note'),
      slack_note: g('slack_note'),
      walkup_replacement: g('walkup_replacement'),
      local_events: g('local_events'),
      special_rules: g('special_rules'),
      committee_contact: g('committee_contact'),
      post: post === true,
    };
    try {
      await api.saveGroundRules(rodeoId, body);
      toast(post ? 'Posted.' : 'Saved.');
      await load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function line(label, name, hint) {
    return h('label', { style: 'display:block;margin-top:8px' }, label,
      hint ? h('span', { class: 'hint' }, hint) : null,
      h('input', { name, value: val(name), style: 'width:100%' }));
  }
  function area(label, name) {
    return h('label', { style: 'display:block;margin-top:8px' }, label,
      h('textarea', { name, rows: '3', style: 'width:100%' }, val(name)));
  }

  function draw() {
    const posted = gr?.posted_at;
    render(h('div', {},
      h('h1', {}, 'Ground rules'),
      h('p', { class: 'muted' },
        posted
          ? `Posted ${new Date(posted).toLocaleString()}. Re-save and post again to update.`
          : 'Fill in, then post with the draw.'),

      h('section', { class: 'card' },
        h('div', { class: 'actions', style: 'gap:12px;flex-wrap:wrap' },
          h('label', {}, 'City / state',
            h('input', { name: 'city_state', value: val('city_state'), style: 'width:200px' })),
          h('label', {}, 'Sanction',
            h('input', { name: 'sanction', value: val('sanction'), style: 'width:160px' })),
          h('label', {}, 'Committee contact',
            h('input', { name: 'committee_contact', value: val('committee_contact'), style: 'width:240px' })),
        ),
        area('Added money by event', 'added_money_by_event'),
        line('Performances', 'performances_note', 'how many, and when'),
        line('Slack', 'slack_note'),
        h('label', { class: 'check', style: 'display:block;margin-top:8px' },
          h('input', {
            type: 'checkbox', name: 'walkup_replacement',
            checked: gr?.walkup_replacement ? true : null,
          }), ' Walk-up / replacement allowed'),
        area('Local events', 'local_events'),
        area('Special rules', 'special_rules'),
      ),

      h('div', { class: 'actions', style: 'gap:10px' },
        h('button', { class: 'ghost', onclick: () => save(false) }, 'Save'),
        h('button', { onclick: () => save(true) }, 'Post'),
        posted ? h('span', { class: 'pill ok' }, 'Posted') : null,
      ),
    ));
  }

  await load();
}
