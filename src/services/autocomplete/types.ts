import { Position } from "vscode"
import { RangeInFile, Range, RangeInFileWithContents } from "./ide-types"

// Replacement types for removed snippet functionality
export enum AutocompleteSnippetType {
	Code = "code",
	Diff = "diff",
	Clipboard = "clipboard",
}

export interface BaseAutocompleteSnippet {
	content: string
	type: AutocompleteSnippetType
}

export interface AutocompleteCodeSnippet extends BaseAutocompleteSnippet {
	filepath: string
	type: AutocompleteSnippetType.Code
}

export interface AutocompleteDiffSnippet extends BaseAutocompleteSnippet {
	type: AutocompleteSnippetType.Diff
}

export interface AutocompleteClipboardSnippet extends BaseAutocompleteSnippet {
	type: AutocompleteSnippetType.Clipboard
	copiedAt: string
}

export type AutocompleteSnippet = AutocompleteCodeSnippet | AutocompleteDiffSnippet | AutocompleteClipboardSnippet

export interface BaseCompletionOptions {
	temperature?: number
	topP?: number
	topK?: number
	minP?: number
	presencePenalty?: number
	frequencyPenalty?: number
	mirostat?: number
	stop?: string[]
	maxTokens?: number
	numThreads?: number
	useMmap?: boolean
	keepAlive?: number
	numGpu?: number
	raw?: boolean
	stream?: boolean
	prediction?: Prediction
	// tools?: Tool[]
	// toolChoice?: ToolChoice
	reasoning?: boolean
	reasoningBudgetTokens?: number
	promptCaching?: boolean
}

export interface CompletionOptions extends BaseCompletionOptions {
	model: string
}

export type RecentlyEditedRange = RangeInFile & {
	timestamp: number
	lines: string[]
	symbols: Set<string>
}

export interface AutocompleteInput {
	isUntitledFile: boolean
	completionId: string
	filepath: string
	pos: Position
	recentlyVisitedRanges: AutocompleteCodeSnippet[]
	recentlyEditedRanges: RecentlyEditedRange[]
	// Used for notebook files
	manuallyPassFileContents?: string
	// Used for VS Code git commit input box
	manuallyPassPrefix?: string
	selectedCompletionInfo?: {
		text: string
		range: Range
	}
	injectDetails?: string
}

// interface ToolChoice {
// 	type: "function"
// 	function: {
// 		name: string
// 	}
// }

export interface Prediction {
	type: "content"
	content:
		| string
		| {
				type: "text"
				text: string
		  }[]
}

// export interface Tool {
// 	type: "function"
// 	function: {
// 		name: string
// 		description?: string
// 		parameters?: Record<string, any>
// 		strict?: boolean | null
// 	}

// 	displayTitle: string
// 	wouldLikeTo?: string
// 	isCurrently?: string
// 	hasAlready?: string
// 	readonly: boolean
// 	isInstant?: boolean
// 	uri?: string
// 	faviconUrl?: string
// 	group: string
// }

/**
 * @deprecated This type should be removed in the future or renamed.
 * We have a new interface called AutocompleteSnippet which is more
 * general.
 */
export type AutocompleteSnippetDeprecated = RangeInFileWithContents & {
	score?: number
}
