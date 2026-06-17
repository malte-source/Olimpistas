"use strict";

/**
 * routes.js — API de Olimpistas. Se monta bajo /api.
 *
 * Público:   /config, /auth/registro, /auth/login
 * Socio:     /auth/yo, /auth/logout, /membresia, /pagos/*, /contenido, /sorteos,
 *            /preventas, /carnet
 *
 * El gateo por tier se hace en el servidor (no confiar en el front).
 */

const express = require("express");
const { getStore } = require("./data/store");
const auth = require("./lib/auth");
const access = require("./lib/access");
const pagopar = require("./lib/pagopar");
const { BRAND, TIERS, tierBySlug } = require("./config");

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

function buildRouter() {
  const r = express.Router();
  const store = getStore();

  // ─── Config pública (branding + tiers) ──────────────────────────────────────
  r.get("/config", (_req, res) => res.json({ brand: BRAND, tiers: TIERS }));

  // ─── Auth ───────────────────────────────────────────────────────────────────
  r.post("/auth/registro", wrap(async (req, res) => {
    const { email, password, nombre, telefono } = req.body || {};
    const { socio, token } = await auth.registrar({ email, password, nombre, telefono });
    setSessionCookie(res, token);
    res.status(201).json({ socio, token });
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
    res.json({ socio: req.socio, membresia });
  }));

  // ─── Membresía ──────────────────────────────────────────────────────────────
  r.get("/membresia", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    res.json({ membresia, tier: membresia ? tierBySlug(membresia.tier_slug) : null });
  }));

  // Iniciar alta/cambio de tier → crea pedido de pago y devuelve cómo pagar.
  r.post("/membresia/unirse", auth.requireSocio, wrap(async (req, res) => {
    const { tier: tierSlug, ciclo } = req.body || {};
    const tier = tierBySlug(tierSlug);
    if (!tier) throw httpError(400, "Tier inválido");

    const cicloFinal = (ciclo === "mes" && tier.precioMes != null) ? "mes" : "anio";
    const monto = cicloFinal === "mes" ? tier.precioMes : tier.precioAnio;

    // Tier gratis → membresía activa inmediata, sin pago.
    if (!monto || monto <= 0) {
      const membresia = await store.setMembresia(req.socio.id, { tierSlug: tier.slug, ciclo: cicloFinal });
      return res.json({ gratis: true, membresia });
    }

    const pedido = await store.createPedidoPago({
      socioId: req.socio.id, concepto: `Membresía ${tier.nombre} (${cicloFinal})`,
      monto, moneda: BRAND.monedaCod,
    });
    const pago = await pagopar.crearPedido({
      pedidoId: pedido.id, monto, concepto: pedido.concepto,
      comprador: { email: req.socio.email, nombre: req.socio.nombre },
    });
    await store.updatePedidoPago(pedido.id, { ref_externa: pago.hash });
    res.json({ gratis: false, pedido, pago, tier: tier.slug, ciclo: cicloFinal });
  }));

  // Confirmación de pago en modo SIMULADO (sin PAGOPAR). Activa la membresía.
  r.post("/pagos/confirmar-simulado", auth.requireSocio, wrap(async (req, res) => {
    if (pagopar.habilitado) throw httpError(400, "PAGOPAR está activo: usá el flujo real");
    const { pedidoId } = req.body || {};
    const pedido = await store.getPedidoPago(pedidoId);
    if (!pedido || pedido.socio_id !== req.socio.id) throw httpError(404, "Pedido no encontrado");

    await store.updatePedidoPago(pedido.id, { estado: "pagado" });
    // El concepto codifica el tier; lo recuperamos del catálogo por nombre.
    const tier = TIERS.find(t => pedido.concepto.includes(t.nombre));
    const ciclo = pedido.concepto.includes("(mes)") ? "mes" : "anio";
    const membresia = tier
      ? await store.setMembresia(req.socio.id, { tierSlug: tier.slug, ciclo, pagoRef: pedido.id })
      : null;
    res.json({ ok: true, membresia });
  }));

  // Webhook / verificación de PAGOPAR (real). El programador conecta esto.
  r.post("/pagos/webhook", wrap(async (req, res) => {
    // PAGOPAR notifica acá. Validar firma, marcar pedido pagado, activar membresía.
    // Stub: registrar y responder 200 para que PAGOPAR no reintente en demo.
    console.log("[olimpistas] webhook PAGOPAR recibido:", JSON.stringify(req.body || {}));
    res.json({ ok: true });
  }));

  // ─── Contenido exclusivo (Olimpia Play) ─────────────────────────────────────
  r.get("/contenido", auth.attachSocio, wrap(async (req, res) => {
    const membresia = req.socio ? await store.getMembresia(req.socio.id) : null;
    const items = (await store.listContenido()).map((c) => ({
      ...c,
      desbloqueado: access.puedeAcceder(membresia, c.tier_min),
    }));
    res.json({ items, miRank: access.rankDeMembresia(membresia) });
  }));

  r.get("/contenido/:id", auth.requireSocio, wrap(async (req, res) => {
    const item = await store.getContenido(req.params.id);
    if (!item) throw httpError(404, "Contenido no encontrado");
    const membresia = await store.getMembresia(req.socio.id);
    if (!access.puedeAcceder(membresia, item.tier_min))
      throw httpError(403, `Necesitás un nivel ${item.tier_min} o superior`);
    // Acá iría la URL firmada del video. Demo: devolvemos el item completo.
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
      throw httpError(403, `Este sorteo es para nivel ${sorteo.tier_min} o superior`);
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
      throw httpError(403, `La preventa es para nivel ${preventa.tier_min} o superior`);
    const cantidad = Math.max(1, Math.min(4, parseInt(req.body?.cantidad || "1", 10)));
    const reserva = await store.reservarPreventa(preventa.id, req.socio.id, cantidad);
    if (reserva?.error === "sin_stock") throw httpError(409, "No hay stock suficiente");
    res.json({ ok: true, reserva });
  }));

  // ─── Carnet digital ─────────────────────────────────────────────────────────
  r.get("/carnet", auth.requireSocio, wrap(async (req, res) => {
    const membresia = await store.getMembresia(req.socio.id);
    if (!membresia) throw httpError(404, "Todavía no sos socio. Unite a un plan para tener carnet.");
    const tier = tierBySlug(membresia.tier_slug);
    res.json({
      carnet: {
        socioId: req.socio.id,
        nombre: req.socio.nombre || req.socio.email,
        tier: tier?.nombre || membresia.tier_slug,
        tierSlug: membresia.tier_slug,
        color: tier?.color || "#000",
        desde: membresia.inicio,
        // Número de socio legible derivado del id
        numero: "OLI-" + req.socio.id.replace(/\D/g, "").slice(0, 8).padStart(8, "0"),
      },
    });
  }));

  return r;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { buildRouter };
