"use strict";
require("dotenv").config();

const express = require("express");
const path = require("path");
const { buildRouter } = require("./routes");
const auth = require("./lib/auth");
const { PORT, BRAND } = require("./config");

const app = express();

app.use(express.json());

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

// Estáticos + páginas
app.use(express.static(PUBLIC));
app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
app.get("/socio", (_req, res) => res.sendFile(path.join(PUBLIC, "socio.html")));

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
