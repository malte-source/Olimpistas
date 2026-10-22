# Capacidad y prueba de carga

Medido el 2026-10-22 con `setup/carga.js` contra **staging** (3 instancias como máximo; producción escala de 5 a 50, cada una con 2 CPU y 60 pedidos simultáneos). La herramienta se niega a correr contra olimpistas.com: crea socios de prueba.

```bash
node setup/carga.js <url-de-staging> --escenario lectura  --concurrencia 30 --segundos 20
node setup/carga.js <url-de-staging> --escenario registro --concurrencia 12 --segundos 25
node setup/carga.js <url-de-staging> --escenario sesion   --concurrencia 60 --segundos 25
```

## Resultados (staging, 3 instancias)

| Escenario | Carga | Rendimiento | Latencia | Errores |
|---|---|---|---|---|
| Visitantes anónimos (inicio, config, stats, listas, mapa) | 30 en paralelo | ~217 pedidos/s | p50 ≈ 65 ms · p95 ≈ 100 ms | 0 |
| Registro de socios nuevos (bcrypt) | 12 en paralelo | ~7 registros/s | p50 ≈ 1,1 s · p95 ≈ 1,5 s | 0 |
| Socios con sesión (yo, beneficios, subastas, sorteos, carnet) | 60 en paralelo | ~165 pedidos/s | p50 130–190 ms · p95 ≈ 290 ms | 0 |
| 60 registros simultáneos mezclados con lecturas | 60 en paralelo | — | registro p50 ≈ 4,9 s; las lecturas siguen en p95 < 370 ms | 0 |

Lectura del resultado:

- **Lo que se ve (inicio, mapa, listas) aguanta de sobra**: son pedidos baratos y cacheados.
- **El cuello de botella es el registro**, por el costo de bcrypt (CPU). Por instancia rinde ≈ 2–4 registros/s; con 50 instancias de producción, del orden de 100–200 registros/s. Una ráfaga de registros no degrada la navegación de los demás.
- La sesión (`/auth/yo` y todo lo autenticado) ya **no arrastra la foto del socio** (antes hasta 800 KB por pedido).

## Campañas de correo (Postgres real, 6.000 destinatarios)

Test `test/pg-campanas-escala.test.js`:

- Repartir 6.000 envíos entre 8 trabajadores simultáneos: **ninguno repetido, ninguno perdido** (≈ 2.200 envíos/s de reparto; cargar los 6.000 pendientes: ~120 ms).
- `procesarLote` real con un correo falso: **≈ 4,3 ms de costo interno por destinatario**. El techo no es nuestro sistema sino el ritmo que permite el proveedor de correo.

Ritmo real de envío = `CAMPANAS_LOTE` por minuto (lo dispara el cron cada minuto), con una pausa de `CAMPANAS_PAUSA_MS` entre correos:

| Config | Ritmo | 10.000 correos | 50.000 correos |
|---|---|---|---|
| Hoy (lote 120, pausa 340 ms) | ~120/min ≈ 7.200/h | ~1 h 25 min | ~7 h |
| Lote 400, pausa 100 ms (requiere un plan de Resend que permita ≥ 10 pedidos/s) | ~400/min ≈ 24.000/h | ~25 min | ~2 h 5 min |

Antes de la primera campaña grande: confirmar el límite de pedidos por segundo del plan de Resend y ajustar `CAMPANAS_LOTE` / `CAMPANAS_PAUSA_MS` en consecuencia (están documentadas en `.env.example`). Empezar siempre con un envío de prueba.

## Riesgo a vigilar: conexiones a la base

Cada instancia abre hasta `DB_POOL_MAX=6` conexiones al pooler de Supabase. Con 50 instancias son **hasta 300 conexiones**. Hay que confirmar en el panel de Supabase (Database → Pooler) que el máximo de clientes del plan lo soporta; si no, bajar `DB_POOL_MAX` (p. ej. 4 → 200) o limitar `maxScale`. Esto no se pudo probar sin tocar producción: se verifica en el panel, no con carga.

## Cupos y reservas

Probado contra Postgres real: 30 personas a la vez por 7 entradas → se venden exactamente 7; pedidos de varias entradas nunca dejan el stock en negativo (`test/pg-preventas-cupo.test.js`).
