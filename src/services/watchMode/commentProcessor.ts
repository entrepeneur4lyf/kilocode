import * as vscode from "vscode"
import {
	AICommentData,
	CommentProcessingResult,
	CommentProcessorOptions,
	DiffBlock,
	DiffEdit as NewDiffEdit,
	AIResponse,
	TriggerType,
} from "./types"
import { MultiSearchReplaceDiffStrategy } from "../../core/diff/strategies/multi-search-replace"

/**
 * Interface for a diff edit
 */
export interface DiffEdit {
	path: string
	hunk: string[]
}
/**
 * Custom error for when search text is not unique in a file
 */
export class SearchTextNotUnique extends Error {
	constructor(message: string) {
		super(message)
		this.name = "SearchTextNotUnique"
	}
}

// Regular expressions for detecting KILO comments
const createAICommentPatterns = (prefix: string) => [
	// For single line comments: // KO! do something (with or without space after //)
	new RegExp(`\\/\\/\\s*.*?${prefix}(.*)$`, "gm"),
	// For multi-line comments: /* KO! do something */
	new RegExp(`\\/\\*\\s*.*?${prefix}(.+?)\\*\\/`, "gms"),
	// For inline comments: /** KO! do something */
	new RegExp(`\\/\\*\\*\\s*.*?${prefix}(.+?)\\*\\/`, "gms"),
]

// Default to "KO!" if no prefix is provided
let AI_COMMENT_PATTERNS = createAICommentPatterns("KO!")

/**
 * Updates the AI comment patterns with a new prefix
 * @param prefix The prefix to use for AI comments (e.g., "KO!")
 */
export const updateAICommentPatterns = (prefix: string): void => {
	AI_COMMENT_PATTERNS = createAICommentPatterns(prefix)
}

// Regular expression for detecting code blocks in AI responses
const CODE_BLOCK_REGEX = /```(?:[\w-]*)\n([\s\S]*?)```/g

// Regular expression for parsing unified diffs in legacy code
// This is now handled differently in the new implementation

/**
 * Error messages for diff application failures
 */
const NO_MATCH_ERROR = `UnifiedDiffNoMatch: hunk failed to apply!

{path} does not contain lines that match the diff you provided!
Try again.
DO NOT skip blank lines, comments, docstrings, etc!
The diff needs to apply cleanly to the lines in {path}!

{path} does not contain these {num_lines} exact lines in a row:
\`\`\`
{original}\`\`\`
`

const NOT_UNIQUE_ERROR = `UnifiedDiffNotUnique: hunk failed to apply!

{path} contains multiple sets of lines that match the diff you provided!
Try again.
Use additional \` \` lines to provide context that uniquely indicates which code needs to be changed.
The diff needs to apply to a unique set of lines in {path}!

{path} contains multiple copies of these {num_lines} lines:
\`\`\`
{original}\`\`\`
`

const OTHER_HUNKS_APPLIED = "Note: some hunks did apply successfully. See the updated source code shown above.\n\n"

/**
 * Interface for a diff edit
 */
export interface DiffEdit {
	path: string
	hunk: string[]
}
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

	const startLine = typeof startPos.line === "number" ? Math.max(0, startPos.line - contextLines) : 0
	const endLine =
		typeof endPos.line === "number" ? Math.min(lines.length - 1, endPos.line + contextLines) : lines.length - 1

	const extractedContext = lines.slice(startLine, endLine + 1).join("\n")
	console.log(`Extracted context: ${extractedContext.substring(0, 100)}${extractedContext.length > 100 ? "..." : ""}`)

	return extractedContext
}

/**
 * Detects AI comments in the provided file content
 * @param options Comment processor options
 */
export const detectAIComments = (options: CommentProcessorOptions): CommentProcessingResult => {
	const { fileUri, content } = options
	const comments: AICommentData[] = []
	const errors: Error[] = []

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

			// Create position objects using vscode.Position
			const startPos = new vscode.Position(startLine, startChar)
			const endPos = new vscode.Position(endLine, endChar)

			// Extract surrounding code context
			// Use a larger context to ensure we capture the function definition
			const codeContext = extractCodeContext(content, startPos, endPos, 15)

			comments.push({
				content: commentContent,
				startPos,
				endPos,
				context: codeContext,
				fileUri,
			})
		}
	})
	return { comments, errors: errors.length > 0 ? errors : undefined }
}

/**
 * Builds a prompt for the AI model based on the comment and its context
 * @param commentData The AI comment data
 */
// Keep track of the current AI comment prefix for use in prompts
let currentAICommentPrefix = "KO!"

/**
 * Updates the current AI comment prefix used in prompts
 * @param prefix The new prefix to use
 */
export const updateCurrentAICommentPrefix = (prefix: string): void => {
	currentAICommentPrefix = prefix
}

/**
 * Determines the trigger type based on the comment content
 * @param commentContent The content of the AI comment
 * @returns The trigger type (Edit or Ask)
 */
export const determineTriggerType = (commentContent: string): TriggerType => {
	// Check if the comment starts with a question mark or contains a question
	if (commentContent.trim().startsWith("?") || commentContent.includes("ai?")) {
		return TriggerType.Ask
	}

	// Default to Edit mode
	return TriggerType.Edit
}

export const buildAIPrompt = (
	commentData: AICommentData,
	triggerType: TriggerType = TriggerType.Edit,
	activeFiles: { uri: vscode.Uri; content: string }[] = [],
): string => {
	console.log("[WatchMode DEBUG] Building AI prompt")
	const { content, context, fileUri } = commentData
	const filePath = vscode.workspace.asRelativePath(fileUri)

	// Extract the prefix without the exclamation mark for display in the prompt
	const displayPrefix = currentAICommentPrefix.endsWith("!")
		? currentAICommentPrefix.slice(0, -1)
		: currentAICommentPrefix

	// Base prompt that's common to both edit and question modes
	let prompt = `
You are Kilo Code, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

# Task

${content}

I've written your instructions in comments in the code and marked them with "${displayPrefix}"
You can see the "${displayPrefix}" comments shown below.
Find them in the code files I've shared with you, and follow their instructions.

# Code to modify

\`\`\`
${context || "No context available"}
\`\`\`
`

	// Add content from active files for additional context
	if (activeFiles.length > 0) {
		prompt += `\n\n# Additional context from open files\n\n`

		for (const file of activeFiles) {
			// For tests, compare paths instead of full URIs
			const filePath = file.uri.path || file.uri.toString()
			const commentPath = fileUri.path || fileUri.toString()

			if (filePath !== commentPath) {
				// Skip the file with the comment
				const relativePath = vscode.workspace.asRelativePath(file.uri)
				prompt += `## ${relativePath}\n\n\`\`\`\n${file.content}\n\`\`\`\n\n`
			}
		}
	}

	// Add mode-specific instructions
	if (triggerType === TriggerType.Edit) {
		prompt += `
# Response format

You MUST respond with SEARCH/REPLACE blocks for each edit. Format your changes as follows:

${filePath}
<<<<<<< SEARCH
exact original code
=======
replacement code
>>>>>>> REPLACE

You can include multiple SEARCH/REPLACE blocks for the same file, and you can edit multiple files.
Make sure to include enough context in the SEARCH block to uniquely identify the code to replace.
After completing the instructions, also BE SURE to remove all the "${displayPrefix}" comments from the code.

You can also provide unified diff format if that's more appropriate for your changes:
\`\`\`diff
--- ${filePath}
+++ ${filePath}
@@ ... @@
 // Context line(s) before (unchanged, starts with space)
-// Old line to be removed or changed (starts with -)
+// New line to replace it (starts with +)
 // Context line(s) after (unchanged, starts with space)
\`\`\`

If you need to explain your changes, please do so before or after the code blocks.
`
	} else {
		// Question mode
		prompt += `
# Response format

Since this appears to be a question rather than a code edit request, please provide a detailed analysis or explanation.
You don't need to modify any code - just answer the question thoroughly based on the code context provided.

If you do need to suggest code changes, you can include them as examples in your explanation using markdown code blocks.
`
	}

	const finalPrompt = prompt.trim()

	// Debug log the full prompt string
	console.log("[WatchMode DEBUG] === FULL AI PROMPT ===")
	console.log(finalPrompt)
	console.log("[WatchMode DEBUG] === END AI PROMPT ===")

	// More detailed debug logging of the prompt
	console.debug(
		"[WatchMode DEBUG] Full prompt string:",
		JSON.stringify({
			prompt: finalPrompt,
			length: finalPrompt.length,
			estimatedTokens: estimateTokenCount(finalPrompt),
			triggerType: triggerType,
			timestamp: new Date().toISOString(),
		}),
	)

	return finalPrompt
}

/**
 * Estimates the token count of a string
 * This is a very rough estimate - about 4 characters per token
 * @param text The text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokenCount(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Parses SEARCH/REPLACE blocks from the AI response
 * @param response The AI response containing SEARCH/REPLACE blocks
 * @returns An array of NewDiffEdit objects
 */
export function parseSearchReplaceBlocks(response: string, defaultFilePath?: string): NewDiffEdit[] {
	const edits: NewDiffEdit[] = []

	// Match with file path (standard format)
	const fileBlockRegex =
		/([^\s]+?)\n(?:`)?<<<<<<< SEARCH(?:`)?(?:\n|\s)([\s\S]*?)(?:`)?=======(?:`)?(?:\n|\s)([\s\S]*?)(?:`)?>>>>>>> REPLACE(?:`)?/g

	// Process matches with file paths
	let match
	while ((match = fileBlockRegex.exec(response)) !== null) {
		const filePath = match[1].trim()
		const searchBlock = match[2]
		const replaceBlock = match[3]

		// Create a DiffEdit with DiffBlocks
		const blocks: DiffBlock[] = [
			{ type: "SEARCH", content: searchBlock },
			{ type: "REPLACE", content: replaceBlock },
		]

		edits.push({
			filePath,
			blocks,
		})
	}

	// Also check for blocks without file paths (directly starting with SEARCH marker)
	const noFilePathRegex =
		/^(?:`)?<<<<<<< SEARCH(?:`)?(?:\n|\s)([\s\S]*?)(?:`)?=======(?:`)?(?:\n|\s)([\s\S]*?)(?:`)?>>>>>>> REPLACE(?:`)?/gm

	// Only process these if we have a default file path
	if (defaultFilePath) {
		let noPathMatch
		while ((noPathMatch = noFilePathRegex.exec(response)) !== null) {
			const searchBlock = noPathMatch[1]
			const replaceBlock = noPathMatch[2]

			// Create a DiffEdit with DiffBlocks
			const blocks: DiffBlock[] = [
				{ type: "SEARCH", content: searchBlock },
				{ type: "REPLACE", content: replaceBlock },
			]

			edits.push({
				filePath: defaultFilePath,
				blocks,
			})
		}
	}

	return edits
}

/**
 * Parses the AI response to extract edits in either SEARCH/REPLACE or unified diff format
 * @param response The AI response
 * @param triggerType The trigger type (Edit or Ask)
 * @returns An AIResponse object containing the edits and explanation
 */
export function parseAIResponse(response: string, triggerType: TriggerType, currentFilePath?: string): AIResponse {
	console.log("[WatchMode DEBUG] Parsing AI response")
	console.log("[WatchMode DEBUG] === FULL AI RESPONSE ===")
	console.log(response)
	console.log("[WatchMode DEBUG] === END AI RESPONSE ===")

	// Debug log the full response string
	console.debug("[WatchMode DEBUG] Full response string:", {
		response: response,
		length: response.length,
		estimatedTokens: estimateTokenCount(response),
		triggerType: triggerType,
		timestamp: new Date().toISOString(),
	})

	// Initialize the result
	const result: AIResponse = {
		edits: [],
		explanation: "",
		triggerType,
	}

	// If it's a question, just return the response as explanation
	if (triggerType === TriggerType.Ask) {
		result.explanation = response
		return result
	}

	// Try to parse SEARCH/REPLACE blocks first
	const searchReplaceEdits = parseSearchReplaceBlocks(response, currentFilePath)
	if (searchReplaceEdits.length > 0) {
		result.edits = searchReplaceEdits

		// Extract any explanation text (text before or after the code blocks)
		const withoutCodeBlocks = response.replace(
			/([^\s]+?)\n(?:`)?<<<<<<< SEARCH(?:`)?(?:\n|\s)[\s\S]*?(?:`)?>>>>>>> REPLACE(?:`)?/g,
			"",
		)
		result.explanation = withoutCodeBlocks.trim()

		return result
	}

	// If no SEARCH/REPLACE blocks found, try unified diffs
	const unifiedDiffEdits = findDiffs(response).map((edit) => {
		// Convert from old format to new format
		const [before, after] = hunkToBeforeAfter(edit.hunk, true) as [string[], string[]]

		return {
			filePath: edit.path,
			blocks: [
				{ type: "SEARCH" as const, content: (before as string[]).join("\n") },
				{ type: "REPLACE" as const, content: (after as string[]).join("\n") },
			],
		}
	})

	if (unifiedDiffEdits.length > 0) {
		result.edits = unifiedDiffEdits

		// Extract any explanation text (text before or after the code blocks)
		const withoutDiffs = response.replace(/```diff[\s\S]*?```/g, "").replace(/---[\s\S]*?(?=\n\n|$)/g, "")
		result.explanation = withoutDiffs.trim()

		return result
	}

	// If no edits found, treat the entire response as explanation
	result.explanation = response

	console.log(
		`[WatchMode DEBUG] Parsed ${result.edits.length} edits, explanation length: ${result.explanation.length}`,
	)
	return result
}

/**
 * Parses unified diffs from the AI response
 * @param response The AI response containing unified diffs
 * @returns An array of parsed diffs
 */
export function findDiffs(content: string): DiffEdit[] {
	// Ensure content ends with newline
	if (!content.endsWith("\n")) {
		content = content + "\n"
	}

	// Split by newline but don't add extra newlines to each line
	const lines = content.split("\n")
	let lineNum = 0
	const edits: DiffEdit[] = []

	// First check for code blocks with diffs
	while (lineNum < lines.length) {
		const line = lines[lineNum]
		if (
			line.startsWith("```diff") ||
			(line.startsWith("```") &&
				lineNum + 2 < lines.length &&
				lines[lineNum + 1].startsWith("---") &&
				lines[lineNum + 2].startsWith("+++"))
		) {
			const [newLineNum, theseEdits] = processFencedBlock(lines, lineNum + 1)
			edits.push(...theseEdits)
			lineNum = newLineNum
		} else {
			lineNum++
		}
	}

	// If no code blocks found, check for raw diffs in the content
	if (edits.length === 0 && content.includes("---") && content.includes("+++")) {
		// Try to extract diffs directly from the content
		const contentLines = content.split("\n")
		let diffContent = ""
		let inDiff = false

		for (const line of contentLines) {
			if (line.startsWith("---")) {
				inDiff = true
				diffContent = line + "\n"
			} else if (inDiff) {
				diffContent += line + "\n"
				if (line.trim() === "" && diffContent.includes("+++") && diffContent.includes("@@")) {
					// Process this diff block
					const dummyLines = diffContent.split("\n")
					const [_, theseEdits] = processDiffBlock(dummyLines, 0)
					edits.push(...theseEdits)
					inDiff = false
					diffContent = ""
				}
			}
		}

		// Add the last diff if there is one
		if (inDiff && diffContent.includes("+++") && diffContent.includes("@@")) {
			const dummyLines = diffContent.split("\n")
			const [_, theseEdits] = processDiffBlock(dummyLines, 0)
			edits.push(...theseEdits)
		}
	}

	return edits
}

/**
 * Processes a fenced code block to extract diffs
 */
export function processFencedBlock(lines: string[], startLineNum: number): [number, DiffEdit[]] {
	let lineNum = startLineNum
	// Find the end of the code block
	for (; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum]
		if (line.startsWith("```")) {
			break
		}
	}

	// Extract the content inside the code block
	const block = lines.slice(startLineNum, lineNum)

	// Process the block content
	const [_, edits] = processDiffBlock(block, 0)

	// Return the updated line number and edits
	return [lineNum + 1, edits]
}

/**
 * Processes a block of diff content
 */
export function processDiffBlock(lines: string[], startLineNum: number): [number, DiffEdit[]] {
	// Add a dummy @@ line at the end if needed for processing
	if (!lines[lines.length - 1]?.startsWith("@@")) {
		lines.push("@@ @@\n")
	}

	let lineNum = startLineNum
	let fname: string | null = null
	const edits: DiffEdit[] = []

	// Find the file path
	if (lines[0]?.startsWith("--- ") && lines[1]?.startsWith("+++ ")) {
		// Extract the file path, considering that it might contain spaces
		const aFname = lines[0].substring(4).trim()
		const bFname = lines[1].substring(4).trim()

		// Check if standard git diff prefixes are present (or /dev/null) and strip them
		if ((aFname.startsWith("a/") || aFname === "/dev/null") && bFname.startsWith("b/")) {
			fname = bFname.substring(2)
		} else {
			// Otherwise, assume the path is as intended
			fname = bFname
		}

		// Skip the header lines
		lineNum += 2
	}

	let keeper = false
	let hunk: string[] = []
	let op = " "

	// Process each line in the diff
	for (; lineNum < lines.length; lineNum++) {
		const line = lines[lineNum]
		hunk.push(line)

		if (line.length < 2) {
			continue
		}

		// Handle new file header
		if (line.startsWith("+++ ") && hunk.length >= 2 && hunk[hunk.length - 2]?.startsWith("--- ")) {
			// Remove the previous file header from the current hunk
			if (hunk.length >= 3 && hunk[hunk.length - 3] === "\n") {
				hunk = hunk.slice(0, -3)
			} else {
				hunk = hunk.slice(0, -2)
			}

			// Save the current hunk if we have a valid file name
			if (fname !== null && hunk.length > 0) {
				edits.push({ path: fname, hunk })
			}

			// Reset for the new file
			hunk = []
			keeper = false
			fname = line.substring(4).trim()
			continue
		}

		// Check for content lines
		op = line[0]
		if (op === "-" || op === "+") {
			keeper = true
			continue
		}

		// Check for hunk header
		if (op !== "@") {
			continue
		}

		// If we don't have any content to keep, skip this hunk
		if (!keeper) {
			hunk = []
			continue
		}

		// Remove the hunk header from the content
		hunk.pop()

		// Save the hunk if we have a valid file name
		if (fname !== null && hunk.length > 0) {
			edits.push({ path: fname, hunk })
		}

		// Reset for the next hunk
		hunk = []
		keeper = false
	}

	return [lineNum, edits]
}

/**
 * Helper function to normalize whitespace
 */
function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/**
 * Helper function to escape special characters in a string for use in a regular expression
 */
function escapeRegExp(string: string): string {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Converts a hunk to before and after text
 */
export function hunkToBeforeAfter(hunk: string[], asLines = false): [string[] | string, string[] | string] {
	const before: string[] = []
	const after: string[] = []

	for (const line of hunk) {
		if (!line || line.length === 0) {
			// Empty line, treat as unchanged
			before.push("")
			after.push("")
			continue
		}

		if (line.length < 2) {
			// Very short line, treat as unchanged
			before.push(line)
			after.push(line)
			continue
		}

		const op = line[0]
		const content = line.substring(1)

		if (op === " ") {
			before.push(content)
			after.push(content)
		} else if (op === "-") {
			before.push(content)
		} else if (op === "+") {
			after.push(content)
		}
	}

	if (asLines) {
		return [before, after]
	}

	// Join with newlines to ensure proper line separation
	return [before.join("\n"), after.join("\n")]
}

/**
 * Cleans up pure whitespace lines
 */
function cleanupPureWhitespaceLines(lines: string[]): string[] {
	return lines.map((line) => {
		if (line.trim() === "") {
			// Keep only the line ending
			const match = line.match(/[\r\n]+$/)
			return match ? match[0] : line
		}
		return line
	})
}

/**
 * Normalizes a hunk
 */
export function normalizeHunk(hunk: string[]): string[] {
	const [before, after] = hunkToBeforeAfter(hunk, true) as [string[], string[]]

	const cleanBefore = cleanupPureWhitespaceLines(before)
	const cleanAfter = cleanupPureWhitespaceLines(after)

	// Create a new diff
	const result: string[] = []

	// Add context lines
	let beforeIndex = 0
	let afterIndex = 0

	while (beforeIndex < cleanBefore.length || afterIndex < cleanAfter.length) {
		if (
			beforeIndex < cleanBefore.length &&
			afterIndex < cleanAfter.length &&
			cleanBefore[beforeIndex] === cleanAfter[afterIndex]
		) {
			// Unchanged line
			result.push(" " + cleanBefore[beforeIndex])
			beforeIndex++
			afterIndex++
		} else if (beforeIndex < cleanBefore.length) {
			// Removed line
			result.push("-" + cleanBefore[beforeIndex])
			beforeIndex++
		} else if (afterIndex < cleanAfter.length) {
			// Added line
			result.push("+" + cleanAfter[afterIndex])
			afterIndex++
		}
	}

	return result
}

/**
 * Flexible search and replace
 */
export function flexiSearchAndReplace(before: string, after: string, content: string): string | null {
	// Simple case: direct replacement
	if (content.includes(before)) {
		// Check if the search text appears multiple times
		const regex = new RegExp(escapeRegExp(before), "g")
		const matches = content.match(regex)
		if (matches && matches.length > 1) {
			throw new SearchTextNotUnique(`Search text appears ${matches.length} times in the content`)
		}

		return content.replace(before, after)
	}

	// Try with normalized whitespace
	const normalizedBefore = normalizeWhitespace(before)
	const normalizedContent = normalizeWhitespace(content)

	if (normalizedContent.includes(normalizedBefore)) {
		// Find the position in normalized content
		const startPos = normalizedContent.indexOf(normalizedBefore)
		const endPos = startPos + normalizedBefore.length

		// Map back to original content
		let originalStartPos = 0
		let originalEndPos = 0
		let normalizedPos = 0

		for (let i = 0; i < content.length; i++) {
			if (content[i].trim() !== "") {
				if (normalizedPos === startPos) {
					originalStartPos = i
				}
				if (normalizedPos === endPos) {
					originalEndPos = i
					break
				}
				normalizedPos++
			}
		}

		// Replace in original content
		return content.substring(0, originalStartPos) + after + content.substring(originalEndPos)
	}

	// Try with case-insensitive search
	const lowerBefore = before.toLowerCase()
	const lowerContent = content.toLowerCase()

	if (lowerContent.includes(lowerBefore)) {
		const startPos = lowerContent.indexOf(lowerBefore)
		const originalBefore = content.substring(startPos, startPos + before.length)

		// Check if the search text appears multiple times
		const regex = new RegExp(escapeRegExp(originalBefore), "gi")
		const matches = content.match(regex)
		if (matches && matches.length > 1) {
			throw new SearchTextNotUnique(
				`Search text appears ${matches.length} times in the content (case-insensitive)`,
			)
		}

		return content.replace(originalBefore, after)
	}

	return null
}

/**
 * Applies a hunk to content
 */
export function applyHunk(content: string, hunk: string[]): string | null {
	// Try direct application first
	try {
		const [_beforeText, _afterText] = hunkToBeforeAfter(hunk)
		const result = directlyApplyHunk(content, hunk)
		if (result) {
			return result
		}
	} catch (error) {
		if (!(error instanceof SearchTextNotUnique)) {
			throw error
		}
		// Continue with other methods if the search text is not unique
	}

	// If direct application fails, try more advanced techniques
	try {
		// Try with different amounts of context
		return applyWithPartialContext(content, hunk)
	} catch (error) {
		console.error("[WatchMode DEBUG] Error in applyHunk:", error)
		return null
	}
}

/**
 * Directly applies a hunk to content
 */
export function directlyApplyHunk(content: string, hunk: string[]): string | null {
	const [before, after] = hunkToBeforeAfter(hunk)

	if (!before || (before as string).length === 0) {
		return content + (after as string)
	}

	const [beforeLines] = hunkToBeforeAfter(hunk, true) as [string[], string[]]
	const beforeLinesStripped = beforeLines.map((line) => line.trim()).join("")

	// Refuse to do a repeated search and replace on a tiny bit of non-whitespace context
	if (
		beforeLinesStripped.length < 10 &&
		content.includes(before as string) &&
		(content.match(new RegExp(escapeRegExp(before as string), "g")) || []).length > 1
	) {
		throw new SearchTextNotUnique("Search text too short and appears multiple times")
	}

	const result = flexiSearchAndReplace(before as string, after as string, content)

	return result
}

/**
 * Applies a hunk with partial context
 */
export function applyWithPartialContext(content: string, hunk: string[]): string | null {
	// Split the hunk into sections based on operation type
	const sections: string[][] = []
	let currentSection: string[] = []
	let currentOp = hunk[0]?.[0] || " "

	for (const line of hunk) {
		const op = line[0] || " "
		if (op !== currentOp) {
			if (currentSection.length > 0) {
				sections.push(currentSection)
			}
			currentSection = []
			currentOp = op
		}
		currentSection.push(line)
	}

	if (currentSection.length > 0) {
		sections.push(currentSection)
	}

	// If we don't have at least context-change-context pattern, return null
	if (sections.length < 3) {
		return null
	}

	// Try different combinations of context
	let updatedContent = content
	let success = false

	for (let i = 1; i < sections.length; i += 2) {
		// This is a change section (+ or - lines)
		const beforeContext = i > 0 ? sections[i - 1] : []
		const changeSection = sections[i]
		const afterContext = i < sections.length - 1 ? sections[i + 1] : []

		// Try different amounts of context
		for (let beforeAmount = beforeContext.length; beforeAmount >= 0; beforeAmount--) {
			for (let afterAmount = afterContext.length; afterAmount >= 0; afterAmount--) {
				if (beforeAmount === 0 && afterAmount === 0) {
					continue // Need at least some context
				}

				const beforeSlice = beforeAmount > 0 ? beforeContext.slice(-beforeAmount) : []
				const afterSlice = afterAmount > 0 ? afterContext.slice(0, afterAmount) : []

				const testHunk = [...beforeSlice, ...changeSection, ...afterSlice]

				try {
					const result = directlyApplyHunk(updatedContent, testHunk)
					if (result) {
						updatedContent = result
						success = true
						break
					}
				} catch (error) {
					// Ignore and try the next combination
				}
			}

			if (success) break
		}

		if (!success) {
			return null // Couldn't apply this change section
		}

		// Reset for the next change section
		success = false
	}

	return updatedContent
}

/**
 * Main class for handling unified diffs
 */
export class UnifiedDiffHandler {
	/**
	 * Gets edits from a response
	 */
	public getEdits(response: string): DiffEdit[] {
		return findDiffs(response)
	}

	/**
	 * Applies edits to content
	 */
	public applyEdits(edits: DiffEdit[], documentContent: string, documentUri: vscode.Uri): [string, string[]] {
		const seen = new Set<string>()
		const uniq: DiffEdit[] = []
		const errors: string[] = []
		let newContent = documentContent

		// Deduplicate edits
		for (const { path: editPath, hunk } of edits) {
			const normalizedHunk = normalizeHunk(hunk)
			if (normalizedHunk.length === 0) {
				continue
			}

			const key = editPath + "\n" + normalizedHunk.join("")
			if (seen.has(key)) {
				continue
			}
			seen.add(key)

			uniq.push({ path: editPath, hunk: normalizedHunk })
		}

		console.log(`[WatchMode DEBUG] Processing ${uniq.length} unique edits`)

		// Apply each edit
		for (const { path: _editPath, hunk } of uniq) {
			const [original] = hunkToBeforeAfter(hunk)
			const relPath = vscode.workspace.asRelativePath(documentUri)

			console.log(`[WatchMode DEBUG] Applying hunk to ${relPath}`)

			try {
				const updatedContent = applyHunk(newContent, hunk)
				if (!updatedContent) {
					const errorMsg = NO_MATCH_ERROR.replace(/{path}/g, relPath)
						.replace(/{original}/g, original as string)
						.replace(/{num_lines}/g, (original as string).split("\n").length.toString())

					console.error(`[WatchMode DEBUG] Hunk failed to apply: ${errorMsg.split("\n")[0]}`)
					errors.push(errorMsg)
					continue
				}

				// Update the content for subsequent edits
				newContent = updatedContent
				console.log(`[WatchMode DEBUG] Successfully applied hunk to ${relPath}`)
			} catch (error) {
				if (error instanceof SearchTextNotUnique) {
					const errorMsg = NOT_UNIQUE_ERROR.replace(/{path}/g, relPath)
						.replace(/{original}/g, original as string)
						.replace(/{num_lines}/g, (original as string).split("\n").length.toString())

					console.error(`[WatchMode DEBUG] Search text not unique: ${errorMsg.split("\n")[0]}`)
					errors.push(errorMsg)
				} else {
					console.error(`[WatchMode DEBUG] Error applying diff: ${error.message}`)
					errors.push(`Error applying diff to ${relPath}: ${error.message}`)
				}
				continue
			}
		}

		if (errors.length > 0 && errors.length < uniq.length) {
			errors.push(OTHER_HUNKS_APPLIED)
		}

		return [newContent, errors]
	}
}

/**
 * Applies a unified diff to a document
 * @param document The document to modify
 * @param diff The unified diff to apply
 * @returns A promise that resolves to true if the diff was applied successfully
 */
/**
 * For compatibility with the previous API, converts from legacy format to new format
 */
export const parseDiffs = (
	response: string,
): Array<{
	originalFile: string
	newFile: string
	hunks: Array<{
		content: string
	}>
}> => {
	const edits = findDiffs(response)

	// Convert to legacy format
	return edits.map((edit) => {
		// Extract file paths from the edit
		let originalFile = edit.path
		let newFile = edit.path

		// Find hunks based on @@ markers
		const hunksText = edit.hunk.join("")
		const hunkMatches = hunksText.split(/(?=@@)/g)
		const hunks = hunkMatches
			.filter((h) => h.trim().startsWith("@@"))
			.map((h) => ({
				content: h.trim(),
			}))

		// If no hunks with @@ markers, create a single hunk
		if (hunks.length === 0) {
			hunks.push({
				content: "@@ @@ \n" + edit.hunk.join(""),
			})
		}

		return {
			originalFile,
			newFile,
			hunks,
		}
	})
}

/**
 * Applies a unified diff to a document
 * @param document The document to modify
 * @param diff The unified diff to apply
 * @returns A promise that resolves to true if the diff was applied successfully
 */
export const applyDiffToDocument = async (
	document: vscode.TextDocument,
	diff: {
		originalFile: string
		newFile: string
		hunks: Array<{
			content: string
		}>
	},
): Promise<boolean> => {
	try {
		// Convert from legacy format to new format
		const edits: DiffEdit[] = diff.hunks.map((hunk) => ({
			path: diff.newFile,
			hunk: hunk.content.split("\n"),
		}))

		// Create a new diff handler
		const diffHandler = new UnifiedDiffHandler()

		// Apply the edits
		const [newContent, errors] = diffHandler.applyEdits(edits, document.getText(), document.uri)

		if (errors.length > 0) {
			console.log(`[WatchMode DEBUG] Errors applying diff: ${errors.length}`)
			for (const error of errors) {
				console.error(`[WatchMode DEBUG] ${error.split("\n")[0]}`)
			}

			// Only return false if all edits failed
			if (errors.length >= edits.length) {
				return false
			}
		}

		// Apply the changes to the document
		const edit = new vscode.WorkspaceEdit()
		const fullRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length))

		edit.replace(document.uri, fullRange, newContent)
		const result = await vscode.workspace.applyEdit(edit)

		return result
	} catch (error) {
		console.error("[WatchMode DEBUG] Error applying diff:", error)
		return false
	}
}

/**
 * Applies SEARCH/REPLACE blocks to a document with enhanced fuzzy matching
 * @param document The document to modify
 * @param edits The NewDiffEdit objects containing SEARCH/REPLACE blocks
 * @returns A promise that resolves to true if the edits were applied successfully
 */
export const applySearchReplaceEdits = async (
	document: vscode.TextDocument,
	edits: NewDiffEdit[],
): Promise<boolean> => {
	try {
		// Group edits by file path
		const editsByFile = new Map<string, NewDiffEdit[]>()

		for (const edit of edits) {
			const filePath = edit.filePath
			if (!editsByFile.has(filePath)) {
				editsByFile.set(filePath, [])
			}
			editsByFile.get(filePath)!.push(edit)
		}

		console.log(`[WatchMode DEBUG] Processing edits for ${editsByFile.size} files`)

		// Track overall success
		let overallSuccess = true

		// Apply edits for each file
		for (const [filePath, fileEdits] of editsByFile.entries()) {
			console.log(`[WatchMode DEBUG] Processing ${fileEdits.length} edits for file: ${filePath}`)

			// Get the document for this file
			let fileDocument = document
			let documentContent: string
			let documentUri: vscode.Uri

			// If the file path doesn't match the current document, open the file
			if (vscode.workspace.asRelativePath(document.uri) !== filePath) {
				try {
					// Find the document in the workspace
					const workspaceFolders = vscode.workspace.workspaceFolders
					if (!workspaceFolders) {
						console.log(`[WatchMode DEBUG] No workspace folders found`)
						overallSuccess = false
						continue
					}

					const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, filePath)
					console.log(`[WatchMode DEBUG] Opening file: ${fileUri.toString()}`)

					fileDocument = await vscode.workspace.openTextDocument(fileUri)
				} catch (error) {
					console.log(`[WatchMode DEBUG] Error opening file ${filePath}: ${error}`)
					overallSuccess = false
					continue
				}
			}

			documentContent = fileDocument.getText()
			documentUri = fileDocument.uri
			const documentPath = vscode.workspace.asRelativePath(documentUri)

			// Create a new instance of MultiSearchReplaceDiffStrategy with default settings
			const diffStrategy = new MultiSearchReplaceDiffStrategy(0.9, 40) // 90% similarity threshold, 40 buffer lines

			// Convert NewDiffEdit[] to a format that MultiSearchReplaceDiffStrategy can use
			let diffContent = ""

			// Build the diff content in the format expected by MultiSearchReplaceDiffStrategy
			for (const edit of fileEdits) {
				const searchBlock = edit.blocks.find((block) => block.type === "SEARCH")
				const replaceBlock = edit.blocks.find((block) => block.type === "REPLACE")

				if (!searchBlock || !replaceBlock) {
					continue
				}

				diffContent += "<<<<<<< SEARCH\n"
				diffContent += ":start_line:0\n" // Use 0 to let the strategy find the best match
				diffContent += "-------\n"
				diffContent += searchBlock.content + "\n"
				diffContent += "=======\n"
				diffContent += replaceBlock.content + "\n"
				diffContent += ">>>>>>> REPLACE\n\n"
			}

			if (diffContent === "") {
				console.log(`[WatchMode DEBUG] No valid edits found for file ${filePath}`)
				continue
			}

			// Apply the diff using MultiSearchReplaceDiffStrategy
			const result = await diffStrategy.applyDiff(documentContent, diffContent)

			if (!result.success) {
				console.error(`[WatchMode DEBUG] Failed to apply diff to ${filePath}:`, result.error || "Unknown error")
				if (result.failParts && result.failParts.length > 0) {
					for (const part of result.failParts) {
						// Check if the part has an error property (only on failed parts)
						if (!part.success && part.error) {
							console.error("[WatchMode DEBUG] Diff part failed:", part.error)
						}
					}
				}
				overallSuccess = false
				continue
			}

			// Apply the changes to the document
			const edit = new vscode.WorkspaceEdit()
			const fullRange = new vscode.Range(
				new vscode.Position(0, 0),
				fileDocument.positionAt(documentContent.length),
			)

			edit.replace(documentUri, fullRange, result.content!)
			const success = await vscode.workspace.applyEdit(edit)

			console.log(`[WatchMode DEBUG] Applied changes to ${documentPath}: ${success ? "SUCCESS" : "FAILED"}`)

			if (success) {
				// Save the file after modifying it
				try {
					await fileDocument.save()
					console.log(`[WatchMode DEBUG] Saved file ${documentPath}`)
				} catch (error) {
					console.error(`[WatchMode DEBUG] Error saving file ${documentPath}:`, error)
					overallSuccess = false
				}
			} else {
				overallSuccess = false
			}
		}

		return overallSuccess
	} catch (error) {
		console.error("[WatchMode DEBUG] Error applying SEARCH/REPLACE edits:", error)
		return false
	}
}


/**
 * Maximum number of reflection attempts for failed edits
 */
const MAX_REFLECTION_ATTEMPTS = 1

/**
 * Processes the AI response and applies it to the document
 * @param document The document to modify
 * @param commentData The original AI comment data
 * @param response The AI response
 * @param reflectionAttempt Current reflection attempt number (for retry logic)
 * @returns A promise that resolves to true if the response was applied successfully
 */
export const processAIResponse = async (
	document: vscode.TextDocument,
	commentData: AICommentData,
	response: string,
	reflectionAttempt: number = 0,
): Promise<boolean> => {
	console.log("[WatchMode DEBUG] ====== processAIResponse START ======")
	console.log("[WatchMode DEBUG] Document URI:", document.uri.toString())
	console.log(
		"[WatchMode DEBUG] Comment:",
		commentData.content.substring(0, 50) + (commentData.content.length > 50 ? "..." : ""),
	)
	console.log("[WatchMode DEBUG] Response length:", response.length)
	console.log("[WatchMode DEBUG] Response preview:", response.substring(0, 100) + "...")
	console.log("[WatchMode DEBUG] Reflection attempt:", reflectionAttempt)

	try {
		// Determine the trigger type from the comment content
		const triggerType = determineTriggerType(commentData.content)
		console.log(`[WatchMode DEBUG] Trigger type: ${triggerType}`)

		// Parse the AI response
		const currentFilePath = vscode.workspace.asRelativePath(document.uri)
		const parsedResponse = parseAIResponse(response, triggerType, currentFilePath)
		console.log(
			`[WatchMode DEBUG] Parsed response: ${parsedResponse.edits.length} edits, explanation length: ${parsedResponse.explanation.length}`,
		)

		// If it's a question, just show the explanation
		if (triggerType === TriggerType.Ask) {
			// Show the explanation in a new editor or information message
			await vscode.window.showInformationMessage(
				"AI Response: " + parsedResponse.explanation.substring(0, 100) + "...",
			)

			// Remove the comment
			const edit = new vscode.WorkspaceEdit()
			const range = new vscode.Range(commentData.startPos, commentData.endPos)
			edit.delete(document.uri, range)
			const result = await vscode.workspace.applyEdit(edit)

			console.log(`[WatchMode DEBUG] Comment removal result: ${result ? "SUCCESS" : "FAILED"}`)
			console.log("[WatchMode DEBUG] ====== processAIResponse END ======")
			return result
		}

		// If there are no edits but there's an explanation, show it
		if (parsedResponse.edits.length === 0 && parsedResponse.explanation) {
			console.log("[WatchMode DEBUG] No edits found, but explanation exists")

			// Check if there are code blocks in the explanation that should replace the comment
			const codeBlocks: string[] = []
			// Use the existing CODE_BLOCK_REGEX constant
			let match

			while ((match = CODE_BLOCK_REGEX.exec(parsedResponse.explanation)) !== null) {
				if (match[1]) {
					codeBlocks.push(match[1].trim())
				}
			}

			if (codeBlocks.length > 0) {
				console.log(`[WatchMode DEBUG] Found ${codeBlocks.length} code blocks, using as replacement`)

				// Use the code blocks as a direct replacement for the comment
				const edit = new vscode.WorkspaceEdit()
				const range = new vscode.Range(commentData.startPos, commentData.endPos)
				const replacement = codeBlocks.join("\n\n")

				edit.replace(document.uri, range, replacement)
				const result = await vscode.workspace.applyEdit(edit)

				console.log(`[WatchMode DEBUG] Direct replacement result: ${result ? "SUCCESS" : "FAILED"}`)
				console.log("[WatchMode DEBUG] ====== processAIResponse END ======")
				return result
			}

			// If no code blocks were found, just remove the comment
			console.log("[WatchMode DEBUG] No code blocks found, removing comment")
			const edit = new vscode.WorkspaceEdit()
			const range = new vscode.Range(commentData.startPos, commentData.endPos)

			edit.delete(document.uri, range)
			const result = await vscode.workspace.applyEdit(edit)

			console.log(`[WatchMode DEBUG] Comment removal result: ${result ? "SUCCESS" : "FAILED"}`)
			console.log("[WatchMode DEBUG] ====== processAIResponse END ======")
			return result
		}

		// Try to apply SEARCH/REPLACE edits first
		let success = await applySearchReplaceEdits(document, parsedResponse.edits)

		// If SEARCH/REPLACE failed, try unified diff as fallback
		if (!success) {
			console.log("[WatchMode DEBUG] SEARCH/REPLACE edits failed, trying unified diff")

			// Convert the edits to the old format
			const oldFormatEdits = parsedResponse.edits.map((edit) => ({
				path: edit.filePath,
				hunk: edit.blocks.flatMap((block) =>
					block.content
						.split("\n")
						.map((line) =>
							block.type === "SEARCH" ? " " + line : block.type === "REPLACE" ? "+" + line : line,
						),
				),
			}))

			const diffHandler = new UnifiedDiffHandler()
			const documentContent = document.getText()
			const [newContent, errors] = diffHandler.applyEdits(oldFormatEdits, documentContent, document.uri)

			if (errors.length > 0) {
				// Log errors but continue with the successful edits
				console.log(`[WatchMode DEBUG] Encountered ${errors.length} errors while applying diffs`)
				for (const error of errors) {
					console.log(`[WatchMode DEBUG] Error: ${error.split("\n")[0]}`)
				}

				// If all edits failed, try reflection if we haven't exceeded the maximum attempts
				if (errors.length >= oldFormatEdits.length) {
					console.log("[WatchMode DEBUG] All edits failed to apply")

					if (reflectionAttempt < MAX_REFLECTION_ATTEMPTS) {
						console.log(`[WatchMode DEBUG] Attempting reflection #${reflectionAttempt + 1}`)

						// Signal that reflection is needed
						// The WatchModeService will handle building the reflection prompt
						console.log("[WatchMode DEBUG] ====== processAIResponse END (needs reflection) ======")

						// Log the error messages for debugging
						console.log("[WatchMode DEBUG] Error messages that will be sent to reflection:")
						errors.forEach((error, index) => {
							console.log(`[WatchMode DEBUG] Error ${index + 1}: ${error}`)
						})

						throw new Error(
							`REFLECTION_NEEDED:${reflectionAttempt + 1}:${errors.map((e) => e.split("\n")[0]).join("|")}`,
						)
					}

					console.log("[WatchMode DEBUG] ====== processAIResponse END (max reflections reached) ======")
					return false
				}
			}

			// Apply the updated content to the document if different from the original
			if (newContent !== documentContent) {
				const fullRange = new vscode.Range(
					new vscode.Position(0, 0),
					document.positionAt(documentContent.length),
				)

				const edit = new vscode.WorkspaceEdit()
				edit.replace(document.uri, fullRange, newContent)
				success = await vscode.workspace.applyEdit(edit)

				console.log(`[WatchMode DEBUG] Applied updated content: ${success ? "SUCCESS" : "FAILED"}`)
			}
		}

		console.log(`[WatchMode DEBUG] Process result: ${success ? "SUCCESS" : "FAILED"}`)
		console.log("[WatchMode DEBUG] ====== processAIResponse END ======")
		return success
	} catch (error) {
		// Check if this is a reflection request
		if (error instanceof Error && error.message.startsWith("REFLECTION_NEEDED:")) {
			// Let the calling code handle the reflection
			throw error
		}

		console.error("[WatchMode DEBUG] Error in processAIResponse:", error)
		console.log("[WatchMode DEBUG] ====== processAIResponse END (with error) ======")
		return false
	}
}

/**
 * Builds a reflection prompt for the AI model when edits fail
 * @param commentData The original AI comment data
 * @param originalResponse The original AI response that failed
 * @param errors The errors encountered when applying the edits
 * @returns A prompt for the AI model to reflect on the errors
 */
export function buildReflectionPrompt(
	commentData: AICommentData,
	originalResponse: string,
	errors: string[],
	activeFiles: { uri: vscode.Uri; content: string }[] = [],
): string {
	console.log("[WatchMode DEBUG] Building reflection prompt")
	const { content, context, fileUri } = commentData
	const filePath = vscode.workspace.asRelativePath(fileUri)

	// Extract the prefix without the exclamation mark for display in the prompt
	const displayPrefix = currentAICommentPrefix.endsWith("!")
		? currentAICommentPrefix.slice(0, -1)
		: currentAICommentPrefix

	// Create the reflection prompt with escaped markers
	let prompt = `
You are Kilo Code, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.

# Task

${content}

I've written your instructions in comments in the code and marked them with "${displayPrefix}"
You can see the "${displayPrefix}" comments shown below.
Find them in the code files I've shared with you, and follow their instructions.

# Code to modify

\`\`\`
${context || "No context available"}
\`\`\`

# Previous response

Your previous response failed to apply correctly. Here's what you provided:

\`\`\`
${originalResponse}
\`\`\`

# Errors

The following errors occurred when trying to apply your changes:

${errors.join("\n\n")}
`

	// Add content from active files for additional context
	if (activeFiles.length > 0) {
		prompt += `\n\n# Additional context from open files\n\n`

		for (const file of activeFiles) {
			if (file.uri.toString() !== fileUri.toString()) {
				// Skip the file with the comment
				const relativePath = vscode.workspace.asRelativePath(file.uri)
				prompt += `## ${relativePath}\n\n\`\`\`\n${file.content}\n\`\`\`\n\n`
			}
		}
	}

	prompt += `
# Response format

Please correct your previous response to address these errors. Make sure your SEARCH blocks exactly match the code in the file.
You MUST respond with SEARCH/REPLACE blocks for each edit. Format your changes as follows:

${filePath}
\<\<\<\<\<\<\< SEARCH
exact original code
\=\=\=\=\=\=\=
replacement code
\>\>\>\>\>\>\> REPLACE

You can include multiple SEARCH/REPLACE blocks for the same file, and you can edit multiple files.
Make sure to include enough context in the SEARCH block to uniquely identify the code to replace.
After completing the instructions, also BE SURE to remove all the "${displayPrefix}" comments from the code.

If you need to explain your changes, please do so before or after the code blocks.
`

	const finalPrompt = prompt.trim()

	// Log the full reflection prompt for debugging
	console.log("[WatchMode DEBUG] === FULL REFLECTION PROMPT ===")
	console.log(finalPrompt)
	console.log("[WatchMode DEBUG] === END REFLECTION PROMPT ===")

	// Debug log the full reflection prompt string
	console.debug(
		"[WatchMode DEBUG] Full reflection prompt string:",
		JSON.stringify({
			prompt: finalPrompt,
			length: finalPrompt.length,
			estimatedTokens: estimateTokenCount(finalPrompt),
			originalResponseLength: originalResponse.length,
			errorsCount: errors.length,
			timestamp: new Date().toISOString(),
		}),
	)

	return finalPrompt
}
