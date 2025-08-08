import chalk from "chalk";
import type { AgentEvent, AgentRenderer } from "../agent.js";

export class ConsoleRenderer implements AgentRenderer {
	render(event: AgentEvent): void {
		switch (event.type) {
			case "assistant_start":
				console.log(chalk.hex("#FFA500")("[assistant]"));
				break;

			case "thinking":
				console.log(chalk.dim("[thinking]"));
				console.log(chalk.dim(event.text));
				console.log();
				break;

			case "tool_call":
				console.log(chalk.yellow(`[tool] ${event.name}(${event.args})`));
				break;

			case "tool_result": {
				const lines = event.result.split("\n");
				const maxLines = 10;
				const truncated = lines.length > maxLines;
				const toShow = truncated ? lines.slice(0, maxLines) : lines;

				const text = toShow.join("\n");
				console.log(event.isError ? chalk.red(text) : chalk.gray(text));

				if (truncated) {
					console.log(chalk.dim(`... (${lines.length - maxLines} more lines)`));
				}
				console.log();
				break;
			}

			case "assistant_message":
				console.log(event.text);
				console.log();
				break;

			case "error":
				console.error(chalk.red(`[error] ${event.message}\n`));
				break;

			case "user_message":
				console.log(chalk.green("[user]"));
				console.log(event.text);
				console.log();
				break;
		}
	}
}
