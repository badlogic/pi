#!/usr/bin/env bash
# GPU pod bootstrap: Ubuntu 22.04 + CUDA 12.6/12.8, vLLM latest, FlashInfer w/ TRT kernels (sm70-120)

set -euo pipefail

sudo apt update -y
sudo apt install -y python3-pip python3-venv git build-essential cmake ninja-build curl

# --- Install uv (fast Python package manager) --------------------------------
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# --- Create and activate venv ------------------------------------------------
VENV="$HOME/vllm_env"
uv venv --python 3.12 --seed "$VENV"
source "$VENV/bin/activate"

# --- Install vLLM with automatic PyTorch selection ---------------------------
echo "Installing vLLM with automatic CUDA/PyTorch detection..."
# uv automatically selects the right PyTorch based on CUDA version
uv pip install vllm --torch-backend=auto

# --- Install additional packages ---------------------------------------------
echo "Installing additional packages..."
uv pip install huggingface-hub psutil tensorrt

# --- FlashInfer installation (optional, improves performance) ----------------
echo "Attempting FlashInfer installation (optional)..."
# vLLM will use Flash Attention as fallback if FlashInfer is not available

# Try the official FlashInfer package name
if uv pip install flashinfer-python; then
    echo "FlashInfer installed successfully"
    ATTENTION_BACKEND="FLASHINFER"
else
    echo "FlashInfer not available, using Flash Attention instead"
    ATTENTION_BACKEND="FLASH_ATTN"
fi

# --- HF token check ----------------------------------------------------------
: "${HF_TOKEN:?HF_TOKEN env var required}"

mkdir -p ~/.config/vllm
touch ~/.config/vllm/do_not_track

cat > ~/.pirc <<EOF
# auto-sourced env
[ -d "$HOME/vllm_env" ] && source "$HOME/vllm_env/bin/activate"
export PATH="$HOME/.local/bin:$PATH"
export VLLM_ATTENTION_BACKEND=${ATTENTION_BACKEND}
export VLLM_USE_FLASHINFER_SAMPLER=1
export VLLM_USE_DEEP_GEMM=1
export VLLM_NO_USAGE_STATS=1
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export HF_TOKEN=${HF_TOKEN}
export HUGGING_FACE_HUB_TOKEN=${HF_TOKEN}
EOF

echo "=== DONE ==="
