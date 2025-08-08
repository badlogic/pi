import { createInterface } from "readline";
import type { Agent } from "./agent.js";
import type { AgentEventReceiver } from "./agent.js";

interface JsonCommand {
	type: "message" | "interrupt";
	content?: string;
}

export class JsonInteractive {
	private agent: Agent;
	private renderer: AgentEventReceiver;
	private rl: ReturnType<typeof createInterface>;
	private isProcessing = false;
	private pendingMessage: string | null = null;

	constructor(agent: Agent, renderer: AgentEventReceiver) {
		this.agent = agent;
		this.renderer = renderer;
		this.rl = createInterface({
			input: process.stdin,
			output: process.stdout,
			terminal: false, // Don't interpret control characters
		});
	}

	async start(): Promise<void> {
		// Listen for lines from stdin
		this.rl.on("line", (line) => {
			this.handleInput(line);
		});

		// Wait for stdin to close
		return new Promise((resolve) => {
			this.rl.on("close", () => {
				resolve();
			});
		});
	}

	private handleInput(line: string): void {
		try {
			const command = JSON.parse(line) as JsonCommand;
			
			switch (command.type) {
				case "interrupt":
					this.agent.interrupt();
					break;
					
				case "message":
					if (!command.content) {
						this.renderer.on({ type: "error", message: "Message content is required" });
						return;
					}
					
					if (this.isProcessing) {
						// Queue the message for when the agent is done
						this.pendingMessage = command.content;
					} else {
						this.processMessage(command.content);
					}
					break;
					
				default:
					this.renderer.on({ type: "error", message: `Unknown command type: ${(command as any).type}` });
			}
		} catch (e) {
			this.renderer.on({ type: "error", message: `Invalid JSON: ${e}` });
		}
	}

	private async processMessage(content: string): Promise<void> {
		this.isProcessing = true;
		
		try {
			await this.agent.ask(content);
		} catch (e: any) {
			await this.renderer.on({ type: "error", message: e.message });
		} finally {
			this.isProcessing = false;
			
			// Process any pending message
			if (this.pendingMessage) {
				const msg = this.pendingMessage;
				this.pendingMessage = null;
				await this.processMessage(msg);
			}
		}
	}

	stop(): void {
		this.rl.close();
	}
}