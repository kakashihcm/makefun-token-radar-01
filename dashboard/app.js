// Token Radar's plain dashboard, radar-2. It reads window.RADAR (written beside dashboard/
// by main.ts) and renders the ranked board, a filterable table, a per-protocol detail drawer
// with the model's own inputs and the protocol's farm plan, a top-10 strip and the category
// benchmarks the model is read off. No network: every byte it shows is in data.js.
(function () {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;
  const app = document.getElementById('board');
  const state = {
    q: '',
    category: 'all',
    chain: 'all',
    watchlistOnly: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  /** A dollar amount, shortened to $x.xxB / $x.xM / $xK once it grows past a thousand. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usdFormat.format(n);
  }

  /** A percent with an explicit sign, two decimals. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days, as years once it passes a year, or 'unknown'. */
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The model in one function: the page recomputes a row from the snapshot figures and checks
  // the number board.json carries, so the page's code and the board's data are visibly the
  // same arithmetic.
  function recomputeImplied(row, model) {
    const rawGrowth = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const growth = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const capped = Math.min(Math.max(age, 0), model.maturity_days);
    const maturity = model.maturity_floor + (capped / model.maturity_days) * model.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * row.benchmark * growthMult * maturity));
  }

  /** Build an element: `attrs` sets class/text/html/listeners/attributes, the rest are children. */
  function el(tag, attrs) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else if (value !== null && value !== undefined) node.setAttribute(key, value);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        child.forEach(function (c) {
          if (c) node.appendChild(c);
        });
      } else if (typeof child === 'string') node.appendChild(document.createTextNode(child));
      else node.appendChild(child);
    }
    return node;
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, chains, TVL
  // and age decide the action, the capital, the hold and every cost and time. No name is
  // special-cased.
  function primaryChain(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  function stakeSize(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdDays(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  /** One category rule: the keywords that pick it, and the action it writes. */
  const MAIN_ACTIONS = [
    {
      keys: ['lend', 'cdp', 'collateral'],
      write: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`,
    },
    {
      keys: ['dex', 'yield', 'leveraged farm'],
      write: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
    },
    {
      keys: ['bridge'],
      write: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
    },
    {
      keys: ['staking', 'restak'],
      write: (name, capital) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`,
    },
    {
      keys: ['perpetual', 'derivative'],
      write: (name, capital) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`,
    },
    {
      keys: ['prediction'],
      write: (name, capital) => `Fund $${capital} and place one market position on ${name}.`,
    },
    {
      keys: ['curator', 'allocator'],
      write: (name, capital, chain) => `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`,
    },
    {
      keys: ['stable'],
      write: (name, capital, chain) => `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`,
    },
    {
      keys: ['rwa'],
      write: (name, capital, chain) => `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`,
    },
    {
      keys: ['insurance'],
      write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`,
    },
  ];

  function mainAction(p, capital, chain) {
    const c = (p.category || '').toLowerCase();
    for (const rule of MAIN_ACTIONS) {
      if (rule.keys.some((key) => c.indexOf(key) >= 0)) return rule.write(p.name, capital, chain);
    }
    return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
  }

  /** One category rule: the keywords that pick it, and the weekly action it writes. */
  const WEEKLY_ACTIONS = [
    {
      keys: ['lend', 'cdp', 'collateral'],
      text: 'Borrow a small amount against your supply once, then repay it, so the wallet shows both sides of the market.',
    },
    {
      keys: ['dex', 'yield', 'leveraged farm'],
      text: 'Swap a small amount through the pool once a week so the wallet shows repeated use, not one deposit.',
    },
    {
      keys: ['bridge'],
      text: 'Bridge a small amount back or to a second chain once a week so the wallet shows repeated use.',
    },
    {
      keys: ['staking', 'restak'],
      text: 'Claim or compound the staking rewards once a week so the wallet shows repeated use.',
    },
    {
      keys: ['perpetual', 'derivative'],
      text: 'Open and close one small position a week so the wallet shows repeated use.',
    },
    {
      keys: ['prediction'],
      text: 'Place one small market position a week so the wallet shows repeated use.',
    },
    {
      keys: ['curator', 'allocator'],
      text: 'Check the vault allocation once a week and rebalance only if the vault itself asks for it.',
    },
    {
      keys: ['stable'],
      text: 'Mint or redeem a small amount once a week so the wallet shows repeated use.',
    },
    {
      keys: ['rwa'],
      text: 'Check the yield accrual once a week and keep the receipt token in the same wallet.',
    },
    {
      keys: ['insurance'],
      text: 'Check the cover status once a week and renew it before it lapses.',
    },
  ];

  function weeklyAction(p) {
    const c = (p.category || '').toLowerCase();
    for (const rule of WEEKLY_ACTIONS) {
      if (rule.keys.some((key) => c.indexOf(key) >= 0)) return rule.text;
    }
    return 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.';
  }

  /** One step as a single line: its action, then its cost and time. */
  function stepLine(step) {
    let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  /** A protocol's seven-step farm plan, derived from its own record. */
  function planSteps(p) {
    const chain = primaryChain(p);
    const capital = stakeSize(p);
    const hold = holdDays(p.age_days);
    const steps = [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: mainAction(p, capital, chain), cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: weeklyAction(p), cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' },
      { text: 'If ' + p.name + ' issues a token, claim from its own app only, and keep half the position for one more month in case later snapshots count it.', cost: 'the gas of one claim', time: '10 minutes to claim' },
    ];
    return steps.map(stepLine);
  }

  /** Read the filter state back out of the URL hash, if the page was linked with one. */
  function loadHash() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('p')) state.selected = params.get('p');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('tab')) state.tab = params.get('tab');
    if (params.get('wl') === '1') state.watchlistOnly = true;
  }

  /** Write the filter state into the URL hash so a view can be linked to. */
  function saveHash() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlistOnly) params.set('wl', '1');
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);
    const next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /** The rows the current filters let through. */
  function visibleRows() {
    const q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (state.watchlistOnly && !r.watchlist) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  /** The filtered rows in the current sort order, ties broken by slug. */
  function orderedRows(list) {
    const key = state.sort;
    return list.slice().sort(function (a, b) {
      let av;
      let bv;
      if (key === 'name') {
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
      } else if (key === 'tvl') {
        av = a.tvl_usd;
        bv = b.tvl_usd;
      } else if (key === 'growth') {
        av = a.change_7d === null ? -Infinity : a.change_7d;
        bv = b.change_7d === null ? -Infinity : b.change_7d;
      } else if (key === 'age') {
        av = a.age_days === null ? Infinity : a.age_days;
        bv = b.age_days === null ? Infinity : b.age_days;
      } else {
        av = a.implied_value_usd;
        bv = b.implied_value_usd;
      }
      if (av < bv) return -state.dir;
      if (av > bv) return state.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function header() {
    return el('header', { class: 'top' },
      el('div', { class: 'brand' }, el('span', { class: 'mark' }), el('span', { class: 'brand-name', text: 'Token Radar' })),
      el('div', { class: 'top-meta' },
        el('span', { text: 'Snapshot ' + DATA.as_of }),
        el('span', { text: 'DefiLlama protocol index' }),
        el('span', { text: DATA.model_version + ' model' })
      )
    );
  }

  function lede() {
    return el('section', { class: 'lede' },
      el('div', null,
        el('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        el('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(DATA.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + DATA.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      el('div', { class: 'facts' },
        el('div', { class: 'fact' }, el('span', { text: 'Watchlist covered' }), el('b', { text: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        el('div', { class: 'fact' }, el('span', { text: 'Pre-token rows scored' }), el('b', { text: String(DATA.board_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Early rows below the floor' }), el('b', { text: String(DATA.early_size) })),
        el('div', { class: 'fact' }, el('span', { text: 'Live-token protocols set aside' }), el('b', { text: String(DATA.live_size) }))
      )
    );
  }

  // The ten strongest rows at a glance: the board's own order, with the same bars the table uses.
  function topTen() {
    const top = DATA.rows.slice(0, 10);
    const max = top.length ? top[0].implied_value_usd : 1;
    return el('section', { class: 'panel top10' },
      el('h2', { text: 'Top 10 by implied value' }),
      el('ol', { class: 'top-list' }, top.map(function (r) {
        return el('li', null,
          el('button', { type: 'button', onclick: function () { openDetail(r.slug); } },
            el('span', { class: 'num', text: String(r.rank) }),
            el('span', { class: 'top-name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + (r.watchlist ? ' · watchlist' : '') })),
            el('span', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
            el('span', { class: 'num', text: money(r.implied_value_usd) })
          )
        );
      }))
    );
  }

  function controls() {
    const categories = Array.from(new Set(DATA.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    const chains = Array.from(new Set(DATA.rows.reduce(function (acc, r) { return acc.concat(r.chains || []); }, []))).sort();
    const search = el('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: state.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { state.q = search.value; saveHash(); render(); });
    const categorySelect = el('select', { id: 'category', 'aria-label': 'Filter by category' },
      el('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return el('option', { value: c, text: c, selected: c === state.category ? 'selected' : null }); })
    );
    categorySelect.addEventListener('change', function () { state.category = categorySelect.value; saveHash(); render(); });
    const chainSelect = el('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      el('option', { value: 'all', text: 'All chains' }),
      chains.map(function (c) { return el('option', { value: c, text: c, selected: c === state.chain ? 'selected' : null }); })
    );
    chainSelect.addEventListener('change', function () { state.chain = chainSelect.value; saveHash(); render(); });
    const wlButton = el('button', { type: 'button', 'aria-pressed': state.watchlistOnly ? 'true' : 'false', text: 'Watchlist only', onclick: function () { state.watchlistOnly = !state.watchlistOnly; saveHash(); render(); } });
    const preButton = el('button', { type: 'button', 'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { state.tab = 'pre-token'; saveHash(); render(); } });
    const liveButton = el('button', { type: 'button', 'aria-pressed': state.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { state.tab = 'live'; saveHash(); render(); } });
    return el('div', { class: 'controls' },
      el('div', { class: 'field' }, el('label', { for: 'q', text: 'Search' }), search),
      el('div', { class: 'field' }, el('label', { for: 'category', text: 'Category' }), categorySelect),
      el('div', { class: 'field' }, el('label', { for: 'chain', text: 'Chain' }), chainSelect),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Scope' }), el('div', { class: 'tabs' }, wlButton)),
      el('div', { class: 'field' }, el('span', { class: 'sub', text: 'Token status' }), el('div', { class: 'tabs' }, preButton, liveButton)),
      el('span', { class: 'count', text: state.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols' })
    );
  }

  /** A sortable column header: clicking it sorts, clicking again flips the direction. */
  function sortHeader(key, label) {
    return el('th', { scope: 'col' },
      el('button', { type: 'button', onclick: function () { if (state.sort === key) state.dir = -state.dir; else { state.sort = key; state.dir = -1; } render(); } },
        label,
        state.sort === key ? el('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    const list = orderedRows(visibleRows());
    if (list.length === 0) {
      return el('div', { class: 'panel' }, el('div', { class: 'empty' },
        el('h2', { text: 'No protocol matches that filter' }),
        el('p', { text: 'Clear the search or pick another category to see the board again.' }),
        el('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlistOnly = false; saveHash(); render(); } })
      ));
    }
    const max = list[0].implied_value_usd || 1;
    const tbody = el('tbody');
    list.forEach(function (r) {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const chainText = r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain';
      const tr = el('tr', {
        'data-selected': state.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        el('td', { class: 'num', text: String(r.rank) }),
        el('td', null, el('div', { class: 'name' },
          el('b', { text: r.name }),
          el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainText })
        )),
        el('td', { class: 'num', text: money(r.tvl_usd) }),
        el('td', { class: 'num ' + growthClass, text: growth }),
        el('td', { class: 'num', text: ageLabel(r.age_days) }),
        el('td', null, el('div', { class: 'implied' },
          el('div', { class: 'bar', 'aria-hidden': 'true' }, el('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
          el('span', { class: 'num', text: money(r.implied_value_usd) })
        )),
        el('td', null, el('span', { class: 'status', text: r.watchlist ? 'watchlist · no token' : 'no token' }))
      );
      tbody.appendChild(tr);
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          el('thead', null, el('tr', null,
            sortHeader('implied', 'Rank'),
            sortHeader('name', 'Protocol'),
            sortHeader('tvl', 'TVL'),
            sortHeader('growth', '7d'),
            sortHeader('age', 'Age'),
            sortHeader('implied', 'Implied value'),
            el('th', { scope: 'col', text: 'Token' })
          )),
          tbody
        )
      )
    );
  }

  function liveTable() {
    const tbody = el('tbody');
    DATA.live.forEach(function (r) {
      const chainText = r.chains && r.chains.length ? r.chains.join(', ') : 'an unnamed chain';
      const changeClass = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(el('tr', null,
        el('td', { class: 'num', text: 'live' }),
        el('td', null, el('div', { class: 'name' }, el('b', { text: r.name }), el('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + chainText }))),
        el('td', { class: 'num', text: money(r.tvl_usd) }),
        el('td', { class: 'num ' + changeClass, text: pct(r.change_7d) }),
        el('td', { class: 'num', text: money(r.mcap_usd) }),
        el('td', null, el('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return el('div', { class: 'panel' },
      el('div', { class: 'table-wrap' },
        el('table', null,
          el('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          el('thead', null, el('tr', null, el('th', { scope: 'col', text: 'Status' }), el('th', { scope: 'col', text: 'Protocol' }), el('th', { scope: 'col', text: 'TVL' }), el('th', { scope: 'col', text: '7d' }), el('th', { scope: 'col', text: 'Market cap' }), el('th', { scope: 'col', text: 'Token' }))),
          tbody
        )
      )
    );
  }

  function modelPanel() {
    const m = DATA.model;
    const benchRows = (DATA.benchmarks || []).slice(0, 12).map(function (b) {
      return el('tr', null,
        el('td', null, el('b', { text: b.category })),
        el('td', { class: 'num', text: String(b.live_count) }),
        el('td', { class: 'num', text: b.median_mcap_per_tvl === null ? 'n/a' : b.median_mcap_per_tvl.toFixed(2) + 'x' }),
        el('td', { class: 'num', text: b.benchmark.toFixed(2) + 'x' })
      );
    });
    const formula = `implied = round( tvl_usd x benchmark(category) x (1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}) x (${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}) )`;
    const benchNote = `benchmark(category) is the market's own mcap/TVL for that category: the median across the live-token protocols in the category, shrunk toward the global median (${DATA.global_median_mcap_per_tvl.toFixed(2)}x) with weight ${m.benchmark_shrink} when the category has few live protocols, and clamped to [${m.benchmark_floor}, ${m.benchmark_cap}]. A category with no live protocol falls back to the global median. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ${m.unknown_age_days} days.`;
    return el('section', { class: 'panel model' },
      el('h2', { text: 'How implied value is computed' }),
      el('p', { class: 'sub', text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.' }),
      el('div', { class: 'formula' }, formula),
      el('p', { class: 'sub', text: benchNote }),
      el('h3', { text: 'Category benchmarks (mcap per $1 of TVL, top 12 by live protocols)' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'bench' },
          el('thead', null, el('tr', null,
            el('th', { scope: 'col', text: 'Category' }),
            el('th', { scope: 'col', text: 'Live protocols' }),
            el('th', { scope: 'col', text: 'Median mcap/TVL' }),
            el('th', { scope: 'col', text: 'Benchmark used' })
          )),
          el('tbody', null, benchRows)
        )
      ),
      el('p', { class: 'sub', text: 'The early radar is every rankable pre-token protocol below the watchlist floor, and the live-token protocols are set aside with their market caps shown.' })
    );
  }

  const dialog = el('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', function () { state.selected = null; saveHash(); });

  function openDetail(slug) {
    const row = DATA.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    state.selected = slug;
    saveHash();
    dialog.textContent = '';
    const steps = planSteps(row);
    const bench = (DATA.benchmarks || []).filter(function (b) { return b.category === (row.category || 'Other'); })[0];
    const benchLine = bench
      ? (row.category || 'Other') + ' live tokens trade at a median ' + bench.median_mcap_per_tvl + 'x TVL (' + bench.live_count + ' live), so this row is priced at ' + row.benchmark.toFixed(2) + 'x TVL.'
      : 'No live-token protocol in this category, so this row is priced at the global median ' + row.benchmark.toFixed(2) + 'x TVL.';
    const chainText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';
    const recomputed = recomputeImplied(row, DATA.model);
    const checkLine = 'Model ' + DATA.model_version + ': the same function scores every protocol. The page recomputes this row as ' + money(recomputed) + (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') + ' This is an estimate, not a price. The snapshot records no token for this protocol; that is the record, not proof it has none.';
    dialog.appendChild(el('div', { class: 'detail-head' },
      el('div', null,
        el('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · watchlist' : ' · early') }),
        el('h2', { id: 'detail-title', text: row.name }),
        el('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + chainText })
      ),
      el('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { dialog.close(); } })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Implied value' }),
      el('div', { class: 'equation' },
        el('div', null, el('span', { text: 'TVL' }), el('b', { class: 'num', text: money(row.tvl_usd) })),
        el('div', null, el('span', { text: 'Seven-day growth' }), el('b', { class: 'num', text: pct(row.change_7d) })),
        el('div', null, el('span', { text: 'Age with no token' }), el('b', { class: 'num', text: ageLabel(row.age_days) })),
        el('div', null, el('span', { text: 'Category benchmark' }), el('b', { class: 'num', text: row.benchmark.toFixed(2) + 'x TVL' })),
        el('div', null, el('span', { text: 'Growth multiplier' }), el('b', { class: 'num', text: String(row.growth_multiplier) })),
        el('div', null, el('span', { text: 'Maturity multiplier' }), el('b', { class: 'num', text: String(row.maturity_multiplier) })),
        el('div', null, el('span', { text: 'Implied value' }), el('b', { class: 'num', text: money(row.implied_value_usd) }))
      ),
      el('p', { class: 'sub', text: benchLine }),
      el('p', { class: 'sub', text: checkLine })
    ));
    dialog.appendChild(el('section', { class: 'detail-section' },
      el('h3', { text: 'Farm plan' }),
      el('ol', { class: 'steps' }, steps.map(function (s) {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return el('li', null, el('b', { text: action }), el('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  function render() {
    app.textContent = '';
    const shell = el('div', { class: 'shell' });
    shell.appendChild(header());
    shell.appendChild(lede());
    if (state.tab === 'pre-token') shell.appendChild(topTen());
    shell.appendChild(controls());
    shell.appendChild(state.tab === 'pre-token' ? boardTable() : liveTable());
    if (state.tab === 'pre-token') shell.appendChild(modelPanel());
    app.appendChild(shell);
    app.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) app.appendChild(dialog);
    if (state.selected) openDetail(state.selected);
  }

  loadHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && dialog.open) dialog.close();
  });
})();
