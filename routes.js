"use strict";

/**
 * routes.js — API de Olimpistas. Se monta bajo /api.
 *
 * Público:   /config, /auth/registro, /auth/login
 * Socio:     /auth/yo, /auth/logout, /perfil*, /membresia, /pagos/*, /contenido,
 *            /sorteos, /preventas, /carnet
 *
 * El gateo por nivel se hace en el servidor (no confiar en el front).
 */

const express = require("express");
const crypto = require("crypto");
const { getStore } = require("./data/store");
const auth = require("./lib/auth");
const mailer = require("./lib/email");
const access = require("./lib/access");
const pagopar = require("./lib/pagopar");
const geo = require("./lib/geo");
const { listaPaises, paisNombre, paisCentroide, PAISES } = require("./data/paises");
const { BRAND, TIERS, PERFIL_CAMPOS, tierBySlug } = require("./config");

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    const status = e.status || 500;
    if (status >= 500) console.error("[olimpistas]", e);
    res.status(status).json({ error: e.message || "Error interno" });
  });

function setSessionCookie(res, token) {
  res.cookie(auth.COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

/** Progreso de completitud del perfil (alimenta la barra). */
function perfilProgreso(socio) {
  const total = PERFIL_CAMPOS.reduce((a, c) => a + c.peso, 0);
  let hechos = 0;
  const faltantes = [];
  for (const c of PERFIL_CAMPOS) {
    const lleno = socio && String(socio[c.key] || "").trim() !== "";
    if (lleno) hechos += c.peso;
    else faltantes.push({ key: c.key, label: c.label });
  }
  return { pct: Math.round((hechos / total) * 100), completos: hechos, total, faltantes };
}

const httpError = (status, message) => { const e = new Error(message); e.status = status; return e; };

function buildRouter() {
  const r = express.Router();
  const store = getStore();

  // ─── Config pública (branding + tiers + países) ─────────────────────────────
  r.get("/config", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300"); // estático (solo cambia en deploy) → cacheable en CDN/navegador
    res.json({ brand: BRAND, tiers: TIERS, paises: listaPaises() });
  });

  // País del visitante (prefill por IP / cabecera de CDN).
  r.get("/geo", wrap(async (req, res) => res.json({ pais: await geo.detectarPais(req) })));

  // ─── Stats: contador global + datos del globo (agregado, cacheado) ───────────
  let _stats = null, _statsTs = 0;
  async function getStats() {
    if (_stats && Date.now() - _statsTs < 30000) return _stats;  // cache 30s
    const [totalReal, porPaisRaw, porCiudadRaw, demo] = await Promise.all([
      store.contarTotal(), store.contarPorPais(), store.contarPorCiudad(), store.demoAgregado(),
    ]);

    // ── Merge miembros REALES + agregado de demo, por país y por ciudad ──
    const paisMap = new Map();   // iso → count
    const add = (map, key, n) => map.set(key, (map.get(key) || 0) + Number(n || 0));
    for (const r of porPaisRaw) add(paisMap, r.pais_iso, r.count);

    const ciudadMap = new Map(); // "iso|ciudad" → { iso, ciudad, count, lat, lng }
    const upCiudad = (iso, ciudad, count, lat, lng) => {
      const k = iso + "|" + (ciudad || "");
      const e = ciudadMap.get(k) || { iso, ciudad: ciudad || "", count: 0, lat: null, lng: null };
      e.count += Number(count || 0);
      if (lat != null && lng != null) { e.lat = Number(lat); e.lng = Number(lng); } // demo trae coords exactas
      ciudadMap.set(k, e);
    };
    for (const r of porCiudadRaw) upCiudad(r.pais_iso, r.ciudad, r.count, r.lat, r.lng);
    for (const r of demo) { add(paisMap, r.pais_iso, r.count); upCiudad(r.pais_iso, r.ciudad, r.count, r.lat, r.lng); }

    const demoTotal = demo.reduce((s, r) => s + Number(r.count || 0), 0);
    const total = totalReal + demoTotal;

    const porPais = [...paisMap.entries()]
      .map(([iso, count]) => {
        const c = paisCentroide(iso);
        return c ? { iso, nombre: paisNombre(iso), count, lat: c.lat, lng: c.lng } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count);

    // Puntos del globo (banderas por ciudad): coords exactas o centroide del país.
    const puntos = [...ciudadMap.values()]
      .map((r) => {
        const c = paisCentroide(r.iso);
        const lat = r.lat != null ? r.lat : (c ? c.lat : null);
        const lng = r.lng != null ? r.lng : (c ? c.lng : null);
        if (lat == null) return null;
        return { iso: r.iso, pais: paisNombre(r.iso), ciudad: r.ciudad, count: r.count, lat, lng };
      })
      .filter(Boolean)
      .sort((a, b) => b.count - a.count)
      .slice(0, 600);

    _stats = { total, paises: porPais.length, porPais, puntos, actualizado: new Date().toISOString() };
    _statsTs = Date.now();
    return _stats;
  }
  r.get("/stats", wrap(async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=30");   // el CDN absorbe el pico
    res.json(await getStats());
  }));

  // Banderas individuales ("casa") del recuadro visible — zoom alto del globo público.
  // bbox = minLng,minLat,maxLng,maxLat. Solo miembros que optaron por el punto exacto.
  r.get("/flags", wrap(async (req, res) => {
    const parts = String(req.query.bbox || "").split(",").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)))
      throw httpError(400, "bbox inválido (se espera minLng,minLat,maxLng,maxLat)");
    const [minLng, minLat, maxLng, maxLat] = parts;
    const flags = await store.flagsEnBBox({ minLng, minLat, maxLng, maxLat, limit: req.query.limit });
    res.setHeader("Cache-Control", "public, max-age=20");
    res.json({ flags });
  }));

  // Reconoce a un socio del padrón oficial de Olimpia y lo sube a Premium.
  // Devuelve true si lo reconoció (para que el front lo celebre).
  async function reconocerSocio(socio, cedula) {
    try {
      if (!store.buscarPadron) return false;
      const fila = await store.buscarPadron({ email: socio.email, cedula });
      if (!fila) return false;
      await store.setMembresia(socio.id, { tierSlug: "premium", ciclo: "anio" });
      await store.updateSocio(socio.id, { es_socio_olimpia: true });
      if (store.marcarPadronReclamado) await store.marcarPadronReclamado(fila.id, socio.id);
      return true;
    } catch (e) { console.error("[olimpistas] reconocerSocio:", e.message); return false; }
  }

  // ─── Auth ───────────────────────────────────────────────────────────────────
  r.post("/auth/registro", wrap(async (req, res) => {
    const { email, password, nombre, apellido, cedula } = req.body || {};
    const { socio, token } = await auth.registrar({ email, password, nombre, apellido, cedula });
    setSessionCookie(res, token);
    // El registro = alta automática como Olimpista gratis (el embudo).
    await store.setMembresia(socio.id, { tierSlug: "olimpista", ciclo: "anio" });
    // ¿Es socio del padrón oficial? → lo subimos a Premium automáticamente.
    const reconocido = await reconocerSocio(socio, cedula);
    // Verificación de email (best-effort: nunca rompe el registro si falta la columna/proveedor).
    try {
      const vtoken = crypto.randomBytes(24).toString("base64url");
      await store.updateSocio(socio.id, { verif_token: vtoken, email_verificado: false });
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
      const link = `${proto}://${req.headers.host}/api/auth/verificar?token=${vtoken}`;
      mailer.enviarVerificacion(socio, link).catch(() => {});
    } catch (e) { console.error("[olimpistas] verificación de email no disponible:", e.message); }
    res.status(201).json({ socio, token, reconocido });
  }));

  // ¿Ya sos socio de Olimpia? Chequeo previo (sin crear cuenta) por email o cédula.
  r.post("/auth/verificar-socio", wrap(async (req, res) => {
    const { email, cedula } = req.body || {};
    if (!store.buscarPadron) return res.json({ esSocio: false });
    const fila = await store.buscarPadron({ email, cedula });
    res.json({ esSocio: !!fila, nombre: fila ? (fila.nombre || "") : "", reclamado: fila ? !!fila.reclamado : false });
  }));

  r.post("/auth/login", wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const { socio, token } = await auth.login({ email, password });
    setSessionCookie(res, token);
    res.json({ socio, token });
  }));

  r.post("/auth/logout", wrap(async (req, res) => {
    await auth.logout(req.sessionToken);
    res.clearCookie(auth.COOKIE);
    res.json({ ok: true });
  }));

  r.get("/auth/yo", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    res.json({ socio: req.socio, membresia, progreso: perfilProgreso(req.socio) });
  }));

  // Verificación de email (link del correo). Tolerante: nunca tira error feo.
  r.get("/auth/verificar", wrap(async (req, res) => {
    let ok = false;
    try {
      const socio = req.query.token ? await store.getSocioByVerifToken(String(req.query.token)) : null;
      if (socio) { await store.updateSocio(socio.id, { email_verificado: true, verif_token: null }); ok = true; }
    } catch (e) { console.error("[olimpistas] verificar:", e.message); }
    res.redirect("/miembro?verificado=" + (ok ? "1" : "0"));
  }));

  // ─── Perfil (enriquecimiento + barra de progreso) ────────────────────────────
  r.get("/perfil", auth.requireSocio, wrap(async (req, res) => {
    res.json({ socio: req.socio, progreso: perfilProgreso(req.socio) });
  }));

  r.patch("/perfil", auth.requireSocio, wrap(async (req, res) => {
    const b = req.body || {};
    const patch = {};
    for (const key of ["nombre", "apellido", "whatsapp", "ciudad"]) {
      if (typeof b[key] === "string") patch[key] = b[key].trim().slice(0, 120);
    }
    // País: acepta código ISO ("PY") o nombre ("Paraguay"); guardamos iso + nombre.
    if (typeof b.pais === "string") {
      const raw = b.pais.trim();
      if (!raw) { patch.pais_iso = ""; patch.pais = ""; }
      else {
        let iso = raw.toUpperCase();
        if (!PAISES[iso]) {
          const porNombre = Object.keys(PAISES).find((k) => PAISES[k].nombre.toLowerCase() === raw.toLowerCase());
          iso = porNombre || null;
        }
        if (!iso) throw httpError(400, "País inválido");
        patch.pais_iso = iso;
        patch.pais = paisNombre(iso);
      }
    }
    // Ubicación exacta (opcional): lat/lng numéricos y dentro de rango.
    if (b.lat != null && b.lng != null) {
      const lat = Number(b.lat), lng = Number(b.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
        throw httpError(400, "Coordenadas inválidas");
      patch.lat = lat; patch.lng = lng;
    }
    // Gamificación: "poné tu bandera en tu casa" (mostrar el punto exacto en público).
    if (typeof b.mostrar_exacto === "boolean") patch.mostrar_exacto = b.mostrar_exacto;
    if (!Object.keys(patch).length) throw httpError(400, "Nada para actualizar");
    const socio = auth.sanitize(await store.updateSocio(req.socio.id, patch));
    res.json({ socio, progreso: perfilProgreso(socio) });
  }));

  r.post("/perfil/foto", auth.requireSocio, wrap(async (req, res) => {
    const { foto } = req.body || {};
    if (typeof foto !== "string" || !/^data:image\/(png|jpe?g|webp);base64,/.test(foto))
      throw httpError(400, "Imagen inválida (se espera un data URL de imagen)");
    if (foto.length > 800_000) throw httpError(413, "La imagen es muy grande (máx ~600KB)");
    const socio = auth.sanitize(await store.updateSocio(req.socio.id, { foto }));
    res.json({ ok: true, foto: socio.foto, progreso: perfilProgreso(socio) });
  }));

  // ─── Membresía ──────────────────────────────────────────────────────────────
  r.get("/membresia", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    res.json({ membresia, tier: membresia ? tierBySlug(membresia.tier_slug) : null });
  }));

  // Subir de nivel (Kids / Premium) → crea pedido de pago. Cobro anual único.
  r.post("/membresia/unirse", auth.requireSocio, wrap(async (req, res) => {
    const tier = tierBySlug(req.body?.tier);
    if (!tier) throw httpError(400, "Nivel inválido");
    const monto = tier.precioAnio;

    // Nivel gratis → membresía activa inmediata, sin pago.
    if (!monto || monto <= 0) {
      const membresia = await store.setMembresia(req.socio.id, { tierSlug: tier.slug, ciclo: "anio" });
      return res.json({ gratis: true, membresia });
    }

    const pedido = await store.createPedidoPago({
      socioId: req.socio.id, concepto: `Membresía ${tier.nombre}`,
      monto, moneda: BRAND.monedaCod, tierSlug: tier.slug, ciclo: "anio",
    });
    const pago = await pagopar.crearPedido({
      pedidoId: pedido.id, monto, concepto: pedido.concepto,
      comprador: { email: req.socio.email, nombre: req.socio.nombre },
    });
    await store.updatePedidoPago(pedido.id, { ref_externa: pago.hash });
    res.json({ gratis: false, pedido, pago, tier: tier.slug });
  }));

  // Confirmación de pago en modo SIMULADO (sin PAGOPAR). Activa la membresía.
  r.post("/pagos/confirmar-simulado", auth.requireSocio, wrap(async (req, res) => {
    if (pagopar.habilitado) throw httpError(400, "PAGOPAR está activo: usá el flujo real");
    const pedido = await store.getPedidoPago(req.body?.pedidoId);
    if (!pedido || pedido.socio_id !== req.socio.id) throw httpError(404, "Pedido no encontrado");

    await store.updatePedidoPago(pedido.id, { estado: "pagado" });
    const tier = tierBySlug(pedido.tier_slug);
    const membresia = tier
      ? await store.setMembresia(req.socio.id, { tierSlug: tier.slug, ciclo: pedido.ciclo, pagoRef: pedido.id })
      : null;
    res.json({ ok: true, membresia });
  }));

  // Webhook / verificación de PAGOPAR (real). El programador conecta esto.
  r.post("/pagos/webhook", wrap(async (req, res) => {
    // PAGOPAR notifica acá. Validar firma, marcar pedido pagado, activar membresía
    // usando pedido.tier_slug / pedido.ciclo. Stub: registrar y responder 200.
    console.log("[olimpistas] webhook PAGOPAR recibido:", JSON.stringify(req.body || {}));
    res.json({ ok: true });
  }));

  // ─── Contenido exclusivo (Olimpia Media+) ───────────────────────────────────
  r.get("/contenido", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const items = (await store.listContenido()).map((c) => ({
      ...c,
      desbloqueado: access.puedeAcceder(membresia, c.tier_min),
    }));
    res.json({ items, miNivel: access.nivelDeMembresia(membresia) });
  }));

  r.get("/contenido/:id", auth.requireSocio, wrap(async (req, res) => {
    const item = await store.getContenido(req.params.id);
    if (!item) throw httpError(404, "Contenido no encontrado");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, item.tier_min))
      throw httpError(403, "Este contenido es para Olimpistas Premium");
    res.json({ item, streamUrl: `/assets/demo-stream.mp4` });
  }));

  // ─── Sorteos ────────────────────────────────────────────────────────────────
  r.get("/sorteos", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const mias = req.socio ? await store.listParticipaciones(req.socio.id) : [];
    const setMios = new Set(mias.map(p => p.sorteo_id));
    const items = (await store.listSorteos()).map((s) => ({
      ...s,
      elegible: access.puedeAcceder(membresia, s.tier_min),
      participando: setMios.has(s.id),
    }));
    res.json({ items });
  }));

  r.post("/sorteos/:id/participar", auth.requireSocio, wrap(async (req, res) => {
    const sorteo = await store.getSorteo(req.params.id);
    if (!sorteo) throw httpError(404, "Sorteo no encontrado");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, sorteo.tier_min))
      throw httpError(403, "Este sorteo es para Olimpistas Premium");
    const participacion = await store.participarSorteo(sorteo.id, req.socio.id);
    res.json({ ok: true, participacion });
  }));

  // ─── Preventas de entradas ──────────────────────────────────────────────────
  r.get("/preventas", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const items = (await store.listPreventas()).map((p) => ({
      ...p,
      habilitada: access.puedeAcceder(membresia, p.tier_min),
    }));
    res.json({ items });
  }));

  r.post("/preventas/:id/reservar", auth.requireSocio, wrap(async (req, res) => {
    const preventa = await store.getPreventa(req.params.id);
    if (!preventa) throw httpError(404, "Preventa no encontrada");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, preventa.tier_min))
      throw httpError(403, "La preventa es para Olimpistas Premium");
    const cantidad = Math.max(1, Math.min(4, parseInt(req.body?.cantidad || "1", 10)));
    const reserva = await store.reservarPreventa(preventa.id, req.socio.id, cantidad);
    if (reserva?.error === "sin_stock") throw httpError(409, "No hay stock suficiente");
    res.json({ ok: true, reserva });
  }));

  // ─── Carnet digital ─────────────────────────────────────────────────────────
  r.get("/carnet", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    if (!membresia) throw httpError(404, "Todavía no sos Olimpista. Registrate para tener carnet.");
    const tier = tierBySlug(membresia.tier_slug);
    res.json({
      carnet: {
        socioId: req.socio.id,
        nombre: [req.socio.nombre, req.socio.apellido].filter(Boolean).join(" ") || req.socio.email,
        iso: req.socio.pais_iso || "",
        foto: req.socio.foto || "",
        tier: tier?.nombre || membresia.tier_slug,
        tierSlug: membresia.tier_slug,
        color: tier?.color || "#000",
        desde: membresia.inicio,
        numero: "OLI-" + req.socio.id.replace(/\D/g, "").slice(0, 8).padStart(8, "0"),
      },
    });
  }));

  return r;
}

module.exports = { buildRouter };
