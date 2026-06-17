# ─── Deploy Olimpistas → Cloud Run ────────────────────────────────────────────
# Ejecutar desde:  C:\Users\user\olimpistas\
# Requisito: gcloud autenticado.   > gcloud auth login
#
# ANTES del primer deploy (una sola vez), crear el secreto con la URL de Supabase
# (usar el "Connection Pooler" / Transaction pooler de Supabase, NO la conexión
# directa, para que escale en Cloud Run):
#
#   $env:OLIMPISTAS_DB = "postgresql://...pooler.supabase.com:6543/postgres?..."
#   $env:OLIMPISTAS_DB | gcloud secrets create olimpistas-db --data-file=- --project=olimpistas
#   # (para actualizarla luego: ... | gcloud secrets versions add olimpistas-db --data-file=-)
#
# Y aplicar el schema una vez (Supabase → SQL Editor → pegar data/schema.sql).
# ------------------------------------------------------------------------------

$PROJECT = "olimpistas"
$REGION  = "us-central1"
$REPO    = "olimpistas"
$IMAGE   = "$REGION-docker.pkg.dev/$PROJECT/$REPO/app"
$SERVICE = "olimpistas"

Write-Host "`n[1/5] Configurando proyecto..." -ForegroundColor Cyan
gcloud config set project $PROJECT

Write-Host "`n[2/5] Habilitando APIs..." -ForegroundColor Cyan
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

Write-Host "`n[3/5] Creando Artifact Registry (si no existe)..." -ForegroundColor Cyan
gcloud artifacts repositories create $REPO `
  --repository-format=docker --location=$REGION `
  --description="Olimpistas - socios de Olimpia" 2>$null
Write-Host "  (si ya existe, se ignora el error)"

Write-Host "`n[4/5] Build y push con Cloud Build..." -ForegroundColor Cyan
gcloud builds submit --tag $IMAGE .

Write-Host "`n[5/5] Deploy a Cloud Run..." -ForegroundColor Cyan
# Flags pensadas para aguantar picos de tráfico (ver SCALING.md):
#   --concurrency 250  : cada instancia atiende ~250 requests a la vez.
#   --max-instances 100: techo de autoescalado.
#   --min-instances 1  : 1 instancia caliente (evita cold start; subir para un pico).
# OLIMPISTAS_DATABASE_URL se inyecta desde Secret Manager (secreto olimpistas-db).
gcloud run deploy $SERVICE `
  --image $IMAGE `
  --platform managed --region $REGION `
  --allow-unauthenticated `
  --memory 512Mi --cpu 1 `
  --concurrency 250 `
  --min-instances 1 --max-instances 100 `
  --port 8080 `
  --set-env-vars NODE_ENV=production `
  --set-secrets OLIMPISTAS_DATABASE_URL=olimpistas-db:latest

Write-Host "`n✅ Deploy completado." -ForegroundColor Green
gcloud run services describe $SERVICE --region $REGION --format="value(status.url)"
