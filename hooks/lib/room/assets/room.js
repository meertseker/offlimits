// offlimits control room page. Builds DOM with textContent only; polls /api/state; two confirmed writes.
'use strict';
(() => {
  const app = document.getElementById('app');
  const DAY = 86_400_000;
  const STAGE_NAMES = ['briefed', 'designing', 'awaiting-approval', 'building', 'delivered', 'merged'];
  const POLL_MS = 20_000;

  const store = {
    get(k, d) {
      try {
        const v = window.localStorage.getItem(`offlimits-room:${k}`);
        return v === null ? d : v;
      } catch { return d; }
    },
    set(k, v) {
      try { window.localStorage.setItem(`offlimits-room:${k}`, v); } catch { /* storage blocked: keep going */ }
    },
  };

  const ui = { data: null, tab: store.get('tab', 'board'), open: null, confirm: null, flash: null, status: 'loading', busy: false, theme: store.get('theme', '') };
  let S = {};

  const t = (k, vars) => String(Object.prototype.hasOwnProperty.call(S, k) ? S[k] : k)
    .replace(/\{(\w+)\}/g, (_, n) => (vars && vars[n] !== undefined && vars[n] !== null ? String(vars[n]) : ''));

  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = String(v);
        // CSSOM, not a style attribute: the page's CSP has no 'unsafe-inline'
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'href') {
          if (/^https?:\/\//i.test(String(v))) {
            node.setAttribute('href', String(v));
            node.setAttribute('rel', 'noopener noreferrer');
            node.setAttribute('target', '_blank');
          }
        } else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
      }
    }
    for (const c of kids.flat(Infinity)) {
      if (c === null || c === undefined || c === false || c === '') continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  // ---------- time and numbers ----------
  const nowRef = () => (ui.data ? Date.parse(ui.data.generatedAt) : Date.now());
  function ago(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
    const m = Math.max(0, Math.round(ms / 60_000));
    if (m < 1) return t('ago.now');
    if (m < 60) return t('ago.minutes', { n: m });
    const hr = Math.round(m / 60);
    if (hr < 48) return t('ago.hours', { n: hr });
    return t('ago.days', { n: Math.round(hr / 24) });
  }
  const agoTs = (ts) => {
    const v = typeof ts === 'number' ? ts : Date.parse(ts);
    return Number.isFinite(v) ? ago(nowRef() - v) : '';
  };
  const locale = () => (ui.data && ui.data.lang === 'tr' ? 'tr-TR' : 'en-GB');
  function clock(ts) {
    const v = typeof ts === 'number' ? ts : Date.parse(ts);
    if (!Number.isFinite(v)) return '';
    return new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(new Date(v));
  }
  function pct(x) {
    const n = Math.round(x * 100);
    return ui.data && ui.data.lang === 'tr' ? `%${n}` : `${n}%`;
  }
  const short = (sha) => (sha ? String(sha).slice(0, 8) : '');
  const projectName = (id) => {
    const p = ui.data && ui.data.projects.find((x) => x.id === id);
    return p ? p.name : id || '';
  };

  // ---------- data ----------
  async function load(manual) {
    if (ui.busy) return;
    if (!manual && ui.confirm) return;
    ui.busy = true;
    try {
      const r = await fetch('/api/state', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      if (r.status === 401) ui.status = 'expired';
      else if (!r.ok) ui.status = 'offline';
      else {
        ui.data = await r.json();
        S = ui.data.strings || {};
        ui.status = 'ok';
        document.documentElement.lang = ui.data.lang || 'en';
        document.title = t('title');
      }
    } catch {
      ui.status = 'offline';
    } finally {
      ui.busy = false;
      render();
    }
  }

  async function post(path, body) {
    try {
      const r = await fetch(path, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Offlimits-Room': '1' },
        body: JSON.stringify(body),
      });
      if (r.status === 401) {
        ui.status = 'expired';
        return { error: 'signed-out', message: t('expired') };
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || String(r.status), message: j.message || '', data: j.data };
      return j;
    } catch {
      return { error: 'offline', message: t('offline') };
    }
  }

  // ---------- theme ----------
  function isDark() {
    if (ui.theme === 'dark') return true;
    if (ui.theme === 'light') return false;
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
  }
  function applyTheme() {
    if (ui.theme === 'light' || ui.theme === 'dark') document.documentElement.dataset.theme = ui.theme;
    else delete document.documentElement.dataset.theme;
  }
  function toggleTheme() {
    ui.theme = isDark() ? 'light' : 'dark';
    store.set('theme', ui.theme);
    applyTheme();
    render();
  }

  // ---------- render ----------
  function render() {
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.k : null;
    app.replaceChildren(view());
    if (focused) {
      const again = [...app.querySelectorAll('[data-k]')].find((n) => n.dataset.k === focused);
      if (again) again.focus({ preventScroll: true });
    }
  }

  function view() {
    if (!ui.data) {
      const msg = ui.status === 'expired'
        ? 'This page is not signed in. Open the control room again from its shortcut, or run team room. / Bu sayfanın girişi bitti; kumandayı kısayoldan yeniden aç.'
        : ui.status === 'offline'
          ? 'The control room is not answering. / Kumanda cevap vermiyor.'
          : '…';
      return h('p', { class: 'loading', role: 'status' }, msg);
    }
    const d = ui.data;
    let panel;
    if (ui.tab === 'today') panel = today(d);
    else if (ui.tab === 'metrics') panel = metrics(d);
    else panel = board(d);
    return h('div', { class: 'wrap' },
      header(d),
      ui.status === 'expired' ? h('p', { class: 'banner', role: 'alert' }, t('expired')) : null,
      ui.status === 'offline' ? h('p', { class: 'banner', role: 'alert' }, t('offline')) : null,
      tabs(),
      h('div', { class: 'cols' }, needs(d), h('main', { class: 'main', id: 'panel', role: 'tabpanel', 'aria-labelledby': `tab-${ui.tab}` }, panel)),
      footer());
  }

  function header(d) {
    const s = d.summary;
    const status = [h('span', null, h('i', { class: s.waiting ? 'dot bekle' : 'dot canli', 'aria-hidden': 'true' }), t('sessions.live', { working: s.working, waiting: s.waiting }))];
    const ln = d.claude && d.claude.limitNotice;
    status.push(ln
      ? h('span', null, h('i', { class: 'dot bekle', 'aria-hidden': 'true' }), t('limit.last', { ago: agoTs(ln.ts), text: ln.text }))
      : h('span', null, h('i', { class: 'dot canli', 'aria-hidden': 'true' }), t('limit.none')));
    for (const p of d.projects) {
      for (const lg of p.logs || []) {
        if (lg.error) continue;
        const bad = lg.errorsSinceOk > 0;
        status.push(h('span', null, h('i', { class: bad ? 'dot bekle' : 'dot canli', 'aria-hidden': 'true' }),
          `${lg.name}: `, lg.lastOk ? t('log.ok', { ago: agoTs(lg.lastOk.ts || lg.mtime) }) : t('log.noOk'), bad ? `, ${t('log.errors', { count: lg.errorsSinceOk })}` : ''));
      }
    }
    return h('header', { class: 'top' },
      h('div', { class: 'top-left' },
        h('h1', null, t('title')),
        h('p', null, t('summary', { lanes: s.lanes, projects: s.projects, approvals: s.approvals, waiting: s.waiting }))),
      h('div', { class: 'top-right' },
        h('div', { class: 'status' }, status),
        h('div', { class: 'tools' },
          h('span', { class: 'meta' }, t('updated', { time: clock(d.generatedAt) })),
          h('button', { type: 'button', class: 'btn small', 'data-k': 'refresh', onclick: () => load(true) }, t('refresh')),
          h('button', { type: 'button', class: 'btn small', 'data-k': 'theme', 'aria-pressed': String(isDark()), onclick: toggleTheme }, `${t('theme')}: ${isDark() ? t('theme.dark') : t('theme.light')}`))));
  }

  function tabs() {
    const tab = (id, label) => h('button', {
      type: 'button', role: 'tab', class: 'tab', id: `tab-${id}`, 'aria-selected': String(ui.tab === id), 'aria-controls': 'panel', 'data-k': `tab-${id}`,
      onclick: () => { ui.tab = id; store.set('tab', id); render(); },
    }, label);
    return h('nav', { class: 'tabs', 'aria-label': t('title') },
      h('div', { class: 'tablist', role: 'tablist' }, tab('board', t('tab.board')), tab('today', t('tab.today')), tab('metrics', t('tab.metrics'))));
  }

  // ---------- markdown blocks ----------
  function inline(list) {
    return (list || []).map((i) => {
      if (i.t === 'code') return h('code', null, i.v);
      if (i.t === 'strong') return h('strong', null, i.v);
      if (i.t === 'link') return h('a', { href: i.href }, i.v);
      return i.v;
    });
  }
  function blocks(list) {
    return h('div', { class: 'md' }, (list || []).map((b) => {
      if (b.kind === 'table') {
        return h('div', { class: 'tablebox' }, h('table', null,
          h('thead', null, h('tr', null, b.header.map((c) => h('th', { scope: 'col' }, inline(c))))),
          h('tbody', null, b.rows.map((r) => h('tr', null, r.map((c) => h('td', null, inline(c))))))));
      }
      if (b.kind === 'list') return h(b.ordered ? 'ol' : 'ul', null, b.items.map((it) => h('li', null, inline(it))));
      if (b.kind === 'code') return h('pre', null, b.text);
      return h('p', null, inline(b.inline));
    }));
  }

  // ---------- needs you ----------
  function needs(d) {
    const n = d.needsYou;
    const parts = [h('h2', null, t('needs.title')), h('p', { class: `flash${ui.flash && !ui.flash.ok ? ' bad' : ''}`, role: 'status', 'aria-live': 'polite' }, ui.flash ? ui.flash.text : '')];
    let any = false;
    if (n.approvals.length) {
      any = true;
      parts.push(h('section', null, h('h3', null, t('approvals.title')), n.approvals.map(approvalCard)));
    }
    if (n.sessions.length) {
      any = true;
      parts.push(h('section', null, h('h3', null, t('sessions.title')), h('ul', { class: 'list' }, n.sessions.map((s) => sessionItem(s, true)))));
    }
    if (n.questions.length) {
      any = true;
      parts.push(h('section', null, h('h3', null, t('questions.title')),
        h('ul', { class: 'list' }, n.questions.map((q) => h('li', null, h('span', { class: 'who' }, `${projectName(q.project)}, ${t('role.lane', { lane: q.lane })}`), q.text, h('span', { class: 'meta' }, agoTs(q.ts)))))));
    }
    if (n.loops.length) {
      any = true;
      parts.push(h('section', null, h('h3', null, t('loops.title')),
        h('ul', { class: 'list' }, n.loops.map((l) => h('li', null, h('span', null, h('i', { class: 'dot sorun', 'aria-hidden': 'true' }), l.error ? `${l.name}: ${l.error}` : t('loop.odd', { name: l.name })))))));
    }
    for (const dec of n.decisions) {
      any = true;
      parts.push(h('section', null,
        h('details', null,
          h('summary', null, `${t('decisions.title', { ledger: dec.ledger })}, ${projectName(dec.project)}`),
          h('p', { class: 'meta' }, t('decisions.readonly')),
          blocks(dec.blocks))));
    }
    if (!any) parts.push(h('p', { class: 'meta' }, t('needs.empty')));
    return h('aside', { class: 'needs', 'aria-label': t('needs.title') }, parts);
  }

  function approvalCard(a) {
    const conf = ui.confirm && ui.confirm.kind === 'answer' && ui.confirm.project === a.project && ui.confirm.id === a.id ? ui.confirm : null;
    const facts = [
      a.from ? t('approval.from', { from: a.from }) : null,
      t('approval.age', { ago: ago(a.ageMs) }),
      a.reversible ? `${t('approval.reversible')}: ${a.reversible}` : null,
      a.due && !/^(yok|none|-)$/i.test(a.due) ? `${t('approval.due')}: ${a.due}` : null,
    ].filter(Boolean);
    return h('article', { class: 'card' },
      h('div', { class: 'card-top' }, h('span', null, projectName(a.project)), h('span', { class: 'mono' }, a.id)),
      h('p', { class: 'card-title' }, a.title || a.id),
      a.impact ? h('p', { class: 'meta' }, `${t('approval.impact')}: ${a.impact}`) : null,
      h('div', { class: 'facts' }, facts.map((f) => h('span', null, f))),
      a.ageMs > DAY ? h('p', { class: 'warn' }, t('approval.old')) : null,
      a.options.length
        ? h('div', { class: 'opts' }, a.options.map((o) => h('button', {
          type: 'button', class: 'opt', 'data-k': `opt:${a.project}:${a.id}:${o.key}`, 'aria-pressed': String(Boolean(conf && conf.option === o.key)),
          onclick: () => { ui.confirm = { kind: 'answer', project: a.project, id: a.id, option: o.key, text: o.text }; render(); focusConfirm(); },
        }, h('strong', null, o.key), o.text)))
        : h('p', { class: 'meta' }, t('approval.noOptions')),
      conf ? confirmBox(t('approval.confirm', { option: conf.option, text: conf.text }), t('approval.send'), true, () => sendAnswer(conf)) : null);
  }

  function confirmBox(question, okLabel, withNote, onOk) {
    return h('div', { class: 'confirm', role: 'group', 'aria-label': question },
      h('p', null, question),
      withNote ? [h('label', { for: 'confirm-note' }, t('approval.note')), h('input', { id: 'confirm-note', type: 'text', maxlength: '300', autocomplete: 'off', 'data-k': 'confirm-note' })] : null,
      h('div', { class: 'tools' },
        h('button', { type: 'button', class: 'btn primary', 'data-k': 'confirm-ok', onclick: onOk }, okLabel),
        h('button', { type: 'button', class: 'btn', 'data-k': 'confirm-cancel', onclick: () => { ui.confirm = null; render(); } }, t('approval.cancel'))));
  }

  function focusConfirm() {
    const n = document.getElementById('confirm-note') || [...app.querySelectorAll('[data-k="confirm-ok"]')][0];
    if (n) n.focus();
  }

  async function sendAnswer(c) {
    const input = document.getElementById('confirm-note');
    const note = input ? input.value : '';
    const res = await post('/api/answer', { project: c.project, id: c.id, option: c.option, note });
    if (res && !res.error) ui.flash = { ok: true, text: t('approval.done', { file: res.file || c.id }) };
    else if (res && res.error === 'already-answered') ui.flash = { ok: false, text: t('approval.conflict', { answer: (res.data && res.data.answer) || '' }) };
    else ui.flash = { ok: false, text: t('source.error', { error: (res && (res.message || res.error)) || '' }) };
    ui.confirm = null;
    await load(true);
  }

  function sessionText(s) {
    if (s.state === 'waiting') return t('session.waiting', { ago: ago(s.ageMs) });
    if (s.state === 'working') return s.stalled ? t('session.stalled', { ago: ago(s.ageMs) }) : t('session.working', { ago: ago(s.ageMs) });
    return t('session.quiet', { ago: ago(s.ageMs) });
  }
  const sessionDot = (s) => (s.state === 'waiting' ? 'dot bekle' : s.state === 'working' ? (s.stalled ? 'dot sorun' : 'dot canli') : 'dot soluk');

  function sessionItem(s, withProject) {
    const role = t(`role.${s.role}`, { lane: s.lane });
    return h('li', null,
      h('span', { class: 'who' }, h('i', { class: sessionDot(s), 'aria-hidden': 'true' }), withProject ? `${projectName(s.project)}, ${role}` : role, s.title ? `: ${s.title}` : ''),
      s.summary || s.lastPrompt ? h('span', null, s.summary || s.lastPrompt) : null,
      h('span', { class: 'meta' }, sessionText(s), s.model ? `, ${s.model.replace(/^claude-/, '')}` : '', h('span', { class: 'mono' }, ` ${s.shortId}`)));
  }

  // ---------- board ----------
  function board(d) {
    const out = [];
    if (d.problems.length) {
      out.push(h('details', { class: 'kutu' },
        h('summary', null, `${t('problems.title')} (${d.problems.length})`),
        h('ul', { class: 'list' }, d.problems.map((p) => h('li', { class: 'mono' }, p)))));
    }
    for (const p of d.projects) out.push(project(p));
    return out;
  }

  function project(p) {
    const parts = [];
    const head = [h('h2', null, p.name)];
    for (const f of p.facts) head.push(h('span', { class: 'meta' }, `${f.label}: `, h('span', { class: 'mono' }, f.value === null || f.value === undefined ? '?' : f.value)));
    if (p.coordinator.current) {
      const s = p.coordinator.session;
      head.push(h('span', { class: 'meta' }, h('i', { class: s ? sessionDot(s) : 'dot soluk', 'aria-hidden': 'true' }),
        `${t('project.coordinator')}: `, s ? `${s.title || s.shortId}, ${sessionText(s)}` : t('project.coordinatorNone')));
    }
    parts.push(h('div', { class: 'project-head' }, head));
    for (const r of p.repos) parts.push(repo(p, r));
    const loops = p.loops.filter((l) => !p.repos.some((r) => r.lanes.some((ln) => !ln.main && insideDir(l.dir, ln.path))));
    const boxes = [...loops.map((l) => loopBox(p, l)), ...p.inbox.map(inboxBox), ...p.logs.map(logBox)];
    if (boxes.length) parts.push(h('div', { class: 'boxes' }, boxes));
    for (const g of p.ledgers) {
      if (g.error) parts.push(h('p', { class: 'error' }, t('source.error', { error: g.error })));
      for (const s of g.sections) parts.push(h('details', null, h('summary', null, `${s.title}, ${g.name}`), blocks(s.blocks)));
    }
    return h('section', { class: 'project', 'aria-label': p.name }, parts);
  }

  const norm = (x) => String(x || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const insideDir = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(`${norm(parent)}/`);

  function repo(p, r) {
    const parts = [];
    const multi = p.repos.length > 1;
    if (r.error) return h('div', null, multi ? h('h3', null, r.name) : null, h('p', { class: 'error' }, t('source.error', { error: r.error })));
    const meta = [];
    if (r.baseHead) meta.push(h('span', { class: 'meta' }, t('project.base', { base: r.base, sha: short(r.baseHead.sha), ago: agoTs(r.baseHead.ts) })));
    if (r.base) meta.push(h('span', { class: 'meta' }, t('project.today', { count: r.todayCommits.length, base: r.base })));
    parts.push(h('div', { class: 'row' }, multi ? h('h3', null, r.name) : null, meta));
    parts.push(h('div', { class: 'legend', 'aria-hidden': 'true' }, `${t('col.stage')}:`, STAGE_NAMES.map((s) => h('span', null, t(`stage.${s}`)))));
    const order = { main: 0, building: 1, delivered: 1, stale: 2, merged: 3, missing: 3 };
    const lanes = [...r.lanes].sort((a, b) => (order[a.state] ?? 1) - (order[b.state] ?? 1));
    const rows = [h('div', { class: 'lane-head', 'aria-hidden': 'true' },
      h('span', null, t('col.lane')), h('span', { class: 'h-branch' }, t('col.branch')), h('span', { class: 'h-trace' }, t('col.stage')),
      h('span', null, t('col.status')), h('span', { class: 'h-act' }, t('col.activity')))];
    for (const l of lanes) {
      const key = `${p.id}:${r.name}:${l.id}`;
      rows.push(laneRow(key, l));
      if (ui.open === key) rows.push(laneDetail(p, l));
    }
    parts.push(h('div', { class: 'lanes' }, rows));
    return h('div', { class: 'project' }, parts);
  }

  function stateDot(l) {
    if (l.state === 'main') return 'dot deniz';
    if (l.state === 'delivered') return 'dot bekle';
    if (l.state === 'merged') return 'dot canli';
    if (l.state === 'stale') return 'dot soluk';
    if (l.state === 'missing') return 'dot sorun';
    return 'dot deniz';
  }
  const stateText = (l) => (l.state === 'stale' ? t('state.stale', { days: l.quietDays }) : t(`state.${l.state}`));

  function trace(l) {
    if (!l.stage) return h('span', { class: 'trace' });
    const i = l.stage.index;
    const cls = `trace${l.stage.inferred ? ' inferred' : ''}${i < 0 ? ' off' : ''}`;
    return h('span', { class: cls, title: l.stage.inferred ? t('stage.inferred') : t(`stage.${l.stage.name}`) },
      STAGE_NAMES.map((_, k) => h('i', { class: `seg${k < i ? ' past' : k === i ? ' now' : ''}`, 'aria-hidden': 'true' })),
      h('span', { class: 'sr' }, t(`stage.${l.stage.name}`)));
  }

  function lastActivity(l) {
    const times = [];
    if (l.lastCommit) times.push(l.lastCommit.ts);
    for (const s of l.sessions || []) if (s.lastTs) times.push(Date.parse(s.lastTs));
    const best = times.filter(Number.isFinite).sort((a, b) => b - a)[0];
    return best ? agoTs(best) : '';
  }

  function laneRow(key, l) {
    const open = ui.open === key;
    const live = (l.sessions || []).some((s) => s.state !== 'quiet');
    const sub = l.main ? t('state.main') : l.team ? l.team.lane : l.ledger && l.ledger.status ? `${t('lane.ledger')}: ${l.ledger.status}` : '';
    return h('button', {
      type: 'button', class: 'lane', 'aria-expanded': String(open), 'data-k': `lane:${key}`,
      onclick: () => { ui.open = open ? null : key; render(); },
    },
    h('span', { class: 'c-name' }, h('strong', null, l.id), sub ? h('span', { class: 'sub' }, sub) : null),
    h('span', { class: 'c-branch mono' }, l.branch || 'HEAD', h('span', { class: 'sub mono' }, short(l.sha))),
    h('span', { class: 'c-trace' }, trace(l)),
    h('span', { class: 'c-state' }, h('i', { class: stateDot(l), 'aria-hidden': 'true' }), stateText(l), live ? h('span', { class: 'live' }, t('lane.live')) : null),
    h('span', { class: 'c-act' }, lastActivity(l)));
  }

  function laneDetail(p, l) {
    const grid = [];
    grid.push(h('div', null, h('span', { class: 'label' }, t('col.branch')), h('span', { class: 'mono' }, l.branch || 'HEAD'), ' ', h('span', { class: 'meta' }, t('lane.ahead', { ahead: l.ahead, behind: l.behind }))));
    grid.push(h('div', null, h('span', { class: 'label' }, t('lane.lastCommit')), l.lastCommit ? [h('span', { class: 'mono' }, short(l.lastCommit.sha)), ` ${l.lastCommit.subject}, ${agoTs(l.lastCommit.ts)}`] : '?'));
    grid.push(h('div', null, h('span', { class: 'label' }, t('col.status')), h('i', { class: stateDot(l), 'aria-hidden': 'true' }), stateText(l), ', ', l.dirty ? t('lane.dirty', { count: l.dirty }) : t('lane.clean')));
    if (l.ledger) {
      grid.push(h('div', null, h('span', { class: 'label' }, t('lane.ledger')),
        Object.entries(l.ledger.row).map(([k, v]) => h('span', { class: 'sub' }, `${k}: ${v}`))));
    }
    const parts = [h('div', { class: 'detail-grid' }, grid)];
    if (l.delivery) {
      parts.push(h('div', null, h('span', { class: 'label' }, t('lane.delivery'), `, ${agoTs(l.delivery.mtime)}`),
        l.delivery.checks.length ? h('div', { class: 'checks' }, `${t('checks')}:`, l.delivery.checks.map((c) => h('span', null, h('i', { class: c.ok ? 'dot canli' : 'dot sorun', 'aria-hidden': 'true' }), c.name, c.ok ? ' ✓' : ' ✗'))) : null,
        h('div', { class: 'detail-grid' }, l.delivery.fields.map(([k, v]) => h('div', null, h('span', { class: 'label' }, k), v)))));
    } else if (!l.main) parts.push(h('p', { class: 'meta' }, t('lane.noDelivery')));
    if ((l.sessions || []).length) {
      parts.push(h('div', null, h('span', { class: 'label' }, t('lane.sessions')), h('ul', { class: 'list' }, l.sessions.map((s) => sessionItem(s, false)))));
    }
    const loops = p.loops.filter((x) => insideDir(x.dir, l.path));
    for (const x of loops) parts.push(h('div', null, h('span', { class: 'label' }, t('lane.loop')), loopBox(p, x)));
    parts.push(h('div', { class: 'tools' }, h('button', { type: 'button', class: 'btn small', 'data-k': 'lane-close', onclick: () => { ui.open = null; render(); } }, t('lane.close'))));
    return h('section', { class: 'detail', 'aria-label': `${t('lane.details')}: ${l.id}` }, parts);
  }

  function loopBox(p, l) {
    const conf = ui.confirm && ui.confirm.kind === 'loop' && ui.confirm.project === p.id && ui.confirm.loop === l.id ? ui.confirm : null;
    const dotClass = l.paused ? 'dot durak' : l.running ? 'dot canli' : 'dot soluk';
    const parts = [h('h3', null, l.name),
      h('p', null, h('i', { class: dotClass, 'aria-hidden': 'true' }), t('loop.status', { status: l.status || '?' }))];
    if (l.tasks) {
      const segs = [];
      const total = Math.min(l.tasks.total, 80);
      for (let i = 0; i < total; i++) segs.push(h('span', { class: i < l.tasks.done ? 'on' : i < l.tasks.done + l.tasks.blocked ? 'blocked' : '' }));
      parts.push(h('p', { class: 'meta' }, t('loop.tasks', { done: l.tasks.done, total: l.tasks.total, blocked: l.tasks.blocked })), h('div', { class: 'bar', 'aria-hidden': 'true' }, segs));
      if (l.tasks.next) parts.push(h('p', { class: 'meta' }, t('loop.next', { task: `${l.tasks.next.id}${l.tasks.next.title ? ` ${l.tasks.next.title}` : ''}` })));
    }
    if (l.running === true) parts.push(h('p', { class: 'meta' }, t('loop.running', { ago: ago(l.logAgeMs) })));
    if (l.running === false) parts.push(h('p', { class: 'meta' }, t('loop.notRunning')));
    if (l.running === false && l.status === l.runValue && l.startHint) parts.push(h('p', { class: 'meta' }, t('loop.startHint', { hint: l.startHint })));
    if (l.markers.length) parts.push(h('p', { class: 'meta' }, t('loop.markers', { list: l.markers.map((m) => m.name).join(', ') })));
    if (l.logTail.length) parts.push(h('p', { class: 'tail' }, l.logTail.join('\n')));
    if (l.error) parts.push(h('p', { class: 'error' }, t('source.error', { error: l.error })));
    const action = l.paused || l.stopped ? 'resume' : 'pause';
    if (conf) {
      const q = conf.action === 'pause' ? t('loop.confirmPause', { name: l.name }) : t('loop.confirmResume', { name: l.name, value: l.runValue });
      parts.push(confirmBox(q, conf.action === 'pause' ? t('loop.pause') : t('loop.resume'), false, () => sendLoop(conf, l)));
    } else {
      parts.push(h('div', { class: 'tools' }, h('button', {
        type: 'button', class: 'btn small', 'data-k': `loop:${p.id}:${l.id}`,
        onclick: () => { ui.confirm = { kind: 'loop', project: p.id, loop: l.id, action }; render(); focusConfirm(); },
      }, action === 'pause' ? t('loop.pause') : t('loop.resume'))));
    }
    return h('div', { class: 'kutu' }, parts);
  }

  async function sendLoop(c, l) {
    const res = await post('/api/loop', { project: c.project, loop: c.loop, action: c.action });
    if (res && !res.error) ui.flash = { ok: true, text: t('loop.done', { name: l.name, status: res.status || '' }) };
    else ui.flash = { ok: false, text: t('source.error', { error: (res && (res.message || res.error)) || '' }) };
    ui.confirm = null;
    await load(true);
  }

  function inboxBox(b) {
    if (b.error) return h('div', { class: 'kutu' }, h('h3', null, b.name), h('p', { class: 'error' }, t('source.error', { error: b.error })));
    const newest = b.items[0];
    return h('div', { class: 'kutu' },
      h('h3', null, b.name),
      h('p', { class: 'meta' }, t('inbox.count', { count: b.total, ago: newest ? agoTs(newest.mtime) : '' })),
      b.items.slice(0, 3).map((it) => h('div', { class: 'feed-item' },
        h('span', { class: 'meta' }, agoTs(it.mtime), ' ', it.fields.filter(([k]) => /^(kanal|channel|tur|type|kind|hedef|target)$/i.test(k)).map(([, v]) => v).join(', ')),
        h('p', null, it.text || it.file))));
  }

  function logBox(lg) {
    if (lg.error) return h('div', { class: 'kutu' }, h('h3', null, lg.name), h('p', { class: 'error' }, t('source.error', { error: lg.error })));
    return h('div', { class: 'kutu' },
      h('h3', null, lg.name),
      h('p', null, h('i', { class: lg.errorsSinceOk ? 'dot bekle' : 'dot canli', 'aria-hidden': 'true' }),
        lg.lastOk ? t('log.ok', { ago: agoTs(lg.lastOk.ts || lg.mtime) }) : t('log.noOk'), lg.errorsSinceOk ? `, ${t('log.errors', { count: lg.errorsSinceOk })}` : ''),
      lg.lastError ? h('p', { class: 'tail' }, lg.lastError.line) : null);
  }

  // ---------- today ----------
  function today(d) {
    if (!d.today.length) return [h('h2', null, t('today.title')), h('p', { class: 'meta' }, t('today.empty'))];
    return [h('h2', null, t('today.title')),
      h('div', { class: 'timeline' }, d.today.map((e) => h('div', { class: 'event' },
        h('span', { class: 'mono' }, clock(e.ts)),
        h('span', { class: 'proj meta' }, projectName(e.project)),
        h('span', { class: 'tag' }, t(`kind.${e.kind}`)),
        h('span', null, e.text, e.sha ? h('span', { class: 'mono' }, ` ${e.sha}`) : null),
        h('span', { class: 'src' }, e.source || ''))))];
  }

  // ---------- metrics ----------
  function tile(label, value) {
    const none = value === null || value === undefined || value === '';
    return h('div', { class: 'tile' }, h('span', { class: `num${none ? ' none' : ''}` }, none ? t('metrics.noData') : value), h('span', { class: 'meta' }, label));
  }

  function metrics(d) {
    const m = d.metrics;
    const ev = m.events > 0;
    const tiles = [
      tile(t('m.lanesMerged7d'), ev ? m.lanesMerged7d : null),
      tile(t('m.firstPassGreen'), m.firstPassGreen ? `${pct(m.firstPassGreen.share)} (${t('unit.share', { n: Math.round(m.firstPassGreen.share * m.firstPassGreen.n), total: m.firstPassGreen.n })})` : null),
      tile(t('m.reviewFindings'), m.reviewFindings ? `${pct(m.reviewFindings.share)} (${t('unit.share', { n: Math.round(m.reviewFindings.share * m.reviewFindings.n), total: m.reviewFindings.n })})` : null),
      tile(t('m.briefToMerge'), m.briefToMerge ? `${t('unit.hours', { n: m.briefToMerge.medianH })}, ${t('unit.hours', { n: m.briefToMerge.p90H })}` : null),
      tile(t('m.approvalsAnswered7d'), m.approvalsAnswered7d),
      tile(t('m.answerTime'), m.answerTime ? t('unit.minutes', { n: m.answerTime.medianMin }) : null),
      tile(t('m.openLanes'), m.openLanes),
      tile(t('m.staleLanes'), m.staleLanes),
      tile(t('m.cleanupLanes'), m.cleanupLanes),
      tile(t('m.prompts7d'), m.prompts7d),
      tile(t('m.orchestration'), m.orchestration ? `${m.orchestration.thisWeek === null ? '?' : pct(m.orchestration.thisWeek)}, ${m.orchestration.lastWeek === null ? '?' : pct(m.orchestration.lastWeek)}` : null),
    ];
    const parts = [h('h2', null, t('metrics.title')), h('p', { class: 'meta' }, t('metrics.fromEvents')), h('div', { class: 'tiles' }, tiles)];
    const days = m.promptsPerDay || [];
    if (days.length) {
      const max = Math.max(1, ...days.map((x) => x.total));
      const top = days.reduce((a, b) => (b.total > a.total ? b : a), days[0]);
      parts.push(h('h3', null, t('chart.title')),
        h('div', { class: 'chart', role: 'img', 'aria-label': `${t('chart.title')}: ${days.map((x) => `${x.date} ${x.total}`).join(', ')}` },
          days.map((x, i) => h('div', { class: 'col', title: `${x.date}: ${x.total}` },
            x === top || i === days.length - 1 ? h('span', { class: 'v' }, x.total) : null,
            h('div', { class: 'b', style: { height: `${Math.round((x.total / max) * 100)}%` } })))),
        h('div', { class: 'chart-x', 'aria-hidden': 'true' }, days.map((x) => h('span', null, x.date.slice(8)))),
        h('details', null, h('summary', null, t('chart.table')),
          h('div', { class: 'tablebox' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('chart.date')), h('th', { scope: 'col' }, t('chart.prompts')))),
            h('tbody', null, days.map((x) => h('tr', null, h('td', null, x.date), h('td', null, x.total))))))));
    }
    return parts;
  }

  function footer() {
    return h('footer', { class: 'foot' }, h('span', null, t('footer.reads')), h('span', null, h('strong', null, t('footer.writes'))), h('span', null, t('footer.never')));
  }

  applyTheme();
  load(true);
  window.setInterval(() => { if (!document.hidden) load(false); }, POLL_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });
})();
