#!/usr/bin/env python3
# deep/flujos/explorar_flujos.py  ·  v2 (detección de login por URL + log a archivo)
# ─────────────────────────────────────────────────────────────────────────────
# Inventaria los MÓDULOS y la ARQUITECTURA del dashboard de flujosinteligentes.com
# (encargo del dueño, Ángel, para estudiar y mejorar/migrar la plataforma).
# Levanta estructura (módulos, pantallas, endpoints), NO datos de clientes.
#
# TÚ te logueas a mano; el script detecta SOLO cuando llegas a tu /dashboard/ y
# recién ahí recorre. Todo queda logueado en deep/flujos/log.txt por si algo falla.
#
# Correr desde la terminal:
#   python C:\Users\HP\Documents\wsp_back\deep\flujos\explorar_flujos.py
# ─────────────────────────────────────────────────────────────────────────────

import json
import re
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urljoin, urlparse

# Windows: consola cp1252 no imprime emojis y tumba el script → forzar UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

OUT = Path(__file__).parent
CAPS = OUT / "capturas"
LOGF = OUT / "log.txt"

_logfile = open(LOGF, "w", encoding="utf-8")


def log(msg=""):
    """Imprime en consola Y guarda en log.txt (para diagnosticar aunque se cierre)."""
    line = str(msg)
    try:
        print(line)
    except Exception:
        print(line.encode("ascii", "replace").decode())
    try:
        _logfile.write(line + "\n")
        _logfile.flush()
    except Exception:
        pass


try:
    from playwright.sync_api import sync_playwright
except ImportError:
    log("❌ Falta Playwright. Instala:\n   pip install playwright\n   python -m playwright install chromium")
    sys.exit(1)

BASE = "https://www.flujosinteligentes.com"
# La zona autenticada. Cuando la URL contenga uno de estos, ya estás DENTRO.
SEÑALES_DENTRO = ("dashboard", "/panel", "/app", "/inicio-app")

# Tu perfil de Chrome (para usar TU sesión ya logueada). Debes cerrar Chrome antes
# de correr, o el perfil está bloqueado. Se usa un directorio de PERFIL específico.
USER_DATA_DIR = r"C:\Users\HP\AppData\Local\Google\Chrome\User Data"

endpoints = {}
modulos = []
paginas = []


def slug(url: str) -> str:
    p = urlparse(url).path.strip("/").replace("/", "_") or "home"
    return re.sub(r"[^a-zA-Z0-9_\-]", "", p)[:60]


def registrar_respuesta(resp):
    """Solo metadata de las llamadas a la API (arquitectura), NO datos de clientes."""
    try:
        url = resp.url
        if not re.search(r"/(api|graphql|v\d|rest|trpc)/", url, re.I):
            return
        ruta = urlparse(url).path
        key = f"{resp.request.method} {ruta}"
        e = endpoints.setdefault(key, {"count": 0, "status": resp.status, "sample_keys": []})
        e["count"] += 1
        e["status"] = resp.status
        if not e["sample_keys"] and "application/json" in (resp.headers.get("content-type") or ""):
            try:
                data = resp.json()
                node = data[0] if isinstance(data, list) and data else data
                if isinstance(node, dict):
                    e["sample_keys"] = list(node.keys())[:25]
            except Exception:
                pass
    except Exception:
        pass


def dentro(url: str) -> bool:
    u = (url or "").lower()
    if "login" in u or "signin" in u or "sign-in" in u:
        return False
    return any(s in u for s in SEÑALES_DENTRO)


def esperar_login(page, minutos=6):
    """Espera —mirando la URL del navegador— a que llegues a tu /dashboard/.
    NO usa la terminal. Devuelve True si te detecta dentro; False si vence el tiempo."""
    intentos = int(minutos * 60 / 2)
    log(f"\n⏳ Esperando tu login (hasta {minutos} min). Entra a tu dashboard; te detecto solo…")
    for i in range(intentos):
        try:
            if dentro(page.url):
                log(f"\n✅ ¡Dentro! URL: {page.url}")
                page.wait_for_timeout(2000)
                return True
        except Exception:
            pass
        if i % 15 == 0 and i > 0:
            try:
                log(f"   … sigo esperando ({(intentos - i) * 2}s). URL actual: {page.url}")
            except Exception:
                pass
        time.sleep(2)
    return False


def guardar():
    (OUT / "modulos.json").write_text(json.dumps(modulos, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "endpoints.json").write_text(json.dumps(endpoints, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "paginas.json").write_text(json.dumps(paginas, indent=2, ensure_ascii=False), encoding="utf-8")
    md = ["# Flujos Inteligentes — inventario de módulos\n"]
    md.append(f"## Módulos del menú ({len(modulos)})\n")
    for m in modulos:
        md.append(f"- **{m['nombre']}** → `{urlparse(m['url']).path}`")
    md.append(f"\n## Pantallas capturadas ({len(paginas)})\n")
    for p in paginas:
        md.append(f"### {p['modulo']}  ·  `{urlparse(p['url']).path}`")
        md.append(f"- título: {p['titulo']}")
        if p["headings"]:
            md.append(f"- secciones: {', '.join(p['headings'][:12])}")
        md.append(f"- captura: `{p['screenshot']}`\n")
    md.append(f"\n## Endpoints de la API detectados ({len(endpoints)})\n")
    for k, v in sorted(endpoints.items()):
        campos = f" · campos: {', '.join(v['sample_keys'])}" if v["sample_keys"] else ""
        md.append(f"- `{k}`  ({v['count']}x, status {v['status']}){campos}")
    (OUT / "estructura.md").write_text("\n".join(md), encoding="utf-8")


def recorrer(page):
    # ── 1. Inventariar el MENÚ / SIDEBAR (los módulos) ──
    log("\n🔎 Levantando el menú de módulos…")
    page.wait_for_timeout(1500)
    links = page.eval_on_selector_all(
        "nav a, aside a, [role=navigation] a, .sidebar a, .menu a, a[href^='/']",
        """els => els.map(a => ({
            nombre: (a.innerText || a.getAttribute('aria-label') || '').trim().split('\\n')[0],
            href: a.getAttribute('href')
        }))"""
    )
    vistos = set()
    for l in links:
        href = (l.get("href") or "").strip()
        if not href or href.startswith("#") or href.startswith("http") or href in vistos:
            continue
        # solo rutas internas de la zona app (evita marketing como /precios)
        vistos.add(href)
        modulos.append({"nombre": l.get("nombre") or href, "url": urljoin(page.url, href)})
    log(f"   → {len(modulos)} enlaces internos detectados")

    # ── 2. Visitar cada módulo: screenshot + estructura ──
    log("\n📸 Recorriendo cada módulo…")
    rutas = [{"nombre": "dashboard_home", "url": page.url}] + modulos
    for m in rutas:
        try:
            page.goto(m["url"], wait_until="networkidle", timeout=20000)
        except Exception:
            try:
                page.goto(m["url"], wait_until="domcontentloaded", timeout=20000)
            except Exception as e:
                log(f"   ⚠️  no pude abrir {m['url']}: {e}")
                continue
        page.wait_for_timeout(1200)
        nombre = slug(m["url"])
        shot = CAPS / f"{nombre}.png"
        try:
            page.screenshot(path=str(shot), full_page=True)
        except Exception:
            try:
                page.screenshot(path=str(shot))
            except Exception:
                pass
        try:
            titulo = page.title()
            headings = page.eval_on_selector_all(
                "h1, h2, h3, [class*=title], [class*=heading]",
                "els => els.slice(0,20).map(e => (e.innerText||'').trim()).filter(Boolean)"
            )
        except Exception:
            titulo, headings = "", []
        paginas.append({
            "modulo": m["nombre"], "url": m["url"], "titulo": titulo,
            "headings": headings[:20], "screenshot": f"capturas/{nombre}.png"
        })
        log(f"   ✅ {m['nombre'] or nombre}  → {shot.name}")


def captura_una(page, m_nombre=None):
    """Captura la pantalla actual: screenshot full-page + títulos/secciones."""
    url = page.url
    nombre = slug(url)
    shot = CAPS / f"{nombre}.png"
    try:
        page.screenshot(path=str(shot), full_page=True)
    except Exception:
        try:
            page.screenshot(path=str(shot))
        except Exception:
            pass
    try:
        titulo = page.title()
        headings = page.eval_on_selector_all(
            "h1, h2, h3, [class*=title], [class*=heading]",
            "els => els.slice(0,25).map(e => (e.innerText||'').trim()).filter(Boolean)"
        )
    except Exception:
        titulo, headings = "", []
    paginas.append({"modulo": m_nombre or (headings[0] if headings else nombre),
                    "url": url, "titulo": titulo,
                    "headings": headings[:25], "screenshot": f"capturas/{nombre}.png"})
    if url not in [m["url"] for m in modulos]:
        modulos.append({"nombre": m_nombre or (headings[0] if headings else nombre), "url": url})
    log(f"   📸 {url}   ({(titulo or '')[:45]})")


def captura_guiada(page, minutos=8):
    """TÚ navegas por los módulos; el script captura cada pantalla nueva sola.
    Robusto para SPA: no adivina el menú, solo captura lo que visitas."""
    log("\n" + "─" * 70)
    log("  🎬  MODO CAPTURA GUIADA")
    log("  Haz clic por CADA módulo del menú (Inbox, Leads, Productos, Pedidos, Config…).")
    log(f"  El script captura cada pantalla nueva SOLO. Tienes ~{minutos} min.")
    log("  Cuando termines, cierra el navegador (o espera a que acabe el tiempo).")
    log("─" * 70 + "\n")
    vistas = set()
    try:
        captura_una(page, "dashboard")
        vistas.add(page.url.split("?")[0])
    except Exception:
        pass
    fin = time.time() + minutos * 60
    while time.time() < fin:
        try:
            u = page.url.split("?")[0]
        except Exception:
            log("   (cerraste el navegador) — termino la captura.")
            break
        if u not in vistas:
            vistas.add(u)
            page.wait_for_timeout(1500)   # deja cargar el contenido del módulo
            try:
                captura_una(page)
            except Exception:
                pass
        time.sleep(1)
    log(f"\n   ✅ Captura guiada terminada: {len(vistas)} pantallas distintas.")


def main():
    CAPS.mkdir(exist_ok=True)
    log("═" * 70)
    log("  EXPLORADOR DE FLUJOS INTELIGENTES  ·  v2")
    log("═" * 70)
    log("\nSe abre un navegador. Solo:")
    log("  1. Inicia sesión TÚ MISMO (tus datos van directo a Flujos).")
    log("  2. Entra a tu dashboard. El script te detecta SOLO — no toques la terminal.")
    log("  3. Recorre los módulos y guarda todo en deep/flujos/.\n")

    with sync_playwright() as pw:
        # Navegador LIMPIO (el perfil real ya no se puede automatizar: Chrome moderno
        # bloquea el remote-debugging sobre el perfil por defecto). Como cerramos todos
        # tus Chrome antes, ESTA será la ÚNICA ventana → imposible confundirse.
        browser = pw.chromium.launch(headless=False, args=["--start-maximized"])
        ctx = browser.new_context(viewport=None)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on("response", registrar_respuesta)

        try:
            page.goto(BASE + "/dashboard/", wait_until="domcontentloaded", timeout=30000)
        except Exception:
            try:
                page.goto(BASE, wait_until="domcontentloaded", timeout=30000)
            except Exception:
                pass

        # Login manual en ESTA ventana (la única abierta). Tras loguearte, entras a /dashboard.
        ok = esperar_login(page, minutos=15)
        if not ok:
            log("\n⚠️ No detecté el dashboard en 15 min.")
            log(f"   Última URL vista: {page.url}")
        else:
            # MODO CAPTURA GUIADA: TÚ haces clic por cada módulo del menú; el script
            # captura cada pantalla nueva sola. Robusto para SPA (no adivina el menú).
            try:
                captura_guiada(page, minutos=8)
            except Exception:
                log("\n⚠️ La captura se cortó. Traceback:")
                log(traceback.format_exc())

        try:
            guardar()
        except Exception:
            log("⚠️ error guardando:")
            log(traceback.format_exc())

        log("\n🕒 Cierro en 15s…")
        try:
            page.wait_for_timeout(15000)
        except Exception:
            pass
        try:
            browser.close()
        except Exception:
            pass

    log("\n" + "═" * 70)
    log(f"  LISTO. Revisa deep/flujos/:")
    log(f"     · capturas/     ({len(paginas)} screenshots)")
    log(f"     · estructura.md (resumen para estudiar)")
    log(f"     · log.txt       (esto mismo, por si necesitas mandármelo)")
    log("═" * 70)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log("\n❌ ERROR GENERAL. Traceback completo:")
        log(traceback.format_exc())
    finally:
        try:
            _logfile.close()
        except Exception:
            pass
        # Pausa final para que la ventana NO se cierre de golpe (verás el resultado).
        try:
            input("\n[ENTER para cerrar esta ventana] ")
        except Exception:
            time.sleep(15)
