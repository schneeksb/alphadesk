import { useState, useEffect } from "react";
import { supabase, authEnabled } from "./lib/supabase";

// undefined = still loading, null = signed out, object = signed in
export function useSession() {
  const [session, setSession] = useState(authEnabled ? undefined : null);
  useEffect(() => {
    if (!authEnabled) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  return session;
}

export async function signInWithGoogle() {
  if (!supabase) return;
  await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
}

export async function signOut() {
  if (supabase) await supabase.auth.signOut();
}

// Full-screen sign-in shown when auth is enabled and the user isn't signed in.
export function LoginScreen() {
  return (
    <div style={{ minHeight:"100vh", display:"flex", alignItems:"center", justifyContent:"center",
      background:"#ffffff", fontFamily:"'Inter',system-ui,-apple-system,sans-serif", padding:"24px" }}>
      <div style={{ width:"100%", maxWidth:380, background:"#f6f8fb", border:"1px solid #dde3ec",
        borderRadius:18, padding:"34px 30px", textAlign:"center", boxShadow:"0 18px 50px rgba(16,22,32,0.08)" }}>
        <div style={{ display:"flex", alignItems:"baseline", justifyContent:"center", gap:4, letterSpacing:"-0.02em", marginBottom:6 }}>
          <span style={{ fontWeight:800, fontSize:30, color:"#101620" }}>Thrive</span>
          <span style={{ fontWeight:600, fontSize:15, color:"#586172" }}>Invest</span>
          <span style={{ color:"#e8590c", fontWeight:800, fontSize:30 }}>·</span>
        </div>
        <div style={{ fontSize:13.5, color:"#586172", marginBottom:26, lineHeight:1.5 }}>
          Sign in to access your watchlist, portfolio, and market briefings — synced across your devices.
        </div>
        <button onClick={signInWithGoogle}
          style={{ width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:10,
            background:"#ffffff", border:"1px solid #dde3ec", borderRadius:10, padding:"12px 16px",
            color:"#101620", fontSize:14, fontWeight:600, cursor:"pointer" }}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.6 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.3 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35 26.8 36 24 36c-5.3 0-9.7-3.4-11.3-8.1l-6.5 5C9.6 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.5l6.3 5.3C41.6 36 44 30.6 44 24c0-1.3-.1-2.3-.4-3.5z"/>
          </svg>
          Continue with Google
        </button>
        <div style={{ fontSize:11, color:"#9aa6b6", marginTop:20 }}>
          Your data is private to your account.
        </div>
      </div>
    </div>
  );
}
