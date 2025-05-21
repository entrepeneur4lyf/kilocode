import * as vscode from "vscode"
import { AICommentData, CommentProcessingResult, CommentProcessorOptions } from "./types"

// Regular expressions for detecting AI comments
const AI_COMMENT_PATTERNS = [
	// For single line comments: // AI! do something
	/\/\/\s*AI!(.+)$/gm,
	// For multi-line comments: /* AI! do something */
	/\/\*\s*AI!(.+?)\*\//gms,
	// For inline comments: /** AI! do something */
	/\/\*\*\s*AI!(.+?)\*\//gms,
]

/**
 * Extracts code context around the given position
 * @param content Full file content
 * @param position Position in the document
 * @param contextLines Number of context lines to extract before and after
 */
const extractCodeContext = (
	content: string,
	startPos: vscode.Position,
	endPos: vscode.Position,
	contextLines: number = 5,
): string => {
	const lines = content.split("\n")

	// Calculate context boundary lines
	const startLine = Math.max(0, startPos.line - contextLines)
	const endLine = Math.min(lines.length - 1, endPos.line + contextLines)

	return lines.slice(startLine, endLine + 1).join("\n")
}

/**
 * Detects AI comments in the provided file content
 * @param options Comment processor options
 */
export const detectAIComments = (options: CommentProcessorOptions): CommentProcessingResult => {
	const { fileUri, content } = options
	const comments: AICommentData[] = []
	const errors: Error[] = []

	try {
		// Apply each pattern to detect AI comments
		AI_COMMENT_PATTERNS.forEach((pattern) => {
			let match
			while ((match = pattern.exec(content)) !== null) {
				// Get the full matched comment and the content capture group
				const fullMatch = match[0]
				const commentContent = match[1].trim()

				// Calculate the start and end positions in the document
				const beforeMatch = content.substring(0, match.index)
				const matchLines = beforeMatch.split("\n")
				const startLine = matchLines.length - 1
				const startChar = matchLines[startLine].length

				const matchEndIndex = match.index + fullMatch.length
				const beforeEnd = content.substring(0, matchEndIndex)
				const endLines = beforeEnd.split("\n")
				const endLine = endLines.length - 1
				const endChar = endLines[endLine].length

				const startPos = new vscode.Position(startLine, startChar)
				const endPos = new vscode.Position(endLine, endChar)

				// Extract surrounding code context
				const codeContext = extractCodeContext(content, startPos, endPos)

				comments.push({
					content: commentContent,
					startPos,
					endPos,
					context: codeContext,
					fileUri,
				})
			}
		})
	} catch (error) {
		errors.push(error instanceof Error ? error : new Error(String(error)))
	}

	return { comments, errors: errors.length > 0 ? errors : undefined }
}

/**
 * Builds a prompt for the AI model based on the comment and its context
 * @param commentData The AI comment data
 */
export const buildAIPrompt = (commentData: AICommentData): string => {
	const { content, context } = commentData

	// Create a prompt that includes both the comment instruction and the code context
	return `
# AI Comment Instruction
${content}

# Code Context
\`\`\`
${context || "No context available"}
\`\`\`

Please respond with code or explanations that address the comment instruction.
Provide only the necessary code or explanation without additional commentary.
`.trim()
}

/**
 * Processes the AI response and prepares it to be applied to the file
 * @param options AI response options
 */
export const processAIResponse = async (options: { commentData: AICommentData; response: string }): Promise<string> => {
	const { response } = options
	console.log("🚀 ~ processAIResponse ~ response:", response)

	// Extract code blocks from the response if they exist
	const codeBlockRegex = /```(?:[\w-]*)\n([\s\S]*?)```/g
	const codeBlocks: string[] = []

	let match
	while ((match = codeBlockRegex.exec(response)) !== null) {
		if (match[1]) {
			codeBlocks.push(match[1].trim())
		}
	}

	// If code blocks found, join them; otherwise use the full response
	return codeBlocks.length > 0 ? codeBlocks.join("\n\n") : response
}

/**
 * Applies the processed AI response to the document
 * @param document The document to modify
 * @param commentData The original AI comment data
 * @param processedResponse The processed AI response
 */
export const applyAIResponseToDocument = async (
	document: vscode.TextDocument,
	commentData: AICommentData,
	processedResponse: string,
): Promise<boolean> => {
	try {
		const edit = new vscode.WorkspaceEdit()

		// Replace the AI comment with the processed response
		edit.replace(document.uri, new vscode.Range(commentData.startPos, commentData.endPos), processedResponse)

		return await vscode.workspace.applyEdit(edit)
	} catch (error) {
		console.error("Error applying AI response to document:", error)
		return false
	}
}
