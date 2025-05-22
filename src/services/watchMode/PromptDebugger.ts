import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"

/**
 * Flag to enable/disable autocomplete prompt debugging
 * When enabled, prompts will be written to a debug file
 */
export const DEBUG_AUTOCOMPLETE_PROMPT = true

/**
 * Base directory for debug files
 */
const DEBUG_BASE_DIR = path.join(os.tmpdir(), "kilo_prompt_debug")

/**
 * Interface for debug session data
 */
interface DebugSession {
	id: string
	directory: string
}

/**
 * Generates a unique ID for a debug session
 */
function generateDebugId(): string {
	return Date.now().toString()
}

/**
 * Creates a debug directory for a session
 * @returns Debug session information
 */
function createDebugSession(): DebugSession {
	const id = generateDebugId()
	const directory = path.join(DEBUG_BASE_DIR, id)

	// Create the directory if it doesn't exist
	if (!fs.existsSync(DEBUG_BASE_DIR)) {
		fs.mkdirSync(DEBUG_BASE_DIR, { recursive: true })
	}

	if (!fs.existsSync(directory)) {
		fs.mkdirSync(directory, { recursive: true })
	}

	console.log(`Debugging prompt dir: ${directory}`)
	return { id, directory }
}

/**
 * Writes content to a debug file
 * @param filename The filename to write to
 * @param content The content to write
 * @param directory The directory to write to
 */
function writeDebugFile(filename: string, content: string, directory: string): void {
	const filePath = path.join(directory, filename)

	fs.writeFile(filePath, content, (err) => {
		if (err) {
			console.error(`Error writing debug file ${filename}:`, err)
		} else {
			// console.log(`Debug file written to ${filePath}`)
		}
	})
}

/**
 * Writes autocomplete prompts to a debug file when debugging is enabled
 * @param systemPrompt The system prompt
 * @param userPrompt The user prompt
 * @returns The debug session ID if debugging is enabled, undefined otherwise
 */
export function writePromptToDebugFile(systemPrompt: string, userPrompt: string): string | undefined {
	if (!DEBUG_AUTOCOMPLETE_PROMPT) {
		return undefined
	}

	try {
		const session = createDebugSession()
		const debugContent = `System Prompt:\n${systemPrompt}\n\nUser Prompt:\n${userPrompt.replaceAll("\\n", "\n")}`
		writeDebugFile("prompt.txt", debugContent, session.directory)

		// Also write a metadata file with timestamp
		const metadata = {
			timestamp: new Date().toISOString(),
			type: "prompt",
		}
		writeDebugFile("metadata.json", JSON.stringify(metadata, null, 2), session.directory)

		return session.id
	} catch (error) {
		console.error("Error in debug prompt writing:", error)
		// Continue with normal operation even if debug writing fails
		return undefined
	}
}

/**
 * Writes prompt response to a debug file when debugging is enabled
 * @param response The response content
 * @param debugId The debug session ID (if available)
 */
export function writePromptResponseToDebugFile(response: string, debugId?: string): void {
	if (!DEBUG_AUTOCOMPLETE_PROMPT) {
		return
	}

	try {
		let directory: string

		if (debugId) {
			// Use the existing debug session directory
			directory = path.join(DEBUG_BASE_DIR, debugId)

			// Create the directory if it doesn't exist (shouldn't happen but just in case)
			if (!fs.existsSync(directory)) {
				fs.mkdirSync(directory, { recursive: true })
			}
		} else {
			// Create a new session if no ID was provided
			const session = createDebugSession()
			directory = session.directory
		}

		const debugContent = `Response:\n${response}`
		writeDebugFile("response.txt", debugContent, directory)
	} catch (error) {
		console.error("Error in debug response writing:", error)
		// Continue with normal operation even if debug writing fails
	}
}
