import {
	AutocompleteSnippetType,
	type AutocompleteSnippet,
	type AutocompleteContextSnippet,
	type AutocompleteCodeSnippet,
} from "../templating/snippetTypes"
// src/services/autocomplete/context/snippetProvider.ts
import { CodeContext, CodeContextDefinition } from "../ContextGatherer"
import { PromptOptions } from "../PromptRenderer" // Use PromptOptions from PromptRenderer
import { getUriPathBasename } from "../templating/uri"

/**
 * Generates autocomplete snippets based on the code context and options.
 * This logic was previously in PromptRenderer.ts.
 * @param codeContext The gathered code context.
 * @param options Autocomplete options, including flags for including imports and definitions.
 * @param currentFilepath The filepath of the current document being edited.
 * @returns An array of AutocompleteSnippet.
 */
export function generateAutocompleteSnippets(
	codeContext: CodeContext,
	options: PromptOptions, // Changed type to PromptOptions
	currentFilepath: string,
): AutocompleteSnippet[] {
	const snippets: AutocompleteSnippet[] = []

	snippets.push(
		...(options.includeImports
			? codeContext.imports.map(
					(importStatement, index): AutocompleteContextSnippet => ({
						type: AutocompleteSnippetType.Context,
						content: importStatement,
						filepath: `context://imports/${getUriPathBasename(currentFilepath)}#${index}`,
					}),
				)
			: []),
	)

	snippets.push(
		...(options.includeDefinitions
			? codeContext.definitions.map(
					(def: CodeContextDefinition): AutocompleteCodeSnippet => ({
						type: AutocompleteSnippetType.Code,
						filepath: def.filepath,
						content: def.content,
						// language: def.language // Language is not on CodeContextDefinition, derived from main file or filepath extension if needed by template
					}),
				)
			: []),
	)
	return snippets
}
