import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getUser, clearSession, onSessionLost } from './api'
import type { AuthUser } from '@shared/types'
import Login from './Login'
import Inbox from './Inbox'

/**
 * Sesión y caché (Hito B1).
 *
 * EL AGUJERO QUE ESTO CIERRA. `api.ts` borraba el token del almacenamiento al recibir un 401,
 * pero el usuario en memoria (`useState(getUser())`) se quedaba como estaba: la pantalla
 * seguía mostrando la bandeja del vendedor con la sesión muerta, sin que nada nitriciera,
 * y las consultas en vuelo seguían escribiendo en la caché con datos de una sesión que ya no
 * existía. Al volver a entrar como OTRO vendedor, React QueryServía las claves viejas
 * (`['leads']`, `['conv', 12]`) hasta que el refetch respondía: durante esa ventana el
 * vendedor veía conversaciones de otro.
 *
 * AQUÍ:
 *   · El 401 y el logout pasan por un aviso común (`onSessionLost`), no por un borrado
 *     silencioso: la app vuelve al login.
 *   · Al cambiar de sesión se cancelan las consultas en vuelo y se limpia la caché, para
 *     que ninguna respuesta tardía pueda pintar datos de la sesión anterior.
 *   · Las claves de consulta llevan el ámbito de sesión (tenant + usuario) — ver
 *     `claveDeCache` en api.ts — así dos sesiones nunca comparten espacio.
 */
export default function App() {
  const [user, setUser] = useState<AuthUser | null>(getUser)
  const qc = useQueryClient()

  useEffect(() => {
    return onSessionLost(() => {
      // Cancelar antes de limpiar: una consulta en vuelo no debe terminar escribiendo su
      // respuesta en una caché que ya se vació (y, con la clave por sesión, tampoco en la
      // caché de la sesión siguiente).
      qc.cancelQueries()
      qc.clear()
      setUser(null)
    })
  }, [qc])

  function logout() {
    clearSession('logout')
    // clearSession ya avisó a los oyentes; el estado local se limpia igual para que la
    // pantalla responda aunque el evento se emitiera antes de montar este efecto.
    qc.cancelQueries()
    qc.clear()
    setUser(null)
  }

  if (!user) return <Login onLogin={setUser} />
  return <Inbox user={user} onLogout={logout} />
}