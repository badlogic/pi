# TUI Integration Plan

## Phase 1: Event-based Architecture

- [x] Create event types in `src/commands/agent.ts`
  - [x] Define `AgentEvent` type union
  - [x] Define `AgentRenderer` interface

- [x] Create `src/commands/renderers/console-renderer.ts`
  - [x] Implement `ConsoleRenderer` class with current `display` behavior
  - [x] Export as default renderer

- [x] Refactor `src/commands/agent.ts`
  - [x] Update `Agent` class to accept optional renderer
  - [x] Replace `display.*` calls with event emissions in `callGptOssModel()`
  - [x] Replace `display.*` calls with event emissions in `callChatModel()`
  - [x] Remove global `display` object (kept minimal for backward compat)

## Phase 2: TUI Renderer

- [x] Add `@mariozechner/tui` dependency to `package.json` (linked locally)

- [x] Create `src/commands/renderers/tui-renderer.ts`
  - [x] Implement `TuiRenderer` class
  - [x] Handle all `AgentEvent` types
  - [x] Add TextEditor for multiline input (Shift+Enter for newline)
  - [x] Add scrollable chat history

## Phase 3: Integration

- [x] Update `src/commands/prompt.ts`
  - [x] Add `--ui <console|tui>` flag support
  - [x] Create appropriate renderer based on flag
  - [x] Pass renderer to Agent
  - [x] Handle input differently based on renderer type

- [x] Update `src/cli.ts`
  - [x] Add UI flag parsing for prompt command

## Phase 4: Testing & Polish

- [x] Test console renderer (default behavior unchanged)
- [x] Test TUI renderer with multiline input
- [x] Test switching between renderers
- [ ] Add error handling for TUI initialization failures
- [ ] Update README with new UI options