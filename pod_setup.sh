#!/bin/bash
# Pod setup script for  GPU instances. Assumes Ubuntu based system with CUDA drivers installed.

set -e

echo "=== Pod Setup ==="

# Update and install basics
sudo apt update
sudo apt install -y python3-pip python3-venv

# Create virtual environment for vLLM
VENV_PATH="$HOME/vllm_env"
echo "Creating virtual environment at $VENV_PATH..."
python3 -m venv "$VENV_PATH"

# Activate virtual environment
source "$VENV_PATH/bin/activate"

# Upgrade pip in virtual environment
pip install --upgrade pip

# Install vLLM and dependencies
echo "Installing vLLM and dependencies..."

# Detect CUDA version and install appropriate PyTorch
# First try nvidia-smi (more commonly available), then nvcc
if command -v nvidia-smi &> /dev/null; then
    CUDA_VERSION=$(nvidia-smi | grep -oP 'CUDA Version: \K[0-9]+\.[0-9]+' | head -1)
    echo "Detected CUDA version from nvidia-smi: $CUDA_VERSION"
elif command -v nvcc &> /dev/null; then
    CUDA_VERSION=$(nvcc --version | grep "release" | sed -n 's/.*release \([0-9]\+\.[0-9]\+\).*/\1/p')
    echo "Detected CUDA version from nvcc: $CUDA_VERSION"
else
    CUDA_VERSION=""
fi

if [ -n "$CUDA_VERSION" ]; then
    # Map CUDA version to PyTorch index
    case "$CUDA_VERSION" in
        12.8*)
            echo "Installing PyTorch with CUDA 12.8 support"
            pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
            ;;
        12.7*)
            echo "Installing PyTorch with CUDA 12.7 support"
            pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu127
            ;;
        12.6*)
            echo "Installing PyTorch with CUDA 12.6 support"
            pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu126
            ;;
        12.4*)
            echo "Installing PyTorch with CUDA 12.4 support"
            pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
            ;;
        12.1*)
            echo "Installing PyTorch with CUDA 12.1 support"
            pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
            ;;
        11.8*)
            echo "Installing PyTorch with CUDA 11.8 support"
            pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
            ;;
        *)
            echo "CUDA $CUDA_VERSION detected - using default PyTorch (may not be optimal)"
            pip install torch torchvision torchaudio
            ;;
    esac
else
    echo "WARNING: nvcc not found, installing default PyTorch"
    pip install torch torchvision torchaudio
fi

pip install vllm huggingface-hub psutil

# Install FlashInfer for better performance (~15% sampler latency reduction)
echo "Installing FlashInfer for performance optimization..."
echo "Building FlashInfer from source..."

# Clone and build FlashInfer from source
cd /tmp
if [ -d "flashinfer" ]; then
    rm -rf flashinfer
fi

git clone https://github.com/flashinfer-ai/flashinfer.git --recursive
cd flashinfer

# Install from source
if python -m pip install -v .; then
    echo "FlashInfer successfully built from source"
else
    echo "FlashInfer installation failed (optional)"
fi

# Clean up
cd /
rm -rf /tmp/flashinfer

# Setup HuggingFace token from environment
if [ -z "$HF_TOKEN" ]; then
    echo "ERROR: HF_TOKEN environment variable not set"
    echo "Please export HF_TOKEN before running setup"
    exit 1
fi

# Create directory for vLLM config
mkdir -p ~/.config/vllm && touch ~/.config/vllm/do_not_track

# Create .pirc file for consistent environment
cat > ~/.pirc << EOF
# Prime Intellect CLI environment
# This file is sourced by all pi commands

# Activate vLLM virtual environment if it exists
if [ -d "\$HOME/vllm_env" ]; then
    source "\$HOME/vllm_env/bin/activate"
fi

# Performance optimizations
export VLLM_USE_FLASHINFER_SAMPLER=1
export VLLM_USE_DEEP_GEMM=1
export VLLM_NO_USAGE_STATS=1
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1

# HuggingFace tokens
export HF_TOKEN="$HF_TOKEN"
export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"
EOF

# Copy manager script
echo "Setup complete!"
