import * as vscode from "vscode"
import { Anthropic } from "@anthropic-ai/sdk"
import { EXPERIMENT_IDS, ExperimentId, experiments } from "../../shared/experiments"
import { AICommentData, FileChangeData, WatchModeConfig, TriggerType } from "./types"
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
	determineTriggerType,
	buildReflectionPrompt,
	estimateTokenCount,
} from "./commentProcessor"
import { WatchModeHighlighter } from "./WatchModeHighlighter"

// Interface for document change event data
interface DocumentChangeData {
	document: vscode.TextDocument
	isDocumentSave: boolean
}

/**
 * Service that watches files for changes and processes AI comments
 */
export class WatchModeService {
	private apiHandler: ApiHandler | null = null
	private watchers: Map<string, vscode.FileSystemWatcher> = new Map()
	private pendingProcessing: Map<string, ReturnType<typeof setTimeout>> = new Map()
	private _isActive: boolean = false
	private outputChannel?: vscode.OutputChannel
	private ui: WatchModeUI
	private highlighter: WatchModeHighlighter
	private processingFiles: Set<string> = new Set()
	private currentDebugId?: string
	private documentListeners: vscode.Disposable[] = []
	private staticHighlights: Map<string, () => void> = new Map()
	private recentlyProcessedFiles: Map<string, number> = new Map()
	private processingDebounceTime: number = 500 // ms to prevent duplicate processing
	private quickCommandDocument?: vscode.TextDocument // Track the document that initiated a quick command

	// Track active files for context management
	private activeFiles: Set<string> = new Set()
	private maxActiveFiles: number = 10 // Maximum number of files to keep in active context
	private largeFileThreshold: number = 1000000 // ~1MB threshold for large files

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
		commentPrefix: "KO!", // Default AI comment prefix
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
		this.disposeDocumentListeners() // Clean up any existing document listeners

		// Set up file system watchers for file save events
		this.config.include.forEach((pattern) => {
			const watcher = vscode.workspace.createFileSystemWatcher(
				new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0]?.uri || "", pattern),
				false, // Don't ignore creates
				false, // Don't ignore changes
				true, // Ignore deletes
			)

			// Handle file creation events
			watcher.onDidCreate((uri: vscode.Uri) =>
				this.handleFileChange({ fileUri: uri, type: vscode.FileChangeType.Created }),
			)

			// Handle file change events (file saves)
			watcher.onDidChange((uri: vscode.Uri) => {
				this.log(`File changed: ${uri.toString()}`)
				return this.handleFileChange({ fileUri: uri, type: vscode.FileChangeType.Changed })
			})

			const watcherId = `watcher-${pattern}`
			this.watchers.set(watcherId, watcher)
			this.context.subscriptions.push(watcher)

			this.log(`Initialized file watcher for pattern: ${pattern}`)
		})

		// Set up document change listeners for real-time editing
		const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
			// Skip excluded files
			if (this.isFileExcluded(event.document.uri)) {
				return
			}

			// Process document changes as they happen (without debounce)
			this.handleDocumentChange({ document: event.document, isDocumentSave: false })
		})

		// Set up document save listeners
		const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
			// Skip excluded files
			if (this.isFileExcluded(document.uri)) {
				return
			}

			// Process document saves
			this.handleDocumentChange({ document: document, isDocumentSave: true })
		})

		this.documentListeners.push(changeListener, saveListener)
		this.context.subscriptions.push(changeListener, saveListener)
		this.log(`Initialized document change and save listeners`)
	}

	/**
	 * Handles document change events (typing or saving)
	 * @param data Document change event data
	 */
	private handleDocumentChange(data: DocumentChangeData): void {
		const { document, isDocumentSave } = data
		const fileUri = document.uri
		const fileKey = fileUri.toString()

		// Clear any existing static highlights for this file
		this.clearStaticHighlightsForFile(fileUri)

		// For all document changes (typing or saving), immediately detect and highlight comments
		this.detectAndHighlightComments(document)

		// For save events, immediately process the comments with animation
		if (isDocumentSave) {
			// Check if this file was recently processed to avoid duplicate processing
			if (this.isFileRecentlyProcessed(fileKey)) {
				this.log(`Skipping duplicate processing for recently saved file: ${fileKey}`)
				return
			}

			this.log(`Document saved, immediately processing: ${fileUri.toString()}`)

			// Cancel any pending processing for this file
			if (this.pendingProcessing.has(fileKey)) {
				clearTimeout(this.pendingProcessing.get(fileKey))
				this.pendingProcessing.delete(fileKey)
			}

			// Mark this file as recently processed
			this.markFileAsProcessed(fileKey)

			// Process the file immediately without debounce
			this.processFile(fileUri)
		}
	}

	/**
	 * Handles file change events from file system watcher
	 * @param data File change event data
	 */
	private handleFileChange(data: FileChangeData): void {
		const { fileUri } = data
		const fileKey = fileUri.toString()

		// Skip excluded files
		if (this.isFileExcluded(fileUri)) {
			this.log(`File excluded: ${fileUri.toString()}`)
			return
		}

		// Check if this file was recently processed to avoid duplicate processing
		if (this.isFileRecentlyProcessed(fileKey)) {
			this.log(`Skipping duplicate processing for recently changed file: ${fileKey}`)
			return
		}

		// Mark this file as recently processed
		this.markFileAsProcessed(fileKey)

		// Process the file immediately without debounce
		this.log(`Processing file from file system event: ${fileUri.toString()}`)
		this.processFile(fileUri)
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
	/**
	 * Adds a file to the active files list
	 * @param fileUri The URI of the file to add
	 */
	private addToActiveFiles(fileUri: vscode.Uri): void {
		const fileKey = fileUri.toString()

		// If already in the set, remove it so it can be added to the front (most recent)
		if (this.activeFiles.has(fileKey)) {
			this.activeFiles.delete(fileKey)
		}

		// Add to the active files set
		this.activeFiles.add(fileKey)

		// If we've exceeded the maximum, remove the oldest file
		if (this.activeFiles.size > this.maxActiveFiles) {
			const iterator = this.activeFiles.values()
			const oldest = iterator.next().value

			if (oldest) {
				this.activeFiles.delete(oldest)
				this.log(`Removed ${oldest} from active files (exceeded max of ${this.maxActiveFiles})`)
			}
		}

		this.log(`Active files (${this.activeFiles.size}): ${Array.from(this.activeFiles).join(", ")}`)
	}

	/**
	 * Gets a list of active files for context
	 * @returns Array of active file URIs
	 */
	private getActiveFiles(): vscode.Uri[] {
		return Array.from(this.activeFiles).map((uri) => vscode.Uri.parse(uri))
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

			// Add to active files list (even if large, we want to track it)
			this.addToActiveFiles(fileUri)

			// Skip processing if file is too large
			if (content.length > this.largeFileThreshold) {
				// Skip files larger than threshold
				this.log(`Skipping large file: ${fileUri.fsPath} (${content.length} bytes)`)
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

	/**
	 * Detects and highlights comments in a document without animation
	 * @param document The document to check
	 */
	/**
	 * Detects and highlights comments in a document without animation
	 * @param document The document to check
	 */
	private detectAndHighlightComments(document: vscode.TextDocument): void {
		try {
			const fileUri = document.uri
			const content = document.getText()

			// Add to active files list (even if large, we want to track it)
			this.addToActiveFiles(fileUri)

			// Skip files larger than threshold
			if (content.length > this.largeFileThreshold) {
				this.log(`Skipping large file: ${fileUri.fsPath} (${content.length} bytes)`)
				return
			}

			const result = detectAIComments({ fileUri, content, languageId: document.languageId })

			if (result.errors) {
				result.errors.forEach((error) => {
					this.log(`Error detecting comments: ${error.message}`)
				})
			}

			if (result.comments.length === 0) {
				this.log(`No AI comments found in file: ${fileUri.fsPath}`)
				return // No comments found, nothing to do
			}

			this.log(`Found ${result.comments.length} AI comments in ${fileUri.fsPath}`)

			for (const comment of result.comments) {
				this.highlightCommentKiloOnly(document, comment)
			}
		} catch (error) {
			this.log(
				`Error detecting comments in ${document.uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	/**
	 * Highlights only the KILO keyword in a comment
	 * @param document The document containing the comment
	 * @param comment The AI comment data
	 */
	private highlightCommentKiloOnly(document: vscode.TextDocument, comment: AICommentData): void {
		// Create a unique ID for this highlight
		const highlightId = `static:${document.uri.toString()}:${comment.startPos.line}:${comment.startPos.character}`

		// Clear any existing highlight for this comment
		if (this.staticHighlights.has(highlightId)) {
			this.staticHighlights.get(highlightId)?.()
			this.staticHighlights.delete(highlightId)
		}

		// Find the position of the KILO prefix in the comment
		const line = document.lineAt(comment.startPos.line).text
		const commentPrefix = this.config.commentPrefix
		const prefixIndex = line.indexOf(commentPrefix)

		if (prefixIndex >= 0) {
			// Create a range just for the KILO prefix
			const prefixStart = new vscode.Position(comment.startPos.line, prefixIndex)
			const prefixEnd = new vscode.Position(comment.startPos.line, prefixIndex + commentPrefix.length)
			const prefixRange = new vscode.Range(prefixStart, prefixEnd)

			// Apply static highlight with a lighter color only to the KILO prefix
			const clearHighlight = this.highlighter.highlightRange(document, prefixRange, {
				backgroundColor: "rgba(0, 122, 255, 0.3)",
				borderColor: "rgba(0, 122, 255, 0.5)",
				borderWidth: "1px",
				borderStyle: "solid",
				isWholeLine: false,
			})

			// Store the cleanup function
			this.staticHighlights.set(highlightId, clearHighlight)
		} else {
			// Fallback to highlighting the whole comment if prefix not found
			const range = new vscode.Range(comment.startPos, comment.endPos)

			// Apply static highlight with a lighter color
			const fallbackClearHighlight = this.highlighter.highlightRange(document, range, {
				backgroundColor: "rgba(0, 122, 255, 0.3)",
				borderColor: "rgba(0, 122, 255, 0.5)",
				borderWidth: "1px",
				borderStyle: "solid",
				isWholeLine: false,
			})

			// Store the cleanup function
			this.staticHighlights.set(highlightId, fallbackClearHighlight)
		}
	}

	/**
	 * Clears all static highlights for a specific file
	 * @param fileUri The URI of the file
	 */
	private clearStaticHighlightsForFile(fileUri: vscode.Uri): void {
		const fileUriStr = fileUri.toString()

		// Find and clear all static highlights for this file
		for (const [id, clearFn] of this.staticHighlights.entries()) {
			if (id.includes(fileUriStr)) {
				clearFn()
				this.staticHighlights.delete(id)
			}
		}
	}

	/**
	 * Checks if a file was recently processed to avoid duplicate processing
	 * @param fileKey The file key (URI as string)
	 * @returns True if the file was recently processed
	 */
	private isFileRecentlyProcessed(fileKey: string): boolean {
		const lastProcessed = this.recentlyProcessedFiles.get(fileKey)
		if (!lastProcessed) {
			return false
		}

		const now = Date.now()
		return now - lastProcessed < this.processingDebounceTime
	}

	/**
	 * Marks a file as recently processed
	 * @param fileKey The file key (URI as string)
	 */
	private markFileAsProcessed(fileKey: string): void {
		this.recentlyProcessedFiles.set(fileKey, Date.now())

		// Clean up old entries after a delay
		setTimeout(() => {
			this.recentlyProcessedFiles.delete(fileKey)
		}, this.processingDebounceTime * 2)
	}

	private async processAIComment(document: vscode.TextDocument, comment: AICommentData): Promise<void> {
		try {
			this.log(
				`Processing AI comment: "${comment.content.substring(0, 50)}${comment.content.length > 50 ? "..." : ""}"`,
			)

			// Check if this is from a quick command and we have a tracked document
			const isQuickCommand = this.quickCommandDocument !== undefined
			if (isQuickCommand) {
				this.log(
					`Processing comment from quick command, using tracked document: ${vscode.workspace.asRelativePath(this.quickCommandDocument!.uri)}`,
				)
			}

			// Use the tracked document if this is from a quick command
			const documentToUse = isQuickCommand ? this.quickCommandDocument! : document

			// Highlight the AI comment with animation
			const clearHighlight = this.highlighter.highlightRange(
				document, // Still highlight in the original document
				new vscode.Range(comment.startPos, comment.endPos),
				{
					backgroundColor: "rgba(0, 122, 255, 0.4)",
					borderColor: "rgba(0, 122, 255, 0.9)",
					borderWidth: "1px",
					borderStyle: "solid",
					isWholeLine: true,
				},
			)

			// Emit event that we're starting to process this comment
			this._onDidStartProcessingComment.fire({ fileUri: document.uri, comment })

			// Determine the trigger type from the comment content
			this.log("Determining trigger type...")
			const triggerType = determineTriggerType(comment.content)
			this.log(`Trigger type determined: ${triggerType}`)

			// Process with reflection support (up to 3 attempts)
			await this.processWithReflection(documentToUse, comment, triggerType, clearHighlight)

			// Clear the tracked document after processing
			if (isQuickCommand) {
				this.log(`Clearing tracked quick command document`)
				this.quickCommandDocument = undefined
			}
		} catch (error) {
			this.log(`Error processing AI comment: ${error instanceof Error ? error.message : String(error)}`)
			this._onDidFinishProcessingComment.fire({
				fileUri: document.uri,
				comment,
				success: false,
			})

			// Clear the tracked document in case of error
			if (this.quickCommandDocument) {
				this.log(`Clearing tracked quick command document due to error`)
				this.quickCommandDocument = undefined
			}
		}
	}

	/**
	 * Processes an AI comment with support for reflection on failed edits
	 * @param document The document containing the comment
	 * @param comment The AI comment data
	 * @param triggerType The trigger type (Edit or Ask)
	 * @param clearHighlight Function to clear the highlight
	 */
	private async processWithReflection(
		document: vscode.TextDocument,
		comment: AICommentData,
		triggerType: TriggerType,
		clearHighlight: () => void,
	): Promise<void> {
		// Maximum number of reflection attempts
		const MAX_REFLECTION_ATTEMPTS = 1
		let currentAttempt = 0
		let success = false
		let lastResponse: string | null = null

		while (currentAttempt <= MAX_REFLECTION_ATTEMPTS) {
			try {
				// Build prompt from the comment and context
				this.log(`Building AI prompt (attempt ${currentAttempt})...`)

				// Gather content from active files for additional context
				const activeFilesWithContent: { uri: vscode.Uri; content: string }[] = []

				// Maximum token budget for additional context (roughly 50% of model's context window)
				const MAX_ADDITIONAL_CONTEXT_TOKENS = 50000
				let estimatedTokens = 0

				// First, estimate tokens for the base prompt
				const basePrompt = buildAIPrompt(comment, triggerType)
				estimatedTokens += estimateTokenCount(basePrompt)

				// Get active files and sort by recency (most recent first)
				const activeFileUris = this.getActiveFiles()

				// Prioritize open editor tabs
				const openEditors = vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString())

				// Sort active files: open editors first, then other active files
				const sortedActiveFiles = activeFileUris.sort((a, b) => {
					const aIsOpen = openEditors.includes(a.toString())
					const bIsOpen = openEditors.includes(b.toString())

					if (aIsOpen && !bIsOpen) return -1
					if (!aIsOpen && bIsOpen) return 1
					return 0
				})

				// Add content from active files until we reach the token limit
				for (const uri of sortedActiveFiles) {
					// Skip the file with the comment (already included in the context)
					if (uri.toString() === document.uri.toString()) {
						continue
					}

					try {
						// Skip files that are too large
						if (uri.fsPath.endsWith(".min.js") || uri.fsPath.endsWith(".min.css")) {
							this.log(`Skipping minified file: ${uri.fsPath}`)
							continue
						}

						const doc = await vscode.workspace.openTextDocument(uri)
						const content = doc.getText()

						// Skip if file is too large
						if (content.length > this.largeFileThreshold) {
							this.log(`Skipping large file for context: ${uri.fsPath} (${content.length} bytes)`)
							continue
						}

						// Estimate tokens for this file
						const fileTokens = estimateTokenCount(content)

						// If adding this file would exceed our budget, skip it
						if (estimatedTokens + fileTokens > MAX_ADDITIONAL_CONTEXT_TOKENS) {
							this.log(`Skipping file due to token budget: ${uri.fsPath} (${fileTokens} tokens)`)
							continue
						}

						// Add file to context
						activeFilesWithContent.push({ uri, content })
						estimatedTokens += fileTokens

						this.log(`Added file to context: ${uri.fsPath} (${fileTokens} tokens)`)
					} catch (error) {
						this.log(
							`Error reading file ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
						)
					}
				}

				this.log(
					`Total context includes ${activeFilesWithContent.length} additional files (est. ${estimatedTokens} tokens)`,
				)

				// Ensure we always have a valid string prompt
				const prompt =
					currentAttempt === 0
						? buildAIPrompt(comment, triggerType, activeFilesWithContent)
						: lastResponse || buildAIPrompt(comment, triggerType, activeFilesWithContent)

				this.log(`Prompt built, length: ${prompt.length} characters`)
				// Log the full prompt for debugging
				console.log("=== FULL PROMPT ===")
				console.log(prompt)
				console.log("=== END PROMPT ===")

				// Get response from AI model
				this.log("Calling AI model...")
				let apiResponse: string | null = null

				try {
					// We know prompt is a valid string at this point
					apiResponse = await this.callAIModel(prompt)
					this.log(`API response received, length: ${apiResponse?.length || 0} characters`)
					// Log the full response for debugging
					console.log("=== FULL API RESPONSE ===")
					console.log(apiResponse)
					console.log("=== END API RESPONSE ===")
				} catch (apiError) {
					this.log(
						`Error calling AI model: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
					)
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
				this.log(`Processing AI response (attempt ${currentAttempt})...`)
				try {
					// Use the tracked document if this is from a quick command
					const documentToProcess = this.quickCommandDocument || document
					success = await processAIResponse(documentToProcess, comment, apiResponse, currentAttempt)
					this.log(`Response processed, success: ${success}`)

					// If successful, break out of the loop
					if (success) {
						break
					}

					// If we've reached the maximum attempts, break out of the loop
					if (currentAttempt >= MAX_REFLECTION_ATTEMPTS) {
						break
					}

					// Increment the attempt counter
					currentAttempt++
				} catch (processError) {
					// Check if this is a reflection request
					if (processError instanceof Error && processError.message.startsWith("REFLECTION_NEEDED:")) {
						// Parse the reflection information
						const parts = processError.message.split(":")
						const nextAttempt = parseInt(parts[1], 10)
						const errorMessages = parts[2].split("|")

						this.log(`Reflection needed, attempt ${nextAttempt} of ${MAX_REFLECTION_ATTEMPTS}`)
						this.log(`Error messages: ${errorMessages.join(", ")}`)

						// Update the attempt counter
						currentAttempt = nextAttempt

						// Build a reflection prompt with active files context
						const reflectionPrompt = buildReflectionPrompt(
							comment,
							apiResponse,
							errorMessages,
							activeFilesWithContent,
						)
						lastResponse = reflectionPrompt

						// Log the full reflection prompt for debugging
						console.log("=== FULL REFLECTION PROMPT ===")
						console.log(reflectionPrompt)
						console.log("=== END REFLECTION PROMPT ===")

						// Continue to the next iteration
						continue
					} else {
						// Handle other errors
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
				}
			} catch (error) {
				this.log(`Error in reflection loop: ${error instanceof Error ? error.message : String(error)}`)
				this._onDidFinishProcessingComment.fire({
					fileUri: document.uri,
					comment,
					success: false,
				})
				clearHighlight()
				return
			}
		}

		if (success) {
			this.log(`Successfully applied AI response to ${document.uri.fsPath}`)
		} else {
			this.log(`Failed to apply AI response to ${document.uri.fsPath} after ${currentAttempt} attempts`)
		}

		// Emit event that we've finished processing this comment
		this._onDidFinishProcessingComment.fire({
			fileUri: document.uri,
			comment,
			success,
		})

		// Clear the highlight
		clearHighlight()
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
	 * Disposes all document listeners
	 */
	private disposeDocumentListeners(): void {
		this.log(`Disposing ${this.documentListeners.length} document listeners`)
		for (const listener of this.documentListeners) {
			listener.dispose()
		}
		this.documentListeners = []

		// Clear all static highlights
		for (const clearFn of this.staticHighlights.values()) {
			clearFn()
		}
		this.staticHighlights.clear()
	}

	/**
	 * Starts the watch mode service
	 * @returns True if the service was started, false otherwise
	 */
	public start(): boolean {
		if (this._isActive) {
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
		this._isActive = true
		this._onDidChangeActiveState.fire(true)
		this.log("Watch mode started")
		return true
	}

	/**
	 * Stops the watch mode service
	 */
	public stop(): void {
		if (!this._isActive) {
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

		// Dispose document listeners
		this.disposeDocumentListeners()

		this._isActive = false
		this._onDidChangeActiveState.fire(false)
		this.log("Watch mode stopped")
	}

	/**
	 * Returns whether the watch mode service is active
	 */
	public isWatchModeActive(): boolean {
		return this._isActive
	}

	/**
	 * Toggles the watch mode service
	 * @returns True if the service is now active, false otherwise
	 */
	public toggle(): boolean {
		if (this._isActive) {
			this.stop()
			return false
		} else {
			return this.start()
		}
	}

	/**
	 * Gets whether the watch mode service is currently active
	 */
	public get isActive(): boolean {
		return this._isActive
	}

	/**
	 * Processes a quick command by creating a temporary AI comment in the document
	 * @param document The document to process
	 * @param command The command text from the user
	 */
	public async processQuickCommand(document: vscode.TextDocument, command: string): Promise<void> {
		try {
			this.log(`Processing quick command: ${command}`)

			// Store a reference to the document that initiated the quick command
			this.quickCommandDocument = document
			const documentPath = vscode.workspace.asRelativePath(document.uri)
			this.log(`Tracking quick command document: ${documentPath}`)

			// Get the current cursor position
			const activeEditor = vscode.window.activeTextEditor
			if (!activeEditor || activeEditor.document !== document) {
				throw new Error("No active editor or document mismatch")
			}

			const cursorPosition = activeEditor.selection.active
			const line = document.lineAt(cursorPosition.line)

			// Determine the appropriate comment syntax based on language
			const languageId = document.languageId
			let commentPrefix = "//"
			let commentSuffix = ""

			// Adjust comment syntax for different languages
			switch (languageId) {
				case "python":
				case "ruby":
				case "perl":
				case "bash":
				case "shell":
				case "yaml":
				case "dockerfile":
					commentPrefix = "#"
					break
				case "html":
				case "xml":
				case "markdown":
					commentPrefix = "<!--"
					commentSuffix = "-->"
					break
				case "css":
				case "scss":
				case "less":
					commentPrefix = "/*"
					commentSuffix = "*/"
					break
				case "sql":
					commentPrefix = "--"
					break
			}

			// Create the AI comment with the configured prefix
			const aiCommentPrefix = this.config.commentPrefix
			const fullComment = `${commentPrefix} ${aiCommentPrefix} ${command}${commentSuffix ? " " + commentSuffix : ""}`

			// Insert the comment at the cursor position
			const edit = new vscode.WorkspaceEdit()
			const insertPosition = new vscode.Position(cursorPosition.line, line.text.length)

			// If the line is not empty, add a newline before the comment
			if (line.text.trim().length > 0) {
				edit.insert(document.uri, insertPosition, `\n${fullComment}`)
			} else {
				// If the line is empty, just insert the comment with proper indentation
				const indentation = line.text.match(/^\s*/)?.[0] || ""
				edit.replace(document.uri, line.range, `${indentation}${fullComment}`)
			}

			// Apply the edit
			const success = await vscode.workspace.applyEdit(edit)
			if (!success) {
				throw new Error("Failed to insert AI comment")
			}

			// Add this document to active files to ensure it's included in context
			this.addToActiveFiles(document.uri)

			// Save the document to trigger the watch mode processing
			await document.save()

			this.log(`Quick command processed successfully`)
		} catch (error) {
			this.log(`Error in processQuickCommand: ${error instanceof Error ? error.message : String(error)}`)
			throw error
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
