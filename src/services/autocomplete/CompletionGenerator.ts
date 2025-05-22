import * as vscode from "vscode"
import { ApiHandler } from "../../api"
import { ContextGatherer } from "./ContextGatherer"
import { PromptRenderer } from "./PromptRenderer"
import { AutocompleteConfig } from "./AutocompleteConfig"
import { CompletionState } from "./CompletionState"
import { DecorationManager } from "./DecorationManager"
import { Debouncer } from "./utils/Debouncer"
import { generateImportSnippets, generateDefinitionSnippets } from "./context/snippetProvider"

export const MIN_TYPED_LENGTH_FOR_COMPLETION = 4

/**
 * Handles completion generation and streaming
 */
export class CompletionGenerator {
	private readonly apiHandler: ApiHandler
	private readonly contextGatherer: ContextGatherer
	private readonly promptRenderer: PromptRenderer
	private readonly config: AutocompleteConfig
	private readonly completionState: CompletionState
	private readonly decorationManager: DecorationManager
	private readonly streamDebouncer: Debouncer<(editor: vscode.TextEditor, document: vscode.TextDocument) => void>

	constructor(
		apiHandler: ApiHandler,
		contextGatherer: ContextGatherer,
		promptRenderer: PromptRenderer,
		config: AutocompleteConfig,
		completionState: CompletionState,
		decorationManager: DecorationManager,
		debounceDelay: number,
	) {
		this.apiHandler = apiHandler
		this.contextGatherer = contextGatherer
		this.promptRenderer = promptRenderer
		this.config = config
		this.completionState = completionState
		this.decorationManager = decorationManager

		// Create debouncer for stream updates
		this.streamDebouncer = new Debouncer((editor, document) => {
			this.updateStreamingPreview(editor, document)
		}, debounceDelay)
	}

	/**
	 * Generate completion text for the given position
	 */
	async generateCompletion(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<string | null> {
		// Validate context first
		if (!this.validateContext(context, document, position)) {
			return null
		}

		// Show streaming indicator
		const editor = vscode.window.activeTextEditor
		if (editor && editor.document === document) {
			this.decorationManager.showStreamingIndicator(editor)
		}

		// Generate a unique ID for this completion
		const completionId = crypto.randomUUID()
		this.completionState.startCompletion(completionId)

		try {
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

			// Define options for prompt rendering
			const promptOptions = {
				language: document.languageId,
				includeImports: useImports,
				includeDefinitions: useDefinitions,
				multilineCompletions: multilineCompletions as any,
			}

			// Render prompts
			const prompt = this.promptRenderer.renderPrompt(codeContext, snippets, promptOptions)
			const systemPrompt = this.promptRenderer.renderSystemPrompt()

			// Setup cancellation
			const abortController = new AbortController()
			token.onCancellationRequested(() => {
				abortController.abort()
				this.completionState.cancelCompletion()
			})

			// Process the completion stream
			const result = await this.processStream(
				systemPrompt,
				prompt.prompt,
				completionId,
				document,
				abortController.signal,
			)

			if (result.isCancelled || token.isCancellationRequested) {
				return null
			}

			return this.cleanMarkdownCodeBlocks(result.completion)
		} finally {
			// Clear decorations
			if (editor) {
				this.decorationManager.clearAll(editor)
			}
		}
	}

	/**
	 * Process the completion stream
	 */
	private async processStream(
		systemPrompt: string,
		prompt: string,
		completionId: string,
		document: vscode.TextDocument,
		signal: AbortSignal,
	): Promise<{ completion: string; isCancelled: boolean }> {
		let completion = ""
		let isCancelled = false
		let firstLineComplete = false

		// Create the stream
		const stream = this.apiHandler.createMessage(systemPrompt, [
			{ role: "user", content: [{ type: "text", text: prompt }] },
		])

		const editor = vscode.window.activeTextEditor

		// Clear loading indicator when we start receiving content
		if (editor) {
			this.completionState.stopLoading()
			this.decorationManager.clearLoadingIndicator(editor)
		}

		// Process stream chunks
		for await (const chunk of stream) {
			// Check cancellation
			if (signal.aborted || !this.completionState.isCompletionActive(completionId)) {
				isCancelled = true
				break
			}

			if (chunk.type === "text") {
				completion += chunk.text
				const cleanedCompletion = this.cleanMarkdownCodeBlocks(completion)

				// Update completion state
				this.completionState.setCompletionText(cleanedCompletion)

				// Check if first line is complete
				if (!firstLineComplete && completion.includes("\n")) {
					firstLineComplete = true
					this.completionState.showPreview()

					// Trigger inline suggestion immediately for first line
					if (editor && editor.document === document) {
						vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
					}
				} else if (editor && editor.document === document) {
					this.streamDebouncer.debounce(editor, document)
				}
			}
		}

		// Clear streaming indicator
		if (editor) {
			this.decorationManager.clearStreamingIndicator(editor)
		}

		// Final update
		if (!isCancelled && this.completionState.isShowingPreview) {
			vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
		}

		return { completion, isCancelled }
	}

	/**
	 * Update streaming preview
	 */
	private updateStreamingPreview(editor: vscode.TextEditor, document: vscode.TextDocument): void {
		if (this.completionState.isShowingPreview && editor.document === document) {
			vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
		}
	}

	/**
	 * Validate completion context
	 */
	private validateContext(
		context: vscode.InlineCompletionContext,
		document: vscode.TextDocument,
		position: vscode.Position,
	): boolean {
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

	/**
	 * Clean markdown code blocks from text
	 */
	private cleanMarkdownCodeBlocks(text: string): string {
		// Handle complete code blocks
		let cleanedText = text.replace(/```[\w-]*\n([\s\S]*?)\n```/g, "$1")

		// Handle opening code block markers at the beginning
		cleanedText = cleanedText.replace(/^```[\w-]*\n/g, "")

		// Handle opening code block markers in the middle
		cleanedText = cleanedText.replace(/\n```[\w-]*\n/g, "\n")

		// Handle closing code block markers
		cleanedText = cleanedText.replace(/\n```$/g, "")

		// Handle any remaining backticks
		cleanedText = cleanedText.replace(/```[\w-]*$/g, "")

		return cleanedText.trim()
	}

	/**
	 * Update debounce delay
	 */
	updateDebounceDelay(delay: number): void {
		this.streamDebouncer.setDelay(delay)
	}

	/**
	 * Dispose resources
	 */
	dispose(): void {
		this.streamDebouncer.dispose()
	}
}
