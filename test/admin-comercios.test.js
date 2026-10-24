"use strict";
// Panel de comercios de la red: resumen (lo que falta + canjes del mes) y la tabla del admin.
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
const leer = (...p) => fs.readFileSync(path.join(__dirname, "..", ...p), "utf8");

let srv, url;
const H = { "x-admin-key": "clave-admin-de-prueba" };
before(async () => {
  srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`;
  const completo = await store.crearComercio({ nombre: "Zeta Completo", rubro: "Moda", ciudad: "Asunción", logo: "/assets/comercios/zeta.png" });
  await store.updateComercio(completo.id, { lat: -25.28, lng: -57.63, usuario: "zeta", password_hash: "x" });
  const b1 = await store.crearBeneficio({ comercio_id: completo.id, titulo: "30%", valor: "30%" });
  const s = await store.createSocio({ email: "canje-comercios@ejemplo.com", passwordHash: "x", nombre: "C" });
  await store.registrarCanje({ beneficioId: b1.id, socioId: s.id, comercioId: completo.id, monto: 100000, ahorro: 30000, validadoPor: "t" }).catch(() => {});
  await store.crearComercio({ nombre: "Alfa Vacío", rubro: "Gastronomía", ciudad: "Luque" });   // sin logo, ubicación, acceso ni beneficios
});
after(() => srv && srv.close());
const api = (ruta, h = {}) => fetch(url + "/api" + ruta, { headers: h });

test("el resumen es solo para admin, ordena por nombre y no trae contraseñas", async () => {
  assert.ok([401, 403].includes((await api("/admin/comercios/resumen")).status));
  const r = await (await api("/admin/comercios/resumen", H)).json();
  assert.match(r.mes, /^\d{4}-\d{2}$/);
  const nombres = r.items.map((c) => c.nombre);
  assert.deepStrictEqual(nombres, [...nombres].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  for (const c of r.items) assert.ok(!("password_hash" in c), "sin contraseña");
});

test("dice qué le falta a cada comercio y cuenta beneficios publicados", async () => {
  const r = await (await api("/admin/comercios/resumen", H)).json();
  const alfa = r.items.find((c) => c.nombre === "Alfa Vacío"), zeta = r.items.find((c) => c.nombre === "Zeta Completo");
  assert.deepStrictEqual({ logo: alfa.logo, lat: alfa.lat, usuario: alfa.usuario, pub: alfa.beneficios_pub, canjes: alfa.canjes_mes }, { logo: false, lat: null, usuario: null, pub: 0, canjes: 0 });
  assert.deepStrictEqual({ logo: zeta.logo, ubicado: zeta.lat != null, acceso: !!zeta.usuario, pub: zeta.beneficios_pub }, { logo: true, ubicado: true, acceso: true, pub: 1 });
  assert.strictEqual(typeof zeta.ahorro_mes, "number");
});

test("pantalla: filtros por lo que falta, tabla ordenable, acciones que reutilizan el formulario existente y exportación", () => {
  const h = leer("public", "admin.html");
  for (const id of ["comFalta", "comEstado", "comRubro", "comLimpiar", "comCsv", "comResumen", "comWrap"]) assert.ok(h.includes('id="' + id + '"'), id);
  assert.match(h, /api\("\/admin\/comercios\/resumen"\)/);
  assert.match(h, /if \(veSeccion\("beneficios"\)\) \{ iniciarComercios\(\); cargarComercios\(\); cargarOfertasAdmin\(\); \}/);
  for (const k of ["Sin logo", "Sin ubicación", "Sin acceso al portal", "Sin beneficios publicados", "Con ofertas por aprobar", "Sin canjes este mes"]) assert.ok(h.includes(k), k);
  assert.match(h, /data-comedit/);
  assert.match(h, /accesoComercio\(id\)/, "el acceso reutiliza la ventana que ya existe");
  assert.match(h, /\[=\+\\-@\\t\\r\]/, "el CSV neutraliza fórmulas");
  assert.match(h, /puede\("beneficios\.write"\) \? '<div class="row-actions"><button class="btn btn-sm btn-ghost" data-comedit/, "editar exige el permiso de beneficios");
});
