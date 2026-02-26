#!/bin/bash
# CodeGate startup script.
#
# USE_GO_PROXY=true  → Node.js serves UI on 9211, Go binary serves proxy on 9212
# USE_GO_PROXY=false → Node.js serves both UI and proxy (original behavior)

if [ "$USE_GO_PROXY" = "true" ]; then
  echo "Starting CodeGate with Go proxy..."
  echo "  UI (Node.js):  :${UI_PORT:-9211}"
  echo "  Proxy (Go):    :${PROXY_PORT:-9212}"

  # Start Node.js (UI only) in background
  node dist/server/index.js &
  NODE_PID=$!

  # Start Go proxy in foreground
  exec codegate-proxy &
  GO_PID=$!

  # Wait for either to exit, then kill both
  wait -n $NODE_PID $GO_PID
  kill $NODE_PID $GO_PID 2>/dev/null
  wait
else
  echo "Starting CodeGate (Node.js only)..."
  exec node dist/server/index.js
fi
