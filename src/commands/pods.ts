import chalk from "chalk";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { addPod, loadConfig, removePod, setActivePod } from "../config.js";
import { scpFile, sshExec, sshExecStream } from "../ssh.js";
import type { GPU, Pod } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * List all pods
 */
export const listPods = () => {
	const config = loadConfig();
	const podNames = Object.keys(config.pods);

	if (podNames.length === 0) {
		console.log("No pods configured. Use 'pi pods setup' to add a pod.");
		return;
	}

	console.log("Configured pods:");
	for (const name of podNames) {
		const pod = config.pods[name];
		const isActive = config.active === name;
		const marker = isActive ? chalk.green("*") : " ";
		const gpuCount = pod.gpus?.length || 0;
		const gpuInfo = gpuCount > 0 ? `${gpuCount}x ${pod.gpus[0].name}` : "no GPUs detected";
		console.log(`${marker} ${chalk.bold(name)} - ${gpuInfo} - ${pod.ssh}`);
		if (pod.modelsPath) {
			console.log(`    Models: ${pod.modelsPath}`);
		}
	}
};

/**
 * Setup a new pod
 */
export const setupPod = async (name: string, sshCmd: string, options: { storage?: string; modelsPath?: string }) => {
	// Validate environment variables
	const hfToken = process.env.HF_TOKEN;
	const vllmApiKey = process.env.VLLM_API_KEY;

	if (!hfToken) {
		console.error(chalk.red("ERROR: HF_TOKEN environment variable is required"));
		console.error("Get a token from: https://huggingface.co/settings/tokens");
		console.error("Then run: export HF_TOKEN=your_token_here");
		process.exit(1);
	}

	if (!vllmApiKey) {
		console.error(chalk.red("ERROR: VLLM_API_KEY environment variable is required"));
		console.error("Set an API key: export VLLM_API_KEY=your_api_key_here");
		process.exit(1);
	}

	// Determine models path
	let modelsPath = options.modelsPath;
	if (!modelsPath && options.storage) {
		// Extract path from mount command if not explicitly provided
		// e.g., "mount -t nfs ... /mnt/sfs" -> "/mnt/sfs"
		const parts = options.storage.split(" ");
		modelsPath = parts[parts.length - 1];
	}

	if (!modelsPath) {
		console.error(chalk.red("ERROR: --models-path is required (or must be extractable from --storage)"));
		process.exit(1);
	}

	console.log(chalk.green(`Setting up pod '${name}'...`));
	console.log(`SSH: ${sshCmd}`);
	console.log(`Models path: ${modelsPath}`);
	if (options.storage) {
		console.log(`Storage mount: ${options.storage}`);
	}
	console.log("");

	// Test SSH connection
	console.log("Testing SSH connection...");
	const testResult = await sshExec(sshCmd, "echo 'SSH OK'");
	if (testResult.exitCode !== 0) {
		console.error(chalk.red("Failed to connect via SSH"));
		console.error(testResult.stderr);
		process.exit(1);
	}
	console.log(chalk.green("✓ SSH connection successful"));

	// Copy setup script
	console.log("Copying setup script...");
	const scriptPath = join(__dirname, "../../scripts/pod_setup.sh");
	const success = await scpFile(sshCmd, scriptPath, "/tmp/pod_setup.sh");
	if (!success) {
		console.error(chalk.red("Failed to copy setup script"));
		process.exit(1);
	}
	console.log(chalk.green("✓ Setup script copied"));

	// Build setup command
	let setupCmd = `bash /tmp/pod_setup.sh --models-path '${modelsPath}' --hf-token '${hfToken}' --vllm-api-key '${vllmApiKey}'`;
	if (options.storage) {
		setupCmd += ` --storage-mount '${options.storage}'`;
	}

	// Run setup script
	console.log("");
	console.log(chalk.yellow("Running setup (this will take 2-5 minutes)..."));
	console.log("");

	// Use forceTTY to preserve colors from apt, pip, etc.
	const exitCode = await sshExecStream(sshCmd, setupCmd, { forceTTY: true });
	if (exitCode !== 0) {
		console.error(chalk.red("\nSetup failed. Check the output above for errors."));
		process.exit(1);
	}

	// Parse GPU info from setup output
	console.log("");
	console.log("Detecting GPU configuration...");
	const gpuResult = await sshExec(sshCmd, "nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader");

	const gpus: GPU[] = [];
	if (gpuResult.exitCode === 0 && gpuResult.stdout) {
		const lines = gpuResult.stdout.trim().split("\n");
		for (const line of lines) {
			const [id, name, memory] = line.split(",").map((s) => s.trim());
			if (id !== undefined) {
				gpus.push({
					id: parseInt(id),
					name: name || "Unknown",
					memory: memory || "Unknown",
				});
			}
		}
	}

	console.log(chalk.green(`✓ Detected ${gpus.length} GPU(s)`));
	for (const gpu of gpus) {
		console.log(`  GPU ${gpu.id}: ${gpu.name} (${gpu.memory})`);
	}

	// Save pod configuration
	const pod: Pod = {
		ssh: sshCmd,
		gpus,
		models: {},
		modelsPath,
	};

	addPod(name, pod);
	console.log("");
	console.log(chalk.green(`✓ Pod '${name}' setup complete and set as active pod`));
	console.log("");
	console.log("You can now deploy models with:");
	console.log(chalk.cyan(`  pi start <model> --name <name>`));
};

/**
 * Switch active pod
 */
export const switchActivePod = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
		console.log("\nAvailable pods:");
		for (const podName of Object.keys(config.pods)) {
			console.log(`  ${podName}`);
		}
		process.exit(1);
	}

	setActivePod(name);
	console.log(chalk.green(`✓ Switched active pod to '${name}'`));
};

/**
 * Remove a pod from config
 */
export const removePodCommand = (name: string) => {
	const config = loadConfig();
	if (!config.pods[name]) {
		console.error(chalk.red(`Pod '${name}' not found`));
		process.exit(1);
	}

	removePod(name);
	console.log(chalk.green(`✓ Removed pod '${name}' from configuration`));
	console.log(chalk.yellow("Note: This only removes the local configuration. The remote pod is not affected."));
};
