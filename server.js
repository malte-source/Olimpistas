"use strict";
require("dotenv").config();

const express = require("express");
const path = require("path");
const { buildRouter } = require("./routes");
const auth = require("./lib/auth");
const { PORT, BRAND } = require("./config");

const app = express();

app.use(express.json({ limit: "1mb" })); // 1mb: alcanza para fotos de perfil (data URL)

// Parser de cookies mínimo (evita dependencia extra).
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const i = part.indexOf("=");
      if (i > -1) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  next();
});

// Adjunta req.socio si hay sesión (no bloquea).
app.use(auth.attachSocio);

const PUBLIC = path.join(__dirname, "public");

// Health
app.get("/health", (_req, res) => res.json({ ok: true, service: "olimpistas", club: BRAND.club }));

// API
app.use("/api", buildRouter());

// Estáticos con cache. Bajo tráfico fuerte, esto deja que un CDN (Cloud CDN /
// Cloudflare) sirva los assets y descargue al origen — clave para picos de 50k+.
app.use(express.static(PUBLIC, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("sw.js")) {
      res.setHeader("Cache-Control", "no-cache");                 // el SW debe actualizarse rápido
    } else if (/[\\/](assets|css|js)[\\/]/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=86400");    // 1 día (idealmente versionar + immutable)
    }
  },
}));

// HTML: cacheable corto en CDN (60s) para absorber picos sin servir contenido viejo.
const sendPage = (file) => (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.sendFile(path.join(PUBLIC, file));
};
app.get("/", sendPage("index.html"));
app.get("/socio", sendPage("socio.html"));

// 404 JSON para /api, fallback a landing para el resto.
app.use((req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "No encontrado" });
  res.sendFile(path.join(PUBLIC, "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[Olimpistas] ${BRAND.club} → http://localhost:${PORT}`);
    console.log(`[Olimpistas] Área de socios → http://localhost:${PORT}/socio`);
  });
}

module.exports = app;
