// AIDIFF: Added to define snippet types used by continue/ templating logic
// PLANREF: continue/core/autocomplete/snippets/types.js

export enum AutocompleteSnippetType {
	Code = "code",
	Diff = "diff",
	Context = "context", // Added for general context items
}

export interface AutocompleteBaseSnippet {
	type: AutocompleteSnippetType
	content: string
}

export interface AutocompleteCodeSnippet extends AutocompleteBaseSnippet {
	type: AutocompleteSnippetType.Code
	filepath: string
	language?: string // Optional, as our definitions might not always have it
}

export interface AutocompleteDiffSnippet extends AutocompleteBaseSnippet {
	type: AutocompleteSnippetType.Diff
	// Diff specific properties can be added if needed
}

export interface AutocompleteContextSnippet extends AutocompleteBaseSnippet {
	type: AutocompleteSnippetType.Context
	filepath: string // Or some identifier
}

export type AutocompleteSnippet = AutocompleteCodeSnippet | AutocompleteDiffSnippet | AutocompleteContextSnippet
