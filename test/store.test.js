"use strict";
// Store en memoria: lógica crítica de negocio (subastas atómicas, encuestas, beneficios
// escalonado, idempotencia del cron, sesiones). No persiste a disco (OLIMPISTAS_PERSIST=0).
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";

const { test } = require("node:test");
const assert = require("node:assert");
const { getStore } = require("../data/store");
const store = getStore();

test("beneficios: modelo ESCALONADO (tier alto ve beneficios de nivel inferior)", async () => {
  const com = await store.crearComercio({ nombre: "Comercio A", estado: "activo" });
  await store.crearBeneficio({ comercio_id: com.id, titulo: "B-Premium", niveles: "premium" });
  await store.crearBeneficio({ comercio_id: com.id, titulo: "B-Olimpista", niveles: "olimpista" });
  const find = (arr, t) => arr.find((b) => b.titulo === t);
  const socio = await store.beneficiosParaNivel("socio");
  const olim = await store.beneficiosParaNivel("olimpista");
  assert.equal(find(socio, "B-Premium").desbloqueado, true, "socio ve beneficio premium");
  assert.equal(find(olim, "B-Premium").desbloqueado, false, "olimpista NO ve beneficio premium");
  assert.equal(find(olim, "B-Olimpista").desbloqueado, true, "olimpista ve beneficio olimpista");
});

test("cron idempotente: reservarNotificacion true la 1ra vez, false luego", async () => {
  assert.equal(await store.reservarNotificacion("cumple:x:2026-08-03"), true);
  assert.equal(await store.reservarNotificacion("cumple:x:2026-08-03"), false);
  assert.equal(await store.reservarNotificacion("cumple:x:2026-08-04"), true);
});

test("sesiones: purga vencidas + borrar todas las de un socio", async () => {
  await store.createSession("socS", "tk-viva", new Date(Date.now() + 1e6).toISOString());
  await store.createSession("socS", "tk-vieja", new Date(Date.now() - 1e6).toISOString());
  const purgadas = await store.purgarSesionesVencidas();
  assert.ok(purgadas >= 1);
  assert.equal(await store.getSession("tk-vieja"), null);
  await store.borrarSesionesDeSocio("socS");
  assert.equal(await store.getSession("tk-viva"), null);
});

test("setMembresia reemplaza SOLO la activa (no pisa el historial)", async () => {
  await store.setMembresia("socM", { tierSlug: "premium" });
  await store.setMembresia("socM", { tierSlug: "socio" });
  const activa = await store.getMembresia("socM");
  assert.equal(activa.tier_slug, "socio");
});

async function subastaActiva(opts = {}) {
  const s = await store.crearSubasta({ titulo: "Lote", nivel_min: "olimpista", precio_inicial: 100000, incremento: 50000, duracion_horas: 48 });
  const termina = opts.termina || new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  await store.updateSubasta(s.id, { estado: "activa", inicia: new Date().toISOString(), termina });
  return s.id;
}

test("pujar: guard de monto mínimo (precio_inicial + incremento)", async () => {
  const id = await subastaActiva();
  const baja = await store.pujar({ subastaId: id, socioId: "p1", monto: 120000 }); // < 150000
  assert.equal(baja.ok, false);
  assert.equal(baja.motivo, "monto_bajo");
  const ok = await store.pujar({ subastaId: id, socioId: "p1", monto: 150000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.subasta.puja_actual, 150000);
  assert.equal(ok.subasta.ganador_id, "p1");
});

test("pujar: anti-sniping extiende el cierre si faltan <3min", async () => {
  const id = await subastaActiva({ termina: new Date(Date.now() + 90 * 1000).toISOString() }); // 90s
  const out = await store.pujar({ subastaId: id, socioId: "p2", monto: 150000 });
  assert.equal(out.ok, true);
  assert.equal(out.extendida, true, "debe extender el cierre");
  assert.ok(new Date(out.subasta.termina).getTime() - Date.now() > 100 * 1000, "termina se movió a ~now+3min");
});

test("pujar: rechaza en subasta cerrada", async () => {
  const id = await subastaActiva({ termina: new Date(Date.now() - 1000).toISOString() });
  const out = await store.pujar({ subastaId: id, socioId: "p3", monto: 999999 });
  assert.equal(out.ok, false);
  assert.equal(out.motivo, "cerrada");
});

test("encuestas: conteo agregado + una respuesta por socio (upsert)", async () => {
  const e = await store.crearEncuesta({ pregunta: "P", opciones: ["A", "B", "C"], tipo: "opcion", estado: "activa" });
  await store.responderEncuesta({ encuestaId: e.id, socioId: "u1", opcion: 0 });
  await store.responderEncuesta({ encuestaId: e.id, socioId: "u2", opcion: 0 });
  await store.responderEncuesta({ encuestaId: e.id, socioId: "u2", opcion: 1 }); // u2 cambia → NO suma
  const r = await store.resultadosEncuesta(e.id);
  assert.equal(r.total, 2, "2 votantes únicos");
  assert.equal(r.conteo[0].n, 1); // u1
  assert.equal(r.conteo[1].n, 1); // u2 (actualizado)
  assert.equal(r.conteo[2].n, 0);
});

test("encuestas: no se puede responder una cerrada", async () => {
  const e = await store.crearEncuesta({ pregunta: "P2", opciones: ["A"], tipo: "opcion", estado: "borrador" });
  const out = await store.responderEncuesta({ encuestaId: e.id, socioId: "u9", opcion: 0 });
  assert.equal(out.ok, false);
});
