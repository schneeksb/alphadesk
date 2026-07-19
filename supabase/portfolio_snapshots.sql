-- AlphaDesk — daily portfolio snapshots (Performance panel history).
-- Run this in Supabase → SQL Editor.
--
-- One row per user per day, upserted: the frontend writes on every valuation
-- while the app is open (last write of the day wins), and the scheduled brief
-- runner (run_market_brief.py, service role key) fills weekday mornings the
-- app isn't opened. PRIVATE: rows are user-keyed with RLS like market_brief.

create table if not exists public.portfolio_snapshots (
  user_id         uuid    not null,
  snap_date       date    not null,
  total_value     numeric,            -- holdings market value
  total_cost      numeric,
  total_pnl       numeric,            -- unrealized P&L
  realized_pnl    numeric,            -- cumulative realized P&L (Closed ledger) at snapshot time
  cash            numeric,            -- combined cash across accounts
  margin          numeric,            -- combined margin balance
  net_value       numeric,            -- equity after margin
  spy_close       numeric,            -- SPY close for the vs-index overlay
  positions_count int,
  updated_at      timestamptz not null default now(),
  primary key (user_id, snap_date)
);

create index if not exists portfolio_snapshots_user_date_idx
  on public.portfolio_snapshots (user_id, snap_date desc);

alter table public.portfolio_snapshots enable row level security;

drop policy if exists "own snapshots read"   on public.portfolio_snapshots;
drop policy if exists "own snapshots insert" on public.portfolio_snapshots;
drop policy if exists "own snapshots update" on public.portfolio_snapshots;

create policy "own snapshots read" on public.portfolio_snapshots
  for select using (auth.uid() = user_id);

create policy "own snapshots insert" on public.portfolio_snapshots
  for insert with check (auth.uid() = user_id);

create policy "own snapshots update" on public.portfolio_snapshots
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
