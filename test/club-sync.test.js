"use strict";
// Consulta de fondo a la API de socios: orden de prioridad, cuidado del límite y lo que queda guardado.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");
const { createMemoryStore } = require("../data/memory-store");
const sync = require("../lib/club-sync");

let store, llamadas;
beforeEach(() => { store = createMemoryStore({ filePath: null }); llamadas = []; delete process.env.TUTI_BARRIDO; });
const sinPausa = { pausaMs: 0, dormirFn: async () => {} };
const reg = (cedula, extra = {}) => ({ cedula, grupo: "PERSONAL", nro_socio: "", socio_desde: null, fecha_calidad: "sin_fecha", antig_anios: null, meses_pagados: 0, activo_erp: true, nombre: "", correo: "", telefono: "", nacimiento: null, ...extra });
// API falsa: termina en 1 → ACTIVE, en 3 → DEBT, en 4 → UNSUBSCRIBED, el resto → 404
const tutiFalsa = (opciones = {}) => ({
  habilitado: () => opciones.habilitado !== false,
  consultarSocio: async (ced) => {
    llamadas.push(ced);
    if (opciones.responder) { const r = opciones.responder(ced, llamadas.length); if (r) return r; }
    const u = ced.slice(-1), base = { documentNumber: ced, plan: "Socio Pleno", numeroSocio: "777", deuda: 0 };
    if (u === "1") return { ok: true, encontrado: true, socio: { ...base, status: "ACTIVE", alDia: true } };
    if (u === "3") return { ok: true, encontrado: true, socio: { ...base, status: "DEBT", alDia: true, deuda: 90000 } };
    if (u === "4") return { ok: true, encontrado: true, socio: { ...base, status: "UNSUBSCRIBED", alDia: false } };
    return { ok: true, encontrado: false };
  },
});

test("orden: primero las cuentas con cédula, después las de la base con correo de una cuenta, al final el resto (familiares últimos)", async () => {
  await store.createSocio({ email: "cuenta-uno@ejemplo.com", passwordHash: "x", nombre: "A", cedula: "1000001" });
  const sinCed = await store.createSocio({ email: "coincide@ejemplo.com", passwordHash: "x", nombre: "B" });
  assert.ok(sinCed);
  await store.upsertSociosClub([
    reg("1000001"),                                              // también es cuenta con cédula: sale una sola vez
    reg("2000002", { correo: "coincide@ejemplo.com" }),           // correo de una cuenta
    reg("2000005", { grupo: "FAMILIAR" }),
    reg("2000006"),
    reg("2000007"),
  ]);
  const lista = await store.siguientesParaConsultar({ limite: 10 });
  assert.deepStrictEqual(lista, ["1000001", "2000002", "2000006", "2000007", "2000005"]);
  assert.strictEqual((await store.siguientesParaConsultar({ limite: 2 })).length, 2, "respeta el tamaño del lote");
});

test("guarda lo que devuelve la API: al día, con deuda, baja y no encontrado", async () => {
  await store.upsertSociosClub([reg("3000001"), reg("3000003"), reg("3000004"), reg("3000009")]);
  const r = await sync.procesarLote({ store, tuti: tutiFalsa(), limite: 10, ...sinPausa });
  assert.deepStrictEqual({ c: r.consultadas, e: r.encontradas, n: r.no_encontradas, err: r.errores, corte: r.cortado_por }, { c: 4, e: 3, n: 1, err: 0, corte: null });
  const g = async (c) => store.getSocioClub(c);
  assert.deepStrictEqual([(await g("3000001")).tuti_estado, (await g("3000001")).tuti_al_dia, (await g("3000001")).tuti_numero], ["ACTIVE", true, "777"]);
  assert.deepStrictEqual([(await g("3000003")).tuti_estado, (await g("3000003")).tuti_deuda], ["DEBT", 90000]);
  assert.deepStrictEqual([(await g("3000004")).tuti_estado, (await g("3000004")).tuti_al_dia], ["UNSUBSCRIBED", false]);
  assert.strictEqual((await g("3000009")).tuti_estado, "NO_ENCONTRADO");
  const res = await store.resumenSociosClub();
  assert.deepStrictEqual({ consultados: res.consultados, pendientes: res.pendientes }, { consultados: 4, pendientes: 0 });
});

test("no vuelve a consultar lo reciente, pero sí refresca a las cuentas con estado viejo", async () => {
  await store.createSocio({ email: "c@ejemplo.com", passwordHash: "x", nombre: "C", cedula: "4000001" });
  await store.upsertSociosClub([reg("4000002")]);
  await sync.procesarLote({ store, tuti: tutiFalsa(), limite: 10, ...sinPausa });
  assert.deepStrictEqual(llamadas.sort(), ["4000001", "4000002"]);
  llamadas.length = 0;
  await sync.procesarLote({ store, tuti: tutiFalsa(), limite: 10, ...sinPausa });
  assert.deepStrictEqual(llamadas, [], "todo es reciente");
  await new Promise((x) => setTimeout(x, 5));
  await sync.procesarLote({ store, tuti: tutiFalsa(), limite: 10, staleDias: 0, ...sinPausa });
  assert.deepStrictEqual(llamadas, ["4000001"], "solo la cuenta se refresca; la de la base ya tiene estado");
});

test("se corta cuando la API pide frenar o rechaza las credenciales, y tras 5 errores de red seguidos", async () => {
  await store.upsertSociosClub(["5000001", "5000011", "5000021", "5000031", "5000041"].map((c) => reg(c)));
  const limite = await sync.procesarLote({ store, tuti: tutiFalsa({ responder: (c, n) => (n === 3 ? { ok: false, motivo: "limite" } : null) }), limite: 10, ...sinPausa });
  assert.deepStrictEqual({ c: limite.consultadas, corte: limite.cortado_por, llamadas: llamadas.length }, { c: 2, corte: "limite", llamadas: 3 });
  llamadas.length = 0;
  const cred = await sync.procesarLote({ store, tuti: tutiFalsa({ responder: () => ({ ok: false, motivo: "credenciales" }) }), limite: 10, ...sinPausa });
  assert.strictEqual(cred.cortado_por, "credenciales");
  assert.strictEqual(llamadas.length, 1, "no insiste");
  await store.upsertSociosClub(Array.from({ length: 8 }, (_, i) => reg("60000" + String(i).padStart(2, "0") + "7")));
  llamadas.length = 0;
  const red = await sync.procesarLote({ store, tuti: tutiFalsa({ responder: () => ({ ok: false, motivo: "red" }) }), limite: 10, ...sinPausa });
  assert.deepStrictEqual({ corte: red.cortado_por, err: red.errores, llamadas: llamadas.length }, { corte: "errores_seguidos", err: 5, llamadas: 5 });
});

test("interruptor TUTI_BARRIDO=off, API apagada y tope del lote", async () => {
  await store.upsertSociosClub([reg("7000001"), reg("7000011")]);
  process.env.TUTI_BARRIDO = "off";
  assert.strictEqual((await sync.procesarLote({ store, tuti: tutiFalsa(), ...sinPausa })).cortado_por, "apagado");
  delete process.env.TUTI_BARRIDO;
  assert.strictEqual((await sync.procesarLote({ store, tuti: tutiFalsa({ habilitado: false }), ...sinPausa })).cortado_por, "api_no_habilitada");
  assert.deepStrictEqual(llamadas, [], "ni una consulta");
  const r = await sync.procesarLote({ store, tuti: tutiFalsa(), limite: 1, ...sinPausa });
  assert.strictEqual(r.consultadas, 1, "el lote respeta su tamaño");
});
