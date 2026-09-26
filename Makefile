# Build and deploy Dixvoice to the gcast EKS cluster.
#
#   make deploy           build, push and roll out both apps
#   make deploy-backend   same, backend only (deploy-web for the web app)
#   make build            build both images locally, without pushing
#   make status | logs-backend | logs-web
#   make cdn              create/update the S3 bucket and CloudFront CDN for clips
#
# Needs: docker with buildx, the aws CLI logged in to account 398351901243, kubectl on context gcast-eks.

REGION      := eu-west-1
REGISTRY    := 398351901243.dkr.ecr.$(REGION).amazonaws.com
PLATFORM    := linux/arm64
CONTEXT     := gcast-eks
NAMESPACE   := dixvoice
BACKEND_URL := https://dixvoice.api.gcast.app

BACKEND_IMG := $(REGISTRY)/dixvoice-backend:latest
WEB_IMG     := $(REGISTRY)/dixvoice-web:latest
WEB_ARGS    := --build-arg VITE_BACKEND_URL=$(BACKEND_URL)
KUBECTL     := kubectl --context $(CONTEXT)

.PHONY: build build-backend build-web push push-backend push-web ecr-login ecr-repos \
        apply-base deploy deploy-backend deploy-web status logs-backend logs-web cdn

## Local builds (arm64 images loaded into the local docker)

build: build-backend build-web

build-backend:
	docker buildx build --platform $(PLATFORM) -t $(BACKEND_IMG) --load webapp/backend

build-web:
	docker buildx build --platform $(PLATFORM) -t $(WEB_IMG) $(WEB_ARGS) --load webapp/frontend

## Push to ECR

ecr-login:
	aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY)

ecr-repos:
	@for r in dixvoice-backend dixvoice-web; do \
	  aws ecr describe-repositories --region $(REGION) --repository-names $$r >/dev/null 2>&1 || \
	  aws ecr create-repository --region $(REGION) --repository-name $$r >/dev/null; \
	done

push: push-backend push-web

push-backend: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(BACKEND_IMG) --push webapp/backend

push-web: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(WEB_IMG) $(WEB_ARGS) --push webapp/frontend

## Deploy

apply-base:
	$(KUBECTL) apply -f deploy/k8s/00-namespace.yaml -f deploy/k8s/01-certificate.yaml

deploy: deploy-backend deploy-web

deploy-backend: push-backend apply-base
	$(KUBECTL) apply -f deploy/k8s/backend.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-backend
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-backend --timeout=120s

deploy-web: push-web apply-base
	$(KUBECTL) apply -f deploy/k8s/web.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-web
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-web --timeout=120s

## Operations

status:
	$(KUBECTL) -n $(NAMESPACE) get deploy,pods,svc,ingress,certificate

logs-backend:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-backend -f --tail=100

logs-web:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-web -f --tail=100

cdn:
	deploy/cdn.sh
