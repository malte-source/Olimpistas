"use strict";
// Tu historia (socio y no socio) y beneficios aspiracionales: lo que ahorraría siendo socio, y el camino a asociarse en el portal.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.TICKET_PROMEDIO = "100000";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { getStore } = require("../data/store");
const { cargarMuestra } = require("../lib/beneficios-muestra");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; await cargarMuestra(store); });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
let n = 0;
async function cuenta(extra = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `hi${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Prueba" } });
  const { token, socio } = await r.json();
  if (Object.keys(extra).length) await store.updateSocio(socio.id, extra);
  return { id: socio.id, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}

test("quien todavía no es socio ve lo que ahorraría siéndolo: los 4 mejores beneficios, una compra promedio supuesta y los números a la vista", async () => {
  const A = await cuenta();
  const r = await (await api("/beneficios", { h: A.h })).json();
  assert.ok(r.potencial, "hay estimación");
  assert.strictEqual(r.potencial.ticket, 100000);
  assert.strictEqual(r.potencial.usos, 4);
  assert.ok(r.potencial.mensual > 0 && r.potencial.mensual <= 4 * 100000, "con 30 % de descuento sobre 100.000 cada uno no pasa de 120.000");
  assert.strictEqual(r.potencial.anual, r.potencial.mensual * 12);
  assert.ok(r.potencial.ejemplos.length >= 1 && r.potencial.ejemplos.every((e) => e.comercio));
  assert.ok(r.items.length > 0 && r.items.every((b) => b.desbloqueado === false), "los beneficios de socios se ven pero bloqueados");
});

test("el socio no ve la estimación (ya los usa) y sus beneficios están desbloqueados", async () => {
  const S = await cuenta({ es_socio_olimpia: true });
  await store.setMembresia(S.id, { tierSlug: "socio", ciclo: "anio", pagoRef: "socio:t" });
  const r = await (await api("/beneficios", { h: S.h })).json();
  assert.strictEqual(r.potencial, null);
  assert.ok(r.items.some((b) => b.desbloqueado));
});

test("Tu historia de un socio: años de socio desde su fecha, plan, número, hitos en orden y estadísticas", async () => {
  const S = await cuenta({ es_socio_olimpia: true, socio_desde: "2009-03-14", grupo_club: "ESTADIO", nro_socio: "555" });
  await store.setMembresia(S.id, { tierSlug: "socio", ciclo: "anio", pagoRef: "socio:t" });
  const ben = (await store.listBeneficios())[0];
  await store.registrarCanje({ beneficioId: ben.id, socioId: S.id, comercioId: ben.comercio_id, monto: 100000, ahorro: 30000, validadoPor: "t" });
  const h = await (await api("/historia", { h: S.h })).json();
  assert.strictEqual(h.es_socio, true);
  assert.strictEqual(h.socio_desde, "2009-03-14");
  assert.ok(h.anios_socio >= 17, "17 años y pico al 2026");
  assert.deepStrictEqual({ g: h.grupo_club, n: h.nro_socio }, { g: "ESTADIO", n: "555" });
  assert.strictEqual(h.potencial, null);
  assert.deepStrictEqual({ canjes: h.stats.canjes, ahorro: h.stats.ahorro_total }, { canjes: 1, ahorro: 30000 });
  const tipos = h.hitos.map((x) => x.tipo);
  assert.strictEqual(tipos[0], "socio", "lo más antiguo primero: se hizo socio en 2009");
  assert.ok(tipos.includes("miembro") && tipos.includes("canje"));
  assert.ok(h.hitos.every((x, i, a) => i === 0 || a[i - 1].fecha <= x.fecha), "en orden cronológico");
  assert.ok(h.hitos.find((x) => x.tipo === "canje").detalle, "el primer beneficio dice dónde");
});

test("Tu historia de quien no es socio: desde cuándo es miembro de Olimpistas, sin antigüedad de socio inventada, y la invitación a asociarse", async () => {
  const A = await cuenta();
  const h = await (await api("/historia", { h: A.h })).json();
  assert.deepStrictEqual({ socio: h.es_socio, desde: h.socio_desde, anios: h.anios_socio, grupo: h.grupo_club }, { socio: false, desde: "", anios: null, grupo: "" });
  assert.deepStrictEqual(h.hitos.map((x) => x.tipo), ["miembro"]);
  assert.ok(h.potencial && h.potencial.mensual > 0);
  assert.strictEqual((await api("/historia")).status, 401, "hace falta sesión");
});

test("pantalla: tarjeta aspiracional, acceso al portal de socios, detalle por beneficio y la vista Tu historia", () => {
  const s = leer("public", "js", "socio.js");
  assert.match(s, /class="ben-ahorro asp"/);
  assert.match(s, /id="bxYaSoy"/);
  assert.match(s, /href="' \+ esc\(portalClub\(\)\) \+ '" target="_blank" rel="noopener">' \+ T\("asp_asociate"\)/);
  assert.match(s, /T\("asp_este"\)/);
  assert.match(s, /async function vHistoria\(\)/);
  assert.match(s, /historia: vHistoria/);
  assert.match(s, /"descubrir", "historia"\]/);
  assert.match(s, /wAhorro\(ahorroR, benR && benR\.potencial\)/);
  assert.match(s, /function wHistoria\(\)/);
  assert.match(leer("public", "js", "paleta.js"), /T\("hi_h"\), run: ir\("historia"\)/);
  const i = leer("public", "js", "i18n.js");
  for (const k of ["asp_lbl", "asp_hasta", "asp_nota", "asp_asociate", "asp_ya_soy", "asp_este", "asp_tile_n", "hi_h", "hi_p", "hi_t_socio", "hi_t_miembro", "hi_t_canje", "hi_s_canjes", "hi_s_ahorro", "hi_linea"]) assert.ok(i.split(" " + k + ":").length - 1 >= 2, k);
  const c = leer("public", "css", "styles.css");
  assert.match(c, /\.ben-ahorro\.asp \{ background: #0a0a0a;/);
  assert.match(c, /\.hi-linea \{ list-style: none;/);
});
