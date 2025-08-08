import chalk from "chalk";
import { execSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
import { resolve } from "path";

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
	apiKey: string;
	baseURL: string;
	model: string;
	isGptOss: boolean;
	systemPrompt?: string;
}

export interface ToolCall {
	name: string;
	arguments: string;
	id: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Logging utilities
// ────────────────────────────────────────────────────────────────────────────────

function logMessages(messages: any[], context: string) {
	const timestamp = new Date().toISOString();
	const logEntry = {
		timestamp,
		context,
		messages: JSON.parse(JSON.stringify(messages)), // Deep clone to avoid mutations
	};
	
	try {
		// Append to prompts.json (create if doesn't exist)
		const logFile = "prompts.json";
		let logs = [];
		
		if (existsSync(logFile)) {
			try {
				const content = readFileSync(logFile, "utf8");
				logs = JSON.parse(content);
			} catch (e) {
				// If file is corrupted, start fresh
				logs = [];
			}
		}
		
		logs.push(logEntry);
		
		// Keep only last 100 entries to prevent file from growing too large
		if (logs.length > 100) {
			logs = logs.slice(-100);
		}
		
		writeFileSync(logFile, JSON.stringify(logs, null, 2));
	} catch (e) {
		// Silently fail logging - don't interrupt the main flow
		console.error(chalk.dim(`[log error] ${e}`));
	}
}

// ────────────────────────────────────────────────────────────────────────────────
// Display utilities
// ────────────────────────────────────────────────────────────────────────────────

export const display = {
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
export const toolsForResponses = [
	{
		type: "function" as const,
		name: "read",
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
		name: "list",
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
		name: "bash",
		description: "Execute a command in Bash",
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
	{
		type: "function" as const,
		name: "glob",
		description: "Find files matching a glob pattern",
		parameters: {
			type: "object",
			properties: {
				pattern: {
					type: "string",
					description: "Glob pattern to match files (e.g., '**/*.ts', 'src/**/*.json')",
				},
				path: {
					type: "string",
					description: "Directory to search in (default: current directory)",
				},
			},
			required: ["pattern"],
		},
	},
	{
		type: "function" as const,
		name: "rg",
		description: "Search using ripgrep.",
		parameters: {
			type: "object",
			properties: {
				args: {
					type: "string",
					description:
						'Arguments to pass directly to ripgrep. Examples: "-l prompt" or "-i TODO" or "--type ts className" or "functionName src/". Never add quotes around the search pattern.',
				},
			},
			required: ["args"],
		},
	},
];

// For standard chat API (OpenAI format)
export const toolsForChat = toolsForResponses.map((tool) => ({
	type: "function" as const,
	function: {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	},
}));

export async function executeTool(name: string, args: string): Promise<string> {
	const parsed = JSON.parse(args);

	switch (name) {
		case "read": {
			const path = parsed.path;
			if (!path) return "Error: path parameter is required";
			const file = resolve(path);
			if (!existsSync(file)) return `File not found: ${file}`;
			const data = readFileSync(file, "utf8");
			return data;
		}

		case "list": {
			const path = parsed.path || ".";
			const dir = resolve(path);
			if (!existsSync(dir)) return `Directory not found: ${dir}`;
			const entries = readdirSync(dir, { withFileTypes: true });
			return entries.map((entry) => (entry.isDirectory() ? entry.name + "/" : entry.name)).join("\n");
		}

		case "bash": {
			const command = parsed.command;
			if (!command) return "Error: command parameter is required";
			try {
				const output = execSync(command, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
				return output || "Command executed successfully";
			} catch (e: any) {
				throw new Error(`Command failed: ${e.message}`);
			}
		}

		case "glob": {
			const pattern = parsed.pattern;
			if (!pattern) return "Error: pattern parameter is required";
			const searchPath = parsed.path || process.cwd();

			try {
				const matches = await glob(pattern, {
					cwd: searchPath,
					dot: true,
					nodir: false,
					mark: true, // Add / to directories
				});

				if (matches.length === 0) {
					return "No files found matching the pattern";
				}

				// Sort by modification time (most recent first) if possible
				return matches.sort().join("\n");
			} catch (e: any) {
				return `Glob error: ${e.message}`;
			}
		}

		case "rg": {
			const args = parsed.args;
			if (!args) return "Error: args parameter is required";

			// Force ripgrep to never read from stdin by redirecting stdin from /dev/null
			const cmd = `rg ${args} < /dev/null`;

			try {
				const output = execSync(cmd, {
					encoding: "utf8",
					maxBuffer: 10 * 1024 * 1024,
					cwd: process.cwd(),
					shell: "/bin/sh", // Need shell to handle the redirect
				});
				return output.trim() || "No matches found";
			} catch (e: any) {
				// ripgrep returns exit code 1 when no matches found
				if (e.status === 1) {
					return "No matches found";
				}
				return `ripgrep error: ${e.message}`;
			}
		}

		default:
			return `Unknown tool: ${name}`;
	}
}

// ────────────────────────────────────────────────────────────────────────────────
// Model communication
// ────────────────────────────────────────────────────────────────────────────────

export async function callGptOssModel(client: OpenAI, model: string, messages: any[]): Promise<void> {
	// Show assistant label at the start
	display.assistantLabel();

	// Log initial messages
	logMessages(messages, "callGptOssModel:initial");

	let conversationDone = false;
	const maxRounds = 10000;

	for (let round = 0; round < maxRounds && !conversationDone; round++) {
		// Log before API call
		logMessages(messages, `callGptOssModel:before_api_round_${round}`);

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
				logMessages(messages, `callGptOssModel:after_tool_${toolCall.name}_success`);
			} catch (e: any) {
				display.toolResult(e.message, true);
				messages.push({
					type: "function_call_output",
					call_id: toolCall.id,
					output: e.message,
				});
				logMessages(messages, `callGptOssModel:after_tool_${toolCall.name}_error`);
			}
		};

		for (const item of output) {
			// vLLM+gpt-oss quirk: remove 'type' field from message items to avoid 400 errors
			if (item.type === "message") {
				const { type, ...messageWithoutType } = item;
				messages.push(messageWithoutType);
				logMessages(messages, `callGptOssModel:pushed_message_without_type`);
			} else {
				messages.push(item);
				logMessages(messages, `callGptOssModel:pushed_${item.type}`);
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

export async function callChatModel(client: OpenAI, model: string, messages: any[]): Promise<void> {
	// Show assistant label at the start
	display.assistantLabel();

	// Log initial messages
	logMessages(messages, "callChatModel:initial");

	const maxRounds = 10000;
	let assistantResponded = false;

	for (let round = 0; round < maxRounds && !assistantResponded; round++) {
		// Log before API call
		logMessages(messages, `callChatModel:before_api_round_${round}`);

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
			logMessages(messages, `callChatModel:pushed_assistant_with_tools`);

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
					logMessages(messages, `callChatModel:after_tool_${funcName}_success`);
				} catch (e: any) {
					display.toolResult(e.message, true);
					messages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					});
					logMessages(messages, `callChatModel:after_tool_${funcName}_error`);
				}
			}
		} else if (message.content) {
			// Final assistant response
			display.assistantMessage(message.content);
			messages.push({ role: "assistant", content: message.content });
			logMessages(messages, `callChatModel:pushed_final_assistant_response`);
			assistantResponded = true;
		}
	}

	if (!assistantResponded) {
		display.error("Max rounds reached without response");
	}
}

// ────────────────────────────────────────────────────────────────────────────────
// Agent class
// ────────────────────────────────────────────────────────────────────────────────

export class Agent {
	private client: OpenAI;
	private config: AgentConfig;
	private messages: any[] = [];

	constructor(config: AgentConfig) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
		});

		// Initialize with system prompt if provided
		if (config.systemPrompt) {
			this.messages.push({ role: "system", content: config.systemPrompt });
		}
	}

	async chat(userMessage: string): Promise<void> {
		// Add user message
		this.messages.push({ role: "user", content: userMessage });
		logMessages(this.messages, "agent:added_user_message");

		try {
			if (this.config.isGptOss) {
				await callGptOssModel(this.client, this.config.model, this.messages);
			} else {
				await callChatModel(this.client, this.config.model, this.messages);
			}
		} catch (e: any) {
			logMessages(this.messages, `agent:error_${e.status || 'unknown'}`);
			throw e;
		}
	}

	getMessages(): any[] {
		return [...this.messages];
	}

	clearMessages(): void {
		// Keep system prompt if it exists
		this.messages = this.config.systemPrompt 
			? [{ role: "system", content: this.config.systemPrompt }]
			: [];
	}
}