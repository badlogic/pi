import type { AgentEvent, AgentEventReceiver } from "../agent.js";

export class JsonRenderer implements AgentEventReceiver {
	async on(event: AgentEvent): Promise<void> {
		// Output each event as a single line of JSON
		console.log(JSON.stringify(event));
	}
}