"""
AlphaDesk — Local Market Pulse transcript fetcher
=================================================
Runs on YOUR machine (a residential IP), where YouTube does NOT block transcript
fetching the way it blocks Render's datacenter IPs.

For each of the 9 analysts (in trust order), it:
  1. Reads their latest videos from the channel RSS feed (free, no API key).
  2. Pulls the spoken transcript via youtube-transcript-api.
  3. Asks Claude to extract 2-3 genuine actionable insights + sentiment.
  4. Writes the processed results to the Supabase `market_pulse` table.

The Render backend then just reads that table (see /yt-insights in research.py).

Run it:   python fetch_transcripts.py
Schedule: schedule_transcripts.bat  (Windows Task Scheduler, ~7:50 AM daily)

Requires (local):  pip install yt-dlp anthropic python-dotenv
Env (.env in this folder):
    ANTHROPIC_API_KEY=sk-ant-...
    SUPABASE_URL=https://<project>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=<service_role key>     # NOT the anon key — service role bypasses RLS to write
    (plus the YT_*_CHANNEL_ID overrides, optional — defaults are baked into research.py)
"""

import os, sys, json, time, datetime, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from dotenv import load_dotenv
import anthropic

# Force UTF-8 so analyst names / emoji in transcripts don't crash a cp1252 console.
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception: pass

load_dotenv()

# Single source of truth for the analyst panel (same trust order, labels, channels).
from research import ANALYSTS

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY  = (os.getenv("SUPABASE_SERVICE_ROLE_KEY")
                or os.getenv("SUPABASE_SERVICE_KEY") or "").strip()
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()

MAX_SCAN = 4        # how many recent videos to try per analyst before giving up
TRANSCRIPT_CAP = 5000   # chars of transcript sent to Claude
# Pause between transcript downloads. YouTube's IP block triggers on BURSTS of
# caption requests — pacing them out is what lets a proxy-less run survive.
THROTTLE_S = float(os.getenv("YT_THROTTLE_S", "12"))

_YT_NS = {
    "atom":  "http://www.w3.org/2005/Atom",
    "yt":    "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


# ── Latest videos per channel (RSS first, HTML scrape fallback) ────────────────
# YouTube's RSS feed endpoint (feeds/videos.xml) began returning 404 for all
# channels, so we fall back to scraping the channel's /videos page and pulling
# recent (videoId, title) pairs out of the embedded ytInitialData JSON.
def _fetch_entries_rss(channel_id):
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=10) as r:
        root = ET.fromstring(r.read())
    out = []
    for entry in root.findall("atom:entry", _YT_NS)[:12]:
        vid   = entry.findtext("yt:videoId", namespaces=_YT_NS) or ""
        title = entry.findtext("atom:title", namespaces=_YT_NS) or ""
        pub   = (entry.findtext("atom:published", namespaces=_YT_NS) or "")[:10]
        link_el = entry.find("atom:link[@rel='alternate']", _YT_NS)
        link  = link_el.get("href") if link_el is not None else f"https://youtube.com/watch?v={vid}"
        combo = (title + " " + link).lower()
        is_short = "#short" in combo or "/shorts/" in link
        out.append({"vid": vid, "title": title, "link": link, "pub": pub, "is_short": is_short})
    return out


def _extract_balanced_json(html, marker):
    """Extract the balanced {...} object that follows `marker` (string-aware)."""
    i = html.find(marker)
    if i < 0:
        return None
    i = html.find("{", i)
    if i < 0:
        return None
    depth = 0; instr = False; esc = False
    for j in range(i, len(html)):
        c = html[j]
        if esc:
            esc = False; continue
        if c == "\\":
            esc = True; continue
        if c == '"':
            instr = not instr; continue
        if instr:
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return html[i:j+1]
    return None


def _fetch_entries_scrape(channel_id):
    url = f"https://www.youtube.com/channel/{channel_id}/videos"
    req = urllib.request.Request(url, headers={"User-Agent": _UA, "Accept-Language": "en-US,en;q=0.9"})
    with urllib.request.urlopen(req, timeout=15) as r:
        html = r.read().decode("utf-8", "replace")
    blob = _extract_balanced_json(html, "ytInitialData")
    out, seen = [], set()
    if blob:
        try:
            data = json.loads(blob)
        except Exception:
            data = None
        def walk(o):
            if isinstance(o, dict):
                # Legacy videoRenderer
                vr = o.get("videoRenderer")
                if isinstance(vr, dict) and vr.get("videoId"):
                    vid = vr["videoId"]
                    if vid not in seen:
                        seen.add(vid)
                        t = ""
                        try: t = vr["title"]["runs"][0]["text"]
                        except Exception:
                            try: t = vr["title"]["simpleText"]
                            except Exception: t = ""
                        out.append({"vid": vid, "title": t, "link": f"https://youtube.com/watch?v={vid}",
                                    "pub": "", "is_short": "#short" in (t or "").lower()})
                # Current lockupViewModel (contentId = videoId, title under metadata)
                lm = o.get("lockupViewModel")
                if isinstance(lm, dict) and lm.get("contentId") and lm.get("contentType") == "LOCKUP_CONTENT_TYPE_VIDEO":
                    vid = lm["contentId"]
                    if vid not in seen and len(vid) == 11:
                        seen.add(vid)
                        t = ""
                        try: t = lm["metadata"]["lockupMetadataViewModel"]["title"]["content"]
                        except Exception: t = ""
                        out.append({"vid": vid, "title": t, "link": f"https://youtube.com/watch?v={vid}",
                                    "pub": "", "is_short": "#short" in (t or "").lower()})
                for v in o.values(): walk(v)
            elif isinstance(o, list):
                for v in o: walk(v)
        if data:
            walk(data)
    return out[:12]


def fetch_entries(channel_id):
    try:
        rss = _fetch_entries_rss(channel_id)
        if rss:
            return rss
    except Exception:
        pass
    return _fetch_entries_scrape(channel_id)


# ── Transcript fetch (youtube-transcript-api 1.x) ─────────────────────────────
# IMPORTANT: YouTube IP-BLOCKS caption downloads from residential/datacenter IPs
# after a handful of requests (the api raises IpBlocked / RequestBlocked). The
# list endpoint keeps working, but .fetch() gets blocked. The only robust fix is
# to route through a proxy — set ONE of:
#     YT_PROXY=http://user:pass@host:port          (any HTTP/HTTPS proxy)
#     WEBSHARE_USER=... and WEBSHARE_PASS=...       (Webshare residential proxies)
# Without a proxy it still works in short bursts / when the IP isn't currently
# blocked, so a single clean run after a cooldown often succeeds.
_YT_PROXY      = os.getenv("YT_PROXY", "").strip() or None
_WEBSHARE_USER = os.getenv("WEBSHARE_USER", "").strip() or None
_WEBSHARE_PASS = os.getenv("WEBSHARE_PASS", "").strip() or None
_LANGS = ["en", "en-US", "en-GB"]

def _yt_api():
    from youtube_transcript_api import YouTubeTranscriptApi
    try:
        if _WEBSHARE_USER and _WEBSHARE_PASS:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            return YouTubeTranscriptApi(proxy_config=WebshareProxyConfig(
                proxy_username=_WEBSHARE_USER, proxy_password=_WEBSHARE_PASS))
        if _YT_PROXY:
            from youtube_transcript_api.proxies import GenericProxyConfig
            return YouTubeTranscriptApi(proxy_config=GenericProxyConfig(
                http_url=_YT_PROXY, https_url=_YT_PROXY))
    except Exception:
        pass
    return YouTubeTranscriptApi()

def get_transcript(vid):
    try:
        from youtube_transcript_api import YouTubeTranscriptApi  # noqa: F401
    except ImportError:
        raise SystemExit("Missing dependency — run:  pip install -U youtube-transcript-api")
    api = _yt_api()
    # Preferred: 1.x instance .fetch()
    try:
        fetched = api.fetch(vid, languages=_LANGS)
        try:    return " ".join(s["text"] for s in fetched.to_raw_data())
        except Exception: return " ".join(getattr(s, "text", "") for s in fetched)
    except Exception as e:
        global _IP_BLOCKED
        if type(e).__name__ in ("IpBlocked", "RequestBlocked"):
            _IP_BLOCKED = True
            return None
    # Fallback: any available language via list()
    try:
        tl = api.list(vid)
        t = tl.find_transcript([tr.language_code for tr in tl])
        return " ".join(s["text"] for s in t.fetch().to_raw_data())
    except Exception:
        return None

_IP_BLOCKED = False


# ── Claude: extract 2-3 real insights from a transcript ───────────────────────
_ai = anthropic.Anthropic(api_key=ANTHROPIC_KEY)
_PROMPT = (
    "You are analyzing a financial YouTube video transcript. Extract the 2-3 most "
    "important actionable insights for a stock investor. Focus on: specific stocks "
    "or sectors mentioned, market direction calls, macro observations, or trading "
    "ideas. Return only the insights — no promotional content, no calls to action, "
    "no affiliate links. Be specific and concrete. If the transcript contains no "
    "useful financial insights, return null."
)


def extract_insights(analyst, video, transcript):
    prompt = (
        f"{_PROMPT}\n\n"
        f"Analyst: {analyst['name']} ({analyst['focus']})\n"
        f"Video title: {video['title']}\n\n"
        f"Transcript:\n{transcript[:TRANSCRIPT_CAP]}\n\n"
        f"Respond with JSON only, no markdown. Either:\n"
        f'{{"insights": ["insight 1", "insight 2", "insight 3"], '
        f'"takeaway": "one sentence — the single most important takeaway", '
        f'"sentiment": "bullish" | "bearish" | "neutral"}}\n'
        f"Or, if there are no useful financial insights, respond with exactly:\nnull"
    )
    try:
        rsp = _ai.messages.create(model="claude-haiku-4-5-20251001", max_tokens=400,
                                  messages=[{"role": "user", "content": prompt}])
        raw = rsp.content[0].text.strip()
    except Exception as e:
        print(f"      ! Claude error: {e}")
        return None
    if raw.startswith("```"):
        import re
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw).strip()
    if raw.lower() == "null" or not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    if not data:
        return None
    points = [str(p).strip() for p in (data.get("insights") or []) if str(p).strip()]
    if not points:
        return None
    sent = str(data.get("sentiment", "neutral")).lower()
    if sent not in ("bullish", "bearish", "neutral"):
        sent = "neutral"
    return {
        "insights": points[:3],
        "takeaway": str(data.get("takeaway", "")).strip() or points[0],
        "sentiment": sent,
    }


# ── Supabase REST (service role → bypasses RLS to write) ──────────────────────
def sb_request(method, path, body=None, prefer="return=minimal"):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def archived_links():
    """Video links already in the knowledge base (market_pulse_archive). Lets the
    daily run SKIP videos it has already summarized — so it spends its limited
    transcript-request budget only on genuinely NEW videos (fresher insights, and
    more analysts get through before YouTube's IP block trips). Best-effort:
    returns an empty set if the archive table isn't there yet."""
    try:
        url = f"{SUPABASE_URL}/rest/v1/market_pulse_archive?select=video_link"
        req = urllib.request.Request(url, headers={
            "apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
            "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            return {row.get("video_link") for row in json.loads(r.read()) if row.get("video_link")}
    except Exception as e:
        print(f"  (archive lookup skipped: {e})")
        return set()


def save_to_supabase(rows):
    """Per-analyst merge, not a full wipe. YouTube's IP block often cuts a run
    short partway down the trust list — replacing only the analysts this run
    actually fetched means a partial run can never erase another analyst's
    still-good insights from a previous run."""
    if not rows:
        return
    fetched_ids = sorted({r["analyst_id"] for r in rows})
    id_list = ",".join(f'"{i}"' for i in fetched_ids)
    sb_request("DELETE", f"market_pulse?analyst_id=in.({id_list})")
    sb_request("POST", "market_pulse", rows)
    # Append-only knowledge base: market_pulse is a rolling cache, the archive
    # keeps every insight forever so the AI can read each analyst's EVOLVING view
    # (see market_pulse_archive.sql). Deduped on (analyst_id, video_link) so
    # re-runs are idempotent; best-effort so a missing table can't break the run.
    try:
        sb_request("POST", "market_pulse_archive?on_conflict=analyst_id,video_link", rows,
                   prefer="return=minimal,resolution=ignore-duplicates")
    except Exception as e:
        print(f"    ! archive write skipped ({e}) — run supabase/market_pulse_archive.sql")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    missing = [n for n, v in [("SUPABASE_URL", SUPABASE_URL),
                              ("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY),
                              ("ANTHROPIC_API_KEY", ANTHROPIC_KEY)] if not v]
    if missing:
        raise SystemExit(f"Missing env vars: {', '.join(missing)} (set them in .env)")

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    all_rows, summary = [], []
    _fetches = 0   # transcript downloads so far (drives the inter-request throttle)
    seen = archived_links()   # videos already summarized — skip to prioritize NEW content
    if seen:
        print(f"Knowledge base has {len(seen)} archived video(s) — skipping those, fetching only new.")

    for a in ANALYSTS:  # already in trust/weight order
        print(f"\n[{a['weight']}] {a['name']} …")
        try:
            entries = fetch_entries(a["channel_id"])
        except Exception as e:
            print(f"    ! RSS failed: {e}")
            summary.append((a["name"], 0)); continue

        # Newest-first (RSS carries publish dates; scrape entries have none and sort
        # last) so a daily run always reaches the freshest videos before the budget
        # runs out. shorts_first analysts keep shorts ahead, newest within each group.
        entries.sort(key=lambda e: e.get("pub") or "", reverse=True)
        if a.get("shorts_first"):
            entries = [e for e in entries if e["is_short"]] + [e for e in entries if not e["is_short"]]

        target = min(int(a.get("videos", 2)), 3)   # collect up to 2-3 insight videos
        found, attempts = 0, 0
        for v in entries:
            if found >= target or attempts >= MAX_SCAN:
                break
            if v["link"] in seen:                    # already in the knowledge base
                print(f"    · already archived: {v['title'][:52]}")
                continue                             # free skip — no request, no throttle
            if _fetches:
                time.sleep(THROTTLE_S)   # pace requests so the run doesn't trip the burst detector
            _fetches += 1; attempts += 1
            transcript = get_transcript(v["vid"])
            if not transcript or len(transcript) < 120:
                print(f"    - no transcript: {v['title'][:60]}")
                continue
            ins = extract_insights(a, v, transcript)
            if not ins:
                print(f"    - no insight (promo/empty): {v['title'][:60]}")
                continue
            seen.add(v["link"])                      # don't re-fetch within this run either
            all_rows.append({
                "analyst_id":     a["id"],
                "analyst_name":   a["name"],
                "label":          a["label"],
                "weight":         a["weight"],
                "video_title":    v["title"],
                "video_link":     v["link"],
                "published_date": v["pub"],
                "insight_summary": "\n".join(ins["insights"]),
                "key_takeaway":   ins["takeaway"],
                "sentiment":      ins["sentiment"],
                "fetched_at":     now_iso,
            })
            found += 1
            print(f"    ✓ {v['title'][:60]}  [{ins['sentiment']}]")
        summary.append((a["name"], found))

    total = sum(n for _, n in summary)
    if all_rows:
        print(f"\nSaving to Supabase … (merging {len({r['analyst_id'] for r in all_rows})} analyst(s); others keep prior insights)")
        save_to_supabase(all_rows)
    else:
        print("\nNothing fetched — existing Market Pulse data left untouched.")

    print("\n" + "=" * 48)
    print("MARKET PULSE — fetch complete")
    print("=" * 48)
    for name, n in summary:
        print(f"  {n} insight(s)  ·  {name}")
    print("-" * 48)
    print(f"  {total} total insight(s) across {len(summary)} analysts")
    if total:
        print(f"  written to market_pulse @ {now_iso}")
    if _IP_BLOCKED:
        print("\n⚠  YouTube IP-BLOCKED transcript downloads from this network.")
        print("   Video discovery worked, but captions couldn't be fetched.")
        print("   Fix: set WEBSHARE_USER/WEBSHARE_PASS (or YT_PROXY=http://user:pass@host:port)")
        print("   in .env to route through a proxy, or re-run later after a cooldown.")


if __name__ == "__main__":
    main()
