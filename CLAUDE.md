# AlphaDesk — personal stock-research app (decision-first)

One user (Google login required in prod). Core pages: Watchlist (Conviction/Radar tiers),
Portfolio, Real Estate (buy underwriting for rental/multifamily/flip/commercial + operating
dashboard + sell-vs-keep — all calculator-driven from user inputs, no market API), Financials
(analyze/statements/compare/projections/filings), Brief (agentic morning Market Brief).
Recommendations are research input, not financial advice.

Tests: `pytest tests/ -q` (no network — valuation layers stubbed) + `npm run build` in `app/`;
both run in CI (`.github/workflows/ci.yml`). Run them before pushing — push to main IS the
prod deploy, CI on main is only a post-hoc signal.

## Architecture
- **Backend**: `research.py` — FastAPI app AND the whole data layer (yfinance). All endpoints
  defined inside the `try: from fastapi...` block at module level. Run: `python -m uvicorn
  research:app --port 8000`. Deployed on Render free tier (sleeps, ephemeral disk, NO user data
  stored server-side).
- **Frontend**: `app/src/App.jsx` — single-file React (~5k lines), Vite, deployed on Vercel.
  `app/src/lib/supabase.js` (anon client + authHeaders()), `app/src/Auth.jsx`, `app/src/main.jsx`
  (login gate). Light theme default; colors via the `C` palette object, inline styles only.
- **Other**: `run_daily.py` (portfolio valuation/Greeks/alerts — profile-aware `layer4_alerts`),
  `scanner.py` (climate/sectors + `_lenient_json`), `market_brief_agent.py` (tool-use loop agent),
  `run_market_brief.py` (CLI/scheduled brief runner), `fetch_transcripts.py` (local-only Market
  Pulse YouTube pipeline), `supabase/*.sql` (schema; run manually in SQL editor).

## Persistence & auth (CRITICAL rules)
- Per-user state (positions, closed-position ledger, watchlist+radar, baselines, profile,
  screens, projection scenarios, RE properties+deals, briefs) lives in Supabase with RLS
  (`auth.uid() = user_id`). Frontend also mirrors to localStorage (anonymous/
  localhost mode is localStorage-only; auth disabled on localhost).
- Daily snapshots: `portfolio_snapshots` (one row per user+day, RLS) upserted by the frontend
  on every valuation AND by run_market_brief.py (service key) on weekday mornings — powers the
  Portfolio Performance panel (equity vs SPY). "Close" on a position books realized P&L into
  `closedPositions` (in the portfolios blob); "Remove" erases without recording.
- `/value` requires auth in prod (same `require_user` as AI endpoints) — it does real yfinance
  work per call; frontend sends `authHeaders()`.
- `SUPABASE_SERVICE_ROLE_KEY`: local `.env` + GitHub Actions secrets ONLY. NEVER frontend, NEVER
  the Render web service. Render gets SUPABASE_URL + SUPABASE_ANON_KEY only.
- AI endpoints require a verified Supabase login (`require_user`), enforced when `RENDER` or
  `REQUIRE_AUTH=1` is set; OPEN on localhost dev. Frontend attaches tokens via `authHeaders()`.
- `.env`, `positions.json`, `settings.json`, `yt_cookies*`, `OAuth client.txt` are gitignored.

## Gotchas (learned the hard way)
- **Yahoo blocks its info/quoteSummary + analyst-estimates APIs from datacenter IPs (Render).**
  Statements + price history still work there. `fundamentals()` derives metrics from statements
  as fallback (incl. EV/EBITDA from EV/EBITDA components and forward P/E from trailing EPS ×
  latest YoY growth); true analyst-estimate bars still need the API. Optional fix: set `YF_PROXY`
  (residential proxy URL) on Render to route yfinance and restore estimates in prod. Independently,
  the Financials "AI Forecast" toggle (`/ai-financials-forecast`) fills the forward bars EVERYWHERE
  via Claude best-estimates (amber, clearly labeled) — works in prod regardless of the Yahoo block.
  The `perf` block (returns/vol/drawdown/beta/div yield) is price-history-only → works everywhere,
  including for ETFs.
- RE property auto-fill (`/re-property-lookup`): RentCast AVM when `RENTCAST_API_KEY` is set
  (free tier 50 req/mo, works on Render), else a labeled AI estimate. 10-min cache via `_cached_ai`.
- Institutional positioning (`/positioning`, no auth): CFTC Commitments of Traders via the free
  public Socrata API (`publicreporting.cftc.gov`, legacy futures-only `6dca-aqww`) — works on Render.
  `cftc_positioning()`/`positioning_data()` (6h SWR) return large-spec net position, 3yr percentile
  and weekly change for the major index/rate/FX/commodity futures. Contract names matched by `like`
  substring (`_COT_CONTRACTS`), most-liquid match wins. Wired into the Brief agent (`get_positioning`
  tool), the `/outlook` prompt, and the Brief-tab `PositioningPanel`. Macro/index-level, not per-stock.
- YouTube blocks transcript downloads (IP-level) → Market Pulse runs locally, throttled
  (`YT_THROTTLE_S`), merges per-analyst into `market_pulse` (public-read table). Optional proxy:
  `WEBSHARE_USER/PASS` or `YT_PROXY`. Every run also appends to `market_pulse_archive`
  (dedupe on analyst+video_link) — the analyst knowledge base. The daily run reads the
  archive's `video_link`s first and SKIPS already-summarized videos (recency-sorted), so the
  limited transcript budget goes to genuinely NEW videos — fresher, and more analysts clear
  the IP block before it trips. `/portfolio-analysis` merges archive + live pulse into
  per-analyst dated timelines (weight ≤ 3 get up to 5 entries, weight 1 gets latest-video
  detail) so the AI reads each analyst's EVOLVING view. `/yt-insights` also attaches a
  trust-weighted panel `summary` (haiku via `_pulse_summary`, cached per fetch: mood /
  bottom_line / themes / divergence / standout) rendered atop the Market Pulse panel.
- yfinance quirks: no `show_errors` kwarg; quarterly statements ≈ 5-6 quarters only; RSI must be
  Wilder's (ewm alpha=1/14) to match TradingView — frontend `calcRSI` mirrors it.
- AI prompts MUST include `datetime.date.today()` (model assumes training-era year otherwise).
- Claude calls: model `claude-sonnet-4-6` (haiku for primers/transcripts). Use prompt caching
  (`cache_control` on static system blocks/tools) — see `ai_analysis_and_news`, `chat_reply`,
  the brief agent loop. The AI stage-read has its own 30-min `aian:` cache separate from
  technicals. `_cached` = 10-min TTL; `_cached_swr(key, fn, ttl, stale_ttl)` = stale-while-revalidate.
- Trader profile string `risk|goal1,goal2|style1,style2|level` (goals/styles are multi-select
  arrays in the frontend, comma-joined). `_profile_ctx()` renders it for prompts; `_profile_line()`
  is the compact one-liner. Portfolio accounts may carry a per-account `profile` override
  (structured object, same shape as global) — `/portfolio-analysis` groups positions by account,
  applies each account's profile, and grounds the read in sector rotation + macro + Market Pulse.
  `/value` also takes `accounts` [{id, profile}]: each position's Signal (`rec`, via `_recommend`)
  and Stop (`stop_rec`, via `_stop_recommendation`) are calibrated to its account's profile through
  `_profile_knobs` (loss-cut/profit-take/DTE/stop-width thresholds; moderate|swing = legacy values;
  `prof_scope` on each position says which profile applied). Frontend re-values on profile or
  account-assignment changes (`acctProfSig` + account in `valSig`).
- FastAPI endpoints are module attrs (e.g. `research.sector_rotation_endpoint()` callable directly
  — the brief agent's tools do this).

## Deploy / verify
- `git push origin main` → Render (backend) + Vercel (frontend) auto-deploy. Scheduled brief:
  GitHub Actions `.github/workflows/market-brief.yml` (weekdays 11:47 UTC, secrets in repo settings).
  Scheduled Market Pulse: `.github/workflows/market-pulse.yml` (weekdays 11:20 UTC, before the
  brief) runs `fetch_transcripts.py` in the cloud — needs `WEBSHARE_USER/PASS` (or `YT_PROXY`)
  repo secrets since YouTube blocks datacenter IPs; `_proxy_url()` routes BOTH discovery and
  transcripts through the residential proxy. Idempotent vs the local Task Scheduler job (skips
  archived videos), so both can coexist.
- Preview: `.claude/launch.json` name "AlphaDesk" (Vite :5173, use `localhost` not `127.0.0.1`).
  Backend must run separately on :8000. Kill stale python before restart (`taskkill //F //IM python.exe`).
- Always run `python -c "import ast; ast.parse(open('research.py').read())"` before restarting.
- Commit style: imperative subject + wrapped body; end with Co-Authored-By Claude line.
