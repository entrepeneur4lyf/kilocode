// AIDIFF: Integrating continue/ templating logic
// PLANREF: continue/core/autocomplete/templating/index.ts
import { CodeContext, CodeContextDefinition } from "./ContextGatherer" // AIDIFF: Changed Definition to CodeContextDefinition
import { /* AutocompleteTemplate, */ getTemplateForModel } from "./templating/AutocompleteTemplate" // AIDIFF: Added AutocompleteTemplate, commented out as unused for now
import { getStopTokens } from "./templating/getStopTokens"
import * as vscode from "vscode"
import { /* AutocompleteLanguageInfo, */ getLanguageInfo } from "./AutocompleteLanguageInfo" // AIDIFF: Added AutocompleteLanguageInfo, commented out as unused for now
import {
	/* AutocompleteCodeSnippet, */ /* AutocompleteContextSnippet, */ AutocompleteSnippet,
	AutocompleteSnippetType,
} from "./templating/snippetTypes" // AIDIFF: Added snippet types, commented out unused
import { getUriPathBasename } from "./templating/uri" // AIDIFF: Added for reponame
// AIDIFF: Removed Handlebars as it's not used directly in the new approach from continue/
// We will use simple string replacement for string templates, and function calls for function templates.

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
	stop?: string[] // AIDIFF: Added stop tokens property
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
	 * @returns Rendered prompt, prefix, suffix, and completion options
	 */
	// AIDIFF: Updated method signature and logic to align with continue/renderPrompt
	// PLANREF: continue/core/autocomplete/templating/index.ts (renderPrompt function)
	renderPrompt(
		context: CodeContext,
		options: Partial<PromptOptions> = {},
	): {
		prompt: string
		prefix: string
		suffix: string
		completionOptions: Partial<PromptOptions> | undefined // AIDIFF: Changed to PromptOptions for consistency
	} {
		const mergedOptions = { ...this.defaultOptions, ...options }
		const langInfo = getLanguageInfo(mergedOptions.language)

		// Get the appropriate template for the model
		const currentTemplate = getTemplateForModel(this.modelName) // AIDIFF: Renamed for clarity

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
		// AIDIFF: Ensure suffix is at least a newline, as in continue/
		if (suffix === "") {
			suffix = "\n"
		}

		const filepath = vscode.window.activeTextEditor?.document.uri.fsPath || "untitled"
		const workspaceFolders = vscode.workspace.workspaceFolders
		const reponame = workspaceFolders?.[0]?.uri.fsPath
			? getUriPathBasename(workspaceFolders[0].uri.fsPath)
			: "myproject"
		const workspaceUris = workspaceFolders?.map((folder) => folder.uri.toString()) || []

		// AIDIFF: Prepare snippets from context (imports and definitions)
		// PLANREF: continue/core/autocomplete/templating/index.ts (getSnippets, formatSnippets)
		const snippets: AutocompleteSnippet[] = []
		if (mergedOptions.includeImports && context.imports.length > 0) {
			// AIDIFF: Treat imports as context snippets for now.
			// This could be refined if continue/ has a more specific way to handle imports.
			context.imports.forEach((importStatement, index) => {
				snippets.push({
					type: AutocompleteSnippetType.Context, // Or Code if more appropriate
					content: importStatement,
					filepath: `${filepath}_import_${index}`, // Placeholder filepath for imports
				})
			})
		}
		if (mergedOptions.includeDefinitions && context.definitions.length > 0) {
			context.definitions.forEach((def: CodeContextDefinition) => {
				// AIDIFF: Changed to CodeContextDefinition
				snippets.push({
					type: AutocompleteSnippetType.Code,
					filepath: def.filepath,
					content: def.content,
					// AIDIFF: CodeContextDefinition doesn't have a direct language prop.
					// Language is part of mergedOptions or derived from filepath if needed by a specific template.
					// For now, omitting direct language from snippet if not readily available on def.
					// language: def.language,
				})
			})
		}

		// AIDIFF: Apply compilePrefixSuffix if available
		// PLANREF: continue/core/autocomplete/templating/index.ts (compilePrefixSuffix logic)
		if (currentTemplate.compilePrefixSuffix) {
			;[prefix, suffix] = currentTemplate.compilePrefixSuffix(
				prefix,
				suffix,
				filepath,
				reponame,
				snippets,
				workspaceUris,
			)
		} else {
			// AIDIFF: Basic snippet formatting if no compilePrefixSuffix
			// PLANREF: continue/core/autocomplete/templating/formatting.ts (formatSnippets - simplified)
			const formattedSnippets = snippets
				.map((snippet) => {
					if (snippet.type === AutocompleteSnippetType.Code) {
						return `// From ${getUriPathBasename(snippet.filepath)}\n${snippet.content}`
					}
					return snippet.content // For other types, just use content
				})
				.join("\n\n")
			if (formattedSnippets) {
				prefix = `${formattedSnippets}\n\n${prefix}`
			}
		}

		// Create prompt using template
		let prompt: string
		if (typeof currentTemplate.template === "string") {
			// AIDIFF: Simple string replacement, similar to continue/renderStringTemplate but without Handlebars
			// PLANREF: continue/core/autocomplete/templating/index.ts (renderStringTemplate)
			prompt = currentTemplate.template
				.replace("{{{prefix}}}", prefix)
				.replace("{{{suffix}}}", suffix)
				.replace("{{{filename}}}", getUriPathBasename(filepath)) // AIDIFF: Added filename replacement
				.replace("{{{reponame}}}", reponame) // AIDIFF: Added reponame replacement
				.replace("{{{language}}}", langInfo.name) // AIDIFF: Added language replacement
		} else {
			// Use function template
			prompt = currentTemplate.template(
				prefix,
				suffix,
				filepath,
				reponame,
				langInfo.name,
				snippets,
				workspaceUris,
			)
		}

		// AIDIFF: Determine stop tokens using the updated getStopTokens
		// PLANREF: continue/core/autocomplete/templating/index.ts (getStopTokens call)
		const stop = getStopTokens(currentTemplate.completionOptions, langInfo, this.modelName)

		return {
			prompt,
			prefix,
			suffix,
			completionOptions: {
				...currentTemplate.completionOptions, // AIDIFF: Spread original completion options
				stop, // AIDIFF: Add determined stop tokens
				maxTokens: mergedOptions.maxTokens, // AIDIFF: Corrected to camelCase
				temperature: mergedOptions.temperature,
			},
		}
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
		// AIDIFF: This method now primarily relies on the stop tokens determined by renderPrompt.
		// It can be simplified or used as a fallback if renderPrompt's result isn't directly available.
		// For direct usage with ApiHandler, the stop tokens from renderPrompt's result should be preferred.
		const template = getTemplateForModel(this.modelName)
		const langInfo = getLanguageInfo(this.defaultOptions.language)
		// AIDIFF: Using the updated getStopTokens function from the templating directory
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
