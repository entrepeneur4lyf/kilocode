import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import { EXPERIMENT_IDS, ExperimentId, experiments } from "../../shared/experiments"
import { detectAIComments, buildAIPrompt, processAIResponse } from "./commentProcessor"
import { AICommentData, FileChangeData, WatchModeConfig } from "./types"
import { WatchModeUI } from "./ui"
import { ApiHandler, buildApiHandler } from "../../api"
import { ContextProxy } from "../../core/config/ContextProxy"
import { writePromptToDebugFile, writePromptResponseToDebugFile } from "./PromptDebugger"

/**
 * Service that watches files for changes and processes AI comments
 */
export class WatchModeService {
	private apiHandler: ApiHandler | null = null
	private watchers: Map<string, vscode.FileSystemWatcher> = new Map()
	private pendingProcessing: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private isActive: boolean = false
	private outputChannel?: vscode.OutputChannel
	private ui: WatchModeUI
	private processingFiles: Set<string> = new Set()

	/**
	 * Tracks the current debug session ID for linking prompts with their responses
	 * This ID is generated when writing a prompt and used when writing the corresponding response
	 */
	private currentDebugId?: string

	// Event emitters
	private readonly _onDidChangeActiveState = new vscode.EventEmitter<boolean>()
	private readonly _onDidStartProcessingComment = new vscode.EventEmitter<{
		fileUri: vscode.Uri
		comment: AICommentData
	}>()
	private readonly _onDidFinishProcessingComment = new vscode.EventEmitter<{
		fileUri: vscode.Uri
		comment: AICommentData
		success: boolean
	}>()

	// Event handlers
	readonly onDidChangeActiveState = this._onDidChangeActiveState.event
	readonly onDidStartProcessingComment = this._onDidStartProcessingComment.event
	readonly onDidFinishProcessingComment = this._onDidFinishProcessingComment.event

	private readonly defaultConfig: WatchModeConfig = {
		include: ["**/*.{js,jsx,ts,tsx,py,java,go,rb,php,c,cpp,h,cs}"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**"],
		model: "claude-3.7",
		debounceTime: 2000, // 2 seconds
	}
	private config: WatchModeConfig

	/**
	 * Creates a new instance of the WatchModeService
	 * @param context The extension context
	 * @param outputChannel Optional output channel for logging
	 */
	constructor(
		private readonly context: vscode.ExtensionContext,
		outputChannel?: vscode.OutputChannel,
	) {
		console.log("👀👀👀 Kilo WatchMode experiment active!")

		this.outputChannel = outputChannel
		this.config = this.defaultConfig
		this.ui = new WatchModeUI(context)

		this.setupApiHandler()

		// Use the real keys from kilocode config

		// Listen to our own events to update the UI
		this.onDidChangeActiveState((isActive) => {
			this.ui.showStatus(isActive)
		})

		this.onDidStartProcessingComment(({ fileUri }) => {
			this.processingFiles.add(fileUri.toString())
			this.ui.showProcessing(this.processingFiles.size)
		})

		this.onDidFinishProcessingComment(({ fileUri, success }) => {
			// comment is unused but required for type matching
			this.processingFiles.delete(fileUri.toString())

			if (this.processingFiles.size === 0) {
				this.ui.hideProcessing()
			} else {
				this.ui.showProcessing(this.processingFiles.size)
			}

			const filePath = vscode.workspace.asRelativePath(fileUri)
			if (success) {
				this.ui.showSuccessNotification(filePath, 1)
			}
		})
	}

	private async setupApiHandler() {
		if (this.apiHandler) return

		const contextProxy = await ContextProxy.getInstance(this.context)
		const providerSettings = contextProxy.getProviderSettings()

		this.apiHandler = buildApiHandler(providerSettings)
	}

	/**
	 * Logs a message to the output channel if available
	 * @param message The message to log
	 */
	private log(message: string): void {
		if (this.outputChannel) {
			this.outputChannel.appendLine(`[WatchMode] ${message}`)
		}
	}

	/**
	 * Checks if the watch mode experiment is enabled
	 */
	private isExperimentEnabled(): boolean {
		const experimentsConfig = (this.context.globalState.get("experiments") || {}) as Record<ExperimentId, boolean>
		const isEnabled = experiments.isEnabled(experimentsConfig, EXPERIMENT_IDS.WATCH_MODE)
		this.log(`Watch mode experiment config: ${JSON.stringify(experimentsConfig)}`)
		this.log(`Watch mode experiment enabled: ${isEnabled}`)
		return isEnabled
	}

	/**
	 * Loads configuration from settings
	 */
	private loadConfig(): void {
		const config = vscode.workspace.getConfiguration("kilo-code.watchMode")

		this.config = {
			include: config.get("include", this.defaultConfig.include),
			exclude: config.get("exclude", this.defaultConfig.exclude),
			model: config.get("model", this.defaultConfig.model),
			debounceTime: config.get("debounceTime", this.defaultConfig.debounceTime),
		}
	}

	/**
	 * Initializes file system watchers
	 */
	private initializeWatchers(): void {
		this.disposeWatchers() // Clean up any existing watchers first

		this.config.include.forEach((pattern) => {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0]?.uri || "", pattern),
				false, // Don't ignore creates
				false, // Don't ignore changes
				true, // Ignore deletes
			)

			// Handle file creation events
			watcher.onDidCreate((uri: vscode.Uri) =>
				this.handleFileChange({
					fileUri: uri,
					type: vscode.FileChangeType.Created,
				}),
			)

			// Handle file change events
			watcher.onDidChange((uri: vscode.Uri) => {
				this.log(`File changed: ${uri.toString()}`)
				return this.handleFileChange({
					fileUri: uri,
					type: vscode.FileChangeType.Changed,
				})
			})

			const watcherId = `watcher-${pattern}`
			this.watchers.set(watcherId, watcher)
			this.context.subscriptions.push(watcher)

			this.log(`Initialized file watcher for pattern: ${pattern}`)
		})
	}

	/**
	 * Handles file change events
	 * @param data File change event data
	 */
	private handleFileChange(data: FileChangeData): void {
		const { fileUri } = data

		this.log(`Handling file change for: ${fileUri.toString()}`)

		// Skip excluded files
		if (this.isFileExcluded(fileUri)) {
			this.log(`File excluded: ${fileUri.toString()}`)
			return
		}

		// Debounce processing to avoid multiple rapid triggers
		const fileKey = fileUri.toString()

		if (this.pendingProcessing.has(fileKey)) {
			clearTimeout(this.pendingProcessing.get(fileKey))
			this.pendingProcessing.delete(fileKey)
		}

		this.log(`Scheduling file processing with ${this.config.debounceTime}ms debounce: ${fileKey}`)

		const timeout = setTimeout(async () => {
			this.log(`Debounce complete, processing file: ${fileKey}`)
			await this.processFile(fileUri)
			this.pendingProcessing.delete(fileKey)
		}, this.config.debounceTime)

		this.pendingProcessing.set(fileKey, timeout)
	}

	/**
	 * Checks if a file should be excluded from processing
	 * @param uri File URI to check
	 */
	private isFileExcluded(uri: vscode.Uri): boolean {
		const relativePath = vscode.workspace.asRelativePath(uri)
		this.log(`Checking if file is excluded: ${relativePath}`)

		// Convert glob patterns to proper regex patterns
		const isExcluded = this.config.exclude.some((pattern) => {
			// Escape special regex characters except * and ?
			const escapedPattern = pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".")

			const regExp = new RegExp(`^${escapedPattern}$`)
			const result = regExp.test(relativePath)

			if (result) {
				this.log(`File matched exclude pattern: ${pattern}`)
			}

			return result
		})

		return isExcluded
	}

	/**
	 * Processes a file to find and handle AI comments
	 * @param fileUri URI of the file to process
	 */
	private async processFile(fileUri: vscode.Uri): Promise<void> {
		try {
			this.log(`Starting to process file: ${fileUri.fsPath}`)

			// Read the file content
			const document = await vscode.workspace.openTextDocument(fileUri)
			const content = document.getText()
			this.log(`File opened, content length: ${content.length} bytes, language: ${document.languageId}`)

			// Skip processing if file is too large
			if (content.length > 1000000) {
				// Skip files larger than ~1MB
				this.log(`Skipping large file: ${fileUri.fsPath}`)
				return
			}

			this.log(`Processing file: ${fileUri.fsPath}`)

			// Detect AI comments in the file
			this.log(`Detecting AI comments in file: ${fileUri.fsPath}`)
			const result = detectAIComments({
				fileUri,
				content,
				languageId: document.languageId,
			})

			if (result.errors) {
				result.errors.forEach((error) => {
					this.log(`Error processing file: ${error.message}`)
					this.ui.showErrorNotification(error.message)
				})
			}

			if (result.comments.length === 0) {
				this.log(`No AI comments found in file: ${fileUri.fsPath}`)
				return // No comments found, nothing to do
			}

			this.log(`Found ${result.comments.length} AI comments in ${fileUri.fsPath}`)

			// Process each AI comment
			for (const comment of result.comments) {
				await this.processAIComment(document, comment)
			}
		} catch (error) {
			this.log(
				`Error processing file ${fileUri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Highlights an AI comment in the editor with a glowing blue animation
	 * @param document The document containing the comment
	 * @param comment The AI comment data
	 * @returns A function to clear the highlight
	 */
	private highlightAICommentWithAnimation(document: vscode.TextDocument, comment: AICommentData): () => void {
		// Get the editor for the document
		const editor = vscode.window.visibleTextEditors.find(
			(editor) => editor.document.uri.toString() === document.uri.toString(),
		)

		if (!editor) {
			// Return a no-op function if no editor was found
			return () => {}
		}

		// Create a range for the comment
		const range = new vscode.Range(comment.startPos, comment.endPos)

		// Create decorations with different intensities for the pulsing effect
		const decorationBright = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(0, 122, 255, 0.4)",
			borderColor: "rgba(0, 122, 255, 0.9)",
			borderWidth: "1px",
			borderStyle: "solid",
			isWholeLine: true,
		})

		const decorationDim = vscode.window.createTextEditorDecorationType({
			backgroundColor: "rgba(0, 122, 255, 0.1)",
			borderColor: "rgba(0, 122, 255, 0.6)",
			borderWidth: "1px",
			borderStyle: "solid",
			isWholeLine: true,
		})

		// Start with the bright decoration
		let isBright = true
		editor.setDecorations(decorationBright, [range])

		// Create an interval to toggle between bright and dim
		const interval = setInterval(() => {
			if (isBright) {
				editor.setDecorations(decorationBright, [])
				editor.setDecorations(decorationDim, [range])
			} else {
				editor.setDecorations(decorationDim, [])
				editor.setDecorations(decorationBright, [range])
			}
			isBright = !isBright
		}, 100) // Toggle every 800ms for a gentle pulsing effect

		// Return a function to clear the highlight and stop the animation
		return () => {
			clearInterval(interval)
			decorationBright.dispose()
			decorationDim.dispose()
		}
	}

	private async processAIComment(document: vscode.TextDocument, comment: AICommentData): Promise<void> {
		this.log("=== DEBUGGING: processAIComment START ===")
		console.log("[WatchMode DEBUG] processAIComment started")

		try {
			this.log(
				`Processing AI comment: "${comment.content.substring(0, 50)}${comment.content.length > 50 ? "..." : ""}"`,
			)
			console.log("[WatchMode DEBUG] Processing comment:", comment.content.substring(0, 100))

			// Highlight the AI comment with animation
			const clearHighlight = this.highlightAICommentWithAnimation(document, comment)
			this.log("Comment highlighted with animation in editor")

			// Emit event that we're starting to process this comment
			this._onDidStartProcessingComment.fire({ fileUri: document.uri, comment })
			this.log("Fired onDidStartProcessingComment event")

			// Build prompt from the comment and context
			this.log("Building AI prompt...")
			const prompt = buildAIPrompt(comment)
			this.log(`Prompt built, length: ${prompt.length} characters`)
			console.log("[WatchMode DEBUG] Prompt built, length:", prompt.length)

			// Get response from AI model
			this.log("Calling AI model...")
			console.log("[WatchMode DEBUG] About to call AI model")

			let apiResponse: string | null = null
			try {
				apiResponse = await this.callAIModel(prompt)
				this.log(`API response received, length: ${apiResponse?.length || 0} characters`)
				console.log("[WatchMode DEBUG] API response received, length:", apiResponse?.length || 0)

				if (apiResponse) {
					console.log("[WatchMode DEBUG] API response preview:", apiResponse.substring(0, 100))
				}
			} catch (apiError) {
				this.log(`Error calling AI model: ${apiError instanceof Error ? apiError.message : String(apiError)}`)
				console.error("[WatchMode DEBUG] Error calling AI model:", apiError)

				// The callAIModel method already writes the error to the debug file,
				// but we need to make sure we don't try to write the response again
				apiResponse = null
			}

			if (!apiResponse) {
				this.log("No response from AI model")
				console.error("[WatchMode DEBUG] No response from AI model")

				// Write error information to debug file
				if (this.currentDebugId) {
					writePromptResponseToDebugFile("Error: No response received from AI model", this.currentDebugId)
					// Reset the debug ID since we're done with this session
					this.currentDebugId = undefined
				}

				this._onDidFinishProcessingComment.fire({
					fileUri: document.uri,
					comment,
					success: false,
				})
				clearHighlight()
				this.log("=== DEBUGGING: processAIComment END (no response) ===")
				return
			}

			// Process the AI response
			this.log("Processing AI response...")
			console.log("[WatchMode DEBUG] Processing AI response")
			let success = false
			try {
				success = await processAIResponse(document, comment, apiResponse)
				this.log(`Response processed, success: ${success}`)
				console.log("[WatchMode DEBUG] Response processed, success:", success)
			} catch (processError) {
				this.log(
					`Error processing response: ${processError instanceof Error ? processError.message : String(processError)}`,
				)
				console.error("[WatchMode DEBUG] Error processing response:", processError)
				this._onDidFinishProcessingComment.fire({
					fileUri: document.uri,
					comment,
					success: false,
				})
				clearHighlight()
				this.log("=== DEBUGGING: processAIComment END (process error) ===")
				return
			}

			if (success) {
				this.log(`Successfully applied AI response to ${document.uri.fsPath}`)
			} else {
				this.log(`Failed to apply AI response to ${document.uri.fsPath}`)
			}

			// Emit event that we've finished processing this comment
			this._onDidFinishProcessingComment.fire({
				fileUri: document.uri,
				comment,
				success,
			})

			// Clear the highlight
			clearHighlight()

			// Reset the debug ID after processing is complete
			this.currentDebugId = undefined

			this.log("=== DEBUGGING: processAIComment END ===")
		} catch (error) {
			this.log(`Error processing AI comment: ${error instanceof Error ? error.message : String(error)}`)
			console.error("[WatchMode DEBUG] Error in processAIComment:", error)
			this._onDidFinishProcessingComment.fire({
				fileUri: document.uri,
				comment,
				success: false,
			})

			// Reset the debug ID after processing is complete (even with error)
			this.currentDebugId = undefined

			this.log("=== DEBUGGING: processAIComment END (with error) ===")
		}
	}

	/**
	 * Makes an API call to the AI model
	 * @param prompt The prompt to send to the AI model
	 */
	private async callAIModel(prompt: string): Promise<string> {
		this.log("=== DEBUGGING: callAIModel START ===")
		this.log(`Prompt length: ${prompt.length} characters`)
		console.log(`[WatchMode DEBUG] callAIModel called with prompt length: ${prompt.length}`)

		try {
			// Get the API handler from the extension
			this.log("Attempting to get API handler...")
			if (!this.apiHandler) {
				throw new Error("this.apiHandler not available")
			}

			// Log API handler details
			this.log(`API handler model: ${this.apiHandler?.getModel()?.id || "unknown"}`)

			// Call the model with the prompt using the streaming API
			this.log(`Using model: ${this.config.model}`)

			// Create a system message and a user message with the prompt
			const systemPrompt =
				"You are Kilo Code, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }]

			// Write prompt to debug file and store the debug ID
			this.currentDebugId = writePromptToDebugFile(systemPrompt, JSON.stringify(messages, null, 2))

			this.log("Creating message stream...")
			console.log("[WatchMode DEBUG] About to call createMessage on API handler")

			// Use the streaming API to get the response
			let fullResponse = ""
			let chunkCount = 0

			// Process the stream and collect the full response
			try {
				const messageStream = this.apiHandler?.createMessage(systemPrompt, messages)
				this.log("Message stream created successfully")
				console.log("[WatchMode DEBUG] Message stream created successfully")

				for await (const chunk of messageStream) {
					chunkCount++
					if (chunk.type === "text") {
						fullResponse += chunk.text
						if (chunkCount % 10 === 0) {
							this.log(`Response so far (${fullResponse.length} chars)`)
						}
					}
				}

				console.log(
					`[WatchMode DEBUG] Stream complete. Received ${chunkCount} chunks, total response length: ${fullResponse.length}`,
				)

				// Write the response to debug file using the same debug ID
				writePromptResponseToDebugFile(fullResponse, this.currentDebugId)
			} catch (streamError) {
				console.error("[WatchMode DEBUG] Error in stream processing:", streamError)
				this.log(
					`Error processing stream: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
				)

				// Write stream error information to debug file
				if (this.currentDebugId) {
					const errorMessage = `Error in stream processing:\n${streamError instanceof Error ? streamError.stack || streamError.message : String(streamError)}`
					writePromptResponseToDebugFile(errorMessage, this.currentDebugId)
				}

				throw streamError
			}

			this.log("=== DEBUGGING: callAIModel END ===")
			return fullResponse
		} catch (error) {
			console.error("[WatchMode DEBUG] Error in callAIModel:", error)
			this.log(`Error in callAIModel: ${error instanceof Error ? error.message : String(error)}`)

			// Write error information to debug file
			if (this.currentDebugId) {
				const errorMessage = `Error in API call:\n${error instanceof Error ? error.stack || error.message : String(error)}`
				writePromptResponseToDebugFile(errorMessage, this.currentDebugId)
			}

			this.log("=== DEBUGGING: callAIModel END (with error) ===")
			throw error
		}
	}

	/**
	 * Disposes all file system watchers
	 */
	private disposeWatchers(): void {
		this.log(`Disposing ${this.watchers.size} watchers`)
		for (const watcher of this.watchers.values()) {
			watcher.dispose()
		}
		this.watchers.clear()
	}

	/**
	 * Starts the watch mode service
	 * @returns True if the service was started, false otherwise
	 */
	public start(): boolean {
		if (this.isActive) {
			this.log("Watch mode is already active")
			return false
		}

		if (!this.isExperimentEnabled()) {
			this.log("Watch mode experiment is not enabled")
			return false
		}

		this.log("Starting watch mode")
		this.loadConfig()
		this.initializeWatchers()
		this.isActive = true
		this._onDidChangeActiveState.fire(true)
		this.log("Watch mode started")
		return true
	}

	/**
	 * Stops the watch mode service
	 */
	public stop(): void {
		if (!this.isActive) {
			this.log("Watch mode is not active")
			return
		}

		this.log("Stopping watch mode")
		this.disposeWatchers()

		// Clear any pending processing
		for (const timeout of this.pendingProcessing.values()) {
			clearTimeout(timeout)
		}
		this.pendingProcessing.clear()

		this.isActive = false
		this._onDidChangeActiveState.fire(false)
		this.log("Watch mode stopped")
	}

	/**
	 * Returns whether the watch mode service is active
	 */
	public isWatchModeActive(): boolean {
		return this.isActive
	}

	/**
	 * Toggles the watch mode service
	 * @returns True if the service is now active, false otherwise
	 */
	public toggle(): boolean {
		if (this.isActive) {
			this.stop()
			return false
		} else {
			return this.start()
		}
	}

	/**
	 * Enables the watch mode service (alias for start)
	 * @returns True if the service was enabled, false otherwise
	 */
	public enable(): boolean {
		return this.start()
	}

	/**
	 * Disables the watch mode service (alias for stop)
	 */
	public disable(): void {
		this.stop()
	}

	/**
	 * Disposes the watch mode service
	 */
	public dispose(): void {
		this.stop()
		this._onDidChangeActiveState.dispose()
		this._onDidStartProcessingComment.dispose()
		this._onDidFinishProcessingComment.dispose()
	}
}
