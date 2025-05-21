import * as vscode from "vscode"
import { EXPERIMENT_IDS, ExperimentId, experiments } from "../../shared/experiments"
import { detectAIComments, buildAIPrompt, processAIResponse, applyAIResponseToDocument } from "./commentProcessor"
import { AICommentData, FileChangeData, WatchModeConfig } from "./types"
import { WatchModeUI } from "./ui"

/**
 * Service that watches files for changes and processes AI comments
 */
export class WatchModeService {
	private watchers: Map<string, vscode.FileSystemWatcher> = new Map()
	private pendingProcessing: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private isActive: boolean = false
	private outputChannel?: vscode.OutputChannel
	private ui: WatchModeUI
	private processingFiles: Set<string> = new Set()

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
		this.outputChannel = outputChannel
		this.config = this.defaultConfig
		this.ui = new WatchModeUI(context)

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
		return experiments.isEnabled(experimentsConfig, EXPERIMENT_IDS.WATCH_MODE)
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
			watcher.onDidChange((uri: vscode.Uri) =>
				this.handleFileChange({
					fileUri: uri,
					type: vscode.FileChangeType.Changed,
				}),
			)

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
			return
		}

		// Debounce processing to avoid multiple rapid triggers
		const fileKey = fileUri.toString()

		if (this.pendingProcessing.has(fileKey)) {
			clearTimeout(this.pendingProcessing.get(fileKey))
			this.pendingProcessing.delete(fileKey)
		}

		const timeout = setTimeout(async () => {
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

		return this.config.exclude.some((pattern) => {
			const regExp = new RegExp(pattern.replace(/\*/g, ".*"))
			return regExp.test(relativePath)
		})
	}

	/**
	 * Processes a file to find and handle AI comments
	 * @param fileUri URI of the file to process
	 */
	private async processFile(fileUri: vscode.Uri): Promise<void> {
		try {
			// Read the file content
			const document = await vscode.workspace.openTextDocument(fileUri)
			const content = document.getText()

			// Skip processing if file is too large
			if (content.length > 1000000) {
				// Skip files larger than ~1MB
				this.log(`Skipping large file: ${fileUri.fsPath}`)
				return
			}

			this.log(`Processing file: ${fileUri.fsPath}`)

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
	 * Processes a single AI comment
	 * @param document The document containing the comment
	 * @param comment The AI comment data
	 */
	private async processAIComment(document: vscode.TextDocument, comment: AICommentData): Promise<void> {
		try {
			this.log(
				`Processing AI comment: "${comment.content.substring(0, 50)}${comment.content.length > 50 ? "..." : ""}"`,
			)

			// Emit event that we're starting to process this comment
			this._onDidStartProcessingComment.fire({ fileUri: document.uri, comment })

			// Build prompt from the comment and context
			const prompt = buildAIPrompt(comment)

			// Get response from AI model - using the extension's existing API system
			// Note: This is a placeholder for the actual API call
			// In a real implementation, this would use the extension's API handling system
			const apiResponse = await this.callAIModel(prompt)

			if (!apiResponse) {
				this.log("No response from AI model")
				this._onDidFinishProcessingComment.fire({
					fileUri: document.uri,
					comment,
					success: false,
				})
				return
			}

			// Process the AI response
			const processedResponse = await processAIResponse({
				commentData: comment,
				response: apiResponse,
			})

			// Apply the processed response to the document
			const success = await applyAIResponseToDocument(document, comment, processedResponse)

			if (success) {
				this.log(`Successfully applied AI response to ${document.uri.fsPath}`)
			} else {
				this.log(`Failed to apply AI response to ${document.uri.fsPath}`)
			}

			// Emit event that we've finished processing
			this._onDidFinishProcessingComment.fire({
				fileUri: document.uri,
				comment,
				success,
			})
		} catch (error) {
			this.log(`Error processing AI comment: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Makes an API call to the AI model
	 * @param prompt The prompt to send to the AI model
	 */
	private async callAIModel(_prompt: string): Promise<string | null> {
		// TODO: Implement the actual API call using the extension's API handling system
		// This is a placeholder that should be replaced with actual API integration

		// For now, just simulate a response
		try {
			this.log("Calling AI model with prompt")

			// In real implementation, this would call the extension's API handling system
			// For example:
			// const api = await getAPIService()
			// const response = await api.callModel(this.config.model, prompt)

			// Simulate API delay
			await new Promise((resolve) => setTimeout(resolve, 500))

			return "```\n// Placeholder AI response\nconsole.log('AI processed this comment');\n```"
		} catch (error) {
			this.log(`API call error: ${error instanceof Error ? error.message : String(error)}`)
			return null
		}
	}

	/**
	 * Disposes all file system watchers
	 */
	private disposeWatchers(): void {
		this.watchers.forEach((watcher) => {
			watcher.dispose()
		})
		this.watchers.clear()
	}

	/**
	 * Starts the watch mode service if the experiment is enabled
	 */
	public start(): boolean {
		if (!this.isExperimentEnabled()) {
			this.log("Watch mode experiment is not enabled. Not starting the service.")
			return false
		}

		if (this.isActive) {
			this.log("Watch mode service is already active")
			return true
		}

		this.log("Starting watch mode service")
		this.loadConfig()
		this.initializeWatchers()
		this.isActive = true

		// Notify that the active state changed
		this._onDidChangeActiveState.fire(this.isActive)
		return true
	}

	/**
	 * Stops the watch mode service and disposes resources
	 */
	public stop(): void {
		if (!this.isActive) {
			return
		}

		this.log("Stopping watch mode service")
		this.disposeWatchers()

		// Clear any pending processing
		this.pendingProcessing.forEach((timeout) => {
			clearTimeout(timeout)
		})
		this.pendingProcessing.clear()

		this.isActive = false

		// Notify that the active state changed
		this._onDidChangeActiveState.fire(this.isActive)
	}

	/**
	 * Disposes the service
	 */
	/**
	 * Returns whether the watch mode is currently active
	 */
	public isWatchModeActive(): boolean {
		return this.isActive
	}

	/**
	 * Enables the watch mode
	 */
	public enable(): boolean {
		return this.start()
	}

	/**
	 * Disables the watch mode
	 */
	public disable(): void {
		this.stop()
	}

	/**
	 * Toggles watch mode on/off
	 */
	public toggle(): boolean {
		if (this.isActive) {
			this.disable()
			return false
		} else {
			return this.enable()
		}
	}

	/**
	 * Disposes the service
	 */
	public dispose(): void {
		this.stop()
		this.ui.dispose()
		this._onDidChangeActiveState.dispose()
		this._onDidStartProcessingComment.dispose()
		this._onDidFinishProcessingComment.dispose()
	}
}
