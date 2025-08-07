import chalk from "chalk";
import { spawn } from "child_process";
import { getActivePod, loadConfig, saveConfig } from "../config.js";
import { sshExec, sshExecStream } from "../ssh.js";
import type { Model, Pod } from "../types.js";
import { getModelConfig, isKnownModel, getModelName } from "../model-configs.js";

/**
 * Get the pod to use (active or override)
 */
const getPod = (podOverride?: string): { name: string; pod: Pod } => {
	if (podOverride) {
		const config = loadConfig();
		const pod = config.pods[podOverride];
		if (!pod) {
			console.error(chalk.red(`Pod '${podOverride}' not found`));
			process.exit(1);
		}
		return { name: podOverride, pod };
	}

	const active = getActivePod();
	if (!active) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}
	return active;
};

/**
 * Find next available port starting from 8001
 */
const getNextPort = (pod: Pod): number => {
	const usedPorts = Object.values(pod.models).map((m) => m.port);
	let port = 8001;
	while (usedPorts.includes(port)) {
		port++;
	}
	return port;
};

/**
 * Select GPUs for model deployment (round-robin)
 */
const selectGPUs = (pod: Pod, count: number = 1): number[] => {
	if (count === pod.gpus.length) {
		// Use all GPUs
		return pod.gpus.map((g) => g.id);
	}

	// Count GPU usage across all models
	const gpuUsage = new Map<number, number>();
	for (const gpu of pod.gpus) {
		gpuUsage.set(gpu.id, 0);
	}

	for (const model of Object.values(pod.models)) {
		for (const gpuId of model.gpu) {
			gpuUsage.set(gpuId, (gpuUsage.get(gpuId) || 0) + 1);
		}
	}

	// Sort GPUs by usage (least used first)
	const sortedGPUs = Array.from(gpuUsage.entries())
		.sort((a, b) => a[1] - b[1])
		.map((entry) => entry[0]);

	// Return the least used GPUs
	return sortedGPUs.slice(0, count);
};

/**
 * Start a model
 */
export const startModel = async (
	modelId: string,
	name: string,
	options: {
		pod?: string;
		vllmArgs?: string[];
		memory?: string;
		context?: string;
	}
) => {
	const { name: podName, pod } = getPod(options.pod);

	if (!pod.modelsPath) {
		console.error(chalk.red("Pod does not have a models path configured"));
		process.exit(1);
	}

	// Check if name already exists
	if (pod.models[name]) {
		console.error(chalk.red(`Model '${name}' already exists on pod '${podName}'`));
		process.exit(1);
	}

	const port = getNextPort(pod);
	
	// Get default configuration for known models
	const isKnown = isKnownModel(modelId);
	let modelConfig = null;
	let gpus: number[] = [];

	// User provided custom --vllm args, takes precedence
	if (options.vllmArgs && options.vllmArgs.length > 0) {
		if (isKnown) {
			console.log(chalk.yellow("Warning: Using custom --vllm args, ignoring known model configuration"));
		}
		
		// We don't know which GPUs will be used, mark as unknown
		gpus = [];
		console.log(chalk.gray("Using custom vLLM args, GPU allocation managed by vLLM"));
		
	} else if (isKnown) {
		// Known model, use our configuration
		// Try to find a config that matches our hardware
		// Start with all GPUs, then try fewer
		for (let gpuCount = pod.gpus.length; gpuCount >= 1; gpuCount--) {
			modelConfig = getModelConfig(modelId, pod.gpus, gpuCount);
			if (modelConfig) {
				gpus = selectGPUs(pod, gpuCount);
				break;
			}
		}
		
		if (!modelConfig) {
			console.error(chalk.red(`Model '${getModelName(modelId)}' requires specific GPU configuration not available on this pod`));
			console.error(`Available: ${pod.gpus.length}x ${pod.gpus[0]?.name || "Unknown GPU"}`);
			console.error(`Check docs/models.md for hardware requirements`);
			process.exit(1);
		}
	} else {
		// Unknown model, default to single GPU
		gpus = selectGPUs(pod, 1);
		console.log(chalk.gray("Unknown model, defaulting to single GPU"));
	}

	console.log(chalk.green(`Starting model '${name}' on pod '${podName}'...`));
	console.log(`Model: ${modelId}`);
	if (isKnown && !options.vllmArgs) {
		console.log(chalk.gray(`(Known model: ${getModelName(modelId)})`));
	}
	console.log(`Port: ${port}`);
	
	// Show GPU allocation info
	if (gpus.length === 0) {
		console.log(`GPU(s): Managed by vLLM (custom args)`);
	} else if (gpus.length === 1) {
		console.log(`GPU: ${gpus[0]}`);
	} else {
		console.log(`GPUs: ${gpus.join(", ")}`);
	}
	
	if (modelConfig?.notes) {
		console.log(chalk.yellow(`Note: ${modelConfig.notes}`));
	}
	console.log("");

	// Download model (HF will skip if already cached)
	console.log("Downloading model (will skip if cached)...");
	const downloadCmd = `source /root/venv/bin/activate && HF_TOKEN='${process.env.HF_TOKEN}' HF_HUB_ENABLE_HF_TRANSFER=1 hf download '${modelId}'`;
	
	// Spawn download process directly so we can kill it on Ctrl+C
	const downloadSshArgs = pod.ssh.split(" ").slice(1); // Remove 'ssh' from command
	downloadSshArgs.push("-t"); // Force TTY for colored progress
	downloadSshArgs.push("-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120"); // Keepalive
	downloadSshArgs.push(downloadCmd);
	
	const downloadProcess = spawn("ssh", downloadSshArgs, { stdio: "inherit" });
	
	// Handle Ctrl+C during download
	let downloadInterrupted = false;
	const downloadCleanup = () => {
		if (!downloadInterrupted) {
			downloadInterrupted = true;
			downloadProcess.kill("SIGINT"); // Send SIGINT to SSH process
			console.log(chalk.yellow("\n\nDownload interrupted by user"));
			process.exit(1);
		}
	};
	
	process.on("SIGINT", downloadCleanup);
	
	// Wait for download to complete
	const downloadExit = await new Promise<number>((resolve) => {
		downloadProcess.on("close", (code) => resolve(code || 0));
		downloadProcess.on("error", () => resolve(1));
	});
	
	// Remove the signal handler after download completes
	process.removeListener("SIGINT", downloadCleanup);
	
	if (downloadExit !== 0) {
		console.error(chalk.red("Failed to download model"));
		process.exit(1);
	}

	// Build vLLM command
	let vllmCmd = `vllm serve '${modelId}' --port ${port} --api-key '${process.env.VLLM_API_KEY}'`;

	if (options.vllmArgs && options.vllmArgs.length > 0) {
		// User provided custom args, use only those
		vllmCmd += " " + options.vllmArgs.join(" ");
		if (options.memory || options.context) {
			console.log(chalk.yellow("Warning: --memory and --context are ignored when using --vllm args"));
		}
	} else if (modelConfig?.args) {
		// Use known model configuration
		vllmCmd += " " + modelConfig.args.join(" ");
		
		// Allow memory override for known models
		if (options.memory) {
			const memoryFraction = parseFloat(options.memory.replace("%", "")) / 100;
			// Remove any existing --gpu-memory-utilization from defaults
			vllmCmd = vllmCmd.replace(/--gpu-memory-utilization\s+[\d.]+/g, "");
			vllmCmd += ` --gpu-memory-utilization ${memoryFraction}`;
		}
		
		// Allow context override for known models
		if (options.context) {
			const contextMap: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			const maxTokens = contextMap[options.context.toLowerCase()] || parseInt(options.context);
			// Remove any existing --max-model-len from defaults
			vllmCmd = vllmCmd.replace(/--max-model-len\s+\d+/g, "");
			vllmCmd += ` --max-model-len ${maxTokens}`;
		}
	} else {
		// Unknown model with no custom args, defaults will be used
		// Only add memory and context if specified
		if (options.memory) {
			const memoryFraction = parseFloat(options.memory.replace("%", "")) / 100;
			vllmCmd += ` --gpu-memory-utilization ${memoryFraction}`;
		}
		
		if (options.context) {
			const contextMap: Record<string, number> = {
				"4k": 4096,
				"8k": 8192,
				"16k": 16384,
				"32k": 32768,
				"64k": 65536,
				"128k": 131072,
			};
			const maxTokens = contextMap[options.context.toLowerCase()] || parseInt(options.context);
			vllmCmd += ` --max-model-len ${maxTokens}`;
		}
	}

	// Start vLLM
	console.log("");
	console.log("Starting vLLM server...");
	console.log(chalk.gray(`Command: ${vllmCmd}`));

	// Build environment variables
	const envVars = [
		`HF_TOKEN='${process.env.HF_TOKEN}'`,
		`VLLM_API_KEY='${process.env.VLLM_API_KEY}'`,
		`HF_HUB_ENABLE_HF_TRANSFER=1`,
		`VLLM_NO_USAGE_STATS=1`,
		`VLLM_DO_NOT_TRACK=1`,
		`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`,
		`PYTHONUNBUFFERED=1`,  // Ensure output isn't buffered
	];
	
	// Set CUDA_VISIBLE_DEVICES for GPU selection when we're tracking specific GPUs
	// For single GPU deployments on multi-GPU systems
	if (gpus.length === 1) {
		envVars.push(`CUDA_VISIBLE_DEVICES=${gpus[0]}`);
	} else if (gpus.length > 1 && !options.vllmArgs) {
		// For multi-GPU deployments from our config (not custom args)
		// Let vLLM use the GPUs specified by tensor-parallel-size
		// We could set CUDA_VISIBLE_DEVICES to limit which GPUs, but for now
		// we assume the pod is dedicated to this model
	}
	// For custom vllm args (gpus.length === 0), don't set CUDA_VISIBLE_DEVICES
	// User has full control

	// Add model-specific environment variables
	if (modelConfig?.env) {
		for (const [key, value] of Object.entries(modelConfig.env)) {
			envVars.push(`${key}='${value}'`);
		}
	}

	// Start vLLM server
	console.log("Starting vLLM server...");
	console.log(chalk.gray(`Command: ${vllmCmd}`));
	console.log("");
	
	// Start vLLM in background
	const startCmd = `
		source /root/venv/bin/activate
		${envVars.map(v => `export ${v}`).join("\n\t\t")}
		
		# Ensure log directory exists
		mkdir -p ~/.vllm_logs
		
		# Just use nohup without colors for now - simpler and more reliable
		nohup ${vllmCmd} > ~/.vllm_logs/${name}.log 2>&1 &
		echo $!
	`;

	// Get the PID first
	const pidResult = await sshExec(pod.ssh, startCmd);
	const pid = parseInt(pidResult.stdout.trim()) || 0;
	
	if (!pid) {
		console.error(chalk.red("Failed to start vLLM process"));
		process.exit(1);
	}
	
	// Save to config immediately so we can stop it if needed
	const config = loadConfig();
	const model: Model = {
		model: modelId,
		port,
		gpu: gpus,
		pid,
	};
	config.pods[podName].models[name] = model;
	saveConfig(config);
	
	console.log(`Process started with PID: ${pid}`);
	console.log("Streaming logs... (Press Ctrl+C to stop monitoring)\n");
	
	// Stream logs and watch for success/failure
	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;
	const sshArgs = pod.ssh.split(" ").slice(1);
	sshArgs.push(tailCmd);
	
	const logProcess = spawn("ssh", sshArgs);
	
	let serverReady = false;
	let serverFailed = false;
	
	// Handle Ctrl+C gracefully
	let interrupted = false;
	const cleanup = () => {
		if (!interrupted) {
			interrupted = true;
			logProcess.kill();
			if (!serverReady) {
				console.log(chalk.yellow("\n\nStopped monitoring. Server is still starting in background."));
				console.log(chalk.cyan(`Check status with: pi logs ${name}`));
				console.log(chalk.cyan(`Stop server with: pi stop ${name}`));
			}
		}
	};
	
	process.on("SIGINT", cleanup);
	
	// Set up log monitoring
	logProcess.stdout.on("data", (data) => {
		const text = data.toString();
		process.stdout.write(text);
		
		// Check for success
		if (text.includes("Uvicorn running on") || 
		    text.includes("Application startup complete") ||
		    text.includes(`http://0.0.0.0:${port}`)) {
			serverReady = true;
			logProcess.kill();
		}
		
		// Check for failure
		if (text.includes("CUDA out of memory") ||
		    text.includes("torch.cuda.OutOfMemoryError") ||
		    text.includes("Address already in use") ||
		    (text.includes("RuntimeError") && !text.includes("Initializing")) ||
		    text.includes("AssertionError")) {
			serverFailed = true;
			logProcess.kill();
		}
	});
	
	logProcess.stderr.on("data", (data) => {
		process.stderr.write(data);
	});
	
	// Wait for process to exit (either from success/failure detection or user interrupt)
	await new Promise<void>((resolve) => {
		logProcess.on("exit", () => resolve());
	});
	
	// Clean up signal handler
	process.removeListener("SIGINT", cleanup);
	
	// Check what happened
	if (serverFailed) {
		console.error(chalk.red("\n✗ Server failed to start"));
		// Remove from config since it failed
		const config = loadConfig();
		delete config.pods[podName].models[name];
		saveConfig(config);
		await sshExec(pod.ssh, `kill ${pid} 2>/dev/null || true`);
		process.exit(1);
	}
	
	if (!serverReady && !interrupted) {
		console.error(chalk.red("\n✗ Connection lost or log stream ended"));
		console.error(chalk.yellow("Server may still be running. Check with:"));
		console.error(chalk.cyan(`  pi logs ${name}`));
		console.error(chalk.cyan(`  pi stop ${name}`));
		// Keep in config since it might still be running
		return;
	}
	
	if (interrupted && !serverReady) {
		// User interrupted, server still starting
		return;
	}

	// Get pod SSH host for display
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";

	console.log("");
	console.log(chalk.green(`✓ Model '${name}' started successfully!`));
	console.log("");
	console.log("Access at:");
	console.log(chalk.cyan(`  http://${host}:${port}/v1`));
	console.log("");
	console.log("Test with:");
	console.log(chalk.cyan(`  pi prompt ${name} "Hello!"`));
	console.log("");
	console.log("View logs:");
	console.log(chalk.cyan(`  pi logs ${name}`));
};

/**
 * Stop a model
 */
export const stopModel = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.yellow(`Stopping model '${name}' on pod '${podName}'...`));

	// Kill the process
	const killCmd = `kill ${model.pid} 2>/dev/null || true`;
	await sshExec(pod.ssh, killCmd);

	// Remove from config
	const config = loadConfig();
	delete config.pods[podName].models[name];
	saveConfig(config);

	console.log(chalk.green(`✓ Model '${name}' stopped`));
};

/**
 * Stop all models on a pod
 */
export const stopAllModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);
	
	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}
	
	console.log(chalk.yellow(`Stopping ${modelNames.length} model(s) on pod '${podName}'...`));
	
	// Kill all processes
	const pids = Object.values(pod.models).map(m => m.pid);
	const killCmd = `kill ${pids.join(' ')} 2>/dev/null || true`;
	await sshExec(pod.ssh, killCmd);
	
	// Clear all models from config
	const config = loadConfig();
	config.pods[podName].models = {};
	saveConfig(config);
	
	console.log(chalk.green(`✓ Stopped all models: ${modelNames.join(', ')}`));
};

/**
 * List all models
 */
export const listModels = async (options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const modelNames = Object.keys(pod.models);
	if (modelNames.length === 0) {
		console.log(`No models running on pod '${podName}'`);
		return;
	}

	// Get pod SSH host for URL display
	const sshParts = pod.ssh.split(" ");
	const host = sshParts.find((p) => p.includes("@"))?.split("@")[1] || "unknown";
	
	console.log(`Models on pod '${chalk.bold(podName)}':`);
	for (const name of modelNames) {
		const model = pod.models[name];
		const gpuStr = model.gpu.length > 1 ? `GPUs ${model.gpu.join(",")}` : model.gpu.length === 1 ? `GPU ${model.gpu[0]}` : "GPU unknown";
		console.log(`  ${chalk.green(name)} - Port ${model.port} - ${gpuStr} - PID ${model.pid}`);
		console.log(`    Model: ${chalk.gray(model.model)}`);
		console.log(`    URL: ${chalk.cyan(`http://${host}:${model.port}/v1`)}`);
	}

	// Optionally verify processes are still running
	console.log("");
	console.log("Verifying processes...");
	let anyDead = false;
	for (const name of modelNames) {
		const model = pod.models[name];
		const checkCmd = `ps -p ${model.pid} > /dev/null 2>&1 && echo "running" || echo "dead"`;
		const result = await sshExec(pod.ssh, checkCmd);
		const status = result.stdout.trim();
		if (status === "dead") {
			console.log(chalk.red(`  ${name}: Process ${model.pid} is not running`));
			anyDead = true;
		}
	}

	if (anyDead) {
		console.log("");
		console.log(chalk.yellow("Some models are not running. Clean up with:"));
		console.log(chalk.cyan("  pi stop <name>"));
	} else {
		console.log(chalk.green("✓ All processes verified"));
	}
};

/**
 * View model logs
 */
export const viewLogs = async (name: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	console.log(chalk.green(`Streaming logs for '${name}' on pod '${podName}'...`));
	console.log(chalk.gray("Press Ctrl+C to stop"));
	console.log("");

	const tailCmd = `tail -f ~/.vllm_logs/${name}.log`;
	await sshExecStream(pod.ssh, tailCmd);
};

/**
 * Show known models and their hardware requirements
 */
export const showKnownModels = async () => {
	const modelsJson = await import("../models.json", { assert: { type: "json" } });
	const models = modelsJson.default.models;
	
	// Get active pod info if available
	const activePod = getActivePod();
	let podGpuCount = 0;
	let podGpuType = "";
	
	if (activePod) {
		podGpuCount = activePod.pod.gpus.length;
		// Extract GPU type from name (e.g., "NVIDIA H200" -> "H200")
		podGpuType = activePod.pod.gpus[0]?.name
			?.replace("NVIDIA", "")
			?.trim()
			?.split(" ")[0] || "";
		
		console.log(chalk.bold(`Known Models for ${activePod.name} (${podGpuCount}x ${podGpuType || "GPU"}):\n`));
	} else {
		console.log(chalk.bold("Known Models:\n"));
		console.log(chalk.yellow("No active pod. Use 'pi pods active <name>' to filter compatible models.\n"));
	}
	
	console.log("Usage: pi start <model> --name <name> [options]\n");
	
	// Group models by compatibility and family
	const compatible: Record<string, Array<{ id: string; name: string; config: string; notes?: string }>> = {};
	const incompatible: Record<string, Array<{ id: string; name: string; minGpu: string; notes?: string }>> = {};
	
	for (const [modelId, info] of Object.entries(models)) {
		const modelInfo = info as any;
		const family = modelInfo.name.split("-")[0] || "Other";
		
		let isCompatible = false;
		let compatibleConfig = "";
		let minGpu = "Unknown";
		let minNotes: string | undefined;
		
		if (modelInfo.configs && modelInfo.configs.length > 0) {
			// Sort configs by GPU count to find minimum
			const sortedConfigs = [...modelInfo.configs].sort((a: any, b: any) => 
				(a.gpuCount || 1) - (b.gpuCount || 1)
			);
			
			// Find minimum requirements
			const minConfig = sortedConfigs[0];
			const minGpuCount = minConfig.gpuCount || 1;
			const gpuTypes = minConfig.gpuTypes?.join("/") || "H100/H200";
			
			if (minGpuCount === 1) {
				minGpu = `1x ${gpuTypes}`;
			} else {
				minGpu = `${minGpuCount}x ${gpuTypes}`;
			}
			
			minNotes = minConfig.notes || modelInfo.notes;
			
			// Check compatibility with active pod
			if (activePod && podGpuCount > 0) {
				// Find best matching config for this pod
				for (const config of sortedConfigs) {
					const configGpuCount = config.gpuCount || 1;
					const configGpuTypes = config.gpuTypes || [];
					
					// Check if we have enough GPUs
					if (configGpuCount <= podGpuCount) {
						// Check if GPU type matches (if specified)
						if (configGpuTypes.length === 0 || 
						    configGpuTypes.some((type: string) => 
						        podGpuType.includes(type) || type.includes(podGpuType)
						    )) {
							isCompatible = true;
							if (configGpuCount === 1) {
								compatibleConfig = `1x ${podGpuType}`;
							} else {
								compatibleConfig = `${configGpuCount}x ${podGpuType}`;
							}
							minNotes = config.notes || modelInfo.notes;
							break;
						}
					}
				}
			}
		}
		
		const modelEntry = {
			id: modelId,
			name: modelInfo.name,
			notes: minNotes
		};
		
		if (activePod && isCompatible) {
			if (!compatible[family]) {
				compatible[family] = [];
			}
			compatible[family].push({ ...modelEntry, config: compatibleConfig });
		} else {
			if (!incompatible[family]) {
				incompatible[family] = [];
			}
			incompatible[family].push({ ...modelEntry, minGpu });
		}
	}
	
	// Display compatible models first
	if (activePod && Object.keys(compatible).length > 0) {
		console.log(chalk.green.bold("✓ Compatible Models:\n"));
		
		const sortedFamilies = Object.keys(compatible).sort();
		for (const family of sortedFamilies) {
			console.log(chalk.cyan(`${family} Models:`));
			
			const modelList = compatible[family].sort((a, b) => a.name.localeCompare(b.name));
			
			for (const model of modelList) {
				console.log(`  ${chalk.green(model.id)}`);
				console.log(`    Name: ${model.name}`);
				console.log(`    Config: ${model.config}`);
				if (model.notes) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				console.log("");
			}
		}
	}
	
	// Display incompatible models
	if (Object.keys(incompatible).length > 0) {
		if (activePod && Object.keys(compatible).length > 0) {
			console.log(chalk.red.bold("✗ Incompatible Models (need more/different GPUs):\n"));
		}
		
		const sortedFamilies = Object.keys(incompatible).sort();
		for (const family of sortedFamilies) {
			if (!activePod) {
				console.log(chalk.cyan(`${family} Models:`));
			} else {
				console.log(chalk.gray(`${family} Models:`));
			}
			
			const modelList = incompatible[family].sort((a, b) => a.name.localeCompare(b.name));
			
			for (const model of modelList) {
				const color = activePod ? chalk.gray : chalk.green;
				console.log(`  ${color(model.id)}`);
				console.log(chalk.gray(`    Name: ${model.name}`));
				console.log(chalk.gray(`    Min Hardware: ${model.minGpu}`));
				if (model.notes && !activePod) {
					console.log(chalk.gray(`    Note: ${model.notes}`));
				}
				if (activePod) {
					console.log("");  // Less verbose for incompatible models when filtered
				} else {
					console.log("");
				}
			}
		}
	}
	
	console.log(chalk.gray("\nFor unknown models, defaults to single GPU deployment."));
	console.log(chalk.gray("Use --vllm to pass custom arguments to vLLM."));
};

/**
 * Test a model with a prompt
 */
export const promptModel = async (name: string, message: string, options: { pod?: string }) => {
	const { name: podName, pod } = getPod(options.pod);

	const model = pod.models[name];
	if (!model) {
		console.error(chalk.red(`Model '${name}' not found on pod '${podName}'`));
		process.exit(1);
	}

	// Simple curl test for now
	const curlCmd = `
		curl -s http://localhost:${model.port}/v1/chat/completions \
			-H "Content-Type: application/json" \
			-H "Authorization: Bearer ${process.env.VLLM_API_KEY}" \
			-d '{
				"model": "${model.model}",
				"messages": [{"role": "user", "content": ${JSON.stringify(message)}}],
				"max_tokens": 500,
				"temperature": 0.7
			}'
	`;

	console.log(chalk.green(`Testing model '${name}'...`));
	console.log(chalk.gray(`User: ${message}`));
	console.log("");

	const result = await sshExec(pod.ssh, curlCmd);
	if (result.exitCode !== 0) {
		console.error(chalk.red("Request failed"));
		console.error(result.stderr);
		process.exit(1);
	}

	try {
		const response = JSON.parse(result.stdout);
		if (response.choices[0]) {
			const content = response.choices[0].message.content;
			console.log(chalk.green("Assistant:"));
			console.log(content);
		} else if (response.error) {
			console.error(chalk.red("API Error:"));
			console.error(response.error);
		} else {
			console.log("Response:");
			console.log(JSON.stringify(response, null, 2));
		}
	} catch (e) {
		console.error(chalk.red("Failed to parse response"));
		console.log(result.stdout);
	}
};