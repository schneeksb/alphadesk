-- AlphaDesk — per-user data store. Run this in Supabase → SQL Editor.
-- One JSON blob per user holding { positions, watchlist, settings }.
-- Row-Level Security guarantees each user can only read/write THEIR OWN row.

create table if not exists public.portfolios (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.portfolios enable row level security;

drop policy if exists "own portfolio select" on public.portfolios;
drop policy if exists "own portfolio insert" on public.portfolios;
drop policy if exists "own portfolio update" on public.portfolios;

create policy "own portfolio select" on public.portfolios
  for select using (auth.uid() = user_id);
create policy "own portfolio insert" on public.portfolios
  for insert with check (auth.uid() = user_id);
create policy "own portfolio update" on public.portfolios
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
