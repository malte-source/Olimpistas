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

## Peñas oficiales y fondo (Sprint 2)

- **Solicitud** pública (`POST /api/penas/solicitud`, 10/hora por red) → queda `pendiente`: no aparece en el ranking ni recibe aportes. El club la **verifica** desde Admin → Contenido → Peñas: se crea el usuario de la comisión y se le manda **un link de un solo uso (7 días)** para elegir su contraseña. No se envía ninguna contraseña por correo; si no hay email válido, el admin recibe el link en pantalla.
- **Link de captación:** `/?pena=<slug>` (igual que `?ref=`); el alta guarda `socios.pena_id` solo si la peña está verificada. El hincha también puede sumarse o dejarla desde "Descubrir → Mi peña" (`PATCH /api/perfil {pena_id}`).
- **Panel de la comisión:** `/pena` (login propio, sesión de 12 h, 12 intentos/15 min). La comisión ve altas con **nombre e inicial del apellido**, ciudad y nivel; nunca email, cédula ni teléfono.
- **Fondo:** cada pago acreditado de un hincha de una peña **verificada** aporta el `pct` de la decisión del club (10 % por defecto, 15 % opcional) — membresías, entradas **y subastas**. Un pedido acredita **una sola vez** (`pedido_id` único), una reversión de pago descuenta el aporte una sola vez, y un pago "huérfano" (lote perdido, a reembolsar) no aporta. Una falla del fondo avisa al equipo pero nunca frena la entrega del pago.
- **Canje:** la comisión pide (`POST /api/pena/fondo/canje`); queda `pendiente` y reserva saldo (no se puede pedir más de lo disponible, ni con pedidos simultáneos). El club aprueba (resta del saldo) o rechaza desde el admin (`pagos.write`). Aprobar exige que el saldo siga alcanzando.
- Migración 0005 aditiva (4 tablas + `pena_id` en socios y comercios).

## Motor de puntos y catálogo de canje (Sprint 3)

- **Libro de puntos** (`puntos_movimientos`): cada regla suma **una vez por hecho** (clave única socio + regla + ref: un referido, una semana, un mes). El saldo es la suma; canjes, reintegros y vencimientos son movimientos negativos/positivos. Los de 0 puntos son marcas internas ("ya revisé la cuota de este mes") y no se muestran.
- **Reglas** (valores del paquete, editables desde Admin → Contenido → Puntos con −50/+50 y activar/desactivar): referido 300 · misión/encuesta 50 · perfil completo 100 · cuota 100 · débito 500 · estadio 150 y liberar 200 (**pendientes**: esperan los endpoints nuevos de Tuti).
- **Cuota y débito** (Portal de Socios): el cron diario revisa **durante los primeros 5 días del mes** (la API tiene límite de velocidad: lotes de 120, se frena ante un 429 y sigue otro día). La cuota suma con `ACTIVE`/`LIFETIME` (nunca `DEBT`). Cada socio queda marcado por mes para no reconsultarlo. `PUNTOS_CUOTA_DIAS` ajusta la ventana.
- **Misión semanal:** una pregunta por semana ISO (hora de Paraguay), **una sola respuesta por hincha** (con 3 opciones, permitir reintentos regala los puntos); la respuesta correcta nunca viaja al cliente. Responder una encuesta también suma como misión (una vez por encuesta).
- **Escalones** por saldo: Bronce 200 · Plata 1.000 · Oro 5.000.
- **Catálogo:** premios por escalón y `nivel_min`; **Oro sale como "próximamente"** mientras la decisión `oro` sea `no_publicar`. Canjear es **atómico** (bloquea al socio y al premio): no se gastan dos veces los mismos puntos ni se vende más stock que el que hay. El club marca **entregado** (avisa al hincha) o **cancela** (devuelve puntos y stock, una sola vez).
- **Vencimiento** (decisión `venc`): con `12_meses` vencen **todos** los puntos de quien pasó 12 meses sin actividad (`ultima_actividad`, que se toca al usar la app); aviso por correo **una vez** a los 11 meses. Con `no_vencen` no pasa nada.
- Admin: `GET/PUT /api/admin/puntos/reglas`, `/resumen` (pasivo), `/premios`, `/canjes`, `/misiones`.
