import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import { EXPERIMENT_IDS, ExperimentId, experiments } from "../../shared/experiments"
import { AICommentData, FileChangeData, WatchModeConfig } from "./types"
import { WatchModeUI } from "./ui"
import { ApiHandler, buildApiHandler } from "../../api"
import { ContextProxy } from "../../core/config/ContextProxy"
import { writePromptToDebugFile, writePromptResponseToDebugFile } from "./PromptDebugger"
import {
	detectAIComments,
	buildAIPrompt,
	processAIResponse,
	updateAICommentPatterns,
	updateCurrentAICommentPrefix,
} from "./commentProcessor"
import { WatchModeHighlighter } from "./WatchModeHighlighter"

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
	private highlighter: WatchModeHighlighter
	private processingFiles: Set<string> = new Set()
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
		commentPrefix: "KILO!", // Default AI comment prefix
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
		this.log("Kilo WatchMode experiment active")

		this.outputChannel = outputChannel
		this.config = this.defaultConfig
		this.ui = new WatchModeUI(context)
		this.highlighter = new WatchModeHighlighter()

		this.setupApiHandler()

		// Listen to our own events to update the UI
		this.onDidChangeActiveState((isActive) => {
			this.ui.showStatus(isActive)
		})

		this.onDidStartProcessingComment(({ fileUri }) => {
			this.processingFiles.add(fileUri.toString())
			this.ui.showProcessing(this.processingFiles.size)
		})

		this.onDidFinishProcessingComment(({ fileUri, success }) => {
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
			commentPrefix: config.get("commentPrefix", this.defaultConfig.commentPrefix),
		}

		// Update the AI comment patterns with the configured prefix
		const { commentPrefix } = this.config
		this.log(`Using AI comment prefix: ${commentPrefix}`)

		// Use the imported functions from commentProcessor

		// Update the patterns and prefix
		updateAICommentPatterns(commentPrefix)
		updateCurrentAICommentPrefix(commentPrefix)
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

		this.log(`Scheduling processing for ${fileKey} with ${this.config.debounceTime}ms debounce`)

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
				this.log(`File excluded: matched pattern ${pattern}`)
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
			this.log(`Processing file: ${fileUri.fsPath}`)

			// Read the file content
			const document = await vscode.workspace.openTextDocument(fileUri)
			const content = document.getText()

			// Skip processing if file is too large
			if (content.length > 1000000) {
				// Skip files larger than ~1MB
				this.log(`Skipping large file: ${fileUri.fsPath}`)
				return
			}

			// Detect AI comments in the file
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

	private async processAIComment(document: vscode.TextDocument, comment: AICommentData): Promise<void> {
		try {
			this.log(
				`Processing AI comment: "${comment.content.substring(0, 50)}${comment.content.length > 50 ? "..." : ""}"`,
			)

			// Highlight the AI comment with animation
			const clearHighlight = this.highlighter.highlightAICommentWithAnimation(document, comment)

			// Emit event that we're starting to process this comment
			this._onDidStartProcessingComment.fire({ fileUri: document.uri, comment })

			// Build prompt from the comment and context
			this.log("Building AI prompt...")
			const prompt = buildAIPrompt(comment)
			this.log(`Prompt built, length: ${prompt.length} characters`)

			// Get response from AI model
			this.log("Calling AI model...")

			let apiResponse: string | null = null
			try {
				apiResponse = await this.callAIModel(prompt)
				this.log(`API response received, length: ${apiResponse?.length || 0} characters`)
			} catch (apiError) {
				this.log(`Error calling AI model: ${apiError instanceof Error ? apiError.message : String(apiError)}`)
				apiResponse = null
			}

			if (!apiResponse) {
				this.log("No response from AI model")
				this._onDidFinishProcessingComment.fire({
					fileUri: document.uri,
					comment,
					success: false,
				})
				clearHighlight()
				return
			}

			// Process the AI response
			this.log("Processing AI response...")
			let success = false
			try {
				success = await processAIResponse(document, comment, apiResponse)
				this.log(`Response processed, success: ${success}`)
			} catch (processError) {
				this.log(
					`Error processing response: ${processError instanceof Error ? processError.message : String(processError)}`,
				)
				this._onDidFinishProcessingComment.fire({
					fileUri: document.uri,
					comment,
					success: false,
				})
				clearHighlight()
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
		} catch (error) {
			this.log(`Error processing AI comment: ${error instanceof Error ? error.message : String(error)}`)
			this._onDidFinishProcessingComment.fire({
				fileUri: document.uri,
				comment,
				success: false,
			})
		}
	}

	/**
	 * Makes an API call to the AI model
	 * @param prompt The prompt to send to the AI model
	 */
	private async callAIModel(prompt: string): Promise<string> {
		this.log(`Calling AI model with prompt length: ${prompt.length} characters`)

		try {
			// Get the API handler from the extension
			if (!this.apiHandler) {
				throw new Error("this.apiHandler not available")
			}

			// Call the model with the prompt using the streaming API
			this.log(`Using model: ${this.config.model || this.apiHandler?.getModel()?.id || "unknown"}`)

			// Create a system message and a user message with the prompt
			const systemPrompt =
				"You are Kilo Code, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices."
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: prompt }]

			// Write prompt to debug file and store the debug ID
			this.currentDebugId = writePromptToDebugFile(systemPrompt, JSON.stringify(messages, null, 2))

			this.log("Creating message stream...")

			// Use the streaming API to get the response
			let fullResponse = ""
			let chunkCount = 0

			// Process the stream and collect the full response
			try {
				const messageStream = this.apiHandler?.createMessage(systemPrompt, messages)
				this.log("Message stream created successfully")

				for await (const chunk of messageStream) {
					chunkCount++
					if (chunk.type === "text") {
						fullResponse += chunk.text
					}
				}

				this.log(
					`Stream complete. Received ${chunkCount} chunks, total response length: ${fullResponse.length}`,
				)

				// Write the response to debug file using the same debug ID
				writePromptResponseToDebugFile(fullResponse, this.currentDebugId)
			} catch (streamError) {
				this.log(
					`Error processing stream: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
				)
				throw streamError
			}

			return fullResponse
		} catch (error) {
			this.log(`Error in callAIModel: ${error instanceof Error ? error.message : String(error)}`)
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
