import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, Plus, X, Flame, Snowflake, ChevronLeft, RefreshCw, ArrowUpRight, ArrowDownRight, Minus, Star, Newspaper, Loader2, AlertCircle, Bell, Activity, Archive, ChevronDown, Trash2, Settings, Sun, Moon, Pencil, LineChart, GripVertical, ArrowUp, ArrowDown, LogOut, Calendar, Target, Zap, FolderPlus, Check, MessageCircle, Send } from "lucide-react";
import { DndContext, DragOverlay, PointerSensor, TouchSensor, useSensor, useSensors, useDroppable, closestCorners } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { authEnabled, supabase, authHeaders } from "./lib/supabase";
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

// First-time default watchlist: the Magnificent 7, the S&P 500 (SPY), and the
// Mag 7 composite ETF (MAGS). New users start here before customizing.
const DEFAULT_WATCHLIST = ["AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","SPY","MAGS"];
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

// ── ACCOUNT BUCKETS (drag-and-drop portfolio organization) ────────────
// Each account = { id, name, color }. A position's `account` field (the
// account id) records its assignment and rides along with the position in
// every persistence layer. Accounts + collapsed state persist on their own.
const ACCT_KEY = "alphadesk:accounts";
const ACCT_COLLAPSE_KEY = "alphadesk:accountsCollapsed";
const ACCOUNT_COLORS = ["#1c7ed6","#0ca678","#e8590c","#6741d9","#e03131","#e08a00","#0c8599","#ae3ec9","#2f9e44","#f03e3e"];
const loadAccounts = () => { try { return JSON.parse(localStorage.getItem(ACCT_KEY)) || []; } catch { return []; } };
const saveAccounts = (l) => { try { localStorage.setItem(ACCT_KEY, JSON.stringify(l)); } catch {} };
const loadAccountCollapsed = () => { try { return JSON.parse(localStorage.getItem(ACCT_COLLAPSE_KEY)) || {}; } catch { return {}; } };
const saveAccountCollapsed = (m) => { try { localStorage.setItem(ACCT_COLLAPSE_KEY, JSON.stringify(m)); } catch {} };
// Saved screener filter combos (synced to Supabase alongside the rest of state)
const SCREENS_KEY = "alphadesk:savedScreens";
const loadSavedScreens = () => { try { return JSON.parse(localStorage.getItem(SCREENS_KEY)) || []; } catch { return []; } };
const saveSavedScreens = (l) => { try { localStorage.setItem(SCREENS_KEY, JSON.stringify(l)); } catch {} };
const UNASSIGNED = "__unassigned__";

// ── CRYPTO SUPPORT ────────────────────────────────────────────────────
// yfinance quotes crypto as "<SYMBOL>-USD". We let users type a bare symbol
// (BTC, ETH, …) and resolve common ones to the pair automatically.
const CRYPTO_SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","ADA","AVAX","LINK","DOT","MATIC",
  "LTC","BCH","SHIB","TRX","UNI","ATOM","XLM","ETC","FIL","APT","ARB","OP","NEAR","INJ","SUI",
  "PEPE","TON","ICP","HBAR","VET","AAVE","MKR","RNDR","IMX","GRT","ALGO","FTM","SAND","MANA","AXS",
  "CRO","QNT","STX","TIA","RUNE","FLOW","EGLD","XTZ","CHZ","ENJ","BTT","USDT","USDC","BNB","TRUMP"]);
const isCrypto = (t="") => /-USD$/i.test(t);

// ── PRECIOUS METALS ───────────────────────────────────────────────────
// Metal ETFs trade like stocks; futures ("<SYM>=F") approximate spot price.
const METAL_ETFS = new Set(["GLD","IAU","SGOL","GLDM","BAR","OUNZ","AAAU","SLV","SIVR",
  "PSLV","PPLT","PALL","GLTR","DBP","GDX","GDXJ","SIL","SILJ","RING","NUGT"]);
const METAL_FUTURES = { "GC=F":"GOLD","MGC=F":"GOLD","SI=F":"SILVER","SIL=F":"SILVER",
  "PL=F":"PLATINUM","PA=F":"PALLADIUM","HG=F":"COPPER" };
// Friendly spot aliases → the yfinance futures symbol (avoids hijacking real
// stock tickers like Barrick's "GOLD", so only explicit *SPOT/XAU forms resolve).
const METAL_ALIASES = { GOLDSPOT:"GC=F", XAU:"GC=F", XAUUSD:"GC=F", SILVERSPOT:"SI=F",
  XAG:"SI=F", XAGUSD:"SI=F", PLATINUMSPOT:"PL=F", PALLADIUMSPOT:"PA=F", COPPERSPOT:"HG=F" };
const isMetal = (t="") => { const T=(t||"").toUpperCase(); return METAL_ETFS.has(T) || (T in METAL_FUTURES); };

// Normalize user input to a yfinance symbol: bare known-crypto → "<SYM>-USD";
// metal spot aliases → futures symbol; crypto pairs / futures pass through.
const normalizeTicker = (input="") => {
  const T = (input||"").toUpperCase().trim();
  if (!T) return "";
  if (METAL_ALIASES[T]) return METAL_ALIASES[T];   // GOLDSPOT -> GC=F
  if (T.includes("-") || T.includes("=")) return T;// crypto pair / futures contract
  return CRYPTO_SYMBOLS.has(T) ? `${T}-USD` : T;
};
// Display form: "BTC-USD"→"BTC", "GC=F"→"GOLD"; otherwise the ticker as-is.
const displaySym = (t="") => {
  if (isCrypto(t)) return t.replace(/-USD$/i, "");
  return METAL_FUTURES[(t||"").toUpperCase()] || t;
};

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
  // AI mode needs the login token (backend gates AI on a verified session).
  const r = await fetch(`${API}/research?ticker=${encodeURIComponent(ticker)}&ai=${ai ? 1 : 0}&profile=${encodeURIComponent(profile||"")}`,
    ai ? { headers: authHeaders() } : undefined);
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
  const r = await fetch(`${API}/sector?name=${encodeURIComponent(name)}`, { headers: authHeaders() });
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
async function fetchFundamentals(ticker) {
  const r = await fetch(`${API}/fundamentals?ticker=${encodeURIComponent(ticker)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchBusinessQuality(ticker, profile = "") {
  const r = await fetch(`${API}/business-quality?ticker=${encodeURIComponent(ticker)}&profile=${encodeURIComponent(profile||"")}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchFinancialsDetail(ticker) {
  const r = await fetch(`${API}/financials-detail?ticker=${encodeURIComponent(ticker)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchFilings(ticker) {
  const r = await fetch(`${API}/filings?ticker=${encodeURIComponent(ticker)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchEarningsPrep(ticker, profile = "") {
  const r = await fetch(`${API}/earnings-prep?ticker=${encodeURIComponent(ticker)}&profile=${encodeURIComponent(profile||"")}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchScreen(params) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k,v])=>{ if (v!==null && v!==undefined && v!=="") qs.set(k, v); });
  const r = await fetch(`${API}/screen?${qs.toString()}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchChat(body) {
  const r = await fetch(`${API}/chat`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchBriefRefresh(body) {
  // Agent loop server-side — expect 1-4 minutes.
  const r = await fetch(`${API}/brief/refresh`, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchValue(positions, margin = 0, margin_rate = 0, profile = "") {
  const r = await fetch(`${API}/value`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positions, margin, margin_rate, profile }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// Settings (margin) persistence: Supabase for signed-in users, localStorage
// otherwise. Server-side /settings store removed — these are no-ops now.
async function fetchSettings() { return { settings: {} }; }
async function saveSettingsServer() { /* localStorage only */ }
async function fetchIndicator(symbol, label) {
  const r = await fetch(`${API}/indicator?symbol=${encodeURIComponent(symbol)}&label=${encodeURIComponent(label||"")}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
// The server-side /positions & /settings store was removed (it was an
// unauthenticated shared file). Persistence is Supabase (signed-in, per-user +
// RLS) or localStorage (local/anonymous). These are now localStorage-only no-ops
// so the anonymous path never sends holdings to the server.
async function fetchPositions() { return { positions: [] }; }
async function savePositionsServer() { /* localStorage only — see saveWL/savePositions */ }
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
  const r = await fetch(`${API}/outlook`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function fetchPortfolioAnalysis(positions, analytics, cash, profile) {
  const r = await fetch(`${API}/portfolio-analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
// Market Brief artifacts (agent output + tool log) — RLS user-keyed table
async function sbLoadBrief(uid) {
  if (!supabase || !uid) return null;
  const { data, error } = await supabase
    .from("market_brief").select("brief,tool_log,generated_at,source,model,turns")
    .eq("user_id", uid).order("generated_at", { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error("[sb] brief load error:", error.message); return null; }
  return data;
}
async function sbSaveBrief(uid, out) {
  if (!supabase || !uid) return;
  const { error } = await supabase.from("market_brief").insert({
    user_id: uid, source: "manual", brief: out.brief, tool_log: out.tool_log,
    model: out.model, turns: out.turns,
  });
  if (error) console.error("[sb] brief save error:", error.message);
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
// RSI zone color — consistent with the app: oversold = green (potential buy),
// overbought = red, neutral = amber.
const rsiColor = (v) => v==null ? C.faint : v < 30 ? C.up : v > 70 ? C.down : C.amber;
const rsiLabel = (v) => v==null ? "" : v < 30 ? "oversold" : v > 70 ? "overbought" : "neutral";
// Tactical setup (mean reversion × trend) tone → color.
const tacticalCol = (t) => t?.tone==="bullish"?C.up : t?.tone==="bearish"?C.down : t?.tone==="caution"?C.amber : C.faint;

// ── TICKER AUTOCOMPLETE ───────────────────────────────────────────────
// Instant suggestions from a built-in directory (zero server load), enriched by
// the backend's Yahoo symbol search after a short debounce.
const TICKER_DIR = [
  ["AAPL","Apple"],["MSFT","Microsoft"],["NVDA","NVIDIA"],["GOOGL","Alphabet"],["AMZN","Amazon"],
  ["META","Meta Platforms"],["TSLA","Tesla"],["AVGO","Broadcom"],["BRK-B","Berkshire Hathaway"],
  ["LLY","Eli Lilly"],["JPM","JPMorgan Chase"],["V","Visa"],["WMT","Walmart"],["XOM","Exxon Mobil"],
  ["UNH","UnitedHealth"],["MA","Mastercard"],["ORCL","Oracle"],["COST","Costco"],["HD","Home Depot"],
  ["PG","Procter & Gamble"],["NFLX","Netflix"],["JNJ","Johnson & Johnson"],["ABBV","AbbVie"],
  ["BAC","Bank of America"],["CRM","Salesforce"],["KO","Coca-Cola"],["MRK","Merck"],["CVX","Chevron"],
  ["AMD","Advanced Micro Devices"],["PEP","PepsiCo"],["ADBE","Adobe"],["TMO","Thermo Fisher"],
  ["MU","Micron Technology"],["PLTR","Palantir"],["SOFI","SoFi Technologies"],["INTC","Intel"],
  ["QCOM","Qualcomm"],["TXN","Texas Instruments"],["IBM","IBM"],["NOW","ServiceNow"],["GE","GE Aerospace"],
  ["CAT","Caterpillar"],["DIS","Disney"],["BA","Boeing"],["GS","Goldman Sachs"],["MS","Morgan Stanley"],
  ["UBER","Uber"],["SBUX","Starbucks"],["NKE","Nike"],["PFE","Pfizer"],["T","AT&T"],["VZ","Verizon"],
  ["SNDK","SanDisk"],["WDC","Western Digital"],["ALAB","Astera Labs"],["VRT","Vertiv"],["APP","AppLovin"],
  ["ANET","Arista Networks"],["PANW","Palo Alto Networks"],["CRWD","CrowdStrike"],["SMCI","Super Micro"],
  ["ASML","ASML"],["TSM","Taiwan Semiconductor"],["BABA","Alibaba"],["SHOP","Shopify"],["PYPL","PayPal"],
  ["COIN","Coinbase"],["HOOD","Robinhood"],["MRNA","Moderna"],["LULU","Lululemon"],["ENPH","Enphase"],
  ["IREN","IREN"],["CELH","Celsius"],["LMT","Lockheed Martin"],["NEE","NextEra Energy"],["LIN","Linde"],
  ["SPY","S&P 500 ETF"],["QQQ","Nasdaq-100 ETF"],["MAGS","Mag 7 ETF (Roundhill)"],["IWM","Russell 2000 ETF"],
  ["XLK","Technology Sector ETF"],["XLF","Financials ETF"],["XLE","Energy ETF"],["XLV","Health Care ETF"],
  ["XLI","Industrials ETF"],["XLY","Consumer Discretionary ETF"],["XLP","Consumer Staples ETF"],
  ["XLC","Communication Services ETF"],["XLU","Utilities ETF"],["XLB","Materials ETF"],["XLRE","Real Estate ETF"],
  ["GLD","Gold ETF"],["SLV","Silver ETF"],["BTC-USD","Bitcoin"],["ETH-USD","Ethereum"],["SOL-USD","Solana"],
];

function TickerInput({ onPick, placeholder, extra=[], style, inputStyle, autoFocus=false }) {
  const [q, setQ]       = useState("");
  const [sugs, setSugs] = useState([]);
  const [open, setOpen] = useState(false);
  const deb = useRef(null);
  const update = (val) => {
    setQ(val);
    const s = val.trim().toUpperCase();
    if (!s) { setSugs([]); setOpen(false); return; }
    // Instant local matches: caller's extras (watchlist etc.) first, then ticker
    // prefix matches, then company-name substring matches.
    const seen = new Set(); const out = [];
    const push = (t, n) => { if (!seen.has(t) && out.length < 8) { seen.add(t); out.push({ t, n }); } };
    extra.forEach(t => { if (String(t).toUpperCase().startsWith(s)) push(String(t).toUpperCase(), "on your watchlist"); });
    TICKER_DIR.forEach(([t, n]) => { if (t.startsWith(s)) push(t, n); });
    TICKER_DIR.forEach(([t, n]) => { if (n.toUpperCase().includes(s)) push(t, n); });
    setSugs(out); setOpen(true);
    clearTimeout(deb.current);
    deb.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API}/symbol-search?q=${encodeURIComponent(s)}`);
        const d = await r.json();
        if ((d.results || []).length) {
          setSugs(prev => {
            const have = new Set(prev.map(x => x.t)); const merged = [...prev];
            d.results.forEach(x => { if (!have.has(x.t) && merged.length < 8) merged.push({ t: x.t, n: x.n }); });
            return merged;
          });
        }
      } catch {}
    }, 280);
  };
  const pick = (t) => { setQ(""); setSugs([]); setOpen(false); if (t) onPick(t); };
  const onKey = (e) => {
    if (e.key === "Enter") {
      const s = q.trim().toUpperCase();
      // exact directory/suggestion match or a plain typed symbol wins; else first suggestion
      const exact = sugs.find(x => x.t === s);
      pick(exact ? exact.t : (sugs[0] && s.length < 2 ? sugs[0].t : (s || sugs[0]?.t)));
    }
    if (e.key === "Escape") { setOpen(false); }
  };
  return (
    <div style={{ position:"relative", ...style }}>
      <Search size={15} color={C.faint} style={{ position:"absolute", left:12, top:"50%", transform:"translateY(-50%)", pointerEvents:"none" }}/>
      <input value={q} autoFocus={autoFocus} onChange={e=>update(e.target.value)} onKeyDown={onKey}
        onFocus={()=>q && setOpen(true)} onBlur={()=>setTimeout(()=>setOpen(false), 160)}
        placeholder={placeholder}
        style={{ width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 12px 8px 36px", color:C.ink, fontSize:13, outline:"none", fontFamily:"inherit", ...inputStyle }}/>
      {open && sugs.length > 0 && (
        <div style={{ position:"absolute", top:"calc(100% + 4px)", left:0, right:0, zIndex:120, background:C.panel, border:`1px solid ${C.line}`, borderRadius:10, boxShadow:"0 12px 34px rgba(0,0,0,0.28)", overflow:"hidden" }}>
          {sugs.map((x,i)=>(
            <div key={x.t} onMouseDown={(e)=>{ e.preventDefault(); pick(x.t); }}
              style={{ display:"flex", alignItems:"center", gap:9, padding:"8px 12px", cursor:"pointer", borderTop: i?`1px solid ${C.panel2}`:"none" }}
              onMouseEnter={e=>e.currentTarget.style.background=C.panel2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
              <span style={{ fontFamily:C.mono, fontWeight:800, fontSize:12.5, color:C.ink, minWidth:64 }}>{x.t}</span>
              <span style={{ fontSize:11.5, color:C.sub, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{x.n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// RSI(14) from a close series — Wilder's smoothing, matching the backend and
// the standard shown on TradingView/brokers. Seeds with a simple average of
// the first `period` moves, then smooths recursively. Returns an array aligned
// with `closes` (nulls where there's not enough lookback).
function calcRSI(closes, period=14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return [];
  const out = new Array(closes.length).fill(null);
  let avgUp = 0, avgDn = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgUp += d; else avgDn -= d;
  }
  avgUp /= period; avgDn /= period;
  out[period] = avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgUp = (avgUp * (period - 1) + (d > 0 ?  d : 0)) / period;
    avgDn = (avgDn * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn);
  }
  return out;
}
// RSI series windowed to a display range: drop the null lookback head, keep
// dates aligned, then take the last `take` points (null take = everything).
function rsiWindow(closes, dates, take) {
  const full = calcRSI(closes || []);
  const start = Math.max(full.findIndex(v => v != null), 0);
  let vals = full.slice(start), dts = (dates || []).slice(start);
  if (take != null) { vals = vals.slice(-take); dts = dts.slice(-take); }
  return { vals, dts };
}

// Simple moving average aligned to `closes` (null until enough lookback).
function calcSMA(closes, n) {
  if (!Array.isArray(closes) || closes.length < n) return new Array((closes||[]).length).fill(null);
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i-n];
    if (i >= n-1) out[i] = sum / n;
  }
  return out;
}
// Moving-average overlay definitions: 20/50/200-day SMAs, theme colors.
const MA_DEFS = [
  { n:20,  color:"#f59e0b", label:"MA20"  },
  { n:50,  color:"#3b82f6", label:"MA50"  },
  { n:200, color:"#a855f7", label:"MA200" },
];
const MA_HELP = "Moving averages smooth price to show trend. Price above a rising MA = uptrend; the 50-day above the 200-day is a bullish 'golden cross', below is a bearish 'death cross'. Longer MAs (200d) mark the big-picture trend; shorter (20d) the near-term.";

// Plain-English explainer used as the RSI tooltip everywhere.
const RSI_HELP = "RSI = momentum on a 0-100 scale, from the last 14 bars shown. Under 30 = oversold (sellers may be exhausted — potentially cheap). Over 70 = overbought (rally may be stretched). Between = neutral.";

// Compact RSI graph on a fixed 0–100 scale with 30/70 guide lines (labeled at
// the right edge) and hover-to-inspect (exact RSI value + date). Falls back to
// nothing if there's no series (caller shows a colored number then).
function RsiMini({ data, dates, w=120, h=26 }) {
  const [hi, setHi] = useState(null);
  if (!Array.isArray(data) || data.length < 2) return null;
  const last = data[data.length-1];
  const col  = rsiColor(last);
  const x = (i) => (i/(data.length-1)) * w;
  const y = (v) => h - (Math.max(0,Math.min(100,v))/100) * h;
  const line = data.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel  = (e.clientX - rect.left) / rect.width;
    setHi(Math.max(0, Math.min(data.length-1, Math.round(rel*(data.length-1)))));
  };
  const edgeLbl = (topPct, txt, c) => (
    <span style={{ position:"absolute", right:2, top:`calc(${topPct}% - 7px)`, fontSize:8, fontFamily:C.mono, color:c, opacity:0.75, pointerEvents:"none", lineHeight:1 }}>{txt}</span>
  );
  return (
    <div style={{ position:"relative" }} onMouseMove={onMove} onMouseLeave={()=>setHi(null)} title={RSI_HELP}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display:"block", width:"100%" }}>
        {/* overbought (>70) and oversold (<30) tint zones + guide lines */}
        <rect x={0} y={0} width={w} height={y(70)} fill={C.down} opacity={0.05}/>
        <rect x={0} y={y(30)} width={w} height={h-y(30)} fill={C.up} opacity={0.05}/>
        <line x1={0} y1={y(70)} x2={w} y2={y(70)} stroke={C.down} strokeWidth={0.6} strokeDasharray="3 3" opacity={0.5}/>
        <line x1={0} y1={y(50)} x2={w} y2={y(50)} stroke={C.faint} strokeWidth={0.5} strokeDasharray="2 4" opacity={0.4}/>
        <line x1={0} y1={y(30)} x2={w} y2={y(30)} stroke={C.up}   strokeWidth={0.6} strokeDasharray="3 3" opacity={0.5}/>
        <polyline points={line} fill="none" stroke={col} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"/>
        {hi!=null && <line x1={x(hi)} y1={0} x2={x(hi)} y2={h} stroke={C.faint} strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke"/>}
        {hi!=null && <circle cx={x(hi)} cy={y(data[hi])} r={3} fill={rsiColor(data[hi])} stroke={C.bg} strokeWidth={1.5} vectorEffect="non-scaling-stroke"/>}
      </svg>
      {h >= 34 && edgeLbl(30, "70", C.down)}
      {h >= 34 && edgeLbl(70, "30", C.up)}
      {hi!=null && (
        <div style={{ position:"absolute", top:-6, left:`${(hi/(data.length-1))*100}%`, transform:`translateX(${hi > data.length*0.7 ? "-105%" : hi < data.length*0.3 ? "5%" : "-50%"})`, pointerEvents:"none", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:6, padding:"3px 7px", fontSize:10, fontFamily:C.mono, whiteSpace:"nowrap", color:C.ink, boxShadow:"0 5px 14px rgba(0,0,0,0.25)", zIndex:5 }}>
          <span style={{ fontWeight:700, color:rsiColor(data[hi]) }}>RSI {Number(data[hi]).toFixed(1)}</span>
          {dates?.[hi] && <span style={{ color:C.faint, marginLeft:6 }}>{dates[hi]}</span>}
        </div>
      )}
    </div>
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
// Sparkline pills for WatchCard use daily slices (no extra fetch needed) except
// 1D, which needs a live intraday fetch (5-min bars via /chart) since the daily
// research history has no sub-day resolution.
const SPARK_RANGES = [
  { key:"1d", days:null }, { key:"1w", days:5 }, { key:"1m", days:21 }, { key:"3m", days:63 }, { key:"6m", days:126 }, { key:"1y", days:252 },
];

function ChartWithRanges({ ticker, history, history_dates, color, defaultRange="3m", ma }) {
  const [range, setRange] = useState(defaultRange);
  const [extras, setExtras] = useState({});
  const [fetching, setFetching] = useState(false);
  const [maOn, setMaOn] = useState({ 20:true, 50:true, 200:false });   // which MA overlays are shown

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

  // Moving-average overlays. Only meaningful on daily-bar ranges; for the sliced
  // ranges we compute the SMA over the FULL year of history then tail-slice so
  // the line is continuous (not restarted inside the window). YTD (daily fetch)
  // computes on its own series. Weekly/intraday ranges (2Y/5Y/1D/1W) are skipped.
  const dailyBars = rConf?.days != null || range === "ytd";
  const overlays = dailyBars ? MA_DEFS.filter(m => maOn[m.n]).map(m => {
    const vals = rConf?.days != null
      ? calcSMA(history || [], m.n).slice(-rConf.days)
      : calcSMA(chartData, m.n);
    return { label:m.label, color:m.color, values:vals };
  }).filter(o => o.values.some(v => v!=null)) : [];

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
        {!fetching && <span style={{ fontSize:10.5, color:C.faint }}>hover to inspect · tap two dates to measure gain/loss</span>}
        {fetching && <span style={{ fontSize:10.5, color:C.faint, display:"flex", alignItems:"center", gap:4 }}><Loader2 size={11} style={{ animation:"spin 1s linear infinite" }}/> Loading…</span>}
      </div>
      {/* Moving-average overlay toggles + trend read */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, flexWrap:"wrap" }} title={MA_HELP}>
        <span style={{ fontSize:10, color:C.faint, letterSpacing:"0.05em" }}>MA</span>
        {MA_DEFS.map(m => {
          const on = dailyBars && maOn[m.n];
          return (
            <button key={m.n} onClick={()=> dailyBars && setMaOn(s=>({ ...s, [m.n]: !s[m.n] }))}
              disabled={!dailyBars}
              style={{ display:"flex", alignItems:"center", gap:5, background:on?`${m.color}1c`:C.panel, border:`1px solid ${on?m.color:C.line}`,
                borderRadius:20, padding:"3px 10px", cursor:dailyBars?"pointer":"not-allowed", opacity:dailyBars?1:0.4, fontSize:11, fontWeight:600, color:on?m.color:C.sub }}>
              <span style={{ width:9, height:2.5, borderRadius:2, background:m.color, display:"inline-block" }}/>{m.label}
            </button>
          );
        })}
        {!dailyBars && <span style={{ fontSize:9.5, color:C.faint }}>daily-bar ranges only (1M–1Y, YTD)</span>}
        {ma?.trend && ma.trend!=="n/a" && (
          <span style={{ marginLeft:"auto", fontSize:11, fontFamily:C.mono, fontWeight:700,
            color: ma.trend==="uptrend"?C.up : ma.trend==="downtrend"?C.down : C.amber }}>
            {ma.trend==="uptrend"?"▲ uptrend" : ma.trend==="downtrend"?"▼ downtrend" : "→ mixed"}
            {ma.cross==="golden" && <span style={{ color:C.up, marginLeft:6 }}>· golden cross</span>}
            {ma.cross==="death"  && <span style={{ color:C.down, marginLeft:6 }}>· death cross</span>}
          </span>
        )}
      </div>
      <InteractiveChart data={chartData} dates={chartDates} color={color} overlays={overlays}/>
      {/* RSI(14) computed over the SAME series the chart shows, so it follows
          the timeframe: daily RSI for 1M-1Y, bar-level RSI for intraday/weekly. */}
      {(() => {
        const src   = rConf?.days != null ? (history || []) : (extras[range]?.history || null);
        const sdate = rConf?.days != null ? (history_dates || []) : (extras[range]?.history_dates || []);
        if (!src || src.length < 20) return null;
        const { vals, dts } = rsiWindow(src, sdate, rConf?.days ?? null);
        if (vals.length < 2) return null;
        const cur = vals[vals.length - 1];
        return (
          <div style={{ marginTop:12 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
              <span title={RSI_HELP} style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase", cursor:"help" }}>RSI — momentum, 0–100 ⓘ</span>
              <span style={{ fontFamily:C.mono, fontSize:12.5, fontWeight:800, color:rsiColor(cur) }}>
                {cur.toFixed(1)} <span style={{ fontSize:9, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.03em" }}>{rsiLabel(cur)}</span>
              </span>
            </div>
            <RsiMini data={vals} dates={dts} h={44}/>
          </div>
        );
      })()}
    </div>
  );
}

const stageEmoji = (s) => ({"Breakout":"🚀","Trending":"📈","Coiling":"🔄","Oversold Bounce":"⚡","Resistance Test":"🧱","Running Out of Steam":"😮‍💨","Deteriorating":"⚠️","Collapsing":"🔻"}[s]||"");
const stageColor = (s) => ["Breakout","Trending","Oversold Bounce"].includes(s)?C.up:["Deteriorating","Collapsing"].includes(s)?C.down:["Resistance Test","Running Out of Steam"].includes(s)?C.amber:C.cold;
const convictionColor = (c) => c==="Strong Setup"?C.up:c==="Risky Setup"?C.down:C.amber;
const convictionToRec = (c) => c==="Strong Setup"?"BUY":c==="Risky Setup"?"SELL":"HOLD";
const recColor = (r) => r==="BUY"?C.up : r==="SELL"?C.down : C.amber;

// Hover-to-inspect + click-to-measure price chart. Hover shows crosshair, dot
// and price/date label; clicking one point then another measures the exact
// gain/loss between those two dates (live-previews to the cursor after the
// first click, locks on the second, third click clears). measure=false gives
// hover-only (used on the compact watchlist cards).
function InteractiveChart({ data, dates, color, h=130, measure: measureEnabled=true, overlays=[] }) {
  const [hi, setHi] = useState(null);
  const [sel, setSel] = useState({ a:null, b:null });
  const dataKey = `${dates?.[0] ?? ""}|${data?.length ?? 0}`;
  useEffect(()=>{ setSel({ a:null, b:null }); },[dataKey]);   // range switch → clear measurement
  if (!Array.isArray(data) || data.length < 2) return null;
  const W = 1000, PAD = 6;
  // Include overlay (MA) values in the vertical scale so lines never clip.
  const ov = (overlays||[]).flatMap(o => (o.values||[]).filter(v => v!=null && isFinite(v)));
  const min = Math.min(...data, ...ov), max = Math.max(...data, ...ov), range = (max - min) || 1;
  const x = (i) => (i/(data.length-1)) * W;
  const y = (v) => h - PAD - ((v - min)/range) * (h - 2*PAD);
  const line = data.map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  // MA overlay paths — break the line wherever the series is null (lookback gap).
  const overlayPath = (vals) => {
    let d = "", pen = false;
    vals.forEach((v,i)=>{ if (v==null || !isFinite(v)) { pen=false; return; }
      d += `${pen?"L":"M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen=true; });
    return d.trim();
  };
  const col  = color || (data[data.length-1] >= data[0] ? C.up : C.down);
  const idxFromEvent = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel  = (e.clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(data.length-1, Math.round(rel*(data.length-1))));
  };
  const onMove  = (e) => setHi(idxFromEvent(e));
  const onClick = (e) => {
    if (!measureEnabled) return;
    const i = idxFromEvent(e);
    setSel(s => s.a==null ? { a:i, b:null }                                  // 1st click: start
             : s.b==null ? (i===s.a ? s : { a:s.a, b:i })                    // 2nd click: lock
             : { a:null, b:null });                                          // 3rd click: clear
  };
  const pctFromStart = hi!=null ? ((data[hi]/data[0]-1)*100) : 0;

  // Measurement: fixed second point, or live-follow the cursor while picking it
  const mB = sel.b ?? (sel.a!=null ? hi : null);
  const measure = (sel.a!=null && mB!=null && mB!==sel.a) ? (() => {
    const [i1, i2] = sel.a < mB ? [sel.a, mB] : [mB, sel.a];
    const p1 = data[i1], p2 = data[i2];
    const chg = p2 - p1, pct = p1 ? (p2/p1 - 1)*100 : 0;
    let daysTxt = "";
    if (dates?.[i1] && dates?.[i2]) {
      const d1 = new Date(dates[i1]), d2 = new Date(dates[i2]);
      const nd = Math.round((d2 - d1)/86400000);
      if (!isNaN(nd) && nd > 0) daysTxt = `${nd}d`;
    }
    return { i1, i2, p1, p2, chg, pct, daysTxt };
  })() : null;
  const mCol = measure ? (measure.chg>=0?C.up:C.down) : col;

  return (
    <div>
      <div style={{ position:"relative", cursor:"crosshair" }} onMouseMove={onMove} onMouseLeave={()=>setHi(null)} onClick={measureEnabled ? onClick : undefined}>
        <svg width="100%" height={h} viewBox={`0 0 ${W} ${h}`} preserveAspectRatio="none" style={{ display:"block", overflow:"visible" }}>
          <polygon points={`${line} ${W},${h} 0,${h}`} fill={col} opacity={0.09}/>
          <polyline points={line} fill="none" stroke={col} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"/>
          {(overlays||[]).map(o => (
            <path key={o.label} d={overlayPath(o.values||[])} fill="none" stroke={o.color} strokeWidth={1.4} strokeOpacity={0.9} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round"/>
          ))}
          {measure && <rect x={x(measure.i1)} y={0} width={Math.max(0, x(measure.i2)-x(measure.i1))} height={h} fill={mCol} opacity={0.07}/>}
          {measure && <line x1={x(measure.i1)} y1={y(measure.p1)} x2={x(measure.i2)} y2={y(measure.p2)} stroke={mCol} strokeWidth={1.5} strokeDasharray="6 4" vectorEffect="non-scaling-stroke"/>}
          {hi!=null && <line x1={x(hi)} y1={0} x2={x(hi)} y2={h} stroke={C.faint} strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke"/>}
          {hi!=null && <circle cx={x(hi)} cy={y(data[hi])} r={4} fill={col} stroke={C.bg} strokeWidth={2} vectorEffect="non-scaling-stroke"/>}
          {sel.a!=null && <circle cx={x(sel.a)} cy={y(data[sel.a])} r={4.5} fill={C.bg} stroke={mCol} strokeWidth={2.5} vectorEffect="non-scaling-stroke"/>}
          {sel.b!=null && <circle cx={x(sel.b)} cy={y(data[sel.b])} r={4.5} fill={C.bg} stroke={mCol} strokeWidth={2.5} vectorEffect="non-scaling-stroke"/>}
        </svg>
        {hi!=null && (
          <div style={{ position:"absolute", top:-2, left:`${(hi/(data.length-1))*100}%`, transform:`translateX(${hi > data.length*0.7 ? "-105%" : hi < data.length*0.3 ? "5%" : "-50%"})`, pointerEvents:"none", background:C.panel2, border:`1px solid ${C.line}`, borderRadius:7, padding:"5px 9px", fontSize:11, fontFamily:C.mono, whiteSpace:"nowrap", color:C.ink, boxShadow:"0 6px 18px rgba(0,0,0,0.25)" }}>
            <span style={{ fontWeight:700 }}>${data[hi]}</span>
            <span style={{ color: pctFromStart>=0?C.up:C.down, marginLeft:7 }}>{pctFromStart>=0?"+":""}{pctFromStart.toFixed(1)}%</span>
            {dates && dates[hi] && <span style={{ color:C.faint, marginLeft:7 }}>{dates[hi]}</span>}
            {(overlays||[]).map(o => o.values?.[hi]!=null && isFinite(o.values[hi]) && (
              <span key={o.label} style={{ color:o.color, marginLeft:7 }}>{o.label} ${o.values[hi].toFixed(2)}</span>
            ))}
          </div>
        )}
      </div>
      {measure && (
        <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap", marginTop:8, background:C.panel, border:`1px solid ${C.line}`, borderLeft:`3px solid ${mCol}`, borderRadius:9, padding:"8px 12px", fontFamily:C.mono, fontSize:12 }}>
          <span style={{ color:C.sub }}>
            {dates?.[measure.i1] ?? `pt ${measure.i1+1}`} → {dates?.[measure.i2] ?? `pt ${measure.i2+1}`}
            {measure.daysTxt && <span style={{ color:C.faint }}> · {measure.daysTxt}</span>}
          </span>
          <span style={{ color:C.ink }}>${measure.p1.toFixed(2)} → ${measure.p2.toFixed(2)}</span>
          <span style={{ color:mCol, fontWeight:800 }}>
            {measure.chg>=0?"+":"−"}${Math.abs(measure.chg).toFixed(2)} ({measure.pct>=0?"+":""}{measure.pct.toFixed(1)}%)
          </span>
          {sel.b==null ? (
            <span style={{ color:C.faint, fontSize:10.5 }}>click to lock the end point</span>
          ) : (
            <button onClick={(e)=>{ e.stopPropagation(); setSel({ a:null, b:null }); }}
              style={{ marginLeft:"auto", background:"none", border:`1px solid ${C.line}`, borderRadius:6, padding:"3px 9px", color:C.sub, cursor:"pointer", fontSize:10.5 }}>
              × clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}


// ── WATCHLIST CARD (fetches its own data) ─────────────────────────────
function WatchCard({ ticker, onOpen, onRemove, aiEnabled, onData, profile, range="1m", onFinancials }) {
  const [d, setD]       = useState(null);
  const [err, setErr]   = useState(false);
  // Sparkline timeframe is driven by the shared watchlist control (range prop)
  // but can still be overridden per-card; resyncs whenever the master changes.
  const [sparkRange, setSparkRange] = useState(range);
  useEffect(()=>{ setSparkRange(range); },[range]);
  useEffect(()=>{
    let alive = true;
    setD(null); setErr(false);
    fetchResearch(ticker, aiEnabled, profile).then(x=>{ if(alive){ x.error?setErr(true):(setD(x), onData?.(ticker, x)); }}).catch(()=>alive&&setErr(true));
    return ()=>{ alive=false; };
  },[ticker, aiEnabled, profile]);

  // 1D has no sub-day resolution in the daily research history, so it's fetched
  // live (5-min bars) on demand and cached per ticker for the life of the card.
  // The in-flight lock lives in a ref (not state) — putting it in the effect's
  // own dependency array would re-trigger the effect the instant it flips true,
  // tearing down `alive` before the fetch resolves and stranding the spinner.
  const [intraday, setIntraday] = useState(null);
  const [intradayLoading, setIntradayLoading] = useState(false);
  const intradayFetching = useRef(false);
  useEffect(()=>{
    if (sparkRange !== "1d" || intraday || intradayFetching.current) return;
    let alive = true;
    intradayFetching.current = true;
    setIntradayLoading(true);
    fetchChart(ticker, "1d").then(x=>{ if(alive && !x.error) setIntraday(x); }).catch(()=>{}).finally(()=>{ intradayFetching.current=false; if(alive) setIntradayLoading(false); });
    return ()=>{ alive=false; };
  },[sparkRange, ticker, intraday]);

  if (err) return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 17px", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
      <div><span style={{ fontWeight:700, color:C.ink }}>{displaySym(ticker)}</span>
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
            <span style={{ fontWeight:700, fontSize:16, color:C.ink }}>{displaySym(ticker)}</span>
            {d.signal==="hot" && <Flame size={13} color={C.hot}/>}
            {d.signal==="cold" && <Snowflake size={13} color={C.cold}/>}
          </div>
          <div style={{ fontSize:11, color:C.faint, marginTop:2, maxWidth:150, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{d.name}</div>
        </div>
        <div style={{ display:"flex", gap:4, alignItems:"center", flexShrink:0 }}>
          {onFinancials && (
            <button onClick={(e)=>{e.stopPropagation();onFinancials(ticker);}} title="Financials" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:2, display:"flex" }}
              onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Activity size={14}/></button>
          )}
          <button onClick={(e)=>{e.stopPropagation();onRemove(ticker);}} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:2 }}
            onMouseEnter={e=>e.currentTarget.style.color=C.down} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><X size={15}/></button>
        </div>
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
            <span title={String(d.ai_error)} style={{ fontSize:10, color:C.amber, fontWeight:600, cursor:"help" }}>API error ⓘ</span>
          ) : d.stage ? (
            <>
              <div style={{ fontFamily:C.mono, fontSize:12, fontWeight:800, letterSpacing:"0.07em", color:recColor(convictionToRec(d.conviction)), marginBottom:2 }}>{convictionToRec(d.conviction)}</div>
              <div style={{ fontSize:11, fontWeight:700, color:stageColor(d.stage), lineHeight:1.3 }}>{stageEmoji(d.stage)} {d.stage}</div>
              {d.conviction && <div style={{ fontSize:9.5, color:convictionColor(d.conviction), marginTop:2, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.04em" }}>{d.conviction}</div>}
            </>
          ) : !aiEnabled && d.rsi ? (
            <div style={{ fontFamily:C.mono, fontSize:12, fontWeight:800, letterSpacing:"0.07em", color: rsiColor(d.rsi) }}>
              {d.rsi < 30 ? "OVERSOLD" : d.rsi > 70 ? "OVERBOUGHT" : "HOLD"}
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
      {d.history && (() => {
        const isIntraday = sparkRange === "1d";
        const sparkDays = SPARK_RANGES.find(r=>r.key===sparkRange)?.days || 21;
        const slice = isIntraday
          ? (intraday?.history || [])
          : d.history.slice(-sparkDays);
        const sliceDates = isIntraday
          ? (intraday?.history_dates || [])
          : (d.history_dates || []).slice(-sparkDays);
        // % change over the selected timeframe. 1D uses the server's daily % change
        // (accurate prior-close comparison) rather than first-vs-last intraday bar,
        // since the first 5-min bar isn't necessarily yesterday's close.
        const tfChg = isIntraday ? d.chg : (slice.length>1 && slice[0] ? (slice[slice.length-1]/slice[0]-1)*100 : null);
        const tfCol = tfChg==null ? C.faint : tfChg>=0 ? C.up : C.down;
        return (
        <div style={{ marginTop:10 }} onClick={e => e.stopPropagation()}>
          <div style={{ display:"flex", gap:1, marginBottom:4, alignItems:"center" }}>
            {SPARK_RANGES.map(r => (
              <button key={r.key} onClick={()=>setSparkRange(r.key)}
                style={{ background:sparkRange===r.key?C.line:"transparent", border:"none", borderRadius:4,
                  padding:"1px 6px", color:sparkRange===r.key?C.ink:C.faint,
                  fontSize:9.5, fontFamily:C.mono, fontWeight:600, cursor:"pointer", minHeight:22 }}>
                {r.key.toUpperCase()}
              </button>
            ))}
            {tfChg!=null && (
              <span style={{ marginLeft:"auto", fontFamily:C.mono, fontSize:10.5, fontWeight:700, color:tfCol }}>
                {tfChg>=0?"+":""}{tfChg.toFixed(1)}% <span style={{ color:C.faint, fontWeight:500 }}>{sparkRange.toUpperCase()}</span>
              </span>
            )}
          </div>
          {isIntraday && intradayLoading && !intraday ? (
            <div style={{ height:34, display:"flex", alignItems:"center", justifyContent:"center", color:C.faint }}>
              <Loader2 size={12} style={{ animation:"spin 1s linear infinite" }}/>
            </div>
          ) : (
            <InteractiveChart data={slice} dates={sliceDates} h={34} color={tfCol} measure={false}/>
          )}
        </div>
        );
      })()}

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

      {/* RSI — mini graph with 30/70 bands, windowed to the card's selected
          timeframe (intraday bars for 1D), otherwise a colored 0–100 gauge. */}
      {d.rsi != null && (() => {
        const rDays = SPARK_RANGES.find(r=>r.key===sparkRange)?.days;
        let rVals = null, rDts = null;
        if (sparkRange === "1d" && (intraday?.history?.length || 0) >= 20) {
          ({ vals: rVals, dts: rDts } = rsiWindow(intraday.history, intraday.history_dates, null));
        } else if (Array.isArray(d.rsi_history) && d.rsi_history.length > 1) {
          const rh = d.rsi_history, rd = (d.history_dates || []).slice(-rh.length);
          rVals = rh.slice(-(rDays ?? 5)); rDts = rd.slice(-(rDays ?? 5));
        }
        const cur = (rVals && rVals.length) ? rVals[rVals.length-1] : d.rsi;
        return (
        <div style={{ marginTop:9 }} title={RSI_HELP}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:3 }}>
            <span style={{ fontSize:9, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase" }}>RSI <span style={{ letterSpacing:0 }}>· {sparkRange.toUpperCase()}</span></span>
            <span style={{ fontFamily:C.mono, fontSize:12.5, fontWeight:800, color:rsiColor(cur) }}>
              {Number(cur).toFixed(1)} <span style={{ fontSize:9, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.03em" }}>{rsiLabel(cur)}</span>
            </span>
          </div>
          {rVals && rVals.length > 1 ? (
            <RsiMini data={rVals} dates={rDts} h={24}/>
          ) : (
            <div style={{ height:6, background:C.line, borderRadius:3, position:"relative" }}>
              <div style={{ position:"absolute", left:"30%", top:0, bottom:0, width:1, background:`${C.up}66` }}/>
              <div style={{ position:"absolute", left:"70%", top:0, bottom:0, width:1, background:`${C.down}66` }}/>
              <div style={{ position:"absolute", left:`calc(${Math.min(100,Math.max(0,d.rsi))}% - 1px)`, top:-2, width:3, height:10, borderRadius:2, background:rsiColor(d.rsi) }}/>
            </div>
          )}
        </div>
        );
      })()}

      {/* Tactical setup — reversion filtered by trend (only when actionable) */}
      {d.tactical && d.tactical.key!=="neutral" && (() => {
        const col = tacticalCol(d.tactical);
        return (
          <div title={d.tactical.note} style={{ marginTop:9, display:"flex", alignItems:"center", gap:6, background:`${col}12`, border:`1px solid ${col}38`, borderRadius:7, padding:"6px 10px" }}>
            <span style={{ fontSize:11, fontWeight:800, color:col }}>{d.tactical.label}</span>
            <span style={{ fontSize:9.5, color:C.faint, fontFamily:C.mono, marginLeft:"auto" }}>RSI {d.rsi} · {d.ma?.trend}</span>
          </div>
        );
      })()}

      {/* Chips */}
      <div style={{ display:"flex", gap:6, marginTop:9, flexWrap:"wrap" }}>
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
function DetailPage({ ticker, onBack, inWatchlist, onToggleWatch, aiEnabled, profile, onFinancials }) {
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
      const r = await fetch(`${API}/why-now?ticker=${ticker}&profile=${encodeURIComponent(profile||"")}`, { headers: authHeaders() });
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
            <span style={{ fontSize:28, fontWeight:800, color:C.ink, letterSpacing:"-0.02em" }}>{displaySym(ticker)}</span>
            {aiOk && d.signal==="hot"  && <Flame     size={20} color={C.hot}/>}
            {aiOk && d.signal==="cold" && <Snowflake size={20} color={C.cold}/>}
          </div>
          <div style={{ fontSize:13, color:C.sub, marginTop:3 }}>{d.name} · {d.sector} · {d.mktCap}</div>
        </div>
        <div style={{ display:"flex", gap:8, flexShrink:0, flexWrap:"wrap", justifyContent:"flex-end" }}>
          {onFinancials && (
            <button onClick={()=>onFinancials(ticker)} title="Fundamentals & valuation" style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 14px", color:C.cold, cursor:"pointer", display:"flex", gap:7, alignItems:"center", fontSize:12.5, fontWeight:600 }}>
              <Activity size={14}/> Financials
            </button>
          )}
          <button onClick={()=>onToggleWatch(ticker)} style={{ background:inWatchlist?`${C.amber}18`:C.panel, border:`1px solid ${inWatchlist?C.amber:C.line}`, borderRadius:9, padding:"9px 14px", color:inWatchlist?C.amber:C.sub, cursor:"pointer", display:"flex", gap:7, alignItems:"center", fontSize:12.5, fontWeight:500 }}>
            <Star size={14} fill={inWatchlist?C.amber:"none"}/> {inWatchlist?"Watching":"Add to Watchlist"}
          </button>
        </div>
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
          <ChartWithRanges ticker={ticker} history={d.history} history_dates={d.history_dates} color={d.chg>=0?C.up:C.down} ma={d.ma}/>
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

      {/* ── Moving-average / trend analysis ────────────────── */}
      {d.ma && (d.ma.ma50 || d.ma.ma200) && (() => {
        const M = d.ma;
        const trendCol = M.trend==="uptrend"?C.up : M.trend==="downtrend"?C.down : C.amber;
        const rows = [["20-day", M.ma20, M.vs20],["50-day", M.ma50, M.vs50],["200-day", M.ma200, M.vs200]];
        return (
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"14px 16px", marginBottom:14 }} title={MA_HELP}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8, marginBottom:10 }}>
              <span style={{ fontSize:12.5, fontWeight:700, color:C.ink }}>Moving Averages & Trend</span>
              <span style={{ fontFamily:C.mono, fontSize:12, fontWeight:800, color:trendCol }}>
                {M.trend==="uptrend"?"▲ UPTREND" : M.trend==="downtrend"?"▼ DOWNTREND" : "→ MIXED"}
                {M.cross==="golden" && <span style={{ color:C.up, marginLeft:7, fontSize:10.5 }}>GOLDEN CROSS ✦</span>}
                {M.cross==="death"  && <span style={{ color:C.down, marginLeft:7, fontSize:10.5 }}>DEATH CROSS ✦</span>}
              </span>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(3, 1fr)", gap:10 }}>
              {rows.map(([lbl, val, vs]) => (
                <div key={lbl} style={{ background:C.panel2, borderRadius:9, padding:"9px 11px" }}>
                  <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase" }}>{lbl} SMA</div>
                  <div style={{ fontFamily:C.mono, fontSize:13.5, fontWeight:700, color:C.ink, marginTop:3 }}>{val!=null?`$${val.toFixed(2)}`:"—"}</div>
                  {vs!=null && <div style={{ fontFamily:C.mono, fontSize:10.5, fontWeight:700, color:vs>=0?C.up:C.down, marginTop:1 }}>
                    price {vs>=0?"+":""}{vs.toFixed(1)}% {vs>=0?"above":"below"}
                  </div>}
                </div>
              ))}
            </div>
            <div style={{ fontSize:10.5, color:C.faint, marginTop:9, lineHeight:1.5 }}>
              {M.trend==="uptrend"   && "Price sits above a rising 50 > 200-day stack — the classic bullish alignment."}
              {M.trend==="downtrend" && "Price is below both key averages with 50 < 200-day — a bearish alignment."}
              {M.trend==="mixed"     && "Price and the averages aren't cleanly stacked — trend is transitioning or rangebound."}
            </div>
            {/* Tactical setup: RSI × trend */}
            {d.tactical && d.tactical.key!=="neutral" && (() => {
              const col = tacticalCol(d.tactical);
              return (
                <div style={{ marginTop:11, paddingTop:11, borderTop:`1px solid ${C.panel2}`, display:"flex", gap:11, alignItems:"flex-start" }}>
                  <span style={{ fontSize:11, fontWeight:800, color:col, background:`${col}14`, border:`1px solid ${col}40`, borderRadius:6, padding:"4px 9px", whiteSpace:"nowrap", flexShrink:0 }}>{d.tactical.label}</span>
                  <span style={{ fontSize:11.5, color:C.sub, lineHeight:1.5 }}>{d.tactical.note}</span>
                </div>
              );
            })()}
          </div>
        );
      })()}

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
// ── MARKET BRIEF (agent-written; decision first, evidence on demand) ──────────
const URGENCY_COL = { high: () => C.down, medium: () => C.amber, low: () => C.faint };
const REGIME_COL  = { "risk-on": () => C.up, "risk-off": () => C.down, neutral: () => C.amber, mixed: () => C.violet };
const Badge = ({ text, col }) => (
  <span style={{ fontSize:10, fontWeight:800, letterSpacing:"0.06em", textTransform:"uppercase",
    color:col, background:`${col}16`, border:`1px solid ${col}40`, borderRadius:5, padding:"2px 8px", whiteSpace:"nowrap" }}>{text}</span>
);

function MarketBriefSection({ userId, positions, watchlist, profile, aiEnabled }) {
  const [row, setRow]           = useState(null);     // {brief, tool_log, generated_at, source}
  const [loading, setLoading]   = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [elapsed, setElapsed]   = useState(0);
  const [err, setErr]           = useState(null);
  const [openObs, setOpenObs]   = useState({});
  const [showLog, setShowLog]   = useState(false);

  useEffect(()=>{
    let alive = true;
    (async () => {
      let r = userId ? await sbLoadBrief(userId) : null;
      if (!r) { try { r = JSON.parse(localStorage.getItem("alphadesk:lastBrief") || "null"); } catch {} }
      if (alive) { setRow(r); setLoading(false); }
    })();
    return ()=>{ alive = false; };
  },[userId]);

  useEffect(()=>{
    if (!refreshing) return;
    const t0 = Date.now();
    const id = setInterval(()=>setElapsed(Math.floor((Date.now()-t0)/1000)), 1000);
    return ()=>clearInterval(id);
  },[refreshing]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true); setErr(null); setElapsed(0);
    try {
      const out = await fetchBriefRefresh({ positions, watchlist, profile });
      if (out.error) { setErr(out.error); }
      else {
        const r = { brief: out.brief, tool_log: out.tool_log, generated_at: out.generated_at,
                    source: "manual", model: out.model, turns: out.turns };
        setRow(r);
        try { localStorage.setItem("alphadesk:lastBrief", JSON.stringify(r)); } catch {}
        if (userId) sbSaveBrief(userId, out);
      }
    } catch (e) { setErr(String(e.message || e)); }
    setRefreshing(false);
  };

  const b = row?.brief;
  const regimeCol = b ? (REGIME_COL[b.market_regime?.label] || (()=>C.amber))() : C.amber;
  const when = row?.generated_at ? new Date(row.generated_at) : null;

  return (
    <div style={{ marginBottom:30 }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:8 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>Market Brief</div>
          <div style={{ fontSize:11.5, color:C.faint, marginTop:2 }}>
            {when ? `${row.source==="scheduled" ? "pre-market run" : "manual run"} · ${when.toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" })}` : "agent-written, evidence-backed"}
          </div>
        </div>
        <button onClick={refresh} disabled={refreshing || !aiEnabled}
          title={aiEnabled ? "Run the agent now (~1-4 min)" : "Turn on AI Insights in Settings"}
          style={{ background: refreshing||!aiEnabled ? C.panel : C.cold, border:`1px solid ${refreshing||!aiEnabled?C.line:C.cold}`,
            borderRadius:9, padding:"8px 15px", color: refreshing||!aiEnabled ? C.sub : "#fff",
            cursor: refreshing||!aiEnabled ? "default" : "pointer", fontSize:12.5, fontWeight:700,
            display:"flex", gap:7, alignItems:"center" }}>
          {refreshing ? <><Loader2 size={14} style={{ animation:"spin 1s linear infinite" }}/> Investigating… {elapsed}s</> : <><Zap size={14}/> Refresh Brief</>}
        </button>
      </div>

      {err && <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}33`, borderRadius:10, padding:"11px 14px", color:C.down, fontSize:12.5, marginBottom:12 }}>Brief failed: {err}</div>}

      {loading ? (
        <div style={{ padding:30, textAlign:"center", color:C.sub }}><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/></div>
      ) : !b ? (
        <div style={{ background:C.panel, border:`1px dashed ${C.line}`, borderRadius:14, padding:"26px 22px", textAlign:"center" }}>
          <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginBottom:6 }}>No brief yet</div>
          <div style={{ fontSize:12.5, color:C.sub, lineHeight:1.6, maxWidth:520, margin:"0 auto" }}>
            The Market Brief agent investigates the macro regime, sector rotation, and your holdings before
            the open, then writes a decision-first summary with its evidence attached.
            {aiEnabled ? " Hit Refresh Brief to run it now." : " Turn on AI Insights in Settings, then hit Refresh Brief."}
          </div>
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
          {/* Headline + regime */}
          <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderLeft:`4px solid ${regimeCol}`, borderRadius:14, padding:"18px 20px" }}>
            <div style={{ fontSize:18, fontWeight:800, color:C.ink, lineHeight:1.35, letterSpacing:"-0.01em" }}>{b.headline}</div>
            <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:10, flexWrap:"wrap" }}>
              <Badge text={b.market_regime?.label} col={regimeCol}/>
              <span style={{ fontSize:10.5, color:C.faint }}>confidence: {b.market_regime?.confidence}</span>
            </div>
            <div style={{ fontSize:12.5, color:C.sub, lineHeight:1.6, marginTop:9 }}>{b.market_regime?.summary}</div>
          </div>

          {/* Portfolio read — the priority section */}
          {b.portfolio_read && (
            <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 20px" }}>
              <div style={{ fontSize:10.5, color:C.faint, letterSpacing:"0.08em", marginBottom:8 }}>YOUR PORTFOLIO</div>
              <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.65, fontWeight:500 }}>{b.portfolio_read.takeaway}</div>
              {(b.portfolio_read.exposures||[]).length > 0 && (
                <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginTop:12 }}>
                  {b.portfolio_read.exposures.map((x,i)=>{
                    const col = (URGENCY_COL[x.severity]||URGENCY_COL.low)();
                    return (
                      <div key={i} title={x.detail} style={{ border:`1px solid ${col}40`, background:`${col}0c`, borderRadius:9, padding:"7px 11px", maxWidth:340 }}>
                        <div style={{ display:"flex", gap:7, alignItems:"center" }}>
                          <span style={{ fontSize:12, fontWeight:700, color:C.ink }}>{x.theme}</span>
                          <Badge text={x.severity} col={col}/>
                        </div>
                        <div style={{ fontSize:11, color:C.sub, marginTop:3, lineHeight:1.45 }}>{x.detail}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Observations — expandable evidence */}
          {(b.key_observations||[]).length > 0 && (
            <div>
              <div style={{ fontSize:10.5, color:C.faint, letterSpacing:"0.08em", marginBottom:8 }}>KEY OBSERVATIONS <span style={{ textTransform:"none", letterSpacing:0 }}>· tap for evidence</span></div>
              <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                {b.key_observations.map((o,i)=>(
                  <div key={i} onClick={()=>setOpenObs(m=>({ ...m, [i]: !m[i] }))}
                    style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"13px 16px", cursor:"pointer" }}>
                    <div style={{ display:"flex", justifyContent:"space-between", gap:10, alignItems:"flex-start" }}>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:13, fontWeight:700, color:C.ink }}>{o.title}</div>
                        <div style={{ fontSize:12, color:C.sub, marginTop:4, lineHeight:1.55 }}>{o.so_what}</div>
                      </div>
                      <ChevronDown size={15} color={C.faint} style={{ flexShrink:0, transform: openObs[i]?"rotate(180deg)":"none", transition:"transform .15s" }}/>
                    </div>
                    {openObs[i] && (o.evidence||[]).length > 0 && (
                      <div style={{ marginTop:10, borderTop:`1px solid ${C.panel2}`, paddingTop:10, display:"flex", flexDirection:"column", gap:6 }}>
                        {o.evidence.map((ev,j)=>(
                          <div key={j} style={{ display:"flex", gap:9, alignItems:"baseline" }}>
                            <span style={{ fontFamily:C.mono, fontSize:9.5, color:C.cold, background:`${C.cold}12`, borderRadius:4, padding:"1px 6px", whiteSpace:"nowrap", flexShrink:0 }}>{ev.source}</span>
                            <span style={{ fontSize:11.5, color:C.sub, lineHeight:1.5 }}>{ev.fact}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Watchlist flags */}
          {(b.watchlist_flags||[]).length > 0 && (
            <div>
              <div style={{ fontSize:10.5, color:C.faint, letterSpacing:"0.08em", marginBottom:8 }}>WATCHLIST FLAGS</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(250px,1fr))", gap:8 }}>
                {b.watchlist_flags.map((f,i)=>{
                  const col = (URGENCY_COL[f.urgency]||URGENCY_COL.low)();
                  return (
                    <div key={i} style={{ background:C.panel, border:`1px solid ${C.line}`, borderLeft:`3px solid ${col}`, borderRadius:10, padding:"11px 13px" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                        <span style={{ fontWeight:800, fontSize:13, color:C.ink }}>{displaySym(f.ticker)}</span>
                        <Badge text={f.urgency} col={col}/>
                      </div>
                      <div style={{ fontSize:11.5, fontWeight:600, color:C.sub, marginTop:4 }}>{f.flag}</div>
                      <div style={{ fontSize:11, color:C.faint, marginTop:3, lineHeight:1.45 }}>{f.reason}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Suggested actions */}
          {(b.suggested_actions||[]).length > 0 && (
            <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"14px 18px" }}>
              <div style={{ fontSize:10.5, color:C.faint, letterSpacing:"0.08em", marginBottom:9 }}>SUGGESTED ACTIONS</div>
              <div style={{ display:"flex", flexDirection:"column", gap:9 }}>
                {b.suggested_actions.map((a,i)=>{
                  const col = a.confidence==="high" ? C.up : a.confidence==="medium" ? C.amber : C.faint;
                  return (
                    <div key={i} style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                      <Badge text={a.confidence} col={col}/>
                      <div style={{ minWidth:0 }}>
                        <div style={{ fontSize:12.5, fontWeight:700, color:C.ink }}>{a.action}</div>
                        <div style={{ fontSize:11.5, color:C.sub, marginTop:2, lineHeight:1.5 }}>{a.rationale}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Honesty footer + tool log */}
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {(b.what_i_did_not_check||[]).length > 0 && (
              <div style={{ fontSize:11, color:C.faint, fontStyle:"italic", lineHeight:1.6 }}>
                <b style={{ fontStyle:"normal" }}>Not checked:</b> {b.what_i_did_not_check.join(" · ")}
              </div>
            )}
            <div>
              <button onClick={()=>setShowLog(s=>!s)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:8, padding:"7px 12px", color:C.sub, cursor:"pointer", fontSize:11.5, fontWeight:600, display:"flex", gap:6, alignItems:"center" }}>
                <Activity size={12}/> How I got here — {row.tool_log?.length ?? 0} tool calls {showLog?"▴":"▾"}
              </button>
              {showLog && (
                <div style={{ marginTop:8, background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"6px 0", overflowX:"auto" }}>
                  {(row.tool_log||[]).map((e,i)=>(
                    <div key={i} style={{ padding:"9px 14px", borderTop: i?`1px solid ${C.panel2}`:"none", fontFamily:C.mono, fontSize:11 }}>
                      <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                        <span style={{ color:C.faint }}>#{e.turn}</span>
                        <span style={{ color:C.cold, fontWeight:700 }}>{e.tool}</span>
                        {e.input && Object.keys(e.input).length > 0 && <span style={{ color:C.sub }}>{JSON.stringify(e.input).slice(0,90)}</span>}
                        <span style={{ color:C.faint, marginLeft:"auto" }}>{e.ms}ms</span>
                      </div>
                      {e.result_preview && <div style={{ color:C.faint, marginTop:4, lineHeight:1.5, wordBreak:"break-all" }}>{String(e.result_preview).slice(0,300)}</div>}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ fontSize:10, color:C.faint }}>Personal research input — not financial advice.</div>
          </div>
        </div>
      )}
    </div>
  );
}

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
function PositionForm({ initial, onSubmit, onClose, accounts=[] }) {
  const editing = !!initial;
  const [type, setType]     = useState(initial?.type || "SHARES");
  const [ticker, setTicker] = useState(initial?.ticker || "");
  const [qty, setQty]       = useState(initial?.qty != null ? String(initial.qty) : "");
  const [cost, setCost]     = useState(initial?.cost_basis != null ? String(initial.cost_basis) : "");
  const [strike, setStrike] = useState(initial?.strike != null ? String(initial.strike) : "");
  const [expiry, setExpiry] = useState(initial?.expiry || "");
  const [stop, setStop]     = useState(initial?.stop != null ? String(initial.stop) : "");
  const [account, setAccount] = useState(initial?.account || UNASSIGNED);
  const [error, setError]   = useState("");
  const isOpt    = type === "CALL" || type === "PUT";
  const isCryptoT = type === "CRYPTO";

  const submit = () => {
    let T = normalizeTicker(ticker);                        // resolve crypto / metal-spot aliases
    if (isCryptoT) T = T.includes("-") ? T : `${T}-USD`;   // force the yfinance pair
    const q = parseFloat(qty), cb = parseFloat(cost);
    if (!T) return setError("Ticker is required");
    if (!(q > 0)) return setError("Quantity must be greater than 0");
    if (cost === "" || isNaN(cb) || cb < 0) return setError("Cost basis (total $ paid) is required");
    const pos = { ticker: T, type, qty: q, cost_basis: cb,
                  account: account===UNASSIGNED ? null : account };
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
        {["SHARES","CRYPTO","CALL","PUT"].map(t=>(
          <button key={t} onClick={()=>setType(t)} style={{ padding:"6px 14px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:600, background:type===t?C.line:"transparent", color:type===t?C.ink:C.sub }}>{t}</button>
        ))}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(120px, 1fr))", gap:10, marginBottom:12 }}>
        <div><label style={lbl}>TICKER{isCryptoT && <span style={{ color:C.cold, marginLeft:4 }}>BTC → BTC-USD</span>}</label><input value={ticker} onChange={e=>setTicker(e.target.value)} placeholder={isCryptoT?"BTC":"NVDA, GLD, GC=F"} title={isCryptoT?"":"Stock, ETF (GLD/SLV), or metal spot (GC=F, or type GOLDSPOT)"} style={{ ...inp, textTransform:"uppercase" }}/></div>
        <div><label style={lbl}>QUANTITY</label><input value={qty} onChange={e=>setQty(e.target.value)} type="number" step="any" placeholder={isOpt?"contracts":isCryptoT?"units (fractional ok)":"shares"} style={inp}/></div>
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
        <div>
          <label style={lbl}>ACCOUNT</label>
          <select value={account} onChange={e=>setAccount(e.target.value)} style={{ ...inp, cursor:"pointer" }}>
            <option value={UNASSIGNED}>Unassigned</option>
            {accounts.map(acc => <option key={acc.id} value={acc.id}>{acc.name}</option>)}
          </select>
        </div>
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

// Shared grid + number formatter for the portfolio position rows / folders.
const POS_GRID = "minmax(140px,2fr) minmax(60px,1fr) minmax(76px,1.1fr) minmax(70px,1fr) minmax(60px,1fr) minmax(44px,0.7fr) minmax(80px,1.1fr) minmax(130px,1.8fr) 60px";
// Sum of the grid's min column widths. Rows carry this as minWidth and the folder
// body scrolls horizontally below it — so on a phone the full P&L/Signal/actions
// columns stay reachable by swiping instead of being clipped off-screen.
const POS_MINW = 720;
const fmtNum = (v, d=2) => (v===null||v===undefined) ? "—" : Number(v).toFixed(d);
const POS_COLS = [
  {label:"Position", align:"left"},  {label:"Spot", align:"right"}, {label:"Today", align:"right"},
  {label:"P&L", align:"right"},      {label:"P&L %", align:"right"},{label:"DTE", align:"right"},
  {label:"Stop", align:"right"},     {label:"Signal", align:"right"},
];

// A single draggable position row. The drag handle (six-dots) is the only grab
// point, so clicking elsewhere on the row still opens the ticker detail.
function PositionRow({ p, groupId, onOpen, onEdit, onRemove, onPayoff }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: p.id, data:{ type:"position", account: groupId } });
  const [tip, setTip] = useState(false);
  const isOpt = p.type === "CALL" || p.type === "PUT";
  const isCry = p.type === "CRYPTO" || isCrypto(p.ticker);
  const label = isOpt ? `${displaySym(p.ticker)} $${p.strike}${(p.type||"")[0]}` : displaySym(p.ticker);
  return (
    <div ref={setNodeRef} className="pos-row"
      onClick={()=>onOpen&&onOpen(p.ticker)}
      style={{ display:"grid", gridTemplateColumns:POS_GRID, minWidth:POS_MINW, padding:"12px 16px", borderTop:`1px solid ${C.panel2}`, fontFamily:C.mono, fontSize:12, color:C.ink, alignItems:"center", opacity:isDragging?0.4:1, cursor:"pointer", background:"transparent",
        transform: CSS.Transform.toString(transform), transition }}
      onMouseEnter={e=>e.currentTarget.style.background=C.panel2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
      <div style={{ display:"flex", alignItems:"center", gap:7, minWidth:0 }}>
        <span className="pos-drag-handle" {...attributes} {...listeners}
          title="Drag into an account" onClick={e=>e.stopPropagation()}
          style={{ flexShrink:0, cursor:"grab", touchAction:"none", display:"flex", alignItems:"center" }}>
          <GripVertical size={14} color={C.faint}/>
        </span>
        <div style={{ display:"flex", flexDirection:"column", gap:2, minWidth:0 }}>
          <span style={{ fontWeight:700, fontFamily:"inherit" }}>{label}</span>
          <span style={{ fontSize:9.5, color:C.faint, whiteSpace:"nowrap" }}>{isOpt ? `${p.qty}x · exp ${p.expiry}` : isCry ? `${p.qty} units` : `${p.qty} shares`}</span>
        </div>
      </div>
      <div style={{ textAlign:"right", fontFamily:C.mono, fontSize:12 }}>${fmtNum(p.spot)}</div>
      <div style={{ textAlign:"right", fontFamily:C.mono, fontSize:12 }} title="Today's change">
        {p.day_change==null ? <span style={{ color:C.faint }}>—</span> : (
          <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", lineHeight:1.25 }}>
            <span style={{ color:(p.day_change||0)>=0?C.up:C.down }}>{(p.day_change||0)>=0?"+":"−"}${Math.abs(p.day_change||0).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
            <span style={{ fontSize:9, color:(p.day_change||0)>=0?C.up:C.down }}>{((p.day_change_pct||0)*100)>=0?"+":""}{((p.day_change_pct||0)*100).toFixed(1)}%</span>
          </div>
        )}
      </div>
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
      <div style={{ position:"relative" }} onMouseEnter={()=>setTip(true)} onMouseLeave={()=>setTip(false)}>
        <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:2, cursor:"default" }}>
          <span style={{ fontFamily:C.mono, fontSize:13, fontWeight:800, letterSpacing:"0.06em", color:recColor(p.rec||convictionToRec(p.conviction)) }}>{p.rec||convictionToRec(p.conviction)||"—"}</span>
          {p.stage && <span style={{ fontSize:9, color:stageColor(p.stage), lineHeight:1.3, textAlign:"right" }}>{stageEmoji(p.stage)} {p.stage}</span>}
          {p.conviction && <span style={{ fontSize:8.5, fontWeight:600, color:convictionColor(p.conviction), textTransform:"uppercase", letterSpacing:"0.03em" }}>{p.conviction}</span>}
        </div>
        {tip && (
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
        {isOpt && <button onClick={(e)=>{e.stopPropagation();onPayoff(p);}} title="Payoff diagram" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><LineChart size={13}/></button>}
        <button onClick={(e)=>{e.stopPropagation();onEdit(p);}} title="Edit" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Pencil size={12}/></button>
        <button onClick={(e)=>{e.stopPropagation();onRemove(p.id);}} title="Remove" style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }} onMouseEnter={e=>e.currentTarget.style.color=C.down} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Trash2 size={13}/></button>
      </div>
    </div>
  );
}

// A collapsible account folder that is also a drag drop-target. Header shows a
// color dot, name, position count, total value and total P&L. `dropId` is the
// account id (or UNASSIGNED) used to route a dropped position.
function AccountFolder({ dropId, name, color, items, collapsed, onToggle, onRename, onDelete, rowProps,
  cash=0, margin=0, marginRate=0, onSetFunds }) {
  const isUnassigned = dropId===UNASSIGNED;
  // Outer node = sortable for reordering the account itself (Unassigned is pinned).
  const sortable = useSortable({ id:`acct:${dropId}`, data:{ type:"account", accountId:dropId }, disabled:isUnassigned });
  // Inner node = droppable target for positions dragged into this account.
  const { setNodeRef:setDropRef, isOver } = useDroppable({ id: dropId });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(name);
  const [fundsEdit, setFundsEdit] = useState(false);
  const [cDraft, setCDraft]   = useState(String(cash||0));
  const [mDraft, setMDraft]   = useState(String(margin||0));
  const [rDraft, setRDraft]   = useState(String(marginRate||0));
  const count = items.length;
  const value = items.reduce((s,p)=>s+(p.current_val||0),0);
  const pnl   = items.reduce((s,p)=>s+(p.pnl||0),0);
  const dayChg = items.reduce((s,p)=>s+(p.day_change||0),0);
  const removable = Boolean(onDelete);
  const openFunds = (e)=>{ e.stopPropagation(); setCDraft(String(cash||0)); setMDraft(String(margin||0)); setRDraft(String(marginRate||0)); setFundsEdit(true); };
  const saveFunds = ()=>{ onSetFunds && onSetFunds(dropId, { cash:parseFloat(cDraft)||0, margin:parseFloat(mDraft)||0, marginRate:parseFloat(rDraft)||0 }); setFundsEdit(false); };
  const fi = { width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:6, padding:"5px 7px", color:C.ink, fontSize:12.5, outline:"none", fontFamily:C.mono };
  return (
    <div ref={sortable.setNodeRef}
      style={{ marginBottom:12, transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : 1 }}>
      <div ref={setDropRef}
        style={{ background:C.panel, border:`1px solid ${isOver?color:C.line}`, borderRadius:12,
          boxShadow:isOver?`0 0 0 2px ${color}55 inset`:"none", transition:"box-shadow .12s, border-color .12s" }}>
      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px", cursor:"pointer" }}
        onClick={()=>!editing && onToggle(dropId)}>
        {!isUnassigned && (
          <span className="acct-drag-handle" {...sortable.attributes} {...sortable.listeners}
            title="Drag to reorder accounts" onClick={e=>e.stopPropagation()}
            style={{ display:"flex", alignItems:"center", cursor:"grab", touchAction:"none", flexShrink:0 }}>
            <GripVertical size={13} color={C.faint}/>
          </span>
        )}
        <ChevronDown size={16} color={C.faint} style={{ transform: collapsed?"rotate(-90deg)":"none", transition:"transform .15s", flexShrink:0 }}/>
        <span style={{ width:10, height:10, borderRadius:"50%", background:color, flexShrink:0 }}/>
        {editing ? (
          <input autoFocus value={draft} onChange={e=>setDraft(e.target.value)} onClick={e=>e.stopPropagation()}
            onKeyDown={e=>{ if(e.key==="Enter"){ onRename(dropId, draft); setEditing(false); } if(e.key==="Escape"){ setDraft(name); setEditing(false); } }}
            style={{ background:C.panel2, border:`1px solid ${C.line}`, borderRadius:6, padding:"3px 8px", color:C.ink, fontSize:13.5, fontWeight:700, outline:"none", minWidth:0, flex:"0 1 220px" }}/>
        ) : (
          <span style={{ fontSize:13.5, fontWeight:700, color:C.ink, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{name}</span>
        )}
        <span style={{ fontSize:10.5, color:C.faint, background:C.panel2, borderRadius:20, padding:"1px 9px", flexShrink:0 }}>{count}</span>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:16, flexShrink:0 }}>
          {editing ? (
            <button onClick={e=>{ e.stopPropagation(); onRename(dropId, draft); setEditing(false); }} title="Save name"
              style={{ background:"none", border:"none", color:C.up, cursor:"pointer", padding:0, display:"flex" }}><Check size={15}/></button>
          ) : (
            <>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontFamily:C.mono, fontSize:13, fontWeight:700, color:C.ink }}>${value.toLocaleString(undefined,{maximumFractionDigits:0})}</div>
                <div style={{ display:"flex", gap:8, justifyContent:"flex-end", fontFamily:C.mono, fontSize:10.5, fontWeight:700 }}>
                  {count>0 && <span style={{ color:dayChg>=0?C.up:C.down }} title="Today's change">{dayChg>=0?"+":"−"}${Math.abs(dayChg).toLocaleString(undefined,{maximumFractionDigits:0})} today</span>}
                  <span style={{ color:pnl>=0?C.up:C.down }} title="Total P&L">{pnl>=0?"+":""}${Math.abs(pnl).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                </div>
              </div>
              {onRename && <button className="acct-action" onClick={e=>{ e.stopPropagation(); setDraft(name); setEditing(true); }} title="Rename account"
                style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0, display:"flex" }} onMouseEnter={e=>e.currentTarget.style.color=C.cold} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Pencil size={13}/></button>}
              {removable && <button className="acct-action" onClick={e=>{ e.stopPropagation(); onDelete(dropId); }} title="Delete account (positions return to Unassigned)"
                style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0, display:"flex" }} onMouseEnter={e=>e.currentTarget.style.color=C.down} onMouseLeave={e=>e.currentTarget.style.color=C.faint}><Trash2 size={13}/></button>}
            </>
          )}
        </div>
      </div>
      {/* Body */}
      {!collapsed && (
        <div style={{ borderTop:`1px solid ${C.line}` }}>
          {/* Per-account cash & margin */}
          {onSetFunds && (
            <div style={{ padding:"9px 16px", borderBottom:`1px solid ${C.panel2}`, background:C.panel2+"55" }}>
              {fundsEdit ? (
                <div style={{ display:"flex", flexWrap:"wrap", gap:8, alignItems:"flex-end" }}>
                  <div style={{ flex:"1 1 90px" }}><div style={{ fontSize:8, color:C.faint, marginBottom:2 }}>CASH $</div><input autoFocus value={cDraft} onChange={e=>setCDraft(e.target.value)} type="number" style={fi}/></div>
                  <div style={{ flex:"1 1 90px" }}><div style={{ fontSize:8, color:C.faint, marginBottom:2 }}>MARGIN $</div><input value={mDraft} onChange={e=>setMDraft(e.target.value)} type="number" style={fi}/></div>
                  <div style={{ flex:"0 1 70px" }}><div style={{ fontSize:8, color:C.faint, marginBottom:2 }}>RATE %</div><input value={rDraft} onChange={e=>setRDraft(e.target.value)} onKeyDown={e=>{ if(e.key==="Enter") saveFunds(); if(e.key==="Escape") setFundsEdit(false); }} type="number" style={fi}/></div>
                  <button onClick={saveFunds} style={{ background:C.up, border:"none", borderRadius:6, padding:"6px 11px", color:"#06080d", fontSize:11.5, fontWeight:700, cursor:"pointer" }}>Save</button>
                  <button onClick={()=>setFundsEdit(false)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:6, padding:"6px 9px", color:C.sub, fontSize:11.5, cursor:"pointer" }}>Cancel</button>
                </div>
              ) : (
                <div onClick={openFunds} title="Set cash & margin for this account"
                  style={{ display:"flex", alignItems:"center", gap:14, cursor:"pointer", fontSize:11.5, color:C.sub, flexWrap:"wrap" }}>
                  <span>💵 Cash <b style={{ color:(cash||0)>0?C.cold:C.faint, fontFamily:C.mono }}>${(Number(cash)||0).toLocaleString()}</b></span>
                  <span>📉 Margin <b style={{ color:(margin||0)>0?C.amber:C.faint, fontFamily:C.mono }}>${(Number(margin)||0).toLocaleString()}</b>{(margin||0)>0 && <span style={{ color:C.faint }}> @ {marginRate||0}%</span>}</span>
                  <Pencil size={11} color={C.faint}/>
                </div>
              )}
            </div>
          )}
          {count===0 ? (
            <div style={{ padding:"16px", fontSize:11.5, color:C.faint, textAlign:"center" }}>
              {isOver ? "Drop to add to this account" : "Drag positions here"}
            </div>
          ) : (
            // Horizontal scroll on narrow screens so the wide position table
            // (P&L / Signal / actions) stays reachable instead of being clipped.
            <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch" }}>
              <div style={{ display:"grid", gridTemplateColumns:POS_GRID, minWidth:POS_MINW, padding:"8px 16px", fontSize:9, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase" }}>
                {POS_COLS.map((c,i)=>(<div key={i} style={{ textAlign:c.align }}>{c.label}</div>))}
                <div/>
              </div>
              <SortableContext items={items.map(p=>p.id)} strategy={verticalListSortingStrategy}>
                {items.map(p => <PositionRow key={p.id} p={p} groupId={dropId} {...rowProps}/>)}
              </SortableContext>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

// ── PORTFOLIO (manual positions, Greeks, P&L; expired in an envelope) ───
function PortfolioPage({ positions, data, err, loading, margin, marginRate, onMargin, cash, onCash,
  totalCash=0, totalMargin=0, blendedRate=0, aiEnabled, profile, onAdd, onUpdate, onRemove, onReorder, onRefresh, onOpen,
  accounts=[], accountCollapsed={}, onAddAccount, onRenameAccount, onDeleteAccount, onToggleAccountCollapse, onReorderPositions, onReorderAccounts, onSetFunds }) {
  const [showForm, setShowForm]       = useState(false);
  const [editing, setEditing]         = useState(null);
  const [showExpired, setShowExpired] = useState(false);
  const [payoff, setPayoff]           = useState(null);
  const [adding, setAdding]           = useState(false);   // "+ Add Account" inline input open
  const [newName, setNewName]         = useState("");
  const [activeDrag, setActiveDrag]   = useState(null);    // currently-dragged position (for overlay)

  const a       = data?.analytics || {};
  const active  = data?.positions || [];
  const expired = data?.expired   || [];
  const errored = data?.errored   || [];
  const pnlCol  = (a.total_pnl||0)>=0?C.up:C.down;
  const num = (v, d=2) => (v===null||v===undefined) ? "—" : Number(v).toFixed(d);
  const sectors = Object.entries(a.sector_alloc||{}).sort((x,y)=>y[1]-x[1]);
  const totalAlloc = sectors.reduce((s,[,v])=>s+v,0) || 1;

  // Drag-and-drop: pointer (desktop) + touch with long-press (mobile).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint:{ distance:6 } }),
    useSensor(TouchSensor,   { activationConstraint:{ delay:250, tolerance:8 } }),
  );
  // Group the valued active positions by account assignment (Unassigned first).
  const groups = useMemo(()=>{
    const map = { [UNASSIGNED]: [] };
    accounts.forEach(acc => { map[acc.id] = []; });
    active.forEach(p => { const k = (p.account && map[p.account]) ? p.account : UNASSIGNED; map[k].push(p); });
    return map;
  },[active, accounts]);
  const onDragStart = (e)=>{
    const t = e.active.data.current?.type;
    if (t==="account") {
      const acc = accounts.find(x=>`acct:${x.id}`===e.active.id);
      setActiveDrag(acc ? { type:"account", name:acc.name, color:acc.color } : null);
    } else {
      const p = active.find(x=>x.id===e.active.id);
      setActiveDrag(p ? { type:"position", ...p } : null);
    }
  };

  // Reorder the named accounts when an account folder is dragged onto another.
  const handleAccountReorder = (activeAcctId, overRaw) => {
    let overAcct = null;
    const o = String(overRaw);
    if (o.startsWith("acct:")) overAcct = o.slice(5);
    else if (o===UNASSIGNED || accounts.some(x=>x.id===o)) overAcct = o;
    else { const op = active.find(p=>p.id===o); if (op) overAcct = op.account ?? UNASSIGNED; }
    if (!overAcct || overAcct===UNASSIGNED) return;          // can't reorder relative to Unassigned
    const from = accounts.findIndex(x=>x.id===activeAcctId);
    const to   = accounts.findIndex(x=>x.id===overAcct);
    if (from<0 || to<0 || from===to) return;
    onReorderAccounts(arrayMove(accounts, from, to));
  };

  // Move a position: handles both reorder-within-account and move-across-accounts.
  // Rebuilds the raw positions array (preserving expired/errored) and updates assignment.
  const movePosition = (activeId, overRaw) => {
    const arr = positions.map(p=>({ ...p }));
    const from = arr.findIndex(p=>p.id===activeId);
    if (from<0) return;
    let over = String(overRaw);
    if (over.startsWith("acct:")) over = over.slice(5);       // folder drop via outer sortable node
    let targetAccount, anchorId = null;
    if (over===UNASSIGNED || accounts.some(x=>x.id===over)) {
      targetAccount = over===UNASSIGNED ? null : over;         // dropped on a folder (possibly empty)
    } else {
      const overPos = arr.find(p=>p.id===over);
      if (!overPos) return;
      targetAccount = overPos.account ?? null;                 // dropped on a row → that row's account
      anchorId = over;
    }
    const moved = arr[from]; moved.account = targetAccount;
    arr.splice(from, 1);
    let insertAt;
    if (anchorId) {
      insertAt = arr.findIndex(p=>p.id===anchorId);
      if (insertAt<0) insertAt = arr.length;
    } else {
      let last = -1; arr.forEach((p,i)=>{ if ((p.account ?? null)===targetAccount) last = i; });
      insertAt = last>=0 ? last+1 : arr.length;
    }
    arr.splice(insertAt, 0, moved);
    onReorderPositions(arr);
  };

  const onDragEnd = (e)=>{
    setActiveDrag(null);
    const { active:act, over } = e;
    if (!over) return;
    if (act.data.current?.type==="account") handleAccountReorder(act.data.current.accountId, over.id);
    else movePosition(act.id, over.id);
  };
  const rowProps = { onOpen, onEdit:(p)=>{ setEditing(p); setShowForm(false); }, onRemove, onPayoff:setPayoff };

  const Stat = ({ label, value, sub, col }) => (
    <div style={{ flex:"1 1 180px", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"15px 18px" }}>
      <div style={{ fontSize:10, color:C.faint, letterSpacing:"0.08em" }}>{label}</div>
      <div style={{ fontFamily:C.mono, fontSize:24, fontWeight:700, color:col||C.ink, marginTop:4 }}>{value}</div>
      {sub && <div style={{ fontSize:11, color:C.sub, marginTop:2 }}>{sub}</div>}
    </div>
  );

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
          accounts={accounts}
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
            <Stat label="TODAY'S CHANGE"
              value={`${(a.daily_change||0)>=0?"+":"−"}$${Math.abs(a.daily_change||0).toLocaleString(undefined,{maximumFractionDigits:0})}`}
              sub={`${((a.daily_change_pct||0)*100)>=0?"+":""}${((a.daily_change_pct||0)*100).toFixed(2)}% today`}
              col={(a.daily_change||0)>=0?C.up:C.down}/>
            <Stat label="TOTAL P&L"    value={`${(a.total_pnl||0)>=0?"+":""}$${Math.abs(a.total_pnl||0).toLocaleString()}`} sub={`${((a.total_pnl_pct||0)*100).toFixed(1)}%`} col={pnlCol}/>
            <Stat label="NET VALUE"    value={`$${(a.net_value ?? a.total_value ?? 0).toLocaleString()}`} sub={totalMargin>0?"equity after margin":"= total value"}/>
            <Stat label="DAILY THETA"  value={`$${num(a.daily_theta,0)}`} sub="time decay per day" col={(a.daily_theta||0)<0?C.down:C.sub}/>
            <Stat label="CASH"   value={`$${totalCash.toLocaleString()}`} col={totalCash>0?C.cold:C.ink}
              sub={accounts.length ? "across all accounts" : "edit in account below"}/>
            <Stat label="MARGIN" value={`$${totalMargin.toLocaleString()}`} col={totalMargin>0?C.amber:C.ink}
              sub={totalMargin>0 ? `${blendedRate.toFixed(2)}% blended · $${num(a.margin_interest_daily,2)}/day` : "edit in account below"}/>
          </div>

          <PortfolioAnalysis data={data} aiEnabled={aiEnabled} cash={totalCash} profile={profile}/>

          {/* Accounts — drag positions between collapsible buckets */}
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8, flexWrap:"wrap", gap:8 }}>
            <div style={{ fontSize:11, color:C.faint }}>Drag the handle (⋮⋮) to move a position into an account · on phone, long-press then drag</div>
            {adding ? (
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                <input autoFocus value={newName} onChange={e=>setNewName(e.target.value)} placeholder="Account name"
                  onKeyDown={e=>{ if(e.key==="Enter"){ onAddAccount(newName); setNewName(""); setAdding(false); } if(e.key==="Escape"){ setNewName(""); setAdding(false); } }}
                  style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:8, padding:"6px 10px", color:C.ink, fontSize:12.5, outline:"none", width:170 }}/>
                <button onClick={()=>{ onAddAccount(newName); setNewName(""); setAdding(false); }} style={{ background:C.up, border:"none", borderRadius:8, padding:"6px 11px", color:"#06080d", cursor:"pointer", fontSize:12, fontWeight:700 }}>Add</button>
                <button onClick={()=>{ setNewName(""); setAdding(false); }} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:8, padding:"6px 9px", color:C.sub, cursor:"pointer", fontSize:12 }}>Cancel</button>
              </div>
            ) : (
              <button onClick={()=>setAdding(true)} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"7px 12px", color:C.cold, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12.5, fontWeight:600 }}><FolderPlus size={14}/> Add Account</button>
            )}
          </div>

          {active.length===0 && errored.length===0 ? (
            <div style={{ padding:"20px 16px", fontSize:12, color:C.faint, textAlign:"center", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, marginBottom:16 }}>All positions expired — see the envelope below.</div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd}>
              <SortableContext items={[`acct:${UNASSIGNED}`, ...accounts.map(acc=>`acct:${acc.id}`)]} strategy={verticalListSortingStrategy}>
                <AccountFolder dropId={UNASSIGNED} name="Unassigned" color={C.faint}
                  items={groups[UNASSIGNED]} collapsed={!!accountCollapsed[UNASSIGNED]}
                  onToggle={onToggleAccountCollapse} rowProps={rowProps}
                  cash={cash} margin={margin} marginRate={marginRate} onSetFunds={onSetFunds}/>
                {accounts.map(acc => (
                  <AccountFolder key={acc.id} dropId={acc.id} name={acc.name} color={acc.color}
                    items={groups[acc.id] || []} collapsed={!!accountCollapsed[acc.id]}
                    onToggle={onToggleAccountCollapse} onRename={onRenameAccount} onDelete={onDeleteAccount}
                    rowProps={rowProps}
                    cash={acc.cash} margin={acc.margin} marginRate={acc.marginRate} onSetFunds={onSetFunds}/>
                ))}
              </SortableContext>
              <DragOverlay dropAnimation={{ duration:180 }}>
                {activeDrag?.type==="account" ? (
                  <div style={{ background:C.panel, border:`1px solid ${activeDrag.color||C.cold}`, borderRadius:10, padding:"12px 16px", boxShadow:"0 10px 30px rgba(0,0,0,0.35)", display:"flex", alignItems:"center", gap:10 }}>
                    <GripVertical size={14} color={activeDrag.color||C.cold}/>
                    <span style={{ width:10, height:10, borderRadius:"50%", background:activeDrag.color||C.cold }}/>
                    <span style={{ fontSize:13, fontWeight:700, color:C.ink }}>{activeDrag.name}</span>
                  </div>
                ) : activeDrag ? (
                  <div style={{ background:C.panel, border:`1px solid ${C.cold}`, borderRadius:10, padding:"10px 14px", boxShadow:"0 10px 30px rgba(0,0,0,0.35)", display:"flex", alignItems:"center", gap:10, fontFamily:C.mono }}>
                    <GripVertical size={14} color={C.cold}/>
                    <span style={{ fontSize:12.5, fontWeight:700, color:C.ink }}>{(activeDrag.type==="CALL"||activeDrag.type==="PUT") ? `${displaySym(activeDrag.ticker)} $${activeDrag.strike}${(activeDrag.type||"")[0]}` : displaySym(activeDrag.ticker)}</span>
                    <span style={{ fontSize:12, color:(activeDrag.pnl||0)>=0?C.up:C.down }}>{(activeDrag.pnl||0)>=0?"+":""}{(activeDrag.pnl||0).toLocaleString(undefined,{maximumFractionDigits:0})}</span>
                  </div>
                ) : null}
              </DragOverlay>
            </DndContext>
          )}

          {/* Errored positions (couldn't be valued) */}
          {errored.length>0 && (
            <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, marginBottom:16, overflow:"hidden" }}>
              {errored.map((p)=>(
                <div key={p.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 16px", borderTop:`1px solid ${C.panel2}`, fontFamily:C.mono, fontSize:12, color:C.down }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}><AlertCircle size={12}/> {p.ticker} — couldn't load ({p.error})</div>
                  <button onClick={()=>onRemove(p.id)} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0 }}><Trash2 size={13}/></button>
                </div>
              ))}
            </div>
          )}

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

// ── MARKET PULSE (9-analyst panel) ───────────────────────────────────
const ANALYST_LABELS = {
  nicholas_crown:    "Macro & Market Cycles",
  felix_friends:     "Technical Timing",
  jerry_romine:      "Financial Analysis",
  fin_edu_jeremy:    "Deep Value & Business Quality",
  ticker_symbol_you: "Innovation & Tech",
  stealth_wealth:    "Value & Accounting",
  jeremy_makes_money:"Market Momentum",
  fx_evolution:      "Short Term Setups",
  figuring_out_money:"Near Term",
};

function MarketPulsePanel({ refreshTick=0 }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(()=>{
    setLoading(true);
    fetchYtInsights()
      .then(x=>{ setData(x); setLoading(false); })
      .catch(()=>setLoading(false));
  },[refreshTick]);

  const sentColor = s => s==="bullish" ? C.up : s==="bearish" ? C.down : C.faint;

  const AnalystCard = ({ analyst, rank }) => {
    const hasInsights = analyst.insights?.length > 0;
    return (
      <div style={{ background:C.bg, border:`1px solid ${C.line}`, borderRadius:10, padding:"14px 16px", display:"flex", flexDirection:"column", gap:8, minWidth:0 }}>
        {/* Header */}
        <div style={{ display:"flex", alignItems:"flex-start", gap:8, justifyContent:"space-between" }}>
          <div style={{ minWidth:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
              <span style={{ fontSize:10, fontWeight:800, color:C.faint, fontFamily:C.mono }}>#{rank}</span>
              <span style={{ fontSize:12.5, fontWeight:700, color:C.ink }}>{analyst.name}</span>
            </div>
            <span style={{ fontSize:10, color:C.cold, background:`${C.cold}14`, borderRadius:4, padding:"1px 7px", fontWeight:600, marginTop:3, display:"inline-block" }}>
              {analyst.label || ANALYST_LABELS[analyst.id] || ""}
            </span>
          </div>
        </div>
        {/* Insights */}
        {!hasInsights ? (
          <div style={{ fontSize:11, color:C.faint }}>No insights available</div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {analyst.insights.map((v, i) => (
              <div key={i} style={{ borderTop: i>0 ? `1px solid ${C.line}` : "none", paddingTop: i>0 ? 8 : 0 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:6, marginBottom:4 }}>
                  <a href={v.link} target="_blank" rel="noopener noreferrer"
                    style={{ fontSize:11.5, fontWeight:600, color:C.cold, textDecoration:"none", flex:1, lineHeight:1.35 }}
                    onClick={e=>e.stopPropagation()}>
                    {v.title}
                  </a>
                  <span style={{ fontSize:8.5, fontWeight:700, color:sentColor(v.sentiment), background:`${sentColor(v.sentiment)}18`,
                    borderRadius:3, padding:"1px 5px", flexShrink:0, textTransform:"uppercase", whiteSpace:"nowrap" }}>
                    {v.sentiment}
                  </span>
                </div>
                {Array.isArray(v.points) && v.points.length > 0 ? (
                  <ul style={{ margin:"0 0 4px", paddingLeft:16, display:"flex", flexDirection:"column", gap:3 }}>
                    {v.points.map((p, j) => (
                      <li key={j} style={{ fontSize:11, color:C.sub, lineHeight:1.45 }}>{p}</li>
                    ))}
                  </ul>
                ) : (
                  v.summary && <div style={{ fontSize:11, color:C.sub, lineHeight:1.45, marginBottom:3 }}>{v.summary}</div>
                )}
                {v.takeaway && <div style={{ fontSize:10.5, color:C.ink, background:`${C.line}50`, borderRadius:5, padding:"4px 8px", lineHeight:1.4 }}>→ {v.takeaway}</div>}
                <div style={{ fontSize:9.5, color:C.faint, fontFamily:C.mono, marginTop:4 }}>{v.published}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ marginTop:32 }}>
      {/* Section header */}
      <div style={{ fontSize:15, fontWeight:700, color:C.ink, marginBottom:4 }}>Market Pulse</div>
      <div style={{ fontSize:12, color:C.faint, marginBottom:14 }}>Analyst panel · ranked by trust weight · sourced from YouTube</div>

      {loading ? (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(260px, 1fr))", gap:12 }}>
          {Array.from({length:9}).map((_,i)=>(
            <div key={i} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:10, padding:"14px 16px", minHeight:100, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ color:C.faint, fontSize:11, display:"flex", alignItems:"center", gap:6 }}>
                <Loader2 size={12} style={{ animation:"spin 1s linear infinite" }}/> Loading…
              </div>
            </div>
          ))}
        </div>
      ) : !data?.analysts?.length ? (
        <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:10, padding:"14px 18px", color:C.sub, fontSize:12.5 }}>
          {data?.message || data?.error || "Market Pulse unavailable — check backend logs."}
        </div>
      ) : (
        <>
          {(data?.stale || data?.message) && (
            <div style={{ background:`${C.amber}12`, border:`1px solid ${C.amber}44`, borderRadius:9, padding:"9px 13px", color:C.amber, fontSize:11.5, marginBottom:12, display:"flex", alignItems:"center", gap:7 }}>
              <AlertCircle size={13}/> {data.message || "Insights are over 24h old."} {data.fetched_at && <span style={{ color:C.faint }}>· last updated {new Date(data.fetched_at).toLocaleString()}</span>}
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))", gap:12 }}>
            {data.analysts.map((a, i) => (
              <AnalystCard key={a.id || i} analyst={a} rank={i+1}/>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SectorMap({ watchlist=[], cardCache={}, onOpen }) {
  const [d, setD]             = useState(null);
  const [rotation, setRotation] = useState(null);
  const [mapData, setMapData] = useState(null);
  const [err, setErr]         = useState(null);
  const [warming, setWarming] = useState(false);
  const [updated, setUpdated] = useState(null);
  const [sel, setSel]         = useState(null);
  const [pulseTick, setPulseTick] = useState(0);
  const retryRef = useRef(null);

  const load = useCallback(()=>{
    setErr(null); setD(null); setWarming(false);
    if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
    fetchSectors()
      .then(x=>{ x.error ? setErr(x.error) : setD(x); setUpdated(new Date()); })
      .catch(()=>{
        // Network error = likely cold start. Show "warming up" and retry after 12s.
        setWarming(true);
        retryRef.current = setTimeout(()=>{
          setWarming(false);
          fetchSectors()
            .then(x=>{ x.error ? setErr(x.error) : setD(x); setUpdated(new Date()); })
            .catch(e=>setErr(e.message));
        }, 12000);
      });
    fetchSectorRotation().then(x=>{ if(!x.error) setRotation(x); }).catch(()=>{});
    fetchMapData(watchlist).then(x=>{ if(!x.error) setMapData(x); }).catch(()=>{});
  },[watchlist]);
  useEffect(()=>{ load(); return ()=>{ if(retryRef.current) clearTimeout(retryRef.current); }; },[load]);

  if (warming) return (
    <div style={{ padding:60, textAlign:"center", color:C.sub }}>
      <Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/>
      <div style={{ marginTop:10, fontWeight:600 }}>Waking up backend…</div>
      <div style={{ marginTop:6, fontSize:12, color:C.faint }}>Render free tier cold-starts in ~15s. Retrying automatically.</div>
    </div>
  );
  if (err) return (
    <div style={{ padding:40, textAlign:"center", color:C.down }}>
      Sector map unavailable: {err}
      <br/><button onClick={load} style={{ marginTop:12, padding:"7px 16px", borderRadius:8, border:`1px solid ${C.line}`, background:C.panel, color:C.sub, cursor:"pointer", fontSize:12 }}>Retry</button>
    </div>
  );
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
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:11, color:C.faint, fontFamily:C.mono }}>updated {updated?.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</span>
          <button onClick={load} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"7px 11px", color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12 }}><RefreshCw size={13}/> Refresh Map</button>
        </div>
      </div>

      {/* ── TOP HALF: Visual Market Data ──────────────────────────────── */}

      {/* Earnings Map */}
      <EarningsMapPanel watchlist={watchlist} cardCache={cardCache} onOpen={onOpen}/>

      {/* Macro Events Timeline */}
      <MacroEventsPanel events={mapData?.macro_events}/>

      {/* Options Flow Map */}
      <OptionsFlowPanel flow={mapData?.options_flow}/>

      {/* ── Sector Heatmap ────────────────────────────────────────────── */}
      <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:10, marginTop:4 }}>Sector Heatmap</div>
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

      {/* ── BOTTOM HALF: Market Pulse Analyst Panel ───────────────────── */}
      <div style={{ borderTop:`2px solid ${C.line}`, marginTop:28, paddingTop:8 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:2 }}>
          <div/>
          <button onClick={()=>setPulseTick(t=>t+1)}
            style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"6px 11px",
              color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12 }}>
            <RefreshCw size={13}/> Refresh Market Pulse
          </button>
        </div>
        <MarketPulsePanel refreshTick={pulseTick}/>
      </div>
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
    label: "Goals",
    multi: true,
    options: [
      { value:"growth",      label:"Growth",      desc:"Maximize portfolio value long term" },
      { value:"income",      label:"Income",      desc:"Generate consistent returns" },
      { value:"speculation", label:"Speculation", desc:"Find big asymmetric opportunities" },
      { value:"hedging",     label:"Hedging",     desc:"Protect existing positions" },
    ]
  },
  style: {
    label: "Trading Style",
    multi: true,
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
  const defaults = { riskTolerance:"moderate", goal:["growth"], style:["swing"], level:"intermediate" };
  // Goals/style are multi-select (arrays); older saved profiles stored strings — normalize.
  const norm = (p) => ({ ...defaults, ...p,
    goal:  Array.isArray(p?.goal)  ? p.goal  : (p?.goal  ? [p.goal]  : defaults.goal),
    style: Array.isArray(p?.style) ? p.style : (p?.style ? [p.style] : defaults.style) });
  const [draft, setDraft] = useState(norm(profile));
  const set = (k, v, multi) => setDraft(d => {
    if (!multi) return { ...d, [k]: v };
    const cur = Array.isArray(d[k]) ? d[k] : [d[k]];
    const next = cur.includes(v) ? cur.filter(x=>x!==v) : [...cur, v];
    return { ...d, [k]: next.length ? next : cur };   // keep at least one selected
  });

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
            <div style={{ fontSize:10.5, color:C.sub, letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:10 }}>
              {section.label}{section.multi && <span style={{ color:C.faint, textTransform:"none", letterSpacing:0 }}> · pick all that apply</span>}
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
              {section.options.map(opt=>{
                const sel = section.multi
                  ? (Array.isArray(draft[key]) ? draft[key] : [draft[key]]).includes(opt.value)
                  : draft[key] === opt.value;
                return (
                  <div key={opt.value} onClick={()=>set(key, opt.value, section.multi)}
                    style={{ background:sel?`${C.cold}18`:C.panel, border:`1.5px solid ${sel?C.cold:C.line}`, borderRadius:10, padding:"10px 13px", cursor:"pointer", transition:"all .15s", position:"relative" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      {section.multi && (
                        <span style={{ width:14, height:14, borderRadius:4, border:`1.5px solid ${sel?C.cold:C.line}`, background:sel?C.cold:"transparent", display:"inline-flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                          {sel && <Check size={10} color="#fff"/>}
                        </span>
                      )}
                      <span style={{ fontSize:12.5, fontWeight:700, color:sel?C.cold:C.ink }}>{opt.label}</span>
                    </div>
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
  const [dropPos, setDropPos] = useState({ top: 0, right: 14 });
  const btnRef = useRef(null);
  const email = userEmail;
  const handleToggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setDropPos({ top: r.bottom + 8, right: Math.max(14, window.innerWidth - r.right) });
    }
    setOpen(o => !o);
  };
  return (
    <div style={{ position:"relative", flexShrink:0 }}>
      <button ref={btnRef} onClick={handleToggle} title="Settings" style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 9px", color:open?C.ink:C.sub, cursor:"pointer", display:"flex" }}><Settings size={15}/></button>
      {open && (
        <>
          <div onClick={()=>setOpen(false)} style={{ position:"fixed", inset:0, zIndex:40 }}/>
          <div style={{ position:"fixed", top:dropPos.top, right:dropPos.right, width:240, maxWidth:"calc(100vw - 28px)", maxHeight:"calc(100dvh - 120px)", overflowY:"auto", background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, boxShadow:"0 14px 44px rgba(0,0,0,0.4)", zIndex:50, padding:"12px 14px" }}>
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

// ── FINANCIALS PAGE (fundamentals · valuation · compare · fair value · screener) ──
const fmtMoney = (v) => {
  if (v==null || isNaN(v)) return "—";
  const a=Math.abs(v), s=v<0?"-":"";
  if (a>=1e12) return `${s}$${(a/1e12).toFixed(2)}T`;
  if (a>=1e9)  return `${s}$${(a/1e9).toFixed(1)}B`;
  if (a>=1e6)  return `${s}$${(a/1e6).toFixed(1)}M`;
  return `${s}$${a.toFixed(0)}`;
};
const fmtPct = (v,d=1) => (v==null||isNaN(v)) ? "—" : `${(v*100).toFixed(d)}%`;
const fmtX   = (v) => (v==null||isNaN(v)) ? "—" : `${v.toFixed(1)}x`;
const valColorOf = (verd) => verd==="cheap"?C.up:verd==="expensive"?C.down:verd==="fair"?C.amber:C.faint;
const SECTORS = ["Technology","Communication Services","Consumer Cyclical","Consumer Defensive","Healthcare",
  "Financial Services","Industrials","Energy","Utilities","Real Estate","Basic Materials"];

// One fundamentals metric as a mini bar chart (per-year bars + YoY change badge),
// so you see the trajectory and its magnitude — not just a squiggle.
function TrendStat({ label, series, fmt, invert=false, years=[] }) {
  const [hov, setHov] = useState(null);
  const clean = (series||[]).map((v,i)=>({ v, y: years[i] })).filter(x=>x.v!=null && !isNaN(x.v));
  const latest = clean.length ? clean[clean.length-1].v : null;
  const prev   = clean.length > 1 ? clean[clean.length-2].v : null;
  const yoy    = (latest!=null && prev!=null && prev!==0) ? (latest/prev - 1) : null;
  const goodYoY = yoy==null ? null : (invert ? yoy<=0 : yoy>=0);
  const yoyCol = goodYoY==null ? C.faint : goodYoY ? C.up : C.down;
  const maxAbs = Math.max(...clean.map(x=>Math.abs(x.v)), 1e-12);
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:11, padding:"12px 13px", minWidth:0 }}>
      <div style={{ fontSize:9.5, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase", marginBottom:4 }}>{label}</div>
      <div style={{ display:"flex", alignItems:"baseline", gap:7, flexWrap:"wrap" }}>
        <span style={{ fontFamily:C.mono, fontSize:17, fontWeight:700, color:C.ink }}>{fmt(hov!=null ? clean[hov].v : latest)}</span>
        {hov==null && yoy!=null && (
          <span style={{ fontFamily:C.mono, fontSize:10.5, fontWeight:800, color:yoyCol }}>{yoy>=0?"+":""}{(yoy*100).toFixed(0)}% YoY</span>
        )}
        {hov!=null && clean[hov].y && <span style={{ fontFamily:C.mono, fontSize:10.5, color:C.faint }}>{clean[hov].y}</span>}
      </div>
      {clean.length>1 && (
        <div style={{ display:"flex", alignItems:"flex-end", gap:3, height:30, marginTop:7 }} onMouseLeave={()=>setHov(null)}>
          {clean.map((x,i)=>(
            <div key={i} onMouseEnter={()=>setHov(i)} title={`${x.y||""} ${fmt(x.v)}`}
              style={{ flex:1, minWidth:0, height:Math.max(3, Math.abs(x.v)/maxAbs*30),
                background: x.v<0 ? C.down : C.cold, opacity: i===clean.length-1 ? 1 : 0.55,
                borderRadius:"2px 2px 0 0", outline: i===clean.length-1 ? `1px solid ${C.ink}` : "none", cursor:"default" }}/>
          ))}
        </div>
      )}
    </div>
  );
}

function ValuationRow({ label, m }) {
  if (!m) return null;
  const secCol = valColorOf(m.vs_sector?.verdict);
  const ownCol = valColorOf(m.vs_own?.verdict);
  return (
    <div style={{ display:"grid", gridTemplateColumns:"minmax(96px,1.4fr) minmax(60px,1fr) minmax(90px,1.3fr) minmax(90px,1.3fr)", gap:8, alignItems:"center", padding:"9px 0", borderTop:`1px solid ${C.panel2}` }}>
      <div style={{ fontSize:12, color:C.sub, fontWeight:600 }}>{label}</div>
      <div style={{ fontFamily:C.mono, fontSize:13, fontWeight:700, color:C.ink, textAlign:"right" }}>{fmtX(m.value)}</div>
      <div style={{ textAlign:"right" }}>
        {m.vs_sector ? (
          <span style={{ fontFamily:C.mono, fontSize:10.5, fontWeight:700, color:secCol, background:`${secCol}14`, padding:"2px 7px", borderRadius:5 }}>
            {m.vs_sector.verdict} · sec {fmtX(m.sector)}
          </span>
        ) : <span style={{ fontSize:10.5, color:C.faint }}>sec {fmtX(m.sector)}</span>}
      </div>
      <div style={{ textAlign:"right" }}>
        {m.vs_own ? (
          <span style={{ fontFamily:C.mono, fontSize:10.5, fontWeight:700, color:ownCol, background:`${ownCol}14`, padding:"2px 7px", borderRadius:5 }}>
            {m.vs_own.verdict} · 5yr {fmtX(m.own_avg)}
          </span>
        ) : <span style={{ fontSize:10, color:C.faint }}>—</span>}
      </div>
    </div>
  );
}

// Editable long-term fair-value model → bull / base / bear vs current price.
function FairValueModel({ inp }) {
  const seedG  = Math.max(-5, Math.min(40, Math.round((inp?.revenueGrowth ?? 0.10)*100)));
  const seedM  = Math.max(1, Math.min(60, Math.round((inp?.netMargin ?? 0.15)*100)));
  const seedPE = Math.max(5, Math.min(60, Math.round(inp?.exitPE ?? 20)));
  const [g, setG]   = useState(seedG);
  const [m, setM]   = useState(seedM);
  const [pe, setPe] = useState(seedPE);
  useEffect(()=>{ setG(seedG); setM(seedM); setPe(seedPE); /* reseed on ticker change */ // eslint-disable-next-line
  },[inp]);
  const project = (gg, mm, pp) => {
    const rev = inp?.revenue, sh = inp?.shares, spot = inp?.spot;
    if (!rev || !sh) return null;
    const rev5 = rev*Math.pow(1+gg/100, 5);
    const eps5 = (rev5*(mm/100))/sh;
    const future = eps5*pp;
    const fair = future/Math.pow(1.10, 5);   // 10% required return, discounted 5y
    return { fair, upside: spot ? (fair/spot-1)*100 : null };
  };
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const scenarios = [
    { key:"bear", label:"Bear", col:C.down,  r:project(clamp(g*0.6,-10,60), clamp(m*0.9,1,60), clamp(pe*0.85,5,60)) },
    { key:"base", label:"Base", col:C.cold,  r:project(g, m, pe) },
    { key:"bull", label:"Bull", col:C.up,    r:project(clamp(g*1.25,-10,80), clamp(m*1.1,1,70), clamp(pe*1.15,5,70)) },
  ];
  const spot = inp?.spot;
  const inputBox = { width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:7, padding:"6px 8px", color:C.ink, fontSize:12.5, fontFamily:C.mono, outline:"none" };
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4, flexWrap:"wrap", gap:6 }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.ink }}>Fair Value Estimate</div>
        <div style={{ fontSize:11, color:C.faint }}>current ${spot?.toFixed?.(2) ?? "—"} · 5yr model, 10% discount</div>
      </div>
      <div style={{ fontSize:11, color:C.faint, marginBottom:12 }}>Editable base assumptions — bull/bear scale off these.</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(120px,1fr))", gap:10, marginBottom:16 }}>
        <div><div style={{ fontSize:9.5, color:C.faint, marginBottom:3 }}>REV GROWTH % / YR</div><input type="number" value={g} onChange={e=>setG(parseFloat(e.target.value)||0)} style={inputBox}/></div>
        <div><div style={{ fontSize:9.5, color:C.faint, marginBottom:3 }}>NET MARGIN %</div><input type="number" value={m} onChange={e=>setM(parseFloat(e.target.value)||0)} style={inputBox}/></div>
        <div><div style={{ fontSize:9.5, color:C.faint, marginBottom:3 }}>EXIT P/E</div><input type="number" value={pe} onChange={e=>setPe(parseFloat(e.target.value)||0)} style={inputBox}/></div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(120px,1fr))", gap:10 }}>
        {scenarios.map(s=>(
          <div key={s.key} style={{ background:C.panel2, border:`1px solid ${C.line}`, borderRadius:11, padding:"13px 14px", textAlign:"center" }}>
            <div style={{ fontSize:10, color:s.col, fontWeight:700, letterSpacing:"0.06em", textTransform:"uppercase" }}>{s.label}</div>
            <div style={{ fontFamily:C.mono, fontSize:20, fontWeight:700, color:C.ink, marginTop:5 }}>{s.r?.fair!=null?`$${s.r.fair.toFixed(0)}`:"—"}</div>
            {s.r?.upside!=null && (
              <div style={{ fontFamily:C.mono, fontSize:12, fontWeight:700, color:s.r.upside>=0?C.up:C.down, marginTop:3 }}>
                {s.r.upside>=0?"+":""}{s.r.upside.toFixed(0)}%
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const CMP_ROWS = [
  {k:"price", label:"Price",        get:d=>d.spot,                         fmt:v=>v==null?"—":`$${v.toFixed(2)}`, best:null},
  {k:"mcap",  label:"Market Cap",   get:d=>d.marketCap,                    fmt:fmtMoney, best:null},
  {k:"tpe",   label:"TTM P/E",      get:d=>d.valuation?.trailingPE?.value, fmt:fmtX, best:"low",  typical:"20–28x"},
  {k:"fpe",   label:"Forward P/E",  get:d=>d.valuation?.forwardPE?.value,  fmt:fmtX, best:"low",  typical:"18–26x"},
  {k:"fpe2",  label:"2yr Fwd P/E",  get:d=>d.advanced?.fwd2PE,             fmt:fmtX, best:"low",  typical:"16–24x"},
  {k:"peg",   label:"PEG",          get:d=>d.valuation?.peg?.value,        fmt:v=>v==null?"—":v.toFixed(2), best:"low", typical:"1.5–2.5"},
  {k:"ps",    label:"TTM P/S",      get:d=>d.valuation?.ps?.value,         fmt:fmtX, best:"low",  typical:"1.8–2.6x"},
  {k:"ev",    label:"EV/EBITDA",    get:d=>d.valuation?.evEbitda?.value,   fmt:fmtX, best:"low",  typical:"10–16x"},
  {k:"epsgt", label:"TTM EPS Growth",     get:d=>d.advanced?.epsGrowthTTM,    fmt:fmtPct, best:"high", typical:"8–12%"},
  {k:"epsgn", label:"Next-Yr EPS G. est", get:d=>d.advanced?.epsGrowthNextYr, fmt:fmtPct, best:"high", typical:"8–12%"},
  {k:"revg",  label:"TTM Rev Growth",     get:d=>d.ttm?.revenueGrowth,        fmt:fmtPct, best:"high", typical:"4.5–6.5%"},
  {k:"revgn", label:"Next-Yr Rev G. est", get:d=>d.advanced?.revGrowthNextYr, fmt:fmtPct, best:"high", typical:"4.5–6.5%"},
  {k:"gm",    label:"Gross Margin", get:d=>d.health?.grossMargin,          fmt:fmtPct, best:"high", typical:"40–48%"},
  {k:"nm",    label:"Net Margin",   get:d=>d.health?.netMargin,            fmt:fmtPct, best:"high", typical:"8–10%"},
  {k:"roe",   label:"ROE",          get:d=>d.health?.roe,                  fmt:fmtPct, best:"high", typical:"12–18%"},
  {k:"de",    label:"Debt / Equity",get:d=>d.health?.debtToEquity,         fmt:v=>v==null?"—":v.toFixed(0), best:"low", typical:"<100"},
  {k:"fcf",   label:"Free Cash Flow",get:d=>d.health?.fcf,                 fmt:fmtMoney, best:"high"},
];

function CompareTable({ items, onRemove, onOpen }) {
  // items: [{ticker, data|null, loading}]
  const bestForRow = (row) => {
    if (!row.best) return null;
    const vals = items.map(it => it.data ? row.get(it.data) : null).filter(v=>v!=null && !isNaN(v) && (row.best!=="low" || v>0));
    if (!vals.length) return null;
    return row.best==="low" ? Math.min(...vals) : Math.max(...vals);
  };
  const gridCols = `minmax(110px,1.3fr) repeat(${items.length}, minmax(110px,1fr)) minmax(104px,1fr)`;
  return (
    <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch", border:`1px solid ${C.line}`, borderRadius:14, background:C.panel }}>
      <div style={{ minWidth: 230 + items.length*130 }}>
        {/* header */}
        <div style={{ display:"grid", gridTemplateColumns:gridCols, borderBottom:`1px solid ${C.line}` }}>
          <div style={{ padding:"12px 14px", fontSize:10, color:C.faint, letterSpacing:"0.05em", textTransform:"uppercase" }}>Metric</div>
          {items.map(it=>(
            <div key={it.ticker} style={{ padding:"10px 12px", textAlign:"right" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"flex-end", gap:6 }}>
                <span onClick={()=>onOpen(it.ticker)} style={{ fontWeight:800, fontSize:13, color:C.ink, cursor:"pointer" }}>{displaySym(it.ticker)}</span>
                <button onClick={()=>onRemove(it.ticker)} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", padding:0, display:"flex" }}><X size={13}/></button>
              </div>
              {it.loading && <Loader2 size={11} style={{ animation:"spin 1s linear infinite", color:C.faint, marginTop:2 }}/>}
              {it.data && <div style={{ fontSize:9, color:C.faint, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:110 }}>{it.data.sector}</div>}
            </div>
          ))}
          <div style={{ padding:"12px 12px", fontSize:9.5, color:C.faint, letterSpacing:"0.04em", textTransform:"uppercase", textAlign:"right" }}>Many stocks<br/>trade at</div>
        </div>
        {/* rows */}
        {CMP_ROWS.map(row=>{
          const best = bestForRow(row);
          return (
            <div key={row.k} style={{ display:"grid", gridTemplateColumns:gridCols, borderTop:`1px solid ${C.panel2}` }}>
              <div style={{ padding:"10px 14px", fontSize:11.5, color:C.sub, fontWeight:600 }}>{row.label}</div>
              {items.map(it=>{
                const v = it.data ? row.get(it.data) : null;
                const isBest = best!=null && v!=null && Math.abs(v-best)<1e-9;
                return (
                  <div key={it.ticker} style={{ padding:"10px 12px", textAlign:"right", fontFamily:C.mono, fontSize:12,
                    color:isBest?C.up:C.ink, fontWeight:isBest?800:500, background:isBest?`${C.up}12`:"transparent" }}>
                    {it.data ? row.fmt(v) : (it.loading?"…":"—")}
                  </div>
                );
              })}
              <div style={{ padding:"10px 12px", textAlign:"right", fontFamily:C.mono, fontSize:10.5, color:C.faint }}>{row.typical || "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── 1000X-STYLE FINANCIALS SUITE ──────────────────────────────────────
// Reference ranges: what "many stocks trade at" — the yardstick column.
const ADV_METRICS = [
  { label:"TTM P/E",                get:f=>f.valuation?.trailingPE?.value, fmt:fmtX,   lo:20,    hi:28,    better:"low"  },
  { label:"Forward P/E",            get:f=>f.valuation?.forwardPE?.value,  fmt:fmtX,   lo:18,    hi:26,    better:"low"  },
  { label:"2yr Forward P/E",        get:f=>f.advanced?.fwd2PE,             fmt:fmtX,   lo:16,    hi:24,    better:"low"  },
  { label:"TTM EPS Growth",         get:f=>f.advanced?.epsGrowthTTM,       fmt:fmtPct, lo:0.08,  hi:0.12,  better:"high" },
  { label:"Curr-Yr EPS Growth est", get:f=>f.advanced?.epsGrowthCurrYr,    fmt:fmtPct, lo:0.08,  hi:0.12,  better:"high" },
  { label:"Next-Yr EPS Growth est", get:f=>f.advanced?.epsGrowthNextYr,    fmt:fmtPct, lo:0.08,  hi:0.12,  better:"high" },
  { label:"TTM Rev Growth",         get:f=>f.advanced?.revGrowthTTM,       fmt:fmtPct, lo:0.045, hi:0.065, better:"high" },
  { label:"Curr-Yr Rev Growth est", get:f=>f.advanced?.revGrowthCurrYr,    fmt:fmtPct, lo:0.045, hi:0.065, better:"high" },
  { label:"Next-Yr Rev Growth est", get:f=>f.advanced?.revGrowthNextYr,    fmt:fmtPct, lo:0.045, hi:0.065, better:"high" },
  { label:"Gross Margin",           get:f=>f.health?.grossMargin,          fmt:fmtPct, lo:0.40,  hi:0.48,  better:"high" },
  { label:"Net Margin",             get:f=>f.health?.netMargin,            fmt:fmtPct, lo:0.08,  hi:0.10,  better:"high" },
  { label:"TTM P/S",                get:f=>f.valuation?.ps?.value,         fmt:fmtX,   lo:1.8,   hi:2.6,   better:"low"  },
];
const typicalTxt = (m) => m.fmt===fmtPct ? `${(m.lo*100).toString().replace(/\.0$/,"")}–${(m.hi*100).toString().replace(/\.0$/,"")}%` : `${m.lo}–${m.hi}x`;
const typicalColor = (v, m) => v==null ? C.faint
  : m.better==="low"  ? (v < m.lo ? C.up : v > m.hi ? C.down : C.amber)
  :                     (v > m.hi ? C.up : v < m.lo ? C.down : C.amber);

function AdvancedMetrics({ fund }) {
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
      <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginBottom:2 }}>Metrics vs the Market</div>
      <div style={{ fontSize:11, color:C.faint, marginBottom:8 }}>Green = better than the typical stock · Amber = in the typical band · Red = worse</div>
      {ADV_METRICS.map((m,i)=>{
        const v = m.get(fund);
        return (
          <div key={i} style={{ display:"grid", gridTemplateColumns:"minmax(150px,1.7fr) minmax(70px,1fr) minmax(120px,1.3fr)", gap:8, alignItems:"center", padding:"8px 0", borderTop: i?`1px solid ${C.panel2}`:"none" }}>
            <div style={{ fontSize:12, color:C.sub, fontWeight:600 }}>{m.label}</div>
            <div style={{ fontFamily:C.mono, fontSize:13, fontWeight:800, textAlign:"right", color:typicalColor(v, m) }}>{m.fmt(v)}</div>
            <div style={{ fontSize:10.5, color:C.faint, textAlign:"right", fontFamily:C.mono }}>many stocks: {typicalTxt(m)}</div>
          </div>
        );
      })}
    </div>
  );
}

// Bar chart with solid actual bars + stacked low/avg/high analyst-estimate bars.
function FinBarChart({ title, unit="money", past=[], est=[], note }) {
  const [hov, setHov] = useState(null);
  const fmtV = v => v==null ? "—" : unit==="money" ? fmtMoney(v) : unit==="pct" ? fmtPct(v) : `$${Number(v).toFixed(2)}`;
  const all = [...past.map(p=>Math.abs(p.value||0)), ...est.map(e=>Math.abs(e.high ?? e.avg ?? 0))];
  if (!all.length) return null;
  const maxV = Math.max(...all) || 1;
  const H = 140;
  const hOf = v => Math.max(2, Math.abs(v||0)/maxV * H);
  const cells = [...past.map(p=>({ ...p, kind:"a" })), ...est.map(e=>({ ...e, kind:"e" }))];
  const hovTxt = hov==null ? null : cells[hov].kind==="a"
    ? `${cells[hov].label}: ${fmtV(cells[hov].value)}`
    : `${cells[hov].label}: avg ${fmtV(cells[hov].avg)} (${fmtV(cells[hov].low)}–${fmtV(cells[hov].high)})`;
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"13px 15px", minWidth:0 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", gap:8, marginBottom:8, flexWrap:"wrap" }}>
        <span style={{ fontSize:12.5, fontWeight:700, color:C.ink }}>{title}{note && <span style={{ fontSize:9.5, color:C.faint, fontWeight:400 }}> {note}</span>}</span>
        <span style={{ fontFamily:C.mono, fontSize:11, color:C.sub, minHeight:14 }}>{hovTxt || ""}</span>
      </div>
      <div style={{ display:"flex", alignItems:"flex-end", gap:2, height:H + 14 }}>
        {cells.map((c,i)=>{
          const showLbl = cells.length <= 9;
          const lblTxt = c.kind==="a" ? fmtV(c.value) : fmtV(c.avg);
          const lbl = showLbl && (
            <div style={{ fontSize:8, fontFamily:C.mono, color:c.kind==="e"?C.amber:C.sub, textAlign:"center", whiteSpace:"nowrap", overflow:"hidden", marginBottom:2 }}>{lblTxt}</div>
          );
          return c.kind==="a" ? (
            <div key={i} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)} title={`${c.label}: ${fmtV(c.value)}`}
              style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", justifyContent:"flex-end", height:"100%", cursor:"default" }}>
              {lbl}
              <div style={{ height:hOf(c.value), background:(c.value||0)<0?C.down:C.cold, opacity:hov===i?1:0.82,
                borderRadius:"3px 3px 0 0", outline: i===past.length-1 ? `1.5px solid ${C.ink}` : "none" }}/>
            </div>
          ) : (
            <div key={i} onMouseEnter={()=>setHov(i)} onMouseLeave={()=>setHov(null)} title={`${c.label} analyst est: avg ${fmtV(c.avg)} (low ${fmtV(c.low)} · high ${fmtV(c.high)})`}
              style={{ flex:1, minWidth:0, display:"flex", flexDirection:"column", justifyContent:"flex-end", height:"100%", opacity:hov===i?1:0.85, cursor:"default" }}>
              {lbl}
              <div style={{ height:Math.max(1, hOf(c.high ?? c.avg)-hOf(c.avg)), background:C.up, borderRadius:"3px 3px 0 0" }}/>
              <div style={{ height:Math.max(1, hOf(c.avg)-hOf(c.low ?? c.avg)), background:C.amber }}/>
              <div style={{ height:hOf(c.low ?? c.avg), background:`${C.down}cc` }}/>
            </div>
          );
        })}
      </div>
      <div style={{ display:"flex", gap:2, marginTop:4 }}>
        {cells.map((c,i)=>(<div key={i} style={{ flex:1, minWidth:0, fontSize:8, color:c.kind==="e"?C.amber:C.faint, textAlign:"center", whiteSpace:"nowrap", overflow:"hidden", fontFamily:C.mono }}>{c.label}</div>))}
      </div>
      {est.length>0 && (
        <div style={{ fontSize:9, color:C.faint, marginTop:6 }}>
          forward bars = analyst estimates: <span style={{ color:C.down }}>low</span> · <span style={{ color:C.amber }}>avg</span> · <span style={{ color:C.up }}>high</span>
        </div>
      )}
    </div>
  );
}

function FinancialsCharts({ ticker }) {
  const [d, setD]     = useState(null);
  const [err, setErr] = useState(null);
  const [mode, setMode] = useState("quarterly");
  useEffect(()=>{
    let alive = true; setD(null); setErr(null);
    fetchFinancialsDetail(ticker).then(x=>{ if(alive){ x.error?setErr(x.error):setD(x); } }).catch(e=>alive&&setErr(e.message));
    return ()=>{ alive=false; };
  },[ticker]);
  if (err) return <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}33`, borderRadius:10, padding:"14px 16px", color:C.down, fontSize:12.5 }}>Couldn't load statements for {ticker}: {err}</div>;
  if (!d)  return <div style={{ padding:40, textAlign:"center", color:C.sub }}><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:8, fontSize:12 }}>Loading statements…</div></div>;
  const src = d[mode] || {};
  const em = d.estimates || {}; const revE = em.revenue || {}, epsE = em.eps || {};
  const periods = mode==="quarterly" ? [["0q","EstQ"],["+1q","EstQ+1"]] : [["0y","Est FY"],["+1y","Est FY+1"]];
  const estRev = [], estEPS = [], estNI = [];
  periods.forEach(([k,lbl])=>{
    if (revE[k]?.avg != null) estRev.push({ label:lbl, ...revE[k] });
    if (epsE[k]?.avg != null) {
      estEPS.push({ label:lbl, ...epsE[k] });
      if (d.shares) estNI.push({ label:lbl, low:(epsE[k].low??epsE[k].avg)*d.shares, avg:epsE[k].avg*d.shares, high:(epsE[k].high??epsE[k].avg)*d.shares });
    }
  });
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12, flexWrap:"wrap", gap:8 }}>
        <div style={{ display:"flex", gap:2, background:C.panel, borderRadius:9, padding:3, border:`1px solid ${C.line}` }}>
          {[["quarterly","Quarterly"],["annual","Annual"]].map(([id,lab])=>(
            <button key={id} onClick={()=>setMode(id)} style={{ padding:"6px 13px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:600, background:mode===id?C.line:"transparent", color:mode===id?C.ink:C.sub }}>{lab}</button>
          ))}
        </div>
        {d.next_earnings && <span style={{ fontSize:11, color:C.violet, fontFamily:C.mono, background:`${C.violet}14`, borderRadius:6, padding:"4px 10px" }}>next earnings {String(d.next_earnings).slice(0,10)}</span>}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(290px, 1fr))", gap:12 }}>
        <FinBarChart title="Revenue"        past={src.revenue}     est={estRev}/>
        <FinBarChart title="Net Income"     past={src.netIncome}   est={estNI} note="(est = EPS est × shares)"/>
        <FinBarChart title="Free Cash Flow" past={src.fcf}/>
        <FinBarChart title="Diluted EPS"    unit="eps" past={src.eps} est={estEPS}/>
        <FinBarChart title="Gross Margin"   unit="pct" past={src.grossMargin}/>
      </div>
      <div style={{ fontSize:10, color:C.faint, marginTop:10 }}>History depth is what Yahoo provides free (~5-6 quarters, 4-5 years). Latest reported bar is outlined.</div>
    </div>
  );
}

// Year-by-year projection model: edit growth, margin and exit-P/E per year →
// implied share price (low/high) and CAGR from today. Persists per ticker.
// 1000X-style projection model. Inputs (blue): REV GROWTH, NET INC. GROWTH, and
// P/E LOW/HIGH per year. Everything else derives: revenue, net income, margins,
// EPS, share-price low/high, and the CAGR you'd earn reaching each price.
function ProjectionsTable({ fund }) {
  const T = fund?.ticker;
  const spot = fund?.spot, shares = fund?.fairValueInputs?.shares, rev0 = fund?.fairValueInputs?.revenue;
  const KEY = `alphadesk:proj2:${T}`;
  const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  const nm0 = fund?.fairValueInputs?.netMargin ?? 0.15;
  const ni0 = rev0 != null ? rev0 * nm0 : null;
  const seed = () => {
    const g1  = clamp(Math.round(((fund?.advanced?.revGrowthNextYr ?? fund?.ttm?.revenueGrowth ?? 0.10))*100), -20, 100);
    const ng1 = clamp(Math.round(((fund?.advanced?.epsGrowthNextYr ?? fund?.ttm?.earningsGrowth ?? (g1/100)))*100), -20, 120);
    const fpe = fund?.valuation?.forwardPE?.value || fund?.valuation?.trailingPE?.value || 25;
    return {
      g:   [g1, Math.round(g1*0.85), Math.round(g1*0.72), Math.round(g1*0.6)].map(x=>Math.max(x,2)),
      ng:  [ng1, Math.round(ng1*0.85), Math.round(ng1*0.72), Math.round(ng1*0.6)].map(x=>Math.max(x,2)),
      peLo:[1,1,1,1].map(()=>clamp(Math.round(fpe*0.65),5,80)),
      peHi:[1,1,1,1].map(()=>clamp(Math.round(fpe*1.05),8,120)),
    };
  };
  const [p, setP] = useState(null);
  useEffect(()=>{ if(!T) return; try { const s = JSON.parse(localStorage.getItem(KEY)||"null"); setP(s?.ng ? s : seed()); } catch { setP(seed()); }
  // eslint-disable-next-line
  },[T, fund]);
  useEffect(()=>{ if (p && T) try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {} },[p, T]);
  if (!fund) return null;
  if (!spot || !shares || !rev0) return <div style={{ padding:30, textAlign:"center", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>Not enough data to project {T} (needs price, shares and revenue).</div>;
  if (!p) return null;
  const y0 = new Date().getFullYear();
  // derive the 4 future years: revenue and net income compound off the inputs
  const yrs = [];
  let rev = rev0, ni = ni0;
  for (let i = 0; i < 4; i++) {
    rev = rev * (1 + (p.g[i]||0)/100);
    ni  = ni  * (1 + (p.ng[i]||0)/100);
    const margin = rev ? ni / rev : null;
    const eps = ni / shares;
    const lo  = eps * (p.peLo[i]||0), hiP = eps * (p.peHi[i]||0);
    const n = i + 1;
    yrs.push({ year:y0+n, rev, ni, margin, eps, lo, hi:hiP,
      cagrLo: (lo>0 && spot>0) ? Math.pow(lo/spot, 1/n)-1 : null,
      cagrHi: (hiP>0 && spot>0) ? Math.pow(hiP/spot, 1/n)-1 : null });
  }
  const setCell = (key, i, v) => setP(prev => ({ ...prev, [key]: prev[key].map((x,j)=>j===i? v : x) }));
  const inp = (key, i) => (
    <input type="number" value={p[key][i]} onChange={e=>setCell(key, i, parseFloat(e.target.value)||0)}
      style={{ width:"100%", background:C.panel2, border:`1px solid ${C.cold}55`, borderRadius:6, padding:"4px 6px", color:C.cold, fontSize:11.5, fontFamily:C.mono, outline:"none", textAlign:"right", fontWeight:700 }}/>
  );
  const cell = { padding:"7px 10px", textAlign:"right", fontFamily:C.mono, fontSize:11.5, color:C.ink, whiteSpace:"nowrap" };
  const lblCell = { padding:"7px 10px", fontSize:10.5, color:C.sub, fontWeight:700, whiteSpace:"nowrap", textTransform:"uppercase", letterSpacing:"0.03em" };
  const cagrFmt = v => v==null ? "—" : `${v>=0?"+":""}${(v*100).toFixed(0)}%`;
  const pctFmtV = v => v==null ? "—" : `${(v*100).toFixed(0)}%`;
  // Row order mirrors 1000X: year → revenue → rev growth → net income →
  // net inc growth → net inc margins → EPS → PE low/high → price low/high → CAGRs
  const rows = [
    ["Revenue",          [fmtMoney(rev0), ...yrs.map(y=>fmtMoney(y.rev))]],
    ["Rev growth",       ["", ...yrs.map((_,i)=>inp("g", i))], true],
    ["Net income",       [fmtMoney(ni0), ...yrs.map(y=>fmtMoney(y.ni))]],
    ["Net inc. growth",  ["", ...yrs.map((_,i)=>inp("ng", i))], true],
    ["Net inc. margins", [pctFmtV(nm0), ...yrs.map(y=>pctFmtV(y.margin))]],
    ["EPS",              [fund?.ttm?.trailingEps!=null?`$${Number(fund.ttm.trailingEps).toFixed(2)}`:"—", ...yrs.map(y=>`$${y.eps.toFixed(2)}`)]],
    ["P/E low est.",     ["", ...yrs.map((_,i)=>inp("peLo", i))], true],
    ["P/E high est.",    ["", ...yrs.map((_,i)=>inp("peHi", i))], true],
    ["Share price low",  [`$${spot?.toFixed(0)}`, ...yrs.map(y=>`$${y.lo.toFixed(0)}`)], false, C.down],
    ["Share price high", [`$${spot?.toFixed(0)}`, ...yrs.map(y=>`$${y.hi.toFixed(0)}`)], false, C.up],
    ["CAGR low",         ["", ...yrs.map(y=>cagrFmt(y.cagrLo))], false, C.down],
    ["CAGR high",        ["", ...yrs.map(y=>cagrFmt(y.cagrHi))], false, C.up],
  ];
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:8 }}>
        <div style={{ fontSize:12, color:C.sub }}>Enter your assumptions in the <b style={{ color:C.cold }}>blue cells</b> — growth rates and P/E multiples. Price targets, margins and CAGR recompute live. Saved per ticker.</div>
        <button onClick={()=>setP(seed())} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:8, padding:"6px 12px", color:C.sub, cursor:"pointer", fontSize:11.5 }}>Reset to analyst-seeded</button>
      </div>
      <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch", border:`1px solid ${C.line}`, borderRadius:12, background:C.panel }}>
        <div style={{ minWidth:660 }}>
          <div style={{ display:"grid", gridTemplateColumns:`minmax(132px,1.4fr) repeat(5, minmax(88px,1fr))`, borderBottom:`1px solid ${C.line}` }}>
            <div style={lblCell}>Year</div>
            <div style={{ ...cell, fontWeight:800, color:C.faint }}>{y0} (TTM)</div>
            {yrs.map(y=><div key={y.year} style={{ ...cell, fontWeight:800 }}>{y.year}</div>)}
          </div>
          {rows.map(([label, vals, editable, col], ri)=>(
            <div key={ri} style={{ display:"grid", gridTemplateColumns:`minmax(132px,1.4fr) repeat(5, minmax(88px,1fr))`, borderTop:ri?`1px solid ${C.panel2}`:"none", background: editable ? `${C.cold}0a` : "transparent", alignItems:"center" }}>
              <div style={lblCell}>{label}{editable && <span style={{ color:C.cold, fontWeight:400, textTransform:"none", letterSpacing:0 }}> · %</span>}</div>
              {vals.map((v,ci)=><div key={ci} style={{ ...cell, color: col || cell.color }}>{v}</div>)}
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize:10, color:C.faint, marginTop:8 }}>CAGR = the yearly return if the stock reaches that price by that year, from today's ${spot?.toFixed(2)}. Assumes share count stays flat. Personal research input — not financial advice.</div>
    </div>
  );
}

function FilingsSection({ ticker, aiEnabled, profile }) {
  const [d, setD] = useState(null);
  const [nextEarn, setNextEarn] = useState(null);
  const [prep, setPrep] = useState(null);
  const [prepLoading, setPrepLoading] = useState(false);
  useEffect(()=>{
    let alive = true; setD(null); setNextEarn(null); setPrep(null); setPrepLoading(false);
    fetchFilings(ticker).then(x=>alive&&setD(x)).catch(()=>alive&&setD({ filings:[], error:"request failed" }));
    fetchFinancialsDetail(ticker).then(x=>{ if(alive && x.next_earnings) setNextEarn(String(x.next_earnings).slice(0,10)); }).catch(()=>{});
    return ()=>{ alive=false; };
  },[ticker]);
  const loadPrep = () => {
    setPrepLoading(true); setPrep(null);
    fetchEarningsPrep(ticker, profile).then(setPrep).catch(()=>setPrep({ ai_error:"request failed" })).finally(()=>setPrepLoading(false));
  };
  const FORM_COL = { "10-K":C.cold, "10-Q":C.up, "8-K":C.amber, "DEF 14A":C.violet };
  const linkBtn = (href, label) => (
    <a href={href} target="_blank" rel="noreferrer" style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:8, padding:"8px 13px", color:C.cold, fontSize:12, fontWeight:600, textDecoration:"none" }}>{label} ↗</a>
  );
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
      {/* Earnings calls */}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginBottom:4 }}>Earnings Calls {nextEarn && <span style={{ fontSize:11, color:C.violet, fontFamily:C.mono, fontWeight:600 }}>· next: {nextEarn}</span>}</div>
        <div style={{ fontSize:11.5, color:C.faint, marginBottom:12 }}>Full transcripts aren't in free market data — these links go straight to them.</div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          {linkBtn(`https://seekingalpha.com/symbol/${ticker}/earnings/transcripts`, "Transcripts (Seeking Alpha)")}
          {linkBtn(`https://www.google.com/search?q=${encodeURIComponent(ticker + " investor relations earnings call webcast")}`, "Company IR / webcast")}
          {linkBtn(`https://finance.yahoo.com/quote/${ticker}/analysis`, "Analyst estimates (Yahoo)")}
        </div>

        {/* AI earnings-call prep */}
        <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${C.panel2}` }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
            <div style={{ fontSize:12.5, fontWeight:700, color:C.ink }}>AI Earnings-Call Prep <span style={{ fontSize:10.5, color:C.faint, fontWeight:400 }}>· the numbers to beat + what to listen for</span></div>
            {aiEnabled && !prep && !prepLoading && (
              <button onClick={loadPrep} style={{ background:C.cold, border:"none", borderRadius:8, padding:"7px 13px", color:"#fff", cursor:"pointer", fontSize:12, fontWeight:600, display:"flex", gap:6, alignItems:"center" }}><Zap size={13}/> Prep me</button>
            )}
          </div>
          {!aiEnabled ? (
            <div style={{ fontSize:11.5, color:C.faint, marginTop:8 }}>Turn on AI Insights in Settings to generate the prep.</div>
          ) : prepLoading ? (
            <div style={{ padding:"14px 0", color:C.sub, display:"flex", gap:8, alignItems:"center" }}><Loader2 size={14} style={{ animation:"spin 1s linear infinite" }}/> <span style={{ fontSize:12 }}>Reading estimates & filing activity…</span></div>
          ) : prep?.ai_error ? (
            <div style={{ fontSize:12, color:C.amber, marginTop:8 }}>AI error — {String(prep.ai_error).slice(0,100)}</div>
          ) : prep ? (
            <div style={{ marginTop:10, display:"flex", flexDirection:"column", gap:10 }}>
              {prep.headline && <div style={{ fontSize:13.5, fontWeight:700, color:C.ink, lineHeight:1.5 }}>{prep.headline}</div>}
              {(prep.numbers_to_beat||[]).length>0 && (
                <div style={{ background:C.panel2, borderRadius:10, padding:"11px 13px" }}>
                  <div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase", marginBottom:5 }}>Numbers to beat</div>
                  {prep.numbers_to_beat.map((x,i)=><div key={i} style={{ fontSize:12, color:C.sub, lineHeight:1.6, fontFamily:C.mono }}>· {x}</div>)}
                </div>
              )}
              {(prep.watch_items||[]).length>0 && (
                <div>
                  <div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase", marginBottom:5 }}>Listen for</div>
                  {prep.watch_items.map((x,i)=><div key={i} style={{ fontSize:12, color:C.sub, lineHeight:1.6 }}>• {x}</div>)}
                </div>
              )}
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px,1fr))", gap:10 }}>
                {(prep.filing_notes||[]).length>0 && (
                  <div style={{ background:C.panel2, borderRadius:10, padding:"11px 13px" }}>
                    <div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase", marginBottom:4 }}>Filing activity</div>
                    {prep.filing_notes.map((x,i)=><div key={i} style={{ fontSize:11.5, color:C.sub, lineHeight:1.55 }}>{x}</div>)}
                  </div>
                )}
                {(prep.risks||[]).length>0 && (
                  <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}30`, borderRadius:10, padding:"11px 13px" }}>
                    <div style={{ fontSize:9.5, color:C.down, textTransform:"uppercase", marginBottom:4, fontWeight:700 }}>Drop risks (even on a beat)</div>
                    {prep.risks.map((x,i)=><div key={i} style={{ fontSize:11.5, color:C.sub, lineHeight:1.55 }}>{x}</div>)}
                  </div>
                )}
              </div>
              {prep.bottom_line && <div style={{ fontSize:12.5, color:C.ink, lineHeight:1.6, fontWeight:500, borderLeft:`3px solid ${C.cold}`, paddingLeft:10 }}>{prep.bottom_line}</div>}
              <div style={{ fontSize:9.5, color:C.faint }}>Built from analyst estimates, fundamentals and filing metadata — full filing text isn't parsed. Not financial advice.</div>
            </div>
          ) : null}
        </div>
      </div>
      {/* SEC filings */}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginBottom:2 }}>SEC Filings <span style={{ fontSize:11, color:C.faint, fontWeight:400 }}>· straight from EDGAR</span></div>
        <div style={{ fontSize:11, color:C.faint, marginBottom:10 }}>10-K = annual report · 10-Q = quarterly · 8-K = material events · DEF 14A = proxy (pay & governance)</div>
        {!d ? <div style={{ padding:20, textAlign:"center", color:C.sub }}><Loader2 size={15} style={{ animation:"spin 1s linear infinite" }}/></div>
        : d.error && !(d.filings||[]).length ? <div style={{ fontSize:12, color:C.amber }}>{d.error}</div>
        : (d.filings||[]).map((f,i)=>(
          <a key={i} href={f.url} target="_blank" rel="noreferrer"
            style={{ display:"flex", gap:12, alignItems:"center", padding:"9px 4px", borderTop:i?`1px solid ${C.panel2}`:"none", textDecoration:"none", cursor:"pointer" }}>
            <span style={{ fontFamily:C.mono, fontSize:10.5, fontWeight:800, color:FORM_COL[f.form]||C.sub, background:`${FORM_COL[f.form]||C.sub}14`, borderRadius:5, padding:"2px 8px", minWidth:64, textAlign:"center" }}>{f.form}</span>
            <span style={{ fontSize:12, color:C.ink, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.desc}</span>
            <span style={{ fontFamily:C.mono, fontSize:11, color:C.faint }}>{f.date}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

// Advanced Education — plain-English glossary of every metric on this page.
const GLOSSARY = [
  ["P/E (TTM)","Share price ÷ last 12 months of earnings per share. How many dollars you pay for $1 of current profit. Lower = cheaper, but fast growers deserve higher."],
  ["Forward P/E","Price ÷ analysts' expected EPS for this fiscal year — the market's price on this year's profit."],
  ["2yr Forward P/E","Price ÷ expected EPS for next fiscal year. Much lower than TTM P/E = the market expects earnings to grow into the valuation."],
  ["PEG","P/E ÷ growth rate. Under ~1.5 usually means you're not overpaying for the growth."],
  ["P/S","Market cap ÷ revenue. The yardstick when earnings are small or negative."],
  ["EV/EBITDA","Enterprise value ÷ cash operating profit. Comparable across companies with different debt loads."],
  ["Gross margin","% of revenue left after direct costs. A read on pricing power — great software runs 70%+."],
  ["Net margin","% of revenue that survives all the way to profit."],
  ["Free cash flow","Cash generated after capital spending — what can actually fund buybacks, dividends, or growth."],
  ["ROE","Profit ÷ shareholder equity: how hard the company works each dollar you own."],
  ["EPS","Profit per share — the E in P/E."],
  ["Dilution","Share-count change. New shares shrink your slice; buybacks grow it."],
  ["Analyst estimates (low/avg/high)","The forecast range across Wall Street analysts. A wide range = high disagreement/uncertainty."],
  ["RSI","Momentum, 0–100, over the last 14 bars. Under 30 = oversold, over 70 = overbought."],
  ["CAGR","Compound annual growth rate — the smoothed per-year return between two points in time."],
];
function EducationPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14 }}>
      <button onClick={()=>setOpen(o=>!o)} style={{ width:"100%", display:"flex", justifyContent:"space-between", alignItems:"center", background:"none", border:"none", padding:"14px 18px", cursor:"pointer" }}>
        <span style={{ fontSize:13, fontWeight:700, color:C.ink }}>📚 What do these metrics mean?</span>
        <ChevronDown size={15} color={C.faint} style={{ transform:open?"rotate(180deg)":"none", transition:"transform .15s" }}/>
      </button>
      {open && (
        <div style={{ padding:"0 18px 14px" }}>
          {GLOSSARY.map(([t,def],i)=>(
            <div key={i} style={{ padding:"8px 0", borderTop:`1px solid ${C.panel2}` }}>
              <span style={{ fontSize:12, fontWeight:700, color:C.cold }}>{t}</span>
              <span style={{ fontSize:12, color:C.sub, marginLeft:8, lineHeight:1.5 }}>{def}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Compare auto-population: closest big competitor by sector + the sector's ETF.
const SECTOR_PEERS = {
  "Technology": ["MSFT","NVDA","AAPL","AVGO","AMD"],
  "Communication Services": ["GOOGL","META","NFLX","DIS"],
  "Consumer Cyclical": ["AMZN","TSLA","HD","NKE"],
  "Consumer Defensive": ["WMT","PG","COST","KO"],
  "Healthcare": ["LLY","UNH","JNJ","MRK"],
  "Financial Services": ["JPM","V","MA","BAC"],
  "Industrials": ["GE","CAT","UBER","BA"],
  "Energy": ["XOM","CVX"],
  "Utilities": ["NEE","DUK"],
  "Real Estate": ["PLD","AMT"],
  "Basic Materials": ["LIN","SHW"],
};
const SECTOR_ETF = {
  "Technology":"XLK", "Communication Services":"XLC", "Financial Services":"XLF",
  "Consumer Cyclical":"XLY", "Consumer Defensive":"XLP", "Healthcare":"XLV",
  "Industrials":"XLI", "Energy":"XLE", "Utilities":"XLU", "Real Estate":"XLRE",
  "Basic Materials":"XLB",
};

const PRESET_SCREENS = [
  {name:"Undervalued Growth",  mode:"market", filters:{fpe_max:25, rev_growth_min:20, fcf_positive:true}},
  {name:"Quality Compounders", mode:"market", filters:{roe_min:15, gross_min:50, de_max:80}},
  {name:"Cheap vs Sector",     mode:"market", filters:{cheap_vs_sector:true}},
];
const SCREEN_FIELDS = [
  {k:"fpe_max", label:"Forward P/E <"}, {k:"peg_max", label:"PEG <"}, {k:"ps_max", label:"P/S <"},
  {k:"ev_max", label:"EV/EBITDA <"}, {k:"rev_growth_min", label:"Rev growth % >"}, {k:"eps_growth_min", label:"EPS growth % >"},
  {k:"gross_min", label:"Gross margin % >"}, {k:"roe_min", label:"ROE % >"}, {k:"de_max", label:"Debt/Equity <"},
  {k:"cr_min", label:"Current ratio >"}, {k:"mcap_min", label:"Mkt cap $B >"}, {k:"mcap_max", label:"Mkt cap $B <"},
];
const RES_COLS = [
  {k:"ticker", label:"Ticker", get:m=>m.ticker, fmt:v=>v, num:false},
  {k:"sector", label:"Sector", get:m=>m.sector, fmt:v=>v, num:false},
  {k:"price", label:"Price", get:m=>m.price, fmt:v=>v==null?"—":`$${v.toFixed(2)}`, num:true},
  {k:"forwardPE", label:"Fwd P/E", get:m=>m.forwardPE, fmt:fmtX, num:true},
  {k:"peg", label:"PEG", get:m=>m.peg, fmt:v=>v==null?"—":v.toFixed(2), num:true},
  {k:"revenueGrowth", label:"Rev G", get:m=>m.revenueGrowth, fmt:fmtPct, num:true},
  {k:"roe", label:"ROE", get:m=>m.roe, fmt:fmtPct, num:true},
  {k:"grossMargin", label:"Gross M", get:m=>m.grossMargin, fmt:fmtPct, num:true},
  {k:"marketCap", label:"Mkt Cap", get:m=>m.marketCap, fmt:fmtMoney, num:true},
];

function ScreenerPanel({ watchlist, savedScreens, onSaveScreen, onDeleteScreen, onOpen, onFinancials }) {
  const [mode, setMode]       = useState("watchlist");
  const [filters, setFilters] = useState({ fcf_positive:false, cheap_vs_sector:false, sectors:[] });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);   // {scanned,total}
  const [results, setResults] = useState(null);
  const [sortKey, setSortKey] = useState("forwardPE");
  const [sortDir, setSortDir] = useState(1);
  const [saveName, setSaveName] = useState("");
  const [showSave, setShowSave] = useState(false);
  const cancelRef = useRef(false);

  const setF = (k,v)=> setFilters(f=>({ ...f, [k]: (v===""||v==null)?undefined:v }));
  const applyPreset = (p)=>{ setMode(p.mode); setFilters({ fcf_positive:false, cheap_vs_sector:false, sectors:[], ...p.filters }); };
  const activeFilterCount = Object.entries(filters).filter(([k,v])=>{
    if (k==="sectors") return v && v.length; if (typeof v==="boolean") return v; return v!=null && v!=="";
  }).length;

  const buildParams = () => {
    const p = {};
    SCREEN_FIELDS.forEach(f=>{ if (filters[f.k]!=null && filters[f.k]!=="") p[f.k]=filters[f.k]; });
    if (filters.fcf_positive) p.fcf_positive = 1;
    if (filters.cheap_vs_sector) p.cheap_vs_sector = 1;
    if (filters.sectors?.length) p.sectors = filters.sectors.join(",");
    return p;
  };

  const run = async () => {
    cancelRef.current = false;
    setRunning(true); setResults(null); setProgress(null);
    const base = buildParams();
    try {
      if (mode==="watchlist") {
        const wl = (watchlist||[]).filter(t=>!isCrypto(t));
        const d = await fetchScreen({ ...base, mode:"watchlist", tickers: wl.join(",") });
        setResults(d.matches||[]);
      } else {
        let offset = 0, acc = [], total = 0;
        while (offset!=null && !cancelRef.current) {
          const d = await fetchScreen({ ...base, mode:"market", offset, limit:40 });
          acc = acc.concat(d.matches||[]);
          total = d.total_universe||0;
          setResults([...acc]);
          setProgress({ scanned: Math.min(offset+40, total), total });
          offset = d.next_offset;
        }
      }
    } catch(e){ setResults([]); }
    setRunning(false); setProgress(null);
  };

  const sorted = results ? [...results].sort((a,b)=>{
    const col = RES_COLS.find(c=>c.k===sortKey); const av=col.get(a), bv=col.get(b);
    if (av==null) return 1; if (bv==null) return -1;
    if (col.num) return (av-bv)*sortDir;
    return String(av).localeCompare(String(bv))*sortDir;
  }) : null;

  const toggleSector = (s)=> setFilters(f=>{ const cur=f.sectors||[]; return { ...f, sectors: cur.includes(s)?cur.filter(x=>x!==s):[...cur,s] }; });
  const chip = (active)=>({ padding:"6px 11px", borderRadius:20, border:`1px solid ${active?C.cold:C.line}`, background:active?`${C.cold}14`:C.panel, color:active?C.cold:C.sub, fontSize:11.5, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" });
  const inputBox = { width:"100%", background:C.panel, border:`1px solid ${C.line}`, borderRadius:7, padding:"7px 9px", color:C.ink, fontSize:12.5, fontFamily:C.mono, outline:"none" };

  return (
    <div>
      {/* Saved + preset screens */}
      <div style={{ display:"flex", gap:7, flexWrap:"wrap", marginBottom:14, alignItems:"center" }}>
        <span style={{ fontSize:10.5, color:C.faint, letterSpacing:"0.05em" }}>SCREENS</span>
        {PRESET_SCREENS.map(p=>(
          <button key={p.name} onClick={()=>applyPreset(p)} style={chip(false)}>{p.name}</button>
        ))}
        {(savedScreens||[]).map(s=>(
          <span key={s.name} style={{ display:"inline-flex", alignItems:"center", gap:5, ...chip(false) }}>
            <span onClick={()=>{ setMode(s.mode||"market"); setFilters({ fcf_positive:false, cheap_vs_sector:false, sectors:[], ...s.filters }); }} style={{ cursor:"pointer" }}>★ {s.name}</span>
            <X size={11} style={{ cursor:"pointer", color:C.faint }} onClick={()=>onDeleteScreen(s.name)}/>
          </span>
        ))}
      </div>

      {/* Filter inputs */}
      <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px", marginBottom:14 }}>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(140px,1fr))", gap:10, marginBottom:14 }}>
          {SCREEN_FIELDS.map(f=>(
            <div key={f.k}>
              <div style={{ fontSize:9.5, color:C.faint, marginBottom:3 }}>{f.label.toUpperCase()}</div>
              <input type="number" value={filters[f.k] ?? ""} onChange={e=>setF(f.k, e.target.value===""?"":parseFloat(e.target.value))} placeholder="—" style={inputBox}/>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center", marginBottom:12 }}>
          <button onClick={()=>setF("fcf_positive", !filters.fcf_positive)} style={chip(filters.fcf_positive)}>Positive FCF</button>
          <button onClick={()=>setF("cheap_vs_sector", !filters.cheap_vs_sector)} style={chip(filters.cheap_vs_sector)}>Cheap vs sector</button>
        </div>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:14 }}>
          {SECTORS.map(s=>(<button key={s} onClick={()=>toggleSector(s)} style={{ ...chip(filters.sectors?.includes(s)), fontSize:10.5, padding:"4px 9px" }}>{s}</button>))}
        </div>
        {/* Mode + run */}
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", alignItems:"center" }}>
          <div style={{ display:"flex", gap:2, background:C.panel2, borderRadius:9, padding:3, border:`1px solid ${C.line}` }}>
            {[["watchlist","My Watchlist"],["market","S&P 500"]].map(([id,lab])=>(
              <button key={id} onClick={()=>setMode(id)} style={{ padding:"6px 12px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12, fontWeight:600, background:mode===id?C.line:"transparent", color:mode===id?C.ink:C.sub }}>{lab}</button>
            ))}
          </div>
          <button onClick={run} disabled={running} style={{ background:running?C.line:C.up, border:"none", borderRadius:9, padding:"9px 18px", color:running?C.sub:"#06080d", cursor:running?"default":"pointer", fontSize:13, fontWeight:700, display:"flex", gap:7, alignItems:"center" }}>
            {running ? <><Loader2 size={14} style={{ animation:"spin 1s linear infinite" }}/> Scanning…</> : <><Search size={14}/> Run Screen ({activeFilterCount})</>}
          </button>
          {mode==="market" && running && <button onClick={()=>{ cancelRef.current=true; }} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 14px", color:C.sub, cursor:"pointer", fontSize:12 }}>Stop</button>}
          {results && !running && (
            showSave ? (
              <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                <input autoFocus value={saveName} onChange={e=>setSaveName(e.target.value)} placeholder="Screen name" style={{ ...inputBox, width:150 }}
                  onKeyDown={e=>{ if(e.key==="Enter"&&saveName.trim()){ onSaveScreen({ name:saveName.trim(), mode, filters }); setSaveName(""); setShowSave(false); } }}/>
                <button onClick={()=>{ if(saveName.trim()){ onSaveScreen({ name:saveName.trim(), mode, filters }); setSaveName(""); setShowSave(false); } }} style={{ background:C.up, border:"none", borderRadius:7, padding:"7px 11px", color:"#06080d", fontSize:12, fontWeight:700, cursor:"pointer" }}>Save</button>
              </div>
            ) : <button onClick={()=>setShowSave(true)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:9, padding:"9px 14px", color:C.sub, cursor:"pointer", fontSize:12, display:"flex", gap:6, alignItems:"center" }}><Star size={13}/> Save screen</button>
          )}
        </div>
        {progress && (
          <div style={{ marginTop:12 }}>
            <div style={{ fontSize:11, color:C.faint, marginBottom:4 }}>Scanned {progress.scanned} / {progress.total}</div>
            <div style={{ height:5, background:C.line, borderRadius:3, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${progress.total?100*progress.scanned/progress.total:0}%`, background:C.cold, transition:"width .2s" }}/>
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      {sorted && (
        sorted.length===0 ? (
          <div style={{ textAlign:"center", padding:"40px 20px", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>
            No matches{running?" yet…":"."} {!running && "Try loosening a filter — lower a minimum or raise a maximum."}
          </div>
        ) : (
          <div>
            <div style={{ fontSize:12, color:C.sub, marginBottom:8 }}><b style={{ color:C.ink }}>{sorted.length}</b> match{sorted.length===1?"":"es"}{mode==="market"?" in S&P 500":" in watchlist"}</div>
            <div style={{ overflowX:"auto", WebkitOverflowScrolling:"touch", border:`1px solid ${C.line}`, borderRadius:12, background:C.panel }}>
              <div style={{ minWidth:640 }}>
                <div style={{ display:"grid", gridTemplateColumns:`minmax(70px,1fr) minmax(120px,1.4fr) repeat(7, minmax(64px,0.9fr))`, borderBottom:`1px solid ${C.line}` }}>
                  {RES_COLS.map(c=>(
                    <div key={c.k} onClick={()=>{ if(sortKey===c.k) setSortDir(d=>-d); else { setSortKey(c.k); setSortDir(c.num?1:1); } }}
                      style={{ padding:"9px 11px", fontSize:9.5, color:sortKey===c.k?C.ink:C.faint, letterSpacing:"0.04em", textTransform:"uppercase", cursor:"pointer", textAlign:c.num?"right":"left", fontWeight:sortKey===c.k?700:500 }}>
                      {c.label}{sortKey===c.k?(sortDir>0?" ↑":" ↓"):""}
                    </div>
                  ))}
                </div>
                {sorted.map(m=>(
                  <div key={m.ticker} onClick={()=>onFinancials(m.ticker)} className="pos-row"
                    style={{ display:"grid", gridTemplateColumns:`minmax(70px,1fr) minmax(120px,1.4fr) repeat(7, minmax(64px,0.9fr))`, borderTop:`1px solid ${C.panel2}`, cursor:"pointer" }}
                    onMouseEnter={e=>e.currentTarget.style.background=C.panel2} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    {RES_COLS.map(c=>(
                      <div key={c.k} style={{ padding:"9px 11px", fontFamily:c.num?C.mono:"inherit", fontSize:12, textAlign:c.num?"right":"left",
                        color:c.k==="ticker"?C.ink:C.sub, fontWeight:c.k==="ticker"?700:500, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>
                        {c.fmt(c.get(m))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      )}
    </div>
  );
}

function FinancialsPage({ initialTicker, watchlist, aiEnabled, profile, savedScreens, onSaveScreen, onDeleteScreen, onOpenDetail }) {
  const [view, setView]   = useState("analyze");   // analyze | compare | screener
  const [ticker, setTicker] = useState(initialTicker || "AAPL");
  const [fund, setFund]   = useState(null);
  const [err, setErr]     = useState(false);
  const [ai, setAi]       = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [cmp, setCmp]     = useState({});   // ticker -> {data,loading}
  const [cmpList, setCmpList] = useState(initialTicker ? [initialTicker] : ["AAPL"]);
  const cmpAuto = useRef(true);   // auto-populate compare until the user edits it

  useEffect(()=>{ if (initialTicker) { setTicker(initialTicker); setView("analyze"); } },[initialTicker]);

  // Load fundamentals for the analyze ticker
  useEffect(()=>{
    let alive=true; setFund(null); setErr(false); setAi(null);
    fetchFundamentals(ticker).then(d=>{ if(alive){ d.error?setErr(true):setFund(d); } }).catch(()=>alive&&setErr(true));
    return ()=>{ alive=false; };
  },[ticker]);

  // Auto-populate Compare: the chosen stock + its closest big competitor + its
  // sector ETF + the broad market. Stops as soon as the user edits the list.
  useEffect(()=>{
    if (!cmpAuto.current || !fund?.ticker) return;
    const peers = SECTOR_PEERS[fund.sector] || [];
    const comp  = peers.find(p => p !== fund.ticker);
    const list  = [fund.ticker, comp, SECTOR_ETF[fund.sector], "SPY"]
      .filter(Boolean).filter((x,i,arr)=>arr.indexOf(x)===i).slice(0,4);
    setCmpList(list);
  },[fund]);

  // Load compare data for any missing tickers
  useEffect(()=>{
    cmpList.forEach(t=>{
      if (cmp[t]) return;
      setCmp(c=>({ ...c, [t]:{ loading:true, data:null } }));
      fetchFundamentals(t).then(d=>setCmp(c=>({ ...c, [t]:{ loading:false, data:d.error?null:d } })))
        .catch(()=>setCmp(c=>({ ...c, [t]:{ loading:false, data:null } })));
    });
  // eslint-disable-next-line
  },[cmpList]);

  // Picking a stock updates EVERY sub-tab; it does NOT yank you back to Analyze.
  const go = (t) => { const T=normalizeTicker(t); if(T) setTicker(T); };
  const loadAi = () => {
    setAiLoading(true); setAi(null);
    fetchBusinessQuality(ticker, profile).then(setAi).catch(()=>setAi({ ai_error:"request failed" })).finally(()=>setAiLoading(false));
  };
  const addCompare = (t) => { cmpAuto.current = false; const T=normalizeTicker(t); if(T && !cmpList.includes(T) && cmpList.length<4) setCmpList(l=>[...l,T]); };
  const removeCompare = (t) => { cmpAuto.current = false; setCmpList(l=>l.filter(x=>x!==t)); };

  const subTab = (id,label) => (
    <button key={id} onClick={()=>setView(id)} style={{ padding:"7px 15px", borderRadius:7, border:"none", cursor:"pointer", fontSize:12.5, fontWeight:600,
      background:view===id?C.line:"transparent", color:view===id?C.ink:C.sub }}>{label}</button>
  );
  const searchBar = (onSubmit, placeholder) => (
    <TickerInput onPick={onSubmit} placeholder={placeholder} style={{ flex:"1 1 220px", maxWidth:360 }}/>
  );

  const t = fund?.trends || {};
  return (
    <div>
      {/* Header + sub-tabs */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexWrap:"wrap", gap:10 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>Financials</div>
          <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>Value a business at a glance · free fundamentals + valuation</div>
        </div>
        <div style={{ display:"flex", gap:2, background:C.panel, borderRadius:9, padding:3, border:`1px solid ${C.line}`, flexWrap:"wrap" }}>
          {subTab("analyze","Analyze")}{subTab("financials","Financials")}{subTab("compare","Compare")}{subTab("projections","Projections")}{subTab("filings","Filings")}
        </div>
      </div>

      {view==="analyze" && (
        <div>
          <div style={{ marginBottom:16 }}>{searchBar(go, "Company fundamentals — e.g. AAPL, NVDA, COST")}</div>
          {err ? (
            <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}33`, borderRadius:10, padding:"14px 16px", color:C.down, fontSize:12.5 }}>Couldn't load fundamentals for {ticker}.</div>
          ) : !fund ? (
            <div style={{ padding:50, textAlign:"center", color:C.sub }}><Loader2 size={20} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:10 }}>Loading {ticker} fundamentals…</div></div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
              {/* Verdict banner */}
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:12, flexWrap:"wrap", background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
                <div style={{ minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"baseline", gap:10, flexWrap:"wrap" }}>
                    <span style={{ fontSize:20, fontWeight:800, color:C.ink }}>{displaySym(fund.ticker)}</span>
                    <span style={{ fontSize:13, color:C.sub }}>{fund.name}</span>
                    <span style={{ fontFamily:C.mono, fontSize:14, color:C.ink }}>${fund.spot?.toFixed?.(2) ?? "—"}</span>
                  </div>
                  <div style={{ fontSize:11, color:C.faint, marginTop:2 }}>{fund.sector} · {fund.industry} · {fmtMoney(fund.marketCap)} mkt cap</div>
                  {fund.verdict && <div style={{ fontSize:13.5, color:C.ink, marginTop:10, lineHeight:1.5, fontWeight:500 }}>{fund.verdict}</div>}
                </div>
                <button onClick={()=>onOpenDetail(fund.ticker)} style={{ background:C.panel2, border:`1px solid ${C.line}`, borderRadius:8, padding:"7px 12px", color:C.cold, cursor:"pointer", fontSize:12, fontWeight:600, flexShrink:0 }}>Chart & AI →</button>
              </div>

              {/* Fundamentals trends */}
              <div>
                <div style={{ fontSize:12.5, fontWeight:700, color:C.sub, marginBottom:9 }}>Company Fundamentals <span style={{ color:C.faint, fontWeight:400 }}>· {fund.years?.join(" → ")}</span></div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(140px,1fr))", gap:10 }}>
                  <TrendStat label="Revenue"     series={t.revenue}   fmt={fmtMoney} years={fund.years}/>
                  <TrendStat label="Net Income"  series={t.netIncome} fmt={fmtMoney} years={fund.years}/>
                  <TrendStat label="Diluted EPS" series={t.eps}       fmt={v=>v==null?"—":`$${v.toFixed(2)}`} years={fund.years}/>
                  <TrendStat label="Gross Margin" series={t.grossMargin} fmt={v=>fmtPct(v)} years={fund.years}/>
                  <TrendStat label="Oper. Margin" series={t.operatingMargin} fmt={v=>fmtPct(v)} years={fund.years}/>
                  <TrendStat label="Net Margin"  series={t.netMargin} fmt={v=>fmtPct(v)} years={fund.years}/>
                  <TrendStat label="Free Cash Flow" series={t.fcf}    fmt={fmtMoney} years={fund.years}/>
                  <TrendStat label="Shares Out"  series={t.shares}    fmt={v=>v==null?"—":`${(v/1e9).toFixed(2)}B`} invert years={fund.years}/>
                </div>
                {/* health strip */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(120px,1fr))", gap:10, marginTop:10 }}>
                  <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:11, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase" }}>Cash vs Debt</div><div style={{ fontFamily:C.mono, fontSize:13, marginTop:3 }}><span style={{ color:C.up }}>{fmtMoney(fund.health?.totalCash)}</span> / <span style={{ color:C.down }}>{fmtMoney(fund.health?.totalDebt)}</span></div></div>
                  <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:11, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase" }}>ROE</div><div style={{ fontFamily:C.mono, fontSize:15, fontWeight:700, marginTop:3, color:C.ink }}>{fmtPct(fund.health?.roe)}</div></div>
                  <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:11, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase" }}>Current Ratio</div><div style={{ fontFamily:C.mono, fontSize:15, fontWeight:700, marginTop:3, color:(fund.health?.currentRatio||0)>=1?C.ink:C.down }}>{fund.health?.currentRatio?.toFixed?.(2) ?? "—"}</div></div>
                  <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:11, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase" }}>Dilution (window)</div><div style={{ fontFamily:C.mono, fontSize:15, fontWeight:700, marginTop:3, color:(fund.dilution||0)>1?C.down:(fund.dilution||0)<-1?C.up:C.ink }}>{fund.dilution==null?"—":`${fund.dilution>=0?"+":""}${fund.dilution.toFixed(1)}%`}</div></div>
                </div>
              </div>

              {/* Metrics vs typical market ranges (1000X-style yardstick) */}
              <AdvancedMetrics fund={fund}/>

              {/* Valuation snapshot */}
              <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
                <div style={{ fontSize:14, fontWeight:700, color:C.ink, marginBottom:2 }}>Valuation Snapshot</div>
                <div style={{ fontSize:11, color:C.faint, marginBottom:6 }}>Green = cheap · Yellow = fair · Red = expensive — vs sector median and its own 5-yr history</div>
                <div style={{ display:"grid", gridTemplateColumns:"minmax(96px,1.4fr) minmax(60px,1fr) minmax(90px,1.3fr) minmax(90px,1.3fr)", gap:8, fontSize:9, color:C.faint, textTransform:"uppercase", letterSpacing:"0.05em", paddingBottom:2 }}>
                  <div>Metric</div><div style={{ textAlign:"right" }}>Now</div><div style={{ textAlign:"right" }}>vs Sector</div><div style={{ textAlign:"right" }}>vs Own 5yr</div>
                </div>
                <ValuationRow label="Forward P/E"  m={fund.valuation?.forwardPE}/>
                <ValuationRow label="Trailing P/E" m={fund.valuation?.trailingPE}/>
                <ValuationRow label="PEG"          m={fund.valuation?.peg}/>
                <ValuationRow label="P/S"          m={fund.valuation?.ps}/>
                <ValuationRow label="P/B"          m={fund.valuation?.pb}/>
                <ValuationRow label="EV/EBITDA"    m={fund.valuation?.evEbitda}/>
              </div>

              {/* Fair value model */}
              <FairValueModel inp={fund.fairValueInputs}/>

              {/* AI business quality */}
              <div style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:14, padding:"16px 18px" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:8 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:C.ink }}>AI Business-Quality Read <span style={{ fontSize:11, color:C.faint, fontWeight:400 }}>· 3–5 yr moat & durability</span></div>
                  {aiEnabled && !ai && !aiLoading && <button onClick={loadAi} style={{ background:C.cold, border:"none", borderRadius:8, padding:"8px 14px", color:"#fff", cursor:"pointer", fontSize:12.5, fontWeight:600, display:"flex", gap:6, alignItems:"center" }}><Zap size={13}/> Analyze</button>}
                </div>
                {!aiEnabled ? (
                  <div style={{ fontSize:12.5, color:C.faint, marginTop:10 }}>Turn on <b style={{ color:C.sub }}>AI Insights</b> in Settings for the written business-quality analysis. All the fundamentals, valuation, compare and fair-value tools above are free and need no AI.</div>
                ) : aiLoading ? (
                  <div style={{ padding:"18px 0", textAlign:"center", color:C.sub }}><Loader2 size={16} style={{ animation:"spin 1s linear infinite" }}/><div style={{ fontSize:12, marginTop:6 }}>Reading the business…</div></div>
                ) : ai?.ai_error ? (
                  <div style={{ fontSize:12, color:C.amber, marginTop:10 }} title={String(ai.ai_error)}>AI error — {String(ai.ai_error).slice(0,120)}</div>
                ) : ai ? (
                  <div style={{ marginTop:12, display:"flex", flexDirection:"column", gap:10 }}>
                    <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                      <span style={{ fontFamily:C.mono, fontSize:22, fontWeight:800, color:scoreColor(ai.quality_score) }}>{ai.quality_score}/10</span>
                      <span style={{ fontSize:12, fontWeight:700, color:ai.direction==="strengthening"?C.up:ai.direction==="weakening"?C.down:C.amber, textTransform:"uppercase", letterSpacing:"0.04em" }}>{ai.direction}</span>
                    </div>
                    {ai.verdict && <div style={{ fontSize:13.5, color:C.ink, lineHeight:1.5, fontWeight:500 }}>{ai.verdict}</div>}
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px,1fr))", gap:10 }}>
                      {[["Moat",ai.moat],["Market Opportunity",ai.market_opportunity],["Entry Read",ai.entry_read]].map(([k,v])=>v&&(
                        <div key={k} style={{ background:C.panel2, borderRadius:10, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.faint, textTransform:"uppercase", marginBottom:3 }}>{k}</div><div style={{ fontSize:12, color:C.sub, lineHeight:1.5 }}>{v}</div></div>
                      ))}
                    </div>
                    <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(220px,1fr))", gap:10 }}>
                      {ai.bull && <div style={{ background:`${C.up}0c`, border:`1px solid ${C.up}30`, borderRadius:10, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.up, textTransform:"uppercase", marginBottom:3, fontWeight:700 }}>Bull</div><div style={{ fontSize:12, color:C.sub, lineHeight:1.5 }}>{ai.bull}</div></div>}
                      {ai.bear && <div style={{ background:`${C.down}0c`, border:`1px solid ${C.down}30`, borderRadius:10, padding:"11px 13px" }}><div style={{ fontSize:9.5, color:C.down, textTransform:"uppercase", marginBottom:3, fontWeight:700 }}>Bear</div><div style={{ fontSize:12, color:C.sub, lineHeight:1.5 }}>{ai.bear}</div></div>}
                    </div>
                  </div>
                ) : null}
              </div>

              {/* Advanced education — plain-English glossary */}
              <EducationPanel/>
            </div>
          )}
        </div>
      )}

      {view==="compare" && (
        <div>
          <div style={{ display:"flex", gap:10, alignItems:"center", marginBottom:16, flexWrap:"wrap" }}>
            {searchBar(addCompare, "Add a ticker to compare (up to 4)")}
            <span style={{ fontSize:11.5, color:C.faint }}>{cmpList.length}/4 · auto-filled with a competitor, the sector ETF and SPY — edit freely · best value highlighted</span>
          </div>
          {cmpList.length===0 ? (
            <div style={{ textAlign:"center", padding:"40px", color:C.faint, background:C.panel, border:`1px dashed ${C.line}`, borderRadius:12 }}>Add 2–4 tickers to compare them side by side.</div>
          ) : (
            <CompareTable items={cmpList.map(tk=>({ ticker:tk, ...(cmp[tk]||{ loading:true, data:null }) }))} onRemove={removeCompare} onOpen={go}/>
          )}
        </div>
      )}

      {view==="financials" && (
        <div>
          <div style={{ marginBottom:16 }}>{searchBar(go, "Statements & estimates — e.g. PLTR, MU, SNDK")}</div>
          <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:10 }}>{displaySym(ticker)} — statements & analyst estimates</div>
          <FinancialsCharts ticker={ticker}/>
          <div style={{ marginTop:16 }}><EducationPanel/></div>
        </div>
      )}

      {view==="projections" && (
        <div>
          <div style={{ marginBottom:16 }}>{searchBar(go, "Project any ticker — e.g. META, NVDA, PLTR")}</div>
          <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:10 }}>{displaySym(ticker)} — 4-year projection model</div>
          {!fund ? (
            <div style={{ padding:40, textAlign:"center", color:C.sub }}><Loader2 size={18} style={{ animation:"spin 1s linear infinite" }}/><div style={{ marginTop:8, fontSize:12 }}>Loading {ticker} fundamentals…</div></div>
          ) : <ProjectionsTable fund={fund}/>}
          <div style={{ marginTop:16 }}><EducationPanel/></div>
        </div>
      )}

      {view==="filings" && (
        <div>
          <div style={{ marginBottom:16 }}>{searchBar(go, "Filings & earnings calls — any ticker")}</div>
          <div style={{ fontSize:13, fontWeight:700, color:C.ink, marginBottom:10 }}>{displaySym(ticker)} — filings & earnings calls</div>
          <FilingsSection ticker={ticker} aiEnabled={aiEnabled} profile={profile}/>
        </div>
      )}
    </div>
  );
}

// ── AI CHAT ASSISTANT (floating; grounded in the user's live data) ────────────
// Lightweight markdown: **bold**, "- " bullets, blank-line paragraphs. No tables/headers
// (the backend prompt is told to avoid them so this stays simple).
function renderRich(text) {
  const lines = String(text || "").split("\n");
  const out = []; let bullets = null; let key = 0;
  const inline = (s) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i} style={{ color:C.ink }}>{part.slice(2,-2)}</strong>
      : <span key={i}>{part}</span>);
  const flush = () => { if (bullets) { out.push(<ul key={`u${key++}`} style={{ margin:"4px 0", paddingLeft:18 }}>{bullets}</ul>); bullets=null; } };
  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, "");   // strip stray headers
    if (/^\s*[-*]\s+/.test(line)) {
      if (!bullets) bullets = [];
      bullets.push(<li key={key++} style={{ marginBottom:3, lineHeight:1.5 }}>{inline(line.replace(/^\s*[-*]\s+/, ""))}</li>);
    } else if (line.trim()==="") {
      flush();
    } else {
      flush();
      out.push(<div key={key++} style={{ lineHeight:1.55, margin:"3px 0" }}>{inline(line)}</div>);
    }
  }
  flush();
  return out;
}

const CHAT_SUGGESTIONS = [
  "How's my portfolio positioned right now?",
  "Is NVDA cheap or expensive at these levels?",
  "What are the biggest risks in my watchlist this week?",
];

function ChatAssistant({ aiEnabled, profile, watchlist, portfolio }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState([]);   // {role, content}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);
  useEffect(()=>{ if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; },[msgs, busy, open]);

  const send = async (text) => {
    const q = (text ?? input).trim();
    if (!q || busy) return;
    const history = msgs.slice(-8);
    const next = [...msgs, { role:"user", content:q }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      const d = await fetchChat({ message:q, history, profile, watchlist,
        portfolio: (portfolio||[]).map(p=>({ ticker:p.ticker, type:p.type, qty:p.qty, current_val:p.current_val, pnl:p.pnl, day_change:p.day_change, error:p.error })) });
      setMsgs(m => [...m, { role:"assistant", content: d.reply || "…" }]);
    } catch {
      setMsgs(m => [...m, { role:"assistant", content:"Sorry — I couldn't reach the server. Is the backend running?" }]);
    }
    setBusy(false);
  };

  const isMobile = typeof window !== "undefined" && window.innerWidth < 640;
  return (
    <>
      {/* Floating launcher */}
      <button onClick={()=>setOpen(o=>!o)} title="Ask AlphaDesk"
        style={{ position:"fixed", right:18, bottom:18, zIndex:80, width:54, height:54, borderRadius:"50%",
          background:C.cold, border:"none", boxShadow:"0 8px 28px rgba(0,0,0,0.35)", cursor:"pointer",
          display:"flex", alignItems:"center", justifyContent:"center", color:"#fff" }}>
        {open ? <X size={22}/> : <MessageCircle size={24}/>}
      </button>

      {open && (
        <div style={{ position:"fixed", zIndex:80, background:C.bg, border:`1px solid ${C.line}`, boxShadow:"0 16px 50px rgba(0,0,0,0.4)",
          display:"flex", flexDirection:"column", overflow:"hidden",
          ...(isMobile
            ? { inset:0, borderRadius:0 }
            : { right:18, bottom:84, width:400, height:"min(620px, 78vh)", borderRadius:16 }) }}>
          {/* Header */}
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"13px 16px", borderBottom:`1px solid ${C.line}`, flexShrink:0 }}>
            <div style={{ display:"flex", alignItems:"center", gap:9 }}>
              <div style={{ width:30, height:30, borderRadius:9, background:`${C.cold}1c`, display:"flex", alignItems:"center", justifyContent:"center" }}><Zap size={16} color={C.cold}/></div>
              <div>
                <div style={{ fontSize:13.5, fontWeight:700, color:C.ink }}>AlphaDesk Assistant</div>
                <div style={{ fontSize:10.5, color:C.faint }}>grounded in your live data</div>
              </div>
            </div>
            <div style={{ display:"flex", gap:6 }}>
              {msgs.length>0 && <button onClick={()=>setMsgs([])} title="Clear chat" style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:7, padding:"5px 8px", color:C.faint, cursor:"pointer", fontSize:11 }}>Clear</button>}
              <button onClick={()=>setOpen(false)} style={{ background:"none", border:"none", color:C.faint, cursor:"pointer", display:"flex" }}><X size={18}/></button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} style={{ flex:1, overflowY:"auto", padding:"14px 14px", display:"flex", flexDirection:"column", gap:10 }}>
            {msgs.length===0 && (
              <div style={{ color:C.sub }}>
                <div style={{ fontSize:13, lineHeight:1.6, marginBottom:12 }}>Ask about any ticker, your holdings, or the market. I read your live prices, valuations, and P&amp;L to answer.</div>
                <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                  {CHAT_SUGGESTIONS.map(s=>(
                    <button key={s} onClick={()=>send(s)} disabled={!aiEnabled}
                      style={{ textAlign:"left", background:C.panel, border:`1px solid ${C.line}`, borderRadius:10, padding:"9px 12px", color:aiEnabled?C.sub:C.faint, cursor:aiEnabled?"pointer":"default", fontSize:12.5, lineHeight:1.4 }}>{s}</button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m,i)=>(
              <div key={i} style={{ display:"flex", justifyContent: m.role==="user"?"flex-end":"flex-start" }}>
                <div style={{ maxWidth:"88%", padding:"9px 13px", borderRadius:13, fontSize:12.5,
                  background: m.role==="user"?C.cold:C.panel, color: m.role==="user"?"#fff":C.sub,
                  border: m.role==="user"?"none":`1px solid ${C.line}`,
                  borderBottomRightRadius: m.role==="user"?4:13, borderBottomLeftRadius: m.role==="user"?13:4 }}>
                  {m.role==="user" ? m.content : <div>{renderRich(m.content)}</div>}
                </div>
              </div>
            ))}
            {busy && <div style={{ display:"flex", alignItems:"center", gap:7, color:C.faint, fontSize:12 }}><Loader2 size={13} style={{ animation:"spin 1s linear infinite" }}/> thinking…</div>}
          </div>

          {/* Input */}
          <div style={{ padding:"11px 12px", borderTop:`1px solid ${C.line}`, flexShrink:0 }}>
            {!aiEnabled ? (
              <div style={{ fontSize:12, color:C.faint, textAlign:"center", padding:"6px 0" }}>Turn on <b style={{ color:C.sub }}>AI Insights</b> in Settings to chat.</div>
            ) : (
              <div style={{ display:"flex", gap:8, alignItems:"flex-end" }}>
                <textarea value={input} onChange={e=>setInput(e.target.value)} rows={1}
                  onKeyDown={e=>{ if(e.key==="Enter" && !e.shiftKey){ e.preventDefault(); send(); } }}
                  placeholder="Ask about a ticker, your holdings, the market…"
                  style={{ flex:1, resize:"none", maxHeight:96, background:C.panel, border:`1px solid ${C.line}`, borderRadius:10, padding:"9px 11px", color:C.ink, fontSize:12.5, outline:"none", fontFamily:"inherit", lineHeight:1.4 }}/>
                <button onClick={()=>send()} disabled={busy||!input.trim()} style={{ background: (busy||!input.trim())?C.line:C.cold, border:"none", borderRadius:10, width:38, height:38, flexShrink:0, cursor:(busy||!input.trim())?"default":"pointer", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center" }}><Send size={16}/></button>
              </div>
            )}
            <div style={{ fontSize:9.5, color:C.faint, textAlign:"center", marginTop:7 }}>Analysis to inform your decisions — not financial advice.</div>
          </div>
        </div>
      )}
    </>
  );
}

// ── MAIN ──────────────────────────────────────────────────────────────
export default function AlphaDesk({ userId = null, userEmail = null }) {
  const [tab, setTab]             = useState("watchlist");
  const [watchlist, setWatchlist] = useState(loadWL);
  const [detail, setDetail]       = useState(null);
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
  const [accounts, setAccounts]         = useState(loadAccounts);
  const [accountCollapsed, setAccountCollapsed] = useState(loadAccountCollapsed);
  const [savedScreens, setSavedScreens] = useState(loadSavedScreens);
  const [financialsTicker, setFinancialsTicker] = useState(null);
  applyTheme(theme);   // sync palette into C during render so children read the new colors immediately


  // localStorage fallback (instant load on first paint)
  useEffect(()=>{ saveWL(watchlist); },[watchlist]);
  useEffect(()=>{ savePositions(positions); },[positions]);
  useEffect(()=>{ saveAlerts(alertHistory); },[alertHistory]);
  useEffect(()=>{ saveAI(aiEnabled); },[aiEnabled]);
  useEffect(()=>{ if (profile) saveProfile(profile); },[profile]);
  useEffect(()=>{ saveAccounts(accounts); },[accounts]);
  useEffect(()=>{ saveAccountCollapsed(accountCollapsed); },[accountCollapsed]);
  useEffect(()=>{ saveSavedScreens(savedScreens); },[savedScreens]);

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
          sbSave(userId, { positions, watchlist, margin, marginRate, theme, aiEnabled, accounts, accountCollapsed });
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
        if (data.accounts)             setAccounts(data.accounts);
        if (data.accountCollapsed)     setAccountCollapsed(data.accountCollapsed);
        if (data.savedScreens)         setSavedScreens(data.savedScreens);
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
  sbState.current = { positions, watchlist, margin, marginRate, cash, profile, theme, aiEnabled, alertHistory, accounts, accountCollapsed, savedScreens };
  useEffect(()=>{
    if (!userId) return;
    clearTimeout(sbTimer.current);
    sbTimer.current = setTimeout(()=>{ sbSave(userId, sbState.current); }, 1000);
    return ()=>clearTimeout(sbTimer.current);
  },[positions, watchlist, margin, marginRate, cash, profile, theme, aiEnabled, alertHistory, accounts, accountCollapsed, savedScreens, userId]);

  // SECURITY: the server's positions.json / settings.json are a SHARED, unauthenticated
  // single-tenant store. Logged-in users must NEVER write sensitive holdings there — their
  // data lives only in their private, RLS-protected Supabase row. Only the anonymous/local
  // single-user path (no userId) may use the server files.
  const syncServer = (next)=>{ if(!userId) savePositionsServer(next); };

  const onMargin = (m, r)=>{ setMargin(m); setMarginRate(r); if(!userId) saveSettingsServer({ margin:m, margin_rate:r }); };
  const onCash   = (c)=>{ setCash(c); };

  // ── Combined cash & margin across all accounts (Unassigned uses the global
  // cash/margin/marginRate; named accounts carry their own). These roll up to
  // the top-of-page totals and drive a single blended-rate valuation call.
  const totalCash   = (Number(cash)||0)   + accounts.reduce((s,a)=>s+(Number(a.cash)||0),0);
  const totalMargin = (Number(margin)||0) + accounts.reduce((s,a)=>s+(Number(a.margin)||0),0);
  const blendedRate = totalMargin>0
    ? ((Number(margin)||0)*(Number(marginRate)||0)
        + accounts.reduce((s,a)=>s+(Number(a.margin)||0)*(Number(a.marginRate)||0),0)) / totalMargin
    : 0;

  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  // Arrays (multi-select goals/styles) serialize to comma lists via template join.
  const profileStr = profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : "";
  const valuePortfolio = useCallback((list, m=0, r=0)=>{
    setPfErr(null); setPfLoading(true);
    fetchValue(list, m, r, profileStr).then(x=> x.error?setPfErr(x.error):setPortfolio(x)).catch(e=>setPfErr(e.message)).finally(()=>setPfLoading(false));
  },[profileStr]);
  // Re-value when positions' CONTENTS or the combined margin/rate change — not when merely reordered.
  const valSig = positions.map(p=>[p.ticker,p.type,p.strike,p.expiry,p.qty,p.cost_basis,p.stop].join("|")).sort().join(",");
  useEffect(()=>{ valuePortfolio(positionsRef.current, totalMargin, blendedRate); },[valSig, totalMargin, blendedRate, valuePortfolio]);

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

  // Every change updates state AND (anonymous mode only) persists to the server.
  const commit         = (next)=>{ setPositions(next); syncServer(next); };
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
    setPositions(next); syncServer(next);
    setPortfolio(pf=>{ if(!pf) return pf; const np=reorderById(pf.positions||[], dragId, dropId); return np ? { ...pf, positions:np } : pf; });
  };

  // ── Account buckets ──────────────────────────────────────────────────
  const addAccount = (name) => {
    const nm = (name||"").trim(); if (!nm) return;
    const color = ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
    setAccounts(a => [...a, { id:newId(), name:nm, color }]);
  };
  const renameAccount = (id, name) => {
    const nm = (name||"").trim(); if (!nm) return;
    setAccounts(a => a.map(x => x.id===id ? { ...x, name:nm } : x));
  };
  const deleteAccount = (id) => {
    // Drop the bucket and return its positions to Unassigned.
    setAccounts(a => a.filter(x => x.id!==id));
    setAccountCollapsed(m => { const n={...m}; delete n[id]; return n; });
    const next = positions.map(p => p.account===id ? { ...p, account:null } : p);
    setPositions(next); syncServer(next);
    setPortfolio(pf => pf ? { ...pf,
      positions:(pf.positions||[]).map(p=>p.account===id?{...p,account:null}:p),
      expired:(pf.expired||[]).map(p=>p.account===id?{...p,account:null}:p),
      errored:(pf.errored||[]).map(p=>p.account===id?{...p,account:null}:p) } : pf);
  };
  const toggleAccountCollapse = (id) => setAccountCollapsed(m => ({ ...m, [id]: !m[id] }));
  // Set cash / margin / marginRate for one account. UNASSIGNED maps to the global
  // cash/margin/marginRate state (preserves pre-accounts data); named accounts store
  // their own. All roll up into the combined totals + blended-rate valuation.
  const setAccountFunds = (id, patch) => {
    if (id===UNASSIGNED) {
      if (patch.cash       != null) setCash(Number(patch.cash)||0);
      const m = patch.margin     != null ? Number(patch.margin)||0     : margin;
      const r = patch.marginRate != null ? Number(patch.marginRate)||0 : marginRate;
      if (patch.margin != null || patch.marginRate != null) {
        setMargin(m); setMarginRate(r);
        if (!userId) saveSettingsServer({ margin:m, margin_rate:r });
      }
    } else {
      setAccounts(a => a.map(x => x.id===id ? {
        ...x,
        ...(patch.cash       != null ? { cash:Number(patch.cash)||0 } : {}),
        ...(patch.margin     != null ? { margin:Number(patch.margin)||0 } : {}),
        ...(patch.marginRate != null ? { marginRate:Number(patch.marginRate)||0 } : {}),
      } : x));
    }
  };
  // Reorder/move positions: takes the fully-rebuilt raw positions array (new order +
  // any changed account assignments) and mirrors that order + assignment onto the
  // already-valued rows so the UI updates instantly without a re-valuation.
  const onReorderPositions = (nextRaw) => {
    setPositions(nextRaw); syncServer(nextRaw);
    setPortfolio(pf => {
      if (!pf) return pf;
      const order = new Map(nextRaw.map((p,i)=>[p.id,i]));
      const acct  = new Map(nextRaw.map(p=>[p.id, p.account ?? null]));
      const fix = list => [...(list||[])]
        .map(p => ({ ...p, account: acct.has(p.id) ? acct.get(p.id) : (p.account ?? null) }))
        .sort((x,y)=>(order.get(x.id)??1e9)-(order.get(y.id)??1e9));
      return { ...pf, positions:fix(pf.positions), expired:fix(pf.expired), errored:fix(pf.errored) };
    });
  };
  // Reorder the account folders themselves.
  const onReorderAccounts = (nextAccounts) => setAccounts(nextAccounts);

  const addTicker    = (t)=>{ const T=normalizeTicker(t); if(T) setWatchlist(w=>w.includes(T)?w:[...w,T]); };
  const removeTicker = (t)=> setWatchlist(w=>w.filter(x=>x!==t));
  const toggleWatch  = (t)=>{ const T=normalizeTicker(t); setWatchlist(w=>w.includes(T)?w.filter(x=>x!==T):[...w,T]); };
  const openFinancials = (t) => { const T=normalizeTicker(t); if(T){ setDetail(null); setFinancialsTicker(T); setTab("financials"); } };
  const saveScreen   = ({ name, mode, filters }) => setSavedScreens(s => [...s.filter(x=>x.name!==name), { name, mode, filters }]);
  const deleteScreen = (name) => setSavedScreens(s => s.filter(x=>x.name!==name));
  const onAlertNavigate = (link) => {
    if (!link) return;
    if (link.startsWith("ticker:")) { setDetail(link.slice(7)); }
    else if (link === "portfolio")  { setDetail(null); setTab("portfolio"); }
    else if (link === "macro")      { setDetail(null); setTab("brief"); }
  };
  const [wlDrag, setWlDrag] = useState(null);
  const [wlRange, setWlRange] = useState("1m");   // shared sparkline timeframe for all watchlist cards
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
          <TickerInput style={{ flex:"1 1 180px", maxWidth:420 }} extra={watchlist}
            placeholder="Research any ticker or crypto — e.g. NVDA, TSLA, BTC, ETH"
            onPick={(t)=>{ const T=normalizeTicker(t)||t; if(T) setDetail(T); }}/>
          <div style={{ display:"flex", gap:2, background:C.panel, borderRadius:9, padding:3, border:`1px solid ${C.line}`, flexShrink:0, flexWrap:"wrap" }}>
            {[["watchlist","Watchlist"],["portfolio","Portfolio"],["financials","Financials"],["brief","Brief"],["map","Map"]].map(([id,label])=>(
              <button key={id} onClick={()=>{ setDetail(null); setTab(id); }}
                style={{ padding:"6px 14px", borderRadius:6, border:"none", cursor:"pointer", fontSize:12.5, fontWeight:500,
                  background: !detail && tab===id ? C.line : "transparent",
                  color:      !detail && tab===id ? C.ink  : C.sub }}>{label}</button>
            ))}
          </div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0, marginLeft:"auto" }}>
            {profile && (
              <div onClick={()=>setShowProfile(true)} title="Edit Trader Profile" style={{ display:"flex", alignItems:"center", gap:6, background:C.panel, border:`1px solid ${C.line}`, borderRadius:8, padding:"5px 10px", cursor:"pointer" }}>
                <span style={{ fontSize:10.5, color:C.cold, fontWeight:700 }}>
                  {({conservative:"🛡️",moderate:"⚖️",aggressive:"⚡",degen:"🔥"}[profile.riskTolerance]||"👤")}
                </span>
                <span style={{ fontSize:10.5, color:C.sub, whiteSpace:"nowrap", display:"none", minWidth:0 }} className="profile-label">
                  {({conservative:"Conservative",moderate:"Moderate",aggressive:"Aggressive",degen:"Degen"}[profile.riskTolerance]||"?")} · {(Array.isArray(profile.style)?profile.style:[profile.style]).map(s=>({longterm:"Long-Term",swing:"Swing",options:"Options",daytrader:"Day"}[s]||"?")).join("+")}
                </span>
              </div>
            )}
            {showProfile && <TraderProfileModal profile={profile} onSave={p=>{ setProfile(p); }} onClose={()=>setShowProfile(false)}/>}
            <SettingsMenu theme={theme} setTheme={setTheme} aiEnabled={aiEnabled} setAiEnabled={setAiEnabled} userEmail={userEmail} onProfileOpen={()=>setShowProfile(true)}/>
            <AlertsBell alertHistory={alertHistory} setAlertHistory={setAlertHistory} onNavigate={onAlertNavigate}/>
          </div>
        </div>
      </div>
      <MacroRibbon/>

      {/* ── Content area ─────────────────────────────────────── */}
      {detail ? (
        <DetailPage ticker={detail} onBack={()=>setDetail(null)} inWatchlist={watchlist.includes(detail)} onToggleWatch={toggleWatch} aiEnabled={aiEnabled} onFinancials={openFinancials} profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}/>
      ) : (
        <div style={{ maxWidth:1180, margin:"0 auto", padding:"16px 14px 60px" }}>
          {tab==="watchlist" && (
            <div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
                <div>
                  <div style={{ fontSize:16, fontWeight:700, color:C.ink }}>My Watchlist</div>
                  <div style={{ fontSize:12, color:C.faint, marginTop:2 }}>{watchlist.length} stocks · live data · tap to open · drag to reorder</div>
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  {/* Master timeframe — sets the sparkline range on every card at once */}
                  {watchlist.length>0 && (
                    <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:10, color:C.faint, letterSpacing:"0.05em" }}>CHART</span>
                      <div style={{ display:"flex", gap:1, background:C.panel, borderRadius:8, padding:2, border:`1px solid ${C.line}` }}>
                        {SPARK_RANGES.map(r => (
                          <button key={r.key} onClick={()=>setWlRange(r.key)}
                            style={{ background:wlRange===r.key?C.line:"transparent", border:"none", borderRadius:6,
                              padding:"5px 10px", color:wlRange===r.key?C.ink:C.sub,
                              fontSize:11, fontFamily:C.mono, fontWeight:700, cursor:"pointer" }}>
                            {r.key.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <AddInline onAdd={addTicker}/>
                </div>
              </div>

              {/* Tactical setups strip — mean reversion filtered by trend.
                  Dips-in-uptrend (buy-the-dip) first, then falling-knife warnings. */}
              {(()=>{
                const dips  = watchlist.filter(t => cardCache[t]?.tactical?.key === "dip_in_uptrend");
                const knives= watchlist.filter(t => cardCache[t]?.tactical?.key === "falling_knife");
                if (!dips.length && !knives.length) return null;
                const pill = (t, col, tip) => (
                  <div key={t} onClick={()=>setDetail(t)} title={tip} style={{ cursor:"pointer", display:"flex", alignItems:"center", gap:7, background:`${col}12`, border:`1px solid ${col}40`, borderRadius:7, padding:"5px 12px" }}>
                    <span style={{ fontWeight:700, fontSize:12.5, color:C.ink }}>{displaySym(t)}</span>
                    <span style={{ fontFamily:C.mono, fontSize:10.5, color:col, fontWeight:700 }}>RSI {cardCache[t].rsi}</span>
                  </div>
                );
                return (
                  <div style={{ marginBottom:14, background:C.panel, border:`1px solid ${C.line}`, borderRadius:12, padding:"12px 18px", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                    <span title="Oversold names, split by trend: buy-the-dip = still above the 200-day; falling knife = below it." style={{ fontSize:11, fontWeight:600, color:C.sub, letterSpacing:"0.06em", flexShrink:0, cursor:"help" }}>TACTICAL SETUPS ⓘ</span>
                    {dips.length>0 && <span style={{ fontSize:10.5, color:C.up, fontWeight:700 }}>BUY-THE-DIP</span>}
                    {dips.map(t=>pill(t, C.up, cardCache[t].tactical.note))}
                    {knives.length>0 && <span style={{ fontSize:10.5, color:C.down, fontWeight:700, marginLeft:dips.length?6:0 }}>FALLING KNIFE</span>}
                    {knives.map(t=>pill(t, C.down, cardCache[t].tactical.note))}
                  </div>
                );
              })()}

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
                        <span style={{ fontWeight:700, fontSize:12.5, color:C.ink }}>{displaySym(t)}</span>
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
                      <WatchCard ticker={t} onOpen={setDetail} onRemove={removeTicker} aiEnabled={aiEnabled} onData={handleCardData} range={wlRange} onFinancials={openFinancials} profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}/>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {tab==="portfolio" && <PortfolioPage positions={positions} data={portfolio} err={pfErr} loading={pfLoading} margin={margin} marginRate={marginRate} onMargin={onMargin} cash={cash} onCash={onCash} totalCash={totalCash} totalMargin={totalMargin} blendedRate={blendedRate} aiEnabled={aiEnabled} profile={profile} onAdd={addPosition} onUpdate={updatePosition} onRemove={removePosition} onReorder={reorderPosition} onRefresh={()=>valuePortfolio(positions, totalMargin, blendedRate)} onOpen={setDetail} accounts={accounts} accountCollapsed={accountCollapsed} onAddAccount={addAccount} onRenameAccount={renameAccount} onDeleteAccount={deleteAccount} onToggleAccountCollapse={toggleAccountCollapse} onReorderPositions={onReorderPositions} onReorderAccounts={onReorderAccounts} onSetFunds={setAccountFunds}/>}
          {tab==="financials" && <FinancialsPage initialTicker={financialsTicker} watchlist={watchlist} aiEnabled={aiEnabled}
            profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}
            savedScreens={savedScreens} onSaveScreen={saveScreen} onDeleteScreen={deleteScreen} onOpenDetail={setDetail}/>}
          {tab==="brief" && (
            <div>
              {/* Decision first: the agent's brief. Evidence below: the full market intelligence. */}
              <MarketBriefSection userId={userId} positions={positions} watchlist={watchlist} aiEnabled={aiEnabled}
                profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}/>
              <BriefingRoom/>
            </div>
          )}
          {tab==="map" && <SectorMap watchlist={watchlist} cardCache={cardCache} onOpen={setDetail}/>}
        </div>
      )}
      <ChatAssistant aiEnabled={aiEnabled} watchlist={watchlist} portfolio={portfolio?.positions}
        profile={profile ? `${profile.riskTolerance}|${profile.goal}|${profile.style}|${profile.level}` : ""}/>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function AddInline({ onAdd }) {
  const [open,setOpen]=useState(false);
  if(!open) return <button onClick={()=>setOpen(true)} style={{ background:C.panel, border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 13px", color:C.sub, cursor:"pointer", display:"flex", gap:6, alignItems:"center", fontSize:12.5 }}><Plus size={14}/> Add stock / crypto / metal</button>;
  return (
    <div style={{ display:"flex", gap:6, alignItems:"center" }}>
      <TickerInput autoFocus placeholder="NVDA, BTC, GLD…" style={{ width:220 }}
        inputStyle={{ border:`1px solid ${C.cold}`, textTransform:"uppercase" }}
        onPick={(t)=>{ onAdd(t); setOpen(false); }}/>
      <button onClick={()=>setOpen(false)} style={{ background:"none", border:`1px solid ${C.line}`, borderRadius:9, padding:"8px 11px", color:C.faint, cursor:"pointer" }}><X size={14}/></button>
    </div>
  );
}
