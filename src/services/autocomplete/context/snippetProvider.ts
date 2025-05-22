// src/services/autocomplete/context/snippetProvider.ts
import { AutocompleteSnippet, AutocompleteSnippetType } from "../templating/snippetTypes"
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

	if (options.includeImports && codeContext.imports.length > 0) {
		codeContext.imports.forEach((importStatement, index) => {
			snippets.push({
				type: AutocompleteSnippetType.Context,
				content: importStatement,
				filepath: `context://imports/${getUriPathBasename(currentFilepath)}#${index}`,
			})
		})
	}

	if (options.includeDefinitions && codeContext.definitions.length > 0) {
		codeContext.definitions.forEach((def: CodeContextDefinition) => {
			snippets.push({
				type: AutocompleteSnippetType.Code,
				filepath: def.filepath,
				content: def.content,
				// language: def.language // Language is not on CodeContextDefinition, derived from main file or filepath extension if needed by template
			})
		})
	}
	return snippets
}
