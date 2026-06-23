import { useState, useEffect, useCallback, useRef } from "react";
import { Search, Plus, X, Flame, Snowflake, ChevronLeft, RefreshCw, ArrowUpRight, ArrowDownRight, Minus, Star, TrendingUp, Newspaper, Loader2, AlertCircle } from "lucide-react";

/* ════════════════════════════════════════════════════════════════════
   AlphaDesk — LIVE app  (run locally against research.py backend)
   - Watchlist is home, persists to localStorage
   - Search researches ANY ticker via backend
   - The Briefing Room refreshes EVERY time the app opens/focuses
   - 8 AM alert handled separately by cron (scanner.py → Slack/SMS)

   SET THIS to wherever research.py is served:
   ════════════════════════════════════════════════════════════════════ */
const API = "http://localhost:8000";   // uvicorn research:app --port 8000

const C = {
  bg:"#0a0e17", panel:"#111722", panel2:"#0d131e", line:"#1e2738",
  ink:"#e8edf6", sub:"#7d8aa3", faint:"#4a5568",
  hot:"#ff6b35", cold:"#3b9eff", up:"#26d07c", down:"#ff4d6a",
  amber:"#f5a623", violet:"#9b7bff", mono:"'JetBrains Mono','SF Mono',Menlo,monospace",
};

const DEFAULT_WATCHLIST = ["NVDA","MSFT","PLTR","GOOGL","AMD"];
const WL_KEY = "alphadesk:watchlist";

// ── PERSISTENCE (localStorage works in a real local app) ──────────────
const loadWL = () => {
  try { return JSON.parse(localStorage.getItem(WL_KEY)) || DEFAULT_WATCHLIST; }
  catch { return DEFAULT_WATCHLIST; }
};
const saveWL = (l) => { try { localStorage.setItem(WL_KEY, JSON.stringify(l)); } catch {} };

// ── BACKEND CALLS ─────────────────────────────────────────────────────
async function fetchResearch(ticker) {
  const r = await fetch(`${API}/research?ticker=${encodeURIComponent(ticker)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchBriefing() {
  const r = await fetch(`${API}/briefing`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── HELPERS ───────────────────────────────────────────────────────────
const Trend = ({ v }) => v>0 ? <ArrowUpRight size={13}/> : v<0 ? <ArrowDownRight size={13}/> : <Minus size={13}/>;
const scoreColor = (s) => s>=7 ? C.up : s>=4 ? C.amber : C.down;
const scoreLabel = (s) => s>=7.5?"Bullish":s>=6?"Lean Bull":s>=4?"Neutral":s>=2.5?"Lean Bear":"Bearish";

function ScoreDial({ score, size=44 }) {
  const col = scoreColor(score), pct = score/10, r = size/2-3;
  return (
    <div style={{ position:"relative", width:size, height:size, flexShrink:0 }}>
      <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.line} strokeWidth={3}/>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={3}
          strokeDasharray={`${pct*2*Math.PI*r} ${2*Math.PI*r}`} strokeLinecap="round"/>
      </svg>
      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center", fontFamily:C.mono, fontSize:size>40?13:11, fontWeight:700, color:col }}>{score?.toFixed(1)}</div>
    </div>
  );
}

// ── WATCHLIST CARD (fetches its own data) ─────────────────────────────
function WatchCard({ ticker, onOpen, onRemove }) {
  const [d, setD]       = useState(null);
  const [err, setErr]   = useState(false);
  useEffect(()=>{
    let alive = true;
    fetchResearch(ticker).then(x=>{ if(alive){ x.error?setErr(true):setD(x); }}).catch(()=>alive&&setErr(true));
    return ()=>{ alive=false; };
  },[ticker]);

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
            <div style={{ fontSize:11, color:scoreColor(d.score), fontWeight:600 }}>{scoreLabel(d.score)}</div>
          </div>
          <ScoreDial score={d.score}/>
        </div>
      </div>
      <div style={{ display:"flex", gap:7, marginTop:11 }}>
        <span style={{ fontFamily:C.mono, fontSize:10, color:C.sub, background:C.panel2, padding:"2px 7px", borderRadius:4 }}>RSI {d.rsi}</span>
        {d.iv && <span style={{ fontFamily:C.mono, fontSize:10, color:C.amber, background:`${C.amber}14`, padding:"2px 7px", borderRadius:4 }}>IV {d.iv}%</span>}
        {d.play && <span style={{ fontFamily:C.mono, fontSize:10, color:C.up, background:`${C.up}14`, padding:"2px 7px", borderRadius:4 }}>PLAY ✓</span>}
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
function DetailPage({ ticker, onBack, inWatchlist, onToggleWatch }) {
  const [d, setD]   = useState(null);
  const [err, setErr] = useState(null);
  useEffect(()=>{
    setD(null); setErr(null);
    fetchResearch(ticker).then(x=> x.error ? setErr(x.error) : setD(x)).catch(e=>setErr(e.message));
  },[ticker]);

  if (err) return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"20px 26px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.cold, cursor:"pointer", display:"flex", gap:5, alignItems:"center", marginBottom:18, fontSize:13 }}><ChevronLeft size={16}/> Watchlist</button>
      <div style={{ color:C.down, fontSize:13 }}>Couldn't load {ticker}: {err}</div>
    </div>
  );
  if (!d) return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"60px 26px", textAlign:"center", color:C.sub }}>
      <Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/> <div style={{ marginTop:10 }}>Researching {ticker}…</div>
    </div>
  );
  const newsAvg = d.news?.length ? (d.news.reduce((s,n)=>s+n.score,0)/d.news.length).toFixed(1) : "—";

  return (
    <div style={{ maxWidth:860, margin:"0 auto", padding:"20px 26px 60px" }}>
      <button onClick={onBack} style={{ background:"none", border:"none", color:C.cold, cursor:"pointer", display:"flex", gap:5, alignItems:"center", marginBottom:18, fontSize:13 }}><ChevronLeft size={16}/> Watchlist</button>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:22 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:11 }}>
            <span style={{ fontSize:28, fontWeight:800, color:C.ink, letterSpacing:"-0.02em" }}>{ticker}</span>
            {d.signal==="hot" && <Flame size={20} color={C.hot}/>}
            {d.signal==="cold" && <Snowflake size={20} color={C.cold}/>}
          </div>
          <div style={{ fontSize:13, color:C.sub, marginTop:3 }}>{d.name} · {d.sector} · {d.mktCap}</div>
        </div>
        <button onClick={()=>onToggleWatch(ticker)} style={{ background:inWatchlist?`${C.amber}18`:C.panel, border:`1px solid ${inWatchlist?C.amber:C.line}`, borderRadius:9, padding:"9px 14px", color:inWatchlist?C.amber:C.sub, cursor:"pointer", display:"flex", gap:7, alignItems:"center", fontSize:12.5, fontWeight:500 }}>
          <Star size={14} fill={inWatchlist?C.amber:"none"}/> {inWatchlist?"Watching":"Add to Watchlist"}
        </button>
      </div>
      <div style={{ display:"flex", gap:14, marginBottom:22 }}>
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1 }}>
          <div style={{ fontFamily:C.mono, fontSize:30, color:C.ink, fontWeight:600 }}>${d.spot}</div>
          <div style={{ fontFamily:C.mono, fontSize:14, color:d.chg>=0?C.up:C.down, display:"flex", alignItems:"center", gap:4, marginTop:2 }}><Trend v={d.chg}/>{d.chg>=0?"+":""}{d.chg}% today</div>
        </div>
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 20px", flex:1, display:"flex", alignItems:"center", gap:16 }}>
          <ScoreDial score={d.score} size={56}/>
          <div>
            <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>ALPHADESK SCORE</div>
            <div style={{ fontSize:17, color:scoreColor(d.score), fontWeight:700 }}>{scoreLabel(d.score)}</div>
            <div style={{ fontSize:10.5, color:C.faint, marginTop:2 }}>0 bearish · 10 bullish</div>
          </div>
        </div>
      </div>
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
        <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:9 }}>Analysis</div>
        <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65 }}>{d.summary}</div>
      </div>
      {d.fundamentals && (
        <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap" }}>
          {Object.entries({ "P/E":d.fundamentals.pe, "Rev Growth":d.fundamentals.revGrowth, "Gross Margin":d.fundamentals.grossMargin, "RSI":d.rsi, "IV":d.iv?`${d.iv}%`:"—" }).map(([k,v])=>(
            <div key={k} style={{ flex:"1 1 120px", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:9, padding:"10px 12px" }}>
              <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.05em" }}>{k.toUpperCase()}</div>
              <div style={{ fontFamily:C.mono, fontSize:13.5, color:C.ink, marginTop:3 }}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"16px 18px", marginBottom:14 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <Newspaper size={15} color={C.sub}/><span style={{ fontSize:13, fontWeight:600, color:C.ink }}>Top News</span>
            <span style={{ fontSize:11, color:C.faint }}>— 3 most important, scored</span>
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:7 }}>
            <span style={{ fontSize:10, color:C.faint }}>NEWS AVG</span>
            <span style={{ fontFamily:C.mono, fontSize:14, fontWeight:700, color:scoreColor(parseFloat(newsAvg)||0) }}>{newsAvg}</span>
          </div>
        </div>
        {d.news?.map((n,i)=><NewsItem key={i} n={n}/>)}
      </div>
      {d.play && (
        <div style={{ background:`${C.up}0c`, border:`1px solid ${C.up}33`, borderRadius:12, padding:"16px 18px" }}>
          <div style={{ fontSize:10.5, color:C.up, letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:9 }}>Suggested Play</div>
          <div style={{ fontFamily:C.mono, fontSize:15, color:C.ink, marginBottom:8 }}>${d.play.strike} {d.play.direction} · exp {d.play.expiry} · {d.play.dte}d · ~${d.play.premium}</div>
          <div style={{ display:"flex", gap:8 }}>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.up, background:`${C.up}18`, padding:"3px 9px", borderRadius:5 }}>{d.play.conviction} conviction</span>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.sub, background:C.panel2, padding:"3px 9px", borderRadius:5 }}>breakeven ${(d.play.strike+d.play.premium).toFixed(2)}</span>
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

  const load = useCallback(()=>{
    setErr(null);
    fetchBriefing().then(x=>{ setB(x); setUpdated(new Date()); }).catch(e=>setErr(e.message));
  },[]);

  // Refresh on mount + every time the tab/window regains focus
  useEffect(()=>{
    load();
    const onFocus = ()=>load();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", ()=>{ if(!document.hidden) load(); });
    return ()=>window.removeEventListener("focus", onFocus);
  },[load]);

  if (err) return <div style={{ padding:40, textAlign:"center", color:C.down }}>Briefing unavailable: {err}<br/><span style={{ color:C.faint, fontSize:12 }}>Is the backend running on {API}?</span></div>;
  if (!b)  return <div style={{ padding:60, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Loading The Briefing Room…</div></div>;

  const sc = b.climate?.macro_score ?? 50;
  const scoreCol = sc>60?C.up:sc>35?C.amber:C.down;
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:16 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>The Briefing Room</div>
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
    </div>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────
export default function AlphaDesk() {
  const [tab, setTab]             = useState("watchlist");
  const [watchlist, setWatchlist] = useState(loadWL);
  const [detail, setDetail]       = useState(null);
  const [query, setQuery]         = useState("");
  const [notice, setNotice]       = useState("");

  useEffect(()=>{ saveWL(watchlist); },[watchlist]);

  const addTicker    = (t)=>{ const T=t.toUpperCase().trim(); if(T) setWatchlist(w=>w.includes(T)?w:[...w,T]); };
  const removeTicker = (t)=> setWatchlist(w=>w.filter(x=>x!==t));
  const toggleWatch  = (t)=> setWatchlist(w=>w.includes(t)?w.filter(x=>x!==t):[...w,t]);
  const runSearch    = ()=>{ const T=query.toUpperCase().trim(); if(T) setDetail(T); };

  if (detail) return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.ink, fontFamily:"'Inter',system-ui,sans-serif" }}>
      <DetailPage ticker={detail} onBack={()=>setDetail(null)} inWatchlist={watchlist.includes(detail)} onToggleWatch={toggleWatch}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );

  return (
    <div style={{ minHeight:"100vh", background:C.bg, color:C.ink, fontFamily:"'Inter',system-ui,sans-serif" }}>
      <div style={{ borderBottom:`1px solid ${C.line}`, padding:"14px 26px", position:"sticky", top:0, background:C.bg, zIndex:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:20, maxWidth:1180, margin:"0 auto" }}>
          <div style={{ fontWeight:800, fontSize:17, letterSpacing:"-0.02em", flexShrink:0 }}>AlphaDesk <span style={{ color:C.hot }}>·</span></div>
          <div style={{ flex:1, maxWidth:420, position:"relative" }}>
            <Search size={15} color={C.faint} style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)" }}/>
            <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>e.key==="Enter"&&runSearch()}
              placeholder="Research any ticker — e.g. NVDA, TSLA, COIN"
              style={{ width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 12px 9px 36px", color:C.ink, fontSize:13, outline:"none", fontFamily:"inherit" }}
              onFocus={e=>e.target.style.borderColor=C.cold} onBlur={e=>e.target.style.borderColor=C.line}/>
            {query && <button onClick={()=>setQuery("")} style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", color:C.faint, cursor:"pointer" }}><X size={14}/></button>}
          </div>
          <div style={{ display:"flex", gap:2, background:C.panel, borderRadius:9, padding:3, border:`1px solid ${C.line}`, flexShrink:0 }}>
            {[["watchlist","Watchlist"],["brief","The Briefing Room"]].map(([id,label])=>(
              <button key={id} onClick={()=>setTab(id)} style={{ padding:"6px 14px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12.5, fontWeight:500, background:tab===id?C.line:"transparent", color:tab===id?C.ink:C.sub }}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth:1180, margin:"0 auto", padding:"22px 26px 60px" }}>
        {tab==="watchlist" && (
          <div>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div>
                <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>My Watchlist</div>
                <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>{watchlist.length} stocks · live data · tap for full analysis</div>
              </div>
              <AddInline onAdd={addTicker}/>
            </div>
            {watchlist.length===0 ? (
              <div style={{ textAlign:"center", padding:"50px 20px", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>Empty — search or add a ticker to start.</div>
            ) : (
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap:14 }}>
                {watchlist.map(t=><WatchCard key={t} ticker={t} onOpen={setDetail} onRemove={removeTicker}/>)}
              </div>
            )}
          </div>
        )}
        {tab==="brief" && <BriefingRoom/>}
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
