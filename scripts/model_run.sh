#!/usr/bin/env bash
# Model runner script - runs sequentially, killed by pi stop
set -euo pipefail

# These values are replaced before upload by pi CLI
MODEL_ID="{{MODEL_ID}}"
NAME="{{NAME}}"
PORT="{{PORT}}"
VLLM_ARGS="{{VLLM_ARGS}}"

# Force colored output even when not a TTY
export FORCE_COLOR=1
export PYTHONUNBUFFERED=1
export TERM=xterm-256color
export RICH_FORCE_TERMINAL=1
export CLICOLOR_FORCE=1

# Source virtual environment
source /root/venv/bin/activate

echo "========================================="
echo "Model Run: $NAME"
echo "Model ID: $MODEL_ID"
echo "Port: $PORT"
if [ -n "$VLLM_ARGS" ]; then
    echo "vLLM Args: $VLLM_ARGS"
fi
echo "========================================="
echo ""

# Download model (with color progress bars)
echo "Downloading model (will skip if cached)..."
HF_HUB_ENABLE_HF_TRANSFER=1 hf download "$MODEL_ID"

if [ $? -ne 0 ]; then
    echo "❌ ERROR: Failed to download model" >&2
    exit 1
fi

echo ""
echo "✅ Model download complete"
echo ""

# Build vLLM command
VLLM_CMD="vllm serve '$MODEL_ID' --port $PORT --api-key '$VLLM_API_KEY'"
if [ -n "$VLLM_ARGS" ]; then
    VLLM_CMD="$VLLM_CMD $VLLM_ARGS"
fi

echo "Starting vLLM server..."
echo "Command: $VLLM_CMD"
echo "========================================="
echo ""

# Run vLLM (this blocks until killed)
# Use exec to replace this shell with vLLM, so signals go directly to it
exec bash -c "$VLLM_CMD"