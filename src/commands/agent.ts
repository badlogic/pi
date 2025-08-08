import chalk from "chalk";
import { spawn } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { glob } from "glob";
import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
import { resolve } from "path";
import { ConsoleRenderer } from "./renderers/console-renderer";

// Helper to execute commands with abort support
async function execWithAbort(command: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			shell: true,
			signal,
		});

		let stdout = "";
		let stderr = "";

		child.stdout?.on("data", (data) => {
			stdout += data.toString();
		});

		child.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		child.on("error", (error) => {
			reject(error);
		});

		child.on("close", (code) => {
			if (signal?.aborted) {
				reject(new Error("Interrupted"));
			} else if (code !== 0 && code !== null) {
				// For some commands like ripgrep, exit code 1 is normal (no matches)
				if (code === 1 && command.includes("rg")) {
					resolve(""); // No matches for ripgrep
				} else if (stderr && !stdout) {
					reject(new Error(stderr));
				} else {
					resolve(stdout || "");
				}
			} else {
				resolve(stdout || stderr || "");
			}
		});

		// Kill the process if signal is aborted
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					child.kill("SIGTERM");
				},
				{ once: true },
			);
		}
	});
}

export type AgentEvent =
	| { type: "assistant_start" }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; name: string; args: string }
	| { type: "tool_result"; result: string; isError: boolean }
	| { type: "assistant_message"; text: string }
	| { type: "error"; message: string }
	| { type: "user_message"; text: string }
	| { type: "token_usage"; promptTokens: number; completionTokens: number; totalTokens: number };

export interface AgentRenderer {
	render(event: AgentEvent): void | Promise<void>;
}

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

export async function executeTool(name: string, args: string, signal?: AbortSignal): Promise<string> {
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
				const output = await execWithAbort(command, signal);
				return output || "Command executed successfully";
			} catch (e: any) {
				if (e.message === "Interrupted") {
					throw e; // Re-throw interruption
				}
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
				const output = await execWithAbort(cmd, signal);
				return output.trim() || "No matches found";
			} catch (e: any) {
				if (e.message === "Interrupted") {
					throw e; // Re-throw interruption
				}
				return `ripgrep error: ${e.message}`;
			}
		}

		default:
			return `Unknown tool: ${name}`;
	}
}

export async function callModelResponses(
	client: OpenAI,
	model: string,
	messages: any[],
	renderer: AgentRenderer,
	signal?: AbortSignal,
): Promise<void> {
	// Show assistant label at the start
	renderer.render({ type: "assistant_start" });

	// Log initial messages
	logMessages(messages, "callGptOssModel:initial");

	let conversationDone = false;
	const maxRounds = 10000;

	for (let round = 0; round < maxRounds && !conversationDone; round++) {
		// Check if we've been interrupted
		if (signal?.aborted) {
			throw new Error("Interrupted");
		}

		// Log before API call
		logMessages(messages, `callGptOssModel:before_api_round_${round}`);

		const response = await client.responses.create(
			{
				model,
				input: messages,
				tools: toolsForResponses,
				tool_choice: "auto",
				max_output_tokens: 2000,
			} as any,
			{ signal },
		);

		// Report token usage if available (responses API format)
		if ((response as any).usage) {
			const usage = (response as any).usage;
			renderer.render({
				type: "token_usage",
				promptTokens: usage.prompt_tokens || 0,
				completionTokens: usage.completion_tokens || 0,
				totalTokens: usage.total_tokens || 0,
			});
		}

		const output = response.output;
		if (!output) break;

		// Now process the output for display and tool execution
		const toolCalls: any[] = [];

		const executeToolCall = async (toolCall: ToolCall) => {
			// Check if interrupted before executing tool
			if (signal?.aborted) {
				throw new Error("Interrupted");
			}

			try {
				renderer.render({ type: "tool_call", name: toolCall.name, args: toolCall.arguments });
				const result = await executeTool(toolCall.name, toolCall.arguments, signal);
				renderer.render({ type: "tool_result", result, isError: false });

				// Add tool result to messages
				messages.push({
					type: "function_call_output",
					call_id: toolCall.id,
					output: result,
				} as ResponseFunctionToolCallOutputItem);
				logMessages(messages, `callGptOssModel:after_tool_${toolCall.name}_success`);
			} catch (e: any) {
				renderer.render({ type: "tool_result", result: e.message, isError: true });
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
							renderer.render({ type: "thinking", text: content.text });
						}
					}
					break;
				}

				case "message": {
					for (const content of item.content || []) {
						if (content.type === "output_text") {
							renderer.render({ type: "assistant_message", text: content.text });
						} else if (content.type === "refusal") {
							renderer.render({ type: "error", message: `Refusal: ${content.refusal}` });
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
					renderer.render({ type: "error", message: `Unknown output type in LLM response: ${item.type}` });
					break;
				}
			}
		}
	}

	if (!conversationDone) {
		renderer.render({ type: "error", message: "Max rounds reached without completion" });
	}
}

export async function callModelChat(
	client: OpenAI,
	model: string,
	messages: any[],
	renderer: AgentRenderer,
	signal?: AbortSignal,
): Promise<void> {
	// Show assistant label at the start
	renderer.render({ type: "assistant_start" });

	// Log initial messages
	logMessages(messages, "callChatModel:initial");

	const maxRounds = 10000;
	let assistantResponded = false;

	for (let round = 0; round < maxRounds && !assistantResponded; round++) {
		// Check if we've been interrupted
		if (signal?.aborted) {
			throw new Error("Interrupted");
		}

		// Log before API call
		logMessages(messages, `callChatModel:before_api_round_${round}`);

		const response = await client.chat.completions.create(
			{
				model,
				messages,
				tools: toolsForChat as any,
				tool_choice: "auto",
				temperature: 0.7,
				max_tokens: 2000,
			},
			{ signal },
		);

		const message = response.choices[0].message;

		// Report token usage if available
		if (response.usage) {
			renderer.render({
				type: "token_usage",
				promptTokens: response.usage.prompt_tokens,
				completionTokens: response.usage.completion_tokens,
				totalTokens: response.usage.total_tokens,
			});
		}

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
				// Check if interrupted before executing tool
				if (signal?.aborted) {
					throw new Error("Interrupted");
				}

				const funcName = toolCall.type === "function" ? toolCall.function.name : toolCall.custom.name;
				const funcArgs = toolCall.type === "function" ? toolCall.function.arguments : toolCall.custom.input;
				renderer.render({ type: "tool_call", name: funcName, args: funcArgs });

				try {
					const result = await executeTool(funcName, funcArgs, signal);
					renderer.render({ type: "tool_result", result, isError: false });

					// Add tool result to messages
					messages.push({
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					});
					logMessages(messages, `callChatModel:after_tool_${funcName}_success`);
				} catch (e: any) {
					renderer.render({ type: "tool_result", result: e.message, isError: true });
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
			renderer.render({ type: "assistant_message", text: message.content });
			messages.push({ role: "assistant", content: message.content });
			logMessages(messages, `callChatModel:pushed_final_assistant_response`);
			assistantResponded = true;
		}
	}

	if (!assistantResponded) {
		renderer.render({ type: "error", message: "Max rounds reached without response" });
	}
}

export class Agent {
	private client: OpenAI;
	private config: AgentConfig;
	private messages: any[] = [];
	private renderer: AgentRenderer;
	private abortController: AbortController | null = null;

	constructor(config: AgentConfig, renderer?: AgentRenderer) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
		});

		// Use provided renderer or default to console
		this.renderer = renderer || new ConsoleRenderer();

		// Initialize with system prompt if provided
		if (config.systemPrompt) {
			this.messages.push({ role: "system", content: config.systemPrompt });
		}
	}

	async chat(userMessage: string): Promise<void> {
		// Add user message
		this.messages.push({ role: "user", content: userMessage });
		// logMessages(this.messages, "agent:added_user_message");

		// Create a new AbortController for this chat session
		this.abortController = new AbortController();

		try {
			if (this.config.isGptOss) {
				await callModelResponses(
					this.client,
					this.config.model,
					this.messages,
					this.renderer,
					this.abortController.signal,
				);
			} else {
				await callModelChat(
					this.client,
					this.config.model,
					this.messages,
					this.renderer,
					this.abortController.signal,
				);
			}
		} catch (e: any) {
			// Check if this was an interruption
			if (e.message === "Interrupted" || this.abortController.signal.aborted) {
				// Don't show another message - TUI already shows it
				return;
			}
			// logMessages(this.messages, `agent:error_${e.status || "unknown"}`);
			throw e;
		} finally {
			this.abortController = null;
		}
	}

	interrupt(): void {
		if (this.abortController) {
			this.abortController.abort();
		}
	}

	getMessages(): any[] {
		return [...this.messages];
	}

	clearMessages(): void {
		// Keep system prompt if it exists
		this.messages = this.config.systemPrompt ? [{ role: "system", content: this.config.systemPrompt }] : [];
	}
}
