// Metricas.tsx — Actividad y resultado con su definición a la vista (Hito B4).
//
// POR QUÉ CADA TARJETA DICE QUÉ CUENTA. Un panel sin definición se cita mal: alguien lee
// "3 ventas" y toma decisiones (comisiones, presupuesto de ads) sobre una cifra que en
// realidad contaba otra cosa. Aquí el número va con su fuente y, cuando no hay dato, se
// escribe "no disponible" y por qué. Nada se estima ni se rellena.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, claveDeCache } from './api'
import type { AuthUser } from '@shared/types'

export default function Metricas({ user }: { user: AuthUser }) {
  const [dias, setDias] = useState(30)
  const scope = claveDeCache(user)
  const q = useQuery({ queryKey: scope.concat('metricas', dias), queryFn: () => api.metricas(dias) })

  if (q.isLoading) return <div className="placeholder">Cargando métricas…</div>
  if (q.isError) return <div className="placeholder">No se pudieron cargar las métricas. <button className="btn" onClick={() => void q.refetch()}>Reintentar</button></div>

  const datos = q.data!
  return (
    <div className="metricas">
      <header className="metricas-head">
        <h2>📊 Actividad y resultado</h2>
        <div className="metricas-controls">
          <select className="btn" value={dias} onChange={e => setDias(Number(e.target.value))}>
            <option value={7}>Últimos 7 días</option>
            <option value={30}>Últimos 30 días</option>
            <option value={90}>Últimos 90 días</option>
          </select>
          <span className="metricas-scope">
            {datos.alcance === 'tenant' ? 'Todo tu equipo' : 'Solo tus leads'}
          </span>
        </div>
      </header>

      <div className="metricas-grid">
        {datos.metricas.map(m => (
          <div className="metrica-card" key={m.clave} title={m.definicion}>
            <div className="metrica-label">{m.clave.replace(/_/g, ' ')}</div>
            {m.valor === null || m.disponible === false
              ? <div className="metrica-valor metrica-nd">no disponible</div>
              : <div className="metrica-valor">{m.valor.toLocaleString('es-PE')} <small>{m.unidad}</small></div>}
            <div className="metrica-def">{m.definicion}</div>
            <div className="metrica-fuente">fuente: {m.fuente}</div>
            {m.valor === null && m.motivoSiNo && <div className="metrica-fuente">{m.motivoSiNo}</div>}
          </div>
        ))}
      </div>

      {datos.resultadosConfirmados.length > 0 && (
        <section className="metricas-sec">
          <h3>Resultados confirmados por el equipo</h3>
          <ul className="resultados-list">
            {datos.resultadosConfirmados.map(r => (
              <li key={r.resultado}><span>{r.resultado}</span><b>{r.total}</b></li>
            ))}
          </ul>
        </section>
      )}

      <p className="metricas-nota">{datos.nota}</p>
    </div>
  )
}