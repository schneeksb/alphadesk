import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { authEnabled } from './lib/supabase'
import { useSession, LoginScreen } from './Auth.jsx'

function Root() {
  const session = useSession()
  if (!authEnabled) return <App userId={null} userEmail={null} />
  if (session === undefined) return null
  if (!session) return <LoginScreen />
  return <App userId={session.user.id} userEmail={session.user.email} />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
