import * as vscode from "vscode"
import { AICommentData } from "./types"

/**
 * Configuration options for the highlighter
 */
export interface HighlighterOptions {
	/** Animation speed in milliseconds (lower = faster) */
	animationSpeed?: number
	/** Primary highlight color (bright state) */
	primaryColor?: string
	/** Secondary highlight color (dim state) */
	secondaryColor?: string
	/** Whether to highlight the whole line or just the comment */
	isWholeLine?: boolean
}

/**
 * Default configuration for the highlighter
 */
const DEFAULT_OPTIONS: Required<HighlighterOptions> = {
	animationSpeed: 100,
	primaryColor: "rgba(0, 122, 255, 0.4)",
	secondaryColor: "rgba(0, 122, 255, 0.1)",
	isWholeLine: true,
}

/**
 * Handles highlighting and visual effects for AI comments in the editor.
 * This class encapsulates all decoration and animation logic for Watch Mode.
 */
export class WatchModeHighlighter {
	private options: Required<HighlighterOptions>
	private activeHighlights: Map<string, () => void> = new Map()

	/**
	 * Creates a new instance of the WatchModeHighlighter
	 * @param options Optional configuration options
	 */
	constructor(options?: HighlighterOptions) {
		this.options = { ...DEFAULT_OPTIONS, ...options }
	}

	/**
	 * Highlights an AI comment in the editor with a glowing animation effect.
	 * @param document The document containing the comment
	 * @param comment The AI comment data
	 * @returns A function to clear the highlight
	 */
	public highlightAICommentWithAnimation(document: vscode.TextDocument, comment: AICommentData): () => void {
		// Get the editor for the document
		const editor = vscode.window.visibleTextEditors.find(
			(editor) => editor.document.uri.toString() === document.uri.toString(),
		)

		if (!editor) {
			// Return a no-op function if no editor was found
			return () => {}
		}

		// Create a range for the comment
		const range = new vscode.Range(comment.startPos, comment.endPos)

		// Create a unique ID for this highlight
		const highlightId = `${document.uri.toString()}:${comment.startPos.line}:${comment.startPos.character}`

		// Clear any existing highlight for this comment
		this.clearHighlight(highlightId)

		// Create decorations with different intensities for the pulsing effect
		const decorationBright = vscode.window.createTextEditorDecorationType({
			backgroundColor: this.options.primaryColor,
			borderColor: this.options.primaryColor.replace("0.4", "0.9"), // Darker border
			borderWidth: "1px",
			borderStyle: "solid",
			isWholeLine: this.options.isWholeLine,
		})

		const decorationDim = vscode.window.createTextEditorDecorationType({
			backgroundColor: this.options.secondaryColor,
			borderColor: this.options.secondaryColor.replace("0.1", "0.6"), // Darker border
			borderWidth: "1px",
			borderStyle: "solid",
			isWholeLine: this.options.isWholeLine,
		})

		// Start with the bright decoration
		let isBright = true
		editor.setDecorations(decorationBright, [range])

		// Create an interval to toggle between bright and dim
		const interval = setInterval(() => {
			if (isBright) {
				editor.setDecorations(decorationBright, [])
				editor.setDecorations(decorationDim, [range])
			} else {
				editor.setDecorations(decorationDim, [])
				editor.setDecorations(decorationBright, [range])
			}
			isBright = !isBright
		}, this.options.animationSpeed)

		// Create a cleanup function
		const cleanup = () => {
			clearInterval(interval)
			decorationBright.dispose()
			decorationDim.dispose()
			this.activeHighlights.delete(highlightId)
		}

		// Store the cleanup function
		this.activeHighlights.set(highlightId, cleanup)

		// Return the cleanup function
		return cleanup
	}

	/**
	 * Highlights a range in the editor with a static decoration
	 * @param document The document containing the range
	 * @param range The range to highlight
	 * @param options Optional decoration options
	 * @returns A function to clear the highlight
	 */
	public highlightRange(
		document: vscode.TextDocument,
		range: vscode.Range,
		options?: vscode.DecorationRenderOptions,
	): () => void {
		const editor = vscode.window.visibleTextEditors.find(
			(editor) => editor.document.uri.toString() === document.uri.toString(),
		)

		if (!editor) {
			return () => {}
		}

		const decoration = vscode.window.createTextEditorDecorationType(
			options || {
				backgroundColor: this.options.primaryColor,
				isWholeLine: this.options.isWholeLine,
			},
		)

		editor.setDecorations(decoration, [range])

		return () => {
			decoration.dispose()
		}
	}

	/**
	 * Clears a specific highlight by ID
	 * @param highlightId The ID of the highlight to clear
	 */
	public clearHighlight(highlightId: string): void {
		const cleanup = this.activeHighlights.get(highlightId)
		if (cleanup) {
			cleanup()
		}
	}

	/**
	 * Clears all active highlights
	 */
	public clearAllHighlights(): void {
		for (const cleanup of this.activeHighlights.values()) {
			cleanup()
		}
		this.activeHighlights.clear()
	}

	/**
	 * Updates the highlighter options
	 * @param options New options to apply
	 */
	public updateOptions(options: HighlighterOptions): void {
		this.options = { ...this.options, ...options }
	}
}
