import chalk from "chalk";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import OpenAI from "openai";
import { resolve } from "path";
import * as readline from "readline/promises";
import { getActivePod, loadConfig } from "../config.js";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

interface PromptOptions {
	pod?: string;
	interactive?: boolean;
	apiKey?: string;
}

interface ToolCall {
	name: string;
	arguments: string;
	id: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Display utilities
// ────────────────────────────────────────────────────────────────────────────────

const display = {
	thinking: (text: string) => {
		console.log(chalk.cyan("[thinking]"));
		console.log(text);
		console.log();
	},

	tool: (name: string, args: string) => {
		console.log(chalk.yellow(`[tool] ${name}(${args})`));
	},

	toolResult: (result: string, isError = false) => {
		const lines = result.split("\n");
		const maxLines = 10;
		const truncated = lines.length > maxLines;
		const toShow = truncated ? lines.slice(0, maxLines) : lines;

		const text = toShow.join("\n");
		console.log(isError ? chalk.red(text) : chalk.gray(text));

		if (truncated) {
			console.log(chalk.dim(`... (${lines.length - maxLines} more lines)`));
		}
		console.log();
	},

	assistant: (text: string) => {
		console.log(chalk.bgHex("#FFA500").white("[assistant]"));
		console.log(text);
		console.log();
	},

	user: (text: string) => {
		console.log(chalk.bgGreen.white("[user]"));
		console.log(text);
		console.log();
	},

	error: (text: string) => {
		console.error(chalk.red(`[error] ${text}`));
	},
};

// ────────────────────────────────────────────────────────────────────────────────
// Tools
// ────────────────────────────────────────────────────────────────────────────────

// For GPT-OSS models via responses API (vLLM format)
const toolsForResponses = [
	{
		type: "function" as const,
		name: "read_file",
		description: "Read contents of a file",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the file to read",
				},
			},
			required: ["path"],
		},
	},
	{
		type: "function" as const,
		name: "list_directory",
		description: "List contents of a directory",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Path to the directory (default: current directory)",
				},
			},
		},
	},
	{
		type: "function" as const,
		name: "run_command",
		description: "Execute a shell command",
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Command to execute",
				},
			},
			required: ["command"],
		},
	},
];

// For standard chat API (OpenAI format)
const toolsForChat = toolsForResponses.map((tool) => ({
	type: "function" as const,
	function: {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	},
}));

async function executeTool(name: string, args: string): Promise<string> {
	const parsed = JSON.parse(args);

	switch (name) {
		case "read_file": {
			const path = parsed.path;
			if (!path) return "Error: path parameter is required";
			const file = resolve(path);
			if (!existsSync(file)) return `File not found: ${file}`;
			const data = readFileSync(file, "utf8");
			return data;
		}

		case "list_directory": {
			const path = parsed.path || ".";
			const dir = resolve(path);
			if (!existsSync(dir)) return `Directory not found: ${dir}`;
			return readdirSync(dir).join("\n");
		}

		case "run_command": {
			const command = parsed.command;
			if (!command) return "Error: command parameter is required";
			try {
				const output = execSync(command, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
				return output || "Command executed successfully";
			} catch (e: any) {
				throw new Error(`Command failed: ${e.message}`);
			}
		}

		default:
			return `Unknown tool: ${name}`;
	}
}

// ────────────────────────────────────────────────────────────────────────────────
// Model communication
// ────────────────────────────────────────────────────────────────────────────────

async function callGptOssModel(client: OpenAI, model: string, messages: any[]): Promise<string | null> {
	const input: any[] = messages.map((m) => ({
		role: m.role,
		content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
	}));

	let conversationDone = false;
	const maxRounds = 10;

	for (let round = 0; round < maxRounds && !conversationDone; round++) {
		const response = await client.responses.create({
			model,
			input,
			tools: toolsForResponses,
			tool_choice: "auto",
			max_output_tokens: 2000,
		} as any);

		const output = response.output as any[];
		if (!output) break;

		for (const item of output) {
			switch (item.type) {
				case "reasoning": {
					const text = item.content?.find((c: any) => c.type === "reasoning_text")?.text;
					if (text) {
						display.thinking(text);
					}
					break;
				}

				case "message": {
					const text = item.content?.find((c: any) => c.type === "output_text")?.text;
					if (text) {
						display.assistant(text);
						conversationDone = true;
						return text;
					}
					break;
				}

				case "function_call": {
					const toolCall: ToolCall = {
						name: item.name,
						arguments: item.arguments,
						id: item.call_id || item.id,
					};

					display.tool(toolCall.name, toolCall.arguments);

					try {
						const result = await executeTool(toolCall.name, toolCall.arguments);
						display.toolResult(result);

						// Add tool result to conversation
						input.push({
							type: "function_call_output",
							call_id: toolCall.id,
							output: result,
						});
					} catch (e: any) {
						display.toolResult(e.message, true);
						input.push({
							type: "function_call_output",
							call_id: toolCall.id,
							output: e.message,
						});
					}
					break;
				}
			}
		}
	}

	if (!conversationDone) {
		display.error("Max rounds reached without completion");
	}
	return null;
}

async function callChatModel(client: OpenAI, model: string, messages: any[]): Promise<string | null> {
	const formattedMessages = messages.map((m) => ({
		role: m.role,
		content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
	}));

	const maxRounds = 5;
	let assistantResponded = false;

	for (let round = 0; round < maxRounds && !assistantResponded; round++) {
		const response = await client.chat.completions.create({
			model,
			messages: formattedMessages,
			tools: toolsForChat as any,
			tool_choice: "auto",
			temperature: 0.7,
			max_tokens: 2000,
		});

		const message = response.choices[0].message;

		if (message.tool_calls && message.tool_calls.length > 0) {
			for (const toolCall of message.tool_calls) {
				const funcName = "function" in toolCall ? toolCall.function.name : (toolCall as any).name;
				const funcArgs = "function" in toolCall ? toolCall.function.arguments : (toolCall as any).arguments;
				display.tool(funcName, funcArgs);

				try {
					const result = await executeTool(funcName, funcArgs);
					display.toolResult(result);

					formattedMessages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					} as any);
				} catch (e: any) {
					display.toolResult(e.message, true);
					formattedMessages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					} as any);
				}
			}

			// Add the assistant's message with tool calls to history
			formattedMessages.push({
				role: "assistant",
				tool_calls: message.tool_calls,
			} as any);
		} else if (message.content) {
			display.assistant(message.content);
			assistantResponded = true;
			return message.content;
		}
	}

	if (!assistantResponded) {
		display.error("Max rounds reached without response");
	}
	return null;
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

	// Create OpenAI client
	const apiKey = opts.apiKey || process.env.VLLM_API_KEY || "dummy";
	const client = new OpenAI({
		apiKey,
		baseURL: `http://${host}:${modelConfig.port}/v1`,
	});

	const isGptOss = modelConfig.model.toLowerCase().includes("gpt-oss");
	const systemPrompt = `Current working directory: ${process.cwd()}`;

	// Interactive mode
	if (opts.interactive) {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});

		console.log(chalk.gray("Interactive mode. Type 'exit' to quit.\n"));

		const messages: any[] = [{ role: "system", content: systemPrompt }];

		while (true) {
			const input = await rl.question(chalk.green("> "));

			if (input.toLowerCase() === "exit") {
				rl.close();
				break;
			}

			display.user(input);
			messages.push({ role: "user", content: input });

			try {
				if (isGptOss) {
					await callGptOssModel(client, modelConfig.model, messages);
				} else {
					await callChatModel(client, modelConfig.model, messages);
				}
			} catch (e: any) {
				display.error(e.message);
			}

			console.log(chalk.gray("─".repeat(50)));
		}
	} else {
		// Single-shot mode with queued prompts
		if (!userMessages || userMessages.length === 0) {
			display.error("No prompts provided");
			process.exit(1);
		}

		const messages: any[] = [{ role: "system", content: systemPrompt }];

		for (const userMessage of userMessages) {
			// Check for exit command
			if (userMessage.toLowerCase() === "<exit>") {
				console.log(chalk.gray("Exiting..."));
				break;
			}

			// Display user message
			display.user(userMessage);
			messages.push({ role: "user", content: userMessage });

			try {
				let assistantResponse: string | null = null;
				if (isGptOss) {
					assistantResponse = await callGptOssModel(client, modelConfig.model, messages);
				} else {
					assistantResponse = await callChatModel(client, modelConfig.model, messages);
				}

				// Add assistant's response to conversation history
				if (assistantResponse) {
					messages.push({ role: "assistant", content: assistantResponse });
				}

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
