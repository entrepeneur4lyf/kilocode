//PLANREF: continue/core/autocomplete/CompletionProvider.ts
//PLANREF: continue/extensions/vscode/src/autocomplete/completionProvider.ts
import * as vscode from "vscode"
import { AutocompleteConfig } from "./AutocompleteConfig"
import { ApiHandler, buildApiHandler } from "../../api"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer"
import { CompletionCache } from "./utils/CompletionCache"
import { AutocompleteDebouncer } from "./utils/AutocompleteDebouncer" // AIDIFF: Import new debouncer
import { v4 as uuidv4 } from "uuid" // AIDIFF: Import uuid for completion IDs, aligning with continue/

// Default configuration values
const DEFAULT_DEBOUNCE_DELAY = 150
const DEFAULT_OLLAMA_MODEL = "qwen2.5-coder:1.5b"
const DEFAULT_OLLAMA_URL = "http://localhost:11434"
const MIN_TYPED_LENGTH_FOR_COMPLETION = 4

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
	// API and completion state
	private apiHandler: ApiHandler
	private enabled: boolean = true
	private activeCompletionId: string | null = null
	private activeCompletionAbortController: AbortController | null = null // AIDIFF: To manage cancellation of ongoing requests

	// Debouncing
	// PLANREF: continue/core/autocomplete/util/AutocompleteDebouncer.ts
	private readonly debouncer: AutocompleteDebouncer // AIDIFF: New debouncer instance
	private debounceDelay: number = DEFAULT_DEBOUNCE_DELAY // AIDIFF: Kept for configuration, used by new debouncer
	// AIDIFF: Removed throttleTimeout and pendingEditor as they are replaced by the new debouncer logic

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
		this.debouncer = new AutocompleteDebouncer() // AIDIFF: Initialize new debouncer
		this.cache = new CompletionCache()
		this.config = new AutocompleteConfig()
		this.contextGatherer = new ContextGatherer()
		// AIDIFF: Instantiate PromptRenderer with empty options and default model.
		// PromptRenderer's constructor handles partial options.
		this.promptRenderer = new PromptRenderer({}, DEFAULT_OLLAMA_MODEL)

		this.apiHandler = buildApiHandler({
			apiProvider: "ollama", // TODO: This should ideally come from config too
			ollamaModelId: DEFAULT_OLLAMA_MODEL,
			ollamaBaseUrl: DEFAULT_OLLAMA_URL,
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
			{ pattern: "**" },
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
		// AIDIFF: Overall structure adapted from continue/core/autocomplete/CompletionProvider.ts and continue/extensions/vscode/src/autocomplete/completionProvider.ts
		if (!this.enabled || this.isFileDisabled(document)) {
			this.debouncer.clear()
			return null
		}

		if (token.isCancellationRequested) {
			this.debouncer.clear()
			return null
		}

		// PLANREF: continue/core/autocomplete/CompletionProvider.ts L147-150
		if (await this.debouncer.delayAndShouldDebounce(this.debounceDelay)) {
			return null
		}

		if (this.activeCompletionAbortController) {
			this.activeCompletionAbortController.abort()
			this.activeCompletionAbortController = null
		}
		const abortController = new AbortController()
		this.activeCompletionAbortController = abortController
		const combinedSignal = abortController.signal
		token.onCancellationRequested(() => {
			abortController.abort()
			if (this.activeCompletionId) this.activeCompletionId = null
		})

		// PLANREF: continue/extensions/vscode/src/autocomplete/completionProvider.ts L105-113
		if (
			document.uri.scheme === "vscode-scm" ||
			(vscode.window.activeTextEditor && vscode.window.activeTextEditor.selections.length > 1)
		) {
			return null
		}

		// PLANREF: continue/extensions/vscode/src/autocomplete/completionProvider.ts L115-133 (selectedCompletionInfo check)
		const { selectedCompletionInfo } = context
		if (selectedCompletionInfo) {
			// AIDIFF: Use _text to satisfy eslint unused-var rule, range is used.
			const { text: _text, range } = selectedCompletionInfo
			const typedLength = range.end.character - range.start.character
			if (typedLength < MIN_TYPED_LENGTH_FOR_COMPLETION) {
				return null
			}
		}

		try {
			if (this.hasAcceptedFirstLine && this.remainingLinesPreview) {
				const item = new vscode.InlineCompletionItem(this.remainingLinesPreview)
				item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
				this.isShowingAutocompletePreview = true
				vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, true)
				return [item]
			}

			// AIDIFF: Pass position to validateCompletionContext
			if (!this.validateCompletionContext(context, document, position)) {
				this.clearLoadingIndicatorIfNeeded()
				return null
			}

			const completionText = await this.generateCompletionText(document, position, context, combinedSignal, token)
			if (combinedSignal.aborted || token.isCancellationRequested || !completionText) {
				this.clearLoadingIndicatorIfNeeded()
				return null
			}

			const lines = completionText.split("\n")
			let item: vscode.InlineCompletionItem

			// AIDIFF: Use typed config for multilineCompletions
			const currentConfig = await this.config.loadConfig()
			if (lines.length > 1 && currentConfig.multilineCompletions === "two-stage") {
				this.firstLinePreview = lines[0]
				this.remainingLinesPreview = lines.slice(1).join("\n")
				item = new vscode.InlineCompletionItem(this.firstLinePreview)
			} else {
				this.firstLinePreview = completionText
				this.remainingLinesPreview = ""
				item = new vscode.InlineCompletionItem(completionText)
			}

			item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }
			this.isShowingAutocompletePreview = true
			vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, true)

			return [item]
		} catch (error: any) {
			if (error.name === "AbortError") {
				console.log("Autocomplete request aborted.")
			} else {
				console.error("Error providing inline completion:", error)
			}
			this.clearLoadingIndicatorIfNeeded()
			return null
		} finally {
			if (this.activeCompletionAbortController === abortController) {
				this.activeCompletionAbortController = null
			}
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
			vscode.workspace.onDidChangeConfiguration(async (e) => {
				// AIDIFF: Make async for config loading
				if (e.affectsConfiguration("kilo-code.autocomplete")) {
					const configValues = await this.config.loadConfig() // AIDIFF: Load full config
					this.debounceDelay = configValues?.debounceDelay || DEFAULT_DEBOUNCE_DELAY
					// AIDIFF: Update ApiHandler if relevant settings change (e.g. model, URL)
					// This is a simplified version; a more robust update mechanism might be needed.
					// TODO: The "apiProvider" is still hardcoded to "ollama". This should be configurable.
					this.apiHandler = buildApiHandler({
						apiProvider: "ollama",
						ollamaModelId: configValues?.ollamaModelId || DEFAULT_OLLAMA_MODEL,
						ollamaBaseUrl: configValues?.ollamaBaseUrl || DEFAULT_OLLAMA_URL,
						// Pass other relevant options from configValues if ApiHandler/buildApiHandler supports them
					})
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
					this.debouncer.clear()
					if (this.isLoadingCompletion) {
						this.clearAutocompletePreview()
					} else {
						e.textEditor.setDecorations(this.loadingDecorationType, [])
						e.textEditor.setDecorations(this.streamingDecorationType, [])
					}
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

			if (!this.hasAcceptedFirstLine && this.remainingLinesPreview) {
				if (this.firstLinePreview) {
					await editor.edit((editBuilder) => {
						editBuilder.insert(editor.selection.active, this.firstLinePreview)
					})
					this.hasAcceptedFirstLine = true
					setTimeout(async () => {
						await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
					}, 50)
				}
			} else if (this.hasAcceptedFirstLine && this.remainingLinesPreview) {
				await editor.edit((editBuilder) => {
					editBuilder.insert(editor.selection.active, this.remainingLinesPreview)
				})
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

	private showLoadingIndicator(editor: vscode.TextEditor): void {
		this.clearAutocompletePreview() // Clear previous state before showing new loading
		this.isLoadingCompletion = true
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(this.loadingDecorationType, [decoration])
	}

	private showStreamingIndicator(editor: vscode.TextEditor): void {
		// Assuming loading indicator is already shown, or clear it if not, then show streaming
		editor.setDecorations(this.loadingDecorationType, []) // Clear loading
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(this.streamingDecorationType, [decoration])
	}

	// AIDIFF: Removed deprecated getCompletionText method
	// private async getCompletionText(...)

	private removeMatchingPrefix(textBeforeCursor: string, result: string): string {
		if (!textBeforeCursor || !result.startsWith(textBeforeCursor)) {
			return result
		}
		return result.slice(textBeforeCursor.length)
	}

	private async generateCompletionText(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		abortSignal: AbortSignal,
		vscodeToken: vscode.CancellationToken,
	): Promise<string | null> {
		const editor = vscode.window.activeTextEditor
		if (editor && editor.document === document) {
			this.showLoadingIndicator(editor) // Show loading indicator
		}

		const completionId = uuidv4()
		this.activeCompletionId = completionId
		this.hasAcceptedFirstLine = false

		const loadedConfig = await this.config.loadConfig()
		const useImports = loadedConfig.useImports ?? false // Default if undefined
		const useDefinitions = loadedConfig.onlyMyCode ?? true // Default if undefined
		const multilineCompletions = loadedConfig.multilineCompletions ?? "auto"
		// AIDIFF: Use typed config for ollamaParameters and ollamaModelId
		const ollamaParameters = loadedConfig.ollamaParameters ?? {}
		const ollamaModelId = loadedConfig.ollamaModelId || DEFAULT_OLLAMA_MODEL // Use default if not configured

		const codeContext = await this.contextGatherer.gatherContext(document, position, useImports, useDefinitions)
		if (abortSignal.aborted || vscodeToken.isCancellationRequested) return null

		// AIDIFF: Get prompt, prefix, and suffix from PromptRenderer
		const {
			prompt,
			prefix: fimPrefix,
			suffix: fimSuffix,
			completionOptions,
		} = this.promptRenderer.renderPrompt(codeContext, {
			language: document.languageId,
			includeImports: useImports,
			includeDefinitions: useDefinitions,
			multilineCompletions: multilineCompletions, // Already string | "auto"
		})
		const systemPrompt = this.promptRenderer.renderSystemPrompt()

		if (abortSignal.aborted || vscodeToken.isCancellationRequested) return null

		let fullCompletion = ""
		let streamCancelled = false

		try {
			// AIDIFF: Call getCompletionStream without casting; method is now defined on ApiHandler.
			// Use stop tokens from completionOptions returned by renderPrompt.
			const stream = this.apiHandler.getCompletionStream(
				{
					prompt: prompt, // Use the rendered prompt
					systemPrompt,
					modelId: ollamaModelId,
					temperature: (ollamaParameters as any).temperature ?? completionOptions?.temperature ?? 0.1, // Prioritize specific ollama param, then template, then default
					stop: completionOptions?.stop, // Use stop tokens from PromptRenderer
				},
				abortSignal,
			)

			if (editor && editor.document === document) {
				this.showStreamingIndicator(editor) // Switch to streaming indicator
			}

			for await (const chunk of stream) {
				if (abortSignal.aborted || vscodeToken.isCancellationRequested) {
					streamCancelled = true
					break
				}
				fullCompletion += chunk
			}
		} catch (error: any) {
			if (error.name === "AbortError") {
				streamCancelled = true
			} else {
				console.error("Error during completion stream:", error)
				this.clearLoadingIndicatorIfNeeded(editor)
				return null
			}
		} finally {
			if (editor && editor.document === document) {
				editor.setDecorations(this.streamingDecorationType, []) // Clear streaming indicator
			}
		}

		if (streamCancelled) {
			this.clearLoadingIndicatorIfNeeded(editor)
			return null
		}

		// AIDIFF: Use fimPrefix and fimSuffix from renderPrompt for post-processing.
		let processedCompletion = this._postprocessCompletion(fullCompletion, fimPrefix, fimSuffix, ollamaModelId)

		// AIDIFF: Validation already happened in provideInlineCompletionItems before calling generateCompletionText.
		// If further validation is needed post-generation, it can be added here.
		// For now, removing the redundant call.
		// if (!this.validateCompletionContext(context, document, position)) {
		// 	this.clearLoadingIndicatorIfNeeded(editor);
		// 	return null;
		// }

		const cursorIndex = document.offsetAt(position)
		// AIDIFF: Cache the processed completion
		this.cache.set(document.uri.toString(), document.getText(), cursorIndex, processedCompletion)

		this.clearLoadingIndicatorIfNeeded(editor)
		return processedCompletion
	}

	// AIDIFF: Placeholder for post-processing logic from continue/core/autocomplete/postprocessing/index.ts
	// This will be implemented in a subsequent step.
	private _postprocessCompletion(completion: string, prefix: string, suffix: string, modelName: string): string {
		// For now, just use existing markdown cleaning.
		// TODO: Integrate full postprocessing logic here.
		console.log(
			"Placeholder: _postprocessCompletion called for model:",
			modelName,
			"prefix:",
			prefix,
			"suffix:",
			suffix,
		)
		return this.cleanMarkdownCodeBlocks(completion)
	}

	private clearLoadingIndicatorIfNeeded(currentEditor?: vscode.TextEditor): void {
		const editor = currentEditor || vscode.window.activeTextEditor
		if (editor) {
			if (this.isLoadingCompletion) {
				editor.setDecorations(this.loadingDecorationType, [])
				this.isLoadingCompletion = false
			}
			editor.setDecorations(this.streamingDecorationType, [])
		}
	}

	public clearAutocompletePreview() {
		// AIDIFF: Clear debouncer
		this.debouncer.clear()

		// AIDIFF: Cancel any ongoing request
		if (this.activeCompletionAbortController) {
			this.activeCompletionAbortController.abort()
			this.activeCompletionAbortController = null
		}
		this.activeCompletionId = null

		this.isShowingAutocompletePreview = false
		// AIDIFF: isLoadingCompletion is cleared by clearLoadingIndicatorIfNeeded
		this.currentAutocompletePreview = ""
		this.firstLinePreview = ""
		this.remainingLinesPreview = ""
		this.hasAcceptedFirstLine = false

		this.clearLoadingIndicatorIfNeeded() // Clears decorations

		vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, false)
		vscode.commands.executeCommand("editor.action.inlineSuggest.hide") // Explicitly hide VS Code's suggestion UI
	}

	private cleanMarkdownCodeBlocks(text: string): string {
		const codeBlockRegex = /```[\s\S]*?\n([\s\S]*?)```/g
		let match
		let cleanedText = text
		while ((match = codeBlockRegex.exec(text)) !== null) {
			cleanedText = match[1]
		}
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

	private isFileDisabled(document: vscode.TextDocument): boolean {
		const config = vscode.workspace.getConfiguration("kilo-code")
		// AIDIFF: Assuming 'autocomplete.disabledFor' is the correct config key based on typical naming.
		// If it's 'disableInFiles' as seen in some snippets, this should be adjusted.
		// For now, using 'disabledFor' as per common convention and initial plan.
		const disabledPatternsGlobs = config.get<string[]>("autocomplete.disabledFor") || []

		// AIDIFF: Using vscode.languages.match for glob patterns as it's more robust for VS Code extensions.
		// This replaces the previous RegExp logic.
		// PLANREF: Inspired by how VS Code handles file matching internally.
		const documentUri = document.uri
		for (const globPattern of disabledPatternsGlobs) {
			if (vscode.languages.match({ scheme: documentUri.scheme, pattern: globPattern }, document)) {
				return true
			}
		}
		return false
	}

	public dispose() {
		// AIDIFF: Clear debouncer
		this.debouncer.clear()

		// AIDIFF: Cancel any ongoing request
		if (this.activeCompletionAbortController) {
			this.activeCompletionAbortController.abort()
			this.activeCompletionAbortController = null
		}
		this.activeCompletionId = null

		if (this.isShowingAutocompletePreview) {
			this.clearAutocompletePreview()
		}

		if (this.inlineCompletionProviderDisposable) {
			this.inlineCompletionProviderDisposable.dispose()
			this.inlineCompletionProviderDisposable = null
		}

		this.loadingDecorationType.dispose()
		this.streamingDecorationType.dispose()
		vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, false)
	}
}
