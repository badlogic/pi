# GPU Pod Manager

Quickly deploy LLMs on GPU pods from [Prime Intellect](https://www.primeintellect.ai/), [Vast.ai](https://vast.ai/), [DataCrunch](datacrunch.io), AWS, etc., for local coding agents and AI assistants.

## Installation

```bash
npm install -g @mariozechner/pi
```

Or run directly with npx:
```bash
npx @mariozechner/pi
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

- **Node.js 14+** - To run the CLI tool on your machine
- **HuggingFace Token** - Required for downloading models (get one at https://huggingface.co/settings/tokens)
- **Prime Intellect/DataCrunch/Vast.ai Account**
- **GPU Pod** - At least one running pod with:
  - Ubuntu 22+ image (selected when creating pod)
  - SSH access enabled
  - Clean state (no manual vLLM installation needed)
  - **Note**: B200 GPUs require PyTorch nightly with CUDA 12.8+ (automatically installed if detected). However, vLLM may need to be built from source for full compatibility.

## Quick Start

```bash
# 1. Get a GPU pod from Prime Intellect
#    Visit https://app.primeintellect.ai or https://vast.ai/ or https://datacrunch.io and create a pod (use Ubuntu 22+ image)
#    Providers usually give you an SSH command with which to log into the machine. Copy that command.
#    IMPORTANT: Note where your provider stores persistent data (e.g., /workspace, /data, etc.)

# 2. On your local machine, run the following to setup the remote pod. The Hugging Face token
#    is required for model download. The --models-path is REQUIRED and should point to persistent storage.
export HF_TOKEN=your_huggingface_token
pi setup my-pod-name "ssh root@135.181.71.41 -p 22" --models-path /workspace

# 3. Start a model (automatically manages GPU assignment)
pi start microsoft/Phi-3-mini-128k-instruct --name phi3 --memory 20%

# 4. Test the model with a prompt
pi prompt phi3 "What is 2+2?"
# Response: The answer is 4.

# 5. Start another model (automatically uses next available GPU on multi-GPU pods)
pi start Qwen/Qwen2.5-7B-Instruct --name qwen --memory 30%

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

The tool supports managing multiple GPU pods from a single machine. Each pod is identified by a name you choose (e.g., "prod", "dev", "h200"). While all your pods continue running independently, the tool operates on one "active" pod at a time - all model commands (start, stop, list, etc.) are directed to this active pod. You can easily switch which pod is active to manage models on different machines.

```bash
pi setup <pod-name> "<ssh_command>" --models-path <path> [--mount <command>]  # Configure and activate a pod
pi pods                                                                       # List all pods (active pod marked)
pi pod <pod-name>                                                            # Switch active pod
pi pod remove <pod-name>                                                     # Remove pod from config
pi shell                                                                     # SSH into active pod
```

#### Why --models-path is Required

The `--models-path` parameter is **REQUIRED** to ensure your downloaded models persist across pod restarts and can be shared between pods. Here's why this matters:

1. **Avoid Re-downloading**: Large models (70B+) can take 30+ minutes to download. With persistent storage, download once and reuse.
2. **Cost Efficiency**: No wasted GPU time re-downloading models every time you start a pod.
3. **Pod Flexibility**: Switch between different GPU types or providers while keeping your model library.
4. **Shared Model Library**: With network volumes, multiple pods can access the same models simultaneously.
5. **Disaster Recovery**: If a pod crashes or gets terminated, your models are safe.

Without persistent storage, models would be stored in the pod's ephemeral storage and lost when the pod stops, requiring re-download every time.

**Example scenario**: Running Llama-3.1-70B (140GB download)
- ❌ Without persistent storage: 30 min download every pod restart = $5-10 wasted GPU time per restart
- ✅ With persistent storage: Download once, instant starts forever = Save hours and dollars

#### Model Storage Paths by Provider

The `--models-path` should point to persistent storage that survives pod restarts:

| Provider | Recommended Path | Type | Notes |
|----------|-----------------|------|-------|
| **RunPod** | `/workspace` | Pod storage | Persists for pod lifetime |
| **RunPod** | `/runpod-volume` | Network volume | Shared across pods (if configured) |
| **Vast.ai** | `/workspace` | Instance storage | Check your instance details |
| **DataCrunch** | `/mnt/sfs` | NFS mount | Requires manual mount (see below) |
| **Lambda Labs** | `/persistent` | Persistent storage | Check instance config |
| **AWS** | `/mnt/efs` | EFS mount | Configure EFS first |
| **Custom** | `/your/path` | Your mount | Any persistent mount point |

**Example setups:**
```bash
# RunPod with network volume
pi setup runpod "root@123.45.67.89 -p 22" --models-path /runpod-volume

# Vast.ai with workspace
pi setup vast "root@vast.ai -p 22" --models-path /workspace

# DataCrunch with NFS mount (see DataCrunch section below)
pi setup dc "ubuntu@dc.server.com" --models-path /mnt/sfs
```

#### DataCrunch Shared Filesystem Setup

DataCrunch uses NFS for shared storage. The easiest way is to use the `--mount` flag during setup:

**Option 1: Automatic mount with --mount flag (Recommended)**

1. **Create a Shared Filesystem (SFS) in DataCrunch dashboard**
2. **Share it with your instance**
3. **Copy the mount command from DataCrunch dashboard**
4. **Run pi setup with --mount:**

```bash
# Copy the mount command from DataCrunch dashboard and use it with --mount
pi setup dc "ubuntu@your-instance.datacrunch.io" --models-path /mnt/sfs \
  --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-01.datacrunch.io:/your-pseudo /mnt/sfs"
```

The setup will automatically:
- Create the mount point directory
- Execute the mount command
- Add to /etc/fstab for persistence
- Verify the mount succeeded

**Option 2: Manual mount before setup**

```bash
# SSH into your DataCrunch instance first
ssh ubuntu@your-instance.datacrunch.io

# Create mount point
sudo mkdir -p /mnt/sfs

# Mount the filesystem (replace with your values from DataCrunch dashboard)
# <DC> = datacenter (e.g., fin-01)
# <PSEUDO> = pseudopath from your SFS dashboard
sudo mount -t nfs -o nconnect=16 nfs.<DC>.datacrunch.io:<PSEUDO> /mnt/sfs

# Add to fstab for persistence across reboots
echo 'nfs.<DC>.datacrunch.io:<PSEUDO> /mnt/sfs nfs defaults,nconnect=16 0 0' | sudo tee -a /etc/fstab

# Verify mount
df -h /mnt/sfs

# Exit back to your local machine
exit

# Now run pi setup with the mounted path
pi setup dc "ubuntu@your-instance.datacrunch.io" --models-path /mnt/sfs
```

**Benefits of DataCrunch SFS:**
- Shared across all your DataCrunch instances in the same datacenter
- Survives instance deletion
- Can be used to share models between multiple GPU instances
- Pay only for storage, not compute time while models download

#### Working with Multiple Pods

You can manage models on any pod without switching the active pod by using the `--pod` parameter:

```bash
# List models on a specific pod
pi list --pod prod

# Start a model on a specific pod
pi start Qwen/Qwen2.5-7B-Instruct --name qwen --pod dev

# Stop a model on a specific pod
pi stop qwen --pod dev

# View logs from a specific pod
pi logs qwen --pod dev

# Test a model on a specific pod
pi prompt qwen "Hello!" --pod dev

# SSH into a specific pod
pi shell --pod prod
pi ssh --pod prod "nvidia-smi"
```

This allows you to manage multiple environments (dev, staging, production) from a single machine without constantly switching between them.

### Model Management

Each model runs as a separate vLLM instance with its own port and GPU allocation. The tool automatically manages GPU assignment on multi-GPU systems and ensures models don't conflict. Models are accessed by their short names (either auto-generated or specified with --name).

```bash
pi list                              # List running models on active pod
pi search <query>                    # Search HuggingFace models
pi start <model> [options]           # Start a model with options
  --name <name>                      # Short alias (default: auto-generated)
  --context <size>                   # Context window: 4k, 8k, 16k, 32k (default: model default)
  --memory <percent>                 # GPU memory: 30%, 50%, 90% (default: 90%)
  --all-gpus                         # Use tensor parallelism across all GPUs
  --pod <pod-name>                   # Run on specific pod (default: active pod)
  --vllm-args                        # Pass all remaining args directly to vLLM
pi stop [name]                       # Stop a model (or all if no name)
pi logs <name>                       # View logs with tail -f
pi prompt <name> "message"           # Quick test prompt
pi downloads [--live]                # Check model download progress (--live for continuous monitoring)
```

All model management commands support the `--pod` parameter to target a specific pod without switching the active pod.

## Examples

### Running GPT-OSS Models

OpenAI's GPT-OSS models are open-weight models optimized with MXFP4 quantization:

```bash
# GPT-OSS 20B - Fits on 16GB+ VRAM GPUs
pi start openai/gpt-oss-20b --name gpt-oss-20b

# GPT-OSS 120B - Needs 60GB+ VRAM (single H100 or multi-GPU)
pi start openai/gpt-oss-120b --name gpt-oss-120b --all-gpus

# With custom context and memory settings
pi start openai/gpt-oss-20b --name gpt-oss --context 32k --memory 50%
```

Both models support:
- Chat completions API
- Responses API (OpenAI's new format)
- Tool calling (function calling)
- Browsing capabilities

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
pi start microsoft/Phi-3-mini-128k-instruct --name phi3 --memory 30%

# Medium model, balanced (~10-20 concurrent requests)
pi start meta-llama/Llama-3.1-8B-Instruct --name llama8b --memory 50%

# Large model, limited concurrency (~5-10 concurrent requests)
pi start meta-llama/Llama-3.1-70B-Instruct --name llama70b --memory 90%

# Run multiple small models
pi start Qwen/Qwen2.5-Coder-1.5B --name coder1 --memory 15%
pi start microsoft/Phi-3-mini-128k-instruct --name phi3 --memory 15%
```

## Understanding Context and Memory

### Context Window vs Output Tokens
Models are loaded with their default context length. You can use the `context` parameter to specify a lower or higher context length. The `context` parameter sets the **total** token budget for input + output combined:
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
pi start microsoft/Phi-3-mini-128k-instruct --memory 20%  # Auto-assigns to GPU 0
pi start Qwen/Qwen2.5-7B-Instruct --memory 20%         # Auto-assigns to GPU 1
pi start meta-llama/Llama-3.1-8B --memory 20%          # Auto-assigns to GPU 2

# Check which GPU each model is using
pi list
```

## Qwen on a single H200
```bash
pi start Qwen/Qwen3-Coder-30B-A3B-Instruct qwen3-30b
```

### Run large models across all GPUs
```bash
# Use --all-gpus for tensor parallelism across all available GPUs
pi start meta-llama/Llama-3.1-70B-Instruct --all-gpus
pi start Qwen/Qwen2.5-72B-Instruct --all-gpus --context 64k
```

### Advanced: Custom vLLM arguments
```bash
# Pass custom arguments directly to vLLM with --vllm-args
# Everything after --vllm-args is passed to vLLM unchanged

# Qwen3-Coder 480B on 8xH200 with expert parallelism
pi start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen-coder --vllm-args \
  --data-parallel-size 8 --enable-expert-parallel \
  --tool-call-parser qwen3_coder --enable-auto-tool-choice --gpu-memory-utilization 0.95 --max-model-len 200000

# DeepSeek with custom quantization
pi start deepseek-ai/DeepSeek-Coder-V2-Instruct --name deepseek --vllm-args \
  --tensor-parallel-size 4 --quantization fp8 --trust-remote-code

# Mixtral with pipeline parallelism
pi start mistralai/Mixtral-8x22B-Instruct-v0.1 --name mixtral --vllm-args \
  --tensor-parallel-size 8 --pipeline-parallel-size 2
```

**Note on Special Models**: Some models require specific vLLM arguments to run properly:
- **Qwen3-Coder 480B**: Requires `--enable-expert-parallel` for MoE support
- **Kimi K2**: May require custom arguments - check the model's documentation
- **DeepSeek V3**: Often needs `--trust-remote-code` for custom architectures
- When in doubt, consult the model's HuggingFace page or documentation for recommended vLLM settings

### Check GPU usage
```bash
pi ssh "nvidia-smi"
```

## Architecture Notes

- **Multi-Pod Support**: The tool stores multiple pod configurations in `~/.pi_config` with one active pod at a time.
- **Port Allocation**: Each model runs on a separate port (8001, 8002, etc.) allowing multiple models on one GPU.
- **Memory Management**: vLLM uses PagedAttention for efficient memory use with less than 4% waste.
- **Model Caching**: Models are downloaded once and cached on the pod.
- **Tool Parser Auto-Detection**: The tool automatically selects the appropriate tool parser based on the model:
  - Qwen models: `hermes` (Qwen3-Coder: `qwen3_coder` if available)
  - Mistral models: `mistral` with optimized chat template
  - Llama models: `llama3_json` or `llama4_pythonic` based on version
  - InternLM models: `internlm`
  - Phi models: Tool calling disabled by default (no compatible tokens)
  - Override with `--vllm-args --tool-call-parser <parser> --enable-auto-tool-choice`


## Tool Calling (Function Calling)

Tool calling allows LLMs to request the use of external functions/APIs, but it's a complex feature with many caveats:

### The Reality of Tool Calling

1. **Model Compatibility**: Not all models support tool calling, even if they claim to. Many models lack the special tokens or training needed for reliable tool parsing.

2. **Parser Mismatches**: Different models use different tool calling formats:
   - Hermes format (XML-like)
   - Mistral format (specific JSON structure)
   - Llama format (JSON-based or pythonic)
   - Custom formats for each model family

3. **Common Issues**:
   - "Could not locate tool call start/end tokens" - Model doesn't have required special tokens
   - Malformed JSON/XML output - Model wasn't trained for the parser format
   - Tool calls when you don't want them - Model overeager to use tools
   - No tool calls when you need them - Model doesn't understand when to use tools

### How We Handle It

The tool automatically detects the model and tries to use an appropriate parser:
- **Qwen models**: `hermes` parser (Qwen3-Coder uses `qwen3_coder`)
- **Mistral models**: `mistral` parser with custom template
- **Llama models**: `llama3_json` or `llama4_pythonic` based on version
- **Phi models**: Tool calling disabled (no compatible tokens)

### Your Options

1. **Let auto-detection handle it** (default):
   ```bash
   pi start meta-llama/Llama-3.1-8B-Instruct --name llama
   ```

2. **Force a specific parser** (if you know better):
   ```bash
   pi start model/name --name mymodel --vllm-args \
     --tool-call-parser mistral --enable-auto-tool-choice
   ```

3. **Disable tool calling entirely** (most reliable):
   ```bash
   pi start model/name --name mymodel --vllm-args \
     --disable-tool-call-parser
   ```

4. **Handle tools in your application** (recommended for production):
   - Send regular prompts asking the model to output JSON
   - Parse the response in your code
   - More control, more reliable

### Best Practices

- **Test first**: Try a simple tool call to see if it works with your model
- **Have a fallback**: Be prepared for tool calling to fail
- **Consider alternatives**: Sometimes a well-crafted prompt works better than tool calling
- **Read the docs**: Check the model card for tool calling examples
- **Monitor logs**: Check `~/.vllm_logs/` for parser errors

Remember: Tool calling is still an evolving feature in the LLM ecosystem. What works today might break tomorrow with a model update.

## Monitoring Downloads

Use `pi downloads` to check the progress of model downloads in the HuggingFace cache:

```bash
pi downloads                         # Check downloads on active pod
pi downloads --live                  # Live monitoring (updates every 2 seconds)
pi downloads --pod 8h200            # Check downloads on specific pod
pi downloads --live --pod 8h200     # Live monitoring on specific pod
```

The command shows:
- Model name and current size
- Download progress (files downloaded / total files)
- Download status (⏬ Downloading or ⏸ Idle)
- Estimated total size (if available from HuggingFace)

**Tip for large models**: When starting models like Qwen-480B that take time to download, run `pi start` in one terminal and `pi downloads --live` in another to monitor progress. This is especially helpful since the log output during downloads can be minimal.

**Downloads stalled?** If downloads appear stuck (e.g., at 92%), you can safely stop and restart:
```bash
pi stop <model-name>         # Stop the current process
pi downloads                 # Verify progress (e.g., 45/49 files)
pi start <same-command>      # Restart with the same command
```
vLLM will automatically use the already-downloaded files and continue from where it left off. This often resolves network or CDN throttling issues.

## Troubleshooting

- **OOM Errors**: Reduce gpu_fraction or use a smaller model
- **Slow Inference**: Could be too many concurrent requests, try increasing gpu_fraction
- **Connection Refused**: Check pod is running and port is correct
- **HF Token Issues**: Ensure HF_TOKEN is set before running setup
- **Access Denied**: Some models (like Llama, Mistral) require completing an access request on HuggingFace first. Visit the model page and click "Request access"
- **Tool Calling Errors**: See the Tool Calling section above - consider disabling it or using a different model
- **Model Won't Stop**: If `pi stop` fails, force kill all Python processes and verify GPU is free:
  ```bash
  pi ssh "killall -9 python3"
  pi ssh "nvidia-smi"  # Should show no processes using GPU
  ```
- **Model Deployment Fails**: Pi currently does not check GPU memory utilization before starting models. If deploying a model fails:
  1. Check if GPUs are full with other models: `pi ssh "nvidia-smi"`
  2. If memory is insufficient, make room by stopping running models: `pi stop <model_name>`
  3. If the error persists with sufficient memory, copy the error output and feed it to an LLM for troubleshooting assistance

## Timing notes
- 8x B200 on DataCrunch, Spot instance
   - pi setup
      - 1:27 min
   - pi start Qwen/Qwen3-Coder-30B-A3B-Instruct
      - (cold start incl. HF download, kernel warmup) 7:32m
      - (warm start, HF model already in cache) 1:02m

- 8x H200 on DataCrunch, Spot instance
   - pi setup
      -2:04m
   - pi start Qwen/Qwen3-Coder-30B-A3B-Instruct
      - (cold start incl. HF download, kernel warmup) 9:30m
      - (warm start, HF model already in cache) 1:14m
   - pi start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 ...
      - (cold start incl. HF download, kernel warmup)
      - (warm start, HF model already in cache)