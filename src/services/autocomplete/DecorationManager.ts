import * as vscode from "vscode"

/**
 * Manages loading and streaming decorations for autocomplete
 */
export class DecorationManager {
	private loadingDecorationType: vscode.TextEditorDecorationType
	private streamingDecorationType: vscode.TextEditorDecorationType

	constructor() {
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

	/**
	 * Show loading indicator at the current cursor position
	 */
	showLoadingIndicator(editor: vscode.TextEditor): void {
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(this.loadingDecorationType, [decoration])
	}

	/**
	 * Show streaming indicator at the current cursor position
	 */
	showStreamingIndicator(editor: vscode.TextEditor): void {
		const position = editor.selection.active
		const decoration: vscode.DecorationOptions = {
			range: new vscode.Range(position, position),
		}
		editor.setDecorations(this.streamingDecorationType, [decoration])
	}

	/**
	 * Clear loading indicator
	 */
	clearLoadingIndicator(editor: vscode.TextEditor): void {
		editor.setDecorations(this.loadingDecorationType, [])
	}

	/**
	 * Clear streaming indicator
	 */
	clearStreamingIndicator(editor: vscode.TextEditor): void {
		editor.setDecorations(this.streamingDecorationType, [])
	}

	/**
	 * Clear all decorations
	 */
	clearAll(editor: vscode.TextEditor): void {
		this.clearLoadingIndicator(editor)
		this.clearStreamingIndicator(editor)
	}

	/**
	 * Dispose of decoration types
	 */
	dispose(): void {
		this.loadingDecorationType.dispose()
		this.streamingDecorationType.dispose()
	}
}
