import { useState } from 'react'
import { getUser, clearSession } from './api'
import type { AuthUser } from '@shared/types'
import Login from './Login'
import Inbox from './Inbox'

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(getUser())

  if (!user) return <Login onLogin={setUser} />
  return <Inbox user={user} onLogout={() => { clearSession(); setUser(null) }} />
}
