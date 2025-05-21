import * as vscode from "vscode"
import { AutocompleteProvider } from "../AutocompleteProvider"
import { AutocompleteConfig } from "../AutocompleteConfig"
import { ApiHandler, buildApiHandler } from "../../../api"
import { ContextGatherer, CodeContext } from "../ContextGatherer"
import { PromptRenderer } from "../PromptRenderer"
import { CompletionCache } from "../utils/CompletionCache"
import { AutocompleteDebouncer } from "../utils/AutocompleteDebouncer"

// --- Mocks ---
const mockVscode = {
	window: {
		createTextEditorDecorationType: jest.fn().mockReturnValue({ dispose: jest.fn() }),
		activeTextEditor: undefined as vscode.TextEditor | undefined,
		createStatusBarItem: jest.fn().mockReturnValue({
			show: jest.fn(),
			dispose: jest.fn(),
			text: "",
			tooltip: "",
			command: "",
		}),
		showInformationMessage: jest.fn(),
	},
	commands: {
		executeCommand: jest.fn(),
		registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
	},
	Range: jest.fn(
		(start, end) =>
			({ start, end, isEmpty: start === end, isSingleLine: start.line === end.line }) as unknown as vscode.Range,
	),
	Position: jest.fn((line, character) => ({ line, character }) as unknown as vscode.Position),
	ThemeColor: jest.fn((id) => ({ id })),
	DecorationRangeBehavior: { ClosedOpen: 1 },
	StatusBarAlignment: { Right: 1 },
	workspace: {
		getConfiguration: jest.fn().mockReturnValue({ get: jest.fn() }),
		onDidChangeConfiguration: jest.fn().mockReturnValue({ dispose: jest.fn() }),
		onDidChangeTextDocument: jest.fn().mockReturnValue({ dispose: jest.fn() }),
	},
	languages: {
		registerInlineCompletionItemProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
	},
	InlineCompletionItem: jest.fn((text) => ({ text })),
	// Add other necessary VS Code constructs
	TextEditorSelectionChangeKind: { Command: 2 }, // Example value
}
jest.mock("vscode", () => mockVscode)

jest.mock("../AutocompleteConfig")
jest.mock("../../../api", () => ({
	buildApiHandler: jest.fn(),
	// ApiHandler itself might need to be a class mock if methods are called on an instance
}))
jest.mock("../ContextGatherer")
jest.mock("../PromptRenderer")
jest.mock("../utils/CompletionCache")
jest.mock("../utils/AutocompleteDebouncer")

// Make sure the mock for InlineCompletionItem matches the actual structure or expected usage
mockVscode.InlineCompletionItem = jest.fn((textOrSnippet) => {
	if (typeof textOrSnippet === "string") {
		return { insertText: textOrSnippet, range: undefined, command: undefined }
	}
	// If it's an object (like a snippet string), assign its properties
	return { ...textOrSnippet }
}) as jest.Mock

describe("AutocompleteProvider", () => {
	let provider: AutocompleteProvider
	let mockConfig: jest.Mocked<AutocompleteConfig>
	let mockApiHandler: jest.Mocked<ApiHandler>
	let mockContextGatherer: jest.Mocked<ContextGatherer>
	let mockPromptRenderer: jest.Mocked<PromptRenderer>
	let mockCache: jest.Mocked<CompletionCache>
	let mockDebouncer: jest.Mocked<AutocompleteDebouncer>
	let mockDocument: vscode.TextDocument
	let mockPosition: vscode.Position
	let mockVscodeToken: vscode.CancellationToken
	let mockContext: vscode.InlineCompletionContext

	beforeEach(() => {
		jest.clearAllMocks()

		// Instantiate mocks
		mockConfig = new AutocompleteConfig() as jest.Mocked<AutocompleteConfig>
		// For buildApiHandler, ensure it returns a mock ApiHandler instance
		mockApiHandler = {
			getCompletionStream: jest.fn(),
			// Add other methods if AutocompleteProvider uses them
		} as unknown as jest.Mocked<ApiHandler>
		;(buildApiHandler as jest.Mock).mockReturnValue(mockApiHandler)

		mockContextGatherer = new ContextGatherer() as jest.Mocked<ContextGatherer>
		mockPromptRenderer = new PromptRenderer({}, "") as jest.Mocked<PromptRenderer>
		mockCache = new CompletionCache() as jest.Mocked<CompletionCache>
		mockDebouncer = new AutocompleteDebouncer() as jest.Mocked<AutocompleteDebouncer>

		// Setup default return values for mocks
		;(mockConfig.loadConfig as jest.Mock).mockResolvedValue({
			enabled: true,
			debounceDelay: 150,
			ollamaModelId: "test-model",
			ollamaBaseUrl: "http://localhost:11434",
			useImports: true,
			onlyMyCode: true, // maps to useDefinitions
			multilineCompletions: "auto",
			ollamaParameters: {},
			disabledInFiles: [],
		})
		;(mockDebouncer.delayAndShouldDebounce as jest.Mock).mockResolvedValue(false) // Default: don't debounce

		const mockGatherContextResult: CodeContext = {
			currentLine: "const a = ",
			precedingLines: ["function test() {"],
			followingLines: ["}"],
			imports: [],
			definitions: [],
		}
		;(mockContextGatherer.gatherContext as jest.Mock).mockResolvedValue(mockGatherContextResult)

		;(mockPromptRenderer.renderPrompt as jest.Mock).mockReturnValue({
			prompt: "Rendered Prompt",
			prefix: "function test() {\nconst a = ",
			suffix: "\n}",
			completionOptions: { stop: ["\n"] },
		})
		;(mockPromptRenderer.renderSystemPrompt as jest.Mock).mockReturnValue("System Prompt")

		// Mock ApiHandler stream
		const mockStream = (async function* () {
			yield "completion part 1"
			yield " completion part 2"
		})()
		;(mockApiHandler.getCompletionStream as jest.Mock).mockReturnValue(mockStream)

		// Initialize AutocompleteProvider - this will call buildApiHandler
		provider = new AutocompleteProvider()

		// Mock VS Code objects for provideInlineCompletionItems
		mockDocument = {
			uri: { scheme: "file", fsPath: "/test/file.ts", toString: () => "file:///test/file.ts" } as vscode.Uri,
			languageId: "typescript",
			getText: jest.fn(() => "function test() {\nconst a = \n}"),
			offsetAt: jest.fn((pos) => pos.line * 100 + pos.character), // Simplified offset
			// Add other necessary TextDocument properties
		} as unknown as vscode.TextDocument

		mockPosition = { line: 1, character: 10 } as vscode.Position
		mockVscodeToken = {
			isCancellationRequested: false,
			onCancellationRequested: jest.fn().mockReturnValue({ dispose: jest.fn() }),
		} as unknown as vscode.CancellationToken
		mockContext = {
			triggerKind: 0, // Invoke
			selectedCompletionInfo: undefined,
		} as vscode.InlineCompletionContext

		// Mock activeTextEditor for loading indicators etc.
		mockVscode.window.activeTextEditor = {
			document: mockDocument,
			selection: { active: mockPosition } as vscode.Selection,
			setDecorations: jest.fn(),
			// Add other TextEditor properties if needed
		} as unknown as vscode.TextEditor
	})

	describe("provideInlineCompletionItems", () => {
		it("should return null if disabled", async () => {
			;(mockConfig.loadConfig as jest.Mock).mockResolvedValueOnce({ enabled: false } as any)
			// Re-initialize or set enabled flag if possible, for now assume constructor sets initial state
			// For this test, we might need to simulate config change or test a fresh provider
			const disabledProvider = new AutocompleteProvider()
			// Manually update internal 'enabled' state for this test if direct access is not possible
			// This highlights a potential need for a 'updateConfig' method or similar for easier testing.
			// As a workaround, we can access private members for testing if absolutely necessary and careful.
			;(disabledProvider as any).enabled = false

			const result = await disabledProvider.provideInlineCompletionItems(
				mockDocument,
				mockPosition,
				mockContext,
				mockVscodeToken,
			)
			expect(result).toBeNull()
			expect(mockDebouncer.clear).toHaveBeenCalled()
		})

		it("should return null if debounced", async () => {
			;(mockDebouncer.delayAndShouldDebounce as jest.Mock).mockResolvedValue(true)
			const result = await provider.provideInlineCompletionItems(
				mockDocument,
				mockPosition,
				mockContext,
				mockVscodeToken,
			)
			expect(result).toBeNull()
		})

		it("should call core services and return completion item", async () => {
			const result = (await provider.provideInlineCompletionItems(
				mockDocument,
				mockPosition,
				mockContext,
				mockVscodeToken,
			)) as vscode.InlineCompletionItem[]

			expect(mockContextGatherer.gatherContext).toHaveBeenCalledWith(mockDocument, mockPosition, true, true)
			expect(mockPromptRenderer.renderPrompt).toHaveBeenCalled()
			expect(mockApiHandler.getCompletionStream).toHaveBeenCalled()
			expect(mockCache.set).toHaveBeenCalled() // Assuming completion is successful

			expect(result).toBeInstanceOf(Array)
			expect(result.length).toBe(1)
			expect(result[0].insertText).toBe("completion part 1 completion part 2") // Based on mock stream
		})

		it("should handle cancellation token", async () => {
			mockVscodeToken.isCancellationRequested = true
			const result = await provider.provideInlineCompletionItems(
				mockDocument,
				mockPosition,
				mockContext,
				mockVscodeToken,
			)
			expect(result).toBeNull()
		})

		// TODO: Add tests for:
		// - Post-processing call
		// - Two-stage completion logic (this will require more detailed setup of provider state)
		// - Error handling from API
		// - validateCompletionContext returning false
		// - isFileDisabled returning true
	})

	describe("provideInlineCompletionItems - Cache Hit", () => {
		it("should return cached completion and not call API if cache hits", async () => {
			const cachedCompletion = "cached completion text"
			;(mockCache.get as jest.Mock).mockReturnValue(cachedCompletion)

			const result = (await provider.provideInlineCompletionItems(
				mockDocument,
				mockPosition,
				mockContext,
				mockVscodeToken,
			)) as vscode.InlineCompletionItem[]

			expect(mockCache.get).toHaveBeenCalledWith(
				mockDocument.uri.toString(),
				mockDocument.getText(),
				mockDocument.offsetAt(mockPosition),
			)
			expect(mockApiHandler.getCompletionStream).not.toHaveBeenCalled()
			expect(mockContextGatherer.gatherContext).not.toHaveBeenCalled() // Should not gather context if cache hit
			expect(mockPromptRenderer.renderPrompt).not.toHaveBeenCalled() // Should not render prompt if cache hit

			expect(result).toBeInstanceOf(Array)
			expect(result.length).toBe(1)
			expect(result[0].insertText).toBe(cachedCompletion)
		})
	})

	// The existing "Two-stage completion acceptance" tests can be adapted here.
	// They would need to use the actual AutocompleteProvider instance and mock its internal dependencies
	// (like editor.edit) or trigger its command handlers.
	// For now, I'll keep them separate and focus on the provideInlineCompletionItems flow.
})
