"use strict";
// Sprint 3 — motor de puntos: reglas, escalones, misión semanal, catálogo de canje, cuota, vencimiento.
const PUERTO_TUTI = 29874;   // fuera del rango de puertos efímeros (32768+): en CI los servidores de prueba toman puertos de ahí y chocaban con este
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";
process.env.PUNTOS_CUOTA_DIAS = "31"; // la revisión de cuotas corre cualquier día del mes en los tests
process.env.TUTI_API_HOST = `http://127.0.0.1:${PUERTO_TUTI}`;
process.env.TUTI_API_KEY = "mock";
process.env.TUTI_MERCHANT_KEY = "mock";

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const express = require("express");

const { escalonDe, semanaIso, mesPy, diaDelMesPy, REGLAS_META, ESCALONES } = require("../lib/puntos");

// ── Reglas puras ─────────────────────────────────────────────────────────────
test("escalones: Bronce desde 200, Plata desde 1.000, Oro desde 5.000, con lo que falta para el siguiente", () => {
  assert.deepStrictEqual(escalonDe(0), { clave: "inicial", nombre: "Inicial", siguiente: { clave: "bronce", nombre: "Bronce", desde: 200 }, faltan: 200, pct: 0 });
  assert.strictEqual(escalonDe(199).clave, "inicial");
  assert.strictEqual(escalonDe(200).clave, "bronce");
  assert.strictEqual(escalonDe(999).clave, "bronce");
  assert.strictEqual(escalonDe(1000).clave, "plata");
  const p = escalonDe(3000);
  assert.deepStrictEqual({ c: p.clave, falta: p.faltan, pct: p.pct, sig: p.siguiente.nombre }, { c: "plata", falta: 2000, pct: 50, sig: "Oro" });
  assert.deepStrictEqual(escalonDe(5000), { clave: "oro", nombre: "Oro", siguiente: null, faltan: 0, pct: 100 });
  assert.strictEqual(escalonDe(-50).clave, "inicial");
  assert.strictEqual(escalonDe("x").clave, "inicial");
  assert.strictEqual(ESCALONES.length, 3);
});

test("semana ISO en hora de Paraguay (lunes a domingo), incluidos los bordes de año", () => {
  assert.strictEqual(semanaIso(new Date("2026-10-21T15:00:00Z")), "2026-W43");
  assert.strictEqual(semanaIso(new Date("2026-10-19T03:30:00Z")), "2026-W43", "lunes 00:30 en Paraguay (UTC-3) ya es la semana nueva");
  assert.strictEqual(semanaIso(new Date("2026-10-19T02:30:00Z")), "2026-W42", "domingo 23:30 en Paraguay todavía es la semana vieja");
  assert.strictEqual(semanaIso(new Date("2027-01-01T15:00:00Z")), "2026-W53", "1-ene-2027 pertenece a la W53 de 2026");
  assert.strictEqual(semanaIso(new Date("2024-12-30T15:00:00Z")), "2025-W01", "30-dic-2024 ya es la W01 de 2025");
  assert.strictEqual(semanaIso(new Date("2026-01-01T15:00:00Z")), "2026-W01");
});

test("mes y día del mes en hora de Paraguay", () => {
  assert.strictEqual(mesPy(new Date("2026-11-01T02:59:00Z")), "2026-10", "31-oct 23:59 en Paraguay");
  assert.strictEqual(mesPy(new Date("2026-11-01T03:00:00Z")), "2026-11");
  assert.strictEqual(diaDelMesPy(new Date("2026-11-01T03:00:00Z")), 1);
});

test("las reglas del paquete están todas, y las de Tuti sin endpoint figuran como pendientes", () => {
  assert.deepStrictEqual(Object.keys(REGLAS_META).sort(), ["cuota", "debito", "estadio", "liberar", "mision", "mision_temporada", "pago_rapido", "perfil", "referido"]);
  assert.ok(REGLAS_META.estadio.pendiente && REGLAS_META.liberar.pendiente);
  assert.ok(!REGLAS_META.referido.pendiente);
});

// ── Servidor ─────────────────────────────────────────────────────────────────
const app = require("../server");
const { getStore } = require("../data/store");
const mailer = require("../lib/email");
const tuti = require("../lib/tuti");
const store = getStore();

let srv, url, fakeTuti, consultasTuti = 0;
before(async () => {
  const t = express();
  t.use((req, _res, next) => { if (req.path.includes("/members")) consultasTuti++; next(); });
  t.use(require("../lib/tuti-mock").router());
  fakeTuti = await new Promise((res) => { const s = http.createServer(t).listen(PUERTO_TUTI, () => res(s)); });
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  url = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv && srv.close(); fakeTuti && fakeTuti.close(); });

let correos;
const orig = {}, NOMBRES = ["enviarPuntosPorVencer", "enviarPremioListo"];
before(() => NOMBRES.forEach((n) => { orig[n] = mailer[n]; }));
after(() => NOMBRES.forEach((n) => { mailer[n] = orig[n]; }));
beforeEach(async () => {
  correos = []; consultasTuti = 0; tuti.__resetBloqueo();
  NOMBRES.forEach((n) => { mailer[n] = async (dest, datos) => { correos.push({ n, a: dest.id || dest.email, datos }); return { ok: true }; }; });
  await adminRegla("referido", { puntos: 300, activa: true });
  await adminRegla("mision", { puntos: 50, activa: true });
  await adminRegla("perfil", { puntos: 100, activa: true });
  await adminRegla("cuota", { puntos: 100, activa: true });
  await adminRegla("debito", { puntos: 500, activa: true });
  await admin("/decisiones/venc", { metodo: "PUT", cuerpo: { valor: "12_meses" } });
  await admin("/decisiones/oro", { metodo: "PUT", cuerpo: { valor: "no_publicar" } });
});

const ADMIN = { "x-admin-key": "clave-admin-de-prueba" };
const HORA = 3600000, DIA = 24 * HORA;
const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const admin = (ruta, o = {}) => api("/admin" + ruta, { ...o, h: { ...ADMIN, ...(o.h || {}) } });
const adminRegla = (clave, cuerpo) => admin("/puntos/reglas", { metodo: "PUT", cuerpo: { clave, ...cuerpo } });
const cron = () => fetch(url + "/api/cron/diario", { method: "POST", headers: { "x-cron-token": "secreto-de-cron-de-prueba" } }).then((r) => r.json());
const saldo = (id) => store.saldoPuntos(id);

let n = 0;
async function socio(nombre, extra = {}, body = {}) {
  n++;
  const r = await api("/auth/registro", { metodo: "POST", cuerpo: { email: `${nombre}${n}-${Date.now()}@ejemplo.com`, password: "clave-larga-123", nombre, ...body } });
  const j = await r.json();
  if (extra && Object.keys(extra).length) await store.updateSocio(j.socio.id, extra);
  return { id: j.socio.id, ref_codigo: j.socio.ref_codigo, h: { Authorization: "Bearer " + j.token, Cookie: "olimpista_sess=" + j.token } };
}
const dar = (socioId, puntos, ref) => store.sumarPuntos({ socioId, motivo: "test", refId: ref || "r" + Math.random(), puntos, detalle: "test" });

// ── Reglas: referido y perfil ────────────────────────────────────────────────
test("referido: el que invita suma 300, una vez por invitado; un código inválido no suma", async () => {
  const A = await socio("Invita");
  const codigo = (await store.getSocioById(A.id)).ref_codigo;
  assert.ok(codigo);
  const B = await socio("Invitado1", {}, { ref: codigo });
  assert.strictEqual(await saldo(A.id), 300);
  await socio("Invitado2", {}, { ref: codigo });
  assert.strictEqual(await saldo(A.id), 600);
  await socio("Falso", {}, { ref: "CODIGO-FALSO" });
  assert.strictEqual(await saldo(A.id), 600);
  assert.ok(B.id);
  const mov = await store.movimientosPuntos(A.id);
  assert.deepStrictEqual(mov.map((m) => m.motivo), ["referido", "referido"]);
});

test("referido: si el club desactiva la regla (o la pone en 0) no suma", async () => {
  const A = await socio("InvitaOff");
  const codigo = (await store.getSocioById(A.id)).ref_codigo;
  await adminRegla("referido", { activa: false });
  await new Promise((x) => setTimeout(x, 10));
  await socio("X1", {}, { ref: codigo });
  assert.strictEqual(await saldo(A.id), 0);
  await adminRegla("referido", { activa: true, puntos: 250 });
  await socio("X2", {}, { ref: codigo });
  assert.strictEqual(await saldo(A.id), 250, "usa el valor vigente");
});

test("perfil completo: +100 una sola vez, cuando los cinco datos están", async () => {
  const A = await socio("Perfil");
  assert.strictEqual(await saldo(A.id), 0);
  const FOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await api("/perfil", { metodo: "PATCH", h: A.h, cuerpo: { whatsapp: "0981123456", ciudad: "Asunción", pais: "PY" } });
  assert.strictEqual(await saldo(A.id), 0, "todavía falta la foto");
  await api("/perfil/foto", { metodo: "POST", h: A.h, cuerpo: { foto: FOTO } });
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(await saldo(A.id), 100);
  await api("/perfil", { metodo: "PATCH", h: A.h, cuerpo: { ciudad: "Luque" } });
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(await saldo(A.id), 100, "editar de nuevo no vuelve a sumar");
});

// ── GET /puntos ──────────────────────────────────────────────────────────────
test("GET /puntos: saldo, escalón, reglas con a quién aplican y movimientos; exige sesión", async () => {
  assert.strictEqual((await api("/puntos")).status, 401);
  const A = await socio("Ver");
  await dar(A.id, 1200);
  const d = await (await api("/puntos", { h: A.h })).json();
  assert.strictEqual(d.saldo, 1200);
  assert.strictEqual(d.escalon.clave, "plata");
  assert.strictEqual(d.escalon.siguiente.nombre, "Oro");
  assert.strictEqual(d.vencen, true);
  const r = Object.fromEntries(d.reglas.map((x) => [x.clave, x]));
  assert.strictEqual(r.referido.aplica, true);
  assert.strictEqual(r.cuota.aplica, false, "la cuota solo aplica a socios");
  assert.strictEqual(r.liberar.aplica, false);
  assert.strictEqual(r.estadio.pendiente, true);
  assert.strictEqual(d.movimientos.length, 1);
  const S = await socio("Socio", { es_socio_olimpia: true });
  assert.strictEqual(Object.fromEntries((await (await api("/puntos", { h: S.h })).json()).reglas.map((x) => [x.clave, x])).cuota.aplica, true);
});

// ── Misión semanal ───────────────────────────────────────────────────────────
const crearMision = (extra = {}) => admin("/puntos/misiones", { metodo: "POST", cuerpo: { semana: semanaIso(), pregunta: "¿En qué año ganó Olimpia su primera Libertadores?", opciones: ["1979", "1990", "2002"], correcta: 0, ...extra } });
test("misión: se carga por semana, no se repite, y valida", async () => {
  const semana = "2031-W10";
  assert.strictEqual((await crearMision({ semana: "2026-43" })).status, 400);
  assert.strictEqual((await crearMision({ semana, pregunta: "x" })).status, 400);
  assert.strictEqual((await crearMision({ semana, opciones: ["solo una"] })).status, 400);
  assert.strictEqual((await crearMision({ semana, correcta: 7 })).status, 400);
  assert.strictEqual((await crearMision({ semana })).status, 201);
  assert.strictEqual((await crearMision({ semana })).status, 409, "una misión por semana");
});

test("misión: se responde UNA vez; acierta +50, falla 0 y no se puede reintentar; nunca se manda cuál es la correcta", async () => {
  // la semana actual puede tener ya una misión de otro test → se crea solo si no hay
  let m = (await store.listMisiones(50)).find((x) => x.semana === semanaIso());
  if (!m) m = (await (await crearMision()).json()).mision;
  else await store.updateMision(m.id, { activa: true, correcta: 0, opciones: ["1979", "1990", "2002"] });
  const A = await socio("Mision"), B = await socio("MisionMal");
  const vista = await (await api("/puntos", { h: A.h })).json();
  assert.strictEqual(vista.mision.id, m.id);
  assert.ok(!("correcta" in vista.mision), "no se filtra la respuesta correcta");
  assert.ok(!JSON.stringify(vista.mision).includes('"correcta"'), "ni en el JSON");
  assert.strictEqual(vista.mision.respondida, null);
  assert.strictEqual((await api("/puntos/mision/" + m.id, { metodo: "POST", h: A.h, cuerpo: { opcion: 9 } })).status, 400);
  const ok = await (await api("/puntos/mision/" + m.id, { metodo: "POST", h: A.h, cuerpo: { opcion: 0 } })).json();
  assert.deepStrictEqual({ c: ok.correcta, p: ok.puntos, s: ok.saldo }, { c: true, p: 50, s: 50 });
  assert.strictEqual((await api("/puntos/mision/" + m.id, { metodo: "POST", h: A.h, cuerpo: { opcion: 0 } })).status, 409, "ya respondió");
  const mal = await (await api("/puntos/mision/" + m.id, { metodo: "POST", h: B.h, cuerpo: { opcion: 1 } })).json();
  assert.deepStrictEqual({ c: mal.correcta, p: mal.puntos }, { c: false, p: 0 });
  assert.strictEqual((await api("/puntos/mision/" + m.id, { metodo: "POST", h: B.h, cuerpo: { opcion: 0 } })).status, 409, "una respuesta mala tampoco se reintenta");
  assert.strictEqual(await saldo(B.id), 0);
  const despues = await (await api("/puntos", { h: B.h })).json();
  assert.deepStrictEqual(despues.mision.respondida, { opcion: 1, correcta: false });
});

test("misión: 5 respuestas simultáneas del mismo hincha suman UNA vez", async () => {
  let m = (await store.listMisiones(50)).find((x) => x.semana === semanaIso());
  if (!m) m = (await (await crearMision()).json()).mision;
  await store.updateMision(m.id, { activa: true, correcta: 0, opciones: ["1979", "1990", "2002"] });
  const A = await socio("Carrera");
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api("/puntos/mision/" + m.id, { metodo: "POST", h: A.h, cuerpo: { opcion: 0 } })));
  assert.strictEqual(rs.filter((r) => r.status === 200).length, 1);
  assert.strictEqual(await saldo(A.id), 50);
});

test("misión de otra semana o inexistente: no se puede responder", async () => {
  const vieja = await store.crearMision({ semana: "2020-W05", pregunta: "pregunta vieja", opciones: ["a", "b"], correcta: 0 });
  const A = await socio("Vieja");
  assert.strictEqual((await api("/puntos/mision/" + vieja.id, { metodo: "POST", h: A.h, cuerpo: { opcion: 0 } })).status, 409);
  assert.strictEqual((await api("/puntos/mision/mis_inventada", { metodo: "POST", h: A.h, cuerpo: { opcion: 0 } })).status, 404);
});

test("encuesta respondida = 'misión': +50 una vez por encuesta", async () => {
  const e = await store.crearEncuesta({ titulo: "Encuesta", pregunta: "¿Cómo viste el partido?", opciones: ["Bien", "Mal"], estado: "activa" });
  const A = await socio("Encuestado");
  assert.strictEqual((await api(`/encuestas/${e.id}/responder`, { metodo: "POST", h: A.h, cuerpo: { opcion: 0 } })).status, 200);
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(await saldo(A.id), 50);
  await api(`/encuestas/${e.id}/responder`, { metodo: "POST", h: A.h, cuerpo: { opcion: 1 } });
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(await saldo(A.id), 50, "cambiar el voto no suma de nuevo");
});

// ── Catálogo y canje ─────────────────────────────────────────────────────────
const crearPremio = (extra) => admin("/puntos/premios", { metodo: "POST", cuerpo: { titulo: "2x1 en el cine", escalon: "bronce", costo: 400, ...extra } }).then((r) => r.json()).then((j) => j.premio);
const premiosDe = async (h) => (await (await api("/puntos/premios", { h })).json());

test("admin de premios: valida y crea; solo con permiso", async () => {
  for (const mal of [{ titulo: "x" }, { costo: 0 }, { escalon: "diamante" }, { nivel_min: "vip" }, { stock: -1 }])
    assert.strictEqual((await admin("/puntos/premios", { metodo: "POST", cuerpo: { titulo: "Premio", costo: 100, ...mal } })).status, 400, JSON.stringify(mal));
  const p = await crearPremio({ titulo: "Premio <b>válido</b>", costo: 300 });
  assert.ok(!/[<>]/.test(p.titulo));
  assert.strictEqual((await api("/admin/puntos/premios", { metodo: "POST", cuerpo: { titulo: "Intruso", costo: 1 } })).status >= 400, true);
  assert.strictEqual((await admin(`/puntos/premios/${p.id}`, { metodo: "PATCH", cuerpo: { costo: 350, activo: false } })).status, 200);
  assert.strictEqual((await store.getPremio(p.id)).costo, 350);
});

test("catálogo: filtra por nivel, marca Oro como 'próximamente' según la decisión del club y avisa lo que falta", async () => {
  const bronce = await crearPremio({ titulo: "Premio bronce " + (++n), costo: 400 });
  const exclusivo = await crearPremio({ titulo: "Solo Plus " + n, costo: 100, nivel_min: "premium" });
  const oro = await crearPremio({ titulo: "Vestuario " + n, escalon: "oro", costo: 5000 });
  const A = await socio("Cat");
  await dar(A.id, 450);
  let c = (await premiosDe(A.h)).items;
  const f = (id) => c.find((x) => x.id === id);
  assert.strictEqual(f(bronce.id).puede_canjear, true);
  assert.ok(!f(exclusivo.id), "un premio de nivel Plus no se ofrece a un Olimpista gratis");
  assert.deepStrictEqual({ prox: f(oro.id).proximamente, puede: f(oro.id).puede_canjear, falta: f(oro.id).faltan }, { prox: true, puede: false, falta: 4550 });
  await store.setMembresia(A.id, { tierSlug: "premium", ciclo: "anio" });
  assert.ok((await premiosDe(A.h)).items.find((x) => x.id === exclusivo.id), "con Plus sí");
  await admin("/decisiones/oro", { metodo: "PUT", cuerpo: { valor: "habilita_futbol" } });
  await new Promise((x) => setTimeout(x, 10));
  assert.strictEqual((await premiosDe(A.h)).items.find((x) => x.id === oro.id).proximamente, false);
});

test("un socio sin fila de membresía (cuenta importada) cuenta como Olimpista: ve y canjea los premios básicos", async () => {
  const p = await crearPremio({ titulo: "Básico " + (++n), costo: 100 });
  const s = await store.createSocio({ email: `import${n}-${Date.now()}@ejemplo.com`, passwordHash: require("bcrypt").hashSync("clave-larga-123", 4), nombre: "Importado" });
  assert.strictEqual(await store.getMembresia(s.id), null, "precondición: sin membresía");
  const login = await (await api("/auth/login", { metodo: "POST", cuerpo: { email: s.email, password: "clave-larga-123" } })).json();
  const h = { Authorization: "Bearer " + login.token };
  await dar(s.id, 300);
  assert.ok((await premiosDe(h)).items.find((x) => x.id === p.id), "lo ve");
  assert.strictEqual((await api(`/puntos/premios/${p.id}/canjear`, { metodo: "POST", h })).status, 201);
});

test("canjear: descuenta los puntos, deja el canje pendiente, baja el stock y avisa al equipo", async () => {
  const p = await crearPremio({ titulo: "Entradas " + (++n), costo: 400, stock: 3 });
  const A = await socio("Canje");
  await dar(A.id, 1000);
  const r = await api(`/puntos/premios/${p.id}/canjear`, { metodo: "POST", h: A.h });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await r.json()).saldo, 600);
  assert.strictEqual(await saldo(A.id), 600);
  assert.strictEqual((await store.getPremio(p.id)).stock, 2);
  const canjes = await store.listCanjesPremio({ socioId: A.id });
  assert.deepStrictEqual({ n: canjes.length, estado: canjes[0].estado, costo: canjes[0].costo }, { n: 1, estado: "pendiente", costo: 400 });
  const mov = (await store.movimientosPuntos(A.id)).find((m) => m.motivo === "canje");
  assert.strictEqual(mov.puntos, -400);
});

test("canjear: sin saldo, agotado, Oro bloqueado, premio oculto o de otro nivel → rechazado y no se cobra nada", async () => {
  const caro = await crearPremio({ titulo: "Caro " + (++n), costo: 900 });
  const agotado = await crearPremio({ titulo: "Agotado " + n, costo: 10, stock: 0 });
  const oro = await crearPremio({ titulo: "Oro " + n, escalon: "oro", costo: 50 });
  const oculto = await crearPremio({ titulo: "Oculto " + n, costo: 10, activo: false });
  const plus = await crearPremio({ titulo: "Plus " + n, costo: 10, nivel_min: "premium" });
  const A = await socio("Rechazos");
  await dar(A.id, 500);
  const probar = async (id) => (await api(`/puntos/premios/${id}/canjear`, { metodo: "POST", h: A.h })).status;
  assert.strictEqual(await probar(caro.id), 409);
  assert.strictEqual(await probar(agotado.id), 409);
  assert.strictEqual(await probar(oro.id), 409, "Oro todavía no se publica");
  assert.strictEqual(await probar(oculto.id), 404);
  assert.strictEqual(await probar(plus.id), 403);
  assert.strictEqual(await probar("pre_inventado"), 404);
  assert.strictEqual(await saldo(A.id), 500, "ningún rechazo cobra");
  assert.strictEqual((await api(`/puntos/premios/${caro.id}/canjear`, { metodo: "POST" })).status, 401);
  const msg = await (await api(`/puntos/premios/${caro.id}/canjear`, { metodo: "POST", h: A.h })).json();
  assert.match(msg.error, /Te faltan 400 puntos/);
});

test("canjear: 6 pedidos simultáneos con saldo para uno solo → entra exactamente uno", async () => {
  const p = await crearPremio({ titulo: "Carrera " + (++n), costo: 400 });
  const A = await socio("Doble");
  await dar(A.id, 500);
  const rs = await Promise.all(Array.from({ length: 6 }, () => api(`/puntos/premios/${p.id}/canjear`, { metodo: "POST", h: A.h })));
  assert.strictEqual(rs.filter((r) => r.status === 201).length, 1);
  assert.strictEqual(await saldo(A.id), 100);
  assert.strictEqual((await store.listCanjesPremio({ socioId: A.id })).length, 1);
});

test("canjear: con stock 2 y cinco hinchas pidiendo a la vez → se entregan solo 2", async () => {
  const p = await crearPremio({ titulo: "Stock " + (++n), costo: 100, stock: 2 });
  const hs = [];
  for (let i = 0; i < 5; i++) { const s = await socio("S" + i); await dar(s.id, 200); hs.push(s); }
  const rs = await Promise.all(hs.map((s) => api(`/puntos/premios/${p.id}/canjear`, { metodo: "POST", h: s.h })));
  assert.strictEqual(rs.filter((r) => r.status === 201).length, 2);
  assert.strictEqual((await store.getPremio(p.id)).stock, 0);
  const sinPremio = (await Promise.all(hs.map((s) => saldo(s.id)))).filter((x) => x === 200).length;
  assert.strictEqual(sinPremio, 3, "a los 3 que no lo consiguieron no se les cobró");
});

test("admin de canjes: entregar avisa al hincha; cancelar devuelve los puntos y el stock; una sola resolución", async () => {
  const p = await crearPremio({ titulo: "Resolver " + (++n), costo: 300, stock: 5 });
  const A = await socio("Resuelve");
  await dar(A.id, 1000);
  const c1 = (await (await api(`/puntos/premios/${p.id}/canjear`, { metodo: "POST", h: A.h })).json()).canje.id;
  const c2 = (await (await api(`/puntos/premios/${p.id}/canjear`, { metodo: "POST", h: A.h })).json()).canje.id;
  assert.strictEqual(await saldo(A.id), 400);
  assert.strictEqual((await store.getPremio(p.id)).stock, 3);
  assert.strictEqual((await admin(`/puntos/canjes/${c1}`, { metodo: "PATCH", cuerpo: { estado: "entregado" } })).status, 200);
  await new Promise((x) => setTimeout(x, 30));
  assert.strictEqual(correos.filter((c) => c.n === "enviarPremioListo").length, 1);
  assert.strictEqual(correos.find((c) => c.n === "enviarPremioListo").datos.premio, p.titulo);
  assert.strictEqual((await admin(`/puntos/canjes/${c1}`, { metodo: "PATCH", cuerpo: { estado: "cancelado" } })).status, 409, "uno entregado no se cancela");
  const cs = await Promise.all([1, 2, 3, 4].map(() => admin(`/puntos/canjes/${c2}`, { metodo: "PATCH", cuerpo: { estado: "cancelado" } })));
  assert.strictEqual(cs.filter((r) => r.status === 200).length, 1, "cancelar simultáneo reintegra una sola vez");
  assert.strictEqual(await saldo(A.id), 700, "se devolvieron 300");
  assert.strictEqual((await store.getPremio(p.id)).stock, 4);
  assert.strictEqual((await admin("/puntos/canjes/cjp_inventado", { metodo: "PATCH", cuerpo: { estado: "entregado" } })).status, 404);
  assert.strictEqual((await admin(`/puntos/canjes/${c2}`, { metodo: "PATCH", cuerpo: { estado: "otro" } })).status, 400);
});

// ── Reglas editables y resumen ───────────────────────────────────────────────
test("admin de reglas: ver, ajustar y desactivar (con permiso); valida", async () => {
  const lista = (await (await admin("/puntos/reglas")).json()).items;
  assert.strictEqual(lista.length, 9);
  assert.strictEqual(lista.find((r) => r.clave === "referido").puntos, 300);
  assert.strictEqual((await adminRegla("referido", { puntos: 350 })).status, 200);
  assert.strictEqual((await adminRegla("referido", { puntos: -5 })).status, 400);
  assert.strictEqual((await adminRegla("referido", { puntos: 999999 })).status, 400);
  assert.strictEqual((await adminRegla("inventada", { puntos: 5 })).status, 404);
  assert.strictEqual((await adminRegla("referido", {})).status, 400);
  assert.strictEqual((await api("/admin/puntos/reglas", { metodo: "PUT", cuerpo: { clave: "referido", puntos: 1 } })).status >= 400, true);
});

test("resumen del club: el pasivo es lo que hay en saldos positivos", async () => {
  const antes = await (await admin("/puntos/resumen")).json();
  const A = await socio("Pasivo"); await dar(A.id, 700);
  const B = await socio("Pasivo2"); await dar(B.id, 300); await dar(B.id, -300);
  const d = await (await admin("/puntos/resumen")).json();
  assert.strictEqual(d.pasivo - antes.pasivo, 700);
  assert.strictEqual(d.socios_con_saldo - antes.socios_con_saldo, 1);
});

// ── Cuota y débito (Portal de Socios) ────────────────────────────────────────
async function socioClub(cedula) { return socio("Club" + cedula.slice(-1), { es_socio_olimpia: true, cedula }); }

test("cuota: suma con ACTIVE y LIFETIME, no con DEBT ni baja ni adherente; el débito automático suma una vez", async () => {
  const activo = await socioClub("5500001"), vita = await socioClub("5500002"), debt = await socioClub("5500003"), baja = await socioClub("5500004"), adher = await socioClub("5500000");
  const out = (await cron()).puntos.cuotas;
  assert.ok(out.revisados >= 5);
  assert.strictEqual(await saldo(activo.id), 100 + 500, "cuota + débito automático (el Tuti falso lo tiene activo en ACTIVE)");
  assert.strictEqual(await saldo(vita.id), 100, "LIFETIME suma la cuota, sin débito");
  assert.strictEqual(await saldo(debt.id), 0, "DEBT es un pago pendiente: no suma");
  assert.strictEqual(await saldo(baja.id), 0);
  assert.strictEqual(await saldo(adher.id), 0, "un adherente no figura como titular");
  const mov = await store.movimientosPuntos(debt.id);
  assert.deepStrictEqual(mov, [], "los movimientos de 0 puntos (marca de 'ya revisado') no se muestran");
});

test("cuota: cada socio se revisa UNA vez por mes (no se vuelve a consultar ni a sumar)", async () => {
  const a = await socioClub("5600001"), b = await socioClub("5600003");
  await cron();
  const consultadas = consultasTuti;
  const saldoA = await saldo(a.id);
  await cron(); await cron();
  assert.strictEqual(await saldo(a.id), saldoA);
  assert.strictEqual(consultasTuti, consultadas, "los ya revisados no se consultan de nuevo (incluso los que no suman)");
  assert.ok(b.id);
});

test("cuota: ante el límite de velocidad (429) se pausa sin marcar al socio, y sigue otro día", async () => {
  const limite = await socioClub("5700006"), otro = await socioClub("5700001");
  const out = (await cron()).puntos.cuotas;
  assert.strictEqual(out.pausado, "limite");
  assert.strictEqual((await store.sociosParaCuota({ mes: mesPy(), limit: 500 })).some((s) => s.id === limite.id), true, "no quedó marcado: se reintenta");
  tuti.__resetBloqueo();
  await store.sumarPuntos({ socioId: limite.id, motivo: "cuota", refId: mesPy(), puntos: 0, detalle: "marca" }); // el 6 del Tuti falso siempre da 429: se descarta para no frenar a los demás
  await cron();
  assert.ok(await saldo(otro.id) >= 100, "el resto se procesa cuando se levanta el límite");
});

test("cuota: la regla en 0 o desactivada no suma (pero igual se marca la revisión)", async () => {
  await adminRegla("cuota", { activa: false });
  await new Promise((x) => setTimeout(x, 10));
  const s = await socioClub("5800002");
  await cron();
  assert.strictEqual(await saldo(s.id), 0);
});

// ── Vencimiento por inactividad ──────────────────────────────────────────────
const haceMeses = (m) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString(); };

test("vencimiento: los puntos de quien pasó 12 meses sin actividad vencen (una sola vez); el activo no pierde nada", async () => {
  const inactivo = await socio("Inactivo"), activo = await socio("Activo");
  await dar(inactivo.id, 800); await dar(activo.id, 800);
  await store.updateSocio(inactivo.id, { ultima_actividad: haceMeses(13) });
  const out = (await cron()).puntos.vencimiento;
  assert.ok(out.vencidos >= 1);
  assert.strictEqual(await saldo(inactivo.id), 0);
  assert.strictEqual(await saldo(activo.id), 800);
  const mov = (await store.movimientosPuntos(inactivo.id)).find((m) => m.motivo === "vencimiento");
  assert.strictEqual(mov.puntos, -800);
  await cron(); await cron();
  assert.strictEqual((await store.movimientosPuntos(inactivo.id)).filter((m) => m.motivo === "vencimiento").length, 1);
  // vuelve a la app (la actividad se actualiza) y suma: sus puntos nuevos ya no vencen
  await store.updateSocio(inactivo.id, { ultima_actividad: new Date().toISOString() });
  await dar(inactivo.id, 100);
  await cron();
  assert.strictEqual(await saldo(inactivo.id), 100);
});

test("vencimiento: avisa UNA vez a los 11 meses de inactividad, con la fecha en que vencen", async () => {
  const s = await socio("PorVencer");
  await dar(s.id, 500);
  await store.updateSocio(s.id, { ultima_actividad: haceMeses(11) });
  await store.updateSocio(s.id, { ultima_actividad: new Date(new Date(haceMeses(11)).getTime() - 2 * DIA).toISOString() });
  await cron(); await cron();
  const avisos = correos.filter((c) => c.n === "enviarPuntosPorVencer" && c.a === s.id);
  assert.strictEqual(avisos.length, 1);
  assert.strictEqual(avisos[0].datos.saldo, 500);
  assert.ok(new Date(avisos[0].datos.vence).getTime() > Date.now() && new Date(avisos[0].datos.vence).getTime() < Date.now() + 40 * DIA, "vence dentro de ~30 días");
  assert.strictEqual(await saldo(s.id), 500, "todavía no venció");
});

test("vencimiento: con la decisión 'no vencen' no se vence ni se avisa", async () => {
  await admin("/decisiones/venc", { metodo: "PUT", cuerpo: { valor: "no_vencen" } });
  await new Promise((x) => setTimeout(x, 10));
  const s = await socio("Eterno");
  await dar(s.id, 900);
  await store.updateSocio(s.id, { ultima_actividad: haceMeses(30) });
  await cron();
  assert.strictEqual(await saldo(s.id), 900);
  assert.strictEqual(correos.filter((c) => c.a === s.id).length, 0);
});

// ── Ficha 360 ────────────────────────────────────────────────────────────────
test("ficha 360: muestra saldo, escalón y últimos movimientos", async () => {
  const A = await socio("Ficha");
  await dar(A.id, 1500);
  const f = await (await admin(`/socios/${A.id}/360`)).json();
  assert.deepStrictEqual({ saldo: f.puntos.saldo, esc: f.puntos.escalon, mov: f.puntos.movimientos.length }, { saldo: 1500, esc: "Plata", mov: 1 });
});
