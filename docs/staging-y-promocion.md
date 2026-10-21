# Staging y promoción a producción

Regla: **toda función nueva se prueba en staging y pasa a producción solo cuando está 100 % probada y con OK explícito de Malte.**

## Los dos entornos

| | Producción | Staging |
|---|---|---|
| Servicio Cloud Run | `olimpistas` | `olimpistas-staging` |
| URL | https://www.olimpistas.com | https://olimpistas-staging-34854791739.southamerica-east1.run.app |
| Base | Supabase `mfkzlboqhzttuhwfhlfn` | Supabase `cjgjgjejfebhbmlqobae` (propia, sin datos reales) |
| Secretos | `olimpistas-db`, `olimpistas-admin`, `olimpistas-resend`, `olimpistas-tuti-*`, `olimpistas-unsub` | `olimpistas-staging-db`, `-admin`, `-unsub` |
| Correo | Resend real | **simulado** (sin `RESEND_API_KEY`: solo loguea) |
| Tuti (API de socios) | real | **mock** propio (`lib/tuti-mock.js`) |
| Pagopar | real | simulado (sin tokens) |
| Se indexa | sí | **no** (`noindex`, `robots.txt` cerrado, cartel "ENTORNO DE PRUEBAS") |
| Migraciones | a mano, **antes** del deploy | automáticas al arrancar (`MIGRAR_AL_ARRANCAR=1`) |

Nunca se comparte: la key de Tuti (su límite de consultas es por key), `RESEND_API_KEY`, tokens de Pagopar de producción ni datos de socios reales.

## Tuti falso en staging

El resultado depende del **último dígito de la cédula** (sirve cualquier cédula):
`1` ACTIVE · `2` LIFETIME · `3` DEBT (pago pendiente, sigue siendo socio) · `4` INACTIVE · `5` UNSUBSCRIBED · `6` 429 con `Retry-After: 20` · `7` error 500 · `8` timeout · `0`/`9` 404 (no figura).

## Flujo de trabajo

1. Una rama por sprint (`sprint1/...`) y un PR por sprint. CI en verde (corre con Postgres real).
2. Deploy de la rama a staging: `gcloud run deploy olimpistas-staging --source . --project=olimpistas --region=southamerica-east1 --quiet`
   (sin `--env-vars-file`; el servicio conserva su configuración).
3. Probar en staging con el checklist del sprint.
4. Con OK de Malte: merge a `main` y promoción (abajo).

## Migraciones

Archivos `migraciones/NNNN_nombre.sql`, en orden. Cada una corre una vez y queda en `schema_migrations` con su checksum.

- **Aditivas primero**: la migración corre antes del deploy, así que el código anterior tiene que seguir andando con el esquema nuevo (columnas nuevas con default/NULL; borrar o renombrar es un segundo paso en otro deploy).
- **No se editan las ya aplicadas** (el checksum lo impide): se agrega una nueva.
- Sin `SET` de sesión ni `BEGIN/COMMIT` propios (el lote ya va en una transacción; los `SET` se filtrarían por el pooler).
- Ver qué haría sin tocar nada: `node setup/migrar.js --ver`

## Promover a producción (checklist)

1. [ ] PR aprobado, CI verde, probado en staging con el checklist del sprint.
2. [ ] Migraciones: `OLIMPISTAS_DATABASE_URL=<prod> node setup/migrar.js --ver` y revisar lo pendiente.
3. [ ] `node setup/migrar.js` contra producción (antes del deploy).
4. [ ] Si hay secretos o variables nuevas: crearlas/montarlas **solo con `--update-secrets` / `--update-env-vars`** (nunca `--env-vars-file`).
5. [ ] `gcloud run deploy olimpistas --source . --project=olimpistas --region=southamerica-east1 --quiet`
6. [ ] Verificar: `/api/salud`, home, una subasta con foto, login, y lo específico del sprint.
7. [ ] Mirar logs 10 minutos (`gcloud logging read` severidad ERROR).

**Rollback:** `gcloud run services update-traffic olimpistas --to-revisions=<revisión-anterior>=100`. Como las migraciones son aditivas, el código anterior sigue funcionando con la base ya migrada.

## Conciliación de pagos

`POST /api/cron/conciliar-pagos` (header `x-cron-token`) pregunta a Pagopar por pedidos pendientes con más de 10 minutos y completa entregas que quedaron a medias. También corre dentro de `/api/cron/diario`. Para que sea una red de seguridad real conviene un Scheduler horario (pendiente de crear en producción tras el deploy).

## Subastas: plazo de pago y segundo postor (Sprint 1)

- Al cerrar, el lote queda **adjudicado** al líder con **72 h** para pagar (decisión `plazo`: `72_48` por defecto o `48_24`).
- Si no paga, la tarea horaria (`POST /api/cron/horario`, también respaldada por el cron diario): cancela su pedido, lo **suspende 90 días** de pujar y adjudica al **segundo postor a su mejor oferta** con 48 h. Si no hay otro postor elegible (o el segundo tampoco paga) el lote vuelve a **borrador**. A los 24 h del vencimiento sale **un** recordatorio.
- Los lotes **anteriores** a esta función se adjudican a su ganador **sin plazo** (`pago_vence` NULL): el cron nunca los vence ni suspende a nadie. Se resuelven a mano con "Extender plazo" desde el admin.
- Un pago que llegue de alguien que ya perdió el lote **no** lo marca pagado: queda cerrado y se avisa al equipo para **reembolsar**.
- Admin: `POST /api/admin/subastas/:id/extender {horas}` y `/segundo`; decisiones en `GET/PUT /api/admin/decisiones` (registrar exige `decisiones.write`, hoy solo `owner`).
- Regla de deuda (decisión `deuda`): por defecto **no se bloquea a nadie**. `cualquier` bloquea con deuda en Tuti; `mas_2_cuotas` necesita la variable `CUOTA_SOCIO_GS`. Si Tuti no responde se deja pujar.
- Scheduler horario: `gcloud scheduler jobs create http <nombre> --schedule="0 * * * *" --uri=<URL>/api/cron/horario --http-method=POST --headers="x-cron-token=<CRON_SECRET>" --location=southamerica-east1`.

## Billetera de Ahorro y Ficha 360 (Sprint 1)

- `GET /api/beneficios/ahorro` → `{mes, anio, total, canjes_mes}` en **mes y año calendario de Paraguay** (antes el mes era UTC).
- `GET /api/admin/socios/:id/360` (cualquier admin): indicadores, estado en el club (**en vivo** desde el Portal de Socios; si no responde, "sin confirmar" con lo del padrón), canjes, pujas por lote, suspensión y línea de tiempo. Puntos, peña y abono salen `null` hasta sus sprints.
- `GET /api/admin/socios/:id/parecidos?por=perfil|habito` y `GET/POST/DELETE /api/admin/segmentos` (guardar y borrar exigen `campanas.write`).
- `socios.gasto_total` lo suma la entrega del pedido (una vez por pedido) y la reversión lo descuenta; `ultima_actividad` se toca a lo sumo una vez por hora; `plan_club` es una copia de lectura del plan de ITTI (Olimpistas no escribe nada allá).
- Migración 0004 es aditiva; recalcula `gasto_total` con lo ya pagado.
