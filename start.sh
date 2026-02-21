#!/usr/bin/env bash
set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND="$REPO_DIR/backend"
FRONTEND="$REPO_DIR/frontend"

echo ""
echo "  ╔══════════════════════════════╗"
echo "  ║      SPY Dash — Startup      ║"
echo "  ╚══════════════════════════════╝"
echo ""

# Kill any process already on ports 3001 / 5173
kill_port() {
  local pid
  pid=$(lsof -ti tcp:"$1" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "  → Killing process on port $1 (PID $pid)"
    kill -9 "$pid" 2>/dev/null || true
  fi
}

kill_port 3001
kill_port 5173

# Start backend
echo "  → Starting backend on http://localhost:3001"
cd "$BACKEND"
npm run dev &
BACKEND_PID=$!

# Give backend a moment to boot
sleep 2

# Start frontend
echo "  → Starting frontend on http://localhost:5173"
cd "$FRONTEND"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  Backend  → http://localhost:3001"
echo "  Frontend → http://localhost:5173"
echo "  Health   → http://localhost:3001/health"
echo ""
echo "  Press Ctrl+C to stop both servers."
echo ""

# Trap Ctrl+C and kill both
cleanup() {
  echo ""
  echo "  Stopping servers..."
  kill "$BACKEND_PID" 2>/dev/null || true
  kill "$FRONTEND_PID" 2>/dev/null || true
  exit 0
}
trap cleanup INT TERM

wait
