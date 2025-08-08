import chalk from "chalk";
import { getActivePod, loadConfig } from "../config.js";
import type { AgentRenderer } from "./agent.js";
import { Agent } from "./agent.js";
import { ConsoleRenderer } from "./renderers/console-renderer.js";
import { TuiRenderer } from "./renderers/tui-renderer.js";
import { SessionManager } from "./session-manager.js";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	interactive?: boolean;
	apiKey?: string;
	continue?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────────
// Main prompt function
// ────────────────────────────────────────────────────────────────────────────────

export async function promptModel(modelName: string, userMessages: string[] | undefined, opts: PromptOptions = {}) {
	// Get pod and model configuration
	const activePod = opts.pod ? { name: opts.pod, pod: loadConfig().pods[opts.pod] } : getActivePod();

	if (!activePod) {
		console.error(chalk.red("No active pod. Use 'pi pods active <name>' to set one."));
		process.exit(1);
	}

	const { name: podName, pod } = activePod;
	const modelConfig = pod.models[modelName];

	if (!modelConfig) {
		console.error(chalk.red(`Model '${modelName}' not found on pod '${podName}'`));
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

	// Create renderer - TUI for interactive, console for single-shot
	let renderer: AgentRenderer;

	if (opts.interactive) {
		renderer = new TuiRenderer();
	} else {
		renderer = new ConsoleRenderer();
	}

	// Create session manager
	const sessionManager = new SessionManager(opts.continue);

	// Create or resume agent
	let agent: Agent;
	let hasRestoredSession = false;
	let restoredMessages: any[] = [];

	if (opts.continue) {
		const sessionData = sessionManager.loadSession();
		if (sessionData) {
			// Resume with existing config and messages
			console.log(chalk.dim(`Resuming session with ${sessionData.messages.length} messages`));
			console.log(
				chalk.dim(
					`Previous usage: ${sessionData.totalUsage.prompt_tokens} prompt / ${sessionData.totalUsage.completion_tokens} completion / ${sessionData.totalUsage.total_tokens} total tokens`,
				),
			);

			// Override config with session's config but keep current API key
			agent = new Agent(
				{
					...sessionData.config,
					apiKey, // Use current API key
				},
				renderer,
				sessionManager,
			);
			agent.setMessages(sessionData.messages);
			hasRestoredSession = true;
			restoredMessages = sessionData.messages;
		} else {
			// No session to resume, create new
			console.log(chalk.dim("No previous session found, starting new session"));
			agent = new Agent(
				{
					apiKey,
					baseURL: `http://${host}:${modelConfig.port}/v1`,
					model: modelConfig.model,
					isGptOss,
					systemPrompt,
				},
				renderer,
				sessionManager,
			);
		}
	} else {
		// Create new agent with new session
		agent = new Agent(
			{
				apiKey,
				baseURL: `http://${host}:${modelConfig.port}/v1`,
				model: modelConfig.model,
				isGptOss,
				systemPrompt,
			},
			renderer,
			sessionManager,
		);
	}

	// Interactive mode - always use TUI
	if (opts.interactive && renderer instanceof TuiRenderer) {
		await renderer.init();

		// Render restored session history if continuing
		if (hasRestoredSession && restoredMessages.length > 0) {
			// Render previous messages (skip system prompt)
			for (const msg of restoredMessages) {
				if (msg.role === "system") continue;

				if (msg.role === "user") {
					await renderer.render({ type: "user_message", text: msg.content });
				} else if (msg.role === "assistant") {
					// Render assistant response
					if (msg.content) {
						await renderer.render({ type: "assistant_start" });
						await renderer.render({ type: "assistant_message", text: msg.content });
					}
				} else if (msg.role === "tool") {
					// Tool result message
					await renderer.render({
						type: "tool_result",
						result: msg.content || "",
						isError: false,
					});
				} else if (msg.tool_calls) {
					// Assistant message with tool calls
					await renderer.render({ type: "assistant_start" });
					for (const toolCall of msg.tool_calls) {
						const funcName = toolCall.type === "function" ? toolCall.function.name : toolCall.custom?.name;
						const funcArgs = toolCall.type === "function" ? toolCall.function.arguments : toolCall.custom?.input;
						await renderer.render({
							type: "tool_call",
							name: funcName || "unknown",
							args: funcArgs || "{}",
						});
					}
				} else if (msg.type === "reasoning") {
					// Reasoning/thinking message (for GPT-OSS)
					for (const content of msg.content || []) {
						if (content.type === "reasoning_text") {
							await renderer.render({ type: "thinking", text: content.text });
						}
					}
				} else if (msg.type === "message") {
					// Regular message (for GPT-OSS)
					await renderer.render({ type: "assistant_start" });
					for (const content of msg.content || []) {
						if (content.type === "output_text") {
							await renderer.render({ type: "assistant_message", text: content.text });
						}
					}
				} else if (msg.type === "function_call") {
					// Function call (for GPT-OSS)
					await renderer.render({
						type: "tool_call",
						name: msg.name || "unknown",
						args: msg.arguments || "{}",
					});
				} else if (msg.type === "function_call_output") {
					// Function output (for GPT-OSS)
					await renderer.render({
						type: "tool_result",
						result: msg.output || "",
						isError: false,
					});
				}
			}
		}

		// Set up interrupt callback
		renderer.setInterruptCallback(() => {
			agent.interrupt();
		});

		while (true) {
			const userInput = await renderer.getUserInput();

			try {
				await agent.chat(userInput);
			} catch (e: any) {
				renderer.render({ type: "error", message: e.message });
			}
		}
	} else {
		// Single-shot mode with queued prompts
		if (!userMessages || userMessages.length === 0) {
			console.error(chalk.red("No prompts provided"));
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
				renderer.render({ type: "error", message: e.message });
				// Continue with next prompt instead of exiting
			}
		}
	}
}
