#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js"
import path from "node:path"
import express from "express"
import cors from "cors"

import { handleTranslateKey, handleMoveKey as handleMoveI18nKey, handleListLocales } from "./tool-handlers.js"

// Environment variables from MCP config
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "anthropic/claude-3.7-sonnet"
// Fix: Use parent directory as PROJECT_ROOT instead of current directory
const PROJECT_ROOT = path.resolve(process.cwd(), "..")

// Validate required environment variables
if (!OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY environment variable is required")
	process.exit(1)
}

// After validation, we know API key is defined (tell TypeScript)
const API_KEY: string = OPENROUTER_API_KEY as string

// Initialize the base paths for locales
const LOCALE_PATHS = {
	core: path.join(PROJECT_ROOT, "src/i18n/locales"),
	webview: path.join(PROJECT_ROOT, "webview-ui/src/i18n/locales"),
}

class TranslationServer {
	private server: Server

	constructor() {
		this.server = new Server(
			{
				name: "translation-mcp-server",
				version: "0.1.0",
			},
			{
				capabilities: {
					tools: {
						translate_i18n_key: {
							description: "Translate a specific key or keys from English to other languages",
							inputSchema: {
								type: "object",
								properties: {
									target: {
										type: "string",
										enum: ["core", "webview"],
										description: "Target directory (core or webview)",
									},
									paths: {
										type: "array",
										items: {
											type: "string",
										},
										description:
											'Array of paths to translate in English locale. Format: "filename:keyPath" (e.g., "kilocode:lowCreditWarning.nice") where the colon separates the filename from the key path. For parent keys (e.g., "kilocode:veryCool"), all child keys will be translated.',
									},
									useCurrentFile: {
										type: "boolean",
										description:
											"Use the currently open file as context for translation (optional)",
									},
									model: {
										type: "string",
										description: "Model to use for translation (optional)",
									},
									targetLocales: {
										type: "array",
										items: {
											type: "string",
										},
										description: "List of locale codes to translate to (empty for all)",
									},
								},
								required: ["target", "paths"],
							},
						},
						move_i18n_key: {
							description: "Move a key from one JSON file to another across all locales",
							inputSchema: {
								type: "object",
								properties: {
									target: {
										type: "string",
										enum: ["core", "webview"],
										description: "Target directory (core or webview)",
									},
									key: {
										type: "string",
										description: "Key to move (dot notation)",
									},
									source: {
										type: "string",
										description: 'Source file name (e.g., "common.json")',
									},
									destination: {
										type: "string",
										description: 'Destination file name (e.g., "tools.json")',
									},
									newKey: {
										type: "string",
										description: "Optional new key name for the destination",
									},
								},
								required: ["target", "key", "source", "destination"],
							},
						},
						list_locales: {
							description: "List all available locales",
							inputSchema: {
								type: "object",
								properties: {
									target: {
										type: "string",
										enum: ["core", "webview"],
										description: "Target directory (core or webview)",
									},
								},
								required: ["target"],
							},
						},
					},
				},
			},
		)

		this.setupToolHandlers()

		// Error handling
		this.server.onerror = (error) => console.error("[MCP Error]", error)
		process.on("SIGINT", async () => {
			await this.server.close()
			process.exit(0)
		})
	}

	private setupToolHandlers() {
		// Register available tools
		this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
			tools: [
				{
					name: "translate_i18n_key",
					description: "Translate a specific key or keys from English to other languages",
					inputSchema: {
						type: "object",
						properties: {
							target: {
								type: "string",
								enum: ["core", "webview"],
								description: "Target directory (core or webview)",
							},
							paths: {
								type: "array",
								items: {
									type: "string",
								},
								description:
									'Array of paths to translate in English locale. Format: "filename:keyPath" (e.g., "kilocode:lowCreditWarning.nice") where the colon separates the filename from the key path. For parent keys (e.g., "kilocode:veryCool"), all child keys will be translated.',
							},
							useCurrentFile: {
								type: "boolean",
								description: "Use the currently open file as context for translation (optional)",
							},
							model: {
								type: "string",
								description: "Model to use for translation (optional)",
							},
							targetLocales: {
								type: "array",
								items: {
									type: "string",
								},
								description: "List of locale codes to translate to (empty for all)",
							},
						},
						required: ["target", "paths"],
					},
				},
				{
					name: "move_i18n_key",
					description: "Move a key from one JSON file to another across all locales",
					inputSchema: {
						type: "object",
						properties: {
							target: {
								type: "string",
								enum: ["core", "webview"],
								description: "Target directory (core or webview)",
							},
							key: {
								type: "string",
								description: "Key to move (dot notation)",
							},
							source: {
								type: "string",
								description: 'Source file name (e.g., "common.json")',
							},
							destination: {
								type: "string",
								description: 'Destination file name (e.g., "tools.json")',
							},
							newKey: {
								type: "string",
								description: "Optional new key name for the destination",
							},
						},
						required: ["target", "key", "source", "destination"],
					},
				},
				{
					name: "list_locales",
					description: "List all available locales",
					inputSchema: {
						type: "object",
						properties: {
							target: {
								type: "string",
								enum: ["core", "webview"],
								description: "Target directory (core or webview)",
							},
						},
						required: ["target"],
					},
				},
			],
		}))

		// Handle tool calls
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
			try {
				const { name, arguments: args } = request.params

				// Pass environment variables to handlers
				const context = {
					LOCALE_PATHS,
					OPENROUTER_API_KEY: API_KEY,
					DEFAULT_MODEL,
				}

				switch (name) {
					case "translate_i18n_key":
						return await handleTranslateKey(args, context)
					case "move_i18n_key":
						return await handleMoveI18nKey(args, context)
					case "list_locales":
						return await handleListLocales(args, context)
					default:
						throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
				}
			} catch (error) {
				console.error(`[Error in ${request.params.name}]:`, error)
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				}
			}
		})
	}

	async run() {
		// Create an Express app
		const app = express()
		const port = process.env.MCP_SERVER_PORT ? parseInt(process.env.MCP_SERVER_PORT) : 3010

		// Enable CORS
		app.use(cors())

		// Parse JSON requests
		app.use(express.json())

		// Create a route for health checks
		app.get("/health", (req, res) => {
			res.status(200).send("OK")
		})

		// Store transports by session ID
		const transports: Record<string, SSEServerTransport> = {}

		// SSE endpoint for establishing the stream
		app.get("/mcp", async (req, res) => {
			console.error("Received GET request to /mcp (establishing SSE stream)")

			try {
				// Create a new SSE transport for the client
				const transport = new SSEServerTransport("/messages", res)

				// Store the transport by session ID
				const sessionId = transport.sessionId
				transports[sessionId] = transport

				// Set up onclose handler to clean up transport when closed
				transport.onclose = () => {
					console.error(`SSE transport closed for session ${sessionId}`)
					delete transports[sessionId]
				}

				// Connect the transport to the MCP server
				await this.server.connect(transport)
				console.error(`Established SSE stream with session ID: ${sessionId}`)
			} catch (error) {
				console.error("Error establishing SSE stream:", error)
				if (!res.headersSent) {
					res.status(500).send("Error establishing SSE stream")
				}
			}
		})

		// Messages endpoint for receiving client JSON-RPC requests
		app.post("/messages", async (req, res) => {
			console.error("Received POST request to /messages")

			// Extract session ID from URL query parameter
			const sessionId = req.query.sessionId as string

			if (!sessionId) {
				console.error("No session ID provided in request URL")
				res.status(400).send("Missing sessionId parameter")
				return
			}

			const transport = transports[sessionId]

			if (!transport) {
				console.error(`No active transport found for session ID: ${sessionId}`)
				res.status(404).send("Session not found")
				return
			}

			try {
				// Handle the POST message with the transport
				await transport.handlePostMessage(req, res, req.body)
			} catch (error) {
				console.error("Error handling request:", error)
				if (!res.headersSent) {
					res.status(500).send("Error handling request")
				}
			}
		})

		// Start the Express server
		const server = app.listen(port, () => {
			console.error(`Express server listening on port ${port}`)
		})

		// Log server status with timestamp for better visibility in the terminal
		const timestamp = new Date().toISOString()
		console.error(`[${timestamp}] ✅ MCP Translation server is ready to process requests`)
		console.error(`[${timestamp}] 📝 Available tools: translate_i18n_key, move_i18n_key, list_locales`)
		console.error(`[${timestamp}] 🔄 Auto-watching enabled - server will restart on file changes`)
		console.error(`[${timestamp}] 🌐 Server URL: http://localhost:${port}/mcp`)

		// Handle server shutdown
		process.on("SIGINT", () => {
			console.error("Shutting down Express server...")

			// Close all active transports to properly clean up resources
			for (const sessionId in transports) {
				try {
					console.error(`Closing transport for session ${sessionId}`)
					transports[sessionId].close()
					delete transports[sessionId]
				} catch (error) {
					console.error(`Error closing transport for session ${sessionId}:`, error)
				}
			}

			server.close()
			process.exit(0)
		})
	}
}

const server = new TranslationServer()
server.run().catch(console.error)
