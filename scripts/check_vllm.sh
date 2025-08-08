#!/usr/bin/env bash
# Check if vLLM is installed and show version info

echo "=== vLLM Installation Check ==="
echo ""

# Check if venv exists
if [ -d "$HOME/venv" ]; then
    echo "✓ Virtual environment found at $HOME/venv"
    source "$HOME/venv/bin/activate"
else
    echo "✗ No virtual environment found"
    exit 1
fi

# Check Python
echo ""
echo "Python: $(which python)"
echo "Python version: $(python --version)"

# Check PyTorch
echo ""
echo "Checking PyTorch..."
python -c "import torch; print(f'PyTorch version: {torch.__version__}'); print(f'CUDA available: {torch.cuda.is_available()}'); print(f'CUDA version: {torch.version.cuda if torch.cuda.is_available() else \"N/A\"}')" 2>/dev/null || echo "✗ PyTorch not found"

# Check vLLM
echo ""
echo "Checking vLLM..."
if python -c "import vllm" 2>/dev/null; then
    echo "✓ vLLM is installed"
    
    # Get version
    python -c "import vllm; print(f'vLLM version: {vllm.__version__}')" 2>/dev/null || echo "Version info not available"
    
    # Check if it's a source build (editable install)
    if pip show vllm 2>/dev/null | grep -q "Editable project location"; then
        echo "✓ vLLM is installed from source (editable)"
        pip show vllm | grep "Location\|Editable"
    else
        echo "⚠ vLLM appears to be a wheel install (not from source)"
    fi
    
    # Try to import key components
    echo ""
    echo "Testing vLLM components:"
    python -c "from vllm import LLM; print('✓ Can import LLM')" 2>/dev/null || echo "✗ Cannot import LLM"
    python -c "from vllm import SamplingParams; print('✓ Can import SamplingParams')" 2>/dev/null || echo "✗ Cannot import SamplingParams"
    python -c "from vllm.entrypoints.openai.api_server import *; print('✓ Can import API server')" 2>/dev/null || echo "✗ Cannot import API server"
    
    # Check for compiled extensions
    echo ""
    echo "Checking compiled extensions:"
    python -c "import vllm._C; print('✓ C++ extensions loaded')" 2>/dev/null || echo "✗ C++ extensions not found"
    python -c "import vllm._custom_ops; print('✓ Custom ops loaded')" 2>/dev/null || echo "✗ Custom ops not found"
    
else
    echo "✗ vLLM is NOT installed"
    echo ""
    echo "Checking for build artifacts..."
    if [ -d "/tmp/vllm" ]; then
        echo "Found vLLM source at /tmp/vllm"
        if [ -f "/tmp/vllm/setup.py" ]; then
            echo "✓ setup.py exists"
        fi
        if [ -d "/tmp/vllm/build" ]; then
            echo "✓ build directory exists"
            ls -la /tmp/vllm/build | head -5
        fi
    fi
fi

# Check available GPU
echo ""
echo "=== GPU Information ==="
nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader 2>/dev/null || echo "✗ Cannot query GPU"

echo ""
echo "=== Installation Summary ==="
if python -c "import vllm._C" 2>/dev/null; then
    echo "✅ vLLM is fully installed and functional"
else
    echo "❌ vLLM is not properly installed"
fi