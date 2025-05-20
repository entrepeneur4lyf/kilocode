# Translation MCP Server

This is an MCP (Model Context Protocol) server for managing translations in the Kilocode project. It provides tools for translating strings across multiple locale files.

The server enables AI agents to efficiently handle translation tasks in parallel, significantly improving productivity when working with multiple locales. While currently focused on translation tools, this MCP server architecture can be extended to enable agents to perform any kind of parallel processing tasks, such as batch data processing, concurrent API calls, or distributed computing operations.

## Features

- Translate specific keys from English to other languages (single key or batch)
- Auto-detect file names for keys without explicit file prefixes
- Smart key suggestions when keys are not found
- Context-aware translation using currently open files
- Find and translate all missing translations
- Move internationalization keys between translation files
- List available locales

## Setup

1. Build the server:

```bash
npm run build
```

2. Register the server in your MCP settings file:

```json
{
	"mcpServers": {
		"translation": {
			"command": "node",
			"args": ["${mcpServersPath}/repo-mcp-server/build/index.js"],
			"env": {
				"OPENROUTER_API_KEY": "${input:openrouter_api_key}",
				"DEFAULT_MODEL": "anthropic/claude-3.7-sonnet",
				"PROJECT_ROOT": "${workspaceFolder}"
			}
		}
	},
	"inputs": [
		{
			"type": "promptString",
			"id": "openrouter_api_key",
			"description": "OpenRouter API Key",
			"password": true
		}
	]
}
```

## Usage

### Translate a specific key

```javascript
await mcpHub.callTool("translation", "translate_i18n_key", {
	target: "core", // or "webview"
	paths: ["common.welcome"], // path to the key in the English locale
	targetLocales: ["fr", "de"], // optional, if not provided, all locales will be translated
})
```

### Translate multiple keys (batch translation)

```javascript
await mcpHub.callTool("translation", "translate_i18n_key", {
	target: "core", // or "webview"
	paths: ["common.welcome", "common.goodbye", "common.error"], // array of paths to translate
	targetLocales: ["fr", "de"], // optional, if not provided, all locales will be translated
})
```

### Use context-aware translation

```javascript
await mcpHub.callTool("translation", "translate_i18n_key", {
	target: "core", // or "webview"
	paths: ["welcome", "goodbye"], // simple keys without file prefix
	useCurrentFile: true, // use currently open file as context
	targetLocales: ["fr", "de"], // optional
})
```

### Auto-detect file for a key

```javascript
await mcpHub.callTool("translation", "translate_i18n_key", {
	target: "core", // or "webview"
	paths: ["welcome"], // simple key without file prefix - will be auto-detected
	targetLocales: ["fr", "de"], // optional
})
```

### Move an i18n key between files

```javascript
await mcpHub.callTool("translation", "move_i18n_key", {
	target: "core", // or "webview"
	key: "error.notFound", // key to move
	source: "common.json", // source file
	destination: "errors.json", // destination file
	newKey: "notFound", // optional, if not provided, the original key will be used
})
```

### List available locales

```javascript
await mcpHub.callTool("translation", "list_locales", {
	target: "core", // or "webview"
})
```

## Testing

You can test the server using the provided test script:

```bash
node test-translation.js
```

This will show you the commands you can use to test the server manually.

## Environment Variables

- `OPENROUTER_API_KEY`: API key for OpenRouter (required)
- `DEFAULT_MODEL`: Model to use for translation (default: "anthropic/claude-3.7-sonnet")
- `PROJECT_ROOT`: Root directory of the project (default: current working directory)
- `VSCODE_OPEN_FILES`: JSON string of currently open files (used for context-aware translation)

## Key Format Options

The translation tool supports several key format options:

1. **Full path format**: `filename.path.to.key` (e.g., `kilocode.lowCreditWarning.bogus`)
2. **Parent key format**: `filename:parentKey` (translates all child keys under the parent)
3. **Simple key format**: `keyName` (auto-detects the file by searching all locale files)

When a key is not found, the tool will suggest similar keys that might be what you're looking for.
