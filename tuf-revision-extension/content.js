(() => {
  'use strict';
  if (window.__tufRevisionLoaded) return;
  window.__tufRevisionLoaded = true;

  // ---------- Config ----------
  const SHEET_SLUG = 'strivers-a2z-dsa-sheet';
  const SHEET_PATH = '/prep-hub/' + SHEET_SLUG;
  const SITE = 'https://takeuforward.org';
  const API = 'https://backend-go.takeuforward.org/api';
  const SHEET_URL = API + '/v2/syllabus/sheet/' + SHEET_SLUG;
  const NOTES_URL = (id) => API + '/v3/plus/problem/notes/' + encodeURIComponent(id);
  const STORE_KEY = 'tufRevision';
  const DAILY_MIN = 1;
  const DAILY_MAX = 20;
  const DEFAULT_DAILY = 5;
  const RESET_WORD = 'RESET';
  const PANEL_ID = 'trs-panel';
  const REFETCH_MIN_MS = 30 * 1000;

  // ---------- Runtime state ----------
  let state = null; // persisted in chrome.storage.local
  let pool = null; // solved practice problems (the revision pool)
  let byId = new Map(); // every practice problem by id
  let loading = false;
  let loadError = null;
  let lastFetch = 0;
  let panel = null;
  let flashMsg = '';
  let flashTimer = null;
  let syncTimer = null;
  let showMore = false; // footer "More" menu open
  let confirmingReset = false; // inline reset confirmation open
  let resetInput = ''; // what's typed in the reset confirmation box
  let focusAfterRender = null; // data-fk of the element to focus after the next render
  const notes = new Map(); // id -> { open, loading, html, error }

  // ---------- Storage ----------
  const storage = {
    get: () =>
      new Promise((resolve) =>
        chrome.storage.local.get(STORE_KEY, (r) => resolve((r && r[STORE_KEY]) || null))
      ),
    set: (value) =>
      new Promise((resolve) => chrome.storage.local.set({ [STORE_KEY]: value }, () => resolve())),
  };

  function freshState() {
    return {
      version: 1,
      spree: { number: 1, startedAt: new Date().toISOString(), revised: {} },
      today: null,
      history: [],
      ui: { collapsed: false },
      settings: { daily: DEFAULT_DAILY },
    };
  }

  function isValidState(s) {
    return (
      s &&
      typeof s === 'object' &&
      s.spree &&
      typeof s.spree === 'object' &&
      s.spree.revised &&
      typeof s.spree.revised === 'object' &&
      !Array.isArray(s.spree.revised)
    );
  }

  function normalize(s) {
    return {
      version: 1,
      spree: {
        number: Number(s.spree.number) || 1,
        startedAt: s.spree.startedAt || new Date().toISOString(),
        revised: { ...s.spree.revised },
      },
      today:
        s.today && typeof s.today.date === 'string' && Array.isArray(s.today.ids)
          ? { date: s.today.date, ids: s.today.ids.map(String) }
          : null,
      history: Array.isArray(s.history) ? s.history : [],
      ui: { collapsed: !!(s.ui && s.ui.collapsed) },
      settings: { daily: clampDaily(s.settings && s.settings.daily) },
    };
  }

  function clampDaily(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_DAILY;
    return Math.min(DAILY_MAX, Math.max(DAILY_MIN, v));
  }

  function dailyCount() {
    return (state && state.settings && state.settings.daily) || DEFAULT_DAILY;
  }

  async function ensureState() {
    if (state) return state;
    const saved = await storage.get();
    state = isValidState(saved) ? normalize(saved) : freshState();
    return state;
  }

  async function save() {
    await storage.set(state);
  }

  // ---------- Helpers ----------
  function localDate(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function prettyDate(d = new Date()) {
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function absUrl(u) {
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    return SITE + (u.startsWith('/') ? u : '/' + u);
  }

  function flash(msg) {
    flashMsg = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashMsg = '';
      render();
    }, 2500);
    render();
  }

  // ---------- Data from TUF ----------
  function toProblem(n, topic) {
    const r = n.redirectTo || {};
    return {
      id: String(n.id),
      title: n.label || n.slug || 'Untitled',
      topic, // used only for balancing picks, never shown
      difficulty: n.difficulty || '',
      solved: n.status === 'solved',
      hasNotes: !!n.notes,
      bookmarked: !!n.bookmark,
      tuf: `${SITE}/practice/${r.contentType || 'dsa'}/${r.itemSlug || n.slug}`,
      leetcode: n.leetcode_link || null,
      video: n.yt_video || null,
      article: absUrl(n.free_blog_link),
    };
  }

  function collect(node, topic, out) {
    if (!node) return;
    if (node.type === 'item') {
      if (node.item_type === 'practice') out.push(toProblem(node, topic));
      return;
    }
    for (const child of node.children || []) collect(child, topic, out);
  }

  async function loadPool(force) {
    if (loading) return;
    if (!force && pool && Date.now() - lastFetch < REFETCH_MIN_MS) {
      await ensureState();
      if (state.today && state.today.date !== localDate()) {
        reconcileToday();
        await save();
        render();
      }
      return;
    }
    loading = true;
    render();
    try {
      await ensureState();
      const res = await fetch(SHEET_URL, { credentials: 'include' });
      if (!res.ok) throw new Error('TUF returned HTTP ' + res.status);
      const json = await res.json();
      const items = [];
      for (const top of (json && json.data && json.data.syllabus) || []) {
        collect(top, String(top.label || '').trim(), items);
      }
      if (!items.length) throw new Error('The sheet came back empty');
      byId = new Map(items.map((p) => [p.id, p]));
      pool = items.filter((p) => p.solved);
      lastFetch = Date.now();
      loadError = null;
      reconcileToday();
      await save();
    } catch (e) {
      loadError = (e && e.message) || String(e);
    } finally {
      loading = false;
      render();
    }
  }

  // ---------- Picking ----------
  function remainingProblems(excludeIds = []) {
    const exclude = new Set(excludeIds);
    return pool.filter((p) => !state.spree.revised[p.id] && !exclude.has(p.id));
  }

  // Picks n unrevised problems, each from a different topic where possible.
  // Topics are drawn weighted by how many unrevised problems they still have,
  // so big topics don't all pile up at the end of the spree.
  function pickProblems(n, alreadyToday = []) {
    if (n <= 0) return [];
    const usedTopics = new Set(
      alreadyToday.map((id) => byId.get(id) && byId.get(id).topic).filter(Boolean)
    );
    const remaining = remainingProblems(alreadyToday);
    const byTopic = new Map();
    for (const p of remaining) {
      if (!byTopic.has(p.topic)) byTopic.set(p.topic, []);
      byTopic.get(p.topic).push(p);
    }
    const picks = [];
    const candidates = [...byTopic.keys()].filter((t) => !usedTopics.has(t));
    while (picks.length < n && candidates.length) {
      const weights = candidates.map((t) => byTopic.get(t).length);
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      let idx = 0;
      while (idx < weights.length - 1 && r >= weights[idx]) {
        r -= weights[idx];
        idx++;
      }
      const list = byTopic.get(candidates[idx]);
      picks.push(list[Math.floor(Math.random() * list.length)]);
      candidates.splice(idx, 1);
    }
    if (picks.length < n) {
      const chosen = new Set(picks.map((p) => p.id));
      const rest = shuffle(remaining.filter((p) => !chosen.has(p.id)));
      picks.push(...rest.slice(0, n - picks.length));
    }
    return shuffle(picks).map((p) => p.id);
  }

  function reconcileToday() {
    const today = localDate();
    const n = dailyCount();
    if (!state.today || state.today.date !== today) {
      state.today = { date: today, ids: pickProblems(n) };
      return;
    }
    // Same day: keep the list, but drop anything you've unticked on TUF,
    // then top up or trim to the current per-day count.
    const poolIds = new Set(pool.map((p) => p.id));
    const kept = state.today.ids.filter((id) => poolIds.has(id));
    state.today.ids = kept.length > n ? trimToday(kept, n) : kept.concat(pickProblems(n - kept.length, kept));
  }

  // Shrinks today's list by dropping unrevised problems from the end.
  // Problems you've already revised today always stay.
  function trimToday(ids, n) {
    const out = ids.slice();
    for (let i = out.length - 1; i >= 0 && out.length > n; i--) {
      if (!state.spree.revised[out[i]]) out.splice(i, 1);
    }
    return out;
  }

  // ---------- Actions ----------
  async function toggleRevised(id) {
    const revised = state.spree.revised;
    if (revised[id]) delete revised[id];
    else revised[id] = new Date().toISOString();
    await save();
    render();
  }

  async function setDaily(n) {
    const v = clampDaily(n);
    if (!state || state.settings.daily === v) return;
    state.settings.daily = v;
    if (pool) reconcileToday();
    await save();
    focusAfterRender = 'daily';
    render();
  }

  async function toggleCollapsed() {
    state.ui.collapsed = !state.ui.collapsed;
    await save();
    render();
  }

  async function startNewSpree() {
    const s = state.spree;
    state.history.push({
      number: s.number,
      startedAt: s.startedAt,
      endedAt: new Date().toISOString(),
      revisedCount: Object.keys(s.revised).length,
    });
    state.spree = { number: s.number + 1, startedAt: new Date().toISOString(), revised: {} };
    state.today = null;
    reconcileToday();
    await save();
    flash(`Spree #${state.spree.number} started`);
  }

  function openResetConfirm() {
    confirmingReset = true;
    resetInput = '';
    focusAfterRender = 'reset';
    render();
  }

  function closeResetConfirm() {
    confirmingReset = false;
    resetInput = '';
    render();
  }

  // Only runs after RESET has been typed. Downloads a backup first so it can be undone with Restore.
  async function resetSpree() {
    if (resetInput.trim() !== RESET_WORD) return;
    exportBackup(true);
    state.spree = { number: state.spree.number, startedAt: new Date().toISOString(), revised: {} };
    state.today = null;
    if (pool) reconcileToday();
    await save();
    confirmingReset = false;
    showMore = false;
    resetInput = '';
    flash('Spree reset. A backup was downloaded first.');
  }

  function exportBackup(quiet) {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tuf-revision-backup-${localDate()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (quiet !== true) flash('Backup downloaded');
  }

  function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        data = null;
      }
      if (!isValidState(data)) {
        alert("That file isn't a TUF Revision backup.");
        return;
      }
      const n = Object.keys(data.spree.revised).length;
      const ok = confirm(
        `Restore this backup? It has ${n} revised problem${n === 1 ? '' : 's'} in spree #${data.spree.number}. Your current progress will be replaced.`
      );
      if (!ok) return;
      state = normalize(data);
      if (pool) reconcileToday();
      await save();
      flash('Backup restored');
    });
    input.click();
  }

  async function toggleNotes(id) {
    const n = notes.get(id) || { open: false, loading: false, html: null, error: null };
    n.open = !n.open;
    notes.set(id, n);
    render();
    if (!n.open || n.loading || n.html != null) return;
    n.loading = true;
    n.error = null;
    render();
    try {
      const res = await fetch(NOTES_URL(id), { credentials: 'include' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      n.html = (json && json.data && json.data.note) || '';
    } catch {
      n.error = "Couldn't load your notes.";
    } finally {
      n.loading = false;
      render();
    }
  }

  // ---------- Notes sanitizing ----------
  const ALLOWED_TAGS = new Set(
    'P BR B STRONG I EM U S DEL CODE PRE UL OL LI H1 H2 H3 H4 H5 H6 BLOCKQUOTE A SPAN DIV IMG HR TABLE THEAD TBODY TR TD TH MARK SUB SUP'.split(
      ' '
    )
  );
  const DROP_TAGS = new Set('SCRIPT STYLE IFRAME OBJECT EMBED LINK META FORM INPUT BUTTON TEXTAREA SELECT SVG MATH'.split(' '));

  function sanitizeNote(html) {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    const clean = (node) => {
      for (const el of [...node.children]) {
        if (DROP_TAGS.has(el.tagName)) {
          el.remove();
          continue;
        }
        clean(el);
        if (!ALLOWED_TAGS.has(el.tagName)) {
          el.replaceWith(...el.childNodes);
          continue;
        }
        for (const attr of [...el.attributes]) {
          const name = attr.name.toLowerCase();
          const keep =
            (el.tagName === 'A' && name === 'href' && /^https?:\/\//i.test(attr.value)) ||
            (el.tagName === 'IMG' && name === 'src' && /^(https:\/\/|data:image\/)/i.test(attr.value)) ||
            (el.tagName === 'IMG' && name === 'alt');
          if (!keep) el.removeAttribute(attr.name);
        }
        if (el.tagName === 'A') {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      }
    };
    clean(doc.body);
    const frag = document.createDocumentFragment();
    frag.append(...doc.body.childNodes);
    return frag;
  }

  // ---------- DOM helpers ----------
  const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    code: '<path d="M8.5 8L4.5 12l4 4M15.5 8l4 4-4 4"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    play: '<circle cx="12" cy="12" r="9"/><path d="M10.2 8.6v6.8l5.6-3.4z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    bookmark: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4.5V9h-4.5"/>',
    shuffle: '<path d="M16 4h4v4M4 20L20 4M20 16v4h-4M15 15l5 5M4 4l5 5"/>',
  };

  function icon(name) {
    const span = document.createElement('span');
    span.className = 'trs-ico';
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
    return span;
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function linkChip(ic, label, href) {
    return h('a', { class: 'trs-chip', href, target: '_blank', rel: 'noopener noreferrer' }, icon(ic), label);
  }

  function detectTheme() {
    try {
      let node = (panel && panel.parentElement) || document.body;
      let bg = null;
      while (node) {
        const b = getComputedStyle(node).backgroundColor;
        if (b && b !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(b)) {
          bg = b;
          break;
        }
        node = node.parentElement;
      }
      if (!bg) return 'dark';
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  // ---------- Rendering ----------
  function problemCard(p, index) {
    const done = !!state.spree.revised[p.id];
    const n = notes.get(p.id);
    const open = !!(n && n.open);

    let notesBox = null;
    if (open) {
      let content;
      if (n.loading) content = h('p', { class: 'trs-muted' }, 'Loading notes…');
      else if (n.error)
        content = h('p', { class: 'trs-muted' }, n.error + ' ', h('a', { href: p.tuf, target: '_blank', rel: 'noopener noreferrer' }, 'Open on TUF'));
      else if (!n.html || !n.html.replace(/<[^>]*>/g, '').trim()) content = h('p', { class: 'trs-muted' }, 'This note is empty.');
      else content = sanitizeNote(n.html);
      notesBox = h('div', { class: 'trs-notes' }, content);
    }

    return h(
      'div',
      { class: 'trs-card' + (done ? ' trs-is-done' : '') },
      h(
        'div',
        { class: 'trs-card-top' },
        h(
          'div',
          { class: 'trs-title-wrap' },
          h('span', { class: 'trs-num' }, String(index + 1)),
          h('a', { class: 'trs-title', href: p.tuf, target: '_blank', rel: 'noopener noreferrer' }, p.title),
          p.difficulty ? h('span', { class: 'trs-diff trs-diff-' + p.difficulty.toLowerCase() }, p.difficulty) : null
        ),
        h(
          'button',
          {
            class: 'trs-revised' + (done ? ' trs-on' : ''),
            type: 'button',
            'aria-pressed': String(done),
            title: done ? 'Click to undo' : 'Mark as revised in this spree',
            onclick: () => toggleRevised(p.id),
          },
          icon('check'),
          done ? 'Revised' : 'Mark revised'
        )
      ),
      h(
        'div',
        { class: 'trs-links' },
        linkChip('code', 'TUF', p.tuf),
        p.leetcode ? linkChip('external', 'LeetCode', p.leetcode) : null,
        p.video ? linkChip('play', 'Video', p.video) : null,
        p.article ? linkChip('file', 'Editorial', p.article) : null,
        p.bookmarked ? h('span', { class: 'trs-chip trs-static', title: 'Bookmarked on TUF' }, icon('bookmark'), 'Saved') : null,
        p.hasNotes
          ? h(
              'button',
              { class: 'trs-chip', type: 'button', 'aria-expanded': String(open), onclick: () => toggleNotes(p.id) },
              icon('eye'),
              open ? 'Hide notes' : 'Show notes'
            )
          : h('span', { class: 'trs-faint' }, 'No notes')
      ),
      notesBox
    );
  }

  // Re-renders the whole panel, keeping keyboard focus on the slider / reset box if it was there.
  function render() {
    if (!panel) return;
    const active = document.activeElement;
    const key = focusAfterRender || (active && panel.contains(active) && active.dataset ? active.dataset.fk : null);
    focusAfterRender = null;
    renderPanel();
    if (key) {
      const el = panel.querySelector(`[data-fk="${key}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  function dailyControl() {
    const value = h('span', { class: 'trs-daily-value' }, String(dailyCount()));
    const slider = h('input', {
      class: 'trs-range',
      type: 'range',
      min: DAILY_MIN,
      max: DAILY_MAX,
      step: 1,
      value: dailyCount(),
      'data-fk': 'daily',
      'aria-label': 'Problems per day',
      oninput: (e) => {
        value.textContent = e.target.value;
      },
      onchange: (e) => setDaily(e.target.value),
    });
    return h(
      'div',
      { class: 'trs-daily' },
      h('span', { class: 'trs-daily-label' }, 'Problems per day'),
      slider,
      value
    );
  }

  function resetConfirmBox() {
    const count = Object.keys(state.spree.revised).length;
    const confirmBtn = h(
      'button',
      { class: 'trs-btn trs-danger', type: 'button', onclick: resetSpree },
      `Reset spree #${state.spree.number}`
    );
    confirmBtn.disabled = resetInput.trim() !== RESET_WORD;
    const input = h('input', {
      class: 'trs-input',
      type: 'text',
      placeholder: RESET_WORD,
      autocomplete: 'off',
      spellcheck: 'false',
      'data-fk': 'reset',
      'aria-label': `Type ${RESET_WORD} to confirm`,
      oninput: (e) => {
        resetInput = e.target.value;
        confirmBtn.disabled = resetInput.trim() !== RESET_WORD;
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && !confirmBtn.disabled) resetSpree();
        if (e.key === 'Escape') closeResetConfirm();
      },
    });
    input.value = resetInput;
    return h(
      'div',
      { class: 'trs-danger-box', role: 'alertdialog', 'aria-label': 'Confirm spree reset' },
      h('p', { class: 'trs-danger-title' }, `Reset spree #${state.spree.number}?`),
      h(
        'p',
        { class: 'trs-muted' },
        `This clears ${count} revised mark${count === 1 ? '' : 's'} and picks a new set for today. Your TUF ticks aren't touched, and a backup file is downloaded first.`
      ),
      h('p', { class: 'trs-muted' }, 'Type ', h('code', null, RESET_WORD), ' to confirm.'),
      h(
        'div',
        { class: 'trs-danger-row' },
        input,
        confirmBtn,
        h('button', { class: 'trs-btn', type: 'button', onclick: closeResetConfirm }, 'Cancel')
      )
    );
  }

  function renderPanel() {
    panel.dataset.theme = detectTheme();
    panel.replaceChildren();

    const collapsed = !!(state && state.ui.collapsed);
    const todayIds = (state && state.today && pool && state.today.ids) || [];
    const todayProblems = todayIds.map((id) => byId.get(id)).filter(Boolean);
    const doneToday = state ? todayProblems.filter((p) => state.spree.revised[p.id]).length : 0;

    // Header
    panel.append(
      h(
        'div',
        { class: 'trs-head' },
        h(
          'div',
          { class: 'trs-head-left' },
          h('span', { class: 'trs-h' }, "Today's revision"),
          h('span', { class: 'trs-faint' }, prettyDate())
        ),
        h(
          'div',
          { class: 'trs-head-right' },
          todayProblems.length ? h('span', { class: 'trs-muted' }, `${doneToday} / ${todayProblems.length} done`) : null,
          h(
            'button',
            {
              class: 'trs-icon-btn' + (collapsed ? ' trs-rot' : ''),
              type: 'button',
              'aria-label': collapsed ? 'Expand' : 'Collapse',
              title: collapsed ? 'Expand' : 'Collapse',
              onclick: () => state && toggleCollapsed(),
            },
            icon('chevron')
          )
        )
      )
    );

    // Spree progress bar
    if (state && pool && pool.length) {
      const revisedCount = pool.filter((p) => state.spree.revised[p.id]).length;
      const pct = Math.round((revisedCount / pool.length) * 100);
      panel.append(
        h(
          'div',
          { class: 'trs-progress' },
          h(
            'div',
            { class: 'trs-progress-label' },
            h('span', null, `Spree #${state.spree.number}`),
            h('span', null, `${revisedCount} / ${pool.length} revised · ${pct}%`)
          ),
          h('div', { class: 'trs-bar' }, h('div', { class: 'trs-bar-fill', style: `width:${pct}%` }))
        )
      );
    }

    if (collapsed) return;

    const body = h('div', { class: 'trs-body' });
    panel.append(body);

    if (!pool) {
      if (loadError) {
        body.append(
          h(
            'div',
            { class: 'trs-empty' },
            h('p', null, "Couldn't load your sheet from TUF. Make sure you're logged in."),
            h('p', { class: 'trs-faint' }, loadError),
            h('button', { class: 'trs-btn', type: 'button', onclick: () => loadPool(true) }, icon('refresh'), 'Retry')
          )
        );
      } else {
        body.append(h('div', { class: 'trs-empty' }, h('p', { class: 'trs-muted' }, 'Loading your solved problems…')));
      }
      return;
    }

    if (!pool.length) {
      body.append(
        h(
          'div',
          { class: 'trs-empty' },
          h('p', null, 'No solved problems found.'),
          h('p', { class: 'trs-muted' }, "Log in to TUF and tick the problems you've solved, then refresh.")
        )
      );
    } else if (remainingProblems().length === 0 && doneToday === todayProblems.length) {
      const days = Math.max(1, Math.round((Date.now() - new Date(state.spree.startedAt).getTime()) / 86400000));
      body.append(
        h(
          'div',
          { class: 'trs-empty trs-celebrate' },
          h('p', { class: 'trs-h' }, `Spree #${state.spree.number} complete`),
          h('p', { class: 'trs-muted' }, `You revised all ${pool.length} solved problems in ${days} day${days === 1 ? '' : 's'}.`),
          h('button', { class: 'trs-btn trs-primary', type: 'button', onclick: startNewSpree }, icon('shuffle'), `Start spree #${state.spree.number + 1}`)
        )
      );
    } else {
      body.append(dailyControl());
      todayProblems.forEach((p, i) => body.append(problemCard(p, i)));
      if (todayProblems.length && doneToday === todayProblems.length) {
        body.append(h('p', { class: 'trs-done-msg' }, `All done for today. Fresh ${dailyCount()} tomorrow.`));
      }
    }

    // Footer
    const synced = lastFetch ? new Date(lastFetch).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    body.append(
      h(
        'div',
        { class: 'trs-foot' },
        h(
          'div',
          { class: 'trs-foot-actions' },
          h('button', { class: 'trs-link-btn', type: 'button', onclick: () => loadPool(true), disabled: loading }, loading ? 'Syncing…' : 'Sync with TUF'),
          h('button', { class: 'trs-link-btn', type: 'button', onclick: exportBackup }, 'Backup'),
          h('button', { class: 'trs-link-btn', type: 'button', onclick: importBackup }, 'Restore'),
          h(
            'button',
            {
              class: 'trs-link-btn',
              type: 'button',
              'aria-expanded': String(showMore),
              onclick: () => {
                showMore = !showMore;
                if (!showMore) confirmingReset = false;
                render();
              },
            },
            showMore ? 'Less' : 'More'
          ),
          showMore && !confirmingReset
            ? h('button', { class: 'trs-link-btn trs-danger-link', type: 'button', onclick: openResetConfirm }, 'Reset spree…')
            : null
        ),
        h('span', { class: 'trs-faint' }, flashMsg || (synced ? `Synced ${synced}` : ''))
      )
    );
    if (showMore && confirmingReset) body.append(resetConfirmBox());
  }

  // ---------- Mounting (TUF is a single-page app) ----------
  function onSheetPage() {
    return location.hostname === 'takeuforward.org' && location.pathname.replace(/\/+$/, '') === SHEET_PATH;
  }

  // Returns the element the panel is inserted in front of.
  // Desktop layout: just above the search/filter bar. Mobile layout: just above the topic list.
  function findAnchor() {
    const main = document.querySelector('[data-sheet-id] [class*="__mainSection"]');
    if (!main) return null;
    const bar = main.querySelector(':scope > [class*="__actionBarWrap"]');
    if (bar) return bar;
    const tree = main.querySelector('[class*="__syllabusTree"], [class*="sheet-tree-module"][class*="__tree"]');
    if (!tree) return null;
    let child = tree;
    while (child.parentElement && child.parentElement !== main) child = child.parentElement;
    return child.parentElement === main ? child : null;
  }

  let started = false;
  function tick() {
    if (!onSheetPage()) {
      if (panel && panel.isConnected) panel.remove();
      return;
    }
    const anchor = findAnchor();
    if (!anchor || !anchor.parentElement) return;
    if (!panel) {
      panel = h('section', { id: PANEL_ID, 'aria-label': "Today's revision" });
      // Keep typing/arrow keys inside the panel from triggering TUF's own keyboard shortcuts.
      panel.addEventListener('keydown', (e) => e.stopPropagation());
    }
    if (!panel.isConnected || panel.nextElementSibling !== anchor) {
      anchor.parentElement.insertBefore(panel, anchor);
      render();
    }
    if (!started) {
      started = true;
      ensureState().then(() => loadPool(true));
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      tick();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();

  // Re-sync shortly after you tick/untick a problem on the sheet, so it joins/leaves the pool.
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button[aria-checked][aria-label^="Mark "]');
      if (!btn || (panel && panel.contains(btn))) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => loadPool(true), 2000);
    },
    true
  );

  // Coming back to the tab: re-sync (throttled) and roll over to a new day if needed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && panel && panel.isConnected) loadPool(false);
  });
  setInterval(() => {
    if (panel && panel.isConnected && state && state.today && state.today.date !== localDate()) loadPool(true);
  }, 5 * 60 * 1000);

  // Keep multiple open sheet tabs in sync.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORE_KEY]) return;
    const next = changes[STORE_KEY].newValue;
    if (!isValidState(next) || JSON.stringify(next) === JSON.stringify(state)) return;
    state = normalize(next);
    render();
  });
})();
