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

## Carnet con QR rotativo y comercio autogestionado (Sprint 4)

- **QR del carnet** (`GET /api/carnet/token`): `OLI1.<socioId>.<ventana>.<firma>`, con la ventana = `floor(epoch / 60 s)` y la firma = HMAC-SHA256 con un **secreto propio de cada hincha** (`socios.carnet_secreto`, se crea la primera vez y nunca sale de la base). La app lo renueva cada minuto y no pide nada con la pestaña en segundo plano.
- **Validación en caja** (`POST /api/comercio/validar`): acepta `{token}` del QR o el `{codigo}` fijo de siempre. Con QR se verifica la firma y la ventana (**±1**, o sea 2–3 min de vida) y **cada QR sirve una vez** (`carnet_usos`). El registro (oferta publicada, cupo, límite de días, QR usado y canje) es **una sola transacción**: dos cajas a la vez no duplican el canje ni pasan el cupo, y un rechazo (nivel, límite, cupo) **no gasta** el QR.
- **Ofertas del comercio** (`POST/PATCH /api/comercio/beneficios`): nacen en **borrador** con origen `comercio` y no se ven ni se pueden validar hasta que el club las **apruebe** (`PATCH /api/admin/beneficios/:id {estado}`; rechazar exige motivo y el comercio lo ve). Editar lo que ve el hincha de una oferta ya aprobada la devuelve a aprobación; pausarla o ajustar el cupo no. Máximo 10 esperando aprobación.
- **Estadísticas** (`GET /api/comercio/estadisticas[?desde&hasta&format=csv]`): canjes, ahorro entregado, ventas con carnet, ticket promedio y mix por nivel (nivel guardado en cada canje; los anteriores figuran como "sin dato"). Períodos en **días de Paraguay**. El CSV del comercio no lleva ningún dato del hincha y neutraliza fórmulas de Excel.
- **Reporte para sponsors** (`GET /api/admin/comercios/estadisticas.csv`, permiso `export`): por comercio, ciudad y nivel.
- Panel del comercio (`/comercio`): pestañas **Validar** (con escaneo por cámara donde el navegador trae `BarcodeDetector`; si no, se pega el texto del QR) y **Mi comercio**.
- **Pendiente / límites conocidos:** el código fijo del socio (su código de invitación) sigue aceptándose en caja para no romper a los comercios actuales; es la vía más fácil de suplantar una identidad y conviene apagarla cuando todos usen el QR. La decisión `base` (beneficios por nivel o por plan del club) solo implementa `por_nivel`: `por_plan` necesita un campo de planes en las ofertas que el paquete no define.

## Panel por rol, Decisiones, Atención con IA y Centro de ayuda (Sprint 5)

**Roles y secciones**
- Roles nuevos: `cd` (Comisión Directiva, **solo lectura**), `comercial`, `operaciones`. Los roles históricos (`finanzas`, `soporte`, `lectura`) no cambian: ven todo y escriben solo con permiso.
- Los roles **restringidos** (`cd`, `marketing`, `comercial`, `operaciones`) entran únicamente a las secciones de la matriz (`VER_POR_ROL` en `lib/admin-auth.js`) y el servidor **niega por defecto** toda ruta `/admin/*` que no esté mapeada a una sección. Una ruta nueva sin mapear queda cerrada para ellos hasta que se agregue a `SECCION_DE_SEGMENTO` (hay un test que lo cubre).
- Permisos de escritura más finos: `subastas.write`, `beneficios.write`, `puntos.write`, `penas.write`, `atencion.write` (antes casi todo colgaba de `contenido.write`). `marketing` conserva lo que ya hacía. El canje del fondo de peñas lo aprueba `pagos.write` **o** `penas.write`.
- La CD **no ve datos personales de hinchas** (sin la sección Hinchas ni la búsqueda): ve el tablero agregado y las decisiones.
- Nuevos: `GET /api/admin/tablero` (agregados, sin datos personales), `/integraciones` (solo estado, jamás valores de claves) y `/roles` (matriz, solo `owner`). Pantallas: Decisiones, Atención, Integraciones y "Quién ve y quién edita qué".
- **Sin migración** para roles: `admin_usuarios.rol` es texto libre.

**Atención con IA** (migración `0008_atencion`)
- Variables: `ANTHROPIC_API_KEY` (**una clave aparte para staging, con tope de gasto en la consola de Anthropic**), `ATENCION_MODELO` (por defecto `claude-haiku-5-5`), `ATENCION_TOPE_DIARIO` (mensajes por hincha y día, 40), `ATENCION_RAFAGA` (por minuto, 8), `GHL_WHATSAPP_URL` (para que la respuesta de una persona salga por WhatsApp).
- Sin `ANTHROPIC_API_KEY`, o si la API falla, el asistente **responde por palabras clave** y lo deja en el log (`atención: respaldo por palabra clave`). Nunca deriva solo ante algo que no entendió (no inunda la bandeja si cae la API).
- La IA se llama **en el servidor** (`lib/atencion.js`, fetch directo a la API de Messages con tool use, máx. 400 tokens y 8 vueltas). Las reglas fijas están **en código**, no en el prompt: las herramientas solo operan sobre el hincha de la sesión (no reciben ids), una herramienta apagada no se ofrece ni se ejecuta, y `liberar_lugar` exige que el último mensaje del hincha sea una confirmación.
- `liberar_lugar` está **apagada y no se puede encender** hasta que existan los endpoints de Tuti para el abono. Estado de socio: `sin confirmar` si Tuti no responde (se usa el mismo `estadoClubDe` que la ficha 360).
- Una persona que responde toma la conversación (la IA calla); **Resolver** la devuelve a la IA y deja el evento en la ficha 360. Una conversación abierta por hincha y canal (índice único). El mismo motor atiende a WhatsApp: `procesarMensajeAtencion({ socio, texto, canal: 'whatsapp' })`; **falta enchufar el webhook de GoHighLevel** (cuando se conecte GHL).
- Indicadores: conversaciones del día, % resuelto solo por la IA (7 días), primera respuesta de una persona, abiertas con persona.

**Centro de ayuda**
- `/ayuda` + `GET /api/ayuda?aud=&cat=&q=`. El contenido (28 tutoriales y 28 preguntas) se exporta **tal cual** del prototipo con `node scripts/exportar-ayuda.js "<Centro de Ayuda Olimpistas.dc.html>"` a `data/ayuda.json`. Se guarda en `data/` y no en `public/data/` (como pedía el paquete) para poder **filtrar por perfil**: los seis perfiles del club solo se ven con sesión del panel.
- El texto del prototipo conserva cifras "a confirmar" (vencimiento de puntos, plazo de 72 h, fondo de 10 %): coinciden con los valores por defecto de Decisiones; cuando la CD decida otra cosa hay que actualizar el prototipo y volver a exportar.
