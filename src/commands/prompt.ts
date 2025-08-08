import chalk from "chalk";
import * as readline from "readline/promises";
import { getActivePod, loadConfig } from "../config.js";
import type { AgentRenderer } from "./agent.js";
import { Agent, display } from "./agent.js";
import { ConsoleRenderer } from "./renderers/console-renderer.js";
import { TuiRenderer } from "./renderers/tui-renderer.js";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	interactive?: boolean;
	apiKey?: string;
	ui?: "console" | "tui";
}

// ────────────────────────────────────────────────────────────────────────────────
// Main prompt function
// ────────────────────────────────────────────────────────────────────────────────

export async function promptModel(modelName: string, userMessages: string[] | undefined, opts: PromptOptions = {}) {
	// Get pod and model configuration
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		display.error("No active pod. Use 'pi pods active <name>' to set one.");
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		display.error(`Model '${modelName}' not found on pod '${podName}'`);
		process.exit(1);
	}

	// Extract host from SSH string
	const host =
		pod.ssh
			.split(" ")
			.find((p) => p.includes("@"))
			?.split("@")[1] ?? "localhost";

	// Create agent configuration
	const apiKey = opts.apiKey || process.env.VLLM_API_KEY || "dummy";
	const isGptOss = modelConfig.model.toLowerCase().includes("gpt-oss");
	const systemPrompt = `
You help the user understand an natigate the codebase in the current working directory.

You can read files, list directories, and execute shell commands via the respective tools.

Do not otuput file contents you read via the read_file tool directly, unless asked to.

Do not output markdown tables as part of your responses.

Keep your respones concise and relevant to the user's request.

File paths you output must include line numbers where possible, e.g. "src/index.ts:10-20" for lines 10 to 20 in src/index.ts.

Current working directory: ${process.cwd()}
`;

	// Create renderer based on UI option
	let renderer: AgentRenderer;
	let tuiRenderer: TuiRenderer | null = null; // Store TUI renderer for cleanup

	if (opts.ui === "tui" && opts.interactive) {
		tuiRenderer = new TuiRenderer();
		renderer = tuiRenderer;
	} else {
		renderer = new ConsoleRenderer();
	}

	// Create agent
	const agent = new Agent(
		{
			apiKey,
			baseURL: `http://${host}:${modelConfig.port}/v1`,
			model: modelConfig.model,
			isGptOss,
			systemPrompt,
		},
		renderer,
	);

	// Interactive mode
	if (opts.interactive) {
		if (tuiRenderer) {
			// TUI mode - use TUI for input
			await tuiRenderer.init();

			// Handle Ctrl+C
			process.on("SIGINT", () => {
				tuiRenderer.stop();
				process.exit(0);
			});

			while (true) {
				const userInput = await tuiRenderer.getUserInput();

				try {
					await agent.chat(userInput);
				} catch (e: any) {
					renderer.render({ type: "error", message: e.message });
				}
			}
		} else {
			// Console mode - use readline
			const rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});

			console.log(chalk.gray("Interactive mode. CTRL + C to quit.\n"));

			while (true) {
				console.log(chalk.green("[user]"));
				let userInput = await rl.question(`${chalk.green("> ")}`);

				// Check for multiline input marker
				if (userInput === '"""' || userInput.startsWith('"""')) {
					const lines = [];
					if (userInput.startsWith('"""') && userInput.length > 3) {
						// Handle case where user types """some text
						lines.push(userInput.substring(3));
					}

					console.log(chalk.dim('(multiline mode - type """ on its own line to finish)'));

					while (true) {
						const line = await rl.question(chalk.green("| "));
						if (line === '"""') break;
						lines.push(line);
					}
					userInput = lines.join("\n");
				}

				console.log();

				try {
					await agent.chat(userInput);
				} catch (e: any) {
					display.error(e.message);
				}
			}
		}
	} else {
		// Single-shot mode with queued prompts
		if (!userMessages || userMessages.length === 0) {
			display.error("No prompts provided");
			process.exit(1);
		}

		for (const userMessage of userMessages) {
			// Check for exit command
			if (userMessage.toLowerCase() === "<exit>") {
				console.log(chalk.gray("Exiting..."));
				break;
			}

			// Display user message for single-shot mode
			renderer.render({ type: "user_message", text: userMessage });

			try {
				await agent.chat(userMessage);

				// Add separator between prompts if not the last one
				const currentIndex = userMessages.indexOf(userMessage);
				if (currentIndex < userMessages.length - 1 && userMessages[currentIndex + 1].toLowerCase() !== "<exit>") {
					console.log(chalk.gray("─".repeat(50)));
				}
			} catch (e: any) {
				display.error(e.message);
				// Continue with next prompt instead of exiting
			}
		}
	}
}
