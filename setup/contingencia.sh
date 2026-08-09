#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# contingencia.sh — Acciones de emergencia para Olimpistas en producción.
# Pensado para ejecutarse bajo presión: un comando por escenario, sin pensar.
#
#   bash setup/contingencia.sh estado      → ¿cómo está todo? (empezá SIEMPRE por acá)
#   bash setup/contingencia.sh reiniciar   → destraba el pool de conexiones (~40s, sin rebuild)
#   bash setup/contingencia.sh escalar     → sube capacidad para una ola de tráfico
#   bash setup/contingencia.sh normal      → vuelve a la capacidad de todos los días
#   bash setup/contingencia.sh volver      → rollback a la revisión anterior
#
# REGLA DE ORO — presupuesto de conexiones: pool × max-instances ≤ 300.
#   50 instancias → DB_POOL_MAX=6      100 instancias → DB_POOL_MAX=3
# Subir instancias sin bajar el pool revienta el pooler de Supabase justo en el pico.
#
# OJO (aprendido el 2026-08-09): "escalar" achica el pool por instancia a propósito.
# Usarlo SOLO con una ola de tráfico ya confirmada en los números (`estado` mostrando
# cientos de req/min sostenidas) — no "por las dudas". Bajar el pool sin que la ola
# sea real achica la capacidad de las pocas instancias que sí están sirviendo, sin
# ninguna ganancia a cambio. Volvé a `normal` apenas pase el pico.
# ─────────────────────────────────────────────────────────────────────────────
set -u
P="--project olimpistas --region southamerica-east1"
SVC=olimpistas
URL=https://www.olimpistas.com

estado() {
  echo "── SITIO ──"
  for p in /api/salud /api/subastas /api/config /; do
    printf "  %-16s → %s\n" "$p" "$(curl -s -o /dev/null -w 'HTTP %{http_code} en %{time_total}s' --max-time 20 "$URL$p")"
  done
  echo "  /api/salud: $(curl -s --max-time 20 $URL/api/salud)"
  echo
  echo "── CAPACIDAD ──"
  gcloud run services describe $SVC $P --format="value(
    spec.template.metadata.annotations['autoscaling.knative.dev/minScale'],
    spec.template.metadata.annotations['autoscaling.knative.dev/maxScale'])" \
    | awk '{print "  min-instances: "$1"  |  max-instances: "$2}'
  POOL=$(gcloud run services describe $SVC $P --format=json \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const e=(JSON.parse(d).spec.template.spec.containers[0].env||[]).find(x=>x.name==='DB_POOL_MAX');console.log(e?e.value:'6 (default)')})")
  echo "  DB_POOL_MAX: $POOL"
  echo
  echo "── TRÁFICO Y ERRORES (últimos 5 min) ──"
  D=$(gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="olimpistas" AND httpRequest.status:*' \
      $P --freshness=5m --limit=4000 --format="value(httpRequest.status)" 2>/dev/null)
  T=$(echo "$D" | grep -c .); E=$(echo "$D" | awk '$1>=500' | grep -c .)
  echo "  $((T/5)) req/min  |  5xx: $E"
  echo
  echo "── REVISIONES (las 3 últimas) ──"
  gcloud run revisions list --service $SVC $P --limit=3 --format="table(name,active,creationTimestamp)"
}

reiniciar() {
  echo "Reiniciando (revisión nueva, misma imagen — destraba conexiones colgadas)..."
  gcloud run services update $SVC $P --update-env-vars "RESTART_AT=$(date +%s)" 2>&1 | tail -3
  echo "Verificando..."; sleep 5
  curl -s --max-time 25 $URL/api/salud; echo
}

escalar() {
  echo "Subiendo capacidad para una ola (100 instancias, pool 3 → 300 conexiones)..."
  gcloud run services update $SVC $P \
    --min-instances 10 --max-instances 100 --concurrency 80 \
    --update-env-vars DB_POOL_MAX=3 2>&1 | tail -3
  echo "Verificando..."; sleep 5
  curl -s --max-time 25 $URL/api/salud; echo
}

normal() {
  echo "Volviendo a capacidad normal (50 instancias, pool 6 → 300 conexiones)..."
  gcloud run services update $SVC $P \
    --min-instances 1 --max-instances 50 --concurrency 60 \
    --update-env-vars DB_POOL_MAX=6 2>&1 | tail -3
  echo "Verificando..."; sleep 5
  curl -s --max-time 25 $URL/api/salud; echo
}

volver() {
  ANT=$(gcloud run revisions list --service $SVC $P --limit=2 \
        --format="value(name)" --sort-by="~creationTimestamp" | tail -1)
  [ -z "$ANT" ] && { echo "No encontré una revisión anterior."; exit 1; }
  echo "Mandando el 100% del tráfico a: $ANT"
  read -p "¿Confirmás? (s/N) " r; [ "$r" = "s" ] || { echo "Cancelado."; exit 0; }
  gcloud run services update-traffic $SVC $P --to-revisions "$ANT=100" 2>&1 | tail -3
  curl -s --max-time 25 $URL/api/salud; echo
}

case "${1:-}" in
  estado)    estado ;;
  reiniciar) reiniciar ;;
  escalar)   escalar ;;
  normal)    normal ;;
  volver)    volver ;;
  *) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
