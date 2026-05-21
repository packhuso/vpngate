BINARY  := vpnhub-agent
PKG     := ./cmd/agent
VERSION ?= 0.1.0-dev
COMMIT  := $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
BUILT   := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
LDFLAGS := -s -w \
  -X vpnhub.local/gateway-agent/internal/version.Version=$(VERSION) \
  -X vpnhub.local/gateway-agent/internal/version.Commit=$(COMMIT) \
  -X vpnhub.local/gateway-agent/internal/version.BuildTime=$(BUILT)

.PHONY: build test vet run clean

build:
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY) $(PKG)

# Static linux/amd64 binary to scp to the gateway VM
build-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/$(BINARY)-linux-amd64 $(PKG)

test:
	go test ./...

vet:
	go vet ./...

run:
	AGENT_TLS_DISABLE=true go run $(PKG)

clean:
	rm -rf bin
