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

# --- Install vLLM from source with automatic PyTorch selection ---------------
echo "Installing PyTorch with automatic CUDA detection..."
uv pip install torch --torch-backend=auto

echo "Installing vLLM from source for GLM-4.5 support..."
cd /tmp
rm -rf vllm
git clone https://github.com/vllm-project/vllm.git
cd vllm
python use_existing_torch.py
uv pip install -r requirements/build.txt
uv pip install --no-build-isolation -e .
cd ~

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
export LD_LIBRARY_PATH="/usr/local/cuda-${DRIVER_CUDA_VERSION}/lib64:\${LD_LIBRARY_PATH:-}"
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

# --- Model storage setup (REQUIRED) ------------------------------------------
if [ -z "${MODELS_PATH:-}" ]; then
    echo "ERROR: MODELS_PATH environment variable is required but not set"
    echo "This should be set by the pi CLI during setup"
    exit 1
fi

echo ""
echo "=== Setting up model storage ==="
echo "Storage path: $MODELS_PATH"

# Check if the path exists and is writable
if [ ! -d "$MODELS_PATH" ]; then
    echo "ERROR: Model storage path does not exist: $MODELS_PATH"
    echo ""
    echo "Common issues:"
    echo "  • Network volume not mounted"
    echo "  • Incorrect path specified"
    echo "  • Permission denied"
    echo ""
    echo "Please verify the path exists and is writable, then run setup again"
    exit 1
fi

if [ ! -w "$MODELS_PATH" ]; then
    echo "ERROR: Model storage path is not writable: $MODELS_PATH"
    echo "Please check permissions"
    exit 1
fi

# Create the huggingface cache directory structure in the models path
mkdir -p "${MODELS_PATH}/huggingface/hub"

# Remove any existing cache directory or symlink
if [ -e ~/.cache/huggingface ] || [ -L ~/.cache/huggingface ]; then
    echo "Removing existing ~/.cache/huggingface..."
    rm -rf ~/.cache/huggingface 2>/dev/null || true
fi

# Create parent directory if needed
mkdir -p ~/.cache

# Create symlink from ~/.cache/huggingface to the models path
ln -s "${MODELS_PATH}/huggingface" ~/.cache/huggingface
echo "Created symlink: ~/.cache/huggingface -> ${MODELS_PATH}/huggingface"

# Verify the symlink works
if [ -d ~/.cache/huggingface/hub ]; then
    echo "✓ Model storage configured successfully"
    
    # Check available space
    AVAILABLE_SPACE=$(df -h "$MODELS_PATH" | awk 'NR==2 {print $4}')
    echo "Available space: $AVAILABLE_SPACE"
else
    echo "ERROR: Could not verify model storage setup"
    echo "The symlink was created but the target directory is not accessible"
    exit 1
fi

echo "=== DONE ==="
