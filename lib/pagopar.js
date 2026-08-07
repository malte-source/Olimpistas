"use strict";

/**
 * lib/pagopar.js — Cliente de PAGOPAR (pasarela de pagos de Paraguay).
 *
 * Implementa el flujo de la doc oficial (api.pagopar.com):
 *   #1 crearPedido()   → POST /comercios/2.0/iniciar-transaccion → devuelve hash + urlPago
 *   #3 validarWebhook() → valida el token de la notificación de pago (sha1(private + hash))
 *   #4 verificarPago()  → POST /pedidos/1.1/traer → estado real del pedido
 *
 * Cada endpoint firma con un token DISTINTO (ver funciones token*). El entorno
 * (sandbox/prod) lo definen las credenciales cargadas, no la URL.
 *
 * Sin credenciales (PAGOPAR.habilitado=false) → modo "simulado" para demo/MVP local.
 */

const crypto = require("crypto");
const { PAGOPAR } = require("../config");

const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const soloDigitos = (s) => String(s || "").replace(/\D/g, "");

/**
 * PHP: strval(floatval($monto)). El monto va en PYG (entero), así que floatval de
 * un entero y su strval dan la representación sin ".0" (ej. 180000 → "180000").
 */
function montoStr(monto) {
  return String(Math.round(Number(monto) || 0));
}

// ── Tokens por endpoint (según doc PAGOPAR) ──────────────────────────────────
// #1 iniciar-transaccion: sha1(private + id_pedido_comercio + strval(floatval(monto_total)))
const tokenIniciar   = (idPedido, monto) => sha1(PAGOPAR.privateToken + String(idPedido) + montoStr(monto));
// #4 consulta de estado: sha1(private + "CONSULTA")
const tokenConsulta  = () => sha1(PAGOPAR.privateToken + "CONSULTA");
// lista de formas de pago: sha1(private + "FORMA-PAGO")
const tokenFormaPago = () => sha1(PAGOPAR.privateToken + "FORMA-PAGO");
// #3 webhook de notificación: sha1(private + hash_pedido)
const tokenWebhook   = (hashPedido) => sha1(PAGOPAR.privateToken + hashPedido);

// Fecha máxima de pago "YYYY-MM-DD HH:MM:SS" (UTC), +N días desde ahora.
function fechaMaximaPago(dias = 3) {
  const d = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`PAGOPAR respuesta no-JSON (HTTP ${r.status}): ${text.slice(0, 200)}`); }
  return json;
}

/**
 * #1 Crea un pedido en PAGOPAR. Devuelve { modo, hash, urlPago }.
 * - modo "pagopar"  → integración real (hay credenciales). urlPago = checkout de PAGOPAR.
 * - modo "simulado" → sin credenciales: URL interna que confirma sin cobrar (MVP/local).
 */
async function crearPedido({ pedidoId, monto, concepto, comprador }) {
  if (!PAGOPAR.habilitado) {
    return {
      modo: "simulado",
      hash: `sim_${pedidoId}`,
      urlPago: `/miembro?pago_simulado=${encodeURIComponent(pedidoId)}`,
    };
  }

  const montoTotal = Math.round(Number(monto) || 0); // PYG entero
  const pk = PAGOPAR.publicToken;
  const desc = String(concepto || "Membresía Olimpista").slice(0, 120);
  const payload = {
    token: tokenIniciar(pedidoId, montoTotal),
    public_key: pk,
    monto_total: montoTotal,
    tipo_pedido: "VENTA-COMERCIO",
    fecha_maxima_pago: fechaMaximaPago(3),
    id_pedido_comercio: String(pedidoId),
    descripcion_resumen: desc,
    comprador: {
      ruc: "",
      email: (comprador && comprador.email) || "",
      ciudad: 1,
      nombre: (comprador && (comprador.nombre || comprador.email)) || "Socio Olimpista",
      telefono: (comprador && comprador.telefono) || "",
      direccion: "",
      documento: soloDigitos(comprador && comprador.documento) || "0",
      coordenadas: "",
      razon_social: "",
      tipo_documento: "CI",
      direccion_referencia: "",
    },
    compras_items: [{
      ciudad: 1,
      nombre: desc,
      cantidad: 1,
      categoria: "909",
      public_key: pk,
      url_imagen: "",
      descripcion: desc,
      id_producto: String(pedidoId),
      precio_total: montoTotal,
      vendedor_telefono: "",
      vendedor_direccion: "",
      vendedor_direccion_referencia: "",
      vendedor_direccion_coordenadas: "",
    }],
  };

  const resp = await postJson(`${PAGOPAR.apiUrl}/comercios/2.0/iniciar-transaccion`, payload);
  if (!resp || resp.respuesta !== true) {
    const motivo = resp && resp.resultado != null ? JSON.stringify(resp.resultado) : "sin respuesta";
    throw new Error("PAGOPAR iniciar-transaccion falló: " + motivo);
  }
  const hash = resp.resultado && resp.resultado[0] && resp.resultado[0].data;
  if (!hash) throw new Error("PAGOPAR no devolvió hash (resultado[0].data)");
  return { modo: "pagopar", hash, urlPago: `${PAGOPAR.checkoutUrl}/${hash}` };
}

/**
 * #4 Consulta el estado real de un pedido. Devuelve { pagado, cancelado, modo, row, raw }.
 */
async function verificarPago({ hash }) {
  if (!PAGOPAR.habilitado) return { pagado: false, cancelado: false, modo: "simulado", raw: null };
  const resp = await postJson(`${PAGOPAR.apiUrl}/pedidos/1.1/traer`, {
    hash_pedido: hash,
    token: tokenConsulta(),
    token_publico: PAGOPAR.publicToken,
  });
  const row = resp && resp.resultado && resp.resultado[0];
  return {
    pagado: !!(row && row.pagado === true),
    cancelado: !!(row && row.cancelado === true),
    modo: "pagopar",
    row: row || null,
    raw: resp,
  };
}

/**
 * #3 Valida el token de la notificación (webhook): debe ser sha1(private + hash_pedido).
 * Comparación timing-safe. Devuelve boolean.
 */
function validarWebhook(hashPedido, token) {
  if (!PAGOPAR.privateToken || !hashPedido || !token) return false;
  const esperado = tokenWebhook(hashPedido);
  const a = Buffer.from(esperado);
  const b = Buffer.from(String(token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  crearPedido,
  verificarPago,
  validarWebhook,
  tokenFormaPago,
  habilitado: PAGOPAR.habilitado,
};
