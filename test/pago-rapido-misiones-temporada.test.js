"use strict";
// G8 · Pagar a tiempo suma (+50 si se paga un lote en las primeras 24 h del plazo) y G3 · misiones de temporada (el sistema mide el avance y premia una vez).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.PAGOPAR_PRIVATE_TOKEN = "privado-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const app = require("../server");
const { ventanaMision, REGLAS_META } = require("../lib/puntos");
const { getStore } = require("../data/store");
const store = getStore();
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const ADM = { "x-admin-key": "clave-admin-de-prueba" };
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const webhook = (hash) => api("/pagos/webhook", { metodo: "POST", cuerpo: { resultado: [{ hash_pedido: hash, token: sha1("privado-de-prueba" + hash), pagado: true }] } });
let n = 0;
async function socio(extra = {}) {
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `gm${++n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre: "Gamer", ...extra } });
  const { socio: s, token } = await r.json();
  return { id: s.id, ref: s.ref_codigo, h: { Authorization: "Bearer " + token, Cookie: "olimpista_sess=" + token } };
}
const hoy = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const sumaDias = (f, d) => new Date(new Date(f + "T12:00:00Z").getTime() + d * 86400000).toISOString().slice(0, 10);
const puntos = async (s) => (await (await api("/puntos", { h: s.h })).json());
const horas = (h) => new Date(Date.now() + h * 3600000).toISOString();

// ── G8 · pagar a tiempo suma ─────────────────────────────────────────────────
async function lotePagado(yo, { vence, ronda = 1 }) {
  const l = await store.crearSubasta({ titulo: "Lote " + (++n), precio_inicial: 100000, estado: "activa" });
  await store.updateSubasta(l.id, { estado: "cerrada", termina: horas(-1), ganador_id: yo.id, adjudicado_a: yo.id, puja_actual: 250000, pago_vence: vence, ronda });
  const hash = "h-" + crypto.randomBytes(5).toString("hex");
  await store.createPedidoPago({ socioId: yo.id, concepto: "Subasta: " + l.titulo, monto: 250000, moneda: "PYG", subastaId: l.id, refExterna: hash });
  return { l, hash };
}
const pagoRapido = async (yo) => (await store.movimientosPuntos(yo.id, 50)).filter((m) => m.motivo === "pago_rapido");

test("la regla existe en el catálogo y arranca en +50", async () => {
  assert.ok(REGLAS_META.pago_rapido && REGLAS_META.mision_temporada);
  const reglas = (await (await api("/admin/puntos/reglas", { h: ADM })).json()).items;
  assert.strictEqual(reglas.find((r) => r.clave === "pago_rapido").puntos, 50);
  assert.strictEqual(reglas.find((r) => r.clave === "mision_temporada").puntos, 300);
});

test("pagar dentro de las primeras 24 h del plazo suma +50, una sola vez aunque el aviso de pago llegue repetido", async () => {
  const yo = await socio();
  const { hash } = await lotePagado(yo, { vence: horas(60) });    // plazo de 72 h que empezó hace 12 h
  assert.strictEqual((await webhook(hash)).status, 200);
  assert.strictEqual((await webhook(hash)).status, 200);
  await new Promise((x) => setTimeout(x, 40));
  const mov = await pagoRapido(yo);
  assert.strictEqual(mov.length, 1);
  assert.strictEqual(mov[0].puntos, 50);
  assert.match(mov[0].detalle, /Pagaste a tiempo/);
});

test("pagar pasadas las 24 h no suma; en la segunda ronda el plazo es de 48 h y también cuentan sus primeras 24", async () => {
  const lento = await socio();
  const a = await lotePagado(lento, { vence: horas(30) });       // empezó hace 42 h
  await webhook(a.hash); await new Promise((x) => setTimeout(x, 40));
  assert.strictEqual((await pagoRapido(lento)).length, 0);
  const r2 = await socio();
  const b = await lotePagado(r2, { vence: horas(30), ronda: 2 }); // plazo de 48 h que empezó hace 18 h
  await webhook(b.hash); await new Promise((x) => setTimeout(x, 40));
  assert.strictEqual((await pagoRapido(r2)).length, 1);
});

test("con la regla apagada no suma (y el pago se entrega igual)", async () => {
  const yo = await socio();
  const { l, hash } = await lotePagado(yo, { vence: horas(60) });
  await api("/admin/puntos/reglas", { metodo: "PUT", h: ADM, cuerpo: { clave: "pago_rapido", activa: false } });
  try {
    await webhook(hash); await new Promise((x) => setTimeout(x, 150));   // la regla se lee con 30 s de caché: el cambio se ve al instante porque PUT la limpia
    assert.strictEqual((await store.getSubasta(l.id)).pago_estado, "pagado");
    assert.strictEqual((await pagoRapido(yo)).length, 0, "regla apagada: no suma");
  } finally { await api("/admin/puntos/reglas", { metodo: "PUT", h: ADM, cuerpo: { clave: "pago_rapido", activa: true } }); }
});

// ── G3 · misiones de temporada ───────────────────────────────────────────────
const crearMision = (extra = {}) => api("/admin/puntos/misiones-temporada", { metodo: "POST", h: ADM, cuerpo: { titulo: "Misión " + (++n), metrica: "canjes", meta: 2, desde: sumaDias(hoy(), -1), hasta: sumaDias(hoy(), 30), ...extra } });

test("ventana en hora de Paraguay: del día 1 a las 00:00 locales al día siguiente del último, 00:00 locales", () => {
  assert.deepStrictEqual(ventanaMision("2026-11-01", "2026-11-30"), { ini: "2026-11-01T03:00:00.000Z", fin: "2026-12-01T03:00:00.000Z" });
  assert.deepStrictEqual(ventanaMision("2026-12-31", "2026-12-31"), { ini: "2026-12-31T03:00:00.000Z", fin: "2027-01-01T03:00:00.000Z" });
});

test("admin: protegido, con validaciones claras, crea, lista y pausa", async () => {
  assert.strictEqual((await api("/admin/puntos/misiones-temporada", { metodo: "POST", cuerpo: {} })).status, 401);
  for (const [extra, motivo] of [[{ titulo: "x" }, "título"], [{ metrica: "asistencia" }, "métrica"], [{ meta: 0 }, "meta"], [{ meta: 1.5 }, "meta"], [{ desde: "mañana" }, "fecha"], [{ hasta: sumaDias(hoy(), -5) }, "orden de fechas"], [{ puntos: 99999 }, "puntos"]]) {
    assert.strictEqual((await crearMision(extra)).status, 400, motivo);
  }
  const r = await crearMision({ titulo: "Sumá 2 olimpistas", metrica: "referidos", meta: 2, descripcion: "Invitá y ganá" });
  assert.strictEqual(r.status, 201);
  const m = (await r.json()).mision;
  assert.strictEqual(m.puntos, 300, "sin puntos explícitos usa el valor de la regla");
  const lista = await (await api("/admin/puntos/misiones-temporada", { h: ADM })).json();
  assert.ok(lista.items.some((x) => x.id === m.id) && lista.metricas.referidos && lista.hoy === hoy());
  assert.strictEqual((await api("/admin/puntos/misiones-temporada/" + m.id, { metodo: "PATCH", h: ADM, cuerpo: { activa: false } })).status, 200);
  assert.strictEqual((await api("/admin/puntos/misiones-temporada/" + m.id, { metodo: "PATCH", h: ADM, cuerpo: { activa: "no" } })).status, 400);
  assert.strictEqual((await api("/admin/puntos/misiones-temporada/mst_inventada", { metodo: "PATCH", h: ADM, cuerpo: { activa: true } })).status, 404);
});

test("el socio ve el avance y, al llegar a la meta, recibe los puntos UNA vez (y el saldo de esa misma respuesta ya los incluye)", async () => {
  const yo = await socio();
  const m = (await (await crearMision({ titulo: "Dos beneficios", metrica: "canjes", meta: 2, puntos: 300 })).json()).mision;
  const ver = async () => (await puntos(yo));
  let p = await ver();
  const mia = () => p.misiones_temporada.find((x) => x.id === m.id);
  assert.deepStrictEqual([mia().progreso, mia().meta, mia().completada, mia().nueva], [0, 2, false, false]);
  const base = p.saldo;
  await store.registrarCanje({ beneficioId: "ben_x", socioId: yo.id, comercioId: "com_x", validadoPor: "t", monto: 1, ahorro: 1 });
  p = await ver();
  assert.deepStrictEqual([mia().progreso, mia().completada, p.saldo], [1, false, base]);
  await store.registrarCanje({ beneficioId: "ben_x", socioId: yo.id, comercioId: "com_x", validadoPor: "t", monto: 1, ahorro: 1 });
  await store.registrarCanje({ beneficioId: "ben_x", socioId: yo.id, comercioId: "com_x", validadoPor: "t", monto: 1, ahorro: 1 });   // de más: el progreso no pasa de la meta
  const [a, b] = await Promise.all([ver(), ver()]);                                                                                   // dos pantallas a la vez
  assert.strictEqual(Math.max(a.saldo, b.saldo), base + 300, "el saldo de la respuesta que premió ya incluye la misión");
  assert.strictEqual([a, b].filter((x) => x.misiones_temporada.find((y) => y.id === m.id).nueva).length, 1, "solo una respuesta la premia");
  p = await ver();
  assert.deepStrictEqual([mia().progreso, mia().completada, mia().nueva, p.saldo], [2, true, false, base + 300]);
  assert.strictEqual((await store.movimientosPuntos(yo.id, 50)).filter((x) => x.motivo === "mision_temporada").length, 1);
});

test("las cuatro métricas: referidos, canjes, rubros distintos y subastas con puja, solo dentro del período", async () => {
  const yo = await socio();
  const mk = async (metrica, meta = 2) => (await (await crearMision({ titulo: "M " + metrica + " " + (++n), metrica, meta })).json()).mision;
  const [mRef, mCanj, mRub, mPuj] = [await mk("referidos"), await mk("canjes"), await mk("rubros"), await mk("pujas")];
  await socio({ ref: yo.ref }); await socio({ ref: yo.ref });
  const cafe = await store.crearComercio({ nombre: "Café", rubro: "Gastronomía", ciudad: "Asunción" }), pizza = await store.crearComercio({ nombre: "Pizza", rubro: " gastronomía ", ciudad: "Luque" }), farma = await store.crearComercio({ nombre: "Farma", rubro: "Salud", ciudad: "Asunción" });
  for (const c of [cafe, pizza]) await store.registrarCanje({ beneficioId: "ben_x", socioId: yo.id, comercioId: c.id, validadoPor: "t", monto: 1, ahorro: 1 });
  const antiguo = await store.registrarCanje({ beneficioId: "ben_x", socioId: yo.id, comercioId: farma.id, validadoPor: "t", monto: 1, ahorro: 1 });
  antiguo.creado = new Date(Date.now() - 10 * 86400000).toISOString();            // fuera del período: no cuenta
  const lote = async () => { const l = await store.crearSubasta({ titulo: "L" + (++n), precio_inicial: 100000, incremento: 10000, estado: "activa", termina: horas(600) }); await store.pujar({ subastaId: l.id, socioId: yo.id, monto: 110000 }); await store.pujar({ subastaId: l.id, socioId: yo.id, monto: 120000 }); };
  await lote();
  const ver = async () => Object.fromEntries((await puntos(yo)).misiones_temporada.map((x) => [x.id, x]));
  // el período empieza ayer: el canje de hace 10 días no entra; "Gastronomía" y " gastronomía " son el mismo rubro
  let v = await ver();
  assert.deepStrictEqual([v[mRef.id].progreso, v[mCanj.id].progreso, v[mRub.id].progreso, v[mPuj.id].progreso], [2, 2, 1, 1]);
  assert.strictEqual(v[mRef.id].completada && v[mCanj.id].completada, true);
  assert.strictEqual(v[mRub.id].completada, false);
  await store.registrarCanje({ beneficioId: "ben_x", socioId: yo.id, comercioId: (await store.crearComercio({ nombre: "Ropa", rubro: "Moda" })).id, validadoPor: "t", monto: 1, ahorro: 1 });
  await lote();
  v = await ver();
  assert.deepStrictEqual([v[mRub.id].progreso, v[mRub.id].completada, v[mPuj.id].progreso, v[mPuj.id].completada], [2, true, 2, true]);
});

test("solo se ven las vigentes y activas; con la regla apagada se ven pero no premian", async () => {
  const yo = await socio();
  const futura = (await (await crearMision({ titulo: "Futura " + (++n), desde: sumaDias(hoy(), 3), hasta: sumaDias(hoy(), 9) })).json()).mision;
  const vencida = (await (await crearMision({ titulo: "Vencida " + (++n), desde: sumaDias(hoy(), -9), hasta: sumaDias(hoy(), -2) })).json()).mision;
  const pausada = (await (await crearMision({ titulo: "Pausada " + (++n) })).json()).mision;
  await api("/admin/puntos/misiones-temporada/" + pausada.id, { metodo: "PATCH", h: ADM, cuerpo: { activa: false } });
  const hastaHoy = (await (await crearMision({ titulo: "Termina hoy " + (++n), hasta: hoy() })).json()).mision;
  const ids = (await puntos(yo)).misiones_temporada.map((x) => x.id);
  assert.ok(!ids.includes(futura.id) && !ids.includes(vencida.id) && !ids.includes(pausada.id));
  assert.ok(ids.includes(hastaHoy.id), "el último día todavía cuenta");
  // regla apagada: el avance se ve, pero no se premia
  const sola = (await (await crearMision({ titulo: "Sin premio " + (++n), metrica: "canjes", meta: 1, puntos: 500 })).json()).mision;
  const otro = await socio();
  await api("/admin/puntos/reglas", { metodo: "PUT", h: ADM, cuerpo: { clave: "mision_temporada", activa: false } });
  try {
    await store.registrarCanje({ beneficioId: "ben_x", socioId: otro.id, comercioId: "com_x", validadoPor: "t", monto: 1, ahorro: 1 });
    const p = await puntos(otro), m = p.misiones_temporada.find((x) => x.id === sola.id);
    assert.deepStrictEqual([m.progreso, m.completada, p.saldo], [1, false, 0]);
  } finally { await api("/admin/puntos/reglas", { metodo: "PUT", h: ADM, cuerpo: { clave: "mision_temporada", activa: true } }); }
  const despues = await puntos(otro);
  assert.strictEqual(despues.misiones_temporada.find((x) => x.id === sola.id).completada, true, "al volver a encender la regla, se premia lo que ya cumplió");
});

test("pantallas: tarjetas de temporada en Puntos y alta en el panel; textos es y en", () => {
  const js = leer("public", "js", "socio.js"), ad = leer("public", "admin.html"), i18n = leer("public", "js", "i18n.js"), css = leer("public", "css", "styles.css");
  assert.ok(/misiones_temporada/.test(js) && /pts-mt-barra/.test(js) && /\$\{mtHtml\}/.test(js));
  assert.ok(/misiones-temporada/.test(ad) && /id="mtCrear"/.test(ad) && /data-mtact/.test(ad));
  for (const k of ["m_pts_temp_h", "m_pts_temp_de", "m_pts_temp_hecha", "m_pts_temp_hasta", "m_pts_temp_ok"]) assert.strictEqual((i18n.match(new RegExp("\\b" + k + ":", "g")) || []).length, 2, k + " en es y en");
  assert.ok(/\.pts-mt-barra/.test(css) && /prefers-reduced-motion/.test(css));
});
