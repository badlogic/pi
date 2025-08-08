import chalk from "chalk";
import { spawn } from "child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { glob } from "glob";
import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
import { resolve } from "path";
import { ConsoleRenderer } from "./renderers/console-renderer";
import type { SessionManager } from "./session-manager";

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

function logMessage(message: any, context: string) {
	const timestamp = new Date().toISOString();
	const logEntry = {
		timestamp,
		context,
		message: JSON.parse(JSON.stringify(message)), // Deep clone to avoid mutations
	};

	try {
		// Append to prompts.jsonl (JSONL format - one JSON object per line)
		const logFile = "prompts.jsonl";
		const line = JSON.stringify(logEntry) + "\n";

		// Use appendFileSync for efficient append-only logging
		appendFileSync(logFile, line);
	} catch (e) {
		// Silently fail logging - don't interrupt the main flow
		console.error(chalk.dim(`[log error] ${e}`));
	}
}

// Reconstruct messages array from JSONL log file
export function reconstructMessagesFromLog(): {
	messages: any[];
	sessions: Array<{ startTime: string; messages: any[] }>;
} {
	try {
		const logFile = "prompts.jsonl";
		if (!existsSync(logFile)) {
			return { messages: [], sessions: [] };
		}

		const content = readFileSync(logFile, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((line) => line);

		const sessions: Array<{ startTime: string; messages: any[] }> = [];
		let currentSession: any[] = [];
		let sessionStartTime: string | null = null;

		for (const line of lines) {
			try {
				const entry = JSON.parse(line);

				// Start new session on initial context
				if (entry.context.includes("initial")) {
					if (currentSession.length > 0 && sessionStartTime) {
						sessions.push({ startTime: sessionStartTime, messages: [...currentSession] });
					}
					currentSession = [];
					sessionStartTime = entry.timestamp;

					// For initial messages, we log each message individually
					if (entry.message && typeof entry.message === "object") {
						currentSession.push(entry.message);
					}
				} else if (entry.context.includes("pushed") || entry.context.includes("after_tool")) {
					// These contexts indicate a new message was added
					if (entry.message && typeof entry.message === "object") {
						currentSession.push(entry.message);
					}
				} else if (entry.context === "agent:added_user_message") {
					// User message - convert string to message object
					currentSession.push({ role: "user", content: entry.message });
				}
			} catch (e) {
				// Skip malformed lines
				console.error(chalk.dim(`[log parse error] ${e}`));
			}
		}

		// Add final session if exists
		if (currentSession.length > 0 && sessionStartTime) {
			sessions.push({ startTime: sessionStartTime, messages: currentSession });
		}

		// Return the last session's messages as the current messages array
		const lastSession = sessions[sessions.length - 1];
		return {
			messages: lastSession ? lastSession.messages : [],
			sessions,
		};
	} catch (e) {
		console.error(chalk.dim(`[log read error] ${e}`));
		return { messages: [], sessions: [] };
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
	sessionManager?: SessionManager,
): Promise<void> {
	// Show assistant label at the start
	renderer.render({ type: "assistant_start" });

	// Log initial messages
	for (const msg of messages) {
		logMessage(msg, "callGptOssModel:initial");
	}

	let conversationDone = false;
	const maxRounds = 10000;

	for (let round = 0; round < maxRounds && !conversationDone; round++) {
		// Check if we've been interrupted
		if (signal?.aborted) {
			throw new Error("Interrupted");
		}

		// Log before API call
		logMessage({ round, messageCount: messages.length }, `callGptOssModel:before_api_round_${round}`);

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
			// Log usage to session
			sessionManager?.logUsage({
				prompt_tokens: usage.prompt_tokens || 0,
				completion_tokens: usage.completion_tokens || 0,
				total_tokens: usage.total_tokens || 0,
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
				const toolResultMsg = {
					type: "function_call_output",
					call_id: toolCall.id,
					output: result,
				} as ResponseFunctionToolCallOutputItem;
				messages.push(toolResultMsg);
				sessionManager?.logMessage(toolResultMsg);
				logMessage(toolResultMsg, `callGptOssModel:after_tool_${toolCall.name}_success`);
			} catch (e: any) {
				renderer.render({ type: "tool_result", result: e.message, isError: true });
				const errorMsg = {
					type: "function_call_output",
					call_id: toolCall.id,
					output: e.message,
				};
				messages.push(errorMsg);
				sessionManager?.logMessage(errorMsg);
				logMessage(errorMsg, `callGptOssModel:after_tool_${toolCall.name}_error`);
			}
		};

		for (const item of output) {
			// vLLM+gpt-oss quirk: remove 'type' field from message items to avoid 400 errors
			if (item.type === "message") {
				const { type, ...messageWithoutType } = item;
				messages.push(messageWithoutType);
				sessionManager?.logMessage(messageWithoutType);
				logMessage(messageWithoutType, `callGptOssModel:pushed_message_without_type`);
			} else {
				messages.push(item);
				sessionManager?.logMessage(item);
				logMessage(item, `callGptOssModel:pushed_${item.type}`);
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
	sessionManager?: SessionManager,
): Promise<void> {
	// Show assistant label at the start
	renderer.render({ type: "assistant_start" });

	// Log initial messages
	for (const msg of messages) {
		logMessage(msg, "callChatModel:initial");
	}

	const maxRounds = 10000;
	let assistantResponded = false;

	for (let round = 0; round < maxRounds && !assistantResponded; round++) {
		// Check if we've been interrupted
		if (signal?.aborted) {
			throw new Error("Interrupted");
		}

		// Log before API call
		logMessage({ round, messageCount: messages.length }, `callChatModel:before_api_round_${round}`);

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
			// Log usage to session
			sessionManager?.logUsage({
				prompt_tokens: response.usage.prompt_tokens,
				completion_tokens: response.usage.completion_tokens,
				total_tokens: response.usage.total_tokens,
				cache_read_tokens: (response.usage as any).cache_read_input_tokens,
				cache_write_tokens: (response.usage as any).cache_creation_input_tokens,
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
			sessionManager?.logMessage(assistantMsg);
			logMessage(assistantMsg, `callChatModel:pushed_assistant_with_tools`);

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
					const toolMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					};
					messages.push(toolMsg);
					sessionManager?.logMessage(toolMsg);
					logMessage(toolMsg, `callChatModel:after_tool_${funcName}_success`);
				} catch (e: any) {
					renderer.render({ type: "tool_result", result: e.message, isError: true });
					const errorMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					};
					messages.push(errorMsg);
					sessionManager?.logMessage(errorMsg);
					logMessage(errorMsg, `callChatModel:after_tool_${funcName}_error`);
				}
			}
		} else if (message.content) {
			// Final assistant response
			renderer.render({ type: "assistant_message", text: message.content });
			const finalMsg = { role: "assistant", content: message.content };
			messages.push(finalMsg);
			sessionManager?.logMessage(finalMsg);
			logMessage(finalMsg, `callChatModel:pushed_final_assistant_response`);
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
	private sessionManager?: SessionManager;

	constructor(config: AgentConfig, renderer?: AgentRenderer, sessionManager?: SessionManager) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
		});

		// Use provided renderer or default to console
		this.renderer = renderer || new ConsoleRenderer();
		this.sessionManager = sessionManager;

		// Initialize with system prompt if provided
		if (config.systemPrompt) {
			this.messages.push({ role: "system", content: config.systemPrompt });
			// Log to session if this is a new session
			if (sessionManager && this.messages.length === 1) {
				sessionManager.logSession({
					model: config.model,
					baseURL: config.baseURL,
					isGptOss: config.isGptOss,
					systemPrompt: config.systemPrompt,
				});
				sessionManager.logMessage({ role: "system", content: config.systemPrompt });
			}
		}
	}

	async chat(userMessage: string): Promise<void> {
		// Render user message through the event system
		this.renderer.render({ type: "user_message", text: userMessage });

		// Add user message
		const userMsg = { role: "user", content: userMessage };
		this.messages.push(userMsg);
		this.sessionManager?.logMessage(userMsg);
		logMessage(userMessage, "agent:added_user_message");

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
					this.sessionManager,
				);
			} else {
				await callModelChat(
					this.client,
					this.config.model,
					this.messages,
					this.renderer,
					this.abortController.signal,
					this.sessionManager,
				);
			}
		} catch (e: any) {
			// Check if this was an interruption
			if (e.message === "Interrupted" || this.abortController.signal.aborted) {
				// Don't show another message - TUI already shows it
				return;
			}
			logMessage({ error: e.message, status: e.status }, `agent:error_${e.status || "unknown"}`);
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

	setMessages(messages: any[]): void {
		this.messages = [...messages];
	}

	clearMessages(): void {
		// Keep system prompt if it exists
		this.messages = this.config.systemPrompt ? [{ role: "system", content: this.config.systemPrompt }] : [];
	}
}
