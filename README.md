# GPU Pod Manager

Quickly deploy LLMs on GPU pods from [Prime Intellect](https://www.primeintellect.ai/), [Vast.ai](https://vast.ai/), AWS, etc., for local coding agents and AI assistants.

## Installation

```bash
npm install -g @badlogic/pi
```

Or run directly with npx:
```bash
npx @badlogic/pi
```

## What This Is

A simple CLI tool that automatically sets up and manages vLLM deployments on GPU pods. Start from a clean Ubuntu pod and have multiple models running in minutes. A GPU pod is defined as an Ubuntu machine with root access, one or more GPUs, and Cuda drivers installed. It is aimed at individuals who are limited by local hardware and want to experiment with large open weight LLMs for their coding assistent workflows.

**Key Features:**
- **Zero to LLM in minutes** - Automatically installs vLLM and all dependencies on clean pods
- **Multi-model management** - Run multiple models concurrently on a single pod
- **Smart GPU allocation** - Round robin assigns models to available GPUs on multi-GPU pods
- **Tensor parallelism** - Run large models across multiple GPUs with `--all-gpus`
- **OpenAI-compatible API** - Drop-in replacement for OpenAI API clients with automatic tool/function calling support
- **No complex setup** - Just SSH access, no Kubernetes or Docker required
- **Privacy first** - vLLM telemetry disabled by default

**Limitations:**
- OpenAI endpoints exposed to the public internet (yolo)
- Requires manual pod creation via Prime Intellect, Vast.ai, AWS, etc.
- Assumes Ubuntu 22 image when creating pods

## What this is not
- A provisioning manager for pods. You need to provision the pods on the respective provider themselves.
- Super optimized LLM deployment infrastructure for absolute best performance. This is for individuals who want to quickly spin up large open weights models for local LLM loads.

## Requirements

- **Node.js 14+** - To run the CLI tool
- **HuggingFace Token** - Required for downloading models (get one at https://huggingface.co/settings/tokens)
- **Prime Intellect Account** - Sign up at https://app.primeintellect.ai
- **GPU Pod** - At least one running pod with:
  - Ubuntu 22 image (selected when creating pod)
  - SSH access enabled
  - Clean state (no manual vLLM installation needed)

## Quick Start

```bash
# 1. Get a GPU pod from Prime Intellect
#    Visit https://app.primeintellect.ai or https://vast.ai/ and create a pod (use Ubuntu 22 image)
#    Providers usually give you an SSH command with which to log into the machine. Copy that command.

# 2. On your local machine, run the following to setup the remote pod. The Hugging Face token
#    is required for model download.
export HF_TOKEN=your_huggingface_token
pi setup my-pod-name "ssh root@135.181.71.41 -p 22"

# 3. Start a model (automatically manages GPU assignment)
pi start microsoft/Phi-3-mini-4k-instruct --name phi3 --context 4k --memory 20%

# 4. Test the model with a prompt
pi prompt phi3 "What is 2+2?"
# Response: The answer is 4.

# 5. Start another model (automatically uses next available GPU on multi-GPU pods)
pi start Qwen/Qwen2.5-7B-Instruct --name qwen --context 128k --memory 30%

# 6. Check running models
pi list

# 7. Use with your coding agent
export OPENAI_BASE_URL='http://135.181.71.41:8001/v1'  # For first model
export OPENAI_API_KEY='dummy'
```

## How It Works

1. **Automatic Setup**: When you run `pi setup`, it:
   - Connects to your clean Ubuntu pod
   - Installs Python, CUDA drivers, and vLLM
   - Configures HuggingFace tokens
   - Sets up the model manager

2. **Model Management**: Each `pi start` command:
   - Automatically finds an available GPU (on multi-GPU systems)
   - Allocates the specified memory fraction
   - Starts a separate vLLM instance on a unique port accessible via the OpenAI API protocol
   - Manages logs and process lifecycle

3. **Multi-GPU Support**: On pods with multiple GPUs:
   - Single models automatically distribute across available GPUs
   - Large models can use tensor parallelism with `--all-gpus`
   - View GPU assignments with `pi list`


## Commands

### Pod Management

The tool supports managing multiple Prime Intellect pods from a single machine. Each pod is identified by a name you choose (e.g., "prod", "dev", "h200"). While all your pods continue running independently, the tool operates on one "active" pod at a time - all model commands (start, stop, list, etc.) are directed to this active pod. You can easily switch which pod is active to manage models on different machines.

```bash
pi setup <pod-name> "<ssh_command>"  # Configure and activate a pod
pi pods                              # List all pods (active pod marked)
pi pod <pod-name>                    # Switch active pod
pi pod remove <pod-name>             # Remove pod from config
pi shell                             # SSH into active pod
```

### Model Management

Each model runs as a separate vLLM instance with its own port and GPU allocation. The tool automatically manages GPU assignment on multi-GPU systems and ensures models don't conflict. Models are accessed by their short names (either auto-generated or specified with --name).

```bash
pi list                              # List running models on active pod
pi search <query>                    # Search HuggingFace models
pi start <model> [options]           # Start a model with options
  --name <name>                      # Short alias (default: auto-generated)
  --context <size>                   # Context window: 4k, 8k, 16k, 32k (default: 8k)
  --memory <percent>                 # GPU memory: 30%, 50%, 90% (default: 90%)
  --all-gpus                         # Use tensor parallelism across all GPUs
pi stop [name]                       # Stop a model (or all if no name)
pi logs <name>                       # View logs with tail -f
pi prompt <name> "message"           # Quick test prompt
```

## Examples

### Search for models
```bash
pi search codellama
pi search deepseek
pi search qwen
```

**Note**: vLLM does not support formats like GGUF. Read the [docs](https://docs.vllm.ai/en/latest/)

### A100 80GB scenarios
```bash
# Small model, high concurrency (~30-50 concurrent requests)
pi start microsoft/Phi-3-mini-4k-instruct --name phi3 --context 4k --memory 30%

# Medium model, balanced (~10-20 concurrent requests)
pi start meta-llama/Llama-3.1-8B-Instruct --name llama8b --context 8k --memory 50%

# Large model, limited concurrency (~5-10 concurrent requests)
pi start meta-llama/Llama-3.1-70B-Instruct --name llama70b --context 4k --memory 90%

# Run multiple small models
pi start Qwen/Qwen2.5-Coder-1.5B --name coder1 --context 8k --memory 15%
pi start microsoft/Phi-3-mini-4k-instruct --name phi3 --context 4k --memory 15%
```

## Understanding Context and Memory

### Context Window vs Output Tokens
The `context` parameter sets the **total** token budget for input + output combined:
- Starting a model with `context=8k` means 8,192 tokens total
- If your prompt uses 6,000 tokens, you have 2,192 tokens left for the response
- Each OpenAI API request to the model can specify `max_output_tokens` to control output length within this budget

Example:
```bash
# Start model with 32k total context
pi start meta-llama/Llama-3.1-8B --name llama --context 32k --memory 50%

# When calling the API, you control output length per request:
# - Send 20k token prompt
# - Request max_tokens=4000
# - Total = 24k (fits within 32k context)
```

### GPU Memory and Concurrency
vLLM pre-allocates GPU memory controlled by `gpu_fraction`. This matters for coding agents that spawn sub-agents, as each connection needs memory.

Example: On an A100 80GB with a 7B model (FP16, ~14GB weights):
- `gpu_fraction=0.3` (24GB): ~10GB for KV cache → ~30-50 concurrent requests
- `gpu_fraction=0.5` (40GB): ~26GB for KV cache → ~50-80 concurrent requests
- `gpu_fraction=0.9` (72GB): ~58GB for KV cache → ~100+ concurrent requests

Models load in their native precision from HuggingFace (usually FP16/BF16). Check the model card's "Files and versions" tab - look for file sizes: 7B models are ~14GB, 13B are ~26GB, 70B are ~140GB. Quantized models (AWQ, GPTQ) in the name use less memory but may have quality trade-offs.

## Multi-GPU Support

For pods with multiple GPUs, the tool automatically manages GPU assignment:

### Automatic GPU assignment for multiple models
```bash
# Each model automatically uses the next available GPU
pi start microsoft/Phi-3-mini-4k-instruct --memory 20%  # Auto-assigns to GPU 0
pi start Qwen/Qwen2.5-7B-Instruct --memory 20%         # Auto-assigns to GPU 1
pi start meta-llama/Llama-3.1-8B --memory 20%          # Auto-assigns to GPU 2

# Check which GPU each model is using
pi list
```

### Run large models across all GPUs
```bash
# Use --all-gpus for tensor parallelism across all available GPUs
pi start meta-llama/Llama-3.1-70B-Instruct --all-gpus
pi start Qwen/Qwen2.5-72B-Instruct --all-gpus --context 64k
```

### Check GPU usage
```bash
pi ssh "nvidia-smi"
```

## Architecture Notes

- **Multi-Pod Support**: The tool stores multiple pod configurations in `~/.pi_config` with one active pod at a time.
- **Port Allocation**: Each model runs on a separate port (8001, 8002, etc.) allowing multiple models on one GPU.
- **Memory Management**: vLLM uses PagedAttention for efficient memory use with less than 4% waste.
- **Model Caching**: Models are downloaded once and cached on the pod.


## Troubleshooting

- **OOM Errors**: Reduce gpu_fraction or use a smaller model
- **Slow Inference**: Could be too many concurrent requests, try increasing gpu_fraction
- **Connection Refused**: Check pod is running and port is correct
- **HF Token Issues**: Ensure HF_TOKEN is set before running setup
- **Access Denied**: Some models (like Llama, Mistral) require completing an access request on HuggingFace first. Visit the model page and click "Request access"