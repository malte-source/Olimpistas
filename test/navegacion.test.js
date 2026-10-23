"use strict";
// Navegabilidad: que cada página, link, atajo y ruta profunda del sitio lleve a algún lado (nada de 404 escondidos).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const leer = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");
const paginas = () => fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));

const app = require("../server");
let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const get = (ruta) => fetch(url + ruta, { redirect: "manual" });

test("las páginas del sitio responden y son HTML", async () => {
  for (const r of ["/", "/miembro", "/admin", "/comercio", "/pena", "/ayuda", "/legal", "/reset"]) {
    const x = await get(r);
    assert.strictEqual(x.status, 200, r + " debería responder 200");
    assert.match(x.headers.get("content-type") || "", /html/, r);
  }
});

test("una ruta que no existe da un 404 real con salida (link de vuelta), y /api da 404 en JSON", async () => {
  const x = await get("/no-existe-esta-pagina");
  assert.strictEqual(x.status, 404);
  assert.match(await x.text(), /href="\/"/, "el 404 tiene que ofrecer volver al inicio");
  const a = await get("/api/no-existe");
  assert.strictEqual(a.status, 404);
  assert.match(a.headers.get("content-type") || "", /json/);
});

test("rutas profundas de la app del hincha: F5 y links compartidos sirven la misma app (cada pestaña y cada segmento de Descubrir)", async () => {
  const js = leer("js/socio.js");
  const tabs = JSON.parse(js.match(/const TABS_RUTA = (\[[^\]]*\])/)[1]);
  const segs = JSON.parse(js.match(/const SEGS_RUTA = (\[[^\]]*\])/)[1]);
  assert.ok(tabs.length >= 6 && segs.length >= 4, "no se pudieron leer las rutas de socio.js");
  const rutas = ["/miembro", ...tabs.map((t) => "/miembro/" + t), ...segs.map((s) => "/miembro/descubrir/" + s), "/miembro/descubrir/subastas/lote-123"];
  for (const r of rutas) assert.strictEqual((await get(r)).status, 200, r);
});

test("atajos del manifest y URLs del sitemap existen", async () => {
  const m = JSON.parse(leer("manifest.webmanifest"));
  for (const s of m.shortcuts || []) assert.strictEqual((await get(s.url)).status, 200, "atajo " + s.url);
  assert.strictEqual((await get(m.start_url)).status, 200);
  for (const loc of leer("sitemap.xml").matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const p = new URL(loc[1]).pathname;
    assert.ok((await get(p)).status < 400, "sitemap " + p);
  }
});

test("todo lo que cargan las páginas (scripts, estilos, imágenes, íconos) existe en public/", () => {
  const faltan = [];
  for (const p of paginas()) {
    const h = leer(p);
    for (const m of h.matchAll(/(?:src|href)=["'](\/(?:assets|js|css)\/[^"'?#\s]+)/g)) {
      if (!fs.existsSync(path.join(PUBLIC, m[1]))) faltan.push(p + " → " + m[1]);
    }
  }
  assert.deepStrictEqual(faltan, []);
});

test("los links internos de cada página (href a una página del sitio) llevan a una ruta que responde", async () => {
  const rotos = [];
  const vistos = new Set();
  for (const p of paginas()) {
    for (const m of leer(p).matchAll(/<a\s[^>]*href=["'](\/[^"'#?\s]*)/g)) {
      const r = m[1];
      if (vistos.has(r) || /^\/(assets|js|css)\//.test(r)) continue;
      vistos.add(r);
      const x = await get(r);
      if (x.status >= 400) rotos.push(`${p} → ${r} (${x.status})`);
    }
  }
  assert.deepStrictEqual(rotos, []);
});

test("panel del club: cada entrada del menú tiene su sección y cada sección sale en el menú (nada huérfano)", () => {
  const h = leer("admin.html");
  const menu = [...h.matchAll(/data-area="([a-z0-9_-]+)" href="#\/([a-z0-9_-]+)"/g)];
  assert.ok(menu.length >= 8);
  for (const [, area, ruta] of menu) {
    assert.strictEqual(area, ruta, "data-area y href deben coincidir: " + area);
    assert.ok(new RegExp(`<section class="area" id="area-${area}"`).test(h), "falta la sección area-" + area);
  }
  const secciones = [...h.matchAll(/<section class="area" id="area-([a-z0-9_-]+)"/g)].map((m) => m[1]);
  for (const s of secciones) assert.ok(menu.some(([, a]) => a === s), "la sección " + s + " no tiene entrada en el menú");
});

test("los portales del comercio y de la peña vuelven al panel del club y avisan cuando se entra en modo lectura", () => {
  for (const p of ["comercio.html", "pena.html"]) {
    const h = leer(p);
    assert.match(h, /id="modoLectura"/, p);
    assert.match(h, /href="\/admin"/, p + " tiene que poder volver al panel del club");
  }
});
