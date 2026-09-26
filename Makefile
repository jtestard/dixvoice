# Build and deploy Dixvoice to the gcast EKS cluster.
#
#   make deploy           build, push and roll out the three apps
#   make deploy-backend   same, backend only (deploy-web for the web app, deploy-audio for the audio service)
#   make build            build the images locally, without pushing
#   make audio-secret     create/update the audio service's secret from secret/audio.env and secret/aws.env
#   make status | logs-backend | logs-web | logs-audio
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
AUDIO_IMG   := $(REGISTRY)/dixvoice-audio:latest
WEB_ARGS    := --build-arg VITE_BACKEND_URL=$(BACKEND_URL)
KUBECTL     := kubectl --context $(CONTEXT)

.PHONY: build build-backend build-web build-audio push push-backend push-web push-audio ecr-login ecr-repos \
        apply-base deploy deploy-backend deploy-web deploy-audio audio-secret status logs-backend logs-web logs-audio cdn

## Local builds (arm64 images loaded into the local docker)

build: build-backend build-web build-audio

build-backend:
	docker buildx build --platform $(PLATFORM) -t $(BACKEND_IMG) --load webapp/backend

build-web:
	docker buildx build --platform $(PLATFORM) -t $(WEB_IMG) $(WEB_ARGS) --load webapp/frontend

build-audio:
	docker buildx build --platform $(PLATFORM) -t $(AUDIO_IMG) --load webapp/audio

## Push to ECR

ecr-login:
	aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY)

ecr-repos:
	@for r in dixvoice-backend dixvoice-web dixvoice-audio; do \
	  aws ecr describe-repositories --region $(REGION) --repository-names $$r >/dev/null 2>&1 || \
	  aws ecr create-repository --region $(REGION) --repository-name $$r >/dev/null; \
	done

push: push-backend push-web push-audio

push-backend: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(BACKEND_IMG) --push webapp/backend

push-web: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(WEB_IMG) $(WEB_ARGS) --push webapp/frontend

push-audio: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(AUDIO_IMG) --push webapp/audio

## Deploy

apply-base:
	$(KUBECTL) apply -f deploy/k8s/00-namespace.yaml -f deploy/k8s/01-certificate.yaml

deploy: deploy-audio deploy-backend deploy-web

deploy-backend: push-backend apply-base
	$(KUBECTL) apply -f deploy/k8s/backend.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-backend
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-backend --timeout=120s

deploy-web: push-web apply-base
	$(KUBECTL) apply -f deploy/k8s/web.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-web
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-web --timeout=120s

# The secret holds GRADIUM_API_KEY and the AWS keys; secret/ is git-ignored.
audio-secret: apply-base
	@test -f secret/audio.env && test -f secret/aws.env || { echo "missing secret/audio.env or secret/aws.env"; exit 1; }
	@cat secret/audio.env secret/aws.env | grep -E '^(GRADIUM_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY)=' > .audio-secret.env
	$(KUBECTL) -n $(NAMESPACE) create secret generic dixvoice-audio-secrets --from-env-file=.audio-secret.env \
	  --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@rm -f .audio-secret.env

deploy-audio: push-audio apply-base
	$(KUBECTL) apply -f deploy/k8s/audio.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-audio
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-audio --timeout=180s

## Operations

status:
	$(KUBECTL) -n $(NAMESPACE) get deploy,pods,svc,ingress,certificate

logs-backend:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-backend -f --tail=100

logs-web:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-web -f --tail=100

logs-audio:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-audio -f --tail=100

cdn:
	deploy/cdn.sh
