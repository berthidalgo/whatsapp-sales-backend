import { useEffect, useState } from 'react'
import { api, saveSession, type VendorLite } from './api'
import type { AuthUser } from '@shared/types'

export default function Login({ onLogin }: { onLogin: (u: AuthUser) => void }) {
  const [vendors, setVendors] = useState<VendorLite[]>([])
  const [sel, setSel] = useState<VendorLite | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    api.vendors().then(setVendors).catch(() => setError('No se pudo conectar al servidor'))
  }, [])

  async function submit(p = pin) {
    if (!sel || p.length !== 4) return
    setLoading(true); setError('')
    try {
      const r = await api.login(sel.nombre, p)
      saveSession(r.token, r.vendor)
      onLogin(r.vendor)
    } catch {
      setError('PIN incorrecto'); setPin('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-logo">H</div>
        <h1 className="login-title">Hidata — Sales OS</h1>

        {!sel ? (
          <>
            <p className="login-sub">Selecciona tu perfil</p>
            <div className="vendor-list">
              {vendors.map(v => (
                <button key={v.id} className="vendor-btn" onClick={() => { setSel(v); setPin(''); setError('') }}>
                  <span className="vendor-av" style={{ background: v.color }}>{v.initials}</span>
                  <span className="vendor-name">{v.nombre}</span>
                  <span className="vendor-role">{v.role === 'ADMIN' ? 'Admin' : 'Asesor'}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="login-sub">PIN de {sel.nombre}</p>
            <input
              className="pin-input"
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              maxLength={4}
              placeholder="••••"
              onChange={e => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 4)
                setPin(v)
                if (v.length === 4) void submit(v)
              }}
            />
            <button className="link-btn" onClick={() => { setSel(null); setError('') }}>← cambiar</button>
          </>
        )}

        {error && <div className="login-error">{error}</div>}
        {loading && <div className="login-sub">Verificando…</div>}
      </div>
    </div>
  )
}
