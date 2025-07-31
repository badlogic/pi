#!/bin/bash
# Pod setup script for Prime Intellect GPU instances

set -e

echo "=== Prime Intellect Pod Setup ==="

# Update and install basics
sudo apt update
sudo apt install -y python3-pip screen

# Install vLLM (using pip3 to be explicit) 
pip3 install --upgrade pip
pip3 install vllm huggingface-hub

# Note: flashinfer is optional and may fail on some systems
pip3 install flashinfer -i https://flashinfer.ai/whl/cu121/torch2.7/ || echo "FlashInfer installation failed (optional)"

# Setup HuggingFace token from environment
if [ -z "$HF_TOKEN" ]; then
    echo "ERROR: HF_TOKEN environment variable not set"
    echo "Please export HF_TOKEN before running setup"
    exit 1
fi

# Add to bashrc if not already there
if ! grep -q "HF_TOKEN" ~/.bashrc 2>/dev/null; then
    echo "" >> ~/.bashrc
    echo "# HuggingFace authentication" >> ~/.bashrc
    echo "export HF_TOKEN=\"$HF_TOKEN\"" >> ~/.bashrc
    echo "export HUGGING_FACE_HUB_TOKEN=\"$HF_TOKEN\"" >> ~/.bashrc
    echo "Added HF tokens to ~/.bashrc"
else
    echo "HF tokens already in ~/.bashrc"
fi

# Add vLLM telemetry opt-out to bashrc
if ! grep -q "VLLM_NO_USAGE_STATS" ~/.bashrc 2>/dev/null; then
    echo "" >> ~/.bashrc
    echo "# Disable vLLM telemetry" >> ~/.bashrc
    echo "export VLLM_NO_USAGE_STATS=1" >> ~/.bashrc
    echo "Added vLLM telemetry opt-out to ~/.bashrc"
fi

# Export for current session
export HF_TOKEN="$HF_TOKEN"
export HUGGING_FACE_HUB_TOKEN="$HF_TOKEN"

# Disable vLLM telemetry
export VLLM_NO_USAGE_STATS=1
mkdir -p ~/.config/vllm && touch ~/.config/vllm/do_not_track

# Copy manager script
echo "Setup complete!"
