"use strict";
// Mapa mundial (handoff v3, tanda M1): glifos propios, sin oro, /api/flags sin datos personales, MapLibre en diferido.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const PUBLIC = path.join(__dirname, "..", "public");
const leer = (rel) => fs.readFileSync(path.join(PUBLIC, rel), "utf8");

const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

// Lector mínimo de protobuf (varints y campos con largo) para revisar los .pbf sin depender de una librería.
function lector(buf) {
  let i = 0;
  const varint = () => { let r = 0, s = 0, b; do { b = buf[i++]; r += (b & 0x7f) * Math.pow(2, s); s += 7; } while (b & 0x80); return r; };
  const zig = () => { const n = varint(); return n % 2 ? -(n + 1) / 2 : n / 2; };
  return { fin: () => i >= buf.length, campo: () => { const k = varint(); return { tag: k >> 3, tipo: k & 7 }; }, varint, zig, bytes: () => { const n = varint(); const b = buf.subarray(i, i + n); i += n; return b; } };
}
function decodificar(buf) {
  const pilas = [];
  const r = lector(buf);
  while (!r.fin()) {
    const c = r.campo(); assert.strictEqual(c.tag, 1); const pila = lector(r.bytes()); const p = { glyphs: {} };
    while (!pila.fin()) {
      const f = pila.campo();
      if (f.tag === 1) p.name = Buffer.from(pila.bytes()).toString(); else if (f.tag === 2) p.range = Buffer.from(pila.bytes()).toString();
      else if (f.tag === 3) {
        const g = lector(pila.bytes()), o = {};
        while (!g.fin()) { const h = g.campo(); if (h.tag === 1) o.id = g.varint(); else if (h.tag === 2) o.bitmap = g.bytes(); else if (h.tag === 3) o.width = g.varint(); else if (h.tag === 4) o.height = g.varint(); else if (h.tag === 5) o.left = g.zig(); else if (h.tag === 6) o.top = g.zig(); else if (h.tag === 7) o.advance = g.varint(); }
        p.glyphs[o.id] = o;
      }
    }
    pilas.push(p);
  }
  return pilas;
}

test("glifos propios: Saira SemiBold y Bold se sirven desde el sitio, con el formato y las métricas que espera MapLibre", async () => {
  for (const nombre of ["Saira SemiBold", "Saira Bold"]) {
    for (const rango of ["0-255", "256-511", "8192-8447"]) {
      const res = await fetch(`${url}/assets/glyphs/${encodeURIComponent(nombre)}/${rango}.pbf`);
      assert.strictEqual(res.status, 200, `${nombre} ${rango}`);
      const [pila] = decodificar(Buffer.from(await res.arrayBuffer()));
      assert.strictEqual(pila.name, nombre);
      assert.strictEqual(pila.range, rango);
      assert.ok(Object.keys(pila.glyphs).length > 0);
      for (const g of Object.values(pila.glyphs)) {
        const esperado = g.width && g.height ? (g.width + 6) * (g.height + 6) : 0;
        assert.strictEqual(g.bitmap ? g.bitmap.length : 0, esperado, `bitmap del glifo ${g.id}: (ancho+6)·(alto+6)`);
      }
    }
  }
  const g = decodificar(fs.readFileSync(path.join(PUBLIC, "assets", "glyphs", "Saira Bold", "0-255.pbf")))[0].glyphs;
  // Misma convención que fontnik (Open Sans: H → top -9, x → -13): el texto queda centrado en la altura de versal.
  assert.strictEqual(g[72].top, -9, "H");
  assert.strictEqual(g[120].top, -13, "x");
  for (const c of "0123456789MK") assert.ok(g[c.charCodeAt(0)], "falta el glifo " + c + " (se usan en los números del globo)");
  for (const c of "áéíóúñÑüÁÉÍÓÚ") assert.ok(g[c.charCodeAt(0)], "falta el glifo " + c + " (nombres de países y ciudades)");
});

test("el mapa no usa servidores de glifos de terceros ni la tipografía Open Sans", () => {
  const globe = leer("js/globe.js");
  assert.ok(globe.includes('glyphs: "/assets/glyphs/{fontstack}/{range}.pbf"'));
  assert.ok(!/demotiles|Open Sans/.test(globe));
  assert.ok(!/demotiles/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")), "la CSP no abre demotiles.maplibre.org");
  for (const f of globe.match(/"text-font":\s*\[[^\]]*\]/g)) assert.match(f, /Saira (SemiBold|Bold)/);
});

test("sin oro en el mapa: ni en globe.js ni en las reglas del globo y el popup", () => {
  assert.deepStrictEqual((leer("js/globe.js").match(/c9a227|201,\s*162,\s*39|0b0b0f|b08d2e/gi) || []), []);
  assert.deepStrictEqual((leer("js/globe.js").match(/\bORO\b/g) || []), [], "sin la constante ORO");
  const css = leer("css/styles.css");
  assert.deepStrictEqual((css.match(/c9a227|201,\s*162,\s*39|0b0b0f/gi) || []), []);
  assert.ok(!/\.globo-stage::before/.test(css), "sin resplandor dorado detrás del globo");
  for (const regla of [/\.mapa-flag::after\s*\{[^}]*\}/, /\.maplibregl-popup-content\s*\{[^}]*\}/, /\.globo-popup\s*\{[^}]*\}/, /\.mapa-vos span\s*\{[^}]*\}/]) {
    const m = css.match(regla);
    assert.ok(m, "no se encontró " + regla);
    assert.ok(!/176,\s*141,\s*46|oro/i.test(m[0]), "tiene oro: " + m[0].slice(0, 60));
  }
});

test("/api/flags no entrega nombre ni ciudad: solo la posición difuminada de la bandera", async () => {
  const r = await fetch(url + "/api/auth/registro", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: `flag${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Marcos", apellido: "Prueba" }) });
  const { socio } = await r.json();
  await store.updateSocio(socio.id, { lat: -25.2937, lng: -57.6359, ciudad: "Asunción", mostrar_exacto: true });
  const j = await (await fetch(url + "/api/flags?bbox=-58,-26,-57,-25&limit=40")).json();
  // /flags quedó desactivado por privacidad (casas sin k-anonimato): responde vacío; las zonas salen de /api/mapa/celdas
  assert.deepStrictEqual(j.flags, []);
  const texto = JSON.stringify(j);
  assert.ok(!/Marcos|Asunci/.test(texto));
});

test("la app del hincha no descarga MapLibre ni el globo hasta que hace falta un mapa", () => {
  const h = leer("socio.html");
  assert.ok(!/maplibre/i.test(h), "socio.html no carga MapLibre");
  assert.ok(!/globe\.js/.test(h), "socio.html no carga globe.js");
  assert.match(leer("js/common.js"), /function cargarMapa\(\)/);
  assert.match(leer("js/socio.js"), /OLI\.cargarMapa\(\)/);
  assert.match(leer("js/landing.js"), /OLI\.cargarMapa\(\)/);
});

test("perfil: mover el mapa solo propone el punto; se guarda con 'Poner mi bandera acá' (un solo PATCH, con la privacidad a la vista)", () => {
  const js = leer("js/socio.js");
  const moveend = js.match(/perfilGlobo\.on\("moveend", \(\) => \{[^\n]*\}\);/)[0];
  assert.ok(!/api\(|guardar/.test(moveend), "moveend no guarda: " + moveend);
  assert.match(js, /function abrirHojaCasa\(\)/);
  assert.match(js, /m_casa_privacidad/);
  const i18n = leer("js/i18n.js");
  for (const k of ["m_casa_boton", "m_casa_privacidad", "m_casa_mostrar", "m_casa_guardar", "m_casa_ver", "m_sin_guardar"]) assert.strictEqual((i18n.match(new RegExp(k + ":", "g")) || []).length, 2, k + " en es y en");
  assert.strictEqual((js.match(/api\("\/perfil", \{ method: "PATCH", body: \{ lat: perfilPunto\.lat/g) || []).length, 1, "un único punto de guardado del mapa");
});

test("encontrarse en el globo: botonera Mi ciudad · Paraguay · El mundo, leyenda y lista accesible de países", () => {
  const h = leer("index.html");
  const botones = [...h.matchAll(/<button type="button" role="radio" class="ctl-seg-b" aria-checked="(true|false)" data-vista="(\w+)"/g)].map((m) => m[2]);
  assert.deepStrictEqual(botones, ["ciudad", "pais", "mundo"]);
  assert.match(h, /id="globoVista"[^>]*role="radiogroup"/);
  assert.match(h, /<ol class="mapa-lista" id="mapaLista">/);
  assert.match(h, /<details class="mapa-lista-wrap" id="mapaListaWrap" hidden>/);
  const g = leer("js/globe.js");
  assert.match(g, /vista\(nombre, p\)/);
  assert.match(g, /setAttribute\("role", "img"\)/, "el canvas es una imagen para lectores de pantalla");
  assert.match(g, /FullscreenControl/);
  const l = leer("js/landing.js");
  assert.match(l, /function iniciarVistasMapa\(gl\)/);
  assert.match(l, /navigator\.geolocation/);
  assert.match(l, /mapa_aria/);
  const i18n = leer("js/i18n.js");
  for (const k of ["mapa_ciudad", "mapa_pais", "mapa_mundo", "mapa_leyenda", "mapa_aria", "mapa_ver_todos", "mapa_ver_los", "mapa_sin_geo"]) assert.strictEqual((i18n.match(new RegExp(k + ":", "g")) || []).length, 2, k + " en es y en");
  assert.ok(!/<img[^>]+flagcdn/.test(l), "la lista de países no agrega servidores de banderas de terceros");
});
