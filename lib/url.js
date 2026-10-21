"use strict";

/**
 * lib/url.js — URL pública canónica del sitio.
 *
 * Se arma SIEMPRE desde APP_URL (default https://www.olimpistas.com), nunca desde el
 * header `Host` de la request: ese header lo controla quien llama. Con el Host reflejado,
 * alguien podía pedir "recuperar contraseña" de una víctima con `Host: evil.example` y el
 * correo oficial le llegaba con un link a otro dominio y un token válido (auditoría
 * 2026-10-21). En staging se define APP_URL con la URL del entorno de pruebas.
 */
const baseUrl = () => String(process.env.APP_URL || "https://www.olimpistas.com").replace(/\/+$/, "");

module.exports = { baseUrl };
