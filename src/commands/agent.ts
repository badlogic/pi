import OpenAI from "openai";
import type { ResponseFunctionToolCallOutputItem } from "openai/resources/responses/responses.mjs";
import { ConsoleRenderer } from "./renderers/console-renderer";
import type { SessionManager } from "./session-manager";
import { executeTool, toolsForChat, toolsForResponses } from "./tools/tools";

export type AgentEvent =
	| { type: "assistant_start" }
	| { type: "thinking"; text: string }
	| { type: "tool_call"; toolCallId: string; name: string; args: string }
	| { type: "tool_result"; toolCallId: string; result: string; isError: boolean }
	| { type: "assistant_message"; text: string }
	| { type: "error"; message: string }
	| { type: "user_message"; text: string }
	| { type: "interrupted" }
	| {
			type: "token_usage";
			inputTokens: number;
			outputTokens: number;
			totalTokens: number;
			cacheReadTokens: number;
			cacheWriteTokens: number;
	  };

export interface AgentEventReceiver {
	on(event: AgentEvent): Promise<void>;
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

export async function callModelResponsesApi(
	client: OpenAI,
	model: string,
	messages: any[],
	signal?: AbortSignal,
	eventReceiver?: AgentEventReceiver,
): Promise<void> {
	await eventReceiver?.on({ type: "assistant_start" });

	let conversationDone = false;

	while (!conversationDone) {
		// Check if we've been interrupted
		if (signal?.aborted) {
			await eventReceiver?.on({ type: "interrupted" });
			throw new Error("Interrupted");
		}

		const response = await client.responses.create(
			{
				model,
				input: messages,
				tools: toolsForResponses,
				tool_choice: "auto",
				max_output_tokens: 2000, // TODO make configurable
			} as any,
			{ signal },
		);

		// Report token usage if available (responses API format)
		if (response.usage) {
			const usage = response.usage;
			eventReceiver?.on({
				type: "token_usage",
				inputTokens: usage.input_tokens || 0,
				outputTokens: usage.output_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cacheReadTokens: usage.input_tokens_details.cached_tokens || 0,
				cacheWriteTokens: 0, // Not available in API
			});
		}

		const output = response.output;
		if (!output) break;

		for (const item of output) {
			// gpt-oss vLLM quirk: need to remove type from "message" events
			if (item.id === "message") {
				const { type, ...message } = item;
				messages.push(item);
			} else {
				messages.push(item);
			}

			switch (item.type) {
				case "reasoning": {
					for (const content of item.content || []) {
						if (content.type === "reasoning_text") {
							await eventReceiver?.on({ type: "thinking", text: content.text });
						}
					}
					break;
				}

				case "message": {
					for (const content of item.content || []) {
						if (content.type === "output_text") {
							await eventReceiver?.on({ type: "assistant_message", text: content.text });
						} else if (content.type === "refusal") {
							await eventReceiver?.on({ type: "error", message: `Refusal: ${content.refusal}` });
						}
						conversationDone = true;
					}
					break;
				}

				case "function_call": {
					if (signal?.aborted) {
						await eventReceiver?.on({ type: "interrupted" });
						throw new Error("Interrupted");
					}

					try {
						await eventReceiver?.on({
							type: "tool_call",
							toolCallId: item.id || "",
							name: item.name,
							args: item.arguments,
						});
						const result = await executeTool(item.name, item.arguments, signal);
						await eventReceiver?.on({ type: "tool_result", toolCallId: item.id || "", result, isError: false });

						// Add tool result to messages
						const toolResultMsg = {
							type: "function_call_output",
							call_id: item.id,
							output: result,
						} as ResponseFunctionToolCallOutputItem;
						messages.push(toolResultMsg);
					} catch (e: any) {
						await eventReceiver?.on({
							type: "tool_result",
							toolCallId: item.id || "",
							result: e.message,
							isError: true,
						});
						const errorMsg = {
							type: "function_call_output",
							call_id: item.id,
							output: e.message,
							isError: true,
						};
						messages.push(errorMsg);
					}
					break;
				}

				default: {
					eventReceiver?.on({ type: "error", message: `Unknown output type in LLM response: ${item.type}` });
					break;
				}
			}
		}
	}
}

export async function callModelChatCompletionsApi(
	client: OpenAI,
	model: string,
	messages: any[],
	signal?: AbortSignal,
	eventReceiver?: AgentEventReceiver,
): Promise<void> {
	await eventReceiver?.on({ type: "assistant_start" });

	let assistantResponded = false;

	while (!assistantResponded) {
		if (signal?.aborted) {
			await eventReceiver?.on({ type: "interrupted" });
			throw new Error("Interrupted");
		}

		const response = await client.chat.completions.create(
			{
				model,
				messages,
				tools: toolsForChat,
				tool_choice: "auto",
				max_tokens: 2000, // TODO make configurable
			},
			{ signal },
		);

		const message = response.choices[0].message;

		// Report token usage if available
		if (response.usage) {
			const usage = response.usage;
			await eventReceiver?.on({
				type: "token_usage",
				inputTokens: usage.prompt_tokens || 0,
				outputTokens: usage.completion_tokens || 0,
				totalTokens: usage.total_tokens || 0,
				cacheReadTokens: usage.prompt_tokens_details?.cached_tokens || 0,
				cacheWriteTokens: 0, // Not available in API
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

			// Display and execute each tool call
			for (const toolCall of message.tool_calls) {
				// Check if interrupted before executing tool
				if (signal?.aborted) {
					await eventReceiver?.on({ type: "interrupted" });
					throw new Error("Interrupted");
				}

				try {
					const funcName = toolCall.type === "function" ? toolCall.function.name : toolCall.custom.name;
					const funcArgs = toolCall.type === "function" ? toolCall.function.arguments : toolCall.custom.input;

					await eventReceiver?.on({ type: "tool_call", toolCallId: toolCall.id, name: funcName, args: funcArgs });
					const result = await executeTool(funcName, funcArgs, signal);
					await eventReceiver?.on({ type: "tool_result", toolCallId: toolCall.id, result, isError: false });

					// Add tool result to messages
					const toolMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: result,
					};
					messages.push(toolMsg);
				} catch (e: any) {
					eventReceiver?.on({ type: "tool_result", toolCallId: toolCall.id, result: e.message, isError: true });
					const errorMsg = {
						role: "tool",
						tool_call_id: toolCall.id,
						content: e.message,
					};
					messages.push(errorMsg);
				}
			}
		} else if (message.content) {
			// Final assistant response
			eventReceiver?.on({ type: "assistant_message", text: message.content });
			const finalMsg = { role: "assistant", content: message.content };
			messages.push(finalMsg);
			assistantResponded = true;
		}
	}
}

export class Agent {
	private client: OpenAI;
	private config: AgentConfig;
	private messages: any[] = [];
	private renderer?: AgentEventReceiver;
	private sessionManager?: SessionManager;
	private comboReceiver: AgentEventReceiver;
	private abortController: AbortController | null = null;

	constructor(config: AgentConfig, renderer?: AgentEventReceiver, sessionManager?: SessionManager) {
		this.config = config;
		this.client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseURL,
		});

		// Use provided renderer or default to console
		this.renderer = renderer;
		this.sessionManager = sessionManager;

		this.comboReceiver = {
			on: async (event: AgentEvent): Promise<void> => {
				await this.renderer?.on(event);
				await this.sessionManager?.on(event);
			},
		};

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
		this.comboReceiver.on({ type: "user_message", text: userMessage });

		// Add user message
		const userMsg = { role: "user", content: userMessage };
		this.messages.push(userMsg);
		this.sessionManager?.logMessage(userMsg);

		// Create a new AbortController for this chat session
		this.abortController = new AbortController();

		try {
			if (this.config.isGptOss) {
				await callModelResponsesApi(
					this.client,
					this.config.model,
					this.messages,
					this.abortController.signal,
					this.comboReceiver,
				);
			} else {
				await callModelChatCompletionsApi(
					this.client,
					this.config.model,
					this.messages,
					this.abortController.signal,
					this.comboReceiver,
				);
			}
		} catch (e: any) {
			// Check if this was an interruption
			if (e.message === "Interrupted" || this.abortController.signal.aborted) {
				// Don't show another message - TUI already shows it
				return;
			}
			throw e;
		} finally {
			this.abortController = null;
		}
	}

	interrupt(): void {
		this.abortController?.abort();
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
