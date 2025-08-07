#!/usr/bin/env node

import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://86.38.238.70:8001/v1',
  apiKey: 'dummy',
});

function getWeather({ location, unit = 'fahrenheit' }) {
  const temp = unit === 'celsius' ? 22 : 72;
  const result = {
    location,
    temperature: `${temp}°${unit === 'celsius' ? 'C' : 'F'}`,
    conditions: 'Partly cloudy',
    humidity: '65%',
    wind: '10 mph NW'
  };
  console.log(`🔧 get_weather(${location}, ${unit}):`, result);
  return JSON.stringify(result);
}

const tools = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a given location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'The city and state, e.g. San Francisco, CA' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'The temperature unit' }
      },
      required: ['location']
    }
  }
}];

async function main() {
  const messages = [{
    role: 'user',
    content: 'What is the weather like in San Francisco and New York?'
  }];

  console.log('💬 User:', messages[0].content);

  while (true) {
    console.log('\n📤 Sending request...');
    const response = await openai.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages,
      tools,
      tool_choice: 'auto'
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    console.log('📥 Assistant:', msg.content || '(no content)');
    if (msg.tool_calls) console.log('   Tool calls:', msg.tool_calls.length);

    if (msg.tool_calls?.length > 0) {
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        const result = getWeather(args);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result
        });
      }
      continue;
    }

    if (response.choices[0].finish_reason) {
      console.log('✅ Stop reason:', response.choices[0].finish_reason);
      break;
    }
  }

  console.log('\n📜 Final conversation:', messages.length, 'messages');
}

main().catch(console.error);