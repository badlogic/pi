import {
	TUI,
	Container,
	TextEditor,
	MarkdownComponent,
	TextComponent,
	WhitespaceComponent,
} from "@mariozechner/tui";
import chalk from "chalk";
import type { AgentEvent, AgentRenderer } from "../agent.js";

export class TuiRenderer implements AgentRenderer {
	private ui: TUI;
	private chatContainer: Container;
	private editor: TextEditor;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;

	constructor() {
		this.ui = new TUI();
		this.chatContainer = new Container();
		this.editor = new TextEditor();
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		// Add header
		const header = new TextComponent(
			chalk.gray("─".repeat(80)) + "\n" +
			chalk.dim("Interactive mode. Enter to send, Shift+Enter for new line, Ctrl+C to quit.") + "\n" +
			chalk.gray("─".repeat(80)),
			{ bottom: 1 }
		);

		// Setup UI layout
		this.ui.addChild(header);
		this.ui.addChild(this.chatContainer);
		this.ui.addChild(new WhitespaceComponent(1));
		this.ui.addChild(this.editor);
		this.ui.setFocus(this.editor);

		// Handle editor submission
		this.editor.onSubmit = (text: string) => {
			text = text.trim();
			if (!text) return;

			// Show user message in chat
			this.chatContainer.addChild(new TextComponent(chalk.green("[user]")));
			this.chatContainer.addChild(new TextComponent(text, { bottom: 1 }));
			this.ui.requestRender();

			// Trigger callback if set
			if (this.onInputCallback) {
				this.onInputCallback(text);
			}
		};

		// Start the UI
		await this.ui.start();
		this.isInitialized = true;
	}

	async render(event: AgentEvent): Promise<void> {
		// Ensure UI is initialized
		if (!this.isInitialized) {
			await this.init();
		}

		switch (event.type) {
			case 'assistant_start':
				this.chatContainer.addChild(new TextComponent(chalk.hex("#FFA500")("[assistant]")));
				break;

			case 'thinking':
				// Show thinking in dim text
				const thinkingContainer = new Container();
				thinkingContainer.addChild(new TextComponent(chalk.dim("[thinking]")));
				
				// Split thinking text into lines for better display
				const thinkingLines = event.text.split('\n');
				for (const line of thinkingLines) {
					thinkingContainer.addChild(new TextComponent(chalk.dim(line)));
				}
				thinkingContainer.addChild(new WhitespaceComponent(1));
				this.chatContainer.addChild(thinkingContainer);
				break;

			case 'tool_call':
				this.chatContainer.addChild(
					new TextComponent(chalk.yellow(`[tool] ${event.name}(${event.args})`))
				);
				break;

			case 'tool_result': {
				// Show tool result with truncation
				const lines = event.result.split("\n");
				const maxLines = 10;
				const truncated = lines.length > maxLines;
				const toShow = truncated ? lines.slice(0, maxLines) : lines;

				const resultContainer = new Container();
				for (const line of toShow) {
					resultContainer.addChild(
						new TextComponent(
							event.isError ? chalk.red(line) : chalk.gray(line)
						)
					);
				}
				
				if (truncated) {
					resultContainer.addChild(
						new TextComponent(chalk.dim(`... (${lines.length - maxLines} more lines)`))
					);
				}
				resultContainer.addChild(new WhitespaceComponent(1));
				this.chatContainer.addChild(resultContainer);
				break;
			}

			case 'assistant_message':
				// Use MarkdownComponent for rich formatting
				this.chatContainer.addChild(new MarkdownComponent(event.text));
				this.chatContainer.addChild(new WhitespaceComponent(1));
				break;

			case 'error':
				this.chatContainer.addChild(
					new TextComponent(chalk.red(`[error] ${event.message}`), { bottom: 1 })
				);
				break;

			case 'user_message':
				// User message already shown when submitted, skip here
				break;

			case 'conversation_end':
				// No special handling needed
				break;
		}

		this.ui.requestRender();
	}

	async getUserInput(): Promise<string> {
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined; // Clear callback
				resolve(text);
			};
		});
	}

	stop(): void {
		if (this.isInitialized) {
			this.ui.stop();
			this.isInitialized = false;
		}
	}
}