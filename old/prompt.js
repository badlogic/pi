const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class PromptCommand {
    constructor(cli) {
        this.cli = cli;

        // Define tools that run LOCALLY
        this.tools = [
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: 'Read the contents of a file given its path',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: 'The path to the file to read'
                            }
                        },
                        required: ['path']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'list_directory',
                    description: 'List the contents of a directory',
                    parameters: {
                        type: 'object',
                        properties: {
                            path: {
                                type: 'string',
                                description: 'The path to the directory to list'
                            }
                        },
                        required: ['path']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'run_command',
                    description: 'Run a shell command locally',
                    parameters: {
                        type: 'object',
                        properties: {
                            command: {
                                type: 'string',
                                description: 'The command to run'
                            }
                        },
                        required: ['command']
                    }
                }
            }
        ];
    }

    async execute(name, message, podName = null) {
        const models = this.cli.getRunningModels(podName);
        const model = models[name];

        if (!model || !model.url) {
            console.error(`Model '${name}' is not running${podName ? ` on pod '${podName}'` : ''}`);
            console.error('Running models:', Object.keys(models).join(', ') || 'none');
            process.exit(1);
        }

        // Add current working directory to the prompt context
        const cwd = process.cwd();
        const enhancedMessage = `Current working directory: ${cwd}\n\n${message}`;
        
        // GPT-OSS models require the responses endpoint for tool support
        if (model.model_id?.toLowerCase().includes('gpt-oss')) {
            await this.promptWithResponses(model, enhancedMessage);
        } else {
            await this.promptWithChatCompletions(model, enhancedMessage);
        }
    }

    // Execute tools LOCALLY
    async executeToolCall(name, args) {
        try {
            switch (name) {
                case 'read_file': {
                    const filePath = path.resolve(args.path);
                    if (!fs.existsSync(filePath)) {
                        return `File not found: ${filePath}`;
                    }
                    const content = fs.readFileSync(filePath, 'utf8');
                    // Limit output size
                    if (content.length > 10000) {
                        return content.substring(0, 10000) + '\n... (truncated)';
                    }
                    return content;
                }

                case 'list_directory': {
                    const dirPath = path.resolve(args.path || '.');
                    if (!fs.existsSync(dirPath)) {
                        return `Directory not found: ${dirPath}`;
                    }
                    const files = fs.readdirSync(dirPath);
                    return files.join('\n');
                }

                case 'run_command': {
                    try {
                        const output = execSync(args.command, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
                        return output || 'Command executed successfully (no output)';
                    } catch (error) {
                        return `Command failed: ${error.message}`;
                    }
                }

                default:
                    return `Unknown function: ${name}`;
            }
        } catch (error) {
            return `Error executing ${name}: ${error.message}`;
        }
    }

    async promptWithResponses(model, message) {
        // GPT-OSS uses /v1/responses endpoint with different format
        const url = `${model.url}/responses`;
        
        // Convert tools to the format expected by responses endpoint
        const responsesTools = this.tools.map(t => ({
            type: 'function',
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters
        }));

        try {
            // First call - may have tool calls
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: model.model_id,
                    input: message,
                    tools: responsesTools,
                    tool_choice: 'auto',
                    max_output_tokens: 1000,
                    temperature: 0.7
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json();
            
            // Check if there are tool calls
            const toolCalls = data.output?.filter(item => 
                item.type === 'function_call'
            ) || [];

            if (toolCalls.length > 0) {
                // Execute tool calls locally
                const inputMessages = [
                    { role: 'user', content: message }
                ];
                
                // Add tool calls to input
                for (const toolCall of toolCalls) {
                    inputMessages.push(toolCall);
                }
                
                // Execute and add results
                for (const toolCall of toolCalls) {
                    const functionArgs = JSON.parse(toolCall.arguments);
                    const result = await this.executeToolCall(toolCall.name, functionArgs);
                    
                    inputMessages.push({
                        type: 'function_call_output',
                        call_id: toolCall.call_id || toolCall.id,
                        output: result
                    });
                }

                // Make follow-up call with tool results
                const followUpResponse = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: model.model_id,
                        input: inputMessages,
                        tools: responsesTools,
                        max_output_tokens: 1000,
                        temperature: 0.7
                    })
                });

                if (followUpResponse.ok) {
                    const followUpData = await followUpResponse.json();
                    console.log(followUpData.output_text || this.extractTextFromResponse(followUpData));
                } else {
                    console.error('Follow-up error:', await followUpResponse.text());
                }
            } else {
                // No tool calls, just print the response
                console.log(data.output_text || this.extractTextFromResponse(data));
            }
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    }

    async promptWithChatCompletions(model, message) {
        const openai = new OpenAI({
            baseURL: model.url,
            apiKey: 'dummy'
        });

        try {
            const completion = await openai.chat.completions.create({
                model: model.model_id,
                messages: [{ role: 'user', content: message }],
                tools: this.tools,
                tool_choice: 'auto',
                max_tokens: 1000,
                temperature: 0.7
            });

            const assistantMessage = completion.choices[0].message;

            if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
                // Execute tool calls locally
                const toolResults = [];
                for (const toolCall of assistantMessage.tool_calls) {
                    const functionArgs = JSON.parse(toolCall.function.arguments);
                    const result = await this.executeToolCall(toolCall.function.name, functionArgs);

                    toolResults.push({
                        tool_call_id: toolCall.id,
                        role: 'tool',
                        content: result
                    });
                }

                // Make follow-up call with tool results
                const followUpCompletion = await openai.chat.completions.create({
                    model: model.model_id,
                    messages: [
                        { role: 'user', content: message },
                        assistantMessage,
                        ...toolResults
                    ],
                    max_tokens: 1000,
                    temperature: 0.7
                });

                console.log(followUpCompletion.choices[0].message.content);
            } else {
                console.log(assistantMessage.content);
            }
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    }

    extractTextFromResponse(response) {
        if (response.output_text) return response.output_text;

        if (response.output && Array.isArray(response.output)) {
            for (const item of response.output) {
                if (item.type === 'message' && item.content) {
                    // Handle content array
                    if (Array.isArray(item.content)) {
                        for (const content of item.content) {
                            if ((content.type === 'text' || content.type === 'output_text') && content.text) {
                                return content.text;
                            }
                        }
                    }
                    // Handle direct text content
                    else if (typeof item.content === 'string') {
                        return item.content;
                    }
                }
            }
        }

        return 'No response generated';
    }
}

module.exports = PromptCommand;