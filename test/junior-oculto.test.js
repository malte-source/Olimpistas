"use strict";
// El nivel Junior (kids) ya no se ofrece: no sale en la landing, no se puede contratar, pero quien ya lo tiene lo conserva.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const leer = (rel) => fs.readFileSync(path.join(__dirname, "..", "public", rel), "utf8");

test("config: Junior queda marcado como oculto (se conserva para quien ya lo tiene) y la landing lo filtra", async () => {
  const cfg = await (await api("/config")).json();
  const kids = cfg.tiers.find((t) => t.slug === "kids");
  assert.ok(kids && kids.oculto === true);
  assert.ok(!cfg.tiers.find((t) => t.slug === "premium").oculto);
  assert.match(leer("js/landing.js"), /t\.comprable !== false && !t\.oculto/);
  assert.match(leer("js/socio.js"), /t\.comprable !== false && !t\.oculto/);
});

test("no se puede contratar Junior (403) pero Plus y el nivel gratis siguen igual", async () => {
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `jr-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Ju", apellido: "Nior" } })).json();
  const h = { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
  const r = await api("/membresia/unirse", { metodo: "POST", cuerpo: { tier: "kids" }, h });
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /ya no se ofrece/);
  const g = await api("/membresia/unirse", { metodo: "POST", cuerpo: { tier: "olimpista" }, h });
  assert.strictEqual(g.status, 200);
  assert.notStrictEqual((await api("/membresia/unirse", { metodo: "POST", cuerpo: { tier: "premium" }, h })).status, 403);
});

test("quien ya es Junior lo conserva: su membresía y su nivel siguen funcionando", async () => {
  const j = await (await api("/auth/registro", { metodo: "POST", cuerpo: { email: `jr2-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Ya", apellido: "Junior" } })).json();
  await store.setMembresia(j.socio.id, { tierSlug: "kids", ciclo: "anio", pagoRef: "ped_viejo" });
  const h = { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token };
  const yo = await (await api("/auth/yo", { h })).json();
  assert.strictEqual(yo.membresia.tier_slug, "kids");
});

test("textos: la landing y el banner ya no ofrecen Junior", () => {
  const i = leer("js/i18n.js");
  assert.ok(!/subí a Junior|Upgrade to Junior|Plus\/Junior/.test(i));
  assert.ok(!/subí a Junior/.test(leer("index.html")));
});
