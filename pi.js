#!/usr/bin/env node
/**
 * pi CLI
 */

const fs = require('fs');
const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.pi_config');
const SCRIPT_DIR = __dirname;

class PiCli {
    constructor() {
        this.loadConfig();
    }

    loadConfig() {
        if (fs.existsSync(CONFIG_FILE)) {
            this.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            // Migrate old single-pod config
            if (this.config.ssh && !this.config.pods) {
                this.config = {
                    pods: { 'default': { ssh: this.config.ssh } },
                    active: 'default'
                };
                this.saveConfig();
            }
        } else {
            this.config = { pods: {}, active: null };
        }
    }

    saveConfig() {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2));
    }

    getActivePod() {
        if (!this.config.active || !this.config.pods[this.config.active]) {
            return null;
        }
        return this.config.pods[this.config.active];
    }

    ssh(command, interactive = false, skipPirc = false, podName = null) {
        const pod = podName ? this.config.pods[podName] : this.getActivePod();
        if (!pod) {
            if (podName) {
                console.error(`Pod '${podName}' not found`);
                console.error('Available pods:', Object.keys(this.config.pods || {}).join(', ') || 'none');
            } else {
                console.error('No active pod. Run: pi setup <pod-name> <ssh_command>');
                console.error('Example: pi setup prod "root@135.181.71.41 -p 22"');
                console.error('Or activate an existing pod: pi pod <pod-name>');
            }
            process.exit(1);
        }

        // Wrap command to source .pirc first (if it exists), unless skipPirc is true
        const finalCommand = skipPirc ? command : `[ -f ~/.pirc ] && source ~/.pirc; ${command}`;

        if (interactive) {
            // For interactive commands, use spawn with shell
            const sshParts = pod.ssh.split(' ');
            const sshCmd = ['ssh', ...sshParts, finalCommand];
            const proc = spawn(sshCmd[0], sshCmd.slice(1), { stdio: 'inherit', shell: false });
            return new Promise((resolve) => {
                proc.on('close', resolve);
            });
        } else {
            const sshCmd = `ssh ${pod.ssh} ${JSON.stringify(finalCommand)}`;

            // For non-interactive, use execSync
            try {
                return execSync(sshCmd, { encoding: 'utf8' });
            } catch (e) {
                if (e.status !== 0) {
                    console.error('SSH command failed:', e.message);
                    process.exit(1);
                }
                throw e;
            }
        }
    }

    scp(localFile, remotePath = '~/', podName = null) {
        const pod = podName ? this.config.pods[podName] : this.getActivePod();
        if (!pod) {
            if (podName) {
                console.error(`Pod '${podName}' not found`);
            } else {
                console.error('No active pod. Run: pi setup <pod-name> <ssh_command>');
            }
            process.exit(1);
        }

        const [userHost, ...sshArgs] = pod.ssh.split(' ');
        let scpCmd = `scp`;

        // Add port if specified
        const portArg = sshArgs.find(arg => arg === '-p');
        if (portArg) {
            const portIndex = sshArgs.indexOf(portArg);
            const port = sshArgs[portIndex + 1];
            scpCmd += ` -P ${port}`;
        }

        scpCmd += ` ${localFile} ${userHost}:${remotePath}`;

        try {
            execSync(scpCmd, { stdio: 'inherit' });
        } catch (e) {
            console.error('SCP failed:', e.message);
            process.exit(1);
        }
    }

    async setup(podName, sshCommand, modelsPath, mountCommand = null) {
        if (!podName || !sshCommand || !modelsPath) {
            console.error('\n❌ ERROR: Missing required parameters\n');
            console.error('Usage: pi setup <pod-name> <ssh_command> --models-path <path> [--mount <command>]');
            console.error('');
            console.error('The --models-path parameter is REQUIRED to specify where models will be stored.');
            console.error('This should be a persistent volume that survives pod restarts.\n');
            console.error('Common paths by provider:');
            console.error('  • RunPod:       --models-path /workspace          (pod-specific storage)');
            console.error('  • RunPod:       --models-path /runpod-volume      (network volume)');
            console.error('  • Vast.ai:      --models-path /workspace');
            console.error('  • DataCrunch:   --models-path /mnt/sfs            (use --mount, see below)');
            console.error('  • Lambda Labs:  --models-path /persistent');
            console.error('  • AWS:          --models-path /mnt/efs            (EFS mount)');
            console.error('  • Custom:       --models-path /your/mount/path\n');
            console.error('Examples:');
            console.error('  pi setup prod "root@135.181.71.41 -p 22" --models-path /workspace');
            console.error('  pi setup h200 "root@gpu.vast.ai -p 22" --models-path /workspace');
            console.error('  pi setup dev "ubuntu@ec2.aws.com" --models-path /mnt/efs\n');
            console.error('DataCrunch with NFS mount (copy mount command from DataCrunch dashboard):');
            console.error('  pi setup dc "ubuntu@server.dc.io" --models-path /mnt/sfs \\');
            console.error('    --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-01.datacrunch.io:/your-pseudo /mnt/sfs"\n');
            console.error('💡 TIP: Use network volumes when available for sharing models between pods');
            process.exit(1);
        }

        // Remove "ssh " prefix if present
        if (sshCommand.toLowerCase().startsWith('ssh ')) {
            sshCommand = sshCommand.substring(4);
        }

        // Save pod config
        if (!this.config.pods) {
            this.config.pods = {};
        }
        this.config.pods[podName] = { ssh: sshCommand };
        this.config.active = podName;
        this.saveConfig();
        console.log(`Saved pod '${podName}' with SSH: ${sshCommand}`);

        // Test connection
        console.log('\nTesting SSH connection...');
        try {
            const hostname = this.ssh('hostname', false, true).trim();
            console.log(`✓ Connected to ${hostname}`);
        } catch (e) {
            console.error('✗ SSH connection failed');
            process.exit(1);
        }

        // Execute mount command if provided
        if (mountCommand) {
            console.log('\nExecuting mount command...');
            try {
                // Create mount point directory first (extract from mount command if possible)
                const mountPointMatch = mountCommand.match(/\s+(\/\S+)\s*$/);
                if (mountPointMatch) {
                    const mountPoint = mountPointMatch[1];
                    console.log(`Creating mount point: ${mountPoint}`);
                    this.ssh(`sudo mkdir -p ${mountPoint}`, false, true);
                }
                
                // Execute the mount command
                console.log(`Running: ${mountCommand}`);
                const mountOutput = this.ssh(mountCommand, false, true);
                if (mountOutput) {
                    console.log(mountOutput);
                }
                
                // Verify mount succeeded
                console.log('Verifying mount...');
                const dfOutput = this.ssh(`df -h ${modelsPath}`, false, true);
                console.log(dfOutput);
                
                // Add to fstab if it's an NFS mount (for persistence)
                if (mountCommand.includes('nfs')) {
                    console.log('Adding NFS mount to /etc/fstab for persistence...');
                    const nfsMatch = mountCommand.match(/nfs[^:]*:([^\s]+)\s+([^\s]+)/);
                    if (nfsMatch) {
                        const nfsPath = nfsMatch[1];
                        const mountPoint = nfsMatch[2];
                        const nfsServer = mountCommand.match(/(nfs[^:]*)/)[1];
                        const fstabEntry = `${nfsServer}:${nfsPath} ${mountPoint} nfs defaults,nconnect=16 0 0`;
                        this.ssh(`grep -qxF '${fstabEntry}' /etc/fstab || echo '${fstabEntry}' | sudo tee -a /etc/fstab`, false, true);
                        console.log('✓ Added to /etc/fstab');
                    }
                }
                
                console.log('✓ Mount completed successfully');
            } catch (e) {
                console.error('⚠ Mount command failed:', e.message);
                console.error('Continuing with setup anyway - please verify the mount manually');
            }
        }

        // Copy setup files
        console.log('\nCopying setup files...');
        this.scp(path.join(SCRIPT_DIR, 'pod_setup.sh'));
        this.scp(path.join(SCRIPT_DIR, 'vllm_manager.py'));

        // Run setup with HF_TOKEN and optional models path
        console.log('\nRunning setup script...');
        const hfToken = process.env.HF_TOKEN;
        if (!hfToken) {
            console.error('\nERROR: HF_TOKEN environment variable not set');
            console.error('Please export HF_TOKEN before running setup');
            process.exit(1);
        }
        
        // Pass models path as environment variable
        const envVars = [`HF_TOKEN="${hfToken}"`, `MODELS_PATH="${modelsPath}"`];
        
        try {
            await this.ssh(`export ${envVars.join(' ')} && bash pod_setup.sh`, true, true);
            
            // Verify setup completed successfully by checking for vllm_env and psutil
            console.log('\nVerifying setup...');
            const verifyCmd = 'source ~/.pirc 2>/dev/null && python3 -c "import psutil, huggingface_hub, hf_transfer; print(\'✓ All required packages installed\')" 2>&1';
            const verifyResult = this.ssh(verifyCmd, false, true);
            
            if (verifyResult.includes('✓ All required packages installed')) {
                console.log(verifyResult.trim());
                console.log('\n✓ Setup complete!');
            } else {
                console.error('\n⚠ Setup may have failed. Verification output:');
                console.error(verifyResult);
                console.error('\nYou may need to run setup again or manually install missing packages.');
                console.error('To manually fix, run:');
                console.error(`  pi ssh h100-dc "source ~/.pirc && pip install psutil huggingface-hub hf_transfer"`);
            }
        } catch (e) {
            console.error('\n❌ Setup script failed!');
            console.error('Error:', e.message);
            console.error('\nCommon issues:');
            console.error('  • Missing dependencies (pkg-config, etc)');
            console.error('  • Python version incompatibility');
            console.error('  • Network issues downloading packages');
            console.error('\nTo debug, check the output above or run:');
            console.error(`  pi ssh ${podName || this.config.active} "tail -100 /tmp/setup.log"`);
            process.exit(1);
        }

        // Show usage help
        this.showHelp();
    }

    list(podName = null) {
        const output = this.ssh('python3 vllm_manager.py list', false, false, podName);
        console.log(output);
    }

    parseContextSize(value) {
        if (!value) return 8192;

        // Convert string to lowercase for case-insensitive matching
        const lower = value.toString().toLowerCase();

        // Handle 'k' suffix (4k, 8k, 32k, etc)
        if (lower.endsWith('k')) {
            return parseInt(lower.slice(0, -1)) * 1024;
        }

        // Handle plain numbers
        return parseInt(value);
    }

    parseMemory(value) {
        if (!value) return 0.9;

        const str = value.toString().toLowerCase();

        // Handle percentage (30%, 50%, etc)
        if (str.endsWith('%')) {
            return parseInt(str.slice(0, -1)) / 100;
        }

        // Handle decimal (0.3, 0.5, etc)
        const num = parseFloat(str);
        if (num > 1) {
            console.error('Memory must be between 0-1 or 0-100%');
            process.exit(1);
        }
        return num;
    }

    async handleStart(args) {
        if (!args[0]) {
            console.error('Usage: pi start <model> [options]');
            console.error('');
            console.error('Options:');
            console.error('  --name <name>      Model alias (default: auto-generated)');
            console.error('  --context <size>   Context window: 4k, 8k, 16k, 32k, 64k, 128k or 4096, 8192, etc (default: model default)');
            console.error('  --memory <percent> GPU memory: 30%, 50%, 90% or 0.3, 0.5, 0.9 (default: 90%)');
            console.error('  --all-gpus         Use all GPUs with tensor parallelism (ignores --memory)');
            console.error('  --debug            Enable debug logging for vLLM');
            console.error('  --pod <name>       Run on specific pod (default: active pod)');
            console.error('  --vllm-args        Pass remaining args directly to vLLM (ignores other options)');
            console.error('');
            console.error('Examples:');
            console.error('  pi start Qwen/Qwen2.5-7B-Instruct');
            console.error('  pi start Qwen/Qwen2.5-7B-Instruct --name qwen --memory 20%');
            console.error('  pi start meta-llama/Llama-3.1-70B-Instruct --all-gpus');
            console.error('  pi start meta-llama/Llama-3.1-405B --all-gpus --context 128k');
            console.error('');
            console.error('  # Custom vLLM args for Qwen3-Coder on 8xH200:');
            console.error('  pi start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen-coder --vllm-args \\\\');
            console.error('    --data-parallel-size 8 --enable-expert-parallel \\\\');
            console.error('    --tool-call-parser qwen3_coder --enable-auto-tool-choice --gpu-memory-utilization 0.95 --max-model-len 200000');
            process.exit(1);
        }

        const modelId = args[0];
        let name = null;
        let context = null;  // Changed to null - let vLLM use model default
        let memory = 0.9;
        let allGpus = false;
        let debug = false;
        let vllmArgs = null;
        let podName = null;

        // Check for --vllm-args first
        const vllmArgsIndex = args.indexOf('--vllm-args');
        if (vllmArgsIndex !== -1) {
            // Extract name and pod if provided before --vllm-args
            for (let i = 1; i < vllmArgsIndex; i++) {
                if (args[i] === '--name' && args[i + 1]) {
                    name = args[++i];
                } else if (args[i] === '--pod' && args[i + 1]) {
                    podName = args[++i];
                } else if (args[i] === '--debug') {
                    debug = true;
                }
            }
            // Everything after --vllm-args is passed to vLLM
            vllmArgs = args.slice(vllmArgsIndex + 1).join(' ');
        } else {
            // Parse normal arguments
            for (let i = 1; i < args.length; i++) {
                switch (args[i]) {
                    case '--name':
                        name = args[++i];
                        break;
                    case '--context':
                        context = this.parseContextSize(args[++i]);
                        break;
                    case '--memory':
                        memory = this.parseMemory(args[++i]);
                        break;
                    case '--all-gpus':
                        allGpus = true;
                        break;
                    case '--debug':
                        debug = true;
                        break;
                    case '--pod':
                        podName = args[++i];
                        break;
                    default:
                        console.error(`Unknown option: ${args[i]}`);
                        process.exit(1);
                }
            }
        }

        // Check for multi-GPU setup
        const gpuCount = await this.getGpuCount(podName);

        if (allGpus) {
            if (memory !== 0.9) {
                console.log('Warning: --memory ignored with --all-gpus (using 95% memory across all GPUs)');
            }
            memory = 0.95;

            if (gpuCount === 1) {
                console.log('Note: --all-gpus specified but only 1 GPU found');
                allGpus = false;
            }
        }

        // Auto-generate name if not provided
        if (!name) {
            // Extract model name from path (e.g., "Phi-3-mini" from "microsoft/Phi-3-mini-4k-instruct")
            const parts = modelId.split('/');
            const modelName = parts[parts.length - 1];
            name = modelName.toLowerCase()
                .replace(/-instruct$/, '')
                .replace(/-chat$/, '')
                .replace(/[^a-z0-9-]/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 20);
        }

        // If vllmArgs provided, skip memory check since we don't know the parallelism strategy
        if (vllmArgs) {
            const modelEstimate = await this.getModelMemoryEstimate(modelId, context);
            if (modelEstimate) {
                console.log(`Model weights: ${modelEstimate.modelSizeGB.toFixed(1)}GB`);
                console.log(`Context length: ${modelEstimate.contextLength.toLocaleString()} tokens`);
            }
            console.log(`Target pod: ${podName || this.config.active || 'active pod'}`);
            await this.startRaw(modelId, name, vllmArgs, debug, podName);
            return;
        }

        // For standard deployment, check memory
        const modelEstimate = await this.getModelMemoryEstimate(modelId, context);

        // Check GPU memory before starting
        console.log('Checking model size and GPU memory...');
        console.log(`Target pod: ${podName || this.config.active || 'active pod'}`);
        const [memoryInfo, modelEstimateWithContext] = await Promise.all([
            this.getGpuMemoryInfo(podName),
            modelEstimate
        ]);

        if (memoryInfo && modelEstimateWithContext) {
            // For tensor parallel (--all-gpus), memory is distributed across GPUs
            const effectiveMemoryNeeded = allGpus && gpuCount > 1
                ? modelEstimateWithContext.estimatedMemoryGB / gpuCount
                : modelEstimateWithContext.estimatedMemoryGB;

            const memoryPerGpu = memoryInfo.freeMemoryGB / (gpuCount || 1);

            console.log(`Model weights: ${modelEstimateWithContext.modelSizeGB.toFixed(1)}GB`);
            console.log(`Context length: ${modelEstimateWithContext.contextLength.toLocaleString()} tokens`);
            console.log(`Note: Estimate includes model parameters only, not KV cache for context`);
            console.log(`Available GPU memory: ${memoryInfo.freeMemoryGB.toFixed(1)}GB total (${memoryPerGpu.toFixed(1)}GB per GPU)`);

            if (effectiveMemoryNeeded > memoryPerGpu) {
                // Log a BIG WARNING as requested
                console.error(`\n❌ BIG WARNING: Insufficient GPU memory`);
                if (allGpus && gpuCount > 1) {
                    console.error(`   Model needs ~${effectiveMemoryNeeded.toFixed(1)}GB per GPU but only ${memoryPerGpu.toFixed(1)}GB available`);
                } else {
                    console.error(`   Model needs ~${modelEstimateWithContext.estimatedMemoryGB.toFixed(1)}GB but only ${memoryInfo.freeMemoryGB.toFixed(1)}GB available`);
                }
                console.error('\n   Free up memory by stopping running models:');
                console.error('   pi list               # See running models');
                console.error('   pi stop <model_name>  # Stop specific model');
                console.error('   pi stop               # Stop all models\n');
                // Don't exit, just warn and proceed
            }
        }

        // Call the original start method with positional args
        const contextStr = context ? context.toString() : null;
        await this.start(modelId, name, contextStr, memory.toString(), { allGpus, gpuCount, debug, podName });
    }

    async getGpuCount(podName = null) {
        try {
            const output = this.ssh('nvidia-smi --query-gpu=name --format=csv,noheader | wc -l', false, false, podName);
            return parseInt(output.trim()) || 1;
        } catch {
            return 1;
        }
    }

    async getGpuMemoryInfo(podName = null) {
        try {
            const output = this.ssh('nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits', false, false, podName);
            const lines = output.trim().split('\n');
            let totalMemoryGB = 0;
            let freeMemoryGB = 0;

            for (const line of lines) {
                const [total, free] = line.split(',').map(x => parseInt(x.trim()));
                totalMemoryGB += total / 1024;
                freeMemoryGB += free / 1024;
            }

            return { totalMemoryGB, freeMemoryGB };
        } catch (e) {
            return null;
        }
    }

    async getModelMemoryEstimate(modelId, contextLength = null) {
        try {
            const response = await fetch(`https://huggingface.co/api/models/${modelId}`);
            const data = await response.json();

            if (data.safetensors?.parameters) {
                // Calculate actual model size based on parameter counts and types
                const dtypeSizes = {
                    'F64': 8,      // float64 - 8 bytes
                    'F32': 4,      // float32 - 4 bytes
                    'BF16': 2,     // bfloat16 - 2 bytes
                    'F16': 2,      // float16 - 2 bytes
                    'I32': 4,      // int32 - 4 bytes
                    'I16': 2,      // int16 - 2 bytes
                    'I8': 1,       // int8 - 1 byte
                    'U8': 1,       // uint8 - 1 byte
                    'I4': 0.5,     // int4 - 0.5 bytes (packed)
                    'F8_E4M3': 1,  // FP8 E4M3 format - 1 byte
                    'F8_E5M2': 1,  // FP8 E5M2 format - 1 byte
                    'Q8_0': 1,     // GGML quantization formats
                    'Q4_0': 0.5,   // GGML quantization formats
                    'Q4_1': 0.5,   // GGML quantization formats
                    'Q5_0': 0.625, // GGML quantization formats
                    'Q5_1': 0.625  // GGML quantization formats
                };

                let totalBytes = 0;
                let paramDetails = [];

                // Calculate bytes for each dtype
                let unknownDtypes = [];
                for (const [dtype, paramCount] of Object.entries(data.safetensors.parameters)) {
                    let bytesPerParam = dtypeSizes[dtype];
                    if (bytesPerParam === undefined) {
                        // Unknown dtype - assume 1 byte (most new formats are quantized)
                        bytesPerParam = 1; // Conservative for memory checking
                        unknownDtypes.push(dtype);
                    }
                    const bytes = paramCount * bytesPerParam;
                    totalBytes += bytes;
                    paramDetails.push({ dtype, count: paramCount, bytes });
                }

                if (unknownDtypes.length > 0) {
                    console.warn(`Unknown dtype(s) found: ${unknownDtypes.join(', ')}. Assuming 1 byte per parameter.`);
                }

                const modelSizeGB = totalBytes / (1024 ** 3);

                // Try to get model config for context length
                let maxContextLength = contextLength;
                try {
                    const configResponse = await fetch(`https://huggingface.co/${modelId}/raw/main/config.json`);
                    if (configResponse.ok) {
                        const config = await configResponse.json();
                        maxContextLength = contextLength || config.max_position_embeddings || 8192;
                    }
                } catch (e) {
                    maxContextLength = contextLength || 8192;
                }

                return {
                    modelSizeGB,
                    estimatedMemoryGB: modelSizeGB, // Only model weights, not KV cache
                    contextLength: maxContextLength,
                    paramDetails // For debugging
                };
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    async start(modelId, name, maxLen = null, gpuMemory, options = {}) {
        // Check if name is already in use locally first
        if (name) {
            const runningModels = this.getRunningModels(options.podName);
            if (runningModels[name]) {
                console.error(`Error: Model name '${name}' is already in use`);
                console.error('Running models:', Object.keys(runningModels).join(', '));
                process.exit(1);
            }
        }

        // Memory check is already done in handleStart, skip it here

        // Build args for vllm_manager.py
        let args = modelId;

        // Handle optional parameters
        if (name || maxLen || gpuMemory) {
            args += ` ${name || '""'}`;

            if (maxLen || gpuMemory) {
                args += ` ${maxLen || '""'}`;  // Pass empty string to use vLLM default

                if (gpuMemory) {
                    args += ` ${gpuMemory}`;
                }
            }
        }

        // Handle multi-GPU options
        let envPrefix = '';
        if (options.allGpus && options.gpuCount > 1) {
            args += ` ${options.gpuCount}`; // Pass tensor parallel size
        }

        // Add debug logging if requested
        if (options.debug) {
            envPrefix = 'VLLM_LOGGING_LEVEL=DEBUG ';
        }

        const output = this.ssh(`${envPrefix}python3 vllm_manager.py start ${args}`, false, false, options.podName);

        // Extract model name and connection info from output
        const nameMatch = output.match(/Started (\S+)/);
        const urlMatch = output.match(/URL: (http:\/\/[^\s]+)/);
        const exportMatch = output.match(/export OPENAI_BASE_URL='([^']+)'/);

        if (nameMatch) {
            const modelName = nameMatch[1];
            const url = urlMatch ? urlMatch[1] : null;
            const exportCmd = exportMatch ? `export OPENAI_BASE_URL='${exportMatch[1]}'` : null;

            console.log(`\nStarted ${modelName}`);
            console.log('Waiting for model to initialize...\n');

            // Set up Ctrl+C handler for manual interruption
            const showModelInfo = () => {
                console.log('\n\n' + '='.repeat(60));
                console.log('Model Information:');
                console.log('='.repeat(60));
                console.log(`Name: ${modelName}`);
                if (url) console.log(`URL: ${url}`);
                if (exportCmd) {
                    console.log(`\nTo use with OpenAI clients:`);
                    console.log(exportCmd);
                    console.log(`export OPENAI_API_KEY='dummy'`);
                    console.log(`export OPENAI_MODEL='${modelId}'`);
                }
                console.log('='.repeat(60));
            };

            process.on('SIGINT', () => {
                showModelInfo();
                process.exit(0);
            });

            // Watch logs until startup complete
            await this.logs(modelName, true, options.podName);  // autoExit = true for startup

            // Warm up the model with a simple prompt
            console.log('\nWarming up model...');
            try {
                const warmupUrl = `${url}/chat/completions`;
                const warmupPayload = {
                    model: modelId,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 1,
                    temperature: 0
                };

                const warmupResponse = await fetch(warmupUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(warmupPayload)
                });

                if (warmupResponse.ok) {
                    console.log('✓ Model warmed up and ready!');
                } else {
                    console.log('⚠ Warmup failed, but model should still work');
                }
            } catch (e) {
                console.log('⚠ Could not warm up model:', e.message);
            }

            // Show model info after warmup
            showModelInfo();
        } else {
            console.log(output);
        }
    }

    async startRaw(modelId, name, vllmArgs, debug = false, podName = null) {
        // Skip memory check for raw vLLM args since we don't know what custom settings are used
        console.log('Note: Memory checking disabled when using --vllm-args');
        // Check if name is already in use
        const runningModels = this.getRunningModels(podName);
        if (runningModels[name]) {
            console.error(`Error: Model name '${name}' is already in use`);
            console.error('Running models:', Object.keys(runningModels).join(', '));
            process.exit(1);
        }

        console.log(`Starting ${name} with custom vLLM args on pod: ${podName || this.config.active || 'active pod'}`);

        // Start vLLM with raw arguments - use base64 to safely pass complex args
        const base64Args = Buffer.from(vllmArgs).toString('base64');
        const envPrefix = debug ? 'VLLM_LOGGING_LEVEL=DEBUG ' : '';
        const output = this.ssh(`${envPrefix}python3 vllm_manager.py start_raw "${modelId}" "${name}" "${base64Args}"`, false, false, podName);

        // Extract connection info from output
        const urlMatch = output.match(/URL: (http:\/\/[^\s]+)/);
        const exportMatch = output.match(/export OPENAI_BASE_URL='([^']+)'/);

        if (urlMatch || exportMatch) {
            const url = urlMatch ? urlMatch[1] : null;
            const exportCmd = exportMatch ? `export OPENAI_BASE_URL='${exportMatch[1]}'` : null;

            console.log(`\nStarted ${name}`);
            console.log('Waiting for model to initialize...\n');

            // Set up Ctrl+C handler for manual interruption
            const showModelInfo = () => {
                console.log('\n\n' + '='.repeat(60));
                console.log('Model Information:');
                console.log('='.repeat(60));
                console.log(`Name: ${name}`);
                if (url) console.log(`URL: ${url}`);
                if (exportCmd) {
                    console.log(`\nTo use with OpenAI clients:`);
                    console.log(exportCmd);
                    console.log(`export OPENAI_API_KEY='dummy'`);
                    console.log(`export OPENAI_MODEL='${modelId}'`);
                }
                console.log('='.repeat(60));
            };

            process.on('SIGINT', () => {
                showModelInfo();
                process.exit(0);
            });

            // Watch logs until startup complete
            await this.logs(name, true, podName);  // autoExit = true for startup

            // Warm up the model with a simple prompt
            console.log('\nWarming up model...');
            try {
                const warmupUrl = `${url}/chat/completions`;
                const warmupPayload = {
                    model: modelId,
                    messages: [{ role: 'user', content: 'Hi' }],
                    max_tokens: 1,
                    temperature: 0
                };

                const warmupResponse = await fetch(warmupUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(warmupPayload)
                });

                if (warmupResponse.ok) {
                    console.log('✓ Model warmed up and ready!');
                } else {
                    console.log('⚠ Warmup failed, but model should still work');
                }
            } catch (e) {
                console.log('⚠ Could not warm up model:', e.message);
            }

            // Show model info after warmup
            showModelInfo();
        } else {
            console.log(output);
        }
    }

    stop(name, podName = null) {
        if (!name) {
            // Stop all models
            const runningModels = this.getRunningModels(podName);
            const modelNames = Object.keys(runningModels);

            if (modelNames.length === 0) {
                console.log('No models running');
                // Still clean up any hanging vLLM processes
                console.log('Cleaning up any remaining vLLM processes...');
                this.ssh("ps aux | grep -E 'python.*vllm' | grep -v grep | grep -v vllm_manager.py | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true", false, false, podName);
                return;
            }

            console.log(`Stopping ${modelNames.length} model(s): ${modelNames.join(', ')}`);

            for (const modelName of modelNames) {
                const output = this.ssh(`python3 vllm_manager.py stop ${modelName}`, false, false, podName);
                console.log(output);
            }
            
            // Final cleanup of vLLM processes after stopping all models
            console.log('Ensuring all vLLM processes are terminated...');
            this.ssh("ps aux | grep -E 'python.*vllm' | grep -v grep | grep -v vllm_manager.py | awk '{print $2}' | xargs -r kill -9 2>/dev/null || true", false, false, podName);
        } else {
            // Stop specific model
            const output = this.ssh(`python3 vllm_manager.py stop ${name}`, false, false, podName);
            console.log(output);
        }
    }

    async logs(name, autoExit = false, podName = null) {
        if (!name) {
            console.error('Usage: pi logs <name>');
            process.exit(1);
        }

        // Use vllm_manager.py to get the log file path
        const infoOutput = this.ssh(`python3 vllm_manager.py list`, false, false, podName);

        // Extract log file path from the output
        const lines = infoOutput.split('\n');
        let logFile = null;
        let inModel = false;

        for (const line of lines) {
            if (line.startsWith(`${name}:`)) {
                inModel = true;
            } else if (inModel && line.includes('Logs:')) {
                logFile = line.split('Logs:')[1].trim();
                break;
            }
        }

        if (!logFile) {
            console.error(`No logs found for ${name}`);
            process.exit(1);
        }

        // Use a custom tail that watches for startup complete
        const pod = podName ? this.config.pods[podName] : this.getActivePod();
        // Add SSH options to prevent connection issues
        const sshOpts = '-o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o TCPKeepAlive=yes';
        const sshCmd = `ssh ${sshOpts} ${pod.ssh} tail -n 50 -f ${logFile}`;

        return new Promise((resolve) => {
            const [cmd, ...args] = sshCmd.split(' ');
            const proc = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'] });

            let buffer = '';

            proc.stdout.on('data', (data) => {
                process.stdout.write(data);
                buffer += data.toString();

                // Only check for startup messages if autoExit is enabled
                if (autoExit) {
                    if (buffer.includes('Application startup complete.') ||
                        buffer.includes('Uvicorn running on')) {
                        setTimeout(() => {
                            proc.kill();
                            resolve();
                        }, 500); // Small delay to ensure final messages are shown
                    }
                }

                // Keep buffer size manageable
                if (buffer.length > 10000) {
                    buffer = buffer.slice(-5000);
                }
            });

            proc.stderr.on('data', (data) => {
                process.stderr.write(data);
            });

            proc.on('close', () => {
                resolve();
            });
        });
    }

    async shell(podName = null) {
        const pod = podName ? this.config.pods[podName] : this.getActivePod();
        if (!pod) {
            if (podName) {
                console.error(`Pod '${podName}' not found`);
                console.error('Available pods:', Object.keys(this.config.pods || {}).join(', ') || 'none');
            } else {
                console.error('No active pod. Run: pi setup <pod-name> <ssh_command>');
            }
            process.exit(1);
        }

        console.log(`Connecting to pod${podName ? ` '${podName}'` : ''}...`);

        // Use spawn directly for interactive shell
        const sshParts = pod.ssh.split(' ');
        const sshCmd = ['ssh', ...sshParts];
        const proc = spawn(sshCmd[0], sshCmd.slice(1), { stdio: 'inherit' });

        return new Promise((resolve) => {
            proc.on('close', resolve);
        });
    }

    listPods() {
        if (!this.config.pods || Object.keys(this.config.pods).length === 0) {
            console.log('No pods configured. Run: pi setup <pod-name> <ssh_command>');
            return;
        }

        console.log('Configured pods:\n');

        // Show active pod first
        if (this.config.active && this.config.pods[this.config.active]) {
            console.log(`● ${this.config.active} (active)`);
            console.log(`  ${this.config.pods[this.config.active].ssh}\n`);
        }

        // Show other pods
        Object.keys(this.config.pods).sort().forEach(name => {
            if (name !== this.config.active) {
                console.log(`○ ${name}`);
                console.log(`  ${this.config.pods[name].ssh}`);
            }
        });
    }

    switchPod(podName) {
        if (!this.config.pods || !this.config.pods[podName]) {
            console.error(`Pod '${podName}' not found`);
            console.error('Available pods:', Object.keys(this.config.pods || {}).join(', ') || 'none');
            process.exit(1);
        }

        this.config.active = podName;
        this.saveConfig();
        console.log(`Switched to pod: ${podName} (${this.config.pods[podName].ssh})`);
    }

    removePod(podName) {
        if (!this.config.pods || !this.config.pods[podName]) {
            console.error(`Pod '${podName}' not found`);
            console.error('Available pods:', Object.keys(this.config.pods || {}).join(', ') || 'none');
            process.exit(1);
        }

        delete this.config.pods[podName];

        // If we removed the active pod, clear it or switch to another
        if (this.config.active === podName) {
            const remainingPods = Object.keys(this.config.pods);
            this.config.active = remainingPods.length > 0 ? remainingPods[0] : null;
        }

        this.saveConfig();
        console.log(`Removed pod: ${podName}`);
        if (this.config.active) {
            console.log(`Active pod is now: ${this.config.active}`);
        }
    }

    async searchModels(query) {
        console.log(`Searching HuggingFace for models matching "${query}"...\n`);

        try {
            const response = await fetch(`https://huggingface.co/api/models?search=${query}&filter=text-generation&sort=downloads&limit=20`);
            const data = await response.json();

            if (!data || data.length === 0) {
                console.log('No models found');
                return;
            }

            // Format results
            console.log('Popular models (sorted by downloads):\n');
            for (const model of data) {
                const modelName = model.modelId.toLowerCase();

                // Skip incompatible formats
                if (modelName.includes('-mlx-') || modelName.includes('-mlx')) {
                    continue; // MLX is for Apple Silicon only
                }
                if (modelName.includes('-gguf') || modelName.includes('.gguf')) {
                    continue; // GGUF is for llama.cpp, not vLLM
                }

                const downloads = model.downloads || 0;
                const likes = model.likes || 0;

                console.log(`\x1b[1m${model.modelId}\x1b[0m`); // Bold
                console.log(`  \x1b[36mhttps://huggingface.co/${model.modelId}\x1b[0m`); // Cyan for URL
                console.log(`  Downloads: ${downloads.toLocaleString()} | Likes: ${likes}`);

                // Check for quantization
                if (modelName.includes('-fp8') || modelName.includes('fp8-')) {
                    console.log(`  \x1b[33mNote: FP8 quantized - requires GPU with FP8 support\x1b[0m`);
                }

                console.log(`  pi start ${model.modelId}`);
                console.log();
            }

            // Add HuggingFace search URL
            console.log(`\nView more models on HuggingFace:`);
            console.log(`\x1b[36mhttps://huggingface.co/models?search=${encodeURIComponent(query)}&sort=downloads&pipeline_tag=text-generation\x1b[0m`);
        } catch (error) {
            console.error('Error searching models:', error.message);
        }
    }

    async checkDownloads(podName = null, live = false) {
        // Check only active pod or specified pod
        const targetPod = podName || this.config.active;
        if (!targetPod || !this.config.pods[targetPod]) {
            console.error('No active pod. Run: pi setup <pod-name> <ssh_command>');
            process.exit(1);
        }

        if (!live) {
            // Single check mode
            console.log(`Checking model downloads on pod: ${targetPod}\n`);
            const output = this.ssh('python3 vllm_manager.py downloads', false, false, targetPod);
            
            if (output.includes('No HuggingFace cache found') || output.includes('No models in cache')) {
                console.log(output);
                return;
            }
            
            // Parse and display
            const downloadInfo = JSON.parse(output);
            this._displayDownloadInfo(downloadInfo);
        } else {
            // Live streaming mode
            const pod = this.config.pods[targetPod];
            // Build SSH command with proper shell invocation
            const sshParts = pod.ssh.split(' ');
            const remoteCmd = 'source .pirc && python3 vllm_manager.py downloads --stream';
            
            return new Promise((resolve) => {
                const proc = spawn('ssh', [...sshParts, remoteCmd], { stdio: ['inherit', 'pipe', 'pipe'] });
                
                let buffer = '';
                
                // Handle Ctrl+C gracefully
                process.on('SIGINT', () => {
                    console.log('\n\nStopping download monitor...');
                    proc.kill('SIGTERM');  // Send SIGTERM to remote process
                    setTimeout(() => {
                        proc.kill('SIGKILL');  // Force kill if not terminated
                        process.exit(0);
                    }, 1000);
                });
                
                // Print header once
                console.log(`Monitoring model downloads on pod: ${targetPod} (Press Ctrl+C to stop)`);
                console.log(); // Empty line after header
                
                // Hide cursor
                process.stdout.write('\x1B[?25l');
                
                // Ensure cursor is shown again on exit
                const cleanup = () => {
                    process.stdout.write('\x1B[?25h');
                };
                process.on('exit', cleanup);
                process.on('SIGINT', cleanup);
                
                let previousLineCount = 0;
                
                proc.stdout.on('data', (data) => {
                    buffer += data.toString();
                    
                    // Process complete lines
                    const lines = buffer.split('\n');
                    buffer = lines[lines.length - 1];  // Keep incomplete line in buffer
                    
                    for (let i = 0; i < lines.length - 1; i++) {
                        const line = lines[i].trim();
                        if (line) {
                            try {
                                const downloadInfo = JSON.parse(line);
                                
                                // If we printed lines before, move cursor back up
                                if (previousLineCount > 0) {
                                    process.stdout.write(`\x1B[${previousLineCount}A`); // Move up N lines
                                    process.stdout.write('\x1B[0J'); // Clear from cursor to end of screen
                                }
                                
                                // Build all output as a single string
                                let output = '';
                                const addLine = (text = '') => {
                                    output += text + '\n';
                                };
                                
                                if (downloadInfo.status === 'NO_CACHE' || downloadInfo.status === 'NO_MODELS') {
                                    addLine(downloadInfo.message);
                                } else {
                                    // Build the display output
                                    for (const model of downloadInfo.models) {
                                        addLine(`Model: ${model.model}`);
                                        addLine(`  Size: ${model.size_gb}GB`);
                                        
                                        if (model.total_files > 0) {
                                            const percentage = Math.round((model.files / model.total_files) * 100);
                                            addLine(`  Files: ${model.files}/${model.total_files} (${percentage}%)`);
                                            
                                            // Show progress bar
                                            const barLength = 30;
                                            const filled = Math.round((percentage / 100) * barLength);
                                            const empty = barLength - filled;
                                            const progressBar = '█'.repeat(filled) + '░'.repeat(empty);
                                            addLine(`  Progress: [${progressBar}] ${percentage}%`);
                                        } else {
                                            addLine(`  Files: ${model.files}`);
                                        }
                                        
                                        addLine(`  Status: ${model.active ? '⏬ Downloading' : '⏸ Idle'}`);
                                        addLine(); // Empty line between models
                                    }
                                    
                                    if (downloadInfo.vllm_processes > 0) {
                                        addLine(`Active vLLM processes: ${downloadInfo.vllm_processes}`);
                                    }
                                    
                                    addLine();
                                    addLine(`Last updated: ${new Date().toLocaleTimeString()}`);
                                }
                                
                                // Write all output at once and count lines
                                process.stdout.write(output);
                                previousLineCount = (output.match(/\n/g) || []).length;
                                
                            } catch (e) {
                                // Not JSON, just display as is
                                console.log(line);
                            }
                        }
                    }
                });
                
                proc.stderr.on('data', (data) => {
                    process.stderr.write(data);
                });
                
                proc.on('close', () => {
                    cleanup(); // Restore cursor
                    resolve();
                });
            });
        }
    }
    
    _displayDownloadInfo(downloadInfo) {
        for (const model of downloadInfo.models) {
            console.log(`\nModel: ${model.model}`);
            console.log(`  Size: ${model.size_gb}GB`);
            
            if (model.total_files > 0) {
                const percentage = Math.round((model.files / model.total_files) * 100);
                console.log(`  Files: ${model.files}/${model.total_files} (${percentage}%)`);
                
                // Show progress bar
                const barLength = 30;
                const filled = Math.round((percentage / 100) * barLength);
                const empty = barLength - filled;
                const progressBar = '█'.repeat(filled) + '░'.repeat(empty);
                console.log(`  Progress: [${progressBar}] ${percentage}%`);
            } else {
                console.log(`  Files: ${model.files}`);
            }
            
            console.log(`  Status: ${model.active ? '⏬ Downloading' : '⏸ Idle'}`);
        }
        
        if (downloadInfo.vllm_processes > 0) {
            console.log(`\nActive vLLM processes: ${downloadInfo.vllm_processes}`);
        }
        
        // Show timestamp
        console.log(`\nLast updated: ${new Date().toLocaleTimeString()}`);
    }

    async prompt(name, message, podName = null) {
        // Get model info
        const models = this.getRunningModels(podName);
        const model = models[name];

        if (!model || !model.url) {
            console.error(`Model '${name}' is not running${podName ? ` on pod '${podName}'` : ''}`);
            console.error('Running models:', Object.keys(models).join(', ') || 'none');
            process.exit(1);
        }

        // Make API call directly to the model's external URL
        const url = `${model.url}/chat/completions`;
        const payload = {
            model: model.model_id,
            messages: [{ role: 'user', content: message }],
            max_tokens: 500,
            temperature: 0.7
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json();
            console.log(data.choices[0].message.content);
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    }

    showHelp() {
        console.log('\npi CLI\n');

        console.log('Pod Management:');
        console.log('  pi setup <pod-name> <ssh_command> --models-path <path> [--mount <command>]');
        console.log('                                      Configure and activate a pod');
        console.log('                                      --models-path: REQUIRED persistent storage path');
        console.log('                                      --mount: Optional mount command (for NFS, etc)');
        console.log('  pi pods                            List all pods (active pod marked)');
        console.log('  pi pod <pod-name>                  Switch active pod');
        console.log('  pi pod remove <pod-name>           Remove pod from config\n');
        console.log('Model Management:');
        console.log('  pi list [--pod <pod-name>]        List running models');
        console.log('  pi search <query>                  Search HuggingFace models');
        console.log('  pi start <model> [options]         Start a model');
        console.log('  pi stop [name] [--pod <pod-name>] Stop a model (or all if no name)');
        console.log('  pi logs <name> [--pod <pod-name>] View model logs');
        console.log('  pi prompt <name> <msg> [--pod <pod-name>] Chat with a model');
        console.log('  pi downloads [--pod <pod-name>] [--live]   Check model download progress (--live for continuous monitoring)\n');
        console.log('Start Options:');
        console.log('  --name <name>      Model alias (default: auto-generated)');
        console.log('  --context <size>   Context window: 4k, 8k, 16k, 32k, 64k, 128k (default: model default)');
        console.log('  --memory <percent> GPU memory: 30%, 50%, 90% (default: 90%)');
        console.log('  --all-gpus         Use all GPUs with tensor parallelism');
        console.log('  --pod <pod-name>   Run on specific pod without switching active pod');
        console.log('  --debug            Enable debug logging for vLLM');
        console.log('  --vllm-args        Pass remaining args directly to vLLM\n');
        console.log('Utility:');
        console.log('  pi shell [--pod <pod-name>]        SSH into pod');
        console.log('  pi ssh [--pod <pod-name>] <cmd>    Run SSH command on pod');

        console.log('\nQuick Examples:');
        console.log('  pi start Qwen/Qwen2.5-7B-Instruct --name qwen');
        console.log('  pi prompt qwen "What is 2+2?"');
        console.log('\n  # Qwen3-Coder on 8xH200 with custom vLLM args:');
        console.log('  pi start Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8 --name qwen-coder --vllm-args \\');
        console.log('    --data-parallel-size 8 --enable-expert-parallel \\');
        console.log('    --tool-call-parser qwen3_coder --enable-auto-tool-choice --gpu-memory-utilization 0.95 --max-model-len 200000');

        if (this.config.active && this.config.pods[this.config.active]) {
            console.log(`\nActive pod: ${this.config.active} (${this.config.pods[this.config.active].ssh})`);
        } else {
            console.log('\nNo active pod');
        }
    }

    getRunningModels(podName = null) {
        try {
            const output = this.ssh('python3 vllm_manager.py list', false, false, podName);
            const models = {};

            // Parse the output to extract model info
            const lines = output.split('\n');
            let currentModel = null;

            for (const line of lines) {
                if (line.match(/^[a-zA-Z0-9_-]+:$/)) {
                    currentModel = line.slice(0, -1);
                    models[currentModel] = {};
                } else if (currentModel) {
                    if (line.includes('Model:')) {
                        models[currentModel].model_id = line.split('Model:')[1].trim();
                    } else if (line.includes('Port:')) {
                        models[currentModel].port = parseInt(line.split('Port:')[1].trim());
                    } else if (line.includes('URL:')) {
                        models[currentModel].url = line.split('URL:')[1].trim();
                    }
                }
            }

            return models;
        } catch (e) {
            return {};
        }
    }

    async run() {
        const [,, command, ...args] = process.argv;

        // Handle --version flag
        if (command === '--version' || command === '-v') {
            const packageJsonPath = path.join(__dirname, 'package.json');
            try {
                const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                console.log(packageJson.version);
            } catch (error) {
                console.error('Error reading version:', error.message);
                process.exit(1);
            }
            return;
        }

        switch (command) {
            case 'setup': {
                if (args.length < 4) {
                    console.error('\n❌ ERROR: Missing required parameters\n');
                    console.error('Usage: pi setup <pod-name> <ssh_command> --models-path <path> [--mount <command>]');
                    console.error('');
                    console.error('The --models-path parameter is REQUIRED.');
                    console.error('See common paths: pi setup (without arguments)\n');
                    process.exit(1);
                }
                const podName = args[0];
                
                // Check for --models-path flag (now required)
                // Also check for common typo --model-path (without 's')
                let modelsPathIndex = args.indexOf('--models-path');
                if (modelsPathIndex === -1) {
                    // Check for common typo
                    const typoIndex = args.indexOf('--model-path');
                    if (typoIndex !== -1) {
                        console.error('\n❌ ERROR: You typed "--model-path" but the correct parameter is "--models-path" (with an "s")\n');
                        process.exit(1);
                    }
                }
                
                if (modelsPathIndex === -1 || !args[modelsPathIndex + 1]) {
                    console.error('\n❌ ERROR: --models-path is required\n');
                    console.error('Usage: pi setup <pod-name> <ssh_command> --models-path <path> [--mount <command>]');
                    console.error('');
                    console.error('Common paths by provider:');
                    console.error('  • RunPod:       --models-path /workspace');
                    console.error('  • Vast.ai:      --models-path /workspace');
                    console.error('  • DataCrunch:   --models-path /mnt/sfs  (use --mount with NFS command)');
                    console.error('  • Lambda Labs:  --models-path /persistent');
                    console.error('  • AWS EFS:      --models-path /mnt/efs\n');
                    console.error('DataCrunch example with NFS mount:');
                    console.error('  pi setup dc "ubuntu@server.dc.io" --models-path /mnt/sfs \\');
                    console.error('    --mount "sudo mount -t nfs -o nconnect=16 nfs.fin-01.datacrunch.io:/pseudo /mnt/sfs"\n');
                    process.exit(1);
                }
                
                const modelsPath = args[modelsPathIndex + 1];
                
                // Check for optional --mount flag
                let mountCommand = null;
                const mountIndex = args.indexOf('--mount');
                if (mountIndex !== -1 && args[mountIndex + 1]) {
                    mountCommand = args[mountIndex + 1];
                }
                
                // Build SSH command (remove flags from args)
                let sshArgs = args.slice(1);
                
                // Remove --models-path and its value
                const mpIndex = sshArgs.indexOf('--models-path');
                if (mpIndex !== -1) {
                    sshArgs.splice(mpIndex, 2);
                }
                
                // Remove --mount and its value
                const mIndex = sshArgs.indexOf('--mount');
                if (mIndex !== -1) {
                    sshArgs.splice(mIndex, 2);
                }
                
                const sshCmd = sshArgs.join(' ');
                this.setup(podName, sshCmd, modelsPath, mountCommand);
                break;
            }
            case 'pods':
                this.listPods();
                break;

            case 'pod':
                if (!args[0]) {
                    console.error('Usage: pi pod <pod-name>');
                    console.error('       pi pod remove <pod-name>');
                    process.exit(1);
                }
                if (args[0] === 'remove' && args[1]) {
                    this.removePod(args[1]);
                } else {
                    this.switchPod(args[0]);
                }
                break;

            case 'list':
            case 'ls': {
                let podName = null;

                // Parse --pod parameter
                const podIndex = args.indexOf('--pod');
                if (podIndex !== -1 && args[podIndex + 1]) {
                    podName = args[podIndex + 1];
                }

                this.list(podName);
                break;
            }

            case 'search':
                if (!args[0]) {
                    console.error('Usage: pi search <query>');
                    console.error('Example: pi search qwen');
                    process.exit(1);
                }
                await this.searchModels(args[0]);
                break;

            case 'downloads': {
                let podName = null;
                let live = false;
                
                // Parse --pod parameter
                const podIndex = args.indexOf('--pod');
                if (podIndex !== -1 && args[podIndex + 1]) {
                    podName = args[podIndex + 1];
                }
                
                // Parse --live parameter
                if (args.includes('--live')) {
                    live = true;
                }
                
                await this.checkDownloads(podName, live);
                break;
            }

            case 'start':
                await this.handleStart(args);
                break;

            case 'stop': {
                let modelName = args[0];
                let podName = null;

                // Parse --pod parameter
                const podIndex = args.indexOf('--pod');
                if (podIndex !== -1 && args[podIndex + 1]) {
                    podName = args[podIndex + 1];
                    // Remove --pod and its value from args
                    args.splice(podIndex, 2);
                    modelName = args[0]; // Update modelName after removing --pod
                }

                this.stop(modelName, podName);
                break;
            }

            case 'logs': {
                let modelName = args[0];
                let podName = null;

                // Parse --pod parameter
                const podIndex = args.indexOf('--pod');
                if (podIndex !== -1 && args[podIndex + 1]) {
                    podName = args[podIndex + 1];
                    // Remove --pod and its value from args
                    args.splice(podIndex, 2);
                    modelName = args[0]; // Update modelName after removing --pod
                }

                await this.logs(modelName, false, podName);  // autoExit = false for manual logs command
                break;
            }

            case 'prompt': {
                if (args.length < 2) {
                    console.error('Usage: pi prompt <model_name> "<message>" [--pod <pod-name>]');
                    console.error('Example: pi prompt phi3 "Hey, how you going"');
                    process.exit(1);
                }
                let modelName = args[0];
                let podName = null;

                // Parse --pod parameter
                const podIndex = args.indexOf('--pod');
                if (podIndex !== -1 && args[podIndex + 1]) {
                    podName = args[podIndex + 1];
                    // Remove --pod and its value from args
                    args.splice(podIndex, 2);
                }

                const message = args.slice(1).join(' ');
                this.prompt(modelName, message, podName);
                break;
            }
            case 'shell': {
                let podName = null;

                // Parse --pod parameter
                const podIndex = args.indexOf('--pod');
                if (podIndex !== -1 && args[podIndex + 1]) {
                    podName = args[podIndex + 1];
                }

                await this.shell(podName);
                break;
            }

            case 'ssh': {
                let podName = null;
                let sshArgs = [...args];

                // For ssh, --pod must be the first parameter if present
                if (args[0] === '--pod' && args[1]) {
                    podName = args[1];
                    sshArgs = args.slice(2); // Remove --pod and podName from args
                }

                // Pass through any SSH command
                if (sshArgs.length > 0) {
                    const output = this.ssh(sshArgs.join(' '), false, false, podName);
                    console.log(output);
                } else {
                    await this.shell(podName);
                }
                break;
            }

            default:
                this.showHelp();
        }
    }
}

// Run CLI
const cli = new PiCli();
cli.run().catch(console.error);