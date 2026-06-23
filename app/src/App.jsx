import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Plus, X, Flame, Snowflake, ChevronLeft, RefreshCw, ArrowUpRight, ArrowDownRight, Minus, Star, TrendingUp, Newspaper, Loader2, AlertCircle, Bell, Activity, Archive, ChevronDown, Trash2, Settings, Sun, Moon, Pencil, LineChart, GripVertical, ArrowUp, ArrowDown, LogOut } from "lucide-react";
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
async function fetchResearch(ticker, ai = false) {
  const r = await fetch(`${API}/research?ticker=${encodeURIComponent(ticker)}&ai=${ai ? 1 : 0}`);
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
const scoreLabel = (s) => s==null?"AI off":s>=7.5?"Bullish":s>=6?"Lean Bull":s>=4?"Neutral":s>=2.5?"Lean Bear":"Bearish";

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

function ScoreDial({ score, size=44 }) {
  const has = score!=null && !isNaN(score);
  const col = scoreColor(score), pct = has ? score/10 : 0, r = size/2-3;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.line} strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={3}
          strokeDasharray={`${pct*2*Math.PI*r} ${2*Math.PI*r}`} strokeLinecap="round"/>
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:C.mono, fontSize:size>40?13:11, fontWeight:700, color:col }}>{has ? score.toFixed(1) : "—"}</div>
    </div>
  );
}

// ── WATCHLIST CARD (fetches its own data) ─────────────────────────────
function WatchCard({ ticker, onOpen, onRemove, aiEnabled }) {
  const [d, setD]       = useState(null);
  const [err, setErr]   = useState(false);
  useEffect(()=>{
    let alive = true;
    setD(null); setErr(false);
    fetchResearch(ticker, aiEnabled).then(x=>{ if(alive){ x.error?setErr(true):setD(x); }}).catch(()=>alive&&setErr(true));
    return ()=>{ alive=false; };
  },[ticker, aiEnabled]);

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
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:11 }}>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.06em" }}>SENTIMENT</div>
            <div style={{ fontSize:11, fontWeight:600,
              color: aiEnabled && d.ai_error && d.ai_error !== "ai_disabled" ? C.amber : scoreColor(d.score) }}>
              {aiEnabled && d.ai_error && d.ai_error !== "ai_disabled" ? "API error" : scoreLabel(d.score)}
            </div>
          </div>
          <ScoreDial score={d.score}/>
        </div>
      </div>
      {d.history && <div style={{ marginTop:10 }}><Sparkline data={d.history} h={30} color={d.chg>=0?C.up:C.down}/></div>}
      <div style={{ display:"flex", gap:7, marginTop:10 }}>
        <span style={{ fontFamily:C.mono, fontSize:10, color:C.sub, background:C.panel2, padding:"2px 7px", borderRadius:4 }}>RSI {d.rsi}</span>
        {d.iv && <span style={{ fontFamily:C.mono, fontSize:10, color:C.amber, background:`${C.amber}14`, padding:"2px 7px", borderRadius:4 }}>IV {d.iv}%</span>}
        {d.play && <span style={{ fontFamily:C.mono, fontSize:10, color:C.up, background:`${C.up}14`, padding:"2px 7px", borderRadius:4 }}>PLAY ✓</span>}
      </div>
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
function DetailPage({ ticker, onBack, inWatchlist, onToggleWatch, aiEnabled }) {
  const [d, setD]   = useState(null);
  const [err, setErr] = useState(null);
  useEffect(()=>{
    setD(null); setErr(null);
    fetchResearch(ticker, aiEnabled).then(x=> x.error ? setErr(x.error) : setD(x)).catch(e=>setErr(e.message));
  },[ticker, aiEnabled]);

  if (err) return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"20px 26px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.cold, cursor:"pointer", display:"flex", gap:5, alignItems:"center", marginBottom:18, fontSize:13 }}><ChevronLeft size={16}/> Watchlist</button>
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
    <div style={{ maxWidth:860, margin:"0 auto", padding:"20px 26px 60px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.cold, cursor:"pointer", display:"flex", gap:5, alignItems:"center", marginBottom:18, fontSize:13 }}><ChevronLeft size={16}/> Watchlist</button>

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
      <div style={{ display:"flex", gap:14, marginBottom:22 }}>
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1 }}>
          <div style={{ fontFamily:C.mono, fontSize:30, color:C.ink, fontWeight:600 }}>${d.spot}</div>
          <div style={{ fontFamily:C.mono, fontSize:14, color:d.chg>=0?C.up:C.down, display:"flex", alignItems:"center", gap:4, marginTop:2 }}><Trend v={d.chg}/>{d.chg>=0?"+":""}{d.chg}% today</div>
        </div>
        {aiOk ? (
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1, display:"flex", alignItems:"center", gap:16 }}>
            <ScoreDial score={d.score} size={56}/>
            <div>
              <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>ALPHADESK SCORE</div>
              <div style={{ fontSize:17, color:scoreColor(d.score), fontWeight:700 }}>{scoreLabel(d.score)}</div>
              <div style={{ fontSize:10.5, color:C.faint, marginTop:2 }}>0 bearish · 10 bullish</div>
            </div>
          </div>
        ) : (
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1, display:"flex", alignItems:"center", gap:12, opacity:0.55 }}>
            <ScoreDial score={null} size={56}/>
            <div>
              <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>ALPHADESK SCORE</div>
              <div style={{ fontSize:13, color:C.faint, fontWeight:500, marginTop:2 }}>{aiFail ? "API error" : "AI Insights off"}</div>
              <div style={{ fontSize:10.5, color:C.faint, marginTop:2 }}>enable in Settings →</div>
            </div>
          </div>
        )}
      </div>

      {/* ── 60-Day Chart ───────────────────────────────────── */}
      {d.history && (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px 12px", marginBottom:14 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:10 }}>
            <span style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase" }}>60-Day Price</span>
            <span style={{ fontSize:10.5, color:C.faint }}>hover to inspect</span>
          </div>
          <InteractiveChart data={d.history} dates={d.history_dates} color={d.chg>=0?C.up:C.down}/>
        </div>
      )}

      {/* ── Technicals grid (always) ───────────────────────── */}
      {d.fundamentals && (
        <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap" }}>
          {Object.entries({
            "P/E":          d.fundamentals.pe,
            "Rev Growth":   d.fundamentals.revGrowth,
            "Gross Margin": d.fundamentals.grossMargin,
            "RSI":          d.rsi,
            "IV":           d.iv ? `${d.iv}%` : "—",
            "Earnings":     d.fundamentals.nextEarnings,
          }).map(([k,v])=>(
            <div key={k} style={{ flex:"1 1 110px", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:9, padding:"10px 12px" }}>
              <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.05em" }}>{k.toUpperCase()}</div>
              <div style={{ fontFamily:C.mono, fontSize:13.5, color:C.ink, marginTop:3 }}>{v}</div>
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

      {/* ── AI: Analysis + scored news + play (only when AI on) */}
      {aiOk && d.summary && (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
          <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:9 }}>Analysis</div>
          <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65 }}>{d.summary}</div>
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

// ── BRIEFING ROOM (refreshes every open/focus) ────────────────────────
function BriefingRoom() {
  const [b, setB]   = useState(null);
  const [err, setErr] = useState(null);
  const [updated, setUpdated] = useState(null);
  const [selSector, setSelSector] = useState(null);

  const load = useCallback(()=>{
    setErr(null);
    fetchBriefing().then(x=>{ setB(x); setUpdated(new Date()); }).catch(e=>setErr(e.message));
  },[]);

  // Refresh on mount + every time the tab/window regains focus
  useEffect(()=>{
    load();
    const onFocus = ()=>load();
    const onVis   = ()=>{ if(!document.hidden) load(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return ()=>{
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  },[load]);

  if (err) return <div style={{ padding:40, textAlign:"center", color:C.down }}>News unavailable: {err}<br/><span style={{ color:C.faint, fontSize:12 }}>Is the backend running on {API}?</span></div>;
  if (!b)  return <div style={{ padding:60, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Loading News…</div></div>;

  const sc = b.climate?.macro_score ?? 50;
  const scoreCol = sc>60?C.up:sc>35?C.amber:C.down;
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:16 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>News</div>
        <div style={{ fontSize:11, color:C.faint, fontFamily:C.mono }}>updated {updated?.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"})}</div>
      </div>
      {/* Climate */}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"18px 20px", marginBottom:14, display:"flex", gap:22, alignItems:"center" }}>
        <div style={{ textAlign:"center", paddingRight:22, borderRight:`1px solid ${C.line}` }}>
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
      {/* Sector rotation */}
      {(b.sectors||[]).length>0 && (
        <div style={{ marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:11 }}>
            <Activity size={15} color={C.violet}/><span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>Sector Rotation</span>
            <span style={{ fontSize:11, color:C.faint }}>— click for 30-90 day forecast</span>
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(150px, 1fr))", gap:10 }}>
            {b.sectors.map((s,i)=>{ const m=s.month??0, h=sectorHeat(m); return (
              <div key={i} onClick={()=>setSelSector(s)} style={{ background:h.bg, border:`1px solid ${h.border}`, borderRadius:10, padding:"11px 13px", cursor:"pointer", transition:"transform .12s" }}
                onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"} onMouseLeave={e=>e.currentTarget.style.transform="none"}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span style={{ fontSize:12, fontWeight:700, color:C.ink }}>{s.name}</span>
                  <span style={{ fontFamily:C.mono, fontSize:13, fontWeight:700, color:h.txt }}>{m>=0?"+":""}{m}%</span>
                </div>
              </div>
            ); })}
          </div>
        </div>
      )}
      {/* Plays */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:12 }}>
        <TrendingUp size={15} color={C.violet}/><span style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>Today's Plays</span>
      </div>
      {(b.plays||[]).map((p,i)=>(
        <div key={i} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"14px 16px", marginBottom:10 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontWeight:700, color:C.ink }}>{p.ticker} <span style={{ fontFamily:C.mono, fontSize:12, color:C.amber, fontWeight:400 }}>${p.strike}{p.direction?.[0]} · {p.expiry} · {p.dte}d</span></span>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.sub }}>bull {p.prob?.bull}% / bear {p.prob?.bear}%</span>
          </div>
          <div style={{ fontSize:12, color:C.sub, lineHeight:1.55, marginTop:7 }}>{p.thesis}</div>
        </div>
      ))}
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
        <div><label style={lbl}>COST BASIS ($)</label><input value={cost} onChange={e=>setCost(e.target.value)} type="number" placeholder="total paid" style={inp}/></div>
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

// ── PORTFOLIO (manual positions, Greeks, P&L; expired in an envelope) ───
function PortfolioPage({ positions, data, err, loading, margin, marginRate, onMargin, onAdd, onUpdate, onRemove, onReorder, onRefresh, onOpen }) {
  const [showForm, setShowForm]       = useState(false);
  const [editing, setEditing]         = useState(null);
  const [showExpired, setShowExpired] = useState(false);
  const [payoff, setPayoff]           = useState(null);
  const [sort, setSort]               = useState({ key:null, dir:null });
  const [dragId, setDragId]           = useState(null);

  const a       = data?.analytics || {};
  const active  = data?.positions || [];
  const expired = data?.expired   || [];
  const errored = data?.errored   || [];
  const pnlCol  = (a.total_pnl||0)>=0?C.up:C.down;
  const num = (v, d=2) => (v===null||v===undefined) ? "—" : Number(v).toFixed(d);
  const sectors = Object.entries(a.sector_alloc||{}).sort((x,y)=>y[1]-x[1]);
  const totalAlloc = sectors.reduce((s,[,v])=>s+v,0) || 1;
  const GRID = "1.5fr 1fr 1fr 1fr 1fr 1fr 0.8fr 0.9fr 0.8fr 0.8fr 1.1fr 1.3fr 78px";
  const COLS = [
    {key:"ticker",      label:"Position", align:"left"},
    {key:"cost_basis",  label:"Cost",     align:"right"},
    {key:"spot",        label:"Spot",     align:"right"},
    {key:"current_val", label:"Value",    align:"right"},
    {key:"pnl",         label:"P&L",      align:"right"},
    {key:"pnl_pct",     label:"P&L %",    align:"right"},
    {key:"delta",       label:"Δ",        align:"right"},
    {key:"theta",       label:"Θ/day",    align:"right"},
    {key:"iv",          label:"IV",       align:"right"},
    {key:"dte",         label:"DTE",      align:"right"},
    {key:"stop",        label:"Stop",     align:"right"},
    {key:"score",       label:"Signal",   align:"right"},
  ];
  const toggleSort = (key)=> setSort(s=> s.key!==key ? {key,dir:"desc"} : s.dir==="desc" ? {key,dir:"asc"} : {key:null,dir:null});
  const sortVal = (p,key)=> key==="ticker" ? (p.ticker||"") : (p[key] ?? -Infinity);
  const displayed = sort.key
    ? [...active].sort((x,y)=>{ const xv=sortVal(x,sort.key), yv=sortVal(y,sort.key);
        if (typeof xv==="string") return sort.dir==="asc" ? xv.localeCompare(yv) : yv.localeCompare(xv);
        return sort.dir==="asc" ? xv-yv : yv-xv; })
    : active;
  const recColor   = (r)=> r==="BUY"?C.up : r==="SELL"?C.down : C.amber;
  const scoreColr  = (s)=> s==null?C.faint : s>=67?C.up : s>=40?C.amber : C.down;

  const Stat = ({ label, value, sub, col }) => (
    <div style={{ flex:"1 1 180px", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 18px" }}>
      <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>{label}</div>
      <div style={{ fontFamily:C.mono, fontSize:24, fontWeight:700, color:col||C.ink, marginTop:4 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.sub, marginTop:2 }}>{sub}</div>}
    </div>
  );

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
            <MarginCard/>
          </div>

          {/* Active positions */}
          <div style={{ fontSize:11, color:C.faint, marginBottom:7 }}>{sort.key ? "Sorted — clear the sort (click the header again) to drag-reorder" : "Click a column to sort · drag the handle to reorder"}</div>
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, overflowX:"auto", marginBottom:16 }}>
           <div style={{ minWidth:1180 }}>
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
                  style={{ display:"grid", gridTemplateColumns:GRID, padding:"12px 16px", borderTop:`1px solid ${C.panel2}`, fontFamily:C.mono, fontSize:12, color:C.ink, alignItems:"center", opacity: dragId===p.id?0.4:1 }}
                  onMouseEnter={e=>e.currentTarget.style.background=C.panel2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <div style={{ display:"flex", alignItems:"center", gap:7, minWidth:0 }} onClick={()=>onOpen&&onOpen(p.ticker)}>
                    {canDrag && <GripVertical size={13} color={C.faint} style={{ flexShrink:0, cursor:"grab" }}/>}
                    <div style={{ display:"flex", flexDirection:"column", gap:2, minWidth:0, cursor:"pointer" }}>
                      <span style={{ fontWeight:700, fontFamily:"inherit" }}>{label}</span>
                      <span style={{ fontSize:9.5, color:C.faint, whiteSpace:"nowrap" }}>{isOpt ? `${p.qty}x · exp ${p.expiry}` : `${p.qty} shares`}</span>
                    </div>
                  </div>
                  <div style={{ textAlign:"right", color:C.sub }}>${(p.cost_basis||0).toLocaleString()}</div>
                  <div style={{ textAlign:"right" }}>${num(p.spot)}</div>
                  <div style={{ textAlign:"right" }}>${(p.current_val||0).toLocaleString(undefined,{maximumFractionDigits:0})}</div>
                  <div style={{ textAlign:"right", color:(p.pnl||0)>=0?C.up:C.down }}>{(p.pnl||0)>=0?"+":""}{(p.pnl||0).toLocaleString(undefined,{maximumFractionDigits:0})}</div>
                  <div style={{ textAlign:"right", color:(p.pnl_pct||0)>=0?C.up:C.down }}>{((p.pnl_pct||0)*100).toFixed(1)}%</div>
                  <div style={{ textAlign:"right", color:C.sub }}>{num(p.delta,2)}</div>
                  <div style={{ textAlign:"right", color:C.sub }}>{p.theta?num(p.theta,2):"—"}</div>
                  <div style={{ textAlign:"right", color:C.amber }}>{p.iv?`${(p.iv*100).toFixed(0)}%`:"—"}</div>
                  <div style={{ textAlign:"right", color:C.sub }}>{p.dte??"—"}</div>
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
                  <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:2 }}>
                    <span style={{ fontWeight:700, color:scoreColr(p.score) }}>{p.score==null?"—":p.score}</span>
                    {p.rec && <span style={{ fontSize:8.5, fontWeight:700, letterSpacing:"0.04em", color:recColor(p.rec), background:`${recColor(p.rec)}1c`, padding:"1px 6px", borderRadius:4 }}>{p.rec}</span>}
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

// ── SECTOR MAP (hot/cold heatmap of market sectors) ───────────────────
function sectorHeat(month) {
  const m = Math.max(-10, Math.min(10, month ?? 0));   // clamp for color scaling
  const a = 0.10 + (Math.abs(m)/10) * 0.55;            // intensity by magnitude
  const rgb = m >= 0 ? "38,208,124" : "255,77,106";    // C.up / C.down
  return { bg:`rgba(${rgb},${a.toFixed(3)})`, border:`rgba(${rgb},${Math.min(1,a+0.3).toFixed(3)})`,
           txt: m >= 0 ? C.up : C.down };
}

function SectorMap() {
  const [d, setD]         = useState(null);
  const [err, setErr]     = useState(null);
  const [updated, setUpdated] = useState(null);
  const [sel, setSel]     = useState(null);

  const load = useCallback(()=>{
    setErr(null); setD(null);
    fetchSectors().then(x=>{ x.error?setErr(x.error):setD(x); setUpdated(new Date()); }).catch(e=>setErr(e.message));
  },[]);
  useEffect(()=>{ load(); },[load]);

  if (err) return <div style={{ padding:40, textAlign:"center", color:C.down }}>Sector map unavailable: {err}<br/><span style={{ color:C.faint, fontSize:12 }}>Is the backend running on {API}?</span></div>;
  if (!d)  return <div style={{ padding:60, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Mapping the market…</div></div>;

  const sectors = d.sectors || [];
  const leader  = sectors[0], laggard = sectors[sectors.length-1];

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:16 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>Sector Map</div>
          <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>Hot &amp; cold across the market · click a sector for drivers &amp; forecast</div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontSize:11, color:C.faint, fontFamily:C.mono }}>updated {updated?.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>
          <button onClick={load} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"7px 11px", color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12 }}><RefreshCw size={13}/> Refresh</button>
        </div>
      </div>

      {/* Heatmap grid */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(180px, 1fr))", gap:12, marginBottom:18 }}>
        {sectors.map((s,i)=>{
          const m = s.month ?? 0, h = sectorHeat(m);
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
            </div>
          );
        })}
      </div>

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

// ── SETTINGS (theme + account) ────────────────────────────────────────
function SettingsMenu({ theme, setTheme, aiEnabled, setAiEnabled, userEmail }) {
  const [open, setOpen] = useState(false);
  const email = userEmail;
  return (
    <div style={{ position:"relative", flexShrink:0 }}>
      <button onClick={()=>setOpen(o=>!o)} title="Settings" style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 9px", color:open?C.ink:C.sub, cursor:"pointer", display:"flex" }}><Settings size={15}/></button>
      {open && (
        <>
          <div onClick={()=>setOpen(false)} style={{ position:"fixed", inset:0, zIndex:40 }}/>
          <div style={{ position:"absolute", right:0, top:"calc(100% + 8px)", width:240, background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, boxShadow:"0 14px 44px rgba(0,0,0,0.4)", zIndex:50, padding:"12px 14px" }}>
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
  const [theme, setTheme]         = useState(loadTheme);
  const [aiEnabled, setAiEnabled]       = useState(loadAI);
  const [alertHistory, setAlertHistory] = useState(loadAlerts);
  applyTheme(theme);   // sync palette into C during render so children read the new colors immediately


  // localStorage fallback (instant load on first paint)
  useEffect(()=>{ saveWL(watchlist); },[watchlist]);
  useEffect(()=>{ savePositions(positions); },[positions]);
  useEffect(()=>{ saveAlerts(alertHistory); },[alertHistory]);
  useEffect(()=>{ saveAI(aiEnabled); },[aiEnabled]);

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
  sbState.current = { positions, watchlist, margin, marginRate, theme, aiEnabled, alertHistory };
  useEffect(()=>{
    if (!userId) return;
    clearTimeout(sbTimer.current);
    sbTimer.current = setTimeout(()=>{ sbSave(userId, sbState.current); }, 1000);
    return ()=>clearTimeout(sbTimer.current);
  },[positions, watchlist, margin, marginRate, theme, aiEnabled, alertHistory, userId]);

  const onMargin = (m, r)=>{ setMargin(m); setMarginRate(r); if(!userId) saveSettingsServer({ margin:m, margin_rate:r }); };

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

  if (detail) return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.ink, fontFamily:"'Inter',system-ui,sans-serif" }}>
      <DetailPage ticker={detail} onBack={()=>setDetail(null)} inWatchlist={watchlist.includes(detail)} onToggleWatch={toggleWatch} aiEnabled={aiEnabled}/>
      <div style={{ position:"fixed", top:14, right:20, zIndex:30 }}>
        <AlertsBell alertHistory={alertHistory} setAlertHistory={setAlertHistory} onNavigate={onAlertNavigate}/>
      </div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.ink, fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ borderBottom:`1px solid ${C.line}`, padding:"14px 26px", position:"sticky", top:0, background:C.bg, zIndex:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:20, maxWidth:1180, margin:"0 auto" }}>
          <div onClick={()=>{ setDetail(null); setTab("watchlist"); }} title="Go to Watchlist" style={{ fontWeight:800, fontSize:17, letterSpacing:"-0.02em", flexShrink:0, cursor:"pointer" }}>AlphaDesk <span style={{ color:C.hot }}>·</span></div>
          <div style={{ flex:1, maxWidth:420, position:"relative" }}>
            <Search size={15} color={C.faint} style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)" }}/>
            <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runSearch()}
              placeholder="Research any ticker — e.g. NVDA, TSLA, COIN"
              style={{ width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 12px 9px 36px", color:C.ink, fontSize:13, outline:"none", fontFamily:"inherit" }}
              onFocus={e=>e.target.style.borderColor=C.cold} onBlur={e=>e.target.style.borderColor=C.line}/>
            {query && <button onClick={()=>setQuery("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={14}/></button>}
          </div>
          <div style={{ display:"flex", gap:2, background:C.panel, borderRadius:9, padding:3, border:`1px solid ${C.line}`, flexShrink:0 }}>
            {[["watchlist","Watchlist"],["portfolio","Portfolio"],["brief","News"],["map","Map"]].map(([id,label])=>(
              <button key={id} onClick={()=>setTab(id)} style={{ padding:"6px 14px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12.5, fontWeight:500, background:tab===id?C.line:"transparent", color:tab===id?C.ink:C.sub }}>{label}</button>
            ))}
          </div>
          <AlertsBell alertHistory={alertHistory} setAlertHistory={setAlertHistory} onNavigate={onAlertNavigate}/>
          <SettingsMenu theme={theme} setTheme={setTheme} aiEnabled={aiEnabled} setAiEnabled={setAiEnabled} userEmail={userEmail}/>
        </div>
      </div>
      <MacroRibbon/>

      <div style={{ maxWidth:1180, margin:"0 auto", padding:"22px 26px 60px" }}>
        {tab==="watchlist" && (
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>My Watchlist</div>
                <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>{watchlist.length} stocks · live data · tap to open · drag to reorder</div>
              </div>
              <AddInline onAdd={addTicker}/>
            </div>
            {watchlist.length===0 ? (
              <div style={{ textAlign:"center", padding:"50px 20px", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>Empty — search or add a ticker to start.</div>
            ) : (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap:14 }}>
                {watchlist.map((t,i)=>(
                  <div key={t} draggable
                    onDragStart={()=>setWlDrag(i)}
                    onDragOver={e=>e.preventDefault()}
                    onDrop={e=>{ e.preventDefault(); if(wlDrag!=null && wlDrag!==i) reorderWatch(wlDrag,i); setWlDrag(null); }}
                    onDragEnd={()=>setWlDrag(null)}
                    style={{ opacity: wlDrag===i?0.35:1, transition:"opacity .12s" }}>
                    <WatchCard ticker={t} onOpen={setDetail} onRemove={removeTicker} aiEnabled={aiEnabled}/>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {tab==="portfolio" && <PortfolioPage positions={positions} data={portfolio} err={pfErr} loading={pfLoading} margin={margin} marginRate={marginRate} onMargin={onMargin} onAdd={addPosition} onUpdate={updatePosition} onRemove={removePosition} onReorder={reorderPosition} onRefresh={()=>valuePortfolio(positions, margin, marginRate)} onOpen={setDetail}/>}
        {tab==="brief" && <BriefingRoom/>}
        {tab==="map" && <SectorMap/>}
      </div>
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
