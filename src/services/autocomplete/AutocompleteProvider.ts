//PLANREF: continue/core/autocomplete/CompletionProvider.ts
//PLANREF: continue/extensions/vscode/src/autocomplete/completionProvider.ts
import * as vscode from "vscode"
import { AutocompleteConfig } from "./AutocompleteConfig"
import { ApiHandler, buildApiHandler } from "../../api"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer" // Imported PromptOptions
import { CompletionCache } from "./utils/CompletionCache"
import { ContextProxy } from "../../core/config/ContextProxy"
import { generateImportSnippets, generateDefinitionSnippets } from "./context/snippetProvider" // Added import

// Default configuration values
export const DEFAULT_DEBOUNCE_DELAY = 150
const DEFAULT_MODEL = "mistralai/codestral-2501" // or google/gemini-2.5-flash-preview
const MIN_TYPED_LENGTH_FOR_COMPLETION = 4

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
	// API and completion state
	private apiHandler: ApiHandler
	private enabled: boolean = true
	private activeCompletionId: string | null = null

	// Throttling and debouncing
	private throttleTimeout: NodeJS.Timeout | null = null
	private debounceDelay: number = DEFAULT_DEBOUNCE_DELAY
	private pendingEditor: vscode.TextEditor | null = null

	// Core services
	private readonly cache: CompletionCache
	private readonly contextGatherer: ContextGatherer
	private readonly promptRenderer: PromptRenderer
	private readonly config: AutocompleteConfig

	// Preview display state
	private currentAutocompletePreview: string = ""
	private firstLinePreview: string = ""
	private remainingLinesPreview: string = ""
	private hasAcceptedFirstLine: boolean = false
	private isShowingAutocompletePreview: boolean = false
	private isLoadingCompletion: boolean = false
	private autocompletePreviewVisibleContextKey: string = "kilo-code.autocompletePreviewVisible"
	private onCursorMoveCallback: ((editor: vscode.TextEditor) => void) | null = null

	// Inline completion provider registration
	private inlineCompletionProviderDisposable: vscode.Disposable | null = null

	// Decorations for loading indicators
	private loadingDecorationType: vscode.TextEditorDecorationType
	private streamingDecorationType: vscode.TextEditorDecorationType

	constructor() {
		this.cache = new CompletionCache()
		this.config = new AutocompleteConfig()
		this.contextGatherer = new ContextGatherer()
		this.promptRenderer = new PromptRenderer({}, DEFAULT_MODEL)

		const kilocodeToken = ContextProxy.instance.getProviderSettings().kilocodeToken
		this.apiHandler = buildApiHandler({
			apiProvider: "kilocode",
			kilocodeToken: kilocodeToken,
			kilocodeModel: DEFAULT_MODEL,
		})

		this.loadingDecorationType = vscode.window.createTextEditorDecorationType({
			after: {
				color: new vscode.ThemeColor("editorGhostText.foreground"),
				fontStyle: "italic",
				contentText: "⏳",
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
		})

		this.streamingDecorationType = vscode.window.createTextEditorDecorationType({
			after: {
				color: new vscode.ThemeColor("editorGhostText.foreground"),
				fontStyle: "italic",
				contentText: "⌛",
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
		})
	}

	register(context: vscode.ExtensionContext): vscode.Disposable {
		this.inlineCompletionProviderDisposable = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" }, // All files
			this,
		)
		context.subscriptions.push(this.inlineCompletionProviderDisposable)
		this.registerTextEditorEvents(context)
		this.registerPreviewCommands(context)

		context.subscriptions.push(
			vscode.commands.registerCommand("editor.action.inlineSuggest.commit", async () => {
				if (this.isShowingAutocompletePreview) {
					await vscode.commands.executeCommand("kilo-code.acceptAutocompletePreview")
					return
				}

				await vscode.commands.executeCommand("default:editor.action.inlineSuggest.commit")
			}),
		)

		const statusBarItem = this.registerStatusBarItem(context)
		this.registerConfigurationWatcher(context)
		this.registerToggleCommand(context, statusBarItem)

		return {
			dispose: () => this.dispose(),
		}
	}

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
		// Don't provide completions if disabled
		if (!this.enabled || this.isFileDisabled(document)) {
			return null
		}

		try {
			if (this.hasAcceptedFirstLine && this.remainingLinesPreview) {
				const item = new vscode.InlineCompletionItem(this.remainingLinesPreview)
				item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
				this.isShowingAutocompletePreview = true
				vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, true)
				return [item]
			}

			// Otherwise, generate a new completion
			const completionText = await this.generateCompletionText(document, position, context, token)
			if (!completionText) return null

			// Split the completion into first line and remaining lines
			const lines = completionText.split("\n")

			// Create the completion item
			let item: vscode.InlineCompletionItem

			if (lines.length > 1) {
				this.firstLinePreview = lines[0]
				this.remainingLinesPreview = lines.slice(1).join("\n")
				// Only show the first line initially
				item = new vscode.InlineCompletionItem(this.firstLinePreview)
			} else {
				// Single line completion
				this.firstLinePreview = completionText
				this.remainingLinesPreview = ""
				item = new vscode.InlineCompletionItem(completionText)
			}

			// Set command to ensure VS Code knows this is a completion that can be accepted with Tab
			item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
			this.isShowingAutocompletePreview = true
			vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, true)

			return [item]
		} catch (error) {
			console.error("Error providing inline completion:", error)
			return null
		}
	}

	private registerStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		statusBarItem.text = "$(sparkle) Autocomplete"
		statusBarItem.tooltip = "Kilo Code Autocomplete"
		statusBarItem.command = "kilo-code.toggleAutocomplete"
		statusBarItem.show()
		context.subscriptions.push(statusBarItem)
		return statusBarItem
	}

	private registerConfigurationWatcher(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("kilo-code.autocomplete")) {
					const config = vscode.workspace.getConfiguration("kilo-code")
					this.debounceDelay = config.get("autocomplete.debounceDelay") || DEFAULT_DEBOUNCE_DELAY
				}
			}),
		)
	}

	private registerToggleCommand(context: vscode.ExtensionContext, statusBarItem: vscode.StatusBarItem): void {
		context.subscriptions.push(
			vscode.commands.registerCommand("kilo-code.toggleAutocomplete", () => {
				this.enabled = !this.enabled
				statusBarItem.text = this.enabled ? "$(sparkle) Autocomplete" : "$(circle-slash) Autocomplete"
				vscode.window.showInformationMessage(`Autocomplete ${this.enabled ? "enabled" : "disabled"}`)
			}),
		)
	}

	private registerTextEditorEvents(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.textEditor) {
					// Clear loading indicator when cursor moves
					if (this.isLoadingCompletion) {
						this.clearAutocompletePreview()
					}

					// Always hide the streaming decorator when cursor moves
					e.textEditor.setDecorations(this.streamingDecorationType, [])

					// If we've accepted the first line and cursor moves, reset state
					// This prevents showing remaining lines if user moves cursor after accepting first line
					if (this.hasAcceptedFirstLine && e.kind !== vscode.TextEditorSelectionChangeKind.Command) {
						this.clearAutocompletePreview()
					}
				}
			}),
		)

		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.isLoadingCompletion) {
					this.clearAutocompletePreview()
				} else {
					const editor = vscode.window.activeTextEditor
					if (editor && editor.document === e.document) {
						editor.setDecorations(this.loadingDecorationType, [])
						editor.setDecorations(this.streamingDecorationType, [])
					}
				}
			}),
		)
	}

	private registerPreviewCommands(context: vscode.ExtensionContext): void {
		const acceptCommand = vscode.commands.registerCommand("kilo-code.acceptAutocompletePreview", async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			// Handle the acceptance directly without calling commit again
			if (!this.hasAcceptedFirstLine && this.remainingLinesPreview) {
				// First Tab press: Insert the first line
				if (this.firstLinePreview) {
					await editor.edit((editBuilder) => {
						editBuilder.insert(editor.selection.active, this.firstLinePreview)
					})

					// Mark that we've accepted the first line
					this.hasAcceptedFirstLine = true

					// Wait a moment for the first line to be inserted
					setTimeout(async () => {
						// Trigger a new completion to show the remaining lines
						await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
					}, 50)
				}
			} else if (this.hasAcceptedFirstLine && this.remainingLinesPreview) {
				// Second Tab press: Insert the remaining lines
				await editor.edit((editBuilder) => {
					editBuilder.insert(editor.selection.active, this.remainingLinesPreview)
				})

				// Reset state
				this.clearAutocompletePreview()
			} else {
				// For single line completion or when remainingLinesPreview is empty after first line acceptance
				// We need to ensure the full preview (which might be just the firstLinePreview if it was a single line)
				// is inserted if it hasn't been fully by VS Code's default commit.
				// However, the default commit (`editor.action.inlineSuggest.commit`) should handle this.
				// So, just clearing our state should be enough.
				this.clearAutocompletePreview()
			}
		})

		const dismissCommand = vscode.commands.registerCommand("kilo-code.dismissAutocompletePreview", () => {
			this.clearAutocompletePreview()
		})

		context.subscriptions.push(acceptCommand, dismissCommand)
	}

	/**
	 * Shows the loading indicator at the current cursor position
	 */
	private showLoadingIndicator(editor: vscode.TextEditor): void {
		// Clear any existing preview first
		this.clearAutocompletePreview()

		// Set the loading state
		this.isLoadingCompletion = true

		// Show the loading decoration
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(this.loadingDecorationType, [decoration])
	}

	/**
	 * Shows the streaming indicator at the current cursor position
	 */
	private showStreamingIndicator(editor: vscode.TextEditor): void {
		// Show the streaming decoration
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(this.streamingDecorationType, [decoration])
	}

	/**
	 * Gets the completion text for the given document and position
	 */
	private async getCompletionText(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<string | null> {
		try {
			const cursorIndex = document.offsetAt(position)

			// Get the current line text up to the cursor position
			const lineText = document.lineAt(position.line).text
			const textBeforeCursor = lineText.substring(0, position.character).trimStart()

			// Generate a new completion
			const result = await this.generateCompletionText(document, position, context, token)
			if (!result) return null

			// Remove any matching prefix from the result
			const finalCompletionText = this.removeMatchingPrefix(textBeforeCursor, result)

			// Split the completion into first line and remaining lines
			const lines = finalCompletionText.split("\n")
			if (lines.length > 1) {
				this.firstLinePreview = lines[0]
				this.remainingLinesPreview = lines.slice(1).join("\n")
			} else {
				this.firstLinePreview = finalCompletionText
				this.remainingLinesPreview = ""
			}

			// Reset the acceptance state
			this.hasAcceptedFirstLine = false

			// Cache the result
			this.cache.set(document.uri.toString(), document.getText(), cursorIndex, finalCompletionText)

			return this.firstLinePreview
		} catch (error) {
			console.error("Error getting completion text:", error)

			// Make sure to clear the loading indicator on error
			const editor = vscode.window.activeTextEditor
			if (editor && this.isLoadingCompletion) {
				editor.setDecorations(this.loadingDecorationType, [])
				this.isLoadingCompletion = false
			}

			return null
		}
	}

	/**
	 * Efficiently removes matching prefix from completion result
	 */
	private removeMatchingPrefix(textBeforeCursor: string, result: string): string {
		if (!textBeforeCursor || !result.startsWith(textBeforeCursor)) {
			return result
		}
		return result.slice(textBeforeCursor.length)
	}

	/**
	 * Generates a new completion text
	 */
	private async generateCompletionText(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<string | null> {
		// Show streaming indicator while generating completion
		const editor = vscode.window.activeTextEditor
		if (editor && editor.document === document) {
			this.showStreamingIndicator(editor)
		}
		// Generate a unique ID for this completion
		const completionId = crypto.randomUUID()
		this.activeCompletionId = completionId

		// Reset the acceptance state for a new completion
		this.hasAcceptedFirstLine = false

		// Load configuration
		const conf = await this.config.loadConfig()
		const useImports = conf?.useImports || false
		const useDefinitions = conf?.onlyMyCode || false
		const multilineCompletions = conf?.multilineCompletions || "auto"

		// Gather context
		const codeContext = await this.contextGatherer.gatherContext(document, position, useImports, useDefinitions)

		// Generate snippets
		const snippets = [
			...generateImportSnippets(useImports, codeContext.imports, document.uri.fsPath),
			...generateDefinitionSnippets(useDefinitions, codeContext.definitions),
		]

		// Define options for snippet generation and prompt rendering
		const promptOptions = {
			language: document.languageId,
			includeImports: useImports,
			includeDefinitions: useDefinitions,
			multilineCompletions: multilineCompletions as any, // Keep as any if type is complex or from external lib
		}

		// Render prompts
		const prompt = this.promptRenderer.renderPrompt(codeContext, snippets, promptOptions)
		const systemPrompt = this.promptRenderer.renderSystemPrompt()

		// Setup cancellation
		const abortController = new AbortController()
		token.onCancellationRequested(() => {
			abortController.abort()
			if (this.activeCompletionId === completionId) {
				this.activeCompletionId = null
			}
		})

		// Process the completion stream
		const startTime = performance.now()
		const result = await this.processCompletionStream(systemPrompt, prompt.prompt, completionId, document)
		const duration = performance.now() - startTime
		if (result.isCancelled) {
			console.info(`Completion ${completionId} CANCELLED`)
		} else {
			console.info(`
				Completion ${completionId} generated.

				System prompt: """${systemPrompt}"""

				Prompt: """${prompt.prompt}"""

				Completion: """${result.completion}"""

				Duration: ${duration} ms
				`)
		}

		if (result.isCancelled || token.isCancellationRequested) {
			// Make sure to clear the loading indicator if the completion is cancelled
			const editor = vscode.window.activeTextEditor
			if (editor && this.isLoadingCompletion) {
				editor.setDecorations(this.loadingDecorationType, [])
				this.isLoadingCompletion = false
			}
			return null
		}

		// Validate completion against selection context
		if (!this.validateCompletionContext(context, document, position)) {
			// Make sure to clear the loading indicator if validation fails
			const editor = vscode.window.activeTextEditor
			if (editor && this.isLoadingCompletion) {
				editor.setDecorations(this.loadingDecorationType, [])
				this.isLoadingCompletion = false
			}
			return null
		}

		return this.cleanMarkdownCodeBlocks(result.completion)
	}

	/**
	 * Updates the preview text at the current cursor position
	 */
	// We no longer need updateAutocompletePreview since we're using inline completions

	/**
	 * Clears any displayed preview text and loading indicator
	 */
	public clearAutocompletePreview() {
		this.isShowingAutocompletePreview = false
		this.isLoadingCompletion = false
		this.currentAutocompletePreview = ""
		this.firstLinePreview = ""
		this.remainingLinesPreview = ""
		this.hasAcceptedFirstLine = false

		// Clear loading indicators
		const editor = vscode.window.activeTextEditor
		if (editor) {
			editor.setDecorations(this.loadingDecorationType, [])
			editor.setDecorations(this.streamingDecorationType, [])
		}

		// Update the context for keybindings
		vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, false)

		// Hide any active inline suggestions
		vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
	}

	/**
	 * Processes the completion stream and returns the result
	 */
	private async processCompletionStream(
		systemPrompt: string,
		prompt: string,
		completionId: string,
		document: vscode.TextDocument,
	): Promise<{ completion: string; isCancelled: boolean }> {
		let completion = ""
		let isCancelled = false
		const currentCompletionId = completionId
		let firstLineComplete = false
		let firstLine = ""
		let remainingLines = ""

		// Function to check if the request has been cancelled
		const checkCancellation = () => {
			if (this.activeCompletionId !== currentCompletionId) {
				isCancelled = true
				return true
			}
			return false
		}

		// Function to split completion into first line and remaining lines
		const splitCompletion = (text: string): { firstLine: string; remainingLines: string } => {
			const cleanedText = this.cleanMarkdownCodeBlocks(text)
			const lines = cleanedText.split("\n")

			if (lines.length <= 1) {
				return { firstLine: cleanedText, remainingLines: "" }
			} else {
				return {
					firstLine: lines[0],
					remainingLines: lines.slice(1).join("\n"),
				}
			}
		}

		// Create the stream using the API handler's createMessage method
		// Note: Stop tokens are embedded in the prompt template format instead of passed directly
		const stream = this.apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		])

		// Get the editor for streaming updates
		const editor = vscode.window.activeTextEditor

		// Clear loading indicator when we start receiving content
		if (editor) {
			this.isLoadingCompletion = false
			editor.setDecorations(this.loadingDecorationType, [])
			// Keep the streaming indicator visible while content is streaming
		}

		// Stream updates to store completion
		for await (const chunk of stream) {
			if (checkCancellation()) {
				break
			}

			if (chunk.type === "text") {
				completion += chunk.text
				const { firstLine: currentFirstLine, remainingLines: currentRemainingLines } =
					splitCompletion(completion)

				// If we have a throttle timeout already, clear it
				if (this.throttleTimeout) {
					clearTimeout(this.throttleTimeout)
				}

				// Store the pending editor
				this.pendingEditor = editor || null

				// Check if first line is complete (has a newline)
				if (!firstLineComplete && completion.includes("\n")) {
					firstLineComplete = true
					firstLine = currentFirstLine
					remainingLines = currentRemainingLines

					// Store the first line and remaining lines
					this.firstLinePreview = firstLine
					this.remainingLinesPreview = remainingLines

					// Mark that we're showing a preview and trigger inline suggestion
					this.isShowingAutocompletePreview = true
					vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
				} else {
					// Set a new throttle timeout
					this.throttleTimeout = setTimeout(() => {
						if (this.pendingEditor && this.pendingEditor.document === document) {
							// If first line is complete, update state based on current completion
							if (firstLineComplete) {
								if (!this.hasAcceptedFirstLine) {
									// Otherwise, still store just the first line
									this.firstLinePreview = currentFirstLine
								}
								this.remainingLinesPreview = currentRemainingLines
							} else {
								// If first line isn't complete yet, store everything
								const cleanedText = this.cleanMarkdownCodeBlocks(completion)
								this.firstLinePreview = cleanedText
								this.remainingLinesPreview = ""
							}

							// Trigger inline suggestion to update
							if (this.isShowingAutocompletePreview) {
								vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
							}
						}
						this.throttleTimeout = null
					}, this.debounceDelay)
				}
			}
		}

		// Clear streaming indicator when streaming is complete
		if (editor) {
			editor.setDecorations(this.streamingDecorationType, [])
		}

		// Final update to ensure we have the correct split
		const { firstLine: finalFirstLine, remainingLines: finalRemainingLines } = splitCompletion(completion)
		this.firstLinePreview = finalFirstLine
		this.remainingLinesPreview = finalRemainingLines

		// Set context for keybindings
		vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, true)

		return { completion, isCancelled }
	}

	/**
	 * Cleans markdown-style code blocks from text
	 */
	private cleanMarkdownCodeBlocks(text: string): string {
		// Handle complete code blocks
		let cleanedText = text.replace(/```[\w-]*\n([\s\S]*?)\n```/g, "$1")

		// Handle opening code block markers at the beginning of a chunk
		cleanedText = cleanedText.replace(/^```[\w-]*\n/g, "")

		// Handle opening code block markers in the middle of a chunk
		cleanedText = cleanedText.replace(/\n```[\w-]*\n/g, "\n")

		// Handle closing code block markers
		cleanedText = cleanedText.replace(/\n```$/g, "")

		// Handle any remaining backticks that might be part of incomplete code blocks
		cleanedText = cleanedText.replace(/```[\w-]*$/g, "")

		// Trim any leading/trailing whitespace that might be left over
		return cleanedText.trim()
	}

	// AIDIFF: Added position parameter
	private validateCompletionContext(
		context: vscode.InlineCompletionContext,
		document: vscode.TextDocument,
		position: vscode.Position,
	): boolean {
		if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
			return true
		}
		// AIDIFF: Correctly access active editor for selection information
		const activeEditor = vscode.window.activeTextEditor
		// AIDIFF: Use the passed 'position' as a fallback if activeEditor is not available or doesn't match.
		const currentPosition =
			activeEditor && activeEditor.document.uri === document.uri ? activeEditor.selection.active : position

		const lineText = document.lineAt(context.selectedCompletionInfo?.range.start.line ?? currentPosition.line).text
		const textBeforeCursor = lineText.substring(
			0,
			context.selectedCompletionInfo?.range.start.character ?? currentPosition.character,
		)
		// AIDIFF: Corrected logic: if trigger is Automatic AND length is too short, then return false.
		// The previous check `context.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke` is implicitly handled
		// by the `context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic` check,
		// because if it's Invoke, the first part of the original if (line 520) already returns true.
		if (
			context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic &&
			textBeforeCursor.trim().length < MIN_TYPED_LENGTH_FOR_COMPLETION
		) {
			return false
		}
		return true
	}

	/**
	 * Checks if autocomplete is disabled for the given document based on file patterns
	 */
	private isFileDisabled(document: vscode.TextDocument): boolean {
		const config = vscode.workspace.getConfiguration("kilo-code")
		const disabledPatterns = config.get<string>("autocomplete.disableInFiles") || ""
		const patterns = disabledPatterns
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)

		return patterns.some((pattern) => {
			const glob = new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", pattern)
			return vscode.languages.match({ pattern: glob }, document)
		})
	}

	/**
	 * Cleans up resources when the provider is no longer needed
	 */
	public dispose() {
		// Clear any throttle timeout
		if (this.throttleTimeout) {
			clearTimeout(this.throttleTimeout)
			this.throttleTimeout = null
		}

		// Clear any active preview text
		if (this.isShowingAutocompletePreview) {
			this.clearAutocompletePreview()
		}

		// Dispose of the inline completion provider
		if (this.inlineCompletionProviderDisposable) {
			this.inlineCompletionProviderDisposable.dispose()
			this.inlineCompletionProviderDisposable = null
		}

		// Dispose of the decorator types
		this.loadingDecorationType.dispose()
		this.streamingDecorationType.dispose()
	}
}
