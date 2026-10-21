"use strict";
// Sprint 5 — panel del club por rol: secciones por rol, default-deny de los roles restringidos,
// permisos finos por sección, solo lectura de la Comisión Directiva, tablero e integraciones.
process.env.OLIMPISTAS_PERSIST = "0";
process.env.OLIMPISTAS_DATABASE_URL = "";
process.env.NODE_ENV = "test";
process.env.ADMIN_KEY = "clave-admin-de-prueba";
process.env.CRON_SECRET = "secreto-de-cron-de-prueba";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const adminAuth = require("../lib/admin-auth");

// ── Reglas puras ─────────────────────────────────────────────────────────────
test("mapeo ruta → sección: cubre los prefijos del panel y no inventa lo desconocido", () => {
  const s = adminAuth.seccionDeRuta;
  assert.strictEqual(s("/admin/socios/abc/membresia"), "hinchas");
  assert.strictEqual(s("/admin/export/socios.csv"), "hinchas");
  assert.strictEqual(s("/admin/export/pagos.csv"), "pagos");
  assert.strictEqual(s("/admin/export/otra-cosa.csv"), null);
  assert.strictEqual(s("/admin/comercios/estadisticas.csv"), "beneficios");
  assert.strictEqual(s("/admin/puntos/premios"), "puntos");
  assert.strictEqual(s("/admin/penas/canje/x"), "penas");
  assert.strictEqual(s("/admin/subastas/s1/extender?x=1"), "subastas");
  assert.strictEqual(s("/admin/tablero"), "tablero");
  assert.strictEqual(s("/admin/usuarios/u1"), "roles");
  assert.strictEqual(s("/admin/ruta-nueva-sin-mapear"), null);
  assert.strictEqual(s("/socios/me"), null, "lo que no es /admin no pertenece al panel");
});

test("roles restringidos: default-deny (ruta sin mapear = negada); el resto conserva lecturas abiertas", () => {
  for (const rol of adminAuth.RESTRINGIDOS) {
    assert.strictEqual(adminAuth.accesoRuta(rol, "/admin/ruta-nueva-sin-mapear").ok, false, `${rol}: lo desconocido se niega`);
    assert.strictEqual(adminAuth.accesoRuta(rol, "/admin/tablero").ok, true, `${rol} ve el tablero`);
  }
  assert.strictEqual(adminAuth.accesoRuta("soporte", "/admin/ruta-nueva-sin-mapear").ok, true, "soporte es histórico: no restringido");
  assert.strictEqual(adminAuth.accesoRuta("owner", "/admin/lo-que-sea").ok, true);
  assert.strictEqual(adminAuth.accesoRuta("cd", "/admin/pagos-recibidos").ok, false, "la CD no entra a pagos individuales");
  assert.strictEqual(adminAuth.accesoRuta("cd", "/admin/decisiones").ok, true);
  assert.strictEqual(adminAuth.accesoRuta("comercial", "/admin/export/socios.csv").ok, false, "comercial no baja el padrón de hinchas");
  assert.strictEqual(adminAuth.accesoRuta("marketing", "/admin/usuarios").ok, false);
});

test("coherencia de la matriz: cada rol ve solo secciones válidas, ROLES las incluye todas y toda sección tiene un área del nav", () => {
  for (const rol of adminAuth.ROLES) {
    assert.ok(adminAuth.VER_POR_ROL[rol], `VER_POR_ROL.${rol}`);
    assert.ok(adminAuth.PERMS_POR_ROL[rol], `PERMS_POR_ROL.${rol}`);
    assert.ok(adminAuth.AREAS_POR_ROL[rol], `AREAS_POR_ROL.${rol}`);
    for (const sec of adminAuth.VER_POR_ROL[rol]) {
      assert.ok(adminAuth.SECCIONES.includes(sec), `${rol} ve una sección inexistente: ${sec}`);
      assert.ok(adminAuth.AREA_DE_SECCION[sec], `la sección ${sec} no tiene área`);
      assert.ok(adminAuth.AREAS_POR_ROL[rol].includes(adminAuth.AREA_DE_SECCION[sec]), `${rol} ve ${sec} pero no tiene el área ${adminAuth.AREA_DE_SECCION[sec]} en el nav`);
    }
  }
  assert.deepStrictEqual(adminAuth.SECCIONES.filter((s) => !adminAuth.AREA_DE_SECCION[s]), []);
});

test("solo lectura: la CD y lectura no tienen ningún permiso de escritura ni de exportar", () => {
  for (const rol of adminAuth.SOLO_LECTURA) assert.deepStrictEqual(adminAuth.PERMS_POR_ROL[rol], [], rol);
});

// ── Servidor ─────────────────────────────────────────────────────────────────
const app = require("../server");
const { getStore } = require("../data/store");
const store = getStore();
let srv, url;
before(async () => { srv = await new Promise((res) => { const s = app.listen(0, () => res(s)); }); url = `http://127.0.0.1:${srv.address().port}`; });
after(() => srv && srv.close());

const api = (ruta, { metodo = "GET", cuerpo, h = {} } = {}) => fetch(url + "/api" + ruta, { method: metodo, headers: { "Content-Type": "application/json", ...h }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
const OWNER = { "x-admin-key": "clave-admin-de-prueba" };

const tokens = {};
async function como(rol) {
  if (tokens[rol]) return { "x-admin-token": tokens[rol] };
  await adminAuth.crearAdminUsuario({ usuario: `u-${rol}`, nombre: rol, password: "clave-de-prueba-1", rol });
  const out = await adminAuth.loginAdmin({ usuario: `u-${rol}`, password: "clave-de-prueba-1" });
  tokens[rol] = out.token;
  return { "x-admin-token": out.token };
}
const hit = async (rol, ruta, o = {}) => api("/admin" + ruta, { ...o, h: await como(rol) });

test("whoami informa secciones y solo lectura según el rol", async () => {
  const cd = await (await hit("cd", "/whoami")).json();
  assert.strictEqual(cd.rol, "cd");
  assert.strictEqual(cd.solo_lectura, true);
  assert.ok(cd.secciones.includes("decisiones") && !cd.secciones.includes("pagos"));
  assert.ok(cd.areas.includes("decisiones"));
  const own = await (await api("/admin/whoami", { h: OWNER })).json();
  assert.strictEqual(own.solo_lectura, false);
  assert.strictEqual(own.secciones.length, adminAuth.SECCIONES.length);
});

test("la CD ve el tablero y las decisiones, pero no los pagos ni los hinchas con nombre", async () => {
  assert.strictEqual((await hit("cd", "/tablero")).status, 200);
  assert.strictEqual((await hit("cd", "/decisiones")).status, 200);
  assert.strictEqual((await hit("cd", "/subastas")).status, 200);
  for (const ruta of ["/pagos-recibidos", "/cuadre", "/usuarios", "/acciones", "/campanas", "/padron"]) {
    const r = await hit("cd", ruta);
    assert.strictEqual(r.status, 403, "CD → " + ruta);
  }
});

test("la CD no puede registrar decisiones ni tocar nada: mensaje claro de solo lectura", async () => {
  const r = await hit("cd", "/decisiones/pct", { metodo: "PUT", cuerpo: { valor: "15" } });
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /solo lectura/);
  const r2 = await hit("cd", "/subastas", { metodo: "POST", cuerpo: { titulo: "x" } });
  assert.strictEqual(r2.status, 403);
  assert.match((await r2.json()).error, /solo lectura/);
  // y el owner sí puede
  const ok = await api("/admin/decisiones/pct", { metodo: "PUT", cuerpo: { valor: "15" }, h: OWNER });
  assert.strictEqual(ok.status, 200);
  const d = await (await hit("cd", "/decisiones")).json();
  assert.strictEqual(d.items.find((x) => x.clave === "pct").valor, "15");
});

test("permisos finos: comercial edita beneficios pero no subastas; operaciones edita subastas pero no puntos", async () => {
  const comercio = await store.crearComercio({ nombre: "Farmacia", ciudad: "Asunción", contacto: "f@demo.test" });
  const b = await store.crearBeneficioComercio({ comercioId: comercio.id, titulo: "10%", valor: "10%", niveles: "todos", pct: 10 });
  assert.strictEqual((await hit("comercial", "/beneficios/" + b.id, { metodo: "PATCH", cuerpo: { estado: "aprobado" } })).status, 200, "comercial aprueba ofertas");
  assert.strictEqual((await hit("comercial", "/subastas", { metodo: "POST", cuerpo: { titulo: "Camiseta" } })).status, 403, "comercial no crea subastas");
  assert.strictEqual((await hit("comercial", "/puntos/reglas")).status, 403, "ni siquiera ve puntos");
  assert.strictEqual((await hit("operaciones", "/puntos/premios", { metodo: "POST", cuerpo: { titulo: "x", costo: 100 } })).status, 403, "operaciones no ve puntos");
  assert.strictEqual((await hit("operaciones", "/subastas")).status, 200);
  assert.strictEqual((await hit("marketing", "/puntos/resumen")).status, 200, "marketing ve puntos");
  assert.strictEqual((await hit("marketing", "/pagos-recibidos")).status, 403, "marketing no ve pagos");
});

test("finanzas aprueba el canje del fondo de peñas (pagos.write) y soporte no", async () => {
  assert.strictEqual((await hit("soporte", "/penas/canje/inexistente", { metodo: "POST", cuerpo: { accion: "aprobar" } })).status, 403);
  const r = await hit("finanzas", "/penas/canje/inexistente", { metodo: "POST", cuerpo: { accion: "aprobar" } });
  assert.notStrictEqual(r.status, 403, "pasa la barrera de permisos (el canje no existe → otro error)");
  assert.notStrictEqual(r.status, 401);
});

test("roles históricos conservan lo que ya podían: marketing sigue creando subastas y soporte sigue viendo todo en lectura", async () => {
  assert.strictEqual((await hit("marketing", "/subastas", { metodo: "POST", cuerpo: { titulo: "Remera firmada", precio_inicial: 100000 } })).status, 201);
  assert.strictEqual((await hit("soporte", "/pagos-recibidos")).status, 200);
  assert.strictEqual((await hit("lectura", "/campanas")).status, 200);
  assert.strictEqual((await hit("lectura", "/campanas/pago", { metodo: "POST", cuerpo: {} })).status, 403);
});

test("tablero: números agregados, sin datos personales", async () => {
  const r = await hit("cd", "/tablero");
  const d = await r.json();
  for (const k of ["hinchas", "ingresos", "subastas", "puntos", "penas", "beneficios", "decisiones"]) assert.ok(d[k] && typeof d[k] === "object", k);
  assert.strictEqual(typeof d.hinchas.total, "number");
  assert.strictEqual(d.decisiones.total, 6);
  assert.ok(!/@|cedula|password/i.test(JSON.stringify(d)), "nada de emails ni cédulas en el tablero");
});

test("integraciones: solo estado, nunca valores de claves", async () => {
  process.env.GHL_WEBHOOK_URL = "https://hooks.example.com/super-secreto-123";
  const d = await (await api("/admin/integraciones", { h: OWNER })).json();
  delete process.env.GHL_WEBHOOK_URL;
  const ghl = d.items.find((i) => i.id === "ghl");
  assert.strictEqual(ghl.estado, "conectado");
  assert.ok(!JSON.stringify(d).includes("super-secreto-123"));
  assert.ok(["tuti", "pagopar", "email", "ghl", "ia", "alertas", "cron"].every((id) => d.items.some((i) => i.id === id)));
  assert.strictEqual(d.items.find((i) => i.id === "cron").estado, "conectado");
  assert.strictEqual((await hit("cd", "/integraciones")).status, 403);
  assert.strictEqual((await hit("finanzas", "/integraciones")).status, 200);
});

test("matriz de roles: solo la ve quien gestiona usuarios", async () => {
  const d = await (await api("/admin/roles", { h: OWNER })).json();
  assert.deepStrictEqual(d.roles.map((r) => r.rol).sort(), adminAuth.ROLES.slice().sort());
  const cd = d.roles.find((r) => r.rol === "cd");
  assert.deepStrictEqual([cd.restringido, cd.solo_lectura], [true, true]);
  assert.strictEqual((await hit("marketing", "/roles")).status, 403);
  assert.strictEqual((await hit("finanzas", "/roles")).status, 403);
});

test("crear usuarios con los roles nuevos funciona y rechaza roles inventados", async () => {
  for (const rol of ["cd", "comercial", "operaciones"]) {
    const r = await api("/admin/usuarios", { metodo: "POST", cuerpo: { usuario: "nuevo-" + rol, nombre: rol, password: "clave-larga-123", rol }, h: OWNER });
    assert.strictEqual(r.status, 201, rol);
  }
  const mal = await api("/admin/usuarios", { metodo: "POST", cuerpo: { usuario: "nuevo-x", nombre: "x", password: "clave-larga-123", rol: "superadmin" }, h: OWNER });
  assert.strictEqual(mal.status, 400);
});
