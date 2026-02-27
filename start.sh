#!/bin/bash
# CodeGate startup script.
#
# Node.js serves the dashboard/API on :9211
# Go binary serves the LLM proxy on :9212

echo "Starting CodeGate..."
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
