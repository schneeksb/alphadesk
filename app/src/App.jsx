import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Plus, X, Flame, Snowflake, ChevronLeft, RefreshCw, ArrowUpRight, ArrowDownRight, Minus, Star, Newspaper, Loader2, AlertCircle, Bell, Activity, Archive, ChevronDown, Trash2, Settings, Sun, Moon, Pencil, LineChart, GripVertical, ArrowUp, ArrowDown, LogOut, Calendar, Target, Zap } from "lucide-react";
import { authEnabled, supabase } from "./lib/supabase";
import { useSession, signOut } from "./Auth.jsx";


/* ════════════════════════════════════════════════════════════════════
   AlphaDesk — LIVE app  (run locally against research.py backend)
   - Watchlist is home, persists to localStorage
   - Search researches ANY ticker via backend
   - The Briefing Room refreshes EVERY time the app opens/focuses
   - 8 AM alert handled separately by cron (scanner.py → Slack/SMS)

   SET THIS to wherever research.py is served:
   ════════════════════════════════════════════════════════════════════ */
// Production: set VITE_API_URL (e.g. your Render URL). Locally it falls back to the host
// the page was loaded from on :8000, so it works on localhost AND from a phone on the LAN.
const API = import.meta.env.VITE_API_URL
  || `http://${typeof window !== "undefined" ? window.location.hostname : "localhost"}:8000`;

const MONO = "'JetBrains Mono','SF Mono',Menlo,monospace";
const PALETTES = {
  dark: {
    bg:"#0a0e17", panel:"#111722", panel2:"#0d131e", line:"#1e2738",
    ink:"#e8edf6", sub:"#7d8aa3", faint:"#4a5568",
    hot:"#ff6b35", cold:"#3b9eff", up:"#26d07c", down:"#ff4d6a",
    amber:"#f5a623", violet:"#9b7bff",
  },
  light: {
    bg:"#ffffff", panel:"#f6f8fb", panel2:"#eceff4", line:"#dde3ec",
    ink:"#101620", sub:"#586172", faint:"#9aa6b6",
    hot:"#e8590c", cold:"#1c7ed6", up:"#0ca678", down:"#e03131",
    amber:"#e08a00", violet:"#6741d9",
  },
};
const THEME_KEY = "alphadesk:theme";
const loadTheme = () => { try { return localStorage.getItem(THEME_KEY) || "light"; } catch { return "light"; } };
// Mutable palette read by every component at render time; applyTheme swaps values in place,
// and a top-level re-render (theme state) makes the whole tree pick up the new colors.
const C = { ...PALETTES[loadTheme()], mono: MONO };
const applyTheme = (t) => {
  Object.assign(C, PALETTES[t] || PALETTES.light);
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  if (typeof document !== "undefined") {
    document.documentElement.style.background = C.bg;
    document.body.style.background = C.bg;
    document.documentElement.style.colorScheme = t;
  }
};

const DEFAULT_WATCHLIST = ["NVDA","MSFT","PLTR","GOOGL","AMD"];
const WL_KEY = "alphadesk:watchlist";

// ── PERSISTENCE (localStorage works in a real local app) ──────────────
const loadWL = () => {
  try { return JSON.parse(localStorage.getItem(WL_KEY)) || DEFAULT_WATCHLIST; }
  catch { return DEFAULT_WATCHLIST; }
};
const saveWL = (l) => { try { localStorage.setItem(WL_KEY, JSON.stringify(l)); } catch {} };

// Portfolio positions — manually entered, persisted locally (starts empty)
const POS_KEY = "alphadesk:positions";
const loadPositions = () => { try { return JSON.parse(localStorage.getItem(POS_KEY)) || []; } catch { return []; } };
const savePositions = (l) => { try { localStorage.setItem(POS_KEY, JSON.stringify(l)); } catch {} };
const newId = () => (typeof crypto!=="undefined" && crypto.randomUUID) ? crypto.randomUUID() : `p_${Math.random().toString(36).slice(2)}`;

// ── AI INSIGHTS TOGGLE PERSISTENCE ───────────────────────────────────
const AI_KEY  = "alphadesk:ai";
const loadAI  = () => { try { return localStorage.getItem(AI_KEY) === "true"; } catch { return false; } };
const saveAI  = (v) => { try { localStorage.setItem(AI_KEY, v ? "true" : "false"); } catch {} };

const loadProfile = () => {
  try { return JSON.parse(localStorage.getItem("alphadesk:profile") || "null") || null; } catch { return null; }
};
const saveProfile = (p) => { try { localStorage.setItem("alphadesk:profile", JSON.stringify(p)); } catch {} };

// ── ALERT HISTORY (persistent, 30-day rolling window) ─────────────────
const ALERT_KEY    = "alphadesk:alerts";
const ALERT_MAX_MS = 30 * 24 * 60 * 60 * 1000;
const loadAlerts   = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(ALERT_KEY)) || [];
    const cut = Date.now() - ALERT_MAX_MS;
    return raw.filter(a => new Date(a.ts).getTime() > cut);
  } catch { return []; }
};
const saveAlerts = (l) => { try { localStorage.setItem(ALERT_KEY, JSON.stringify(l)); } catch {} };
const alertTimeAgo = (ts) => {
  const m = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};
function mergeAlerts(existing, fresh) {
  if (!fresh?.length) return existing;
  const today = new Date().toISOString().slice(0, 10);
  const seen  = new Set(existing.map(a => `${a.ticker}:${a.type}:${(a.ts||"").slice(0,10)}`));
  const now   = new Date().toISOString();
  const added = fresh
    .filter(a => !seen.has(`${a.ticker}:${a.type}:${today}`))
    .map(a => ({
      id:       newId(),
      ts:       now,
      severity: a.severity === "yellow" ? "amber" : (a.severity || "amber"),
      ticker:   a.ticker,
      type:     a.type,
      message:  a.message,
      read:     false,
      link:     a.ticker === "MACRO" ? "macro" : a.ticker === "PORTFOLIO" ? "portfolio" : `ticker:${a.ticker}`,
    }));
  if (!added.length) return existing;
  const cut = Date.now() - ALERT_MAX_MS;
  return [...added, ...existing].filter(a => new Date(a.ts).getTime() > cut);
}

// ── BACKEND CALLS ─────────────────────────────────────────────────────
async function fetchResearch(ticker, ai = false, profile = "") {
  const r = await fetch(`${API}/research?ticker=${encodeURIComponent(ticker)}&ai=${ai ? 1 : 0}&profile=${encodeURIComponent(profile||"")}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchChart(ticker, range) {
  const r = await fetch(`${API}/chart?ticker=${encodeURIComponent(ticker)}&range=${range}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchBriefing() {
  const r = await fetch(`${API}/briefing`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchSectors() {
  const r = await fetch(`${API}/sectors`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchSector(name) {
  const r = await fetch(`${API}/sector?name=${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchClimate() {
  const r = await fetch(`${API}/climate`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchMapData(tickers = []) {
  const q = tickers.length ? `?tickers=${encodeURIComponent(tickers.join(","))}` : "";
  const r = await fetch(`${API}/map-data${q}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchYtInsights() {
  const r = await fetch(`${API}/yt-insights`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchValue(positions, margin = 0, margin_rate = 0) {
  const r = await fetch(`${API}/value`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions, margin, margin_rate }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchSettings() {
  const r = await fetch(`${API}/settings`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function saveSettingsServer(settings) {
  try {
    await fetch(`${API}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
  } catch { /* offline */ }
}
async function fetchIndicator(symbol, label) {
  const r = await fetch(`${API}/indicator?symbol=${encodeURIComponent(symbol)}&label=${encodeURIComponent(label||"")}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchPositions() {
  const r = await fetch(`${API}/positions`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function savePositionsServer(positions) {
  try {
    await fetch(`${API}/positions`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positions }),
    });
  } catch { /* offline / backend down — localStorage still holds the copy */ }
}
async function fetchCalendar() {
  const r = await fetch(`${API}/calendar`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchSectorRotation() {
  const r = await fetch(`${API}/sectors/rotation`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchOutlook() {
  const r = await fetch(`${API}/outlook`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchPortfolioAnalysis(positions, analytics, cash, profile) {
  const r = await fetch(`${API}/portfolio-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions, analytics, cash, profile }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── SUPABASE CROSS-DEVICE SYNC ────────────────────────────────────────
async function sbLoad(uid) {
  if (!supabase || !uid) return null;
  const { data, error } = await supabase
    .from("portfolios").select("data").eq("user_id", uid).maybeSingle();
  if (error) { console.error("[sb] load error:", error.message); return null; }
  return data?.data ?? null;
}
async function sbSave(uid, payload) {
  if (!supabase || !uid) return;
  const { error } = await supabase.from("portfolios").upsert(
    { user_id: uid, data: payload, updated_at: new Date().toISOString() },
    { onConflict: "user_id" }
  );
  if (error) console.error("[sb] save error:", error.message);
}

// ── HELPERS ───────────────────────────────────────────────────────────
const Trend = ({ v }) => v>0 ? <ArrowUpRight size={13}/> : v<0 ? <ArrowDownRight size={13}/> : <Minus size={13}/>;
const scoreColor = (s) => s==null ? C.faint : s>=7 ? C.up : s>=4 ? C.amber : C.down;

// Lightweight inline price sparkline from an array of closes
function Sparkline({ data, w=120, h=32, color }) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), range = (max - min) || 1;
  const x = (i) => (i/(data.length-1)) * w;
  const y = (v) => h - ((v - min)/range) * (h - 2) - 1;
  const line = data.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const col  = color || (data[data.length-1] >= data[0] ? C.up : C.down);
  const area = `${line} ${w},${h} 0,${h}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display:"block", width:"100%" }}>
      <polygon points={area} fill={col} opacity={0.08}/>
      <polyline points={line} fill="none" stroke={col} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"/>
    </svg>
  );
}
const RANGES = [
  { key:"1d",  label:"1D",  days:null },   // /chart 1d/5m
  { key:"1w",  label:"1W",  days:null },   // /chart 5d/1h (hourly bars)
  { key:"1m",  label:"1M",  days:21 },     // slice from research history
  { key:"3m",  label:"3M",  days:63 },     // slice from research history (default)
  { key:"6m",  label:"6M",  days:126 },    // slice from research history
  { key:"ytd", label:"YTD", days:null },   // /chart ytd/1d
  { key:"1y",  label:"1Y",  days:252 },    // slice from research history (all)
  { key:"2y",  label:"2Y",  days:null },   // /chart 2y/1wk
  { key:"5y",  label:"5Y",  days:null },   // /chart 5y/1wk
];
// Sparkline pills for WatchCard use daily slices (no extra fetch needed)
const SPARK_RANGES = [
  { key:"1w", days:5 }, { key:"1m", days:21 }, { key:"3m", days:63 }, { key:"6m", days:126 },
];

function ChartWithRanges({ ticker, history, history_dates, color, defaultRange="3m" }) {
  const [range, setRange] = useState(defaultRange);
  const [extras, setExtras] = useState({});
  const [fetching, setFetching] = useState(false);

  const rConf = RANGES.find(r => r.key === range);
  let chartData, chartDates;
  if (rConf?.days != null) {
    // Instant — slice from already-loaded research history
    chartData  = (history || []).slice(-rConf.days);
    chartDates = (history_dates || []).slice(-rConf.days);
  } else if (extras[range]) {
    // Cached from a previous /chart fetch
    chartData  = extras[range].history;
    chartDates = extras[range].history_dates;
  } else {
    // Show placeholder while loading (show what we have)
    chartData  = (history || []).slice(-63);
    chartDates = (history_dates || []).slice(-63);
  }

  const handleRange = async (key) => {
    setRange(key);
    const conf = RANGES.find(r => r.key === key);
    if (conf?.days == null && !extras[key] && ticker) {
      setFetching(true);
      try {
        const d = await fetchChart(ticker, key);
        if (!d.error) setExtras(prev => ({ ...prev, [key]: d }));
      } catch {}
      setFetching(false);
    }
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:4 }}>
        <div style={{ display:"flex", gap:1, flexWrap:"wrap" }}>
          {RANGES.map(r => (
            <button key={r.key} onClick={() => handleRange(r.key)}
              style={{ background:range===r.key ? C.line : "transparent", border:"none", borderRadius:5,
                padding:"3px 8px", color:range===r.key ? C.ink : C.faint,
                fontSize:11, fontFamily:C.mono, fontWeight:600, cursor:"pointer", transition:"color .1s",
                minHeight:28 }}
              onMouseEnter={e => { if (range!==r.key) e.currentTarget.style.color=C.sub; }}
              onMouseLeave={e => { if (range!==r.key) e.currentTarget.style.color=C.faint; }}>
              {r.label}
            </button>
          ))}
        </div>
        {!fetching && <span style={{ fontSize:10.5, color:C.faint }}>hover to inspect</span>}
        {fetching && <span style={{ fontSize:10.5, color:C.faint, display:"flex", alignItems:"center", gap:4 }}><Loader2 size={11} style={{ animation:"spin 1s linear infinite" }}/> Loading…</span>}
      </div>
      <InteractiveChart data={chartData} dates={chartDates} color={color}/>
    </div>
  );
}

const stageEmoji = (s) => ({"Breakout":"🚀","Trending":"📈","Coiling":"🔄","Oversold Bounce":"⚡","Resistance Test":"🧱","Running Out of Steam":"😮‍💨","Deteriorating":"⚠️","Collapsing":"🔻"}[s]||"");
const stageColor = (s) => ["Breakout","Trending","Oversold Bounce"].includes(s)?C.up:["Deteriorating","Collapsing"].includes(s)?C.down:["Resistance Test","Running Out of Steam"].includes(s)?C.amber:C.cold;
const convictionColor = (c) => c==="Strong Setup"?C.up:c==="Risky Setup"?C.down:C.amber;
const convictionToRec = (c) => c==="Strong Setup"?"BUY":c==="Risky Setup"?"SELL":"HOLD";
const recColor = (r) => r==="BUY"?C.up : r==="SELL"?C.down : C.amber;

// Hover-to-inspect price chart: crosshair + dot + floating price/date label
function InteractiveChart({ data, dates, color, h=130 }) {
  const [hi, setHi] = useState(null);
  if (!Array.isArray(data) || data.length < 2) return null;
  const W = 1000, PAD = 6;
  const min = Math.min(...data), max = Math.max(...data), range = (max - min) || 1;
  const x = (i) => (i/(data.length-1)) * W;
  const y = (v) => h - PAD - ((v - min)/range) * (h - 2*PAD);
  const line = data.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const col  = color || (data[data.length-1] >= data[0] ? C.up : C.down);
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel  = (e.clientX - rect.left) / rect.width;
    setHi(Math.max(0, Math.min(data.length-1, Math.round(rel*(data.length-1)))));
  };
  const pctFromStart = hi!=null ? ((data[hi]/data[0]-1)*100) : 0;
  return (
    <div style={{ position:"relative" }} onMouseMove={onMove} onMouseLeave={()=>setHi(null)}>
      <svg width="100%" height={h} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ display:"block", overflow:"visible" }}>
        <polygon points={`${line} ${W},${h} 0,${h}`} fill={col} opacity={0.09}/>
        <polyline points={line} fill="none" stroke={col} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"/>
        {hi!=null && <line x1={x(hi)} y1={0} x2={x(hi)} y2={h} stroke={C.faint} strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke"/>}
        {hi!=null && <circle cx={x(hi)} cy={y(data[hi])} r={4} fill={col} stroke={C.bg} strokeWidth={2} vectorEffect="non-scaling-stroke"/>}
      </svg>
      {hi!=null && (
        <div style={{ position:"absolute", top:-2, left:`${(hi/(data.length-1))*100}%`, transform:`translateX(${hi > data.length*0.7 ? "-105%" : hi < data.length*0.3 ? "5%" : "-50%"})`, pointerEvents:"none", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:7, padding:"5px 9px", fontSize:11, fontFamily:C.mono, whiteSpace:"nowrap", color:C.ink, boxShadow:"0 6px 18px rgba(0,0,0,0.25)" }}>
          <span style={{ fontWeight:700 }}>${data[hi]}</span>
          <span style={{ color: pctFromStart>=0?C.up:C.down, marginLeft:7 }}>{pctFromStart>=0?"+":""}{pctFromStart.toFixed(1)}%</span>
          {dates && dates[hi] && <span style={{ color:C.faint, marginLeft:7 }}>{dates[hi]}</span>}
        </div>
      )}
    </div>
  );
}


// ── WATCHLIST CARD (fetches its own data) ─────────────────────────────
function WatchCard({ ticker, onOpen, onRemove, aiEnabled, onData, profile }) {
  const [d, setD]       = useState(null);
  const [err, setErr]   = useState(false);
  const [sparkRange, setSparkRange] = useState("1m");
  useEffect(()=>{
    let alive = true;
    setD(null); setErr(false);
    fetchResearch(ticker, aiEnabled, profile).then(x=>{ if(alive){ x.error?setErr(true):(setD(x), onData?.(ticker, x)); }}).catch(()=>alive&&setErr(true));
    return ()=>{ alive=false; };
  },[ticker, aiEnabled, profile]);

  if (err) return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 17px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <div><span style={{ fontWeight:700, color:C.ink }}>{ticker}</span>
        <div style={{ fontSize:10.5, color:C.down, marginTop:3, display:"flex", alignItems:"center", gap:4 }}><AlertCircle size={11}/> couldn't load</div></div>
      <button onClick={()=>onRemove(ticker)} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={15}/></button>
    </div>
  );
  if (!d) return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 17px", display:"flex", alignItems:"center", gap:10, color:C.faint, height:118 }}>
      <Loader2 size={15} style={{ animation:"spin 1s linear infinite" }}/> <span style={{ fontSize:12 }}>{ticker}…</span>
    </div>
  );
  return (
    <div onClick={()=>onOpen(ticker)} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 17px", cursor:"pointer", transition:"border-color .15s" }}
      onMouseEnter={e=>e.currentTarget.style.borderColor=C.faint}
      onMouseLeave={e=>e.currentTarget.style.borderColor=C.line}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontWeight:700, fontSize:16, color:C.ink }}>{ticker}</span>
            {d.signal==="hot" && <Flame size={13} color={C.hot}/>}
            {d.signal==="cold" && <Snowflake size={13} color={C.cold}/>}
          </div>
          <div style={{ fontSize:11, color:C.faint, marginTop:2, maxWidth:150, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.name}</div>
        </div>
        <button onClick={(e)=>{e.stopPropagation();onRemove(ticker);}} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:2 }}
          onMouseEnter={e=>e.currentTarget.style.color=C.down} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><X size={15}/></button>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div>
          <div style={{ fontFamily:C.mono, fontSize:19, color:C.ink, fontWeight:600 }}>${d.spot}</div>
          <div style={{ fontFamily:C.mono, fontSize:12, color:d.chg>=0?C.up:C.down, display:"flex", alignItems:"center", gap:3 }}><Trend v={d.chg}/>{d.chg>=0?"+":""}{d.chg}%</div>
          {d.analyst?.targetMean && d.spot && (() => {
            const upside = ((d.analyst.targetMean - d.spot) / d.spot * 100);
            return <div style={{ fontFamily:C.mono, fontSize:10, color:upside>=0?C.up:C.down, marginTop:2 }}>{upside>=0?"+":""}{upside.toFixed(0)}% to target · {(d.analyst.recKey||"").replace(/_/g," ")}</div>;
          })()}
        </div>
        <div style={{ textAlign:"right" }}>
          {/* Always-visible signal: AI conviction when available, RSI-based fallback otherwise */}
          {aiEnabled && d.ai_error && d.ai_error !== "ai_disabled" ? (
            <span style={{ fontSize:10, color:C.amber, fontWeight:600 }}>API error</span>
          ) : d.stage ? (
            <>
              <div style={{ fontFamily:C.mono, fontSize:12, fontWeight:800, letterSpacing:"0.07em", color:recColor(convictionToRec(d.conviction)), marginBottom:2 }}>{convictionToRec(d.conviction)}</div>
              <div style={{ fontSize:11, fontWeight:700, color:stageColor(d.stage), lineHeight:1.3 }}>{stageEmoji(d.stage)} {d.stage}</div>
              {d.conviction && <div style={{ fontSize:9.5, color:convictionColor(d.conviction), marginTop:2, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.04em" }}>{d.conviction}</div>}
            </>
          ) : !aiEnabled && d.rsi ? (
            <div style={{ fontFamily:C.mono, fontSize:12, fontWeight:800, letterSpacing:"0.07em",
              color: d.rsi < 35 ? C.up : d.rsi > 70 ? C.down : C.amber }}>
              {d.rsi < 35 ? "OVERSOLD" : d.rsi > 70 ? "OVERBOUGHT" : "HOLD"}
            </div>
          ) : aiEnabled ? (
            <span style={{ fontSize:10, color:C.faint }}>Analyzing…</span>
          ) : null}
          {/* Earnings badge */}
          {d.daysToEarn != null && d.daysToEarn >= 0 && d.daysToEarn <= 30 && (
            <div style={{ marginTop:4, fontSize:9.5, fontWeight:700, color: d.daysToEarn <= 7 ? C.amber : C.violet,
              background: d.daysToEarn <= 7 ? `${C.amber}18` : `${C.violet}18`,
              borderRadius:4, padding:"1px 6px", display:"inline-block", fontFamily:C.mono }}>
              ER {d.daysToEarn}d
            </div>
          )}
        </div>
      </div>
      {d.history && (
        <div style={{ marginTop:10 }} onClick={e => e.stopPropagation()}>
          <div style={{ display:"flex", gap:1, marginBottom:4 }}>
            {SPARK_RANGES.map(r => (
              <button key={r.key} onClick={()=>setSparkRange(r.key)}
                style={{ background:sparkRange===r.key?C.line:"transparent", border:"none", borderRadius:4,
                  padding:"1px 6px", color:sparkRange===r.key?C.ink:C.faint,
                  fontSize:9.5, fontFamily:C.mono, fontWeight:600, cursor:"pointer", minHeight:22 }}>
                {r.key.toUpperCase()}
              </button>
            ))}
          </div>
          <Sparkline data={d.history.slice(-(SPARK_RANGES.find(r=>r.key===sparkRange)?.days||21))} h={30} color={d.chg>=0?C.up:C.down}/>
        </div>
      )}

      {/* 52-week range bar */}
      {d.week52High && d.week52Low && (
        <div style={{ marginTop:8 }}>
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:8.5, color:C.faint, fontFamily:C.mono, marginBottom:2 }}>
            <span>${d.week52Low}</span><span>52W</span><span>${d.week52High}</span>
          </div>
          <div style={{ height:3, background:C.line, borderRadius:2, overflow:"hidden" }}>
            <div style={{ height:"100%", borderRadius:2,
              width:`${Math.min(100,Math.max(0,((d.spot-d.week52Low)/(d.week52High-d.week52Low))*100))}%`,
              background: d.spot >= d.week52High*0.95 ? C.up : d.spot <= d.week52Low*1.05 ? C.down : C.cold,
            }}/>
          </div>
        </div>
      )}

      {/* Chips */}
      <div style={{ display:"flex", gap:6, marginTop:9, flexWrap:"wrap" }}>
        <span style={{ fontFamily:C.mono, fontSize:10, color:C.sub, background:C.panel2, padding:"2px 7px", borderRadius:4 }}>RSI {d.rsi}</span>
        {d.iv   && <span style={{ fontFamily:C.mono, fontSize:10, color:C.amber,  background:`${C.amber}14`,  padding:"2px 7px", borderRadius:4 }}>IV {d.iv}%</span>}
        {d.relVol >= 1.5 && <span style={{ fontFamily:C.mono, fontSize:10, color:C.amber, background:`${C.amber}14`, padding:"2px 7px", borderRadius:4 }}>{d.relVol}× vol</span>}
        {d.daysToEarn != null && d.daysToEarn <= 45 && <span style={{ fontFamily:C.mono, fontSize:10, color:C.violet, background:`${C.violet}14`, padding:"2px 7px", borderRadius:4 }}>Earn {d.daysToEarn}d</span>}
        {d.pcRatio != null && <span style={{ fontFamily:C.mono, fontSize:10, color:d.pcRatio>1.2?C.down:d.pcRatio<0.8?C.up:C.sub, background:C.panel2, padding:"2px 7px", borderRadius:4 }}>P/C {d.pcRatio}</span>}
        {d.play && <span style={{ fontFamily:C.mono, fontSize:10, color:C.up, background:`${C.up}14`, padding:"2px 7px", borderRadius:4 }}>PLAY ✓</span>}
      </div>
      {d.reason && aiEnabled && !(d.ai_error && d.ai_error !== "ai_disabled") && (
        <div style={{ fontSize:10.5, color:C.sub, marginTop:9, lineHeight:1.45, borderTop:`1px solid ${C.line}`, paddingTop:9, fontStyle:"italic" }}>{d.reason}</div>
      )}
    </div>
  );
}

function YahooNewsItem({ n }) {
  return (
    <div style={{ padding:"12px 0", borderBottom:`1px solid ${C.panel2}`, display:"flex", gap:10, alignItems:"flex-start" }}>
      <div style={{ width:3, flexShrink:0, alignSelf:"stretch", background:C.line, borderRadius:2 }}/>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:13, color:C.ink, lineHeight:1.5, marginBottom:4 }}>{n.headline}</div>
        <div style={{ fontSize:10.5, color:C.faint, fontFamily:C.mono }}>{n.source} · {n.time}</div>
      </div>
    </div>
  );
}

function NewsItem({ n }) {
  const col = scoreColor(n.score);
  return (
    <div style={{ display:"flex", gap:13, padding:"13px 0", borderBottom:`1px solid ${C.panel2}` }}>
      <div style={{ flexShrink:0, width:38, textAlign:"center" }}>
        <div style={{ fontFamily:C.mono, fontSize:18, fontWeight:700, color:col }}>{n.score}</div>
        <div style={{ fontSize:8.5, color:C.faint, letterSpacing:"0.04em", textTransform:"uppercase" }}>{n.sentiment}</div>
      </div>
      <div style={{ width:3, background:col, borderRadius:2, opacity:0.6 }}/>
      <div style={{ flex:1 }}>
        <div style={{ fontSize:13, color:C.ink, lineHeight:1.5, marginBottom:5 }}>{n.headline}</div>
        <div style={{ fontSize:10.5, color:C.faint, fontFamily:C.mono }}>{n.source} · {n.time}</div>
      </div>
    </div>
  );
}

// ── DETAIL PAGE ───────────────────────────────────────────────────────
function DetailPage({ ticker, onBack, inWatchlist, onToggleWatch, aiEnabled, profile }) {
  const [d, setD]   = useState(null);
  const [err, setErr] = useState(null);
  const [whyNow, setWhyNow]       = useState(null);
  const [whyLoading, setWhyLoading] = useState(false);
  useEffect(()=>{
    setD(null); setErr(null);
    fetchResearch(ticker, aiEnabled, profile).then(x=> x.error ? setErr(x.error) : setD(x)).catch(e=>setErr(e.message));
  },[ticker, aiEnabled, profile]);

  const fetchWhyNow = useCallback(async () => {
    setWhyLoading(true); setWhyNow(null);
    try {
      const r = await fetch(`${API}/why-now?ticker=${ticker}&profile=${encodeURIComponent(profile||"")}`);
      const j = await r.json();
      setWhyNow(j.error ? null : j.take);
    } catch { setWhyNow(null); }
    finally { setWhyLoading(false); }
  }, [ticker, profile]);

  if (err) return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"20px 26px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.cold, cursor:"pointer", display:"flex", gap:5, alignItems:"center", marginBottom:18, fontSize:13 }}><ChevronLeft size={16}/> Back</button>
      <div style={{ color:C.down, fontSize:13 }}>Couldn't load {ticker}: {err}</div>
    </div>
  );
  if (!d) return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"60px 26px", textAlign:"center", color:C.sub }}>
      <Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/> <div style={{ marginTop:10 }}>{aiEnabled ? `Researching ${ticker} with AI…` : `Loading ${ticker}…`}</div>
    </div>
  );

  const aiOk    = aiEnabled && d.score != null;
  const aiFail  = aiEnabled && d.ai_error && d.ai_error !== "ai_disabled";
  const newsAvg = d.news?.length ? (d.news.reduce((s,n)=>s+n.score,0)/d.news.length).toFixed(1) : "—";

  return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"16px 14px 60px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.cold, cursor:"pointer", display:"flex", gap:5, alignItems:"center", marginBottom:18, fontSize:13 }}><ChevronLeft size={16}/> Back</button>

      {/* ── Header ─────────────────────────────────────────── */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:22 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:11 }}>
            <span style={{ fontSize:28, fontWeight:800, color:C.ink, letterSpacing:"-0.02em" }}>{ticker}</span>
            {aiOk && d.signal==="hot"  && <Flame     size={20} color={C.hot}/>}
            {aiOk && d.signal==="cold" && <Snowflake size={20} color={C.cold}/>}
          </div>
          <div style={{ fontSize:13, color:C.sub, marginTop:3 }}>{d.name} · {d.sector} · {d.mktCap}</div>
        </div>
        <button onClick={()=>onToggleWatch(ticker)} style={{ background:inWatchlist?`${C.amber}18`:C.panel, border:`1px solid ${inWatchlist?C.amber:C.line}`, borderRadius:9, padding:"9px 14px", color:inWatchlist?C.amber:C.sub, cursor:"pointer", display:"flex", gap:7, alignItems:"center", fontSize:12.5, fontWeight:500 }}>
          <Star size={14} fill={inWatchlist?C.amber:"none"}/> {inWatchlist?"Watching":"Add to Watchlist"}
        </button>
      </div>

      {/* ── Price + Score row ──────────────────────────────── */}
      <div style={{ display:"flex", gap:14, marginBottom:22, flexWrap:"wrap" }}>
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1 }}>
          <div style={{ fontFamily:C.mono, fontSize:30, color:C.ink, fontWeight:600 }}>${d.spot}</div>
          <div style={{ fontFamily:C.mono, fontSize:14, color:d.chg>=0?C.up:C.down, display:"flex", alignItems:"center", gap:4, marginTop:2 }}><Trend v={d.chg}/>{d.chg>=0?"+":""}{d.chg}% today</div>
          {d.week52High && d.week52Low && (() => {
            const pct = Math.min(100,Math.max(0,((d.spot-d.week52Low)/(d.week52High-d.week52Low))*100));
            return (
              <div style={{ marginTop:12 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:C.faint, fontFamily:C.mono, marginBottom:3 }}>
                  <span>52W L ${d.week52Low}</span><span style={{ color:C.sub }}>{pct.toFixed(0)}th pct</span><span>52W H ${d.week52High}</span>
                </div>
                <div style={{ height:4, background:C.line, borderRadius:3, overflow:"hidden" }}>
                  <div style={{ height:"100%", borderRadius:3, width:`${pct}%`,
                    background: pct>=90?C.up:pct<=10?C.down:C.cold }}/>
                </div>
              </div>
            );
          })()}
        </div>
        {aiOk ? (
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1, display:"flex", alignItems:"flex-start", gap:14 }}>
            <div style={{ fontSize:38, lineHeight:1, flexShrink:0, marginTop:2 }}>{stageEmoji(d.stage) || "🔍"}</div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.08em", marginBottom:5 }}>30-DAY SIGNAL</div>
              {d.conviction && <div style={{ fontFamily:C.mono, fontSize:20, fontWeight:800, letterSpacing:"0.08em", color:recColor(convictionToRec(d.conviction)), marginBottom:4 }}>{convictionToRec(d.conviction)}</div>}
              <div style={{ fontSize:14, fontWeight:700, color:stageColor(d.stage)||C.sub, marginBottom:d.conviction?6:0 }}>{d.stage || "—"}</div>
              {d.conviction && (
                <span style={{ fontFamily:C.mono, fontSize:9.5, fontWeight:700,
                  color:convictionColor(d.conviction),
                  background:`${convictionColor(d.conviction)}14`,
                  border:`1px solid ${convictionColor(d.conviction)}40`,
                  borderRadius:5, padding:"2px 8px" }}>{d.conviction}</span>
              )}
              {d.reason && <div style={{ fontSize:11.5, color:C.sub, marginTop:8, lineHeight:1.5, fontStyle:"italic" }}>{d.reason}</div>}
            </div>
          </div>
        ) : (
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1, display:"flex", alignItems:"center", gap:14, opacity:0.55 }}>
            <div style={{ fontSize:38, lineHeight:1, flexShrink:0 }}>🔍</div>
            <div>
              <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.08em" }}>30-DAY SIGNAL</div>
              <div style={{ fontSize:13, color:C.faint, fontWeight:500, marginTop:4 }}>{aiFail ? "API error" : "AI Insights off"}</div>
              <div style={{ fontSize:10.5, color:C.faint, marginTop:3 }}>enable in Settings →</div>
            </div>
          </div>
        )}
      </div>

      {/* ── Price Chart ────────────────────────────────────── */}
      {d.history && (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px 12px", marginBottom:14 }}>
          <ChartWithRanges ticker={ticker} history={d.history} history_dates={d.history_dates} color={d.chg>=0?C.up:C.down}/>
        </div>
      )}

      {/* ── Analyst Consensus ─────────────────────────────── */}
      {d.analyst?.targetMean && d.spot && (() => {
        const upside = ((d.analyst.targetMean - d.spot) / d.spot * 100);
        const low = d.analyst.targetLow || d.spot * 0.85;
        const high = d.analyst.targetHigh || d.spot * 1.25;
        const range = high - low || 1;
        const spotPct = Math.min(100, Math.max(0, ((d.spot - low) / range) * 100));
        const meanPct = Math.min(100, Math.max(0, ((d.analyst.targetMean - low) / range) * 100));
        return (
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                <Target size={14} color={C.sub}/>
                <span style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase" }}>Analyst Consensus</span>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                {d.analyst.recKey && <span style={{ fontFamily:C.mono, fontSize:11, fontWeight:700, color:upside>=10?C.up:upside<=-5?C.down:C.amber, textTransform:"capitalize" }}>{d.analyst.recKey.replace(/_/g," ")}</span>}
                {d.analyst.count && <span style={{ fontSize:10.5, color:C.faint }}>{d.analyst.count} analysts</span>}
              </div>
            </div>
            <div style={{ position:"relative", height:6, background:C.line, borderRadius:3, marginBottom:6 }}>
              <div style={{ position:"absolute", left:`${meanPct}%`, top:-3, height:12, width:2, background:C.sub, borderRadius:1, transform:"translateX(-50%)"}}/>
              <div style={{ position:"absolute", left:`${spotPct}%`, top:-4, width:14, height:14, background:upside>=0?C.up:C.down, border:`2px solid ${C.bg}`, borderRadius:"50%", transform:"translateX(-50%)", zIndex:1 }}/>
            </div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:9.5, color:C.faint, fontFamily:C.mono, marginBottom:8 }}>
              <span>L ${d.analyst.targetLow?.toFixed(0)}</span>
              <span style={{ color:upside>=0?C.up:C.down, fontSize:11 }}>{upside>=0?"+":""}{upside.toFixed(1)}% upside</span>
              <span>H ${d.analyst.targetHigh?.toFixed(0)}</span>
            </div>
            <div style={{ textAlign:"center", fontSize:12, color:C.ink }}>Mean target <span style={{ fontFamily:C.mono, fontWeight:700 }}>${d.analyst.targetMean?.toFixed(2)}</span></div>
          </div>
        );
      })()}

      {/* ── Technicals grid (always) ───────────────────────── */}
      {d.fundamentals && (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:10, marginBottom:14 }}>
          {Object.entries({
            "P/E":          d.fundamentals.pe,
            "Rev Growth":   d.fundamentals.revGrowth,
            "Gross Margin": d.fundamentals.grossMargin,
            "RSI":          d.rsi,
            "IV":           d.iv ? `${d.iv}%` : "—",
            "P/C Ratio":    d.pcRatio ?? "—",
            "Rel Vol":      d.relVol  ? `${d.relVol}×` : "—",
            "Earnings":     d.fundamentals.nextEarnings + (d.daysToEarn != null ? ` (${d.daysToEarn}d)` : ""),
          }).map(([k,v])=>(
            <div key={k} style={{ background:C.panel2, border:`1px solid ${C.line}`, borderRadius:9, padding:"10px 12px" }}>
              <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.05em" }}>{k.toUpperCase()}</div>
              <div style={{ fontFamily:C.mono, fontSize:13, color:
                k==="P/C Ratio" && d.pcRatio ? (d.pcRatio>1.2?C.down:d.pcRatio<0.8?C.up:C.ink) :
                k==="Rel Vol"   && d.relVol   ? (d.relVol>=1.5?C.amber:C.ink) : C.ink,
                marginTop:3 }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── AI error banner ────────────────────────────────── */}
      {aiFail && (
        <div style={{ background:`${C.amber}12`, border:`1px solid ${C.amber}40`, borderRadius:10, padding:"11px 14px", marginBottom:14, fontSize:12.5, color:C.amber }}>
          AI analysis unavailable{/credit|balance/i.test(d.ai_error) ? " — Anthropic API credits exhausted" : `: ${d.ai_error}`}. Technical data above is still live.
        </div>
      )}

      {/* ── AI: 30-day forward analysis */}
      {aiOk && (d.outlook_30d || d.summary) && (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
            <span style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase" }}>30-Day Outlook</span>
            {d.setup && (
              <span style={{
                fontFamily:C.mono, fontSize:10, fontWeight:700, marginLeft:"auto",
                color:    d.setup==="strong"?C.up    : d.setup==="risky"?C.down    : C.amber,
                background:d.setup==="strong"?`${C.up}14`: d.setup==="risky"?`${C.down}14`: `${C.amber}14`,
                border:`1px solid ${d.setup==="strong"?C.up+"50":d.setup==="risky"?C.down+"50":C.amber+"50"}`,
                borderRadius:6, padding:"2px 9px",
              }}>{d.setup==="strong"?"STRONG SETUP":d.setup==="risky"?"RISKY SETUP":"WAIT & SEE"}</span>
            )}
          </div>
          <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65, marginBottom:(d.catalysts?.length||d.risks?.length)?14:0 }}>
            {d.outlook_30d || d.summary}
          </div>
          {(d.catalysts?.length > 0 || d.risks?.length > 0) && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:d.options_read?12:0 }}>
              {d.catalysts?.length > 0 && (
                <div style={{ background:`${C.up}0c`, border:`1px solid ${C.up}30`, borderRadius:9, padding:"10px 12px" }}>
                  <div style={{ fontSize:9.5, color:C.up, letterSpacing:"0.07em", marginBottom:7 }}>UPSIDE CATALYSTS</div>
                  {d.catalysts.map((c,i)=><div key={i} style={{ fontSize:12, color:C.ink, lineHeight:1.5, marginBottom:4 }}>↑ {c}</div>)}
                </div>
              )}
              {d.risks?.length > 0 && (
                <div style={{ background:`${C.amber}0c`, border:`1px solid ${C.amber}30`, borderRadius:9, padding:"10px 12px" }}>
                  <div style={{ fontSize:9.5, color:C.amber, letterSpacing:"0.07em", marginBottom:7 }}>KEY RISKS</div>
                  {d.risks.map((r,i)=><div key={i} style={{ fontSize:12, color:C.ink, lineHeight:1.5, marginBottom:4 }}>⚠ {r}</div>)}
                </div>
              )}
            </div>
          )}
          {d.options_read && (
            <div style={{ background:C.panel2, borderRadius:8, padding:"9px 12px", fontSize:12, color:C.sub, lineHeight:1.55 }}>
              <span style={{ color:C.violet, fontWeight:600 }}>Smart money signal: </span>{d.options_read}
            </div>
          )}
        </div>
      )}

      {aiOk && d.trade_levels && (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
          <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>Today's Play</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4, 1fr)", gap:10 }}>
            {[
              ["ENTRY",  `$${d.trade_levels.entry}`,       C.cold],
              ["TARGET", `$${d.trade_levels.target}`,      C.up  ],
              ["STOP",   `$${d.trade_levels.stop}`,        C.down],
              ["R:R",    d.trade_levels.risk_reward || "—",C.amber],
            ].map(([label, value, col]) => (
              <div key={label} style={{ background:C.panel2, borderRadius:9, padding:"10px 12px", textAlign:"center" }}>
                <div style={{ fontSize:9, color:C.faint, letterSpacing:"0.07em", marginBottom:5 }}>{label}</div>
                <div style={{ fontFamily:C.mono, fontSize:14, fontWeight:700, color:col }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {aiEnabled && (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: whyNow ? 12 : 0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <Zap size={14} color={C.violet}/>
              <span style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase" }}>Why Now?</span>
            </div>
            <button onClick={fetchWhyNow} disabled={whyLoading}
              style={{ background:C.violet, border:"none", borderRadius:7, padding:"6px 14px", color:"#fff", cursor:whyLoading?"wait":"pointer", fontSize:11.5, fontWeight:700, opacity:whyLoading?0.7:1, display:"flex", alignItems:"center", gap:6 }}>
              {whyLoading ? <><Loader2 size={11} style={{ animation:"spin 1s linear infinite" }}/> Thinking…</> : "Re-evaluate today"}
            </button>
          </div>
          {whyNow && <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65 }}>{whyNow}</div>}
          {!whyNow && !whyLoading && <div style={{ fontSize:11, color:C.faint, marginTop:6 }}>Get a fresh take on today's specific price action.</div>}
        </div>
      )}

      {/* ── News ───────────────────────────────────────────── */}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <Newspaper size={15} color={C.sub}/>
            <span style={{ fontSize:13, fontWeight:600, color:C.ink }}>Top News</span>
            {aiOk && <span style={{ fontSize:11, color:C.faint }}>— AI-scored</span>}
          </div>
          {aiOk && d.news?.length > 0 && (
            <div style={{ display:"flex", alignItems:"center", gap:7 }}>
              <span style={{ fontSize:10, color:C.faint }}>NEWS AVG</span>
              <span style={{ fontFamily:C.mono, fontSize:14, fontWeight:700, color:scoreColor(parseFloat(newsAvg)||0) }}>{newsAvg}</span>
            </div>
          )}
        </div>
        {aiOk && d.news?.length > 0
          ? d.news.map((n,i)=><NewsItem key={i} n={n}/>)
          : (d.yahoo_news?.length > 0
              ? d.yahoo_news.map((n,i)=><YahooNewsItem key={i} n={n}/>)
              : <div style={{ fontSize:12.5, color:C.faint, padding:"6px 0" }}>No recent headlines found.</div>
            )
        }
      </div>

      {/* ── Suggested Play (AI only) ───────────────────────── */}
      {aiOk && d.play && (
        <div style={{ background:`${C.up}0c`, border:`1px solid ${C.up}33`, borderRadius:12, padding:"16px 18px" }}>
          <div style={{ fontSize:10.5, color:C.up, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:9 }}>Suggested Play</div>
          <div style={{ fontFamily:C.mono, fontSize:15, color:C.ink, marginBottom:8 }}>${d.play.strike} {d.play.direction} · exp {d.play.expiry} · {d.play.dte}d · ~${d.play.premium}</div>
          <div style={{ display:"flex", gap:8 }}>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.up, background:`${C.up}18`, padding:"3px 9px", borderRadius:5 }}>{d.play.conviction} conviction</span>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.sub, background:C.panel2, padding:"3px 9px", borderRadius:5 }}>breakeven ${(d.play.direction==="PUT" ? d.play.strike-d.play.premium : d.play.strike+d.play.premium).toFixed(2)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function EconomicCalendar({ events }) {
  if (!events?.length) return null;
  const cfg = {
    fomc: { label:"FOMC", color:C.violet },
    cpi:  { label:"CPI",  color:C.amber  },
    nfp:  { label:"JOBS", color:C.cold   },
    pce:  { label:"PCE",  color:C.sub    },
    opex: { label:"OPEX", color:C.hot    },
  };
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"14px 16px", marginBottom:14 }}>
      <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:10 }}>
        <Calendar size={14} color={C.sub}/>
        <span style={{ fontSize:12, fontWeight:700, color:C.ink }}>Market Calendar — next 90 days</span>
      </div>
      <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
        {events.map((e,i)=>{
          const c = cfg[e.type] || cfg.pce;
          const isNear = e.days_away <= 14;
          const dateStr = new Date(e.date+"T12:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"});
          return (
            <div key={i} title={e.detail} style={{
              display:"flex", alignItems:"center", gap:5,
              background: isNear ? `${c.color}16` : C.panel2,
              border:`1px solid ${isNear ? c.color+"50" : C.line}`,
              borderRadius:7, padding:"5px 10px", cursor:"default"
            }}>
              <span style={{ fontFamily:C.mono, fontSize:9.5, fontWeight:700, color:c.color }}>{c.label}</span>
              <span style={{ fontSize:11, color:C.ink }}>{dateStr}</span>
              <span style={{ fontSize:10, color:C.faint }}>{e.days_away===0?"today":`${e.days_away}d`}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── BRIEFING ROOM (refreshes every open/focus) ────────────────────────
function BriefingRoom() {
  const [b, setB]           = useState(null);
  const [outlook, setOutlook] = useState(null);
  const [calendar, setCalendar] = useState(null);
  const [err, setErr]       = useState(null);
  const [updated, setUpdated] = useState(null);
  const [selSector, setSelSector] = useState(null);

  const load = useCallback(()=>{
    setErr(null);
    fetchBriefing().then(x=>{ setB(x); setUpdated(new Date()); }).catch(e=>setErr(e.message));
    fetchCalendar().then(x=>setCalendar(x.events || [])).catch(()=>{});
    fetchOutlook().then(x=>{ if(!x.error) setOutlook(x); }).catch(()=>{});
  },[]);

  useEffect(()=>{
    load();
    const onFocus = ()=>load();
    const onVis   = ()=>{ if(!document.hidden) load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return ()=>{ window.removeEventListener("focus",onFocus); document.removeEventListener("visibilitychange",onVis); };
  },[load]);

  if (err) return <div style={{ padding:40, textAlign:"center", color:C.down }}>News unavailable: {err}<br/><span style={{ color:C.faint, fontSize:12 }}>Is the backend running on {API}?</span></div>;
  if (!b)  return <div style={{ padding:60, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Loading…</div></div>;

  const sc = b.climate?.macro_score ?? 50;
  const scoreCol = sc>60?C.up:sc>35?C.amber:C.down;
  const regimeCol = r => ({bull:C.up,volatile:C.amber,neutral:C.amber,bear:C.down}[r]||C.amber);

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:14 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>Market Intelligence</div>
        <div style={{ fontSize:11, color:C.faint, fontFamily:C.mono }}>updated {updated?.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
      </div>

      {/* Economic Calendar */}
      {calendar && <EconomicCalendar events={calendar}/>}

      {/* 1-3 Month Outlook */}
      {outlook && (
        <div style={{ background:C.panel, border:`1px solid ${regimeCol(outlook.regime)}40`, borderRadius:14, padding:"18px 20px", marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:7, marginBottom:10 }}>
            <Zap size={14} color={regimeCol(outlook.regime)}/>
            <span style={{ fontSize:12, fontWeight:700, color:C.ink }}>1-3 Month Outlook</span>
            <span style={{ fontFamily:C.mono, fontSize:11, color:regimeCol(outlook.regime), textTransform:"uppercase", marginLeft:"auto" }}>{outlook.regime}</span>
          </div>
          {outlook.headline && <div style={{ fontSize:15, fontWeight:700, color:C.ink, marginBottom:8 }}>{outlook.headline}</div>}
          {outlook.summary  && <div style={{ fontSize:13, color:C.sub, lineHeight:1.65, marginBottom:12 }}>{outlook.summary}</div>}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginBottom:10 }}>
            {outlook.overweight?.length>0 && (
              <div style={{ background:`${C.up}0c`, border:`1px solid ${C.up}30`, borderRadius:9, padding:"10px 12px" }}>
                <div style={{ fontSize:9.5, color:C.up, letterSpacing:"0.07em", marginBottom:6 }}>OVERWEIGHT</div>
                {outlook.overweight.map((x,i)=><div key={i} style={{ fontSize:12, color:C.ink, marginBottom:3 }}>↑ {x}</div>)}
              </div>
            )}
            {outlook.underweight?.length>0 && (
              <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}30`, borderRadius:9, padding:"10px 12px" }}>
                <div style={{ fontSize:9.5, color:C.down, letterSpacing:"0.07em", marginBottom:6 }}>UNDERWEIGHT</div>
                {outlook.underweight.map((x,i)=><div key={i} style={{ fontSize:12, color:C.ink, marginBottom:3 }}>↓ {x}</div>)}
              </div>
            )}
          </div>
          {outlook.key_risks?.length>0 && (
            <div style={{ marginBottom:10 }}>
              <div style={{ fontSize:9.5, color:C.amber, letterSpacing:"0.07em", marginBottom:5 }}>KEY RISKS</div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {outlook.key_risks.map((r,i)=>(
                  <span key={i} style={{ fontSize:11, color:C.amber, background:`${C.amber}14`, border:`1px solid ${C.amber}30`, borderRadius:6, padding:"3px 9px" }}>⚠ {r}</span>
                ))}
              </div>
            </div>
          )}
          {outlook.positioning && (
            <div style={{ background:C.panel2, borderRadius:8, padding:"9px 11px", fontSize:12, color:C.sub, lineHeight:1.55 }}>
              <span style={{ color:C.violet, fontWeight:600 }}>Options positioning:</span> {outlook.positioning}
            </div>
          )}
        </div>
      )}

      {/* Macro Climate */}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"18px 20px", marginBottom:14, display:"flex", gap:22, alignItems:"center" }}>
        <div style={{ textAlign:"center", paddingRight:22, borderRight:`1px solid ${C.line}`, flexShrink:0 }}>
          <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.1em", marginBottom:4 }}>MACRO</div>
          <div style={{ fontFamily:C.mono, fontSize:34, fontWeight:700, color:scoreCol, lineHeight:1 }}>{sc}</div>
          <div style={{ fontSize:9.5, color:C.faint, marginTop:3 }}>0 stress · 100 calm</div>
        </div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:11, color:scoreCol, fontWeight:600, marginBottom:5 }}>{(b.climate?.posture||"").toUpperCase()}</div>
          <div style={{ fontSize:13, color:C.sub, lineHeight:1.6 }}>{b.climate_note}</div>
        </div>
      </div>

      {/* Hot / Not */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:18, marginBottom:14 }}>
        {[["hot",b.hot,C.hot,"What's Hot"],["not",b.not,C.cold,"What's Not"]].map(([k,arr,col,label])=>(
          <div key={k}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:11 }}>
              {k==="hot"?<Flame size={15} color={col}/>:<Snowflake size={15} color={col}/>}
              <span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>{label}</span>
            </div>
            {(arr||[]).map((m,i)=>(
              <div key={i} style={{ background:C.panel, border:`1px solid ${C.line}`, borderLeft:`3px solid ${col}`, borderRadius:10, padding:"12px 14px", marginBottom:9 }}>
                <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                  <span style={{ fontWeight:700, color:C.ink }}>{m.ticker}</span>
                  <span style={{ fontFamily:C.mono, fontSize:12, color:k==="hot"?C.up:C.down }}>{m.chg}</span>
                </div>
                <div style={{ fontSize:11.5, color:C.sub, lineHeight:1.5 }}>{m.why}</div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Sector rotation strip (kept compact — full chart is in Map tab) */}
      {(b.sectors||[]).length>0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:10 }}>
            <Activity size={15} color={C.violet}/><span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>Sector Snapshot</span>
            <span style={{ fontSize:11, color:C.faint }}>— full rotation matrix in Map tab</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(150px, 1fr))", gap:9 }}>
            {b.sectors.map((s,i)=>{ const m=s.month??0, h=sectorHeat(m); return (
              <div key={i} onClick={()=>setSelSector(s)} style={{ background:h.bg, border:`1px solid ${h.border}`, borderRadius:9, padding:"10px 12px", cursor:"pointer" }}
                onMouseEnter={e=>e.currentTarget.style.opacity="0.85"} onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:11.5, fontWeight:700, color:C.ink }}>{s.name}</span>
                  <span style={{ fontFamily:C.mono, fontSize:12, fontWeight:700, color:h.txt }}>{m>=0?"+":""}{m}%</span>
                </div>
              </div>
            ); })}
          </div>
        </div>
      )}

      {/* Trade Ideas */}
      {(b.plays||[]).length>0 && (
        <>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
            <Target size={15} color={C.violet}/><span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>Trade Ideas</span>
          </div>
          {b.plays.map((p,i)=>(
            <div key={i} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"14px 16px", marginBottom:10 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontWeight:700, color:C.ink }}>{p.ticker} <span style={{ fontFamily:C.mono, fontSize:12, color:C.amber, fontWeight:400 }}>${p.strike}{p.direction?.[0]} · {p.expiry} · {p.dte}d</span></span>
                <span style={{ fontFamily:C.mono, fontSize:11, color:C.sub }}>bull {p.prob?.bull}% / bear {p.prob?.bear}%</span>
              </div>
              <div style={{ fontSize:12, color:C.sub, lineHeight:1.55, marginTop:7 }}>{p.thesis}</div>
            </div>
          ))}
        </>
      )}
      {selSector && <SectorDetail sector={selSector} onClose={()=>setSelSector(null)}/>}
    </div>
  );
}

// ── INDICATOR DRILL-DOWN (macro item → chart + AI outlook/news) ────────
function IndicatorModal({ item, onClose }) {
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  useEffect(()=>{ setD(null); setErr(null); fetchIndicator(item.symbol, item.label).then(x=> x.error?setErr(x.error):setD(x)).catch(e=>setErr(e.message)); },[item.symbol]);
  useEffect(()=>{ const h=(e)=>{ if(e.key==="Escape") onClose(); }; window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h); },[onClose]);
  const regimeCol = (r)=> ({calm:C.up, falling:C.up, neutral:C.amber, rising:C.down, stress:C.down}[r] || C.amber);
  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:60, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"6vh 16px", overflowY:"auto" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.bg, border:`1px solid ${C.line}`, borderRadius:16, width:"100%", maxWidth:580, boxShadow:"0 24px 70px rgba(0,0,0,0.5)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"18px 20px", borderBottom:`1px solid ${C.line}` }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800, color:C.ink }}>{item.label}</div>
            {d && <div style={{ fontSize:12, color:C.faint, marginTop:3, fontFamily:C.mono }}>{d.current} <span style={{ color:(d.change||0)>=0?C.up:C.down }}>{(d.change||0)>=0?"+":""}{d.change}% today</span>{d.regime && <span style={{ color:regimeCol(d.regime), marginLeft:8, textTransform:"capitalize" }}>· {d.regime}</span>}</div>}
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={18}/></button>
        </div>
        <div style={{ padding:"16px 20px 20px" }}>
          {err && <div style={{ color:C.down, fontSize:13 }}>Couldn't load: {err}</div>}
          {!d && !err && <div style={{ textAlign:"center", padding:"30px 0", color:C.sub }}><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:8, fontSize:12.5 }}>Loading {item.label}…</div></div>}
          {d && (
            <>
              {d.history?.length>1 && (
                <div style={{ marginBottom:16 }}>
                  <InteractiveChart data={d.history} dates={d.history_dates} color={(d.change||0)>=0?C.up:C.down}/>
                  <div style={{ fontSize:9.5, color:C.faint, marginTop:4, letterSpacing:"0.04em" }}>60-DAY · hover to inspect</div>
                </div>
              )}
              {d.ai_error ? (
                <div style={{ fontSize:12.5, color:C.amber, background:`${C.amber}14`, border:`1px solid ${C.amber}33`, borderRadius:10, padding:"11px 13px" }}>
                  AI summary &amp; news are unavailable right now{/credit|balance/i.test(d.ai_error) ? " (Anthropic API credit exhausted)" : ""}. The live chart above still works.
                </div>
              ) : (
                <>
                  {d.summary && <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65, marginBottom:14 }}>{d.summary}</div>}
                  {d.outlook && (
                    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"13px 15px", marginBottom:14 }}>
                      <div style={{ fontSize:10, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:6 }}>30-90 Day Outlook</div>
                      <div style={{ fontSize:12.5, color:C.sub, lineHeight:1.6 }}>{d.outlook}</div>
                      {d.implication && <div style={{ fontSize:12, color:C.ink, lineHeight:1.55, marginTop:8 }}><span style={{ color:C.violet }}>→</span> {d.implication}</div>}
                    </div>
                  )}
                  {d.news?.length>0 && (
                    <div>
                      <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:9 }}>Latest</div>
                      {d.news.map((n,i)=>(
                        <div key={i} style={{ padding:"9px 0", borderBottom:`1px solid ${C.panel2}` }}>
                          <div style={{ fontSize:12.5, color:C.ink, lineHeight:1.45 }}>{n.headline}</div>
                          <div style={{ fontSize:10, color:C.faint, fontFamily:C.mono, marginTop:3 }}>{n.source} · {n.time}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── MACRO RIBBON (top strip of climate gauges — click to drill in) ─────
function MacroRibbon() {
  const [c, setC] = useState(null);
  const [sel, setSel] = useState(null);
  useEffect(()=>{ let alive=true; fetchClimate().then(x=>{ if(alive && !x.error) setC(x); }).catch(()=>{}); return ()=>{alive=false;}; },[]);
  if (!c) return null;
  const sc = c.macro_score ?? 50;
  const scoreCol = sc>60?C.up:sc>35?C.amber:C.down;
  const hov = (e,on)=>{ e.currentTarget.style.background = on ? C.line : "transparent"; };
  return (
    <div style={{ borderBottom:`1px solid ${C.line}`, background:C.panel2 }}>
      <div style={{ maxWidth:1180, margin:"0 auto", padding:"6px 22px", display:"flex", alignItems:"center", gap:8, overflowX:"auto", whiteSpace:"nowrap" }}>
        <div onClick={()=>setSel({symbol:"SPY", label:"S&P 500"})} onMouseEnter={e=>hov(e,true)} onMouseLeave={e=>hov(e,false)} title="Market overview — chart & outlook"
          style={{ display:"flex", alignItems:"center", gap:7, flexShrink:0, cursor:"pointer", padding:"3px 7px", borderRadius:6 }}>
          <Activity size={13} color={scoreCol}/>
          <span style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.1em" }}>MACRO</span>
          <span style={{ fontFamily:C.mono, fontSize:14, fontWeight:700, color:scoreCol }}>{sc}</span>
          <span style={{ fontSize:11, color:scoreCol }}>{c.posture}</span>
        </div>
        {(c.gauges||[]).map((g,i)=>(
          <div key={i} onClick={()=> g.symbol && setSel({symbol:g.symbol, label:g.label})}
            onMouseEnter={e=> g.symbol && hov(e,true)} onMouseLeave={e=>hov(e,false)}
            title={g.symbol ? `${g.label} — chart, outlook & news` : ""}
            style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, cursor: g.symbol?"pointer":"default", padding:"3px 7px", borderRadius:6 }}>
            <span style={{ fontSize:10, color:C.faint }}>{g.label}</span>
            <span style={{ fontFamily:C.mono, fontSize:12, color: g.good?C.up:C.down }}>{g.value}</span>
          </div>
        ))}
      </div>
      {sel && <IndicatorModal item={sel} onClose={()=>setSel(null)}/>}
    </div>
  );
}

// ── ALERTS BELL — slide-out drawer, persistent history, read/unread ────
function AlertsBell({ alertHistory = [], setAlertHistory, onNavigate }) {
  const [open, setOpen] = useState(false);
  const unread = alertHistory.filter(a => !a.read).length;

  const markRead = (id) => setAlertHistory(prev => {
    const next = prev.map(a => a.id === id ? { ...a, read: true } : a);
    saveAlerts(next); return next;
  });
  const markAllRead = () => setAlertHistory(prev => {
    const next = prev.map(a => ({ ...a, read: true }));
    saveAlerts(next); return next;
  });
  const handleClick = (a) => {
    markRead(a.id);
    setOpen(false);
    onNavigate(a.link);
  };
  const sevCol = (s) => s === "red" ? C.down : s === "green" ? C.up : C.amber;

  return (
    <>
      <div style={{ position:"relative", flexShrink:0 }}>
        <button onClick={()=>setOpen(o=>!o)} title="Alerts"
          style={{ position:"relative", background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 9px", color:open?C.ink:C.sub, cursor:"pointer", display:"flex" }}>
          <Bell size={15}/>
          {unread > 0 && (
            <span style={{ position:"absolute", top:-6, right:-6, background:C.down, color:"#fff", fontSize:9, fontWeight:700, borderRadius:8, padding:"1px 5px", minWidth:15, textAlign:"center", lineHeight:1.4 }}>
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </button>
      </div>

      {open && (
        <>
          {/* backdrop */}
          <div onClick={()=>setOpen(false)}
            style={{ position:"fixed", inset:0, zIndex:55, background:"rgba(0,0,0,0.18)" }}/>

          {/* drawer */}
          <div style={{ position:"fixed", top:0, right:0, bottom:0, width:370,
            background:C.panel, borderLeft:`1px solid ${C.line}`,
            boxShadow:"-16px 0 48px rgba(0,0,0,0.22)", zIndex:60,
            display:"flex", flexDirection:"column" }}>

            {/* header */}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
              padding:"16px 18px", borderBottom:`1px solid ${C.line}`, flexShrink:0 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <Bell size={15} color={C.ink}/>
                <span style={{ fontWeight:700, fontSize:14, color:C.ink }}>Alerts</span>
                {unread > 0 && (
                  <span style={{ background:C.down, color:"#fff", fontSize:10, fontWeight:700, borderRadius:6, padding:"1px 7px" }}>
                    {unread} new
                  </span>
                )}
              </div>
              <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                {unread > 0 && (
                  <button onClick={markAllRead}
                    style={{ fontSize:11, color:C.cold, background:"none", border:"none", cursor:"pointer", fontWeight:600 }}>
                    Mark all read
                  </button>
                )}
                <button onClick={()=>setOpen(false)}
                  style={{ background:"none", border:"none", color:C.sub, cursor:"pointer", display:"flex" }}>
                  <X size={16}/>
                </button>
              </div>
            </div>

            {/* list */}
            <div style={{ flex:1, overflowY:"auto" }}>
              {alertHistory.length === 0 ? (
                <div style={{ padding:"48px 20px", textAlign:"center", color:C.faint }}>
                  <Bell size={30} style={{ opacity:0.25, display:"block", margin:"0 auto 12px" }}/>
                  <div style={{ fontSize:13 }}>No alerts yet</div>
                  <div style={{ fontSize:11, marginTop:6 }}>Stop hits, portfolio signals, and macro warnings appear here.</div>
                </div>
              ) : alertHistory.map(a => {
                const col = sevCol(a.severity);
                return (
                  <div key={a.id} onClick={()=>handleClick(a)}
                    style={{ display:"flex", gap:12, padding:"12px 18px",
                      borderBottom:`1px solid ${C.line}`,
                      background: a.read ? "transparent" : `${C.cold}08`,
                      cursor:"pointer" }}
                    onMouseEnter={e=>e.currentTarget.style.background=C.panel2}
                    onMouseLeave={e=>e.currentTarget.style.background= a.read?"transparent":`${C.cold}08`}>
                    <div style={{ width:3, borderRadius:2, background:col, flexShrink:0, alignSelf:"stretch", minHeight:36 }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                        <div style={{ fontSize:12.5, color:C.ink, lineHeight:1.45,
                          fontWeight: a.read ? 400 : 600 }}>
                          {a.message}
                        </div>
                        {!a.read && <div style={{ width:7, height:7, borderRadius:"50%", background:C.cold, flexShrink:0, marginTop:5 }}/>}
                      </div>
                      <div style={{ display:"flex", gap:6, marginTop:5, alignItems:"center", flexWrap:"wrap" }}>
                        <span style={{ fontSize:10, color:col, fontWeight:700, letterSpacing:"0.04em" }}>{a.ticker}</span>
                        <span style={{ fontSize:10, color:C.faint }}>·</span>
                        <span style={{ fontSize:10, color:C.faint }}>{a.type.replace(/_/g," ")}</span>
                        <span style={{ fontSize:10, color:C.faint, marginLeft:"auto", whiteSpace:"nowrap" }}>{alertTimeAgo(a.ts)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* footer */}
            <div style={{ padding:"10px 18px", borderTop:`1px solid ${C.line}`, flexShrink:0,
              display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:11, color:C.faint }}>
                {alertHistory.length} alert{alertHistory.length!==1?"s":""} · last 30 days
              </span>
              {alertHistory.some(a=>a.read) && (
                <button onClick={()=>setAlertHistory(prev=>{
                  const next=prev.filter(a=>!a.read); saveAlerts(next); return next;
                })} style={{ fontSize:11, color:C.faint, background:"none", border:"none", cursor:"pointer" }}>
                  Clear read
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ── ADD-POSITION FORM ─────────────────────────────────────────────────
function PositionForm({ initial, onSubmit, onClose }) {
  const editing = !!initial;
  const [type, setType]     = useState(initial?.type || "SHARES");
  const [ticker, setTicker] = useState(initial?.ticker || "");
  const [qty, setQty]       = useState(initial?.qty != null ? String(initial.qty) : "");
  const [cost, setCost]     = useState(initial?.cost_basis != null ? String(initial.cost_basis) : "");
  const [strike, setStrike] = useState(initial?.strike != null ? String(initial.strike) : "");
  const [expiry, setExpiry] = useState(initial?.expiry || "");
  const [stop, setStop]     = useState(initial?.stop != null ? String(initial.stop) : "");
  const [error, setError]   = useState("");
  const isOpt = type !== "SHARES";

  const submit = () => {
    const T = ticker.toUpperCase().trim();
    const q = parseFloat(qty), cb = parseFloat(cost);
    if (!T) return setError("Ticker is required");
    if (!(q > 0)) return setError("Quantity must be greater than 0");
    if (cost === "" || isNaN(cb) || cb < 0) return setError("Cost basis (total $ paid) is required");
    const pos = { ticker: T, type, qty: q, cost_basis: cb };
    if (isOpt) {
      const k = parseFloat(strike);
      if (!(k > 0)) return setError("Strike is required for options");
      if (!expiry)  return setError("Expiry is required for options");
      pos.strike = k; pos.expiry = expiry;
    }
    const sv = parseFloat(stop);
    pos.stop = (stop !== "" && sv > 0) ? sv : null;   // underlying price; null clears it
    onSubmit(pos); onClose();
  };

  const lbl = { display:"block", fontSize:9, color:C.faint, letterSpacing:"0.06em", marginBottom:4 };
  const inp = { width:"100%", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:8, padding:"8px 10px", color:C.ink, fontSize:13, outline:"none", fontFamily:"inherit" };
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:16 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <span style={{ fontSize:13, fontWeight:700, color:C.ink }}>{editing ? "Edit Position" : "Add Position"}</span>
        <button onClick={onClose} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={16}/></button>
      </div>
      <div style={{ display:"flex", gap:3, background:C.panel2, borderRadius:9, padding:3, border:`1px solid ${C.line}`, marginBottom:12, width:"fit-content" }}>
        {["SHARES","CALL","PUT"].map(t=>(
          <button key={t} onClick={()=>setType(t)} style={{ padding:"6px 16px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:600, background:type===t?C.line:"transparent", color:type===t?C.ink:C.sub }}>{t}</button>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))", gap:10, marginBottom:12 }}>
        <div><label style={lbl}>TICKER</label><input value={ticker} onChange={e=>setTicker(e.target.value)} placeholder="NVDA" style={{ ...inp, textTransform:"uppercase" }}/></div>
        <div><label style={lbl}>QUANTITY</label><input value={qty} onChange={e=>setQty(e.target.value)} type="number" placeholder={isOpt?"contracts":"shares"} style={inp}/></div>
        <div>
          <label style={lbl}>COST BASIS ($){isOpt && <span style={{ color:C.amber, marginLeft:4 }}>= contracts × premium × 100</span>}</label>
          <input value={cost} onChange={e=>setCost(e.target.value)} type="number"
            placeholder={isOpt ? `e.g. 2 contracts × $14.20 = $2,840` : "total $ paid"}
            style={inp}/>
          {isOpt && cost && (
            <div style={{ fontSize:10, color:C.cold, marginTop:3 }}>
              = ${parseFloat(cost).toLocaleString()} total · ~${qty && parseFloat(qty)>0 ? (parseFloat(cost)/(parseFloat(qty)*100)).toFixed(2) : "?"} per share
            </div>
          )}
        </div>
        {isOpt && <div><label style={lbl}>STRIKE</label><input value={strike} onChange={e=>setStrike(e.target.value)} type="number" placeholder="210" style={inp}/></div>}
        {isOpt && <div><label style={lbl}>EXPIRY</label><input value={expiry} onChange={e=>setExpiry(e.target.value)} type="date" style={inp}/></div>}
        <div><label style={lbl}>STOP LOSS ($)</label><input value={stop} onChange={e=>setStop(e.target.value)} type="number" placeholder="optional · underlying" style={inp}/></div>
      </div>
      {error && <div style={{ color:C.down, fontSize:11.5, marginBottom:10, display:"flex", alignItems:"center", gap:5 }}><AlertCircle size={12}/> {error}</div>}
      <div style={{ display:"flex", gap:8 }}>
        <button onClick={submit} style={{ background:C.up, border:"none", borderRadius:9, padding:"9px 18px", color:"#06080d", cursor:"pointer", fontSize:12.5, fontWeight:700 }}>{editing ? "Save Changes" : "Add Position"}</button>
        <button onClick={onClose} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 16px", color:C.sub, cursor:"pointer", fontSize:12.5 }}>Cancel</button>
      </div>
    </div>
  );
}

// ── AI PORTFOLIO ANALYSIS ─────────────────────────────────────────────
function PortfolioAnalysis({ data, aiEnabled, cash, profile }) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading]   = useState(false);
  const [err, setErr]           = useState(null);

  const hasRun = useRef(false);

  const run = useCallback(async () => {
    if (!aiEnabled || !data?.positions?.length) return;
    setLoading(true); setErr(null);
    try {
      const result = await fetchPortfolioAnalysis(
        data.positions, data.analytics, cash,
        profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""
      );
      if (result.error) setErr(result.error);
      else setAnalysis(result);
    } catch(e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [aiEnabled, data, cash, profile]);

  // Only auto-run once when positions first become non-empty — don't re-run on every
  // valuation refresh (which fires whenever individual position values update).
  useEffect(()=>{
    if (aiEnabled && data?.positions?.length && !hasRun.current) {
      hasRun.current = true;
      run();
    }
  }, [aiEnabled, data?.positions?.length]);
  // Reset hasRun when AI is toggled off so turning it back on re-triggers the analysis.
  useEffect(()=>{ if (!aiEnabled) hasRun.current = false; }, [aiEnabled]);

  const healthColor = (h) => h==="Strong"?C.up:h==="Balanced"?C.cold:h==="At Risk"?C.amber:C.down;

  if (!aiEnabled) return (
    <div style={{ background:C.panel, border:`1px dashed ${C.line}`, borderRadius:14, padding:"20px 24px", marginBottom:18, opacity:0.7 }}>
      <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom:10 }}>
        <Activity size={15} color={C.sub}/>
        <span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>AI Portfolio Analysis</span>
        <span style={{ fontSize:10, color:C.faint, marginLeft:"auto" }}>AI Insights OFF</span>
      </div>
      <div style={{ fontSize:12, color:C.sub, lineHeight:1.65 }}>
        Turn on AI Insights to get: Portfolio Health Score · Concentration Risk · Greeks in Plain English · Biggest Opportunity · Biggest Risk · Overall Recommendation tailored to your trader profile.
      </div>
    </div>
  );

  if (!data?.positions?.length) return null;

  return (
    <div style={{ background:C.panel, border:`1px solid ${analysis ? healthColor(analysis.health_score)+"50" : C.line}`, borderRadius:14, padding:"18px 20px", marginBottom:18 }}>
      <div style={{ display:"flex", alignItems:"center", gap:9, marginBottom: analysis||loading ? 14 : 0 }}>
        <Activity size={15} color={analysis ? healthColor(analysis.health_score) : C.sub}/>
        <span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>AI Portfolio Analysis</span>
        {profile && <span style={{ fontSize:10, color:C.faint, fontStyle:"italic" }}>
          {({conservative:"Conservative",moderate:"Moderate",aggressive:"Aggressive",degen:"Degen"}[profile.riskTolerance]||"")} · {({longterm:"Long-Term",swing:"Swing",options:"Options",daytrader:"Day Trader"}[profile.style]||"")} profile
        </span>}
        <button onClick={run} disabled={loading} style={{ marginLeft:"auto", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:7, padding:"5px 12px", color:loading?C.faint:C.sub, fontSize:11, cursor:loading?"wait":"pointer", display:"flex", alignItems:"center", gap:5 }}>
          {loading ? <><Loader2 size={11} style={{ animation:"spin 1s linear infinite" }}/> Analyzing…</> : <><RefreshCw size={11}/> Refresh</>}
        </button>
      </div>

      {err && <div style={{ color:C.amber, fontSize:12, marginBottom:10 }}>Analysis error: {err}</div>}

      {loading && !analysis && (
        <div style={{ textAlign:"center", padding:"20px 0", color:C.sub, fontSize:12 }}>
          <Loader2 size={16} style={{ animation:"spin 1s linear infinite", display:"inline" }}/> Analyzing your portfolio as a whole book…
        </div>
      )}

      {analysis && (
        <>
          {/* Health Score row */}
          <div style={{ display:"flex", alignItems:"center", gap:12, background:C.panel2, borderRadius:10, padding:"12px 16px", marginBottom:14 }}>
            <span style={{ fontFamily:C.mono, fontSize:14, fontWeight:800, color:healthColor(analysis.health_score), letterSpacing:"0.06em" }}>{analysis.health_score?.toUpperCase()}</span>
            <div style={{ width:1, height:20, background:C.line }}/>
            <span style={{ fontSize:13, color:C.ink }}>{analysis.health_summary}</span>
          </div>

          {/* 4-section grid */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:14 }}>
            <div style={{ background:C.panel2, borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:9.5, color:C.amber, letterSpacing:"0.07em", marginBottom:6 }}>CONCENTRATION RISK</div>
              <div style={{ fontSize:12.5, color:C.ink, lineHeight:1.55 }}>{analysis.concentration}</div>
            </div>
            <div style={{ background:C.panel2, borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:9.5, color:C.violet, letterSpacing:"0.07em", marginBottom:6 }}>GREEKS IN PLAIN ENGLISH</div>
              <div style={{ fontSize:12.5, color:C.ink, lineHeight:1.55 }}>{analysis.greeks_plain}</div>
            </div>
            <div style={{ background:`${C.up}0c`, border:`1px solid ${C.up}30`, borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:9.5, color:C.up, letterSpacing:"0.07em", marginBottom:6 }}>BIGGEST OPPORTUNITY</div>
              <div style={{ fontSize:12, fontWeight:700, color:C.ink, marginBottom:4 }}>{analysis.opportunity?.ticker}</div>
              <div style={{ fontSize:11.5, color:C.sub, lineHeight:1.5 }}>{analysis.opportunity?.reason}</div>
            </div>
            <div style={{ background:`${C.amber}0c`, border:`1px solid ${C.amber}30`, borderRadius:10, padding:"12px 14px" }}>
              <div style={{ fontSize:9.5, color:C.amber, letterSpacing:"0.07em", marginBottom:6 }}>BIGGEST RISK</div>
              <div style={{ fontSize:12, fontWeight:700, color:C.ink, marginBottom:4 }}>{analysis.risk?.ticker}</div>
              <div style={{ fontSize:11.5, color:C.sub, lineHeight:1.5 }}>{analysis.risk?.reason}</div>
            </div>
          </div>

          {/* Recommendation */}
          <div style={{ background:C.panel2, borderRadius:10, padding:"12px 16px", borderLeft:`3px solid ${C.cold}` }}>
            <div style={{ fontSize:9.5, color:C.cold, letterSpacing:"0.07em", marginBottom:6 }}>OVERALL RECOMMENDATION</div>
            <div style={{ fontSize:13, color:C.ink, lineHeight:1.65 }}>{analysis.recommendation}</div>
          </div>
        </>
      )}
    </div>
  );
}

// ── PORTFOLIO (manual positions, Greeks, P&L; expired in an envelope) ───
function PortfolioPage({ positions, data, err, loading, margin, marginRate, onMargin, cash, onCash, aiEnabled, profile, onAdd, onUpdate, onRemove, onReorder, onRefresh, onOpen }) {
  const [showForm, setShowForm]       = useState(false);
  const [editing, setEditing]         = useState(null);
  const [showExpired, setShowExpired] = useState(false);
  const [payoff, setPayoff]           = useState(null);
  const [sort, setSort]               = useState({ key:null, dir:null });
  const [dragId, setDragId]           = useState(null);
  const [tooltip, setTooltip]         = useState(null);

  const a       = data?.analytics || {};
  const active  = data?.positions || [];
  const expired = data?.expired   || [];
  const errored = data?.errored   || [];
  const pnlCol  = (a.total_pnl||0)>=0?C.up:C.down;
  const num = (v, d=2) => (v===null||v===undefined) ? "—" : Number(v).toFixed(d);
  const sectors = Object.entries(a.sector_alloc||{}).sort((x,y)=>y[1]-x[1]);
  const totalAlloc = sectors.reduce((s,[,v])=>s+v,0) || 1;
  const GRID = "minmax(140px,2fr) minmax(60px,1fr) minmax(70px,1fr) minmax(60px,1fr) minmax(44px,0.7fr) minmax(80px,1.1fr) minmax(130px,1.8fr) 60px";
  const COLS = [
    {key:"ticker",      label:"Position",  align:"left"},
    {key:"spot",        label:"Spot",      align:"right"},
    {key:"pnl",         label:"P&L",       align:"right"},
    {key:"pnl_pct",     label:"P&L %",     align:"right"},
    {key:"dte",         label:"DTE",       align:"right"},
    {key:"stop",        label:"Stop",      align:"right"},
    {key:"score",       label:"Signal",    align:"right"},
  ];
  const toggleSort = (key)=> setSort(s=> s.key!==key ? {key,dir:"desc"} : s.dir==="desc" ? {key,dir:"asc"} : {key:null,dir:null});
  const sortVal = (p,key)=> key==="ticker" ? (p.ticker||"") : (p[key] ?? -Infinity);
  const displayed = sort.key
    ? [...active].sort((x,y)=>{ const xv=sortVal(x,sort.key), yv=sortVal(y,sort.key);
        if (typeof xv==="string") return sort.dir==="asc" ? xv.localeCompare(yv) : yv.localeCompare(xv);
        return sort.dir==="asc" ? xv-yv : yv-xv; })
    : active;
  const scoreColr  = (s)=> s==null?C.faint : s>=67?C.up : s>=40?C.amber : C.down;

  const Stat = ({ label, value, sub, col }) => (
    <div style={{ flex:"1 1 180px", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 18px" }}>
      <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>{label}</div>
      <div style={{ fontFamily:C.mono, fontSize:24, fontWeight:700, color:col||C.ink, marginTop:4 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.sub, marginTop:2 }}>{sub}</div>}
    </div>
  );

  const CashCard = () => {
    const [edit, setEdit] = useState(false);
    const [c, setC] = useState(String(cash||0));
    const ip = { width:"100%", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:6, padding:"5px 7px", color:C.ink, fontSize:13, outline:"none", fontFamily:C.mono };
    const totalWithCash = (a.total_value||0) + (cash||0);
    if (edit) return (
      <div style={{ flex:"1 1 200px", background:C.panel, border:`1px solid ${C.cold}66`, borderRadius:12, padding:"13px 16px" }}>
        <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", marginBottom:8 }}>CASH</div>
        <div style={{ marginBottom:8 }}>
          <div style={{ fontSize:8.5, color:C.faint, marginBottom:2 }}>BALANCE $</div>
          <input value={c} onChange={e=>setC(e.target.value)} type="number" min="0" style={ip}/>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <button onClick={()=>{ onCash(parseFloat(c)||0); setEdit(false); }} style={{ background:C.up, border:"none", borderRadius:7, padding:"6px 12px", color:"#06080d", fontSize:11.5, fontWeight:700, cursor:"pointer" }}>Save</button>
          <button onClick={()=>setEdit(false)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:7, padding:"6px 10px", color:C.sub, fontSize:11.5, cursor:"pointer" }}>Cancel</button>
        </div>
      </div>
    );
    return (
      <div onClick={()=>{ setC(String(cash||0)); setEdit(true); }} title="Click to set cash balance"
        style={{ flex:"1 1 180px", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 18px", cursor:"pointer" }}>
        <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", display:"flex", justifyContent:"space-between", alignItems:"center" }}>CASH <Pencil size={11} color={C.faint}/></div>
        <div style={{ fontFamily:C.mono, fontSize:24, fontWeight:700, color:(cash||0)>0?C.cold:C.ink, marginTop:4 }}>${(cash||0).toLocaleString()}</div>
        <div style={{ fontSize:11, color:C.sub, marginTop:2 }}>{(cash||0)>0 ? `$${totalWithCash.toLocaleString()} total with portfolio` : "click to add cash"}</div>
      </div>
    );
  };

  const MarginCard = () => {
    const [edit, setEdit] = useState(false);
    const [m, setM] = useState(String(margin||0));
    const [r, setR] = useState(String(marginRate||0));
    const ip = { width:"100%", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:6, padding:"5px 7px", color:C.ink, fontSize:13, outline:"none", fontFamily:C.mono };
    if (edit) return (
      <div style={{ flex:"1 1 200px", background:C.panel, border:`1px solid ${C.amber}66`, borderRadius:12, padding:"13px 16px" }}>
        <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", marginBottom:8 }}>MARGIN</div>
        <div style={{ display:"flex", gap:8, marginBottom:8 }}>
          <div style={{ flex:1 }}><div style={{ fontSize:8.5, color:C.faint, marginBottom:2 }}>BALANCE $</div><input value={m} onChange={e=>setM(e.target.value)} type="number" style={ip}/></div>
          <div style={{ flex:1 }}><div style={{ fontSize:8.5, color:C.faint, marginBottom:2 }}>RATE %</div><input value={r} onChange={e=>setR(e.target.value)} type="number" style={ip}/></div>
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <button onClick={()=>{ onMargin(parseFloat(m)||0, parseFloat(r)||0); setEdit(false); }} style={{ background:C.up, border:"none", borderRadius:7, padding:"6px 12px", color:"#06080d", fontSize:11.5, fontWeight:700, cursor:"pointer" }}>Save</button>
          <button onClick={()=>setEdit(false)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:7, padding:"6px 10px", color:C.sub, fontSize:11.5, cursor:"pointer" }}>Cancel</button>
        </div>
      </div>
    );
    return (
      <div onClick={()=>{ setM(String(margin||0)); setR(String(marginRate||0)); setEdit(true); }} title="Click to set margin balance & rate"
        style={{ flex:"1 1 180px", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 18px", cursor:"pointer" }}>
        <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", display:"flex", justifyContent:"space-between", alignItems:"center" }}>MARGIN <Pencil size={11} color={C.faint}/></div>
        <div style={{ fontFamily:C.mono, fontSize:24, fontWeight:700, color:(margin||0)>0?C.amber:C.ink, marginTop:4 }}>${(margin||0).toLocaleString()}</div>
        <div style={{ fontSize:11, color:C.sub, marginTop:2 }}>{margin>0 ? `${marginRate||0}% · $${num(a.margin_interest_daily,2)}/day` : "click to add margin"}</div>
      </div>
    );
  };

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>Portfolio</div>
          <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>{positions.length} position{positions.length===1?"":"s"} · your holdings · Black-Scholes Greeks</div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {loading && <Loader2 size={14} color={C.faint} style={{ animation:"spin 1s linear infinite" }}/>}
          <button onClick={onRefresh} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"7px 11px", color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12 }}><RefreshCw size={13}/> Refresh</button>
          <button onClick={()=>{ setEditing(null); setShowForm(s=>!s); }} style={{ background:C.up, border:"none", borderRadius:9, padding:"7px 13px", color:"#06080d", cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12.5, fontWeight:600 }}><Plus size={14}/> Add Position</button>
        </div>
      </div>

      {(showForm || editing) && (
        <PositionForm
          key={editing?.id || "new"}
          initial={editing}
          onSubmit={(pos)=>{ if (editing) onUpdate(editing.id, pos); else onAdd(pos); }}
          onClose={()=>{ setEditing(null); setShowForm(false); }}
        />
      )}

      {err && <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}33`, borderRadius:10, padding:"12px 14px", color:C.down, fontSize:12.5, marginBottom:16 }}>Couldn't value portfolio: {err} — is the backend running on {API}?</div>}

      {positions.length===0 ? (
        <div style={{ textAlign:"center", padding:"54px 20px", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>
          No positions yet. <span style={{ color:C.cold, cursor:"pointer" }} onClick={()=>setShowForm(true)}>Add a stock or option</span> to start tracking P&L and Greeks.
        </div>
      ) : !data ? (
        <div style={{ padding:50, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Valuing positions & computing Greeks…</div></div>
      ) : (
        <>
          <div style={{ display:"flex", gap:14, flexWrap:"wrap", marginBottom:16 }}>
            <Stat label="TOTAL VALUE"  value={`$${(a.total_value||0).toLocaleString()}`} sub={`cost $${(a.total_cost||0).toLocaleString()}`}/>
            <Stat label="TOTAL P&L"    value={`${(a.total_pnl||0)>=0?"+":""}$${Math.abs(a.total_pnl||0).toLocaleString()}`} sub={`${((a.total_pnl_pct||0)*100).toFixed(1)}%`} col={pnlCol}/>
            <Stat label="NET VALUE"    value={`$${(a.net_value ?? a.total_value ?? 0).toLocaleString()}`} sub={margin>0?"equity after margin":"= total value"}/>
            <Stat label="NET DELTA"    value={num(a.net_delta,0)} sub="share-equivalent exposure"/>
            <Stat label="DAILY THETA"  value={`$${num(a.daily_theta,0)}`} sub="time decay per day" col={(a.daily_theta||0)<0?C.down:C.sub}/>
            <CashCard/>
            <MarginCard/>
          </div>

          <PortfolioAnalysis data={data} aiEnabled={aiEnabled} cash={cash} profile={profile}/>

          {/* Active positions */}
          <div style={{ fontSize:11, color:C.faint, marginBottom:7 }}>{sort.key ? "Sorted — clear the sort (click the header again) to drag-reorder" : "Click a column to sort · drag the handle to reorder"}</div>
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, marginBottom:16 }}>
           <div>
            <div style={{ display:"grid", gridTemplateColumns:GRID, padding:"10px 16px", borderBottom:`1px solid ${C.line}`, fontSize:9.5, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase" }}>
              {COLS.map((c)=>(
                <div key={c.key} onClick={()=>toggleSort(c.key)} title="Sort"
                  style={{ textAlign:c.align, cursor:"pointer", display:"flex", gap:3, alignItems:"center", justifyContent:c.align==="left"?"flex-start":"flex-end", color: sort.key===c.key?C.ink:C.faint, userSelect:"none" }}>
                  {c.label}{sort.key===c.key && (sort.dir==="asc"?<ArrowUp size={10}/>:<ArrowDown size={10}/>)}
                </div>
              ))}
              <div/>
            </div>
            {active.length===0 && errored.length===0 && (
              <div style={{ padding:"20px 16px", fontSize:12, color:C.faint, textAlign:"center" }}>All positions expired — see the envelope below.</div>
            )}
            {displayed.map((p)=>{
              const isOpt = p.type !== "SHARES";
              const label = isOpt ? `${p.ticker} $${p.strike}${(p.type||"")[0]}` : `${p.ticker}`;
              const canDrag = !sort.key;
              return (
                <div key={p.id}
                  draggable={canDrag}
                  onDragStart={canDrag?(()=>setDragId(p.id)):undefined}
                  onDragOver={canDrag?(e=>e.preventDefault()):undefined}
                  onDrop={canDrag?(e=>{ e.preventDefault(); if(dragId && dragId!==p.id) onReorder(dragId,p.id); setDragId(null); }):undefined}
                  onDragEnd={canDrag?(()=>setDragId(null)):undefined}
                  onClick={()=>onOpen&&onOpen(p.ticker)}
                  style={{ display:"grid", gridTemplateColumns:GRID, padding:"12px 16px", borderTop:`1px solid ${C.panel2}`, fontFamily:C.mono, fontSize:12, color:C.ink, alignItems:"center", opacity: dragId===p.id?0.4:1, cursor:"pointer" }}
                  onMouseEnter={e=>e.currentTarget.style.background=C.panel2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{ display:"flex", alignItems:"center", gap:7, minWidth:0 }} onClick={()=>onOpen&&onOpen(p.ticker)}>
                    {canDrag && <GripVertical size={13} color={C.faint} style={{ flexShrink:0, cursor:"grab" }}/>}
                    <div style={{ display:"flex", flexDirection:"column", gap:2, minWidth:0, cursor:"pointer" }}>
                      <span style={{ fontWeight:700, fontFamily:"inherit" }}>{label}</span>
                      <span style={{ fontSize:9.5, color:C.faint, whiteSpace:"nowrap" }}>{isOpt ? `${p.qty}x · exp ${p.expiry}` : `${p.qty} shares`}</span>
                    </div>
                  </div>
                  <div style={{ textAlign:"right", fontFamily:C.mono, fontSize:12 }}>${num(p.spot)}</div>
                  <div style={{ textAlign:"right", color:(p.pnl||0)>=0?C.up:C.down, fontFamily:C.mono, fontSize:12 }}>{(p.pnl||0)>=0?"+":""}{(p.pnl||0).toLocaleString(undefined,{maximumFractionDigits:0})}</div>
                  <div style={{ textAlign:"right", color:(p.pnl_pct||0)>=0?C.up:C.down, fontFamily:C.mono, fontSize:12 }}>{((p.pnl_pct||0)*100).toFixed(1)}%</div>
                  <div style={{ textAlign:"right", color:C.sub, fontFamily:C.mono, fontSize:12 }}>{p.dte??"—"}</div>
                  <div style={{ textAlign:"right" }}>
                    {p.stop!=null ? (
                      <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end" }}>
                        <span style={{ color: p.stop_hit?C.down:C.ink }}>${p.stop}</span>
                        <span style={{ fontSize:8.5, fontWeight:700, color: p.stop_hit?C.down:C.up }}>{p.stop_hit?"HIT":`+${((p.stop_dist||0)*100).toFixed(0)}%`}</span>
                      </div>
                    ) : (
                      <span style={{ color:C.faint, fontSize:10 }} title="recommended stop">rec ${p.stop_rec ?? "—"}</span>
                    )}
                  </div>
                  <div style={{ position:"relative" }}
                    onMouseEnter={()=>setTooltip(p.id)}
                    onMouseLeave={()=>setTooltip(null)}>
                    <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:2, cursor:"default" }}>
                      <span style={{ fontFamily:C.mono, fontSize:13, fontWeight:800, letterSpacing:"0.06em", color:recColor(p.rec||convictionToRec(p.conviction)) }}>{p.rec||convictionToRec(p.conviction)||"—"}</span>
                      {p.stage && <span style={{ fontSize:9, color:stageColor(p.stage), lineHeight:1.3, textAlign:"right" }}>{stageEmoji(p.stage)} {p.stage}</span>}
                      {p.conviction && <span style={{ fontSize:8.5, fontWeight:600, color:convictionColor(p.conviction), textTransform:"uppercase", letterSpacing:"0.03em" }}>{p.conviction}</span>}
                    </div>
                    {tooltip===p.id && (
                      <div style={{ position:"absolute", right:0, bottom:"100%", zIndex:100, background:C.panel2, border:`1px solid ${C.line}`, borderRadius:10, padding:"12px 14px", width:240, boxShadow:"0 8px 24px rgba(0,0,0,0.3)", pointerEvents:"none" }}>
                        {p.reason && <div style={{ fontSize:11.5, color:C.ink, lineHeight:1.5, marginBottom:8, fontStyle:"italic" }}>{p.reason}</div>}
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6 }}>
                          {p.trade_levels?.entry  && <div><div style={{ fontSize:8.5, color:C.faint }}>ENTRY</div><div style={{ fontFamily:C.mono, fontSize:11.5, color:C.ink }}>${p.trade_levels.entry}</div></div>}
                          {p.trade_levels?.target && <div><div style={{ fontSize:8.5, color:C.faint }}>TARGET</div><div style={{ fontFamily:C.mono, fontSize:11.5, color:C.up }}>${p.trade_levels.target}</div></div>}
                          {(p.stop||p.stop_rec) && <div><div style={{ fontSize:8.5, color:C.faint }}>STOP</div><div style={{ fontFamily:C.mono, fontSize:11.5, color:C.down }}>${p.stop||p.stop_rec}</div></div>}
                          {p.trade_levels?.risk_reward && <div><div style={{ fontSize:8.5, color:C.faint }}>R:R</div><div style={{ fontFamily:C.mono, fontSize:11.5, color:C.amber }}>{p.trade_levels.risk_reward}</div></div>}
                        </div>
                      </div>
                    )}
                  </div>
                  <div style={{ display:"flex", gap:9, justifyContent:"flex-end", alignItems:"center" }}>
                    {isOpt && <button onClick={(e)=>{e.stopPropagation();setPayoff(p);}} title="Payoff diagram" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><LineChart size={13}/></button>}
                    <button onClick={(e)=>{e.stopPropagation();setEditing(p);setShowForm(false);}} title="Edit" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Pencil size={12}/></button>
                    <button onClick={(e)=>{e.stopPropagation();onRemove(p.id);}} title="Remove" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.down} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Trash2 size={13}/></button>
                  </div>
                </div>
              );
            })}
            {errored.map((p)=>(
              <div key={p.id} style={{ display:"grid", gridTemplateColumns:GRID, padding:"12px 16px", borderTop:`1px solid ${C.panel2}`, fontFamily:C.mono, fontSize:12, color:C.down, alignItems:"center" }}>
                <div style={{ display:"flex", alignItems:"center", gap:6, gridColumn:"1 / -2" }}><AlertCircle size={12}/> {p.ticker} — couldn't load ({p.error})</div>
                <div style={{ display:"flex", justifyContent:"flex-end" }}><button onClick={()=>onRemove(p.id)} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }}><Trash2 size={13}/></button></div>
              </div>
            ))}
           </div>
          </div>

          {/* Expired envelope (closed by default) */}
          {expired.length>0 && (
            <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, overflow:"hidden", marginBottom:16 }}>
              <button onClick={()=>setShowExpired(s=>!s)} style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", padding:"13px 16px", background:"none", border:"none", cursor:"pointer" }}>
                <span style={{ display:"flex", alignItems:"center", gap:9, fontSize:13, fontWeight:600, color:C.ink }}><Archive size={15} color={C.faint}/> Expired <span style={{ color:C.faint, fontWeight:400 }}>· {expired.length}</span></span>
                <ChevronDown size={16} color={C.faint} style={{ transform: showExpired?"rotate(180deg)":"none", transition:"transform .15s" }}/>
              </button>
              {showExpired && (
                <div style={{ borderTop:`1px solid ${C.line}` }}>
                  {expired.map((p)=>(
                    <div key={p.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"11px 16px", borderTop:`1px solid ${C.panel2}`, fontFamily:C.mono, fontSize:12 }}>
                      <div>
                        <span style={{ fontWeight:700, color:C.faint }}>{p.ticker} ${p.strike}{(p.type||"")[0]}</span>
                        <span style={{ fontSize:10, color:C.faint, marginLeft:8 }}>{p.qty}x · expired {p.expiry}</span>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                        <span style={{ color:(p.pnl||0)>=0?C.up:C.down }}>{(p.pnl||0)>=0?"+":""}${Math.abs(p.pnl||0).toLocaleString()}</span>
                        <button onClick={()=>setPayoff(p)} title="Payoff diagram" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><LineChart size={13}/></button>
                        <button onClick={()=>{setEditing(p);setShowForm(false);}} title="Edit / roll expiry" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Pencil size={13}/></button>
                        <button onClick={()=>onRemove(p.id)} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.down} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Trash2 size={14}/></button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Sector allocation */}
          {sectors.length>0 && (
            <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px" }}>
              <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:12 }}>Sector Allocation</div>
              {sectors.map(([name,val],i)=>{
                const pct = (val/totalAlloc)*100;
                return (
                  <div key={i} style={{ marginBottom:10 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:11.5, color:C.sub, marginBottom:4 }}>
                      <span>{name}</span><span style={{ fontFamily:C.mono }}>${val.toLocaleString(undefined,{maximumFractionDigits:0})} · {pct.toFixed(0)}%</span>
                    </div>
                    <div style={{ height:6, background:C.panel2, borderRadius:3, overflow:"hidden" }}>
                      <div style={{ width:`${pct}%`, height:"100%", background:C.violet, borderRadius:3 }}/>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {payoff && <PayoffModal position={payoff} onClose={()=>setPayoff(null)}/>}
    </div>
  );
}

function SectorRotationChart({ sectors }) {
  const [hov, setHov] = useState(null);
  if (!sectors?.length) return null;
  const W=420, H=320, PAD=44;
  const rsVals  = sectors.map(s=>s.rs),  momVals = sectors.map(s=>s.rs_mom);
  const rsR  = Math.max(Math.abs(Math.min(...rsVals)),  Math.abs(Math.max(...rsVals)),  2) * 1.3;
  const momR = Math.max(Math.abs(Math.min(...momVals)), Math.abs(Math.max(...momVals)), 1) * 1.3;
  const toX = rs  => PAD + (rs  / rsR  + 1) / 2 * (W - 2*PAD);
  const toY = mom => PAD + (1 - (mom / momR + 1) / 2) * (H - 2*PAD);
  const cx = toX(0), cy = toY(0);
  const qCol = q => q==="Leading"?C.up:q==="Weakening"?C.amber:q==="Improving"?C.cold:C.down;
  const abbr = n => ({
    "Technology":"Tech","Communication":"Comm","Financials":"Fins","Health Care":"Hlth",
    "Industrials":"Inds","Materials":"Matl","Real Estate":"RE","Energy":"Engy",
    "Utilities":"Util","Staples":"Stpl","Discretionary":"Disc"
  }[n] || n.slice(0,4));
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
        <span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>Sector Rotation Matrix</span>
        <div style={{ display:"flex", gap:12 }}>
          {[["Leading",C.up],["Weakening",C.amber],["Improving",C.cold],["Lagging",C.down]].map(([q,col])=>(
            <div key={q} style={{ display:"flex", alignItems:"center", gap:4, fontSize:10 }}>
              <div style={{ width:7, height:7, borderRadius:"50%", background:col }}/>
              <span style={{ color:C.faint }}>{q}</span>
            </div>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width:"100%", height:"auto", display:"block" }}>
        {/* Quadrant shading */}
        <rect x={PAD} y={PAD} width={cx-PAD} height={cy-PAD} fill={C.cold} opacity={0.05}/>
        <rect x={cx}  y={PAD} width={W-PAD-cx} height={cy-PAD} fill={C.up} opacity={0.05}/>
        <rect x={PAD} y={cy}  width={cx-PAD} height={H-PAD-cy} fill={C.down} opacity={0.05}/>
        <rect x={cx}  y={cy}  width={W-PAD-cx} height={H-PAD-cy} fill={C.amber} opacity={0.05}/>
        {/* Axes */}
        <line x1={PAD} y1={cy} x2={W-PAD} y2={cy} stroke={C.line} strokeWidth={1}/>
        <line x1={cx} y1={PAD} x2={cx} y2={H-PAD} stroke={C.line} strokeWidth={1}/>
        {/* Axis labels */}
        <text x={W-PAD-2} y={cy-5} fontSize={8} fill={C.faint} textAnchor="end">Outperforming →</text>
        <text x={PAD+2}   y={cy-5} fontSize={8} fill={C.faint}>← Underperforming</text>
        <text x={cx} y={PAD+10} fontSize={8} fill={C.faint} textAnchor="middle">Accelerating ↑</text>
        <text x={cx} y={H-PAD-4} fontSize={8} fill={C.faint} textAnchor="middle">↓ Decelerating</text>
        {/* Sector dots */}
        {sectors.map((s,i)=>{
          const x=toX(s.rs), y=toY(s.rs_mom), col=qCol(s.quadrant), isH=hov===i;
          return (
            <g key={i} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)} style={{cursor:"default"}}>
              <circle cx={x} cy={y} r={isH?9:7} fill={col} opacity={isH?1:0.8} stroke={C.bg} strokeWidth={1.5}/>
              <text x={x} y={y+17} fontSize={8} fill={isH?C.ink:C.sub} textAnchor="middle" fontWeight={isH?"700":"400"}>{abbr(s.sector)}</text>
              {isH && (
                <g>
                  <rect x={x-46} y={y-42} width={92} height={34} rx={5} fill={C.panel2} stroke={C.line}/>
                  <text x={x} y={y-28} fontSize={9} fill={C.ink} textAnchor="middle" fontWeight="700">{s.sector}</text>
                  <text x={x} y={y-16} fontSize={8} fill={col} textAnchor="middle">{s.quadrant} · RS {s.rs>=0?"+":""}{s.rs}% · {s.perf_1m>=0?"+":""}{s.perf_1m}% 1mo</text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── SECTOR MAP (hot/cold heatmap of market sectors) ───────────────────
function sectorHeat(month) {
  const m = Math.max(-10, Math.min(10, month ?? 0));   // clamp for color scaling
  const a = 0.10 + (Math.abs(m)/10) * 0.55;            // intensity by magnitude
  const rgb = m >= 0 ? "38,208,124" : "255,77,106";    // C.up / C.down
  return { bg:`rgba(${rgb},${a.toFixed(3)})`, border:`rgba(${rgb},${Math.min(1,a+0.3).toFixed(3)})`,
           txt: m >= 0 ? C.up : C.down };
}

// ── MACRO EVENTS TIMELINE ─────────────────────────────────────────────
function MacroEventsPanel({ events }) {
  if (!events?.length) return null;
  const typeColor = { FOMC:C.violet, CPI:C.amber, NFP:C.cold };
  const typeIcon  = { FOMC:"🏦", CPI:"📊", NFP:"💼" };
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:12 }}>Macro Events — Next 90 Days</div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {events.map((e, i) => (
          <div key={i} style={{ display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ width:60, fontFamily:C.mono, fontSize:10, color:typeColor[e.type]||C.sub,
              fontWeight:700, background:`${typeColor[e.type]||C.sub}15`, borderRadius:5, padding:"2px 6px", textAlign:"center", flexShrink:0 }}>
              {typeIcon[e.type]||"📅"} {e.type}
            </div>
            <div style={{ flex:1 }}>
              <span style={{ fontSize:12, color:C.ink }}>{e.name}</span>
              <span style={{ fontSize:10.5, color:C.faint, fontFamily:C.mono, marginLeft:8 }}>{e.date}</span>
            </div>
            <div style={{ fontFamily:C.mono, fontSize:11, fontWeight:700,
              color: e.days_away <= 7 ? C.amber : C.faint }}>
              {e.days_away === 0 ? "Today" : `${e.days_away}d`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── OPTIONS FLOW MAP ─────────────────────────────────────────────────
function OptionsFlowPanel({ flow }) {
  if (!flow?.length) return null;
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:12 }}>Options Flow — Your Tickers</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(160px, 1fr))", gap:10 }}>
        {flow.map((f, i) => {
          const biasColor = f.bias==="bullish" ? C.up : f.bias==="bearish" ? C.down : C.faint;
          return (
            <div key={i} style={{ background:C.panel2, borderRadius:10, padding:"12px 14px",
              border:`1px solid ${f.unusual ? biasColor : C.line}`, borderLeftWidth: f.unusual ? 3 : 1 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <span style={{ fontWeight:700, fontSize:13, color:C.ink }}>{f.ticker}</span>
                {f.unusual && <span style={{ fontSize:9, fontWeight:700, color:biasColor, background:`${biasColor}18`, borderRadius:4, padding:"1px 5px" }}>UNUSUAL</span>}
              </div>
              <div style={{ fontFamily:C.mono, fontSize:10.5, color:C.sub }}>P/C {f.pc_ratio} · Vol {f.rel_vol}×</div>
              <div style={{ fontFamily:C.mono, fontSize:10, fontWeight:700, color:biasColor, marginTop:4, textTransform:"uppercase" }}>{f.bias}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── EARNINGS MAP ─────────────────────────────────────────────────────
function EarningsMapPanel({ watchlist, cardCache, onOpen }) {
  const upcoming = (watchlist || [])
    .filter(t => cardCache[t]?.daysToEarn != null && cardCache[t].daysToEarn >= 0 && cardCache[t].daysToEarn <= 30)
    .sort((a,b) => cardCache[a].daysToEarn - cardCache[b].daysToEarn);
  if (!upcoming.length) return null;
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:12 }}>Earnings Map — Next 30 Days</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))", gap:10 }}>
        {upcoming.map(t => {
          const d = cardCache[t];
          const dte = d.daysToEarn;
          const urgency = dte <= 3 ? C.down : dte <= 7 ? C.amber : C.violet;
          const expectedMove = d.iv ? `±${(d.iv * Math.sqrt(dte / 365) * 100).toFixed(1)}%` : null;
          return (
            <div key={t} onClick={()=>onOpen(t)} style={{ background:C.panel2, borderRadius:10, padding:"12px 14px",
              border:`1px solid ${urgency}`, borderLeftWidth:3, cursor:"pointer" }}
              onMouseEnter={e=>e.currentTarget.style.background=C.line}
              onMouseLeave={e=>e.currentTarget.style.background=C.panel2}>
              <div style={{ fontWeight:700, fontSize:14, color:C.ink }}>{t}</div>
              <div style={{ fontFamily:C.mono, fontSize:11, color:urgency, fontWeight:700, marginTop:3 }}>
                {dte === 0 ? "Today" : `${dte}d`}
              </div>
              {expectedMove && (
                <div style={{ fontSize:9.5, color:C.faint, fontFamily:C.mono, marginTop:2 }}>exp move {expectedMove}</div>
              )}
              {d.fundamentals?.nextEarnings && (
                <div style={{ fontSize:9, color:C.faint, marginTop:2 }}>{d.fundamentals.nextEarnings}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── MARKET PULSE (Nicholas Crown) ────────────────────────────────────
function MarketPulsePanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(()=>{
    fetchYtInsights().then(x=>{ setData(x); setLoading(false); }).catch(()=>setLoading(false));
  },[]);
  if (loading) return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:8 }}>Market Pulse</div>
      <div style={{ color:C.faint, fontSize:12, display:"flex", alignItems:"center", gap:6 }}><Loader2 size={13} style={{ animation:"spin 1s linear infinite" }}/> Loading macro insights…</div>
    </div>
  );
  if (!data || data.error || !data.insights?.length) return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:6 }}>Market Pulse</div>
      <div style={{ fontSize:11.5, color:C.faint }}>
        {data?.error || "YouTube insights unavailable."}
        {data?.error?.includes("YT_NICHOLAS_CROWN") && <span style={{ color:C.amber }}> Set <code>YT_NICHOLAS_CROWN_CHANNEL_ID</code> in backend .env to enable.</span>}
      </div>
    </div>
  );
  const sentColor = s => s==="bullish" ? C.up : s==="bearish" ? C.down : C.faint;
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:18 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <div style={{ fontSize:13, fontWeight:700, color:C.ink }}>Market Pulse · Nicholas Crown</div>
        <span style={{ fontSize:10, color:C.faint }}>YouTube macro digest</span>
      </div>
      {data.insights.map((v, i) => (
        <div key={i} style={{ borderTop: i > 0 ? `1px solid ${C.line}` : "none", paddingTop: i > 0 ? 12 : 0, marginTop: i > 0 ? 12 : 0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
            <a href={v.link} target="_blank" rel="noopener noreferrer"
              style={{ fontSize:12.5, fontWeight:700, color:C.cold, textDecoration:"none", flex:1, marginRight:8, lineHeight:1.3 }}
              onClick={e=>e.stopPropagation()}>
              {v.title}
            </a>
            <span style={{ fontSize:9, fontWeight:700, color:sentColor(v.sentiment), background:`${sentColor(v.sentiment)}18`,
              borderRadius:4, padding:"1px 6px", flexShrink:0, textTransform:"uppercase" }}>{v.sentiment}</span>
          </div>
          {v.summary && <div style={{ fontSize:11.5, color:C.sub, marginBottom:6, lineHeight:1.45 }}>{v.summary}</div>}
          {v.takeaways?.length > 0 && (
            <ul style={{ margin:0, paddingLeft:16, color:C.faint, fontSize:11 }}>
              {v.takeaways.map((t,j) => <li key={j} style={{ marginBottom:2 }}>{t}</li>)}
            </ul>
          )}
          <div style={{ fontSize:10, color:C.faint, fontFamily:C.mono, marginTop:6 }}>{v.published}</div>
        </div>
      ))}
    </div>
  );
}

function SectorMap({ watchlist=[], cardCache={}, onOpen }) {
  const [d, setD]             = useState(null);
  const [rotation, setRotation] = useState(null);
  const [mapData, setMapData] = useState(null);
  const [err, setErr]         = useState(null);
  const [updated, setUpdated] = useState(null);
  const [sel, setSel]         = useState(null);

  const load = useCallback(()=>{
    setErr(null); setD(null);
    fetchSectors().then(x=>{ x.error?setErr(x.error):setD(x); setUpdated(new Date()); }).catch(e=>setErr(e.message));
    fetchSectorRotation().then(x=>{ if(!x.error) setRotation(x); }).catch(()=>{});
    fetchMapData(watchlist).then(x=>{ if(!x.error) setMapData(x); }).catch(()=>{});
  },[watchlist]);
  useEffect(()=>{ load(); },[load]);

  if (err) return <div style={{ padding:40, textAlign:"center", color:C.down }}>Sector map unavailable: {err}<br/><span style={{ color:C.faint, fontSize:12 }}>Is the backend running on {API}?</span></div>;
  if (!d)  return <div style={{ padding:60, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Mapping the market…</div></div>;

  const sectors = d.sectors || [];
  const leader  = sectors[0], laggard = sectors[sectors.length-1];

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:16, flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>Market Map</div>
          <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>Sectors · Earnings · Macro Events · Options Flow</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontSize:11, color:C.faint, fontFamily:C.mono }}>updated {updated?.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>
          <button onClick={load} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"7px 11px", color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12 }}><RefreshCw size={13}/> Refresh</button>
        </div>
      </div>

      {/* Earnings Map */}
      <EarningsMapPanel watchlist={watchlist} cardCache={cardCache} onOpen={onOpen}/>

      {/* Macro Events Timeline */}
      <MacroEventsPanel events={mapData?.macro_events}/>

      {/* Options Flow Map */}
      <OptionsFlowPanel flow={mapData?.options_flow}/>

      {/* Market Pulse — Nicholas Crown */}
      <MarketPulsePanel/>

      {/* Sector Heatmap */}
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:10 }}>Sector Heatmap</div>
      {/* Heatmap grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))", gap:12, marginBottom:18 }}>
        {sectors.map((s,i)=>{
          const m = s.month ?? 0, h = sectorHeat(m);
          const rot = rotation?.sectors?.find(r=>r.sector===s.name);
          return (
            <div key={i} onClick={()=>setSel(s)} style={{ background:h.bg, border:`1px solid ${h.border}`, borderRadius:12, padding:"16px 16px 14px", cursor:"pointer", transition:"transform .12s, box-shadow .12s" }}
              onMouseEnter={e=>{ e.currentTarget.style.transform="translateY(-2px)"; e.currentTarget.style.boxShadow="0 8px 22px rgba(0,0,0,0.18)"; }}
              onMouseLeave={e=>{ e.currentTarget.style.transform="none"; e.currentTarget.style.boxShadow="none"; }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
                <span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>{s.name}</span>
                {m>=8  && <Flame size={14} color={C.hot}/>}
                {m<=-5 && <Snowflake size={14} color={C.cold}/>}
              </div>
              <div style={{ fontFamily:C.mono, fontSize:26, fontWeight:700, color:h.txt, lineHeight:1 }}>{m>=0?"+":""}{m}%</div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:8 }}>
                <span style={{ fontSize:10, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase" }}>1-Month</span>
                <span style={{ fontFamily:C.mono, fontSize:11.5, color:(s.day??0)>=0?C.up:C.down, display:"flex", alignItems:"center", gap:3 }}><Trend v={s.day??0}/>{(s.day??0)>=0?"+":""}{s.day}% today</span>
              </div>
              {rot && (
                <div style={{ marginTop:6, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontFamily:C.mono, fontSize:10, color:rot.rs>=0?C.up:C.down }}>vs SPY {rot.rs>=0?"+":""}{rot.rs}%</span>
                  <span style={{ fontSize:9.5, color:C.faint }}>{rot.quadrant}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Sector Rotation Matrix */}
      <SectorRotationChart sectors={rotation?.sectors}/>

      {/* Leaders + legend */}
      {leader && laggard && (
        <div style={{ display:"flex", gap:14, flexWrap:"wrap", alignItems:"center" }}>
          <div style={{ flex:"1 1 220px", background:C.panel, border:`1px solid ${C.line}`, borderLeft:`3px solid ${C.up}`, borderRadius:10, padding:"12px 14px" }}>
            <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>LEADER</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginTop:3 }}>{leader.name} <span style={{ fontFamily:C.mono, color:C.up, fontWeight:600 }}>+{leader.month}%</span></div>
          </div>
          <div style={{ flex:"1 1 220px", background:C.panel, border:`1px solid ${C.line}`, borderLeft:`3px solid ${C.down}`, borderRadius:10, padding:"12px 14px" }}>
            <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>LAGGARD</div>
            <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginTop:3 }}>{laggard.name} <span style={{ fontFamily:C.mono, color:C.down, fontWeight:600 }}>{laggard.month}%</span></div>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:10.5, color:C.faint }}>
            <span>COLD</span>
            <div style={{ width:120, height:8, borderRadius:4, background:`linear-gradient(90deg, ${C.down}, ${C.line}, ${C.up})` }}/>
            <span>HOT</span>
          </div>
        </div>
      )}
      {sel && <SectorDetail sector={sel} onClose={()=>setSel(null)}/>}
    </div>
  );
}

// ── SECTOR DETAIL (drivers + 30-90 day forecast) ──────────────────────
function SectorDetail({ sector, onClose }) {
  const [d, setD]     = useState(null);
  const [err, setErr] = useState(null);
  useEffect(()=>{
    setD(null); setErr(null);
    fetchSector(sector.name).then(x=> x.error?setErr(x.error):setD(x)).catch(e=>setErr(e.message));
  },[sector.name]);
  useEffect(()=>{ const h=(e)=>{ if(e.key==="Escape") onClose(); }; window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h); },[onClose]);

  const m = sector.month ?? 0;
  const biasCol = (b)=> b==="bullish"?C.up : b==="bearish"?C.down : C.amber;
  const impCol  = (i)=> i==="positive"?C.up : i==="negative"?C.down : C.amber;

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:60, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"6vh 16px", overflowY:"auto" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.bg, border:`1px solid ${C.line}`, borderRadius:16, width:"100%", maxWidth:560, boxShadow:"0 24px 70px rgba(0,0,0,0.5)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"18px 20px", borderBottom:`1px solid ${C.line}` }}>
          <div>
            <div style={{ fontSize:18, fontWeight:800, color:C.ink }}>{sector.name}</div>
            <div style={{ fontSize:12, color:C.faint, marginTop:3 }}>{sector.etf && sector.etf!=="—" ? `${sector.etf} · ` : ""}<span style={{ fontFamily:C.mono, color:m>=0?C.up:C.down }}>{m>=0?"+":""}{m}% 1-mo</span> · <span style={{ fontFamily:C.mono, color:(sector.day??0)>=0?C.up:C.down }}>{(sector.day??0)>=0?"+":""}{sector.day}% today</span></div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={18}/></button>
        </div>

        <div style={{ padding:"18px 20px" }}>
          {err && <div style={{ color:C.down, fontSize:13 }}>Couldn't load: {err}</div>}
          {!d && !err && <div style={{ textAlign:"center", padding:"30px 0", color:C.sub }}><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:8, fontSize:12.5 }}>Analyzing {sector.name}…</div></div>}
          {d && (
            <>
              <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65, marginBottom:18 }}>{d.summary}</div>

              {d.forecast && (
                <div style={{ background:`${biasCol(d.forecast.bias)}0e`, border:`1px solid ${biasCol(d.forecast.bias)}40`, borderRadius:12, padding:"14px 16px", marginBottom:18 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                    <span style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase" }}>{d.forecast.horizon} Forecast</span>
                    <span style={{ fontSize:12.5, fontWeight:700, color:biasCol(d.forecast.bias), textTransform:"capitalize" }}>{d.forecast.bias}</span>
                  </div>
                  <div style={{ display:"flex", gap:18, marginBottom:8, fontFamily:C.mono, fontSize:12 }}>
                    <span style={{ color:C.sub }}>range <span style={{ color:C.ink }}>{d.forecast.expected_range}</span></span>
                    <span style={{ color:C.sub }}>confidence <span style={{ color:C.ink, textTransform:"capitalize" }}>{d.forecast.confidence}</span></span>
                  </div>
                  <div style={{ fontSize:12.5, color:C.sub, lineHeight:1.55 }}>{d.forecast.rationale}</div>
                </div>
              )}

              {d.drivers?.length>0 && (
                <div style={{ marginBottom:18 }}>
                  <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:10 }}>What's driving it</div>
                  {d.drivers.map((dr,i)=>(
                    <div key={i} style={{ display:"flex", gap:10, marginBottom:10 }}>
                      <div style={{ width:3, borderRadius:2, background:impCol(dr.impact), flexShrink:0 }}/>
                      <div>
                        <div style={{ fontSize:12.5, fontWeight:600, color:C.ink }}>{dr.factor} <span style={{ fontSize:10, fontWeight:500, color:impCol(dr.impact), textTransform:"capitalize" }}>· {dr.impact}</span></div>
                        <div style={{ fontSize:12, color:C.sub, lineHeight:1.5, marginTop:2 }}>{dr.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {d.catalysts?.length>0 && (
                <div>
                  <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:9 }}>Catalysts to watch</div>
                  {d.catalysts.map((c,i)=>(
                    <div key={i} style={{ display:"flex", gap:8, alignItems:"flex-start", fontSize:12.5, color:C.sub, marginBottom:6 }}>
                      <span style={{ color:C.violet }}>▸</span> {c}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── OPTIONS PAYOFF DIAGRAM (P&L at expiry vs. underlying) ──────────────
function PayoffModal({ position: p, onClose }) {
  const [hi, setHi] = useState(null);
  useEffect(()=>{ const h=(e)=>{ if(e.key==="Escape") onClose(); }; window.addEventListener("keydown",h); return ()=>window.removeEventListener("keydown",h); },[onClose]);
  const isCall = p.type === "CALL";
  const K = p.strike, qty = p.qty || 1, spot = p.spot || K;
  const premPaid = p.cost_basis || 0;
  const premPer  = qty ? premPaid/(qty*100) : 0;
  const breakeven = isCall ? K + premPer : K - premPer;
  const lo  = Math.max(0, Math.min(spot, K, breakeven) * 0.7);
  const hiP = (Math.max(spot, K, breakeven) * 1.3) || K*1.3;
  const N = 100;
  const xs = Array.from({length:N+1}, (_,i)=> lo + (hiP-lo)*i/N);
  const pnlAt = (S)=> (isCall ? Math.max(0,S-K) : Math.max(0,K-S))*qty*100 - premPaid;
  const ys = xs.map(pnlAt);
  const yMin = Math.min(...ys, 0), yMax = Math.max(...ys, 0);
  const W=1000, H=240, PAD=12, yRange=(yMax-yMin)||1;
  const xp=(S)=> ((S-lo)/(hiP-lo))*W;
  const yp=(v)=> H-PAD - ((v-yMin)/yRange)*(H-2*PAD);
  const line = xs.map((S,i)=>`${xp(S).toFixed(1)},${yp(ys[i]).toFixed(1)}`).join(" ");
  const zeroY = yp(0);
  const onMove=(e)=>{ const r=e.currentTarget.getBoundingClientRect(); setHi(Math.max(0,Math.min(N,Math.round(((e.clientX-r.left)/r.width)*N)))); };
  const curS = hi!=null ? xs[hi] : null, curP = hi!=null ? ys[hi] : null;
  const fmt=(v)=> `${v>=0?"+":"−"}$${Math.abs(Math.round(v)).toLocaleString()}`;

  const Chip = ({ label, value, col }) => (
    <div style={{ flex:"1 1 110px", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 11px" }}>
      <div style={{ fontSize:9, color:C.faint, letterSpacing:"0.05em" }}>{label}</div>
      <div style={{ fontFamily:C.mono, fontSize:14, color:col||C.ink, marginTop:3 }}>{value}</div>
    </div>
  );

  return (
    <div onClick={onClose} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.55)", zIndex:60, display:"flex", alignItems:"flex-start", justifyContent:"center", padding:"6vh 16px", overflowY:"auto" }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:C.bg, border:`1px solid ${C.line}`, borderRadius:16, width:"100%", maxWidth:620, boxShadow:"0 24px 70px rgba(0,0,0,0.5)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", padding:"18px 20px", borderBottom:`1px solid ${C.line}` }}>
          <div>
            <div style={{ fontSize:17, fontWeight:800, color:C.ink }}>{p.ticker} ${K} {p.type} <span style={{ fontSize:12, fontWeight:500, color:C.faint }}>· payoff at expiry</span></div>
            <div style={{ fontSize:12, color:C.faint, marginTop:3 }}>{qty} contract{qty===1?"":"s"} · exp {p.expiry} · spot <span style={{ fontFamily:C.mono, color:C.ink }}>${spot}</span></div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={18}/></button>
        </div>
        <div style={{ padding:"16px 20px 20px" }}>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:14 }}>
            <Chip label="BREAKEVEN" value={`$${breakeven.toFixed(2)}`}/>
            <Chip label="MAX LOSS" value={fmt(-premPaid)} col={C.down}/>
            <Chip label="PREMIUM / SH" value={`$${premPer.toFixed(2)}`}/>
            <Chip label="CURRENT P&L" value={fmt(p.pnl||0)} col={(p.pnl||0)>=0?C.up:C.down}/>
          </div>
          <div style={{ position:"relative" }} onMouseMove={onMove} onMouseLeave={()=>setHi(null)}>
            <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display:"block", overflow:"visible" }}>
              <line x1={0} y1={zeroY} x2={W} y2={zeroY} stroke={C.faint} strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke"/>
              <polyline points={line} fill="none" stroke={C.cold} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round"/>
              <line x1={xp(breakeven)} y1={0} x2={xp(breakeven)} y2={H} stroke={C.amber} strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke"/>
              {spot>=lo && spot<=hiP && <line x1={xp(spot)} y1={0} x2={xp(spot)} y2={H} stroke={C.ink} strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" opacity={0.45}/>}
              {hi!=null && <line x1={xp(curS)} y1={0} x2={xp(curS)} y2={H} stroke={C.faint} strokeWidth={1} vectorEffect="non-scaling-stroke"/>}
              {hi!=null && <circle cx={xp(curS)} cy={yp(curP)} r={4} fill={curP>=0?C.up:C.down} stroke={C.bg} strokeWidth={2} vectorEffect="non-scaling-stroke"/>}
            </svg>
            {hi!=null && (
              <div style={{ position:"absolute", top:-2, left:`${(hi/N)*100}%`, transform:`translateX(${hi>N*0.7?"-105%":hi<N*0.3?"5%":"-50%"})`, pointerEvents:"none", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:7, padding:"5px 9px", fontSize:11, fontFamily:C.mono, whiteSpace:"nowrap", color:C.ink, boxShadow:"0 6px 18px rgba(0,0,0,0.25)" }}>
                <span>${curS.toFixed(0)}</span> <span style={{ color:curP>=0?C.up:C.down, marginLeft:6 }}>{fmt(curP)}</span>
              </div>
            )}
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:C.faint, fontFamily:C.mono, marginTop:6 }}>
              <span>${lo.toFixed(0)}</span>
              <span style={{ color:C.amber }}>breakeven ${breakeven.toFixed(2)}</span>
              <span>${hiP.toFixed(0)}</span>
            </div>
          </div>
          <div style={{ fontSize:11, color:C.faint, marginTop:12, lineHeight:1.5 }}>
            P&amp;L at expiration vs. underlying price. Assumes a long {p.type?.toLowerCase()} held to expiry; max loss is the premium paid (${premPaid.toLocaleString()}). The amber line is breakeven, the faint line is today's spot.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── TRADER PROFILE MODAL ──────────────────────────────────────────────
const PROFILE_OPTIONS = {
  riskTolerance: {
    label: "Risk Tolerance",
    options: [
      { value:"conservative", label:"Conservative", desc:"Protect capital, small steady gains" },
      { value:"moderate",     label:"Moderate",     desc:"Balanced growth with manageable risk" },
      { value:"aggressive",   label:"Aggressive",   desc:"High risk, high reward" },
      { value:"degen",        label:"Degen",        desc:"Maximum risk, options heavy, big swings" },
    ]
  },
  goal: {
    label: "Primary Goal",
    options: [
      { value:"growth",      label:"Growth",      desc:"Maximize portfolio value long term" },
      { value:"income",      label:"Income",      desc:"Generate consistent returns" },
      { value:"speculation", label:"Speculation", desc:"Find big asymmetric opportunities" },
      { value:"hedging",     label:"Hedging",     desc:"Protect existing positions" },
    ]
  },
  style: {
    label: "Trading Style",
    options: [
      { value:"longterm",   label:"Long-Term Investor", desc:"Months to years" },
      { value:"swing",      label:"Swing Trader",       desc:"Days to weeks, technical setups" },
      { value:"options",    label:"Options Trader",     desc:"Leverage and Greeks focused" },
      { value:"daytrader",  label:"Day Trader",         desc:"Intraday moves" },
    ]
  },
  level: {
    label: "Experience Level",
    options: [
      { value:"beginner",      label:"Beginner",      desc:"Learning the basics" },
      { value:"intermediate",  label:"Intermediate",  desc:"Comfortable with most strategies" },
      { value:"advanced",      label:"Advanced",      desc:"Experienced across products" },
      { value:"professional",  label:"Professional",  desc:"Full-time or institutional" },
    ]
  },
};

function TraderProfileModal({ profile, onSave, onClose }) {
  const defaults = { riskTolerance:"moderate", goal:"growth", style:"swing", level:"intermediate" };
  const [draft, setDraft] = useState(profile || defaults);
  const set = (k, v) => setDraft(d => ({...d, [k]:v}));

  return (
    <div style={{ position:"fixed", inset:0, zIndex:200, background:"rgba(0,0,0,0.55)", display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}
      onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}>
      <div style={{ background:C.bg, border:`1px solid ${C.line}`, borderRadius:16, padding:"28px 30px", width:"100%", maxWidth:520, maxHeight:"90vh", overflowY:"auto", boxShadow:"0 24px 80px rgba(0,0,0,0.5)" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
          <div>
            <div style={{ fontSize:18, fontWeight:700, color:C.ink }}>Trader Profile</div>
            <div style={{ fontSize:11.5, color:C.sub, marginTop:3 }}>Personalizes all AI analysis to your style</div>
          </div>
          <button onClick={onClose} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:4 }}><X size={18}/></button>
        </div>
        {Object.entries(PROFILE_OPTIONS).map(([key, section])=>(
          <div key={key} style={{ marginBottom:20 }}>
            <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:10 }}>{section.label}</div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {section.options.map(opt=>{
                const sel = draft[key] === opt.value;
                return (
                  <div key={opt.value} onClick={()=>set(key, opt.value)}
                    style={{ background:sel?`${C.cold}18`:C.panel, border:`1.5px solid ${sel?C.cold:C.line}`, borderRadius:10, padding:"10px 13px", cursor:"pointer", transition:"all .15s" }}>
                    <div style={{ fontSize:12.5, fontWeight:700, color:sel?C.cold:C.ink }}>{opt.label}</div>
                    <div style={{ fontSize:10.5, color:C.sub, marginTop:3 }}>{opt.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ display:"flex", gap:9, marginTop:6 }}>
          <button onClick={()=>{ onSave(draft); onClose(); }}
            style={{ flex:1, background:C.cold, border:"none", borderRadius:10, padding:"11px 0", color:"#fff", fontSize:13.5, fontWeight:700, cursor:"pointer" }}>
            Save Profile
          </button>
          <button onClick={onClose}
            style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:10, padding:"11px 18px", color:C.sub, fontSize:13, cursor:"pointer" }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SETTINGS (theme + account) ────────────────────────────────────────
function SettingsMenu({ theme, setTheme, aiEnabled, setAiEnabled, userEmail, onProfileOpen }) {
  const [open, setOpen] = useState(false);
  const email = userEmail;
  return (
    <div style={{ position:"relative", flexShrink:0 }}>
      <button onClick={()=>setOpen(o=>!o)} title="Settings" style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 9px", color:open?C.ink:C.sub, cursor:"pointer", display:"flex" }}><Settings size={15}/></button>
      {open && (
        <>
          <div onClick={()=>setOpen(false)} style={{ position:"fixed", inset:0, zIndex:40 }}/>
          <div style={{ position:"absolute", right:0, top:"calc(100% + 8px)", width:240, background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, boxShadow:"0 14px 44px rgba(0,0,0,0.4)", zIndex:50, padding:"12px 14px" }}>
            <div style={{ marginBottom:14, paddingBottom:14, borderBottom:`1px solid ${C.line}` }}>
              <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", marginBottom:9 }}>TRADER PROFILE</div>
              <button onClick={()=>{ setOpen(false); onProfileOpen(); }}
                style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"space-between", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:8, padding:"9px 12px", color:C.ink, fontSize:12, fontWeight:600, cursor:"pointer" }}>
                Edit Trader Profile <ChevronDown size={12} color={C.faint} style={{ transform:"rotate(-90deg)" }}/>
              </button>
            </div>
            <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", marginBottom:9 }}>APPEARANCE</div>
            <div style={{ display:"flex", gap:6, background:C.panel2, borderRadius:9, padding:4, border:`1px solid ${C.line}` }}>
              {[["light","Light",Sun],["dark","Dark",Moon]].map(([id,label,Icon])=>(
                <button key={id} onClick={()=>setTheme(id)} style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6, padding:"7px 0", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:600, background:theme===id?C.line:"transparent", color:theme===id?C.ink:C.sub }}><Icon size={13}/> {label}</button>
              ))}
            </div>
            <div style={{ marginTop:14, paddingTop:12, borderTop:`1px solid ${C.line}` }}>
              <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", marginBottom:9 }}>AI FEATURES</div>
              <label style={{ display:"flex", alignItems:"center", gap:9, cursor:"pointer" }}>
                <div onClick={()=>setAiEnabled(v=>!v)}
                  style={{ width:32, height:18, borderRadius:9, background:aiEnabled?C.cold:C.line, position:"relative", transition:"background .2s", flexShrink:0, cursor:"pointer" }}>
                  <div style={{ position:"absolute", top:2, left:aiEnabled?14:2, width:14, height:14, borderRadius:"50%", background:"#fff", transition:"left .2s", boxShadow:"0 1px 3px rgba(0,0,0,0.2)" }}/>
                </div>
                <div>
                  <div style={{ fontSize:12, fontWeight:600, color:C.ink }}>AI Sentiment</div>
                  <div style={{ fontSize:11, color:C.faint, marginTop:1 }}>{aiEnabled ? "On — using Anthropic credits" : "Off — scores hidden"}</div>
                </div>
              </label>
            </div>
            {email && (
              <div style={{ marginTop:14, paddingTop:12, borderTop:`1px solid ${C.line}` }}>
                <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em", marginBottom:7 }}>ACCOUNT</div>
                <div style={{ fontSize:11.5, color:C.sub, marginBottom:9, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{email}</div>
                <button onClick={signOut} style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:7, background:"none", border:`1px solid ${C.line}`, borderRadius:8, padding:"8px 0", color:C.sub, fontSize:12, fontWeight:600, cursor:"pointer" }}><LogOut size={13}/> Sign out</button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────
export default function AlphaDesk({ userId = null, userEmail = null }) {
  const [tab, setTab]             = useState("watchlist");
  const [watchlist, setWatchlist] = useState(loadWL);
  const [detail, setDetail]       = useState(null);
  const [query, setQuery]         = useState("");
  const [positions, setPositions] = useState(loadPositions);
  const [portfolio, setPortfolio] = useState(null);
  const [pfErr, setPfErr]         = useState(null);
  const [pfLoading, setPfLoading] = useState(false);
  const [margin, setMargin]       = useState(0);
  const [marginRate, setMarginRate] = useState(0);
  const [cash, setCash]           = useState(0);
  const [profile, setProfile]     = useState(loadProfile);
  const [showProfile, setShowProfile] = useState(false);
  const [theme, setTheme]         = useState(loadTheme);
  const [aiEnabled, setAiEnabled]       = useState(loadAI);
  const [alertHistory, setAlertHistory] = useState(loadAlerts);
  applyTheme(theme);   // sync palette into C during render so children read the new colors immediately


  // localStorage fallback (instant load on first paint)
  useEffect(()=>{ saveWL(watchlist); },[watchlist]);
  useEffect(()=>{ savePositions(positions); },[positions]);
  useEffect(()=>{ saveAlerts(alertHistory); },[alertHistory]);
  useEffect(()=>{ saveAI(aiEnabled); },[aiEnabled]);
  useEffect(()=>{ if (profile) saveProfile(profile); },[profile]);

  // Keep-alive: ping the backend every 8 min so Render never cold-starts mid-session
  useEffect(()=>{
    const ping = () => fetch(`${API}/health`).catch(()=>{});
    ping(); // immediate ping on mount
    const id = setInterval(ping, 8 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Primary sync: Supabase (logged-in) or server positions.json (anonymous)
  useEffect(()=>{
    if (userId) {
      // Logged-in path: load full state from user's private Supabase row
      sbLoad(userId).then(data=>{
        if (!data) {
          // New user row — push up whatever we have locally
          sbSave(userId, { positions, watchlist, margin, marginRate, theme, aiEnabled });
          return;
        }
        if (data.positions?.length)  setPositions(data.positions);
        if (data.watchlist?.length)  setWatchlist(data.watchlist);
        if (data.margin    != null)  setMargin(data.margin);
        if (data.marginRate != null) setMarginRate(data.marginRate);
        if (data.cash      != null)  setCash(data.cash);
        if (data.profile   != null)  setProfile(data.profile);
        if (data.theme)              { setTheme(data.theme); applyTheme(data.theme); }
        if (data.aiEnabled != null)    setAiEnabled(data.aiEnabled);
        if (data.alertHistory?.length) setAlertHistory(data.alertHistory);
      }).catch(()=>{});
    } else {
      // Anonymous path: fall back to server positions.json + settings.json
      fetchPositions().then(srv=>{ const sp=srv.positions||[]; if(sp.length) setPositions(sp); else if(positions.length) savePositionsServer(positions); }).catch(()=>{});
      fetchSettings().then(s=>{ const st=s.settings||{}; if(st.margin!=null) setMargin(st.margin); if(st.margin_rate!=null) setMarginRate(st.margin_rate); }).catch(()=>{});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[userId]);

  // Save full state to Supabase whenever anything changes (debounced 1s)
  const sbTimer = useRef(null);
  const sbState = useRef({});
  sbState.current = { positions, watchlist, margin, marginRate, cash, profile, theme, aiEnabled, alertHistory };
  useEffect(()=>{
    if (!userId) return;
    clearTimeout(sbTimer.current);
    sbTimer.current = setTimeout(()=>{ sbSave(userId, sbState.current); }, 1000);
    return ()=>clearTimeout(sbTimer.current);
  },[positions, watchlist, margin, marginRate, cash, profile, theme, aiEnabled, alertHistory, userId]);

  const onMargin = (m, r)=>{ setMargin(m); setMarginRate(r); if(!userId) saveSettingsServer({ margin:m, margin_rate:r }); };
  const onCash   = (c)=>{ setCash(c); };

  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const valuePortfolio = useCallback((list, m=0, r=0)=>{
    setPfErr(null); setPfLoading(true);
    fetchValue(list, m, r).then(x=> x.error?setPfErr(x.error):setPortfolio(x)).catch(e=>setPfErr(e.message)).finally(()=>setPfLoading(false));
  },[]);
  // Re-value when positions' CONTENTS or the margin inputs change — not when merely reordered.
  const valSig = positions.map(p=>[p.ticker,p.type,p.strike,p.expiry,p.qty,p.cost_basis,p.stop].join("|")).sort().join(",");
  useEffect(()=>{ valuePortfolio(positionsRef.current, margin, marginRate); },[valSig, margin, marginRate, valuePortfolio]);

  // Merge portfolio + stop-hit alerts into persistent history whenever valuation updates
  useEffect(()=>{
    if (!portfolio) return;
    const stopAlerts = (portfolio.positions||[])
      .filter(p=>p.stop_hit)
      .map(p=>({ ticker:p.ticker, type:"STOP_HIT", severity:"red",
        message:`${p.ticker} hit stop — spot $${(p.spot||0).toFixed(2)} ≤ stop $${(p.stop||0).toFixed(2)}` }));
    const fresh = [...(portfolio.alerts||[]), ...stopAlerts];
    if (!fresh.length) return;
    setAlertHistory(prev => mergeAlerts(prev, fresh));
  },[portfolio]);

  // Every change updates state AND persists to the server so other browsers stay in sync.
  const commit         = (next)=>{ setPositions(next); savePositionsServer(next); };
  const addPosition    = (p)=> commit([...positions, { id:newId(), ...p }]);
  const updatePosition = (id, patch)=> commit(positions.map(p=> p.id===id ? { ...p, ...patch, id } : p));
  const removePosition = (id)=> commit(positions.filter(p=>p.id!==id));
  // Drag-to-reorder: persist the new order but skip re-valuation; reorder the already-valued
  // rows locally so the table updates instantly.
  const reorderById = (arr, dragId, dropId) => {
    const a=[...arr]; const from=a.findIndex(x=>x.id===dragId), to=a.findIndex(x=>x.id===dropId);
    if (from<0 || to<0 || from===to) return null;
    const [m]=a.splice(from,1); a.splice(to,0,m); return a;
  };
  const reorderPosition = (dragId, dropId) => {
    const next = reorderById(positions, dragId, dropId);
    if (!next) return;
    setPositions(next); savePositionsServer(next);
    setPortfolio(pf=>{ if(!pf) return pf; const np=reorderById(pf.positions||[], dragId, dropId); return np ? { ...pf, positions:np } : pf; });
  };

  const addTicker    = (t)=>{ const T=t.toUpperCase().trim(); if(T) setWatchlist(w=>w.includes(T)?w:[...w,T]); };
  const removeTicker = (t)=> setWatchlist(w=>w.filter(x=>x!==t));
  const toggleWatch  = (t)=> setWatchlist(w=>w.includes(t)?w.filter(x=>x!==t):[...w,t]);
  const runSearch    = ()=>{ const T=query.toUpperCase().trim(); if(T) setDetail(T); };
  const onAlertNavigate = (link) => {
    if (!link) return;
    if (link.startsWith("ticker:")) { setDetail(link.slice(7)); }
    else if (link === "portfolio")  { setDetail(null); setTab("portfolio"); }
    else if (link === "macro")      { setDetail(null); setTab("brief"); }
  };
  const [wlDrag, setWlDrag] = useState(null);
  const reorderWatch = (from, to)=> setWatchlist(w=>{ const a=[...w]; const [m]=a.splice(from,1); a.splice(to,0,m); return a; });

  // Collect card data as WatchCards finish loading (for the earnings strip)
  const [cardCache, setCardCache] = useState({});
  const handleCardData = useCallback((ticker, data) => {
    setCardCache(prev => prev[ticker] === data ? prev : { ...prev, [ticker]: data });
  }, []);

  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.ink, fontFamily:"'Inter',system-ui,sans-serif", overflowX:"hidden" }}>
      {/* ── Sticky top nav — always visible ─────────────────── */}
      <div style={{ borderBottom:`1px solid ${C.line}`, padding:"10px 14px", position:"sticky", top:0, background:C.bg, zIndex:20 }}>
        <div style={{ display:"flex", flexWrap:"wrap", justifyContent:"space-between", alignItems:"center", gap:8, maxWidth:1180, margin:"0 auto" }}>
          <div onClick={()=>{ setDetail(null); setTab("watchlist"); }} title="Go to Watchlist" style={{ fontWeight:800, fontSize:17, letterSpacing:"-0.02em", flexShrink:0, cursor:"pointer" }}>AlphaDesk <span style={{ color:C.hot }}>·</span></div>
          <div style={{ flex:"1 1 180px", maxWidth:420, position:"relative" }}>
            <Search size={15} color={C.faint} style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)" }}/>
            <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runSearch()}
              placeholder="Research any ticker — e.g. NVDA, TSLA, COIN"
              style={{ width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 12px 8px 36px", color:C.ink, fontSize:13, outline:"none", fontFamily:"inherit" }}
              onFocus={e=>e.target.style.borderColor=C.cold} onBlur={e=>e.target.style.borderColor=C.line}/>
            {query && <button onClick={()=>setQuery("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={14}/></button>}
          </div>
          <div style={{ display:"flex", gap:2, background:C.panel, borderRadius:9, padding:3, border:`1px solid ${C.line}`, flexShrink:0, flexWrap:"wrap" }}>
            {[["watchlist","Watchlist"],["portfolio","Portfolio"],["brief","News"],["map","Map"]].map(([id,label])=>(
              <button key={id} onClick={()=>{ setDetail(null); setTab(id); }}
                style={{ padding:"6px 14px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12.5, fontWeight:500,
                  background: !detail && tab===id ? C.line : "transparent",
                  color:      !detail && tab===id ? C.ink  : C.sub }}>{label}</button>
            ))}
          </div>
          <AlertsBell alertHistory={alertHistory} setAlertHistory={setAlertHistory} onNavigate={onAlertNavigate}/>
          {profile && (
            <div onClick={()=>setShowProfile(true)} title="Edit Trader Profile" style={{ display:"flex", alignItems:"center", gap:6, background:C.panel, border:`1px solid ${C.line}`, borderRadius:8, padding:"5px 10px", cursor:"pointer", flexShrink:0 }}>
              <span style={{ fontSize:10.5, color:C.cold, fontWeight:700 }}>
                {({conservative:"🛡️",moderate:"⚖️",aggressive:"⚡",degen:"🔥"}[profile.riskTolerance]||"👤")}
              </span>
              <span style={{ fontSize:10.5, color:C.sub, whiteSpace:"nowrap", display:"none", minWidth:0 }} className="profile-label">
                {({conservative:"Conservative",moderate:"Moderate",aggressive:"Aggressive",degen:"Degen"}[profile.riskTolerance]||"?")} · {({longterm:"Long-Term",swing:"Swing",options:"Options",daytrader:"Day"}[profile.style]||"?")}
              </span>
            </div>
          )}
          {showProfile && <TraderProfileModal profile={profile} onSave={p=>{ setProfile(p); }} onClose={()=>setShowProfile(false)}/>}
          <SettingsMenu theme={theme} setTheme={setTheme} aiEnabled={aiEnabled} setAiEnabled={setAiEnabled} userEmail={userEmail} onProfileOpen={()=>setShowProfile(true)}/>
        </div>
      </div>
      <MacroRibbon/>

      {/* ── Content area ─────────────────────────────────────── */}
      {detail ? (
        <DetailPage ticker={detail} onBack={()=>setDetail(null)} inWatchlist={watchlist.includes(detail)} onToggleWatch={toggleWatch} aiEnabled={aiEnabled} profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}/>
      ) : (
        <div style={{ maxWidth:1180, margin:"0 auto", padding:"16px 14px 60px" }}>
          {tab==="watchlist" && (
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>My Watchlist</div>
                  <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>{watchlist.length} stocks · live data · tap to open · drag to reorder</div>
                </div>
                <AddInline onAdd={addTicker}/>
              </div>

              {/* Upcoming earnings strip */}
              {(()=>{
                const soon = watchlist
                  .filter(t => cardCache[t]?.daysToEarn != null && cardCache[t].daysToEarn <= 14)
                  .sort((a,b) => cardCache[a].daysToEarn - cardCache[b].daysToEarn);
                if (!soon.length) return null;
                return (
                  <div style={{ marginBottom:18, background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"12px 18px", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
                    <span style={{ fontSize:11, fontWeight:600, color:C.sub, letterSpacing:"0.06em", flexShrink:0 }}>EARNINGS SOON</span>
                    {soon.map(t=>(
                      <div key={t} onClick={()=>setDetail(t)} style={{ cursor:"pointer", display:"flex", alignItems:"center", gap:7, background:C.panel2, borderRadius:7, padding:"5px 12px" }}
                        onMouseEnter={e=>e.currentTarget.style.background=C.line}
                        onMouseLeave={e=>e.currentTarget.style.background=C.panel2}>
                        <span style={{ fontWeight:700, fontSize:12.5, color:C.ink }}>{t}</span>
                        <span style={{ fontFamily:C.mono, fontSize:11, color:C.violet }}>in {cardCache[t].daysToEarn}d</span>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {watchlist.length===0 ? (
                <div style={{ textAlign:"center", padding:"50px 20px", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>Empty — search or add a ticker to start.</div>
              ) : (
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:12 }}>
                  {watchlist.map((t,i)=>(
                    <div key={t} draggable
                      onDragStart={()=>setWlDrag(i)}
                      onDragOver={e=>e.preventDefault()}
                      onDrop={e=>{ e.preventDefault(); if(wlDrag!=null && wlDrag!==i) reorderWatch(wlDrag,i); setWlDrag(null); }}
                      onDragEnd={()=>setWlDrag(null)}
                      style={{ opacity: wlDrag===i?0.35:1, transition:"opacity .12s" }}>
                      <WatchCard ticker={t} onOpen={setDetail} onRemove={removeTicker} aiEnabled={aiEnabled} onData={handleCardData} profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}/>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab==="portfolio" && <PortfolioPage positions={positions} data={portfolio} err={pfErr} loading={pfLoading} margin={margin} marginRate={marginRate} onMargin={onMargin} cash={cash} onCash={onCash} aiEnabled={aiEnabled} profile={profile} onAdd={addPosition} onUpdate={updatePosition} onRemove={removePosition} onReorder={reorderPosition} onRefresh={()=>valuePortfolio(positions, margin, marginRate)} onOpen={setDetail}/>}
          {tab==="brief" && <BriefingRoom/>}
          {tab==="map" && <SectorMap watchlist={watchlist} cardCache={cardCache} onOpen={setDetail}/>}
        </div>
      )}
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function AddInline({ onAdd }) {
  const [open,setOpen]=useState(false); const [val,setVal]=useState("");
  if(!open) return <button onClick={()=>setOpen(true)} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 13px", color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12.5 }}><Plus size={14}/> Add stock</button>;
  return (
    <div style={{ display:"flex", gap:6 }}>
      <input autoFocus value={val} onChange={e=>setVal(e.target.value)}
        onKeyDown={e=>{ if(e.key==="Enter"){onAdd(val);setVal("");setOpen(false);} if(e.key==="Escape")setOpen(false); }}
        placeholder="Ticker…" style={{ background:C.panel, border:`1px solid ${C.cold}`, borderRadius:9, padding:"8px 11px", color:C.ink, fontSize:12.5, outline:"none", width:110, fontFamily:"inherit", textTransform:"uppercase" }}/>
      <button onClick={()=>{onAdd(val);setVal("");setOpen(false);}} style={{ background:C.up, border:"none", borderRadius:9, padding:"8px 13px", color:"#06080d", cursor:"pointer", fontSize:12.5, fontWeight:600 }}>Add</button>
      <button onClick={()=>setOpen(false)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 11px", color:C.faint, cursor:"pointer" }}><X size={14}/></button>
    </div>
  );
}
