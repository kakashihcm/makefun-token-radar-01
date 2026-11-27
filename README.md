# Token Radar — pre-token protocols ranked by implied value

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/kakashihcm/makefun-token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/kakashihcm/makefun-token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

This is my entry for the make.fun bounty "Build the best token launch radar": https://make.fun/bounty/token-radar-01

A token launch radar over DefiLlama's sealed snapshot of 14 November 2026 (758 protocols, 40 on
the watchlist). It ranks every pre-token protocol by an implied value the model derives from the
snapshot's own figures, and gives each one a farm plan a reader can follow.

## The model (radar-2)

Implied value is not one flat multiple for every protocol. Each category is priced off what the
market already pays for the same kind of business: the median mcap/TVL of the live-token
protocols in that category, shrunk toward the global median (0.19x) when the category has few
live protocols, and clamped to [0.05, 1.50]. A category with no live protocol falls back to the
global median. No protocol name is ever special-cased.

```
implied = round( tvl_usd x benchmark(category)
               x (1 + clamp(change_7d, -60, 120) / 100 x 0.5)
               x (0.6 + min(age_days, 1095) / 1095 x 0.4) )
```

Age is the time since DefiLlama first listed the protocol, the best record of how long it has
run with no token on record; an unlisted age uses 365 days. The board carries 226 rows: all 40
watchlist protocols plus every rankable pre-token protocol below the $50M floor. The 24 largest
live-token protocols are set aside in their own view, with their market caps shown as facts,
never mixed into the ranking. The snapshot records no token for a protocol; that is the record,
not proof it has none.

Some benchmarks the model reads off (live-token medians, shrunk): Lending 0.14x, Dexs 0.30x,
RWA 0.25x, Liquid Staking 0.08x, Basis Trading 0.38x, Risk Curators 0.74x (one live token, so
the shrinkage pulls it hard toward the global median).

## The dashboard

A static page — no framework, no network. It shows:

- A top-10 strip, then the full board sorted by implied value, with TVL, 7-day growth, age and
  a value bar per row. Watchlist members are marked in the Token column.
- Filters: search by name, category or chain; filter by category and by chain; a Watchlist-only
  toggle; a Live token tab that shows the protocols whose token already trades.
- A detail view for every protocol: its TVL, growth, age, category benchmark, both
  multipliers, the recomputed implied value (the page re-runs the model and checks the number
  board.json carries), and a seven-step farm plan.
- The model panel: the formula in full, plus the category benchmark table the model is read
  off, so a reader can see exactly where every number comes from.
- Farm plans: seven steps each, derived from the protocol's own category, chains, TVL and age —
  the action, what it costs and how long it takes, including a weekly action for the
  protocol's own category and a step for what to do if a token is issued.

## How to run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Then open `out/dashboard/index.html` in a browser (no server needed). Two runs write the same
bytes. Node 22 or later, standard library only.

## Files

- `main.ts` — entrypoint: reads the snapshot, writes `/output/board.json`, `/output/data.js`,
  copies `dashboard/` and `screenshots/`, writes `/output/dossier.json`.
- `lib/model.ts` — the radar-2 model, the farm plans and the snapshot parser.
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.
- `dashboard/index.html`, `dashboard/app.css`, `dashboard/app.js` — the static dashboard.
- `screenshots/` — 4 real renders of the dashboard (board, detail, filtered, live-token view).
- `LICENSE` — MIT license.
