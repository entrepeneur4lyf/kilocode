//PLANREF: continue/core/autocomplete/CompletionProvider.ts
//PLANREF: continue/extensions/vscode/src/autocomplete/completionProvider.ts
import * as vscode from "vscode"
import { AutocompleteConfig } from "./AutocompleteConfig"
import { buildApiHandler } from "../../api"
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

	const cleanMarkdownCodeBlocks = (text: string): string =>
		text
			.replace(/```[\w-]*\n([\s\S]*?)\n```/g, "$1") // Handle complete code blocks
			.replace(/^```[\w-]*\n/g, "") // Handle opening code block markers at the beginning of a chunk
			.replace(/\n```[\w-]*\n/g, "\n") // Handle opening code block markers in the middle of a chunk
			.replace(/\n```$/g, "") // Handle closing code block markers
			.replace(/```[\w-]*$/g, "") // Handle any remaining backticks that might be part of incomplete code blocks
			.trim() // Trim any leading/trailing whitespace that might be left over

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

	// State variables are now accessed directly within the hookAutocompleteInner closure.
	// The 'state' object has been removed.

	// Dependencies
	const deps = { apiHandler, cache, config, contextGatherer, promptRenderer }

	// Inline completion provider disposable
	let inlineCompletionProviderDisposable: vscode.Disposable | null = null

	/**
	 * Processes the completion stream and returns the result
	 */
	const processCompletionStream = async (
		systemPrompt: string,
		prompt: string,
		completionId: string,
		document: vscode.TextDocument,
	): Promise<{ completion: string; isCancelled: boolean }> => {
		let completion = ""
		let isCancelled = false
		let firstLineComplete = false
		let firstLine_asdf = ""
		let remainingLines = ""

		// Local state for throttling
		let throttleTimeout: NodeJS.Timeout | null = null
		let pendingEditor: vscode.TextEditor | null = null

		// Function to check if the request has been cancelled

		// Function to split completion into first line and remaining lines
		const splitCompletion = (text: string): { firstLine: string; remainingLines: string } => {
			const cleanedText = cleanMarkdownCodeBlocks(text)
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
		const stream = deps.apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		])

		// Get the editor for streaming updates
		const editor = vscode.window.activeTextEditor

		// Clear loading indicator when we start receiving content
		if (editor) {
			isLoadingCompletion = false
			editor.setDecorations(loadingDecorationType, [])
			// Keep the streaming indicator visible while content is streaming
		}

		// Stream updates to store completion
		for await (const chunk of stream) {
			if (activeCompletionId !== completionId) {
				isCancelled = true
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
					firstLine_asdf = currentFirstLine
					remainingLines = currentRemainingLines

					// Store the first line and remaining lines
					firstLinePreview = firstLine_asdf
					remainingLinesPreview = remainingLines
					isShowingAutocompletePreview = true

					// Trigger inline suggestion
					vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
				} else {
					// Set a new throttle timeout
					throttleTimeout = setTimeout(() => {
						if (pendingEditor && pendingEditor.document === document) {
							// If first line is complete, update state based on current completion

							if (firstLineComplete) {
								if (!hasAcceptedFirstLine) {
									// Otherwise, still store just the first line
									firstLinePreview = currentFirstLine
								}
								remainingLinesPreview = currentRemainingLines
							} else {
								// If first line isn't complete yet, store everything
								const cleanedText = cleanMarkdownCodeBlocks(completion)
								firstLinePreview = cleanedText
								remainingLinesPreview = ""
							}

							// Trigger inline suggestion to update
							if (isShowingAutocompletePreview) {
								vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
							}
						}
						throttleTimeout = null
					}, debounceDelay)
				}
			}
		}

		// Clear streaming indicator when streaming is complete
		if (editor) {
			editor.setDecorations(streamingDecorationType, [])
		}

		// Clean up any pending throttle timeout
		if (throttleTimeout) {
			clearTimeout(throttleTimeout)
		}

		// Final update to ensure we have the correct split
		const { firstLine: finalFirstLine, remainingLines: finalRemainingLines } = splitCompletion(completion)
		firstLinePreview = finalFirstLine
		remainingLinesPreview = finalRemainingLines

		// Set context for keybindings
		vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, true)

		return { completion, isCancelled }
	}

	/**
	 * Generates a new completion text
	 */
	const generateCompletionText = async (
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<string | null> => {
		// Show streaming indicator while generating completion
		const editor = vscode.window.activeTextEditor
		if (editor && editor.document === document) {
			showStreamingIndicator(editor)
		}
		// Generate a unique ID for this completion
		const completionId = crypto.randomUUID()
		activeCompletionId = completionId

		// Reset the acceptance state for a new completion
		hasAcceptedFirstLine = false

		// Load configuration
		const conf = await deps.config.loadConfig()
		const useImports = conf?.useImports || false
		const useDefinitions = conf?.onlyMyCode || false
		const multilineCompletions = conf?.multilineCompletions || "auto"

		// Gather context
		const codeContext = await deps.contextGatherer.gatherContext(document, position, useImports, useDefinitions)

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
		const prompt = deps.promptRenderer.renderPrompt(codeContext, snippets, promptOptions)
		const systemPrompt = deps.promptRenderer.renderSystemPrompt()

		// Setup cancellation
		const abortController = new AbortController()
		token.onCancellationRequested(() => {
			abortController.abort()
			if (activeCompletionId === completionId) {
				activeCompletionId = null
			}
		})

		// Process the completion stream
		const startTime = performance.now()
		const result = await processCompletionStream(systemPrompt, prompt.prompt, completionId, document)
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

			if (editor && isLoadingCompletion) {
				editor.setDecorations(loadingDecorationType, [])
				isLoadingCompletion = false
			}
			return null
		}

		// Validate completion against selection context
		if (!validateCompletionContext(context, document, position)) {
			// Make sure to clear the loading indicator if validation fails
			const editor = vscode.window.activeTextEditor

			if (editor && isLoadingCompletion) {
				editor.setDecorations(loadingDecorationType, [])
				isLoadingCompletion = false
			}
			return null
		}

		return cleanMarkdownCodeBlocks(result.completion)
	}

	const provideInlineCompletionItems = async (
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> => {
		// Don't provide completions if disabled
		if (!enabled || isFileDisabled(document)) {
			return null
		}

		try {
			if (hasAcceptedFirstLine && remainingLinesPreview) {
				const item = new vscode.InlineCompletionItem(remainingLinesPreview)
				item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
				isShowingAutocompletePreview = true
				vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, true)
				return [item]
			}

			// Otherwise, generate a new completion
			const completionText = await generateCompletionText(document, position, context, token)
			if (!completionText) return null

			// Split the completion into first line and remaining lines
			const lines = completionText.split("\n")

			// Create the completion item
			let item: vscode.InlineCompletionItem

			if (lines.length > 1) {
				firstLinePreview = lines[0]
				remainingLinesPreview = lines.slice(1).join("\n")
				// Only show the first line initially
				item = new vscode.InlineCompletionItem(lines[0])
			} else {
				// Single line completion
				firstLinePreview = completionText
				remainingLinesPreview = ""
				item = new vscode.InlineCompletionItem(completionText)
			}

			isShowingAutocompletePreview = true
			vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, true)

			return [item]
		} catch (error) {
			console.error("Error providing inline completion:", error)
			return null
		}
	}

	const registerStatusBarItem = (context: vscode.ExtensionContext): vscode.StatusBarItem => {
		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
		statusBarItem.text = "$(sparkle) Autocomplete"
		statusBarItem.tooltip = "Kilo Code Autocomplete"
		statusBarItem.command = "kilo-code.toggleAutocomplete"
		statusBarItem.show()
		context.subscriptions.push(statusBarItem)
		return statusBarItem
	}

	const registerConfigurationWatcher = (context: vscode.ExtensionContext): void => {
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("kilo-code.autocomplete")) {
					const config = vscode.workspace.getConfiguration("kilo-code")
					debounceDelay = config.get("autocomplete.debounceDelay") || DEFAULT_DEBOUNCE_DELAY
				}
			}),
		)
	}

	const registerToggleCommand = (context: vscode.ExtensionContext, statusBarItem: vscode.StatusBarItem): void => {
		context.subscriptions.push(
			vscode.commands.registerCommand("kilo-code.toggleAutocomplete", () => {
				const currentEnabled = enabled
				enabled = !currentEnabled
				const newEnabled = enabled
				statusBarItem.text = newEnabled ? "$(sparkle) Autocomplete" : "$(circle-slash) Autocomplete"
				vscode.window.showInformationMessage(`Autocomplete ${newEnabled ? "enabled" : "disabled"}`)
			}),
		)
	}

	const registerTextEditorEvents = (context: vscode.ExtensionContext): void => {
		context.subscriptions.push(
			vscode.window.onDidChangeTextEditorSelection((e) => {
				if (e.textEditor) {
					// Clear loading indicator when cursor moves
					if (isLoadingCompletion) {
						clearAutocompletePreview()
					}

					// Always hide the streaming decorator when cursor moves
					e.textEditor.setDecorations(streamingDecorationType, [])

					// If we've accepted the first line and cursor moves, reset state
					// This prevents showing remaining lines if user moves cursor after accepting first line
					if (hasAcceptedFirstLine && e.kind !== vscode.TextEditorSelectionChangeKind.Command) {
						clearAutocompletePreview()
					}
				}
			}),
		)

		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (isLoadingCompletion) {
					clearAutocompletePreview()
				} else {
					const editor = vscode.window.activeTextEditor
					if (editor && editor.document === e.document) {
						editor.setDecorations(loadingDecorationType, [])
						editor.setDecorations(streamingDecorationType, [])
					}
				}
			}),
		)
	}

	const registerPreviewCommands = (context: vscode.ExtensionContext): void => {
		const acceptCommand = vscode.commands.registerCommand("kilo-code.acceptAutocompletePreview", async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			// Handle the acceptance directly without calling commit again
			if (!hasAcceptedFirstLine && remainingLinesPreview) {
				// First Tab press: Insert the first line
				if (firstLinePreview) {
					await editor.edit((editBuilder) => {
						editBuilder.insert(editor.selection.active, firstLinePreview)
					})

					// Mark that we've accepted the first line
					hasAcceptedFirstLine = true

					// Wait a moment for the first line to be inserted
					setTimeout(async () => {
						// Trigger a new completion to show the remaining lines
						await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
					}, 50)
				}
			} else if (hasAcceptedFirstLine && remainingLinesPreview) {
				// Second Tab press: Insert the remaining lines
				await editor.edit((editBuilder) => {
					editBuilder.insert(editor.selection.active, remainingLinesPreview)
				})

				// Reset state
				clearAutocompletePreview()
			} else {
				// For single line completion or when remainingLinesPreview is empty after first line acceptance
				// We need to ensure the full preview (which might be just the firstLinePreview if it was a single line)
				// is inserted if it hasn't been fully by VS Code's default commit.
				// However, the default commit (`editor.action.inlineSuggest.commit`) should handle this.
				// So, just clearing our state should be enough.
				clearAutocompletePreview()
			}
		})

		const dismissCommand = vscode.commands.registerCommand("kilo-code.dismissAutocompletePreview", () => {
			clearAutocompletePreview()
		})

		context.subscriptions.push(acceptCommand, dismissCommand)
	}

	/**
	 * Cleans up resources when the provider is no longer needed
	 */
	const dispose = () => {
		if (isShowingAutocompletePreview) {
			clearAutocompletePreview()
		}

		// Dispose of the inline completion provider
		if (inlineCompletionProviderDisposable) {
			inlineCompletionProviderDisposable.dispose()
			inlineCompletionProviderDisposable = null
		}

		// Dispose of the decorator types
		loadingDecorationType.dispose()
		streamingDecorationType.dispose()
		// Reset the context when disposing
		vscode.commands.executeCommand("setContext", AUTOCOMPLETE_PREVIEW_VISIBLE_CONTEXT_KEY, false)
	}

	const register = (context: vscode.ExtensionContext) => {
		inlineCompletionProviderDisposable = vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" }, // All files
			{ provideInlineCompletionItems: (...args) => provideInlineCompletionItems(...args) },
		)
		context.subscriptions.push(inlineCompletionProviderDisposable)
		registerTextEditorEvents(context)
		registerPreviewCommands(context)

		context.subscriptions.push(
			vscode.commands.registerCommand("editor.action.inlineSuggest.commit", async () => {
				if (isShowingAutocompletePreview) {
					await vscode.commands.executeCommand("kilo-code.acceptAutocompletePreview")
				} else {
					// not sure if this is needed: leaving it here for now
					await vscode.commands.executeCommand("default:editor.action.inlineSuggest.commit")
				}
			}),
		)

		const statusBarItem = registerStatusBarItem(context)
		registerConfigurationWatcher(context)
		registerToggleCommand(context, statusBarItem)
	}

	// Main provider implementation
	register(context)

	// Subscribe to cleanup
	context.subscriptions.push({ dispose })
}
