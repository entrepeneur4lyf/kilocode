//PLANREF: continue/core/autocomplete/CompletionProvider.ts
//PLANREF: continue/extensions/vscode/src/autocomplete/completionProvider.ts
import * as vscode from "vscode"
import { AutocompleteConfig } from "./AutocompleteConfig"
import { buildApiHandler } from "../../api"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer"
import { CompletionCache } from "./utils/CompletionCache"
import { ContextProxy } from "../../core/config/ContextProxy"
import { CompletionState } from "./CompletionState"
import { DecorationManager } from "./DecorationManager"
import { InlineCompletionHandler } from "./InlineCompletionHandler"
import { CompletionGenerator } from "./CompletionGenerator"

// Default configuration values
export const DEFAULT_DEBOUNCE_DELAY = 150
const DEFAULT_MODEL = "mistralai/codestral-2501"

export class AutocompleteProvider implements vscode.InlineCompletionItemProvider {
	// Core state
	private enabled: boolean = true
	private debounceDelay: number = DEFAULT_DEBOUNCE_DELAY

	// Core services
	private readonly cache: CompletionCache
	private readonly config: AutocompleteConfig
	private readonly completionState: CompletionState
	private readonly decorationManager: DecorationManager
	private readonly inlineCompletionHandler: InlineCompletionHandler
	private readonly completionGenerator: CompletionGenerator

	// Provider registration
	private inlineCompletionProviderDisposable: vscode.Disposable | null = null

	constructor() {
		// Initialize core services
		this.cache = new CompletionCache()
		this.config = new AutocompleteConfig()
		this.completionState = new CompletionState()
		this.decorationManager = new DecorationManager()
		this.inlineCompletionHandler = new InlineCompletionHandler(this.completionState)

		// Initialize API handler
		const kilocodeToken = ContextProxy.instance.getProviderSettings().kilocodeToken
		const apiHandler = buildApiHandler({
			apiProvider: "kilocode",
			kilocodeToken: kilocodeToken,
			kilocodeModel: DEFAULT_MODEL,
		})

		// Initialize completion generator
		const contextGatherer = new ContextGatherer()
		const promptRenderer = new PromptRenderer({}, DEFAULT_MODEL)

		this.completionGenerator = new CompletionGenerator(
			apiHandler,
			contextGatherer,
			promptRenderer,
			this.config,
			this.completionState,
			this.decorationManager,
			this.debounceDelay,
		)
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
				if (this.completionState.isShowingPreview) {
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
			// Check if we're showing remaining lines after first line acceptance
			if (this.completionState.hasAcceptedFirstLine && this.completionState.remainingLinesPreview) {
				return this.inlineCompletionHandler.createCompletionItems()
			}

			// Check cache first
			const cursorIndex = document.offsetAt(position)
			const cachedCompletion = this.cache.get(document.uri.toString(), document.getText(), cursorIndex)

			if (cachedCompletion) {
				this.completionState.setCompletionText(cachedCompletion)
				return this.inlineCompletionHandler.createCompletionItems()
			}

			// Generate a new completion
			const completionText = await this.completionGenerator.generateCompletion(document, position, context, token)
			if (!completionText) return null

			// Remove any matching prefix
			const lineText = document.lineAt(position.line).text
			const textBeforeCursor = lineText.substring(0, position.character).trimStart()
			const finalCompletionText = this.removeMatchingPrefix(textBeforeCursor, completionText)

			// Cache the result
			this.cache.set(document.uri.toString(), document.getText(), cursorIndex, finalCompletionText)

			// Set completion text and create items
			this.completionState.setCompletionText(finalCompletionText)
			return this.inlineCompletionHandler.createCompletionItems()
		} catch (error) {
			console.error("Error providing inline completion:", error)
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
					this.completionGenerator.updateDebounceDelay(this.debounceDelay)
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
					if (this.completionState.isLoading) {
						this.clearAutocompletePreview()
					}

					// Always hide the streaming decorator when cursor moves
					this.decorationManager.clearStreamingIndicator(e.textEditor)

					// If we've accepted the first line and cursor moves, reset state
					// This prevents showing remaining lines if user moves cursor after accepting first line
					if (
						this.completionState.hasAcceptedFirstLine &&
						e.kind !== vscode.TextEditorSelectionChangeKind.Command
					) {
						this.clearAutocompletePreview()
					}
				}
			}),
		)

		context.subscriptions.push(
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.completionState.isLoading) {
					this.clearAutocompletePreview()
				} else {
					const editor = vscode.window.activeTextEditor
					if (editor && editor.document === e.document) {
						this.decorationManager.clearAll(editor)
					}
				}
			}),
		)
	}

	private registerPreviewCommands(context: vscode.ExtensionContext): void {
		const acceptCommand = vscode.commands.registerCommand("kilo-code.acceptAutocompletePreview", async () => {
			const editor = vscode.window.activeTextEditor
			if (!editor) return

			await this.inlineCompletionHandler.handleAcceptance(editor)
		})

		const dismissCommand = vscode.commands.registerCommand("kilo-code.dismissAutocompletePreview", () => {
			this.clearAutocompletePreview()
		})

		context.subscriptions.push(acceptCommand, dismissCommand)
	}

	/**
	 * Clears any displayed preview text and loading indicator
	 */
	public clearAutocompletePreview() {
		this.completionState.reset()

		// Clear loading indicators
		const editor = vscode.window.activeTextEditor
		if (editor) {
			this.decorationManager.clearAll(editor)
		}

		// Hide any active inline suggestions
		this.inlineCompletionHandler.dismiss()
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
		// Clear any active preview text
		if (this.completionState.isShowingPreview) {
			this.clearAutocompletePreview()
		}

		// Dispose of the inline completion provider
		if (this.inlineCompletionProviderDisposable) {
			this.inlineCompletionProviderDisposable.dispose()
			this.inlineCompletionProviderDisposable = null
		}

		// Dispose of services
		this.decorationManager.dispose()
		this.completionGenerator.dispose()
	}
}
