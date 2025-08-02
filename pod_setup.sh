#!/usr/bin/env bash
# GPU pod bootstrap: Ubuntu 20.04/22.04/24.04 + dynamic CUDA toolkit, vLLM latest, FlashInfer

set -euo pipefail

apt update -y
apt install -y python3-pip python3-venv git build-essential cmake ninja-build curl wget lsb-release htop

# --- Install matching CUDA toolkit -------------------------------------------
echo "Checking CUDA driver version..."
DRIVER_CUDA_VERSION=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
echo "Driver supports CUDA: $DRIVER_CUDA_VERSION"

# Check if nvcc exists and its version
if command -v nvcc &> /dev/null; then
    NVCC_VERSION=$(nvcc --version | grep "release" | awk '{print $6}' | cut -d, -f1)
    echo "Current nvcc version: $NVCC_VERSION"
else
    NVCC_VERSION="none"
    echo "nvcc not found"
fi

# Install CUDA toolkit matching driver version if needed
if [[ "$NVCC_VERSION" != "$DRIVER_CUDA_VERSION" ]]; then
    echo "Installing CUDA Toolkit $DRIVER_CUDA_VERSION to match driver..."
    
    # Detect Ubuntu version
    UBUNTU_VERSION=$(lsb_release -rs)
    UBUNTU_CODENAME=$(lsb_release -cs)
    
    echo "Detected Ubuntu $UBUNTU_VERSION ($UBUNTU_CODENAME)"
    
    # Map Ubuntu version to NVIDIA repo path
    if [[ "$UBUNTU_VERSION" == "24.04" ]]; then
        REPO_PATH="ubuntu2404"
    elif [[ "$UBUNTU_VERSION" == "22.04" ]]; then
        REPO_PATH="ubuntu2204"
    elif [[ "$UBUNTU_VERSION" == "20.04" ]]; then
        REPO_PATH="ubuntu2004"
    else
        echo "Warning: Unsupported Ubuntu version $UBUNTU_VERSION, trying ubuntu2204"
        REPO_PATH="ubuntu2204"
    fi
    
    # Add NVIDIA package repositories
    wget https://developer.download.nvidia.com/compute/cuda/repos/${REPO_PATH}/x86_64/cuda-keyring_1.1-1_all.deb
    dpkg -i cuda-keyring_1.1-1_all.deb
    rm cuda-keyring_1.1-1_all.deb
    apt-get update
    
    # Install specific CUDA toolkit version
    # Convert version format (12.9 -> 12-9)
    CUDA_VERSION_APT=$(echo $DRIVER_CUDA_VERSION | sed 's/\./-/')
    echo "Installing cuda-toolkit-${CUDA_VERSION_APT}..."
    apt-get install -y cuda-toolkit-${CUDA_VERSION_APT}
    
    # Add CUDA to PATH
    export PATH=/usr/local/cuda-${DRIVER_CUDA_VERSION}/bin:$PATH
    export LD_LIBRARY_PATH=/usr/local/cuda-${DRIVER_CUDA_VERSION}/lib64:$LD_LIBRARY_PATH
    
    # Verify installation
    nvcc --version
else
    echo "CUDA toolkit $NVCC_VERSION matches driver version"
fi

# --- Install uv (fast Python package manager) --------------------------------
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# --- Install Python 3.13 if not available ------------------------------------
if ! command -v python3.13 &> /dev/null; then
    echo "Python 3.13 not found. Installing via uv..."
    # Let uv handle Python installation - it can download and install Python
    uv python install 3.13
fi

# --- Create and activate venv ------------------------------------------------
VENV="$HOME/vllm_env"
uv venv --python 3.13 --seed "$VENV"
source "$VENV/bin/activate"

# --- Install vLLM with automatic PyTorch selection ---------------------------
echo "Installing vLLM with automatic CUDA/PyTorch detection..."
# uv automatically selects the right PyTorch based on CUDA version
uv pip install vllm --torch-backend=auto

# --- Install additional packages ---------------------------------------------
echo "Installing additional packages..."
uv pip install huggingface-hub psutil tensorrt hf_transfer

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
export PATH="/usr/local/cuda-${DRIVER_CUDA_VERSION}/bin:$HOME/.local/bin:$PATH"
export LD_LIBRARY_PATH="/usr/local/cuda-${DRIVER_CUDA_VERSION}/lib64:$LD_LIBRARY_PATH"
export VLLM_ATTENTION_BACKEND=${ATTENTION_BACKEND}
export VLLM_USE_FLASHINFER_SAMPLER=1
export VLLM_USE_DEEP_GEMM=1
export VLLM_NO_USAGE_STATS=1
export VLLM_ALLOW_LONG_MAX_MODEL_LEN=1
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
export HF_TOKEN=${HF_TOKEN}
export HUGGING_FACE_HUB_TOKEN=${HF_TOKEN}
export HF_HUB_ENABLE_HF_TRANSFER=1
EOF

# --- RunPod specific setup ---------------------------------------------------
if df -h | grep -q "runpod.net.*workspace"; then
    echo "Detected RunPod instance - setting up workspace symlink..."
    if [ ! -L ~/.cache/huggingface ]; then
        mkdir -p /workspace/cache/huggingface
        rm -rf ~/.cache/huggingface 2>/dev/null || true
        ln -s /workspace/cache/huggingface ~/.cache/huggingface
        echo "Created symlink: ~/.cache/huggingface -> /workspace/cache/huggingface"
    else
        echo "Symlink already exists"
    fi
fi

echo "=== DONE ==="
