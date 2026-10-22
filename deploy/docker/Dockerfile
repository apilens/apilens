# syntax=docker/dockerfile:1.28.0@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
#
# APILens single binary (all roles). One image serves every -target.
#
# Build context is the REPO ROOT:
#   docker build -f deploy/docker/Dockerfile -t ghcr.io/apilens/apilens:dev \
#     --build-arg VERSION=dev --build-arg COMMIT=$(git rev-parse HEAD) .
#
# The Go toolchain cross-compiles natively on the build platform (no QEMU):
# CGO is disabled, so GOOS/GOARCH come straight from TARGETOS/TARGETARCH.

FROM --platform=$BUILDPLATFORM golang:1.27.3-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS build

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown

WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY cmd ./cmd
COPY internal ./internal

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath \
      -ldflags="-s -w \
        -X github.com/apilens/apilens/internal/platform/buildinfo.Version=${VERSION} \
        -X github.com/apilens/apilens/internal/platform/buildinfo.Commit=${COMMIT} \
        -X github.com/apilens/apilens/internal/platform/buildinfo.Date=${DATE}" \
      -o /out/apilens ./cmd/apilens

FROM gcr.io/distroless/static-debian13:nonroot@sha256:d62067879de890a1def9da0e7766b7d20810a5e5555cef8506b752437d7a3e88

ARG VERSION=dev
ARG COMMIT=unknown
LABEL org.opencontainers.image.title="apilens" \
      org.opencontainers.image.description="APILens API observability platform (single binary, role targets)" \
      org.opencontainers.image.source="https://github.com/apilens/apilens" \
      org.opencontainers.image.url="https://github.com/apilens/apilens" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${COMMIT}"

COPY --from=build /out/apilens /apilens

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/apilens"]
CMD ["-target=all"]
