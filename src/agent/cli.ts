#!/usr/bin/env node
import { Agent } from "./agent.js";
import type { AgentConfig, AgentEventReceiver } from "./agent.js";

// Main function to use Agent as standalone CLI
export async function main(args: string[]): Promise<void> {
	// Parse command line arguments
	let baseURL = "https://api.openai.com/v1";
	let apiKey = process.env.OPENAI_API_KEY || "";
	let model = "gpt-4o-mini";
	let continueSession = false;
	let api: "completions" | "responses" = "completions";
	let systemPrompt = "You are a helpful assistant.";
	let jsonOutput = false;

	// Collect messages (non-flag arguments)
	const messages: string[] = [];
	
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--base-url" && i + 1 < args.length) {
			baseURL = args[++i];
		} else if (args[i] === "--api-key" && i + 1 < args.length) {
			apiKey = args[++i];
		} else if (args[i] === "--model" && i + 1 < args.length) {
			model = args[++i];
		} else if (args[i] === "--continue") {
			continueSession = true;
		} else if (args[i] === "--api" && i + 1 < args.length) {
			api = args[++i] as "completions" | "responses";
		} else if (args[i] === "--system-prompt" && i + 1 < args.length) {
			systemPrompt = args[++i];
		} else if (args[i] === "--json") {
			jsonOutput = true;
		} else if (args[i] === "--help" || args[i] === "-h") {
			console.log(`Usage: pi-agent [options] [messages...]

Options:
  --base-url <url>        API base URL (default: https://api.openai.com/v1)
  --api-key <key>         API key (or set OPENAI_API_KEY env var)
  --model <model>         Model name (default: gpt-4o-mini)
  --api <type>            API type: "completions" or "responses" (default: completions)
  --system-prompt <text>  System prompt (default: "You are a helpful assistant.")
  --continue              Continue previous session
  --json                  Output as JSONL (for both single-shot and interactive modes)
  --help, -h              Show this help message

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
  pi-agent --base-url http://localhost:8000/v1 --model meta-llama/Llama-3.1-8B-Instruct "Hello"
`);
			return;
		} else if (!args[i].startsWith("-")) {
			// This is a message (not a flag)
			messages.push(args[i]);
		}
		// Ignore unrecognized flags
	}

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
		// Interactive mode
		if (jsonOutput) {
			// JSON interactive mode - read commands from stdin
			const { JsonInteractive } = await import("./json-interactive.js");
			const jsonHandler = new JsonInteractive(agent, renderer);
			await jsonHandler.start();
		} else {
			// Interactive mode with TUI
			const tui = renderer as InstanceType<typeof TuiRenderer>;
			await tui.init();

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
	} else {
		// Single-shot mode: process all messages sequentially
		for (const msg of messages) {
			try {
				await agent.ask(msg);
			} catch (e: any) {
				await renderer.on({ type: "error", message: e.message });
				// Continue with next message even if one fails
			}
		}
	}
}

// Run as CLI if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).catch((err) => {
		console.error(err);
		process.exit(1);
	});
}