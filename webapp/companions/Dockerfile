# syntax=docker/dockerfile:1
# Build: docker buildx build --platform linux/arm64 -t <image> webapp/companions
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} \
    go build -trimpath -ldflags="-s -w" -o /out/companions ./cmd/companions

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/companions /companions
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/companions"]
