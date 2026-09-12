-- AlphaDesk — custom YouTube channel transcript insights (the "YouTube" tab's
-- DEEP layer). Run this in Supabase → SQL Editor.
--
-- The backend can pull recent video titles/descriptions (RSS) from Render, but
-- YouTube IP-blocks caption downloads, so full transcripts are fetched LOCALLY by
-- fetch_transcripts.py (residential IP) for the user's own channel list and written
-- here with the service-role key. The channel list itself lives in the user's
-- private portfolios blob; these rows hold only public video commentary (no PII),
-- so — like market_pulse — reads are open (anon key on Render) and writes are
-- service-role only. Deduped per channel+video.

create table if not exists public.yt_custom_archive (
  id              bigint generated always as identity primary key,
  channel_id      text        not null,
  channel_name    text,
  video_title     text,
  video_link      text,
  published_date  text,
  insight_summary text,
  key_takeaway    text,
  sentiment       text,        -- bullish | bearish | neutral
  fetched_at      timestamptz  not null default now(),
  unique (channel_id, video_link)
);

create index if not exists yt_custom_archive_channel_idx
  on public.yt_custom_archive (channel_id, published_date desc);

alter table public.yt_custom_archive enable row level security;

drop policy if exists "yt_custom_archive public read" on public.yt_custom_archive;
create policy "yt_custom_archive public read" on public.yt_custom_archive
  for select using (true);
