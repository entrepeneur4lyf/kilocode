import { CodeContext } from "./ContextGatherer"
import { getTemplateForModel } from "./templating/AutocompleteTemplate"
import { getStopTokens } from "./templating/getStopTokens"
import * as vscode from "vscode"
import { getLanguageInfo } from "./AutocompleteLanguageInfo"

/**
 * Interface for prompt options
 */
export interface PromptOptions {
	maxTokens: number
	temperature: number
	language: string
	includeImports: boolean
	includeDefinitions: boolean
	multilineCompletions: boolean | "auto"
}

/**
 * Renders prompts for autocomplete
 */
export class PromptRenderer {
	private defaultOptions: PromptOptions = {
		maxTokens: 2048,
		temperature: 0.2,
		language: "typescript",
		includeImports: true,
		includeDefinitions: true,
		multilineCompletions: "auto",
	}
	private modelName: string = "qwen2.5-coder:1.5b"

	/**
	 * Create a new prompt renderer
	 * @param options Prompt options
	 * @param modelName Model name for template selection
	 */
	constructor(options: Partial<PromptOptions> = {}, modelName: string = "qwen2.5-coder:1.5b") {
		this.defaultOptions = { ...this.defaultOptions, ...options }
		this.modelName = modelName
	}

	/**
	 * Render a prompt for autocomplete using templates based on the model
	 * @param context Code context
	 * @param options Prompt options
	 * @returns Rendered prompt
	 */
	renderPrompt(context: CodeContext, options: Partial<PromptOptions> = {}): string {
		const mergedOptions = { ...this.defaultOptions, ...options }
		const { language } = mergedOptions

		// Get the appropriate template for the model
		const template = getTemplateForModel(this.modelName)

		// Construct prefix and suffix from context
		let prefix = ""
		if (context.precedingLines.length > 0) {
			prefix += `${context.precedingLines.join("\n")}\n`
		}
		prefix += context.currentLine

		// For suffix, use following lines
		let suffix = ""
		if (context.followingLines.length > 0) {
			suffix = `\n${context.followingLines.join("\n")}`
		}

		// Include imports if requested
		if (mergedOptions.includeImports && context.imports.length > 0) {
			prefix = `${context.imports.join("\n")}\n\n${prefix}`
		}

		// Include definitions if requested
		if (mergedOptions.includeDefinitions && context.definitions.length > 0) {
			let definitionsText = ""
			for (const def of context.definitions) {
				definitionsText += `// From ${def.filepath}\n${def.content}\n\n`
			}
			prefix = `${definitionsText}${prefix}`
		}

		// Create prompt using template
		let prompt: string
		if (typeof template.template === "string") {
			// Use Handlebars-style template format without requiring Handlebars
			prompt = template.template.replace("{{{prefix}}}", prefix).replace("{{{suffix}}}", suffix)
		} else {
			// Use function template
			const filepath = vscode.window.activeTextEditor?.document.uri.fsPath || ""
			const reponame = vscode.workspace.workspaceFolders?.[0]?.name || ""

			prompt = template.template(
				prefix,
				suffix,
				filepath,
				reponame,
				language,
				[], // No workspace URIs for now
			)
		}

		return prompt
	}

	/**
	 * Render a system prompt for autocomplete
	 * @returns System prompt
	 */
	renderSystemPrompt(): string {
		return `You are an AI coding assistant that provides accurate and helpful code completions.
Your task is to complete the code at the cursor position.
Provide only the completion text, without any explanations or markdown formatting.
The completion should be valid, syntactically correct code that fits the context.`
	}

	/**
	 * Get the stop tokens for the current model
	 * @returns Array of stop tokens
	 */
	getStopTokens(): string[] {
		const template = getTemplateForModel(this.modelName)
		const langInfo = getLanguageInfo(this.defaultOptions.language)
		return getStopTokens(template.completionOptions, langInfo, this.modelName)
	}

	/**
	 * Extract completion from model response
	 * @param response Model response
	 * @returns Extracted completion
	 */
	extractCompletion(response: string): string {
		// Remove any markdown code block formatting
		let completion = response.trim()

		// Remove markdown code blocks if present
		const codeBlockRegex = /^```[\w]*\n([\s\S]*?)\n```$/
		const match = completion.match(codeBlockRegex)
		if (match) {
			completion = match[1]
		}

		// Remove any explanations or comments that might be at the beginning
		const lines = completion.split("\n")
		let startIndex = 0

		for (let i = 0; i < lines.length; i++) {
			if (
				lines[i].trim().startsWith("//") ||
				lines[i].trim().startsWith("#") ||
				lines[i].trim().startsWith("/*")
			) {
				startIndex = i + 1
			} else if (lines[i].trim() !== "") {
				break
			}
		}

		completion = lines.slice(startIndex).join("\n")

		return completion
	}
}
