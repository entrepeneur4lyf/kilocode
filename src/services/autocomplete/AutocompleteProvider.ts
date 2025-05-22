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
const AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY = "kilo-code.autocompletePreviewVisible"

export function hookAutocomplete(context: vscode.ExtensionContext) {
	try {
		// Initialize the autocomplete preview text visibility context to false
		hookAutocompleteInner(context)
	} catch (error) {
		console.error("Failed to register autocomplete provider:", error)
	}
}

function hookAutocompleteInner(context: vscode.ExtensionContext) {
	vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, false)

	// Shared state encapsulated in closure
	let enabled = true
	let activeCompletionId: string | null = null
	let debounceDelay = DEFAULT_DEBOUNCE_DELAY

	// Preview state
	let firstLinePreview = ""
	let remainingLinesPreview = ""
	let hasAcceptedFirstLine = false
	let isShowingAutocompletePreview = false
	let isLoadingCompletion = false

	// Core services - created once
	const cache = new CompletionCache()
	const config = new AutocompleteConfig()
	const contextGatherer = new ContextGatherer()
	const promptRenderer = new PromptRenderer({}, DEFAULT_MODEL)

	const kilocodeToken = ContextProxy.instance.getProviderSettings().kilocodeToken
	const apiHandler = buildApiHandler({
		apiProvider: "kilocode",
		kilocodeToken: kilocodeToken,
		kilocodeModel: DEFAULT_MODEL,
	})

	// Decoration types
	const loadingDecorationType = vscode.window.createTextEditorDecorationType({
		after: {
			color: new vscode.ThemeColor("editorGhostText.foreground"),
			fontStyle: "italic",
			contentText: "⏳",
		},
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
	})

	const streamingDecorationType = vscode.window.createTextEditorDecorationType({
		after: {
			color: new vscode.ThemeColor("editorGhostText.foreground"),
			fontStyle: "italic",
			contentText: "⌛",
		},
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
	})

	// Helper functions
	const clearAutocompletePreview = () => {
		isShowingAutocompletePreview = false
		isLoadingCompletion = false
		firstLinePreview = ""
		remainingLinesPreview = ""
		hasAcceptedFirstLine = false

		// Clear loading indicators
		const editor = vscode.window.activeTextEditor
		if (editor) {
			editor.setDecorations(loadingDecorationType, [])
			editor.setDecorations(streamingDecorationType, [])
		}

		// Update the context for keybindings
		vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, false)

		// Hide any active inline suggestions
		vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
	}

	const showStreamingIndicator = (editor: vscode.TextEditor) => {
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(streamingDecorationType, [decoration])
	}

	const cleanMarkdownCodeBlocks = (text: string): string => {
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

	const isFileDisabled = (document: vscode.TextDocument): boolean => {
		const vscodeConfig = vscode.workspace.getConfiguration("kilo-code")
		const disabledPatterns = vscodeConfig.get<string>("autocomplete.disableInFiles") || ""
		const patterns = disabledPatterns
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean)

		return patterns.some((pattern) => {
			const glob = new vscode.RelativePattern(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "", pattern)
			return vscode.languages.match({ pattern: glob }, document)
		})
	}

	const validateCompletionContext = (
		context: vscode.InlineCompletionContext,
		document: vscode.TextDocument,
		position: vscode.Position,
	): boolean => {
		if (context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke) {
			return true
		}
		const activeEditor = vscode.window.activeTextEditor
		const currentPosition =
			activeEditor && activeEditor.document.uri === document.uri ? activeEditor.selection.active : position

		const lineText = document.lineAt(context.selectedCompletionInfo?.range.start.line ?? currentPosition.line).text
		const textBeforeCursor = lineText.substring(
			0,
			context.selectedCompletionInfo?.range.start.character ?? currentPosition.character,
		)
		if (
			context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic &&
			textBeforeCursor.trim().length < MIN_TYPED_LENGTH_FOR_COMPLETION
		) {
			return false
		}
		return true
	}

	// Main provider implementation
	const provider = new AutocompleteProvider(
		// Dependencies
		{ apiHandler, cache, config, contextGatherer, promptRenderer },
		// State accessors
		{
			isEnabled: () => enabled,
			setEnabled: (value: boolean) => {
				enabled = value
			},
			getDebounceDelay: () => debounceDelay,
			setDebounceDelay: (value: number) => {
				debounceDelay = value
			},
			getActiveCompletionId: () => activeCompletionId,
			setActiveCompletionId: (id: string | null) => {
				activeCompletionId = id
			},
			getPreviewState: () => ({
				firstLinePreview,
				remainingLinesPreview,
				hasAcceptedFirstLine,
				isShowingAutocompletePreview,
				isLoadingCompletion,
			}),
			setPreviewState: (
				state: Partial<{
					firstLinePreview: string
					remainingLinesPreview: string
					hasAcceptedFirstLine: boolean
					isShowingAutocompletePreview: boolean
					isLoadingCompletion: boolean
				}>,
			) => {
				if (state.firstLinePreview !== undefined) firstLinePreview = state.firstLinePreview
				if (state.remainingLinesPreview !== undefined) remainingLinesPreview = state.remainingLinesPreview
				if (state.hasAcceptedFirstLine !== undefined) hasAcceptedFirstLine = state.hasAcceptedFirstLine
				if (state.isShowingAutocompletePreview !== undefined)
					isShowingAutocompletePreview = state.isShowingAutocompletePreview
				if (state.isLoadingCompletion !== undefined) isLoadingCompletion = state.isLoadingCompletion
			},
		},
		// Helpers
		{
			clearAutocompletePreview,
			showStreamingIndicator,
			cleanMarkdownCodeBlocks,
			isFileDisabled,
			validateCompletionContext,
			loadingDecorationType,
			streamingDecorationType,
		},
	)

	const disposable = provider.register(context)

	// Subscribe to cleanup
	context.subscriptions.push({
		dispose: () => {
			disposable.dispose()
			// Reset the context when disposing
			vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, false)
		},
	})
}

interface AutocompleteProviderDeps {
	apiHandler: ApiHandler
	cache: CompletionCache
	config: AutocompleteConfig
	contextGatherer: ContextGatherer
	promptRenderer: PromptRenderer
}

interface AutocompleteProviderState {
	isEnabled: () => boolean
	setEnabled: (value: boolean) => void
	getDebounceDelay: () => number
	setDebounceDelay: (value: number) => void
	getActiveCompletionId: () => string | null
	setActiveCompletionId: (id: string | null) => void
	getPreviewState: () => {
		firstLinePreview: string
		remainingLinesPreview: string
		hasAcceptedFirstLine: boolean
		isShowingAutocompletePreview: boolean
		isLoadingCompletion: boolean
	}
	setPreviewState: (
		state: Partial<{
			firstLinePreview: string
			remainingLinesPreview: string
			hasAcceptedFirstLine: boolean
			isShowingAutocompletePreview: boolean
			isLoadingCompletion: boolean
		}>,
	) => void
}

interface AutocompleteProviderHelpers {
	clearAutocompletePreview: () => void
	showStreamingIndicator: (editor: vscode.TextEditor) => void
	cleanMarkdownCodeBlocks: (text: string) => string
	isFileDisabled: (document: vscode.TextDocument) => boolean
	validateCompletionContext: (
		context: vscode.InlineCompletionContext,
		document: vscode.TextDocument,
		position: vscode.Position,
	) => boolean
	loadingDecorationType: vscode.TextEditorDecorationType
	streamingDecorationType: vscode.TextEditorDecorationType
}

class AutocompleteProvider {
	private inlineCompletionProviderDisposable: vscode.Disposable | null = null

	constructor(
		private deps: AutocompleteProviderDeps,
		private state: AutocompleteProviderState,
		private helpers: AutocompleteProviderHelpers,
	) {}

	register(context: vscode.ExtensionContext): vscode.Disposable {
		this.inlineCompletionProviderDisposable = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" }, // All files
			{ provideInlineCompletionItems: (...args) => this.provideInlineCompletionItems(...args) },
		)
		context.subscriptions.push(this.inlineCompletionProviderDisposable)
		this.registerTextEditorEvents(context)
		this.registerPreviewCommands(context)

		context.subscriptions.push(
			vscode.commands.registerCommand("editor.action.inlineSuggest.commit", async () => {
				const previewState = this.state.getPreviewState()
				if (previewState.isShowingAutocompletePreview) {
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
		if (!this.state.isEnabled() || this.helpers.isFileDisabled(document)) {
			return null
		}

		try {
			const previewState = this.state.getPreviewState()
			if (previewState.hasAcceptedFirstLine && previewState.remainingLinesPreview) {
				const item = new vscode.InlineCompletionItem(previewState.remainingLinesPreview)
				item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
				this.state.setPreviewState({ isShowingAutocompletePreview: true })
				vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, true)
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
				this.state.setPreviewState({
					firstLinePreview: lines[0],
					remainingLinesPreview: lines.slice(1).join("\n"),
				})
				// Only show the first line initially
				item = new vscode.InlineCompletionItem(lines[0])
			} else {
				// Single line completion
				this.state.setPreviewState({
					firstLinePreview: completionText,
					remainingLinesPreview: "",
				})
				item = new vscode.InlineCompletionItem(completionText)
			}

			// Set command to ensure VS Code knows this is a completion that can be accepted with Tab
			item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
			this.state.setPreviewState({ isShowingAutocompletePreview: true })
			vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, true)

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
					this.state.setDebounceDelay(config.get("autocomplete.debounceDelay") || DEFAULT_DEBOUNCE_DELAY)
				}
			}),
		)
	}

	private registerToggleCommand(context: vscode.ExtensionContext, statusBarItem: vscode.StatusBarItem): void {
		context.subscriptions.push(
			vscode.commands.registerCommand("kilo-code.toggleAutocomplete", () => {
				const currentEnabled = this.state.isEnabled()
				this.state.setEnabled(!currentEnabled)
				const newEnabled = this.state.isEnabled()
				statusBarItem.text = newEnabled ? "$(sparkle) Autocomplete" : "$(circle-slash) Autocomplete"
				vscode.window.showInformationMessage(`Autocomplete ${newEnabled ? "enabled" : "disabled"}`)
			}),
		)
	}

	private registerTextEditorEvents(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.textEditor) {
					const previewState = this.state.getPreviewState()
					// Clear loading indicator when cursor moves
					if (previewState.isLoadingCompletion) {
						this.helpers.clearAutocompletePreview()
					}

					// Always hide the streaming decorator when cursor moves
					e.textEditor.setDecorations(this.helpers.streamingDecorationType, [])

					// If we've accepted the first line and cursor moves, reset state
					// This prevents showing remaining lines if user moves cursor after accepting first line
					if (previewState.hasAcceptedFirstLine && e.kind !== vscode.TextEditorSelectionChangeKind.Command) {
						this.helpers.clearAutocompletePreview()
					}
				}
			}),
		)

		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				const previewState = this.state.getPreviewState()
				if (previewState.isLoadingCompletion) {
					this.helpers.clearAutocompletePreview()
				} else {
					const editor = vscode.window.activeTextEditor
					if (editor && editor.document === e.document) {
						editor.setDecorations(this.helpers.loadingDecorationType, [])
						editor.setDecorations(this.helpers.streamingDecorationType, [])
					}
				}
			}),
		)
	}

	private registerPreviewCommands(context: vscode.ExtensionContext): void {
		const acceptCommand = vscode.commands.registerCommand("kilo-code.acceptAutocompletePreview", async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			const previewState = this.state.getPreviewState()

			// Handle the acceptance directly without calling commit again
			if (!previewState.hasAcceptedFirstLine && previewState.remainingLinesPreview) {
				// First Tab press: Insert the first line
				if (previewState.firstLinePreview) {
					await editor.edit((editBuilder) => {
						editBuilder.insert(editor.selection.active, previewState.firstLinePreview)
					})

					// Mark that we've accepted the first line
					this.state.setPreviewState({ hasAcceptedFirstLine: true })

					// Wait a moment for the first line to be inserted
					setTimeout(async () => {
						// Trigger a new completion to show the remaining lines
						await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
					}, 50)
				}
			} else if (previewState.hasAcceptedFirstLine && previewState.remainingLinesPreview) {
				// Second Tab press: Insert the remaining lines
				await editor.edit((editBuilder) => {
					editBuilder.insert(editor.selection.active, previewState.remainingLinesPreview)
				})

				// Reset state
				this.helpers.clearAutocompletePreview()
			} else {
				// For single line completion or when remainingLinesPreview is empty after first line acceptance
				// We need to ensure the full preview (which might be just the firstLinePreview if it was a single line)
				// is inserted if it hasn't been fully by VS Code's default commit.
				// However, the default commit (`editor.action.inlineSuggest.commit`) should handle this.
				// So, just clearing our state should be enough.
				this.helpers.clearAutocompletePreview()
			}
		})

		const dismissCommand = vscode.commands.registerCommand("kilo-code.dismissAutocompletePreview", () => {
			this.helpers.clearAutocompletePreview()
		})

		context.subscriptions.push(acceptCommand, dismissCommand)
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
			this.helpers.showStreamingIndicator(editor)
		}
		// Generate a unique ID for this completion
		const completionId = crypto.randomUUID()
		this.state.setActiveCompletionId(completionId)

		// Reset the acceptance state for a new completion
		this.state.setPreviewState({ hasAcceptedFirstLine: false })

		// Load configuration
		const conf = await this.deps.config.loadConfig()
		const useImports = conf?.useImports || false
		const useDefinitions = conf?.onlyMyCode || false
		const multilineCompletions = conf?.multilineCompletions || "auto"

		// Gather context
		const codeContext = await this.deps.contextGatherer.gatherContext(
			document,
			position,
			useImports,
			useDefinitions,
		)

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
		const prompt = this.deps.promptRenderer.renderPrompt(codeContext, snippets, promptOptions)
		const systemPrompt = this.deps.promptRenderer.renderSystemPrompt()

		// Setup cancellation
		const abortController = new AbortController()
		token.onCancellationRequested(() => {
			abortController.abort()
			if (this.state.getActiveCompletionId() === completionId) {
				this.state.setActiveCompletionId(null)
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
			const previewState = this.state.getPreviewState()
			if (editor && previewState.isLoadingCompletion) {
				editor.setDecorations(this.helpers.loadingDecorationType, [])
				this.state.setPreviewState({ isLoadingCompletion: false })
			}
			return null
		}

		// Validate completion against selection context
		if (!this.helpers.validateCompletionContext(context, document, position)) {
			// Make sure to clear the loading indicator if validation fails
			const editor = vscode.window.activeTextEditor
			const previewState = this.state.getPreviewState()
			if (editor && previewState.isLoadingCompletion) {
				editor.setDecorations(this.helpers.loadingDecorationType, [])
				this.state.setPreviewState({ isLoadingCompletion: false })
			}
			return null
		}

		return this.helpers.cleanMarkdownCodeBlocks(result.completion)
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

		// Local state for throttling
		let throttleTimeout: NodeJS.Timeout | null = null
		let pendingEditor: vscode.TextEditor | null = null

		// Function to check if the request has been cancelled
		const checkCancellation = () => {
			if (this.state.getActiveCompletionId() !== currentCompletionId) {
				isCancelled = true
				return true
			}
			return false
		}

		// Function to split completion into first line and remaining lines
		const splitCompletion = (text: string): { firstLine: string; remainingLines: string } => {
			const cleanedText = this.helpers.cleanMarkdownCodeBlocks(text)
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
		const stream = this.deps.apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		])

		// Get the editor for streaming updates
		const editor = vscode.window.activeTextEditor

		// Clear loading indicator when we start receiving content
		if (editor) {
			this.state.setPreviewState({ isLoadingCompletion: false })
			editor.setDecorations(this.helpers.loadingDecorationType, [])
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
				if (throttleTimeout) {
					clearTimeout(throttleTimeout)
				}

				// Store the pending editor
				pendingEditor = editor || null

				// Check if first line is complete (has a newline)
				if (!firstLineComplete && completion.includes("\n")) {
					firstLineComplete = true
					firstLine = currentFirstLine
					remainingLines = currentRemainingLines

					// Store the first line and remaining lines
					this.state.setPreviewState({
						firstLinePreview: firstLine,
						remainingLinesPreview: remainingLines,
						isShowingAutocompletePreview: true,
					})

					// Trigger inline suggestion
					vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
				} else {
					// Set a new throttle timeout
					throttleTimeout = setTimeout(() => {
						if (pendingEditor && pendingEditor.document === document) {
							// If first line is complete, update state based on current completion
							const previewState = this.state.getPreviewState()
							if (firstLineComplete) {
								if (!previewState.hasAcceptedFirstLine) {
									// Otherwise, still store just the first line
									this.state.setPreviewState({ firstLinePreview: currentFirstLine })
								}
								this.state.setPreviewState({ remainingLinesPreview: currentRemainingLines })
							} else {
								// If first line isn't complete yet, store everything
								const cleanedText = this.helpers.cleanMarkdownCodeBlocks(completion)
								this.state.setPreviewState({
									firstLinePreview: cleanedText,
									remainingLinesPreview: "",
								})
							}

							// Trigger inline suggestion to update
							if (previewState.isShowingAutocompletePreview) {
								vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
							}
						}
						throttleTimeout = null
					}, this.state.getDebounceDelay())
				}
			}
		}

		// Clear streaming indicator when streaming is complete
		if (editor) {
			editor.setDecorations(this.helpers.streamingDecorationType, [])
		}

		// Clean up any pending throttle timeout
		if (throttleTimeout) {
			clearTimeout(throttleTimeout)
		}

		// Final update to ensure we have the correct split
		const { firstLine: finalFirstLine, remainingLines: finalRemainingLines } = splitCompletion(completion)
		this.state.setPreviewState({
			firstLinePreview: finalFirstLine,
			remainingLinesPreview: finalRemainingLines,
		})

		// Set context for keybindings
		vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, true)

		return { completion, isCancelled }
	}

	/**
	 * Cleans up resources when the provider is no longer needed
	 */
	public dispose() {
		// Clear any active preview text
		const previewState = this.state.getPreviewState()
		if (previewState.isShowingAutocompletePreview) {
			this.helpers.clearAutocompletePreview()
		}

		// Dispose of the inline completion provider
		if (this.inlineCompletionProviderDisposable) {
			this.inlineCompletionProviderDisposable.dispose()
			this.inlineCompletionProviderDisposable = null
		}

		// Dispose of the decorator types
		this.helpers.loadingDecorationType.dispose()
		this.helpers.streamingDecorationType.dispose()
	}
}
