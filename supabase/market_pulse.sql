-- AlphaDesk — Market Pulse cache table.
-- Run this in Supabase → SQL Editor.
--
-- The local script fetch_transcripts.py writes processed analyst insights here
-- (using the SERVICE ROLE key, which bypasses RLS). The Render backend reads
-- them with the ANON key. Market Pulse is public analyst commentary — not
-- user-private data — so reads are open; writes are service-role only.

create table if not exists public.market_pulse (
  id              bigint generated always as identity primary key,
  analyst_id      text        not null,
  analyst_name    text        not null,
  label           text,
  weight          int         not null,
  video_title     text,
  video_link      text,
  published_date  text,
  insight_summary text,        -- the 2-3 extracted insights (newline-separated)
  key_takeaway    text,        -- the single most important takeaway
  sentiment       text,        -- bullish | bearish | neutral
  fetched_at      timestamptz  not null default now()
);

create index if not exists market_pulse_weight_idx  on public.market_pulse (weight);
create index if not exists market_pulse_fetched_idx on public.market_pulse (fetched_at desc);

alter table public.market_pulse enable row level security;

-- Public read (anon key, used by the Render backend). No insert/update/delete
-- policy is defined, so only the service_role key (local fetch script) can write.
drop policy if exists "market_pulse public read" on public.market_pulse;
create policy "market_pulse public read" on public.market_pulse
  for select using (true);
