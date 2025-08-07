import { tool } from "ai";
import chalk from "chalk";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
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
		console.log(chalk.dim("[thinking]"));
		console.log(chalk.dim(text));
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

	assistantLabel: () => {
		console.log(chalk.hex("#FFA500")("[assistant]"));
	},

	assistantMessage: (text: string) => {
		console.log(text);
		console.log();
	},

	user: (text?: string) => {
		if (text) {
			console.log(chalk.green("[user]"));
			console.log(text);
			console.log(); // Extra newline after user message
		} else {
			// For interactive mode - just the label since text is already shown
			console.log(chalk.green("[user]"));
			console.log();
		}
	},

	error: (text: string) => {
		console.error(chalk.red(`[error] ${text}\n`));
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

async function callGptOssModel(client: OpenAI, model: string, messages: any[]): Promise<void> {
	// Show assistant label at the start
	display.assistantLabel();

	let conversationDone = false;
	const maxRounds = 10;

	for (let round = 0; round < maxRounds && !conversationDone; round++) {
		const response = await client.responses.create({
			model,
			input: messages,
			tools: toolsForResponses,
			tool_choice: "auto",
			max_output_tokens: 2000,
		} as any);

		const output = response.output;
		if (!output) break;

		// Now process the output for display and tool execution
		const toolCalls: any[] = [];

		const executeToolCall = async (toolCall: ToolCall) => {
			try {
				display.tool(toolCall.name, toolCall.arguments);
				const result = await executeTool(toolCall.name, toolCall.arguments);
				display.toolResult(result);

				// Add tool result to messages
				messages.push({
					type: "function_call_output",
					call_id: toolCall.id,
					output: result,
				} as ResponseFunctionToolCallOutputItem);
			} catch (e: any) {
				display.toolResult(e.message, true);
				messages.push({
					type: "function_call_output",
					call_id: toolCall.id,
					output: e.message,
				});
			}
		};

		for (const item of output) {
			// vLLM+gpt-oss quirk: remove 'type' field from message items to avoid 400 errors
			if (item.type === "message") {
				const { type, ...messageWithoutType } = item;
				messages.push(messageWithoutType);
			} else {
				messages.push(item);
			}

			switch (item.type) {
				case "reasoning": {
					for (const content of item.content || []) {
						if (content.type === "reasoning_text") {
							display.thinking(content.text);
						}
					}
					break;
				}

				case "message": {
					for (const content of item.content || []) {
						if (content.type === "output_text") {
							display.assistantMessage(content.text);
						} else if (content.type === "refusal") {
							display.error(`Refusal: ${content.refusal}`);
						}
						conversationDone = true;
					}
					break;
				}

				case "function_call": {
					// Execute tool call and add result
					await executeToolCall({
						name: item.name,
						arguments: item.arguments,
						id: item.call_id,
					});
					break;
				}

				default: {
					display.error(`Unknown output type in LLM response: ${item.type}`);
					break;
				}
			}
		}
	}

	if (!conversationDone) {
		display.error("Max rounds reached without completion");
	}
}

async function callChatModel(client: OpenAI, model: string, messages: any[]): Promise<void> {
	// Show assistant label at the start
	display.assistantLabel();

	const maxRounds = 5;
	let assistantResponded = false;

	for (let round = 0; round < maxRounds && !assistantResponded; round++) {
		const response = await client.chat.completions.create({
			model,
			messages,
			tools: toolsForChat as any,
			tool_choice: "auto",
			temperature: 0.7,
			max_tokens: 2000,
		});

		const message = response.choices[0].message;

		if (message.tool_calls && message.tool_calls.length > 0) {
			// Add assistant message with tool calls to history
			const assistantMsg: any = {
				role: "assistant",
				content: message.content || null,
				tool_calls: message.tool_calls,
			};
			messages.push(assistantMsg);

			// Display and execute each tool call
			for (const toolCall of message.tool_calls) {
				const funcName = toolCall.type === "function" ? toolCall.function.name : toolCall.custom.name;
				const funcArgs = toolCall.type === "function" ? toolCall.function.arguments : toolCall.custom.input;
				display.tool(funcName, funcArgs);

				try {
					const result = await executeTool(funcName, funcArgs);
					display.toolResult(result);

					// Add tool result to messages
					messages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					});
				} catch (e: any) {
					display.toolResult(e.message, true);
					messages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					});
				}
			}
		} else if (message.content) {
			// Final assistant response
			display.assistantMessage(message.content);
			messages.push({ role: "assistant", content: message.content });
			assistantResponded = true;
		}
	}

	if (!assistantResponded) {
		display.error("Max rounds reached without response");
	}
}

// ────────────────────────────────────────────────────────────────────────────────
// Main prompt function
// ────────────────────────────────────────────────────────────────────────────────

export async function promptModel(modelName: string, userMessages: string[] | undefined, opts: PromptOptions = {}) {
	// Remove the SIGINT handler - it's preventing normal Ctrl+C behavior

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

		console.log(chalk.gray("Interactive mode. CTRL + C to quit.\n"));

		// Different conversation formats for different APIs
		let conversation: any[];

		if (isGptOss) {
			// Responses API uses 'input' array with different format
			conversation = [{ role: "system", content: systemPrompt }];
		} else {
			// Chat API uses 'messages' array
			conversation = [{ role: "system", content: systemPrompt }];
		}

		while (true) {
			console.log(chalk.green("[user]"));
			const userInput = await rl.question(`${chalk.green("> ")}`);
			console.log();

			// Add user message to conversation
			conversation.push({ role: "user", content: userInput });

			try {
				if (isGptOss) {
					// For responses API, modifies the input array directly
					await callGptOssModel(client, modelConfig.model, conversation);
				} else {
					// For chat API, modifies the messages array directly
					await callChatModel(client, modelConfig.model, conversation);
				}
			} catch (e: any) {
				display.error(e.message);
			}
		}
	} else {
		// Single-shot mode with queued prompts
		if (!userMessages || userMessages.length === 0) {
			display.error("No prompts provided");
			process.exit(1);
		}

		// Different conversation formats for different APIs
		let conversation: any[];

		if (isGptOss) {
			// Responses API uses 'input' array
			conversation = [{ role: "system", content: systemPrompt }];
		} else {
			// Chat API uses 'messages' array
			conversation = [{ role: "system", content: systemPrompt }];
		}

		for (const userMessage of userMessages) {
			// Check for exit command
			if (userMessage.toLowerCase() === "<exit>") {
				console.log(chalk.gray("Exiting..."));
				break;
			}

			// Display user message for single-shot mode
			display.user(userMessage);
			conversation.push({ role: "user", content: userMessage });

			try {
				if (isGptOss) {
					// For responses API, modifies the input array directly
					await callGptOssModel(client, modelConfig.model, conversation);
				} else {
					// For chat API, modifies the messages array directly
					await callChatModel(client, modelConfig.model, conversation);
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
