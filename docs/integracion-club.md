# Integración con el club: validación de socios, base de referencia y consulta de estado

Fecha: 2026-10-24. Lo que hace Olimpistas con la API de socios del club (ITI/Tuti) y con la base de referencia (`socios_club`).

## Reglas

1. **La API en vivo decide si está al día; la base nunca da el nivel Socio.** `socios_club` solo enriquece (antigüedad, plan, número) y dice a quién consultar.
2. **Estados** (`lib/club-estado.js`): `al_dia` = ACTIVE sin deuda o LIFETIME; `mora` = DEBT o ACTIVE con deuda; `baja` = INACTIVE o UNSUBSCRIBED; 404 = no concluyente (adherentes de plan familiar, que la API no devuelve).
3. **Al día** → el nivel Socio se activa solo. **Mora** → no se activa, se muestra cuánto debe y un acceso al portal de socios (`https://socios.clubolimpia.com.py`, `CLUB_PORTAL_URL`); "Ya pagué" consulta en vivo (1 por minuto) y el cron horario revisa solo a las cuentas en mora (hasta 30 por hora) y las activa apenas el club dice "al día". **Baja** → puede reactivar en el portal. **API sin respuesta** → "reintentar" (sin reclamos ni avisos de revisión).
4. **El detalle solo lo ve quien coincide con la persona del club**: correo confirmado igual al del club ("alta": con monto) o nombre y apellido iguales ("media": sin monto). Si nada coincide, respuesta neutra igual que para quien no figura, y nada de eso queda guardado en la cuenta (se vería en `/auth/yo`). La cédula no es secreta: probar cédulas ajenas no debe revelar el estado de pago de nadie.
5. **Hace falta el correo confirmado** (cuentas nuevas) para validar. Quien se inscribe con su cédula: se guarda y se consulta ya su estado; el nivel se activa al confirmar el correo.
6. **Estado guardado:** la validación usa lo guardado si es reciente (1 hora si la persona la pide, 24 horas en silencio); si no, consulta en vivo y lo guarda. Así cada persona suma como máximo una consulta por vez.
7. **Consulta de fondo** (`lib/club-sync.js`, cron horario, `TUTI_LOTE=120`, `TUTI_PAUSA_MS=400`, apagado con `TUTI_BARRIDO=off`): primero cuentas con cédula, después las de la base cuyo correo ya tiene cuenta, al final el resto (familiares últimos). Se corta ante 429, credenciales rechazadas o 5 errores seguidos.
8. **"Socio desde" siempre definido:** fecha de ingreso (los días de carga masiva cuentan); si falta, la más antigua del plan familiar (mismo número de socio); si falta, el 1 de enero del año del primer registro de cuota; si no hay ningún dato, cuenta desde el día en que se lo reconoce. La antigüedad se calcula desde esa fecha (el carnet muestra los años). `fecha_fuente` guarda de dónde salió.
9. **Campaña de validación de datos:** tres perfiles guardados como segmentos ("por reconocer", "sin cédula con correo en la base", "en mora"), que se crean desde el panel. Las campañas siguen apagadas; los correos de la base no se usan para escribirle a quien no tiene cuenta sin consentimiento y aval del club.

## Revisión a fondo de la integración anterior (qué se encontró y qué se hizo)

| Hallazgo | Riesgo | Qué se hizo |
|---|---|---|
| DEBT contaba como socio al día (corrección del club del 2026-10-06) | Se activaba el nivel a quien tiene cuota pendiente | Ahora es mora y pide pagar. **Las cuentas que ya son socias con pago pendiente no se tocaron** (no se baja a nadie). `SOCIO_MORA=permitir` revierte |
| Mora, baja y "no figura" daban la misma respuesta | La persona no sabía qué hacer; el equipo recibía un reclamo por cada intento | Respuesta específica solo para quien coincide con el club; un reclamo por cambio de estado |
| Cualquiera con una cédula ajena podía obtener el nivel Socio | Fraude de beneficios | Se guarda con qué confianza coincide la cuenta (en el reclamo, para revisión); el detalle de pago nunca se muestra sin coincidencia. **Sigue abierto:** exigir coincidencia para otorgar el nivel rompería a quien usa otro correo; se recomienda decidirlo con el club |
| Si la API estaba caída (límite, red) se creaba un reclamo "en revisión" y un correo | Spam al equipo y a la persona | "Reintentar", sin reclamo ni correo |
| El aviso de "en revisión" salía en cada intento | Correos repetidos | Una sola vez por cambio de estado |
| Cada validación consultaba la API en vivo | Riesgo de 429 con picos | Estado guardado reciente + consulta de fondo + tope de 1 por minuto por "Ya pagué" |
| Los adherentes de plan familiar (24.040 activos) dan 404 | No se reconocen solos | Se sigue usando el padrón como respaldo; falta el número del titular y su estado desde el club |
| Las cuentas en mora no tenían seguimiento | Quien pagaba tenía que volver a pedirlo | Revisión automática cada hora |
