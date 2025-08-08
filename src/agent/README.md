# pi-agent

Standalone OpenAI-compatible agent with tool calling and session persistence.

## Installation

```bash
npm install -g @mariozechner/pi
```

This installs both `pi` and `pi-agent` commands.

## Quick Start

```bash
# Single message (uses OPENAI_API_KEY from environment)
pi-agent "What is 2+2?"

# Multiple messages processed sequentially
pi-agent "What is 2+2?" "What about 3+3?"

# Interactive chat mode (no messages = interactive)
pi-agent

# Continue previous session
pi-agent --continue "Follow up question"
```

## Usage Modes

### Single-Shot Mode
Process one or more messages and exit:
```bash
pi-agent "First question" "Second question"
```

### Interactive Mode
Start an interactive chat session:
```bash
pi-agent
```
- Type messages and press Enter to send
- Type `exit` or `quit` to end session
- Press Escape to interrupt while processing

### JSON Mode
Output events as JSONL for programmatic integration:
```bash
# Single message with JSON output
pi-agent --json "What is 2+2?"

# Interactive JSON mode - accepts commands via stdin
echo '{"type": "message", "content": "Hello"}' | pi-agent --json
```

JSON commands:
- `{"type": "message", "content": "..."}` - Send a message
- `{"type": "interrupt"}` - Interrupt current processing

## Configuration

### Command Line Options
```
--base-url <url>        API base URL (default: https://api.openai.com/v1)
--api-key <key>         API key (or set OPENAI_API_KEY env var)
--model <model>         Model name (default: gpt-4o-mini)
--api <type>            API type: "completions" or "responses" (default: completions)
--system-prompt <text>  System prompt (default: "You are a helpful assistant.")
--continue              Continue previous session
--json                  Output as JSONL
--help, -h              Show help message
```

### Environment Variables
- `OPENAI_API_KEY` - OpenAI API key (used if --api-key not provided)

## Examples

### Use with OpenAI
```bash
export OPENAI_API_KEY=sk-...
pi-agent "Explain quantum computing"
```

### Use with Local vLLM
```bash
pi-agent --base-url http://localhost:8000/v1 \
         --model meta-llama/Llama-3.1-8B-Instruct \
         --api-key dummy \
         "Hello"
```

### Use with Claude/Anthropic
```bash
pi-agent --base-url https://api.anthropic.com/v1 \
         --api-key $ANTHROPIC_API_KEY \
         --model claude-3-opus-20240229 \
         "What is consciousness?"
```

### Build a UI with JSON Mode
```javascript
import { spawn } from 'child_process';

const agent = spawn('pi-agent', ['--json']);

// Send message
agent.stdin.write(JSON.stringify({
  type: 'message',
  content: 'What is 2+2?'
}) + '\n');

// Handle events
agent.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  for (const line of lines) {
    if (line.trim()) {
      const event = JSON.parse(line);
      console.log('Event:', event.type);
      // Handle event based on type
    }
  }
});
```

## Session Persistence

Sessions are automatically saved to `~/.pi/sessions/` and include:
- Complete conversation history
- Tool call results
- Token usage statistics

Use `--continue` to resume the last session:
```bash
pi-agent "Start a story about a robot"
# ... later ...
pi-agent --continue "Continue the story"
```

## Tools

The agent includes built-in tools for file system operations:
- **read_file** - Read file contents
- **list_directory** - List directory contents  
- **bash** - Execute shell commands
- **glob** - Find files by pattern
- **ripgrep** - Search file contents

These tools are automatically available when using the agent through the `pi` command for code navigation tasks.

## Event Types

When using `--json`, the agent outputs these event types:
- `user_message` - User input
- `assistant_start` - Assistant begins responding
- `assistant_message` - Assistant's response
- `thinking` - Reasoning/thinking (for models that support it)
- `tool_call` - Tool being called
- `tool_result` - Result from tool
- `token_usage` - Token usage statistics
- `error` - Error occurred
- `interrupted` - Processing was interrupted

## Architecture

The agent is built with:
- **agent.ts** - Core Agent class and API functions
- **cli.ts** - CLI entry point and argument parsing
- **args.ts** - Custom typed argument parser
- **session-manager.ts** - Session persistence
- **json-interactive.ts** - JSON command handler
- **tools/** - Tool implementations
- **renderers/** - Output formatters (console, TUI, JSON)

## Development

```bash
# Run from source
npx tsx src/agent/cli.ts "Hello"

# Build
npm run build

# Run built version
dist/agent/cli.js "Hello"
```