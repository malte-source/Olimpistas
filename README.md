# Olimpistas — plataforma de socios de Olimpia

Réplica funcional de [madridistas.com](https://madridistas.com) adaptada a **Club Olimpia**:
membresías por niveles, contenido exclusivo ("Olimpia Play"), preventa de entradas,
descuentos, sorteos y carnet digital. **Proyecto standalone**, sin dependencias de
otros sistemas.

## Correr en local

```bash
npm install
npm start
# → http://localhost:3002        (landing)
# → http://localhost:3002/socio  (área de socio)
```

No necesita base de datos para verlo funcionar: sin `OLIMPISTAS_DATABASE_URL` usa un
store en memoria con contenido/sorteos/preventas de ejemplo (se persiste a
`data/.olimpistas-state.json`; desactivar con `OLIMPISTAS_PERSIST=0`).

Copiá `.env.example` a `.env` para configurar variables.

## Pasar a Postgres (producción)

```bash
# 1. Crear las tablas en la base de Olimpistas:
psql "$OLIMPISTAS_DATABASE_URL" -f data/schema.sql
# 2. Arrancar con la variable seteada:
OLIMPISTAS_DATABASE_URL=postgres://... npm start
```

`data/memory-store.js` y `data/pg-store.js` implementan **la misma interfaz**, así que
el resto de la app no cambia al pasar de uno a otro.

## Integración de pagos — PAGOPAR (pendiente)

Está stubbeada a propósito en [`lib/pagopar.js`](lib/pagopar.js). Hoy funciona en
**modo simulado**: el botón "Unite" crea el pedido y lo confirma sin cobrar.

Para activar el cobro real, el programador debe:

1. Setear `PAGOPAR_PUBLIC_TOKEN` y `PAGOPAR_PRIVATE_TOKEN` (y `PAGOPAR_ENV=prod`).
2. Completar `crearPedido()` y `verificarPago()` en `lib/pagopar.js` (los `TODO`
   marcan exactamente dónde van las llamadas a la API de PAGOPAR).
3. Conectar el webhook `POST /api/pagos/webhook` para que, al confirmarse el pago,
   marque el pedido como `pagado` y active la membresía (`store.setMembresia`).

No hay que tocar las rutas: ya llaman a esa interfaz.

## Estructura

```
olimpistas/
  server.js          Express: estáticos, cookies, sesión, monta /api
  config.js          Branding + catálogo de tiers + precios (editable por negocio)
  routes.js          API: auth, membresía, pagos, contenido, sorteos, preventas, carnet
  lib/
    auth.js          Registro/login/sesión (bcrypt + token en cookie httpOnly)
    access.js        Gateo por nivel de membresía
    pagopar.js       Cliente PAGOPAR (stub con interfaz estable)
  data/
    store.js         Selector memoria/Postgres
    memory-store.js  Backend en memoria + semillas (demo)
    pg-store.js      Backend Postgres
    schema.sql       DDL Postgres
  public/            Landing (réplica) + área de socio (HTML/CSS/JS sin build)
  Dockerfile         Imagen autocontenida (node:20-slim)
  deploy.ps1         Deploy a Cloud Run
```

## Endpoints principales

| Método | Ruta | Acceso | Qué hace |
|---|---|---|---|
| GET  | `/api/config` | público | Branding + tiers |
| POST | `/api/auth/registro` · `/login` · `/logout` | público | Cuenta + sesión |
| GET  | `/api/auth/yo` | socio | Datos + membresía |
| POST | `/api/membresia/unirse` | socio | Alta de plan → pago (o gratis) |
| POST | `/api/pagos/confirmar-simulado` | socio | Confirma pago en modo demo |
| POST | `/api/pagos/webhook` | PAGOPAR | Notificación de pago (a conectar) |
| GET  | `/api/contenido` · `/contenido/:id` | público / socio | Olimpia Play (gateado) |
| GET  | `/api/sorteos` · POST `/:id/participar` | socio | Sorteos |
| GET  | `/api/preventas` · POST `/:id/reservar` | socio | Preventa de entradas |
| GET  | `/api/carnet` | socio | Carnet digital |

## Deploy

`Dockerfile` autocontenido + `deploy.ps1` (Cloud Run). Ver comentarios del Dockerfile
para variables de entorno y secretos.
