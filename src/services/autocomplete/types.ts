import { Position } from "vscode"
import { AutocompleteCodeSnippet } from "./snippets/types"
import { RangeInFile, Range } from "."

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
	tools?: Tool[]
	toolChoice?: ToolChoice
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

interface ToolChoice {
	type: "function"
	function: {
		name: string
	}
}

export interface Prediction {
	type: "content"
	content:
		| string
		| {
				type: "text"
				text: string
		  }[]
}

export interface Tool {
	type: "function"
	function: {
		name: string
		description?: string
		parameters?: Record<string, any>
		strict?: boolean | null
	}

	displayTitle: string
	wouldLikeTo?: string
	isCurrently?: string
	hasAlready?: string
	readonly: boolean
	isInstant?: boolean
	uri?: string
	faviconUrl?: string
	group: string
}
