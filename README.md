# Olimpistas

Plataforma de hinchas y socios de Club Olimpia: **olimpistas.com**. Registro gratis, niveles de
membresía, beneficios con comercios, sorteos, preventas, subastas, peñas, carnet digital y un
mapa mundial de olimpistas. Es una web móvil primero e instalable (PWA), sin paso de build en el front.

No es la tienda ni la web del club; se vincula a ellas como un apartado.

## Niveles

`olimpista` (gratis) · `kids` · `premium` (los dos pagos) · `socio` (se otorga al validar la
cédula contra el padrón / la API de socios del club; no se compra). El catálogo y los precios
viven en [`config.js`](config.js); el gateo por nivel, en [`lib/access.js`](lib/access.js).

## Correr en local

```bash
npm install
npm start
# → http://localhost:3002          landing
# → http://localhost:3002/miembro  área de socio
```

Sin `OLIMPISTAS_DATABASE_URL` usa un store en memoria con datos de ejemplo (se persiste a
`data/.olimpistas-state.json`; `OLIMPISTAS_PERSIST=0` lo desactiva). Copiá `.env.example` a
`.env` para configurar; **toda variable que lee el código está documentada ahí** (un test lo exige).

## Tests

```bash
npm test                                   # sin base: los tests de Postgres se saltean
TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres npm test   # con Postgres real
```

`test/calidad.test.js` compila todo el JavaScript (servidor, `public/js` y los `<script>` en
línea de cada página) y revisa `.env.example`. CI (`.github/workflows/ci.yml`) corre todo con
Postgres 17, exige que los tests con base hayan corrido, audita dependencias de producción y
construye la imagen Docker.

## Base de datos

Las tablas las crean las migraciones de [`migraciones/`](migraciones/) (`NNNN_nombre.sql`, en
orden, una vez cada una, con checksum). Ver pendientes: `node setup/migrar.js --ver`. Hay dos
stores con la **misma interfaz** (`data/memory-store.js` y `data/pg-store.js`), y un test de
contrato que verifica que se comporten igual. `data/schema.sql` es la foto histórica inicial,
no la fuente de verdad.

## Estructura

```
server.js          Express: seguridad (helmet/CSP), límites, estáticos, sesión, monta /api
routes.js          API: auth, membresía, pagos, beneficios, sorteos, preventas, subastas,
                   peñas, comercios, mapa, campañas y panel admin
config.js          Marca, catálogo de niveles y precios
lib/               auth, access (niveles), admin-auth (roles), pagopar, tuti (API de socios),
                   email/resend, campanas, atencion (asistente IA), mapa/h3/ciudades, alert, log…
data/              store (selector), memory-store, pg-store, países
migraciones/       Esquema versionado
public/            HTML + CSS + JS sin build (landing, miembro, admin, comercio, peña, ayuda, legal)
setup/             Scripts operativos: migrar, importar padrón/ciudades, crear admin, backfills…
docs/              Staging y promoción a producción
```

## Entornos y deploy

Producción (`olimpistas`) y staging (`olimpistas-staging`) en Cloud Run, región
`southamerica-east1`, con bases Supabase separadas. **Toda función nueva se prueba en staging y
pasa a producción solo con el OK explícito del dueño.** El procedimiento completo, las
migraciones y el checklist de promoción están en [`docs/staging-y-promocion.md`](docs/staging-y-promocion.md).

Regla de oro del deploy: nunca `--env-vars-file` ni `--set-env-vars`; cambian o borran la
configuración del servicio. `deploy.ps1` reproduce la configuración existente. Para escalar
(CDN, pooler, fotos en Cloud Storage) ver [`SCALING.md`](SCALING.md); las cifras medidas de carga y de campañas están en [`docs/capacidad.md`](docs/capacidad.md) (herramienta: `setup/carga.js`, solo contra staging).

## Integraciones

| Qué | Dónde | Estado |
|---|---|---|
| Pagos Pagopar | `lib/pagopar.js`, `POST /api/pagos/webhook` (valida token) | Real con tokens; simulado sin ellos |
| API de socios (Tuti/ITI) | `lib/tuti.js` (mock en staging: `lib/tuti-mock.js`) | Real en producción |
| Correo | `lib/resend.js`, `lib/email.js` | Resend real en producción; simulado si falta la key |
| Campañas de correo | `lib/campanas.js` | Armadas pero **apagadas** (`CAMPANAS_ACTIVAS`) |
| Asistente de atención | `lib/atencion.js` | Anthropic, con respaldo de palabras clave (Gemini como motor principal está en el PR #12) |

## Pendiente

- Google Workspace del club (ingreso con Google, Calendar de partidos, Drive).
- Base del mapa sin proveedor externo (hoy usa teselas de terceros).
- Fotos de perfil a Cloud Storage (hoy van como data URL en la base).
- Activar campañas de correo (decisión del dueño, con prueba previa).
