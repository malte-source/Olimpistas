"use strict";
// Tanda de victorias rápidas de UX: saltar al contenido, foco, buscador global, detalle lateral, barra de pujas y métricas reales.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });

test("todas las páginas tienen enlace para saltar al contenido que apunta a un destino que existe", () => {
  for (const [f, id] of [["socio", "main"], ["index", "main"], ["comercio", "main"], ["pena", "wrap"], ["admin", "main"]]) {
    const h = leer("public", f + ".html");
    assert.match(h, new RegExp('class="skip-link" href="#' + id + '"'), f + ": enlace");
    assert.match(h, new RegExp('id="' + id + '"[^>]*tabindex="-1"'), f + ": destino con foco programático");
  }
  assert.match(leer("public", "socio.html"), /<main class="wrap" id="main"/, "el contenido del socio es <main>");
  assert.match(leer("public", "index.html"), /<main id="main"[\s\S]*<\/main>\s*<footer/, "la landing envuelve su contenido en <main>");
  assert.match(leer("public", "css", "styles.css"), /\.skip-link:focus \{ transform: none/);
});

test("al cambiar de pantalla el foco va al título y el título de la pestaña acompaña; no se roba el foco en la primera carga", () => {
  const s = leer("public", "js", "socio.js");
  assert.match(s, /_enfocarTitulo = !opts\.fromRoute/);
  assert.match(s, /document\.title = txt \+ " — Olimpistas"/);
  assert.match(s, /t\.tabIndex = -1; try \{ t\.focus\(\{ preventScroll: true \}\)/);
});

test("formularios con teclado correcto: cédula numérica con ir, correo sin mayúsculas ni corrector, nombres con mayúscula", () => {
  assert.match(leer("public", "js", "common.js"), /id="mdlCed" type="text" inputmode="numeric" pattern="\[0-9\]\*" enterkeyhint="go"/);
  const o = leer("public", "js", "onboarding.js");
  assert.match(o, /id="obEmail" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false"/);
  assert.match(o, /id="obNombre"[^>]*autocapitalize="words"/);
  assert.match(leer("public", "js", "socio.js"), /id="upCedula" type="text" inputmode="numeric" pattern="\[0-9\]\*" enterkeyhint="go"/);
  assert.match(leer("public", "css", "styles.css"), /@media \(pointer: coarse\) \{\s*\.btn, \.bx-chip, \.ctl-seg-b/);
});

test("buscador global: Ctrl/Cmd+K, combobox accesible con foco atrapado, pantallas, acciones y beneficios; la app expone la navegación", () => {
  const p = leer("public", "js", "paleta.js");
  assert.match(p, /\(e\.ctrlKey \|\| e\.metaKey\)[\s\S]*"k"/);
  for (const k of ['role="combobox"', 'role="listbox"', 'role="dialog" aria-modal="true"', "aria-activedescendant", 'e.key === "Escape"', 'e.key === "Tab"']) assert.ok(p.includes(k), k);
  assert.match(leer("public", "socio.html"), /id="sideBuscar"[^>]*aria-keyshortcuts="Control\+K Meta\+K"/);
  assert.match(leer("public", "socio.html"), /<script src="\/js\/paleta\.js/);
  const s = leer("public", "js", "socio.js");
  assert.match(s, /window\.OLI\.nav = \{[\s\S]*ir:[\s\S]*verBeneficio:[\s\S]*validarSocio:[\s\S]*esSocio:[\s\S]*logout:/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["pal_ph", "pal_sin", "pal_qr", "pal_persona", "pal_salir", "pal_perfil", "skip_main", "bx_detalle"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
});

test("beneficios en escritorio: el detalle abre en el panel lateral (maestro y detalle) y en el celular sigue la hoja", () => {
  const s = leer("public", "js", "socio.js");
  assert.match(s, /id="bxDetalle"/);
  assert.match(s, /window\.matchMedia\("\(min-width: 1180px\)"\)\.matches \? view\(\)\.querySelector\("#bxDetalle"\) : null/);
  assert.match(s, /\(\{ root, close \} = OLI\.modal\(html\)\)/);
  assert.match(s, /setAttribute\("aria-current", "true"\)/);
});

test("subasta en el celular: la barra de acciones queda fija sobre las pestañas y el chat se corre", () => {
  const c = leer("public", "css", "styles.css");
  assert.match(c, /#subAcciones \{ position: sticky; bottom: calc\(72px/);
  assert.match(c, /body\.en-puja \.atc-fab \{ display: none; \}/);
  const s = leer("public", "js", "socio.js");
  assert.match(s, /document\.body\.classList\.add\("en-puja"\)/);
  assert.match(s, /function stopSub\(\) \{ document\.body\.classList\.remove\("en-puja"\)/);
});

test("métricas reales: el cliente muestrea y manda por beacon; la ruta valida, guarda y no devuelve nada", async () => {
  const v = leer("public", "js", "vitales.js");
  assert.match(v, /Math\.random\(\) > 0\.2/);
  assert.match(v, /sendBeacon\("\/api\/vitales"/);
  assert.ok(!/cedula|email|password/i.test(v), "no toca datos personales");
  for (const f of ["socio", "index"]) assert.match(leer("public", f + ".html"), /js\/vitales\.js/);

  const ok = await api("/vitales", { metodo: "POST", cuerpo: { p: "beneficios", lcp: 1800, inp: 120, cls: 0.02, fcp: 900, ttfb: 300, d: "movil", c: "4g" } });
  assert.strictEqual(ok.status, 204);
  await api("/vitales", { metodo: "POST", cuerpo: { p: "beneficios", lcp: 2600, inp: 220, cls: 0.1, fcp: 1000, ttfb: 500, d: "movil", c: "4g" } });
  await api("/vitales", { metodo: "POST", cuerpo: { p: "no-existe", lcp: 99999999, cls: -1, d: "tv" } });   // fuera de rango: se descarta; sin números válidos no se guarda
  await new Promise((x) => setTimeout(x, 50));
  const sin = await api("/admin/vitales");
  assert.ok([401, 403].includes(sin.status), "el resumen es solo para admin");
  const r = await (await api("/admin/vitales?dias=7", { h: { "x-admin-key": "clave-admin-de-prueba" } })).json();
  const fila = r.filas.find((f) => f.pagina === "beneficios" && f.dispositivo === "movil");
  assert.ok(fila && fila.n === 2, "dos mediciones válidas en beneficios/móvil");
  assert.ok(fila.lcp_p75 >= 1800 && fila.lcp_p75 <= 2600);
  assert.ok(!r.filas.some((f) => f.pagina === "otra"), "lo inválido no se guardó");
});

test("migración 0015: tabla de métricas sin datos personales, aditiva", () => {
  const m = leer("migraciones", "0015_vitales_ux.sql");
  assert.match(m, /CREATE TABLE IF NOT EXISTS public\.vitales_ux/);
  assert.ok(!/cedula|email|ip\b/i.test(m.replace(/--.*$/gm, "")), "sin columnas personales");
  assert.ok(!/DROP|TRUNCATE/i.test(m));
});
