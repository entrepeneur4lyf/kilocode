import * as vscode from "vscode"
import { CompletionState } from "./CompletionState"

/**
 * Handles inline completion item creation and management
 */
export class InlineCompletionHandler {
	private readonly completionState: CompletionState
	private readonly autocompletePreviewVisibleContextKey = "kilo-code.autocompletePreviewVisible"

	constructor(completionState: CompletionState) {
		this.completionState = completionState
	}

	/**
	 * Create inline completion items based on current state
	 */
	createCompletionItems(): vscode.InlineCompletionItem[] {
		let item: vscode.InlineCompletionItem

		if (this.completionState.hasAcceptedFirstLine && this.completionState.remainingLinesPreview) {
			// Show remaining lines after first line was accepted
			item = new vscode.InlineCompletionItem(this.completionState.remainingLinesPreview)
		} else if (this.completionState.firstLinePreview) {
			// Show first line (or full completion if single line)
			item = new vscode.InlineCompletionItem(this.completionState.firstLinePreview)
		} else {
			return []
		}

		// Set command to ensure VS Code knows this is a completion that can be accepted with Tab
		item.command = { command: "editor.action.inlineSuggest.commit", title: "Accept Completion" }

		// Update context for keybindings
		this.setPreviewVisible(true)

		return [item]
	}

	/**
	 * Handle acceptance of the current preview
	 */
	async handleAcceptance(editor: vscode.TextEditor): Promise<void> {
		if (!this.completionState.hasAcceptedFirstLine && this.completionState.remainingLinesPreview) {
			// First Tab press: Insert the first line
			if (this.completionState.firstLinePreview) {
				await editor.edit((editBuilder) => {
					editBuilder.insert(editor.selection.active, this.completionState.firstLinePreview)
				})

				// Mark that we've accepted the first line
				this.completionState.acceptFirstLine()

				// Wait a moment for the first line to be inserted
				setTimeout(async () => {
					// Trigger a new completion to show the remaining lines
					await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger")
				}, 50)
			}
		} else if (this.completionState.hasAcceptedFirstLine && this.completionState.remainingLinesPreview) {
			// Second Tab press: Insert the remaining lines
			await editor.edit((editBuilder) => {
				editBuilder.insert(editor.selection.active, this.completionState.remainingLinesPreview)
			})

			// Reset state
			this.completionState.reset()
			this.setPreviewVisible(false)
		} else {
			// Single line completion or no remaining lines
			this.completionState.reset()
			this.setPreviewVisible(false)
		}
	}

	/**
	 * Dismiss the current preview
	 */
	dismiss(): void {
		this.completionState.reset()
		this.setPreviewVisible(false)
		vscode.commands.executeCommand("editor.action.inlineSuggest.hide")
	}

	/**
	 * Update the preview visibility context
	 */
	private setPreviewVisible(visible: boolean): void {
		vscode.commands.executeCommand("setContext", this.autocompletePreviewVisibleContextKey, visible)
		if (visible) {
			this.completionState.showPreview()
		} else {
			this.completionState.hidePreview()
		}
	}

	/**
	 * Split completion text into first line and remaining lines
	 */
	splitCompletion(text: string): { firstLine: string; remainingLines: string } {
		const lines = text.split("\n")

		if (lines.length <= 1) {
			return { firstLine: text, remainingLines: "" }
		} else {
			return {
				firstLine: lines[0],
				remainingLines: lines.slice(1).join("\n"),
			}
		}
	}
}
