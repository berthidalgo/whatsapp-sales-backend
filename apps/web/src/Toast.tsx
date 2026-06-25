// Sistema de toasts liviano (cero dependencia): provider + hook + container.
// Resuelve el bug de "errores tragados en silencio" — una acción que falla (responder,
// reasignar, etc.) ahora le avisa al vendedor en vez de fingir que funcionó.
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

type ToastType = 'error' | 'success' | 'info'
interface ToastItem { id: number; msg: string; type: ToastType }

// El value es la función `show(msg, type)`. Default no-op para usos fuera del provider.
const ToastCtx = createContext<(msg: string, type?: ToastType) => void>(() => {})

export function useToast() { return useContext(ToastCtx) }

let seq = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])

  const dismiss = useCallback((id: number) => setItems(xs => xs.filter(t => t.id !== id)), [])

  const show = useCallback((msg: string, type: ToastType = 'error') => {
    const id = ++seq
    setItems(xs => [...xs, { id, msg, type }])
    setTimeout(() => dismiss(id), 4000)  // auto-cierra; también se puede cerrar al click
  }, [dismiss])

  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-wrap">
        {items.map(t => (
          <div key={t.id} className={`toast toast-${t.type}`} role="alert" onClick={() => dismiss(t.id)}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
