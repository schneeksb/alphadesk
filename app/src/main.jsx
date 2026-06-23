import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { authEnabled } from './lib/supabase'
import { useSession, LoginScreen } from './Auth.jsx'

function Root() {
  const session = useSession()
  if (!authEnabled) return <App />          // auth not configured → app runs as before
  if (session === undefined) return null    // still checking the session
  if (!session) return <LoginScreen />      // signed out → show login
  return <App />                            // signed in
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
