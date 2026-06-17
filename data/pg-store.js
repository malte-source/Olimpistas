"use strict";

/**
 * pg-store.js — Implementación Postgres del store de Olimpistas.
 *
 * Misma interfaz async que memory-store.js. Se activa cuando hay DATABASE_URL.
 * Usa el driver `postgres` (ya presente en el repo). Aplicá data/schema.sql antes.
 */

const crypto = require("crypto");
const postgres = require("postgres");

function uid(prefix) { return `${prefix}_${crypto.randomBytes(8).toString("hex")}`; }

function createPgStore({ databaseUrl }) {
  const sql = postgres(databaseUrl, { max: 5, idle_timeout: 20 });

  return {
    kind: "postgres",
    _sql: sql,

    // ── Socios ──
    async createSocio({ email, passwordHash, nombre, telefono }) {
      const id = uid("soc");
      const [s] = await sql`
        INSERT INTO socios (id, email, password_hash, nombre, telefono)
        VALUES (${id}, ${email.toLowerCase()}, ${passwordHash}, ${nombre || ""}, ${telefono || ""})
        RETURNING *`;
      return s;
    },
    async getSocioByEmail(email) {
      const [s] = await sql`SELECT * FROM socios WHERE email = ${String(email).toLowerCase()} LIMIT 1`;
      return s || null;
    },
    async getSocioById(id) {
      const [s] = await sql`SELECT * FROM socios WHERE id = ${id} LIMIT 1`;
      return s || null;
    },
    async updateSocio(id, patch) {
      const [s] = await sql`UPDATE socios SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
      return s || null;
    },

    // ── Sesiones ──
    async createSession(socioId, token, expiraIso) {
      const [s] = await sql`
        INSERT INTO sesiones (token, socio_id, expira)
        VALUES (${token}, ${socioId}, ${expiraIso}) RETURNING *`;
      return s;
    },
    async getSession(token) {
      const [row] = await sql`
        SELECT s.token, s.socio_id, s.expira, so.*
        FROM sesiones s JOIN socios so ON so.id = s.socio_id
        WHERE s.token = ${token} AND s.expira > now() LIMIT 1`;
      if (!row) return null;
      const { token: t, socio_id, expira, ...socio } = row;
      return { session: { token: t, socio_id, expira }, socio };
    },
    async deleteSession(token) {
      await sql`DELETE FROM sesiones WHERE token = ${token}`;
    },

    // ── Membresías ──
    async setMembresia(socioId, m) {
      return sql.begin(async (tx) => {
        await tx`UPDATE membresias SET estado = 'reemplazada' WHERE socio_id = ${socioId} AND estado = 'activa'`;
        const id = uid("mem");
        const [mem] = await tx`
          INSERT INTO membresias (id, socio_id, tier_slug, ciclo, estado, fin, pago_ref)
          VALUES (${id}, ${socioId}, ${m.tierSlug}, ${m.ciclo || "anio"}, ${m.estado || "activa"},
                  ${m.fin || null}, ${m.pagoRef || null})
          RETURNING *`;
        return mem;
      });
    },
    async getMembresia(socioId) {
      const [m] = await sql`
        SELECT * FROM membresias WHERE socio_id = ${socioId} AND estado = 'activa'
        ORDER BY inicio DESC LIMIT 1`;
      return m || null;
    },

    // ── Contenido ──
    async listContenido() { return sql`SELECT * FROM contenido ORDER BY publicado DESC`; },
    async getContenido(id) {
      const [c] = await sql`SELECT * FROM contenido WHERE id = ${id} LIMIT 1`;
      return c || null;
    },

    // ── Sorteos ──
    async listSorteos() { return sql`SELECT * FROM sorteos ORDER BY cierra ASC`; },
    async getSorteo(id) {
      const [s] = await sql`SELECT * FROM sorteos WHERE id = ${id} LIMIT 1`;
      return s || null;
    },
    async participarSorteo(sorteoId, socioId) {
      const id = uid("par");
      const [p] = await sql`
        INSERT INTO participaciones (id, sorteo_id, socio_id)
        VALUES (${id}, ${sorteoId}, ${socioId})
        ON CONFLICT (sorteo_id, socio_id) DO UPDATE SET sorteo_id = EXCLUDED.sorteo_id
        RETURNING *`;
      return p;
    },
    async listParticipaciones(socioId) {
      return sql`SELECT * FROM participaciones WHERE socio_id = ${socioId}`;
    },

    // ── Preventas ──
    async listPreventas() { return sql`SELECT * FROM preventas ORDER BY fecha ASC`; },
    async getPreventa(id) {
      const [p] = await sql`SELECT * FROM preventas WHERE id = ${id} LIMIT 1`;
      return p || null;
    },
    async reservarPreventa(preventaId, socioId, cantidad) {
      return sql.begin(async (tx) => {
        const [pv] = await tx`SELECT * FROM preventas WHERE id = ${preventaId} FOR UPDATE`;
        if (!pv) return null;
        if (pv.stock < cantidad) return { error: "sin_stock" };
        await tx`UPDATE preventas SET stock = stock - ${cantidad} WHERE id = ${preventaId}`;
        const id = uid("res");
        const [r] = await tx`
          INSERT INTO reservas (id, preventa_id, socio_id, cantidad)
          VALUES (${id}, ${preventaId}, ${socioId}, ${cantidad}) RETURNING *`;
        return r;
      });
    },

    // ── Pedidos de pago ──
    async createPedidoPago({ socioId, concepto, monto, moneda, refExterna, tierSlug, ciclo }) {
      const id = uid("ped");
      const [p] = await sql`
        INSERT INTO pedidos_pago (id, socio_id, concepto, monto, moneda, ref_externa, tier_slug, ciclo)
        VALUES (${id}, ${socioId}, ${concepto}, ${monto}, ${moneda || "PYG"}, ${refExterna || null},
                ${tierSlug || null}, ${ciclo || "anio"})
        RETURNING *`;
      return p;
    },
    async updatePedidoPago(id, patch) {
      const [p] = await sql`UPDATE pedidos_pago SET ${sql(patch)} WHERE id = ${id} RETURNING *`;
      return p || null;
    },
    async getPedidoPago(id) {
      const [p] = await sql`SELECT * FROM pedidos_pago WHERE id = ${id} LIMIT 1`;
      return p || null;
    },
  };
}

module.exports = { createPgStore };
