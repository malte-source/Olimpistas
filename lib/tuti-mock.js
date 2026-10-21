"use strict";

/**
 * lib/tuti-mock.js — Tuti falso para el entorno de pruebas.
 *
 * Se monta SOLO con ENTORNO=staging, en /_mock/tuti, y el staging apunta ahí con
 *   TUTI_API_HOST=<APP_URL>/_mock/tuti  ·  TUTI_API_KEY=mock  ·  TUTI_MERCHANT_KEY=mock
 * Así el staging prueba la integración completa sin tocar la API real del club: la key
 * real de Tuti y su límite de consultas (429) son de producción y no se comparten.
 *
 * El resultado depende del ÚLTIMO DÍGITO de la cédula (cualquier cédula sirve):
 *   1 → ACTIVE (socio al día)        6 → 429 con Retry-After: 20 (límite de velocidad)
 *   2 → LIFETIME (vitalicio)         7 → 500 (error del proveedor)
 *   3 → DEBT (pago pendiente, sigue siendo socio)   8 → no responde a tiempo (timeout)
 *   4 → INACTIVE (baja)              0 y 9 → 404 (no figura: adherente o no socio)
 *   5 → UNSUBSCRIBED (baja de ciclo)
 * Igual que la API real: solo titulares; sin las dos keys → 401.
 */
const express = require("express");

const CASOS = {
  1: { status: "ACTIVE", plan: "Socio Pleno", debtor: false, totalDebt: 0, autoDebitEnabled: true },
  2: { status: "LIFETIME", plan: "Socio Vitalicio", debtor: false, totalDebt: 0, autoDebitEnabled: false },
  3: { status: "DEBT", plan: "Socio Pleno", debtor: true, totalDebt: 180000, autoDebitEnabled: false },
  4: { status: "INACTIVE", plan: "Socio Pleno", debtor: false, totalDebt: 0, autoDebitEnabled: false },
  5: { status: "UNSUBSCRIBED", plan: "Socio Pleno", debtor: false, totalDebt: 0, autoDebitEnabled: false },
};

function router() {
  const r = express.Router();
  r.get("/bff-service/OLIMPIA/subscription/members", async (req, res) => {
    if (req.get("X-Api-Key") !== "mock" || req.get("X-Merchant-Key") !== "mock")
      return res.status(401).json({ code: "AUTH-001", message: "credenciales inválidas (mock)" });
    const doc = String(req.query.documentNumber || "").replace(/\D/g, "");
    if (!doc) return res.status(400).json({ code: "VAL-001", message: "falta documentNumber" });
    const d = Number(doc.slice(-1));
    if (d === 6) { res.set("Retry-After", "20"); return res.status(429).json({ code: "RATE-001", message: "demasiadas consultas (mock)" }); }
    if (d === 7) return res.status(500).json({ code: "INT-001", message: "error interno (mock)" });
    if (d === 8) { await new Promise((x) => setTimeout(x, 4000)); return res.status(200).json({}); }
    const caso = CASOS[d];
    if (!caso) return res.status(404).json({ code: "SUB-027", message: "socio no encontrado (mock)" });
    res.json({
      documentNumber: doc, documentType: "CI", firstName: "Socio", lastName: "Prueba " + d,
      subscriptionNumber: 900000 + Number(doc.slice(-5)), phoneNumber: "0981000000",
      email: "socio" + doc + "@prueba.olimpistas.test", paymentModality: "ANNUAL", ...caso,
    });
  });
  return r;
}

module.exports = { router, CASOS };
