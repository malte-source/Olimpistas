"use strict";

/**
 * lib/pagopar.js — Cliente de PAGOPAR (pasarela de pagos de Paraguay).
 *
 * ⚠️ INTEGRACIÓN PENDIENTE: este módulo está stubbeado a propósito. La conexión
 * real la completa el programador con las credenciales del comercio. La interfaz
 * de abajo es estable: el resto de la app sólo llama `crearPedido()` y
 * `verificarPago()`, así que conectar PAGOPAR no requiere tocar las rutas.
 *
 * Flujo real de PAGOPAR (referencia, a implementar):
 *   1. POST {baseUrl}/comercios/2.0/iniciar-transaccion  con el pedido + token
 *      firmado (sha1(privateToken + ...)) → devuelve `hash_pedido` y URL de pago.
 *   2. Se redirige al socio a la URL de pago de PAGOPAR.
 *   3. PAGOPAR llama al callback (webhook) y/o se consulta el estado con
 *      POST {baseUrl}/pedidos/traer  → estado `pagado`.
 *
 * Docs: https://www.pagopar.com/desarrolladores
 */

const crypto = require("crypto");
const { PAGOPAR } = require("../config");

/**
 * Firma estándar de PAGOPAR: sha1(privateToken + payload).
 * (El payload exacto depende del endpoint; se ajusta al integrar.)
 */
function firmar(payload) {
  return crypto.createHash("sha1")
    .update(PAGOPAR.privateToken + payload)
    .digest("hex");
}

/**
 * Crea un pedido de pago. Devuelve { hash, urlPago, modo }.
 * - modo 'pagopar'   → integración real activa (PAGOPAR.habilitado).
 * - modo 'simulado'  → no hay credenciales: se devuelve una URL interna que
 *   confirma el pago sin cobrar (para demo/MVP).
 */
async function crearPedido({ pedidoId, monto, concepto, comprador }) {
  if (!PAGOPAR.habilitado) {
    return {
      modo: "simulado",
      hash: `sim_${pedidoId}`,
      // En modo simulado el front llama a /api/pagos/confirmar-simulado para "pagar".
      urlPago: `/miembro?pago_simulado=${encodeURIComponent(pedidoId)}`,
    };
  }

  // ─── INTEGRACIÓN REAL (a completar por el programador) ───────────────────────
  // const payload = { ... monto, concepto, comprador, public_token: PAGOPAR.publicToken };
  // const token   = firmar(JSON.stringify(payload));
  // const resp    = await fetch(`${PAGOPAR.baseUrl}/comercios/2.0/iniciar-transaccion`, {
  //   method: "POST",
  //   headers: { "Content-Type": "application/json" },
  //   body: JSON.stringify({ ...payload, token }),
  // }).then(r => r.json());
  // return { modo: "pagopar", hash: resp.resultado.hash_pedido, urlPago: resp.resultado.data };
  throw new Error("PAGOPAR habilitado pero la integración real aún no está implementada (lib/pagopar.js)");
}

/**
 * Verifica el estado de un pago contra PAGOPAR.
 * Devuelve { pagado: boolean, raw }.
 */
async function verificarPago({ hash }) {
  if (!PAGOPAR.habilitado) {
    // En modo simulado el estado lo maneja la ruta /api/pagos/confirmar-simulado.
    return { pagado: false, modo: "simulado", raw: null };
  }
  // ─── INTEGRACIÓN REAL (a completar) ──────────────────────────────────────────
  // const payload = { hash_pedido: hash, token_publico: PAGOPAR.publicToken };
  // const token   = firmar(hash);
  // const resp    = await fetch(`${PAGOPAR.baseUrl}/pedidos/traer`, { ... }).then(r => r.json());
  // return { pagado: resp.resultado?.[0]?.pagado === true, modo: "pagopar", raw: resp };
  throw new Error("PAGOPAR habilitado pero verificarPago() no está implementado (lib/pagopar.js)");
}

module.exports = { crearPedido, verificarPago, firmar, habilitado: PAGOPAR.habilitado };
