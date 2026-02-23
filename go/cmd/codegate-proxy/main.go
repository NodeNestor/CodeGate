package main

import (
	"codegate-proxy/internal/db"
	"codegate-proxy/internal/proxy"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	proxyPort := getEnv("PROXY_PORT", "9212")

	log.SetFlags(log.Ltime | log.Lmicroseconds)

	// Open the shared SQLite database (read-only for queries, write connections opened per-write)
	if err := db.Open(); err != nil {
		log.Fatalf("Failed to open database: %v", err)
	}
	defer db.Close()

	handler := proxy.Handler()

	server := &http.Server{
		Addr:    ":" + proxyPort,
		Handler: handler,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down proxy...")
		server.Close()
	}()

	fmt.Printf("CodeGate Go Proxy starting on :%s\n", proxyPort)
	fmt.Println("  Reading config from shared SQLite database")
	fmt.Println("  Node.js dashboard should run separately on :9211")

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Proxy stopped.")
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
