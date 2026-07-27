# Explorador de Flujos Inteligentes

Herramienta para inventariar los **módulos** y la **arquitectura** del dashboard de
flujosinteligentes.com — encargo del dueño (Ángel) para estudiar y mejorar/migrar la
plataforma. Levanta estructura (módulos, pantallas, endpoints de API), no datos de clientes.

## Cómo se usa (2 minutos)

```bash
# 1. Instalar Playwright (una sola vez)
pip install playwright
python -m playwright install chromium

# 2. Correr el explorador
python deep/flujos/explorar_flujos.py
```

Se abre un navegador. **Tú te logueas a mano** en la página (tus credenciales van
directo a Flujos — el script no las pide ni las guarda). Cuando ya estés dentro,
vuelves a la terminal y presionas ENTER. El script recorre todos los módulos solo.

## Qué te deja en `deep/flujos/`

| Archivo | Qué es |
|---|---|
| `capturas/*.png` | Screenshot de cada módulo (para ver el diseño) |
| `modulos.json` | Lista de módulos del menú (nombre + ruta) |
| `endpoints.json` | Llamadas a la API que hace el front (arquitectura) |
| `paginas.json` | Título + secciones de cada pantalla |
| `estructura.md` | Resumen legible de todo, para estudiar |

## Notas

- **Privacidad:** las capturas pueden contener datos de clientes de Flujos. Esta carpeta
  está en `.gitignore` → no se sube a GitHub. Úsalas solo para el estudio.
- **Enfoque limpio:** estudiamos la FUNCIONALIDAD (qué módulos hay, cómo se organiza)
  para construir lo nuestro mejor — no copiamos su código/diseño 1:1.
- Si el login o el menú tienen una estructura rara y el script no detecta bien los
  módulos, pásame el `estructura.md` (o dime qué salió) y ajusto los selectores.
