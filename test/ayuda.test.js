"use strict";
// Sprint 5 — Centro de ayuda: contenido exportado del prototipo, filtros de la API y perfiles del club solo con sesión del panel.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const AYUDA = require("../data/ayuda.json");

test("contenido: perfiles, categorías y referencias consistentes; cada tutorial tiene pasos con título y texto", () => {
  const ids = new Set(AYUDA.aud.map((a) => a.id));
  assert.strictEqual(AYUDA.aud.length, 12);
  assert.deepStrictEqual([...new Set(AYUDA.aud.map((a) => a.grupo))], ["Hinchas", "Red de Beneficios", "Peñas", "Club"]);
  for (const x of [...AYUDA.tuts, ...AYUDA.faqs]) {
    assert.ok(x.aud.length && x.aud.every((a) => ids.has(a)), "perfil desconocido en " + (x.titulo || x.q));
    assert.ok(AYUDA.cats[x.cat], "categoría desconocida: " + x.cat);
  }
  for (const t of AYUDA.tuts) {
    assert.ok(t.titulo && t.bajada && t.min > 0 && t.pasos.length >= 2, t.titulo);
    for (const p of t.pasos) assert.ok(p.titulo && p.texto, "paso incompleto en " + t.titulo);
  }
  for (const f of AYUDA.faqs) assert.ok(f.q && f.a && f.d, f.q);
  assert.strictEqual(AYUDA.aud.filter((a) => a.club).length, 6, "los seis perfiles del club");
});

test("contenido estático: nada de HTML ni scripts (la página lo muestra escapado, pero tampoco debe venir en el origen)", () => {
  assert.ok(!/[<>]/.test(JSON.stringify(AYUDA)));
});

const app = require("../server");
const adminAuth = require("../lib/admin-auth");
let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const get = (ruta, h = {}) => fetch(url + ruta, { headers: h });
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };

test("API pública: perfiles de hinchas, comercios y peñas con contadores; los del club no aparecen", async () => {
  const j = await (await get("/api/ayuda")).json();
  assert.deepStrictEqual(j.aud.map((a) => a.id), ["olimpista", "junior", "plus", "socio", "comercio", "pena"]);
  assert.ok(j.aud.every((a) => a.n > 0));
  assert.ok(j.tuts.length > 0 && j.faqs.length > 0);
  assert.ok(j.tuts.every((t) => t.aud.includes("olimpista")), "el primer perfil por defecto es Olimpista");
  assert.ok(!JSON.stringify(j).includes("Leer el tablero"), "nada de contenido interno del club");
});

test("filtros: por perfil, categoría y búsqueda de texto", async () => {
  const pena = await (await get("/api/ayuda?aud=pena")).json();
  assert.ok(pena.tuts.length >= 3 && pena.tuts.every((t) => t.aud.includes("pena")));
  const soloPagos = await (await get("/api/ayuda?aud=pena&cat=pagos")).json();
  assert.ok(soloPagos.tuts.every((t) => t.cat === "pagos") && soloPagos.faqs.every((f) => f.cat === "pagos"));
  assert.ok(soloPagos.tuts.length < pena.tuts.length);
  assert.ok(soloPagos.categorias.length >= 2, "las categorías ofrecidas salen de lo que hay en el perfil, no del filtro");
  const q = await (await get("/api/ayuda?aud=plus&q=" + encodeURIComponent("SUBASTA"))).json();
  assert.ok(q.tuts.length + q.faqs.length > 0);
  assert.ok([...q.tuts, ...q.faqs].every((x) => JSON.stringify(x).toLowerCase().includes("subasta")), "búsqueda sin distinguir mayúsculas");
  const nada = await (await get("/api/ayuda?aud=plus&q=zzzzxxxx")).json();
  assert.deepStrictEqual([nada.tuts.length, nada.faqs.length], [0, 0]);
});

test("el perfil Socio ve lo suyo (liberar el lugar, la cuota va al Portal de Socios)", async () => {
  const j = await (await get("/api/ayuda?aud=socio")).json();
  assert.ok(j.tuts.some((t) => /Liberar tu lugar/.test(t.titulo)));
  assert.ok(j.faqs.some((f) => /Portal de Socios de ITTI/.test(f.a) && /cuota/i.test(f.q)));
});

test("perfiles del club: 403 sin sesión, 404 si no existe, y con sesión del panel se ven", async () => {
  assert.strictEqual((await get("/api/ayuda?aud=cd")).status, 403);
  assert.strictEqual((await get("/api/ayuda?aud=admin", { "x-admin-key": "clave-equivocada" })).status, 403);
  assert.strictEqual((await get("/api/ayuda?aud=inexistente")).status, 404);
  const j = await (await get("/api/ayuda?aud=cd", OWNER)).json();
  assert.strictEqual(j.aud.length, 12);
  assert.ok(j.tuts.some((t) => t.titulo === "Tomar una decisión"));
  await adminAuth.crearAdminUsuario({ usuario: "ayuda-lectura", nombre: "x", password: "clave-de-prueba-1", rol: "lectura" });
  const tok = (await adminAuth.loginAdmin({ usuario: "ayuda-lectura", password: "clave-de-prueba-1" })).token;
  assert.strictEqual((await get("/api/ayuda?aud=atencion", { "x-admin-token": tok })).status, 200);
});

test("la respuesta con sesión no se cachea (varía según quién pregunta) y la página /ayuda se sirve", async () => {
  const r = await get("/api/ayuda", OWNER);
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  const p = await get("/ayuda");
  assert.strictEqual(p.status, 200);
  assert.match(await p.text(), /Centro de ayuda/);
});
