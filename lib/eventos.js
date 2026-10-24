"use strict";
/**
 * lib/eventos.js — los hitos de cada socio con fecha (tabla socio_eventos). Alimentan el embudo por cohorte y "tiempo hasta el primer canje".
 *
 *   registro              se creó la cuenta                          (único)
 *   correo_verificado     confirmó su correo                         (único)
 *   foto                  subió su foto de carnet                    (único)
 *   nivel_socio_activado  el club lo reconoció y se activó Socio     (cada vez: puede perderlo y recuperarlo)
 *   nivel_socio_pausado   se pausó por mora o baja (meta.motivo)     (cada vez)
 *   primer_canje          primer beneficio usado en un comercio      (único)
 *   primer_pago           primer pago acreditado                     (único)
 *   primera_puja          primera puja en una subasta                (único)
 *   referido              invitó a alguien que se registró           (cada vez)
 *
 * Los "únicos" se guardan una sola vez por socio (índice único parcial). Registrar un hito nunca puede romper el flujo que lo origina.
 */
const TIPOS = ["registro", "correo_verificado", "foto", "nivel_socio_activado", "nivel_socio_pausado", "primer_canje", "primer_pago", "primera_puja", "referido"];
const UNICOS = new Set(["registro", "correo_verificado", "foto", "primer_canje", "primer_pago", "primera_puja"]);

module.exports = { TIPOS, UNICOS };
