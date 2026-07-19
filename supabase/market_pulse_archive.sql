-- AlphaDesk — Market Pulse ARCHIVE (append-only analyst knowledge base).
-- Run this in Supabase → SQL Editor.
--
-- market_pulse is a rolling cache: fetch_transcripts.py replaces each analyst's
-- rows on every run, so history is lost. This table keeps EVERY insight ever
-- fetched (deduped per analyst+video), giving the AI Portfolio Analysis an
-- evolving timeline of each analyst's views — e.g. how Nicholas Crown's macro
-- read has shifted over the past weeks — instead of only today's takeaway.
-- Same access model as market_pulse: public analyst commentary, open reads
-- (anon key on Render), service-role-only writes (local fetch script).

create table if not exists public.market_pulse_archive (
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
  fetched_at      timestamptz  not null default now(),
  unique (analyst_id, video_link)
);

create index if not exists market_pulse_archive_analyst_pub_idx
  on public.market_pulse_archive (analyst_id, published_date desc);

alter table public.market_pulse_archive enable row level security;

drop policy if exists "market_pulse_archive public read" on public.market_pulse_archive;
create policy "market_pulse_archive public read" on public.market_pulse_archive
  for select using (true);
