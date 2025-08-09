#!/usr/bin/env node
import { createInterface } from "readline";
import type { AgentEventReceiver } from "./agent.js";
import { Agent } from "./agent.js";
import { parseArgs, printHelp } from "./args.js";

// Define argument structure
const argDefs = {
	"base-url": {
		type: "string" as const,
		default: "https://api.openai.com/v1",
		description: "API base URL",
	},
	"api-key": {
		type: "string" as const,
		default: process.env.OPENAI_API_KEY || "",
		description: "API key",
		showDefault: "$OPENAI_API_KEY",
	},
	model: {
		type: "string" as const,
		default: "gpt-5-mini",
		description: "Model name",
	},
	api: {
		type: "string" as const,
		default: "completions",
		description: "API type",
		choices: [
			{ value: "completions", description: "OpenAI Chat Completions API (most models)" },
			{ value: "responses", description: "OpenAI Responses API (GPT-OSS models)" },
		],
	},
	"system-prompt": {
		type: "string" as const,
		default: "You are a helpful assistant.",
		description: "System prompt",
	},
	continue: {
		type: "flag" as const,
		alias: "c",
		description: "Continue previous session",
	},
	json: {
		type: "flag" as const,
		description: "Output as JSONL",
	},
	help: {
		type: "flag" as const,
		alias: "h",
		description: "Show this help message",
	},
};

interface JsonCommand {
	type: "message" | "interrupt";
	content?: string;
}

async function runJsonInteractiveMode(agent: Agent, renderer: AgentEventReceiver): Promise<void> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: false, // Don't interpret control characters
	});

	let isProcessing = false;
	let pendingMessage: string | null = null;

	const processMessage = async (content: string): Promise<void> => {
		isProcessing = true;

		try {
			await agent.ask(content);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		} finally {
			isProcessing = false;

			// Process any pending message
			if (pendingMessage) {
				const msg = pendingMessage;
				pendingMessage = null;
				await processMessage(msg);
			}
		}
	};

	// Listen for lines from stdin
	rl.on("line", (line) => {
		try {
			const command = JSON.parse(line) as JsonCommand;

			switch (command.type) {
				case "interrupt":
					agent.interrupt();
					isProcessing = false;
					break;

				case "message":
					if (!command.content) {
						renderer.on({ type: "error", message: "Message content is required" });
						return;
					}

					if (isProcessing) {
						// Queue the message for when the agent is done
						pendingMessage = command.content;
					} else {
						processMessage(command.content);
					}
					break;

				default:
					renderer.on({ type: "error", message: `Unknown command type: ${(command as any).type}` });
			}
		} catch (e) {
			renderer.on({ type: "error", message: `Invalid JSON: ${e}` });
		}
	});

	// Wait for stdin to close
	await new Promise<void>((resolve) => {
		rl.on("close", () => {
			resolve();
		});
	});
}

async function runTuiInteractiveMode(agent: Agent, renderer: any): Promise<void> {
	const tui = renderer;

	tui.setInterruptCallback(() => {
		agent.interrupt();
	});

	while (true) {
		const userInput = await tui.getUserInput();
		if (userInput.toLowerCase() === "exit" || userInput.toLowerCase() === "quit") {
			tui.stop();
			break;
		}

		try {
			await agent.ask(userInput);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
		}
	}
}

async function runSingleShotMode(agent: Agent, renderer: AgentEventReceiver, messages: string[]): Promise<void> {
	for (const msg of messages) {
		try {
			await agent.ask(msg);
		} catch (e: any) {
			await renderer.on({ type: "error", message: e.message });
			// Continue with next message even if one fails
		}
	}
}

// Main function to use Agent as standalone CLI
export async function main(args: string[]): Promise<void> {
	// Parse arguments
	const parsed = parseArgs(argDefs, args);

	// Show help if requested
	if (parsed.help) {
		const usage = `Usage: pi-agent [options] [messages...]

Examples:
  # Single message
  pi-agent --api-key sk-... "What is 2+2?"

  # Multiple messages (processed sequentially)
  pi-agent "What is 2+2?" "What about 3+3?"

  # JSON output
  pi-agent --json "What is 2+2?"

  # Interactive mode (no messages = interactive)
  pi-agent --api-key sk-...

  # Interactive JSON mode (for programmatic UIs)
  pi-agent --json

  # Continue previous session
  pi-agent --continue "Follow up question"

  # Use local vLLM
  pi-agent --base-url http://localhost:8000/v1 --model meta-llama/Llama-3.1-8B-Instruct "Hello"`;

		printHelp(argDefs, usage);
		return;
	}

	// Extract configuration from parsed args
	const baseURL = parsed["base-url"];
	const apiKey = parsed["api-key"];
	const model = parsed.model;
	const continueSession = parsed.continue;
	const api = parsed.api as "completions" | "responses";
	const systemPrompt = parsed["system-prompt"];
	const jsonOutput = parsed.json;
	const messages = parsed._; // Positional arguments

	if (!apiKey) {
		throw new Error("API key required (use --api-key or set OPENAI_API_KEY)");
	}

	// Import dependencies
	const { ConsoleRenderer } = await import("./renderers/console-renderer.js");
	const { SessionManager } = await import("./session-manager.js");
	const { TuiRenderer } = await import("./renderers/tui-renderer.js");
	const { JsonRenderer } = await import("./renderers/json-renderer.js");

	// Determine mode: interactive if no messages provided
	const isInteractive = messages.length === 0;

	// Create renderer based on mode and json flag
	let renderer: AgentEventReceiver;
	if (jsonOutput) {
		renderer = new JsonRenderer();
	} else if (isInteractive) {
		renderer = new TuiRenderer();
	} else {
		renderer = new ConsoleRenderer();
	}

	// Show configuration in interactive TUI mode only
	if (isInteractive && !jsonOutput) {
		console.log(`Using: ${baseURL} with model ${model}`);
		if (!apiKey || apiKey === "dummy") {
			console.log("Warning: No valid API key provided. Set OPENAI_API_KEY or use --api-key");
		}
	}

	// Create session manager
	const sessionManager = new SessionManager(continueSession);

	// Create or restore agent
	let agent: Agent;

	if (continueSession) {
		const sessionData = sessionManager.getSessionData();
		if (sessionData) {
			// Resume with existing config
			if (!jsonOutput) {
				console.log(`Resuming session with ${sessionData.events.length} events`);
			}
			agent = new Agent(
				{
					...sessionData.config,
					apiKey, // Allow overriding API key
				},
				renderer,
				sessionManager,
			);
			// Restore events
			const agentEvents = sessionData.events.map((e) => e.event);
			agent.setEvents(agentEvents);

			// Replay events to renderer for visual continuity
			if (isInteractive && renderer instanceof TuiRenderer) {
				await renderer.init();
				for (const sessionEvent of sessionData.events) {
					const event = sessionEvent.event;
					if (event.type === "assistant_start") {
						renderer.renderAssistantLabel();
					} else {
						await renderer.on(event);
					}
				}
			}
		} else {
			if (!jsonOutput) {
				console.log("No previous session found, starting new session");
			}
			agent = new Agent(
				{
					apiKey,
					baseURL,
					model,
					api,
					systemPrompt: "You are a helpful assistant.",
				},
				renderer,
				sessionManager,
			);
		}
	} else {
		agent = new Agent(
			{
				apiKey,
				baseURL,
				model,
				api,
				systemPrompt,
			},
			renderer,
			sessionManager,
		);
	}

	// Run in appropriate mode
	if (isInteractive) {
		if (jsonOutput) {
			await runJsonInteractiveMode(agent, renderer);
		} else {
			await runTuiInteractiveMode(agent, renderer);
		}
	} else {
		await runSingleShotMode(agent, renderer, messages);
	}
}

// Run as CLI if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
