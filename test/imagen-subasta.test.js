"use strict";
// La foto de la subasta sale del JSON del listado y se sirve aparte, con caché inmutable
// (auditoría 2026-10-21: /api/subastas pesaba ~300 KB en cada visita a la home).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { urlImagen, decodificar } = require("../lib/imagen-subasta");

// PNG de 1×1 px, válido.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = "data:image/png;base64," + PNG_B64;
// Relleno para que se note si la foto se cuela en un JSON.
const PNG_GRANDE = "data:image/png;base64," + Buffer.alloc(45000, 7).toString("base64"); // ~60 KB de base64

test("urlImagen: sin foto → null; con foto → URL versionada; http se respeta", () => {
  assert.strictEqual(urlImagen({ id: "sub_1", imagen: null }), null);
  assert.strictEqual(urlImagen({ id: "sub_1", tiene_imagen: false }), null);
  assert.match(urlImagen({ id: "sub_1", slug: "camiseta-x", imagen: PNG }), /^\/api\/subastas\/camiseta-x\/imagen\?v=[0-9a-f]{10}$/);
  assert.match(urlImagen({ id: "sub_1", tiene_imagen: true, imagen_v: "abc123def4" }), /^\/api\/subastas\/sub_1\/imagen\?v=abc123def4$/);
  assert.strictEqual(urlImagen({ id: "s", imagen: "https://cdn.ejemplo.com/a.jpg" }), "https://cdn.ejemplo.com/a.jpg");
  // La versión cambia si cambia la foto (así el navegador no se queda con la vieja).
  assert.notStrictEqual(urlImagen({ id: "s", imagen: PNG }), urlImagen({ id: "s", imagen: PNG_GRANDE }));
});

test("decodificar: acepta rasters, rechaza SVG, texto y basura", () => {
  assert.strictEqual(decodificar(PNG).tipo, "image/png");
  assert.ok(decodificar(PNG).buf.length > 0);
  assert.strictEqual(decodificar("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="), null, "SVG podría llevar scripts");
  assert.strictEqual(decodificar("data:text/html;base64,PGgxPg=="), null);
  for (const malo of [null, undefined, "", "hola", "data:image/png;base64,"]) assert.strictEqual(decodificar(malo), null, String(malo));
});

const app = require("../server");
const { getStore } = require("../data/store");
let srv, url, ids = {};

before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  url = `http://127.0.0.1:${srv.address().port}`;
  const st = getStore();
  const futuro = new Date(Date.now() + 36e5).toISOString();
  const a = await st.crearSubasta({ titulo: "Camiseta con foto", imagen: PNG_GRANDE, estado: "activa", termina: futuro, precio_inicial: 100000 });
  const b = await st.crearSubasta({ titulo: "Lote sin foto", estado: "activa", termina: futuro, precio_inicial: 100000 });
  const c = await st.crearSubasta({ titulo: "Lote con svg", imagen: "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+", estado: "activa", termina: futuro, precio_inicial: 100000 });
  ids = { a, b, c };
});
after(() => srv && srv.close());

test("/api/subastas NO trae la foto en el JSON, solo imagen_url", async () => {
  const r = await fetch(url + "/api/subastas");
  assert.strictEqual(r.status, 200);
  const txt = await r.text();
  assert.ok(!txt.includes("data:image"), "ninguna data URL en el listado");
  assert.ok(txt.length < 5000, "el listado es liviano (" + txt.length + " bytes)");
  const { items } = JSON.parse(txt);
  const con = items.find((x) => x.id === ids.a.id), sin = items.find((x) => x.id === ids.b.id);
  assert.match(con.imagen_url, /^\/api\/subastas\/.+\/imagen\?v=[0-9a-f]{10}$/);
  assert.strictEqual(sin.imagen_url, null);
  assert.ok(!("imagen" in con), "el campo imagen ya no existe en el listado");
});

test("el detalle tampoco manda la foto: usa imagen_url", async () => {
  const r = await fetch(url + "/api/subastas/" + ids.a.id);
  const txt = await r.text();
  assert.ok(!txt.includes("data:image"));
  assert.match(JSON.parse(txt).subasta.imagen_url, /\/imagen\?v=/);
});

test("GET imagen: devuelve el binario, con tipo correcto y caché inmutable", async () => {
  const lista = await (await fetch(url + "/api/subastas")).json();
  const u = lista.items.find((x) => x.id === ids.a.id).imagen_url;
  const r = await fetch(url + u);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("content-type").split(";")[0], "image/png");
  assert.match(r.headers.get("cache-control"), /max-age=31536000.*immutable/);
  assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok(Buffer.from(await r.arrayBuffer()).length > 40000, "es la imagen completa");
  // Funciona también por id (no solo por slug) y sin ?v= con caché corta.
  const r2 = await fetch(url + `/api/subastas/${ids.a.id}/imagen`);
  assert.strictEqual(r2.status, 200);
  assert.match(r2.headers.get("cache-control"), /max-age=300/);
});

test("GET imagen: sin foto, inexistente o SVG → 404 (no se sirve SVG)", async () => {
  assert.strictEqual((await fetch(url + `/api/subastas/${ids.b.id}/imagen`)).status, 404);
  assert.strictEqual((await fetch(url + `/api/subastas/no-existe/imagen`)).status, 404);
  assert.strictEqual((await fetch(url + `/api/subastas/${ids.c.id}/imagen`)).status, 404);
});

test("página pública /subasta/:id: la foto va por URL, no incrustada, y og:image es absoluta", async () => {
  const r = await fetch(url + "/subasta/" + ids.a.slug);
  const html = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(!html.includes("data:image"), "el HTML no lleva 60 KB de base64");
  assert.match(html, /<meta property="og:image" content="https:\/\/www\.olimpistas\.com\/api\/subastas\/[^"]+\/imagen\?v=[0-9a-f]{10}"/);
  assert.match(html, /<img src="\/api\/subastas\/[^"]+\/imagen\?v=/);
});
