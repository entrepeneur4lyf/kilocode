import { HelperVars } from "../utils/HelperVars"
import { IDE } from "../utils/ide"
import {
	AutocompleteClipboardSnippet,
	AutocompleteCodeSnippet,
	AutocompleteDiffSnippet,
	AutocompleteSnippetType,
} from "./types"
// Define missing types for GetLspDefinitionsFunction and ContextRetrievalService
export type GetLspDefinitionsFunction = (
	filepath: string,
	fileContents: string,
	cursorPosition: number,
	ide: IDE,
	lang: any,
) => Promise<AutocompleteCodeSnippet[]>

export interface ContextRetrievalService {
	// This is a stub interface that would normally have methods for retrieving context
	getContextForPath?: (filepath: string, astPath: any) => Promise<AutocompleteCodeSnippet[]>
}

const IDE_SNIPPETS_ENABLED = false // ideSnippets is not used, so it's temporarily disabled

export interface SnippetPayload {
	rootPathSnippets: AutocompleteCodeSnippet[]
	importDefinitionSnippets: AutocompleteCodeSnippet[]
	ideSnippets: AutocompleteCodeSnippet[]
	recentlyEditedRangeSnippets: AutocompleteCodeSnippet[]
	recentlyVisitedRangesSnippets: AutocompleteCodeSnippet[]
	diffSnippets: AutocompleteDiffSnippet[]
	clipboardSnippets: AutocompleteClipboardSnippet[]
}

function racePromise<T>(promise: Promise<T[]>): Promise<T[]> {
	const timeoutPromise = new Promise<T[]>((resolve) => {
		setTimeout(() => resolve([]), 100)
	})

	return Promise.race([promise, timeoutPromise])
}

class DiffSnippetsCache {
	private cache: Map<number, any> = new Map()
	private lastTimestamp: number = 0

	public set<T>(timestamp: number, value: T): T {
		// Clear old cache entry if exists
		if (this.lastTimestamp !== timestamp) {
			this.cache.clear()
		}
		this.lastTimestamp = timestamp
		this.cache.set(timestamp, value)
		return value
	}

	public get(timestamp: number): any | undefined {
		return this.cache.get(timestamp)
	}
}

const diffSnippetsCache = new DiffSnippetsCache()

// Some IDEs might have special ways of finding snippets (e.g. JetBrains and VS Code have different "LSP-equivalent" systems,
// or they might separately track recently edited ranges)
async function getIdeSnippets(
	_helper: HelperVars,
	_ide: IDE,
	_getDefinitionsFromLsp: GetLspDefinitionsFunction,
): Promise<AutocompleteCodeSnippet[]> {
	return []
	// const ideSnippets = await getDefinitionsFromLsp(
	// 	helper.input.filepath,
	// 	helper.fullPrefix + helper.fullSuffix,
	// 	helper.fullPrefix.length,
	// 	ide,
	// 	helper.lang,
	// )

	// if (helper.options.onlyMyCode) {
	// 	const workspaceDirs = await ide.getWorkspaceDirs()

	// 	return ideSnippets.filter((snippet) =>
	// 		workspaceDirs.some((dir) => !!findUriInDirs(snippet.filepath, [dir]).foundInDir),
	// 	)
	// }

	// return ideSnippets
}

function getSnippetsFromRecentlyEditedRanges(helper: HelperVars): AutocompleteCodeSnippet[] {
	if (helper.options.useRecentlyEdited === false) {
		return []
	}

	return helper.input.recentlyEditedRanges.map((range) => {
		return {
			filepath: range.filepath,
			content: range.lines.join("\n"),
			type: AutocompleteSnippetType.Code,
		}
	})
}

const getClipboardSnippets = async (ide: IDE): Promise<AutocompleteClipboardSnippet[]> => {
	const content = await ide.getClipboardContent()

	return [content].map((item) => {
		return {
			content: item.text,
			copiedAt: item.copiedAt,
			type: AutocompleteSnippetType.Clipboard,
		}
	})
}

const getDiffSnippets = async (ide: IDE): Promise<AutocompleteDiffSnippet[]> => {
	const currentTimestamp = ide.getLastFileSaveTimestamp
		? ide.getLastFileSaveTimestamp()
		: Math.floor(Date.now() / 10000) * 10000 // Defaults to update once in every 10 seconds

	// Check cache first
	const cached = diffSnippetsCache.get(currentTimestamp) as AutocompleteDiffSnippet[]

	if (cached) {
		return cached
	}

	let diff: string[] = []
	try {
		diff = await ide.getDiff(true)
	} catch (e) {
		console.error("Error getting diff for autocomplete", e)
	}

	return diffSnippetsCache.set(
		currentTimestamp,
		diff.map((item) => {
			return {
				content: item,
				type: AutocompleteSnippetType.Diff,
			}
		}),
	)
}

export const getAllSnippets = async ({
	helper,
	ide,
	getDefinitionsFromLsp,
	_contextRetrievalService,
}: {
	helper: HelperVars
	ide: IDE
	getDefinitionsFromLsp: GetLspDefinitionsFunction
	_contextRetrievalService: ContextRetrievalService
}): Promise<SnippetPayload> => {
	const recentlyEditedRangeSnippets = getSnippetsFromRecentlyEditedRanges(helper)

	const [ideSnippets, diffSnippets, clipboardSnippets] = await Promise.all([
		IDE_SNIPPETS_ENABLED ? racePromise(getIdeSnippets(helper, ide, getDefinitionsFromLsp)) : [],
		racePromise(getDiffSnippets(ide)),
		racePromise(getClipboardSnippets(ide)),
	])

	return {
		rootPathSnippets: [],
		importDefinitionSnippets: [],
		ideSnippets,
		recentlyEditedRangeSnippets,
		diffSnippets,
		clipboardSnippets,
		recentlyVisitedRangesSnippets: helper.input.recentlyVisitedRanges,
	}
}
