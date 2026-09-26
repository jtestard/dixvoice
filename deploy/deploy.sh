#!/usr/bin/env bash
# Build, push and deploy Dixvoice to the gcast EKS cluster.
#
# Usage: deploy/deploy.sh [backend|web|all]   (default: all)
#
# Needs: docker with buildx, aws CLI logged in to account 398351901243, kubectl on context gcast-eks.
set -euo pipefail

REGISTRY=398351901243.dkr.ecr.eu-west-1.amazonaws.com
REGION=eu-west-1
PLATFORM=linux/arm64 # cluster nodes are arm64
BACKEND_URL=https://dixvoice.api.gcast.app
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TARGET=${1:-all}

if [ "$(kubectl config current-context)" != "gcast-eks" ]; then
  echo "kubectl context must be gcast-eks" >&2
  exit 1
fi

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY"

ensure_repo() {
  aws ecr describe-repositories --region "$REGION" --repository-names "$1" >/dev/null 2>&1 ||
    aws ecr create-repository --region "$REGION" --repository-name "$1" >/dev/null
}

build_push() { # name, context dir, extra buildx args...
  local name=$1 dir=$2
  shift 2
  ensure_repo "$name"
  docker buildx build --platform "$PLATFORM" -t "$REGISTRY/$name:latest" --push "$@" "$dir"
}

kubectl apply -f "$ROOT/deploy/k8s/00-namespace.yaml"
kubectl apply -f "$ROOT/deploy/k8s/01-certificate.yaml"

if [ "$TARGET" = backend ] || [ "$TARGET" = all ]; then
  build_push dixvoice-backend "$ROOT/webapp/backend"
  kubectl apply -f "$ROOT/deploy/k8s/backend.yaml"
  kubectl -n dixvoice rollout restart deployment/dixvoice-backend
  kubectl -n dixvoice rollout status deployment/dixvoice-backend --timeout=120s
fi

if [ "$TARGET" = web ] || [ "$TARGET" = all ]; then
  build_push dixvoice-web "$ROOT/webapp/frontend" --build-arg "VITE_BACKEND_URL=$BACKEND_URL"
  kubectl apply -f "$ROOT/deploy/k8s/web.yaml"
  kubectl -n dixvoice rollout restart deployment/dixvoice-web
  kubectl -n dixvoice rollout status deployment/dixvoice-web --timeout=120s
fi
