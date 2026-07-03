-- AlphaDesk — Market Brief artifacts (agent output + tool-call log).
-- Run this in Supabase → SQL Editor.
--
-- PRIVATE table (unlike market_pulse): briefs contain portfolio analysis, so
-- rows are user-keyed with RLS. The frontend reads/writes its own rows with the
-- user's authenticated session; the scheduled runner (run_market_brief.py, local
-- or Render Cron Job) writes with the service role key, which bypasses RLS.

create table if not exists public.market_brief (
  id           bigint generated always as identity primary key,
  user_id      uuid        not null,
  source       text        not null default 'manual',  -- 'scheduled' | 'manual' | 'manual-cli'
  brief        jsonb       not null,                   -- the structured Market Brief
  tool_log     jsonb,                                  -- every tool call: name, input, preview, ms
  model        text,
  turns        int,
  generated_at timestamptz not null default now()
);

create index if not exists market_brief_user_time_idx
  on public.market_brief (user_id, generated_at desc);

alter table public.market_brief enable row level security;

drop policy if exists "own briefs read"   on public.market_brief;
drop policy if exists "own briefs insert" on public.market_brief;

create policy "own briefs read" on public.market_brief
  for select using (auth.uid() = user_id);

create policy "own briefs insert" on public.market_brief
  for insert with check (auth.uid() = user_id);
