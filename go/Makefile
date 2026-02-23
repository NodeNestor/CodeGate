.PHONY: build run clean vet

# Build the Go proxy binary
build:
	go build -o ../bin/codegate-proxy ./cmd/codegate-proxy/

# Run the Go proxy (reads from shared SQLite DB in ../data/)
run: build
	DATA_DIR=../data ../bin/codegate-proxy

# Run with custom port
run-port: build
	DATA_DIR=../data PROXY_PORT=$(PORT) ../bin/codegate-proxy

# Static analysis
vet:
	go vet ./...

# Clean build artifacts
clean:
	rm -f ../bin/codegate-proxy ../bin/codegate-proxy.exe
