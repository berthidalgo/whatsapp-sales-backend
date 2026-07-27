#!/usr/bin/env python3
# deep/flujos/explorar_auto.py  ·  TODO AUTOMÁTICO (auto-login + auto-recorrido)
# ─────────────────────────────────────────────────────────────────────────────
# Se loguea SOLO (con tus credenciales del archivo local .creds, que NUNCA sale de
# tu PC ni lo lee nadie más), entra al dashboard, hace clic por CADA módulo del menú
# y captura todo: screenshots + estructura + endpoints de la API de cada pantalla.
#
# TUS CREDENCIALES — crea el archivo  deep/flujos/.creds  con 2 líneas:
#     EMAIL=tucorreo@ejemplo.com
#     PASSWORD=tuclave
# (está en .gitignore → no se sube; el script lo lee solo en tu máquina)
#
# Correr:  python C:\Users\HP\Documents\wsp_back\deep\flujos\explorar_auto.py
# ─────────────────────────────────────────────────────────────────────────────

import json
import re
import sys
import time
import traceback
from pathlib import Path
from urllib.parse import urljoin, urlparse

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

OUT = Path(__file__).parent
CAPS = OUT / "capturas"
LOGF = OUT / "log_auto.txt"
CREDS = OUT / ".creds"
_logfile = open(LOGF, "w", encoding="utf-8")


def log(msg=""):
    line = str(msg)
    try:
        print(line)
    except Exception:
        print(line.encode("ascii", "replace").decode())
    try:
        _logfile.write(line + "\n"); _logfile.flush()
    except Exception:
        pass


try:
    from playwright.sync_api import sync_playwright
except ImportError:
    log("❌ Falta Playwright: pip install playwright && python -m playwright install chromium")
    sys.exit(1)

BASE = "https://www.flujosinteligentes.com"
SEÑALES_DENTRO = ("dashboard", "/panel", "/app")
endpoints, modulos, paginas = {}, [], []


def slug(url):
    p = urlparse(url).path.strip("/").replace("/", "_") or "home"
    return re.sub(r"[^a-zA-Z0-9_\-]", "", p)[:60]


def leer_creds():
    """Lee las credenciales de varios lugares y formatos posibles. El script las lee
    EN TU MÁQUINA; nunca se imprimen. Busca en .creds, y en cre.txt/cre de la raíz."""
    ROOT = OUT.parent.parent   # deep/flujos -> deep -> raíz del proyecto
    candidatos = [CREDS, ROOT / "cre.txt", ROOT / "cre", ROOT / "CRE.txt", OUT / "cre.txt"]
    archivo = next((c for c in candidatos if c.exists()), None)
    if not archivo:
        log("❌ No encontré credenciales. Crea deep/flujos/.creds o cre.txt en la raíz con:")
        log("     EMAIL=tucorreo@ejemplo.com\n     PASSWORD=tuclave")
        return None, None
    log(f"   Leyendo credenciales de: {archivo.name}")
    lineas = [l.strip() for l in archivo.read_text(encoding="utf-8", errors="ignore").splitlines() if l.strip()]
    email = pwd = None
    # Formato con claves EMAIL=/PASSWORD=
    for ln in lineas:
        if "=" in ln:
            k, v = ln.split("=", 1); k = k.strip().upper(); v = v.strip()
            if k in ("EMAIL", "CORREO", "USER", "USUARIO", "MAIL"):
                email = v
            elif k in ("PASSWORD", "PASS", "CLAVE", "CONTRASENA", "CONTRASEÑA", "PWD"):
                pwd = v
    # Fallback: detectar por contenido (la línea con @ es el email; la otra, la clave)
    if not email or not pwd:
        sin_clave = [l for l in lineas if "=" not in l or "@" in l]
        correo = next((l.split("=")[-1].strip() for l in lineas if "@" in l), None)
        if correo and not email:
            email = correo
        if not pwd:
            for l in lineas:
                val = l.split("=")[-1].strip()
                if val and "@" not in val and val != email:
                    pwd = val; break
    return email, pwd


def registrar_respuesta(resp):
    try:
        url = resp.url
        if not re.search(r"/(api|graphql|v\d|rest|trpc|auth|functions)/", url, re.I):
            return
        key = f"{resp.request.method} {urlparse(url).path}"
        e = endpoints.setdefault(key, {"count": 0, "status": resp.status, "sample_keys": []})
        e["count"] += 1; e["status"] = resp.status
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


def dentro(url):
    u = (url or "").lower()
    if "login" in u or "signin" in u:
        return False
    return any(s in u for s in SEÑALES_DENTRO)


def login_automatico(page, email, pwd):
    """Va a /login, rellena el formulario y entra. Selectores genéricos con fallback."""
    log("\n🔐 Login automático…")
    for url in (BASE + "/login", BASE + "/signin", BASE + "/iniciar-sesion", BASE + "/"):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=25000)
            page.wait_for_timeout(1500)
            if page.query_selector("input[type=password]"):
                break
        except Exception:
            continue

    # Campo de email
    email_sel = None
    for s in ("input[type=email]", "input[name*=email i]", "input[name*=correo i]",
              "input[id*=email i]", "input[placeholder*=correo i]", "input[placeholder*=email i]",
              "input[type=text]"):
        if page.query_selector(s):
            email_sel = s; break
    pwd_sel = "input[type=password]"
    if not email_sel or not page.query_selector(pwd_sel):
        log("   ⚠️ No encontré el formulario de login (campos email/password). URL: " + page.url)
        return False
    try:
        page.fill(email_sel, email)
        page.fill(pwd_sel, pwd)
    except Exception as e:
        log(f"   ⚠️ no pude rellenar el formulario: {e}")
        return False

    # Botón de enviar
    for bs in ("button[type=submit]", "button:has-text('Iniciar')", "button:has-text('Ingresar')",
               "button:has-text('Entrar')", "button:has-text('Login')", "button:has-text('Acceder')"):
        b = page.query_selector(bs)
        if b:
            try:
                b.click(); break
            except Exception:
                pass
    else:
        try:
            page.press(pwd_sel, "Enter")
        except Exception:
            pass

    # Esperar a estar dentro (URL estable en dashboard, 2 chequeos seguidos)
    estable = 0
    for _ in range(40):
        page.wait_for_timeout(1000)
        if dentro(page.url):
            estable += 1
            if estable >= 2:
                log(f"   ✅ Logueado. URL: {page.url}")
                return True
        else:
            estable = 0
    log(f"   ⚠️ No confirmé el login (última URL: {page.url}).")
    return False


def captura_una(page, m_nombre=None):
    url = page.url
    nombre = slug(url)
    try:
        page.screenshot(path=str(CAPS / f"{nombre}.png"), full_page=True)
    except Exception:
        try:
            page.screenshot(path=str(CAPS / f"{nombre}.png"))
        except Exception:
            pass
    try:
        titulo = page.title()
        headings = page.eval_on_selector_all(
            "h1, h2, h3, [class*=title], [class*=heading]",
            "els => els.slice(0,25).map(e => (e.innerText||'').trim()).filter(Boolean)")
    except Exception:
        titulo, headings = "", []
    paginas.append({"modulo": m_nombre or (headings[0] if headings else nombre), "url": url,
                    "titulo": titulo, "headings": headings[:25], "screenshot": f"capturas/{nombre}.png"})
    log(f"   📸 {url}   ({(titulo or '')[:45]})")


def items_menu(page):
    """Textos de los ítems del menú lateral (a, button, [role]) — para clicarlos uno a uno."""
    try:
        return page.eval_on_selector_all(
            "nav a, nav button, aside a, aside button, [role=navigation] a, [role=navigation] button, "
            "[class*=sidebar] a, [class*=sidebar] button, [class*=menu] a, [class*=menu] button",
            """els => Array.from(new Set(els
                .map(e => (e.innerText||e.getAttribute('aria-label')||'').trim().split('\\n')[0])
                .filter(t => t && t.length>1 && t.length<40)))"""
        ) or []
    except Exception:
        return []


def recorrer_auto(page, dash_url):
    log("\n🧭 Recorriendo módulos automáticamente…")
    captura_una(page, "dashboard")
    labels = items_menu(page)
    log(f"   → {len(labels)} ítems de menú detectados: {', '.join(labels[:20])}")
    vistas = {page.url.split('?')[0]}
    for txt in labels:
        # volver al dashboard antes de cada clic (evita menús que cambian de contexto)
        try:
            page.goto(dash_url, wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(800)
        except Exception:
            pass
        # clicar el ítem por su texto (primer match visible en el menú)
        try:
            loc = page.get_by_role("link", name=txt, exact=False)
            if loc.count() == 0:
                loc = page.get_by_role("button", name=txt, exact=False)
            if loc.count() == 0:
                loc = page.get_by_text(txt, exact=False)
            loc.first.click(timeout=6000)
            page.wait_for_timeout(2000)
        except Exception as e:
            log(f"   ⚠️ no pude abrir '{txt}': {str(e)[:60]}")
            continue
        u = page.url.split('?')[0]
        if u not in vistas:
            vistas.add(u)
            captura_una(page, txt)
    log(f"\n   ✅ Recorrido: {len(vistas)} pantallas distintas.")


def guardar():
    (OUT / "modulos.json").write_text(json.dumps(modulos, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "endpoints.json").write_text(json.dumps(endpoints, indent=2, ensure_ascii=False), encoding="utf-8")
    (OUT / "paginas.json").write_text(json.dumps(paginas, indent=2, ensure_ascii=False), encoding="utf-8")
    md = ["# Flujos Inteligentes — inventario AUTO\n", f"## Pantallas ({len(paginas)})\n"]
    for p in paginas:
        md.append(f"### {p['modulo']}  ·  `{urlparse(p['url']).path}`")
        md.append(f"- título: {p['titulo']}")
        if p["headings"]:
            md.append(f"- secciones: {', '.join(p['headings'][:12])}")
        md.append(f"- captura: `{p['screenshot']}`\n")
    md.append(f"\n## Endpoints ({len(endpoints)})\n")
    for k, v in sorted(endpoints.items()):
        c = f" · campos: {', '.join(v['sample_keys'])}" if v["sample_keys"] else ""
        md.append(f"- `{k}`  ({v['count']}x, {v['status']}){c}")
    (OUT / "estructura_auto.md").write_text("\n".join(md), encoding="utf-8")


def main():
    CAPS.mkdir(exist_ok=True)
    log("═" * 70); log("  EXPLORADOR AUTO — login + recorrido sin intervención"); log("═" * 70)
    email, pwd = leer_creds()
    if not email or not pwd:
        return
    log(f"   Credenciales cargadas (email: {email[:3]}***). La clave NO se registra.")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, args=["--start-maximized"])
        ctx = browser.new_context(viewport=None)
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        page.on("response", registrar_respuesta)

        try:
            if login_automatico(page, email, pwd):
                dash_url = page.url
                try:
                    recorrer_auto(page, dash_url)
                except Exception:
                    log("\n⚠️ recorrido cortado:\n" + traceback.format_exc())
            else:
                log("\n⚠️ No pude loguearme solo. Revisa .creds o el formulario cambió.")
        except Exception:
            log("\n❌ error:\n" + traceback.format_exc())
        finally:
            try:
                guardar()
            except Exception:
                log("error guardando:\n" + traceback.format_exc())
            try:
                page.wait_for_timeout(8000); browser.close()
            except Exception:
                pass

    log("\n" + "═" * 70)
    log(f"  LISTO. deep/flujos/: {len(paginas)} pantallas · {len(endpoints)} endpoints · estructura_auto.md")
    log("═" * 70)


if __name__ == "__main__":
    try:
        main()
    finally:
        try:
            _logfile.close()
        except Exception:
            pass
