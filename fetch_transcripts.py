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

Requires (local):  pip install youtube-transcript-api anthropic python-dotenv
Env (.env in this folder):
    ANTHROPIC_API_KEY=sk-ant-...
    SUPABASE_URL=https://<project>.supabase.co
    SUPABASE_SERVICE_ROLE_KEY=<service_role key>     # NOT the anon key — service role bypasses RLS to write
    (plus the YT_*_CHANNEL_ID overrides, optional — defaults are baked into research.py)
"""

import os, sys, json, datetime, urllib.request, urllib.parse
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

_YT_NS = {
    "atom":  "http://www.w3.org/2005/Atom",
    "yt":    "http://www.youtube.com/xml/schemas/2015",
    "media": "http://search.yahoo.com/mrss/",
}


# ── YouTube RSS (latest video IDs/titles — free, no quota) ────────────────────
def fetch_entries(channel_id):
    url = f"https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
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


# ── Transcript fetch (handles youtube-transcript-api 0.6.x AND 1.x) ───────────
def get_transcript(vid):
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        raise SystemExit("Missing dependency — run:  pip install youtube-transcript-api")
    langs = ["en", "en-US", "en-GB"]
    # 0.6.x classmethod API
    try:
        if hasattr(YouTubeTranscriptApi, "list_transcripts"):
            tl = YouTubeTranscriptApi.list_transcripts(vid)
            try:
                t = tl.find_manually_created_transcript(langs)
            except Exception:
                try:
                    t = tl.find_generated_transcript(langs)
                except Exception:
                    t = next(iter(tl))
            return " ".join(p["text"] for p in t.fetch())
        if hasattr(YouTubeTranscriptApi, "get_transcript"):
            return " ".join(p["text"] for p in YouTubeTranscriptApi.get_transcript(vid, languages=langs))
    except Exception:
        pass
    # 1.x instance API
    try:
        fetched = YouTubeTranscriptApi().fetch(vid, languages=langs)
        try:
            return " ".join(p["text"] for p in fetched.to_raw_data())
        except Exception:
            return " ".join(getattr(s, "text", "") for s in fetched)
    except Exception:
        return None


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
def sb_request(method, path, body=None):
    url = f"{SUPABASE_URL}/rest/v1/{path}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def save_to_supabase(rows):
    # Full refresh: wipe the table, then insert the fresh snapshot.
    sb_request("DELETE", "market_pulse?weight=gte.0")        # PostgREST needs a filter; weight is always >= 0
    if rows:
        sb_request("POST", "market_pulse", rows)


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    missing = [n for n, v in [("SUPABASE_URL", SUPABASE_URL),
                              ("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY),
                              ("ANTHROPIC_API_KEY", ANTHROPIC_KEY)] if not v]
    if missing:
        raise SystemExit(f"Missing env vars: {', '.join(missing)} (set them in .env)")

    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    all_rows, summary = [], []

    for a in ANALYSTS:  # already in trust/weight order
        print(f"\n[{a['weight']}] {a['name']} …")
        try:
            entries = fetch_entries(a["channel_id"])
        except Exception as e:
            print(f"    ! RSS failed: {e}")
            summary.append((a["name"], 0)); continue

        if a.get("shorts_first"):
            entries = [e for e in entries if e["is_short"]] + [e for e in entries if not e["is_short"]]

        target = min(int(a.get("videos", 2)), 3)   # collect up to 2-3 insight videos
        found = 0
        for v in entries[:MAX_SCAN]:
            if found >= target:
                break
            transcript = get_transcript(v["vid"])
            if not transcript or len(transcript) < 120:
                print(f"    - no transcript: {v['title'][:60]}")
                continue
            ins = extract_insights(a, v, transcript)
            if not ins:
                print(f"    - no insight (promo/empty): {v['title'][:60]}")
                continue
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

    print("\nSaving to Supabase …")
    save_to_supabase(all_rows)

    print("\n" + "=" * 48)
    print("MARKET PULSE — fetch complete")
    print("=" * 48)
    total = 0
    for name, n in summary:
        print(f"  {n} insight(s)  ·  {name}")
        total += n
    print("-" * 48)
    print(f"  {total} total insight(s) across {len(summary)} analysts")
    print(f"  written to market_pulse @ {now_iso}")


if __name__ == "__main__":
    main()
