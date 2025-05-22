# Autocomplete Service

This directory contains the autocomplete functionality for Kilo Code. The service has been refactored for better maintainability and separation of concerns.

## Architecture

### Core Components

1. **AutocompleteProvider** (`AutocompleteProvider.ts`)

    - Main entry point implementing VS Code's `InlineCompletionItemProvider`
    - Coordinates between all other components
    - Handles registration and lifecycle management

2. **CompletionState** (`CompletionState.ts`)

    - Manages the state of autocomplete completions
    - Tracks preview states, loading states, and multi-line completion progress
    - Provides a centralized state management solution

3. **CompletionGenerator** (`CompletionGenerator.ts`)

    - Handles the generation of completion text
    - Manages API calls and streaming responses
    - Validates completion context
    - Cleans markdown code blocks from responses

4. **InlineCompletionHandler** (`InlineCompletionHandler.ts`)

    - Creates VS Code inline completion items
    - Handles multi-line completion acceptance logic
    - Manages preview visibility and dismissal

5. **DecorationManager** (`DecorationManager.ts`)
    - Manages loading and streaming indicators
    - Provides visual feedback during completion generation

### Supporting Components

- **AutocompleteConfig** - Configuration management
- **ContextGatherer** - Gathers code context for better completions
- **PromptRenderer** - Renders prompts for the AI model
- **CompletionCache** - Caches completions for performance

### Utilities

- **Debouncer** (`utils/Debouncer.ts`) - Generic debouncing utility for throttling updates
- **CompletionCache** (`utils/CompletionCache.ts`) - LRU cache for storing completions

## Features

- **Multi-line Completions**: Supports accepting completions line by line
- **Streaming Updates**: Shows completions as they stream from the API
- **Smart Context**: Uses imports and definitions for better completions
- **File Pattern Exclusions**: Can disable autocomplete for specific file patterns
- **Caching**: Caches completions to reduce API calls

## Configuration

The service respects the following VS Code settings:

- `kilo-code.autocomplete.debounceDelay` - Delay before triggering completions
- `kilo-code.autocomplete.disableInFiles` - File patterns to disable autocomplete

## Testing

Run tests with:

```bash
npm test -- src/services/autocomplete/__tests__/
```
