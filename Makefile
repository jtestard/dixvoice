# Build and deploy Dixvoice to the gcast EKS cluster.
#
#   make deploy           build, push and roll out all the apps
#   make deploy-backend   same, backend only (deploy-web, deploy-audio, deploy-companions, deploy-sample)
#   make build            build the images locally, without pushing
#   make audio-secret     create/update the audio service's secret from secret/audio.env and secret/aws.env
#   make companions-secret  create/update the companions' secret (GEMINI_API_KEY) from secret/gemini.key
#   make status | logs-backend | logs-web | logs-audio | logs-companions | logs-sample
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
COMP_IMG    := $(REGISTRY)/dixvoice-companions:latest
SAMPLE_IMG  := $(REGISTRY)/dixvoice-sample:latest
SAMPLE_ARGS := webapp/sample
WEB_ARGS    := --build-arg VITE_BACKEND_URL=$(BACKEND_URL)
KUBECTL     := kubectl --context $(CONTEXT)

.PHONY: build build-backend build-web build-audio build-companions push push-backend push-web push-audio push-companions \
        build-sample push-sample deploy-sample logs-sample ecr-login ecr-repos apply-base deploy deploy-backend deploy-web deploy-audio deploy-companions audio-secret \
        companions-secret status logs-backend logs-web logs-audio logs-companions cdn

## Local builds (arm64 images loaded into the local docker)

build: build-backend build-web build-audio build-companions build-sample

build-backend:
	docker buildx build --platform $(PLATFORM) -t $(BACKEND_IMG) --load webapp/backend

build-web:
	docker buildx build --platform $(PLATFORM) -t $(WEB_IMG) $(WEB_ARGS) --load webapp/frontend

build-audio:
	docker buildx build --platform $(PLATFORM) -t $(AUDIO_IMG) --load webapp/audio

build-companions:
	docker buildx build --platform $(PLATFORM) -t $(COMP_IMG) --load webapp/companions

build-sample:
	docker buildx build --platform $(PLATFORM) -t $(SAMPLE_IMG) --load $(SAMPLE_ARGS)

## Push to ECR

ecr-login:
	aws ecr get-login-password --region $(REGION) | docker login --username AWS --password-stdin $(REGISTRY)

ecr-repos:
	@for r in dixvoice-backend dixvoice-web dixvoice-audio dixvoice-companions dixvoice-sample; do \
	  aws ecr describe-repositories --region $(REGION) --repository-names $$r >/dev/null 2>&1 || \
	  aws ecr create-repository --region $(REGION) --repository-name $$r >/dev/null; \
	done

push: push-backend push-web push-audio push-companions push-sample

push-backend: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(BACKEND_IMG) --push webapp/backend

push-web: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(WEB_IMG) $(WEB_ARGS) --push webapp/frontend

push-audio: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(AUDIO_IMG) --push webapp/audio

push-companions: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(COMP_IMG) --push webapp/companions

push-sample: ecr-login ecr-repos
	docker buildx build --platform $(PLATFORM) -t $(SAMPLE_IMG) --push $(SAMPLE_ARGS)

## Deploy

apply-base:
	$(KUBECTL) apply -f deploy/k8s/00-namespace.yaml -f deploy/k8s/01-certificate.yaml

deploy: deploy-audio deploy-companions deploy-backend deploy-web deploy-sample

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

# secret/gemini.key holds the Gemini API key, raw or as KEY=value; secret/ is git-ignored.
companions-secret: apply-base
	@test -f secret/gemini.key || { echo "missing secret/gemini.key"; exit 1; }
	@printf 'GEMINI_API_KEY=%s\n' "$$(sed -E 's/^[A-Za-z_]+=//; s/["'"'"' ]//g' secret/gemini.key | tr -d '\n\r')" > .companions-secret.env
	$(KUBECTL) -n $(NAMESPACE) create secret generic dixvoice-companions-secrets --from-env-file=.companions-secret.env \
	  --dry-run=client -o yaml | $(KUBECTL) apply -f -
	@rm -f .companions-secret.env

deploy-companions: push-companions apply-base
	$(KUBECTL) apply -f deploy/k8s/companions.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-companions
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-companions --timeout=120s

deploy-sample: push-sample apply-base
	$(KUBECTL) apply -f deploy/k8s/sample.yaml
	$(KUBECTL) -n $(NAMESPACE) rollout restart deployment/dixvoice-sample
	$(KUBECTL) -n $(NAMESPACE) rollout status deployment/dixvoice-sample --timeout=120s

## Operations

status:
	$(KUBECTL) -n $(NAMESPACE) get deploy,pods,svc,ingress,certificate

logs-backend:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-backend -f --tail=100

logs-web:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-web -f --tail=100

logs-audio:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-audio -f --tail=100

logs-companions:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-companions -f --tail=100

logs-sample:
	$(KUBECTL) -n $(NAMESPACE) logs deployment/dixvoice-sample -f --tail=100

cdn:
	deploy/cdn.sh
