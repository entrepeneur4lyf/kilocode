import * as vscode from "vscode"
import { WatchModeService } from ".."
import * as experimentsModule from "../../../shared/experiments"

jest.mock("vscode", () => ({
	workspace: {
		createFileSystemWatcher: jest.fn().mockReturnValue({
			onDidCreate: jest.fn(),
			onDidChange: jest.fn(),
			dispose: jest.fn(),
		}),
		getConfiguration: jest.fn().mockReturnValue({
			get: jest.fn((key, defaultValue) => defaultValue),
		}),
		openTextDocument: jest.fn().mockResolvedValue({
			getText: jest.fn().mockReturnValue("// AI! Test comment"),
			languageId: "javascript",
			uri: { fsPath: "test.js" },
		}),
		workspaceFolders: [{ uri: {} }],
		asRelativePath: jest.fn().mockReturnValue("test.js"),
		applyEdit: jest.fn().mockResolvedValue(true),
	},
	window: {
		createOutputChannel: jest.fn().mockReturnValue({
			appendLine: jest.fn(),
		}),
	},
	Uri: {
		file: jest.fn().mockReturnValue({}),
	},
	FileChangeType: {
		Created: 1,
		Changed: 2,
		Deleted: 3,
	},
	WorkspaceEdit: jest.fn().mockImplementation(() => ({
		replace: jest.fn(),
	})),
	Range: jest.fn(),
	Position: jest.fn(),
	EventEmitter: jest.fn().mockImplementation(() => ({
		event: jest.fn(),
		fire: jest.fn(),
	})),
	RelativePattern: jest.fn(),
}))

// Mock the experiments module
jest.mock("../../../shared/experiments", () => ({
	EXPERIMENT_IDS: {
		WATCH_MODE: "watchMode",
	},
	experiments: {
		isEnabled: jest.fn(),
		get: jest.fn(),
	},
	ExperimentId: {},
}))

// Mock the WatchModeUI class
jest.mock("../ui", () => ({
	WatchModeUI: jest.fn().mockImplementation(() => ({
		showStatus: jest.fn(),
		showProcessing: jest.fn(),
		hideProcessing: jest.fn(),
		showSuccessNotification: jest.fn(),
		showErrorNotification: jest.fn(),
		dispose: jest.fn(),
	})),
}))

// Mock the commentProcessor module
jest.mock("../commentProcessor", () => ({
	detectAIComments: jest.fn().mockReturnValue({
		comments: [
			{
				content: "Test AI comment",
				startPos: {},
				endPos: {},
				fileUri: { fsPath: "test.js" },
			},
		],
	}),
	buildAIPrompt: jest.fn().mockReturnValue("Mock AI prompt"),
	processAIResponse: jest.fn().mockResolvedValue("Processed AI response"),
	applyAIResponseToDocument: jest.fn().mockResolvedValue(true),
}))

describe("WatchModeService", () => {
	const mockContext = {
		subscriptions: [],
		globalState: {
			get: jest.fn(),
			update: jest.fn(),
		},
	} as unknown as vscode.ExtensionContext

	const mockOutputChannel = {
		appendLine: jest.fn(),
	} as unknown as vscode.OutputChannel

	beforeEach(() => {
		jest.clearAllMocks()
		jest.useFakeTimers()
	})

	afterEach(() => {
		jest.useRealTimers()
	})

	describe("start", () => {
		it("should not start when experiment is disabled", () => {
			// Mock experiment as disabled
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(false)

			const service = new WatchModeService(mockContext, mockOutputChannel)
			const result = service.start()

			expect(result).toBe(false)
			expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("experiment is not enabled"),
			)
		})

		it("should start when experiment is enabled", () => {
			// Mock experiment as enabled
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			const service = new WatchModeService(mockContext, mockOutputChannel)
			const result = service.start()

			expect(result).toBe(true)
			expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Starting watch mode service"),
			)
		})

		it("should not start twice", () => {
			// Mock experiment as enabled
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			const service = new WatchModeService(mockContext, mockOutputChannel)

			// Start first time
			service.start()

			// Reset mock to verify second call
			jest.clearAllMocks()

			// Start second time
			const result = service.start()

			expect(result).toBe(true)
			expect(vscode.workspace.createFileSystemWatcher).not.toHaveBeenCalled()
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("already active"))
		})
	})

	describe("stop", () => {
		it("should stop and clean up resources", () => {
			// Mock experiment as enabled
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			const service = new WatchModeService(mockContext, mockOutputChannel)
			service.start() // Start the service first

			// Reset mocks after start
			jest.clearAllMocks()

			// Stop the service
			service.stop()

			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Stopping watch mode service"),
			)
		})

		it("should do nothing if not started", () => {
			const service = new WatchModeService(mockContext, mockOutputChannel)

			jest.clearAllMocks()

			// Stop without starting
			service.stop()

			expect(mockOutputChannel.appendLine).not.toHaveBeenCalled()
		})
	})
	describe("handleFileChange", () => {
		it("should process file changes with debounce", async () => {
			// Mock experiment as enabled
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			const service = new WatchModeService(mockContext, mockOutputChannel)
			service.start()

			// Get the file change handler from the watcher
			const onDidChangeHandler = (vscode.workspace.createFileSystemWatcher as jest.Mock).mock.results[0].value
				.onDidChange
			expect(onDidChangeHandler).toHaveBeenCalled()

			// Call the handler with a file URI
			const fileChangeCallback = onDidChangeHandler.mock.calls[0][0]
			const mockUri = vscode.Uri.file("test.js")

			// Simulate file change
			fileChangeCallback(mockUri)

			// Fast-forward timers to trigger debounced function
			jest.runAllTimers()

			// Verify file was processed
			expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(mockUri)
		})

		it("should skip excluded files", async () => {
			// Setup
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			// Create a spy for the handleFileChange method
			const service = new WatchModeService(mockContext, mockOutputChannel)
			const handleFileChangeSpy = jest.spyOn(service as any, "handleFileChange")

			// Mock the isFileExcluded method to return true
			const isFileExcludedSpy = jest.spyOn(service as any, "isFileExcluded").mockReturnValue(true)

			service.start()

			// Get the file change handler
			const onDidChangeHandler = (vscode.workspace.createFileSystemWatcher as jest.Mock).mock.results[0].value
				.onDidChange
			const fileChangeCallback = onDidChangeHandler.mock.calls[0][0]

			// Reset mocks to verify they're not called
			jest.clearAllMocks()

			// Simulate file change for an excluded file
			const mockUri = vscode.Uri.file("node_modules/some-file.js")
			fileChangeCallback(mockUri)

			// Fast-forward timers
			jest.runAllTimers()

			// Verify handleFileChange was called
			expect(handleFileChangeSpy).toHaveBeenCalled()

			// But openTextDocument should not have been called due to isFileExcluded returning true
			expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled()

			// Clean up
			handleFileChangeSpy.mockRestore()
			isFileExcludedSpy.mockRestore()
		})
	})

	describe("processFile", () => {
		it("should process files with AI comments", async () => {
			// Setup
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			// Mock the processAIComment method to avoid timeout
			const service = new WatchModeService(mockContext, mockOutputChannel)
			const processAICommentSpy = jest.spyOn(service as any, "processAIComment").mockResolvedValue(undefined)
			service.start()

			// Reset mocks
			jest.clearAllMocks()

			// Call private method via any cast to test it directly
			const mockUri = vscode.Uri.file("test.js")
			await (service as any).processFile(mockUri)

			// Verify correct flow
			expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(mockUri)

			// Check if detectAIComments was called with correct parameters
			const commentProcessorModule = require("../commentProcessor")
			expect(commentProcessorModule.detectAIComments).toHaveBeenCalledWith({
				fileUri: mockUri,
				content: "// AI! Test comment",
				languageId: "javascript",
			})

			// Verify that the AI comment was processed
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Found 1 AI comments"))

			// Verify that processAIComment was called
			expect(processAICommentSpy).toHaveBeenCalled()

			// Clean up
			processAICommentSpy.mockRestore()
		}, 10000) // Increase timeout just in case

		it("should skip large files", async () => {
			// Setup
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			// Mock a large file content
			const longContent = "x".repeat(1100000) // Larger than 1MB
			const mockDocument = {
				getText: jest.fn().mockReturnValue(longContent),
				languageId: "javascript",
				uri: vscode.Uri.file("large-file.js"),
			}
			// Mock the document to return large content
			;(vscode.workspace.openTextDocument as jest.Mock).mockResolvedValueOnce(mockDocument)

			const service = new WatchModeService(mockContext, mockOutputChannel)
			service.start()

			// Reset mocks
			jest.clearAllMocks()

			// Process the large file
			const mockUri = vscode.Uri.file("large-file.js")
			await (service as any).processFile(mockUri)

			// Verify large file was skipped
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Skipping large file"))

			// Verify detectAIComments was not called
			const commentProcessorModule = require("../commentProcessor")
			expect(commentProcessorModule.detectAIComments).not.toHaveBeenCalled()
		})

		it("should handle errors during file processing", async () => {
			// Setup
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)
			// Mock openTextDocument to throw error
			;(vscode.workspace.openTextDocument as jest.Mock).mockRejectedValueOnce(new Error("File read error"))

			const service = new WatchModeService(mockContext, mockOutputChannel)
			service.start()

			// Reset mocks
			jest.clearAllMocks()

			// Process file with error
			const mockUri = vscode.Uri.file("error-file.js")
			await (service as any).processFile(mockUri)

			// Verify error was logged
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("Error processing file"))
		})
	})

	describe("processAIComment", () => {
		it("should process AI comments and apply responses", async () => {
			// Setup
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			const mockDocument = {
				getText: jest.fn().mockReturnValue("// AI! Test comment"),
				languageId: "javascript",
				uri: vscode.Uri.file("test.js"),
			}

			const mockComment = {
				content: "Test AI comment",
				startPos: {},
				endPos: {},
				fileUri: vscode.Uri.file("test.js"),
				context: "// Context code",
			}

			const service = new WatchModeService(mockContext, mockOutputChannel)

			// Mock the API call
			const originalCallAIModel = (service as any).callAIModel
			;(service as any).callAIModel = jest.fn().mockResolvedValue("AI response")

			// Process the AI comment
			await (service as any).processAIComment(mockDocument, mockComment)

			// Verify prompt was built
			const commentProcessorModule = require("../commentProcessor")
			expect(commentProcessorModule.buildAIPrompt).toHaveBeenCalledWith(mockComment)

			// Verify AI model was called
			expect((service as any).callAIModel).toHaveBeenCalledWith("Mock AI prompt")

			// Verify response was processed
			expect(commentProcessorModule.processAIResponse).toHaveBeenCalledWith({
				commentData: mockComment,
				response: "AI response",
			})

			// Verify response was applied
			expect(commentProcessorModule.applyAIResponseToDocument).toHaveBeenCalledWith(
				mockDocument,
				mockComment,
				"Processed AI response",
			)

			// Verify success was logged
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("Successfully applied AI response"),
			)
			// Restore the original method
			;(service as any).callAIModel = originalCallAIModel
		})

		it("should handle API errors", async () => {
			// Setup
			jest.spyOn(experimentsModule.experiments, "isEnabled").mockReturnValue(true)

			const mockDocument = {
				getText: jest.fn().mockReturnValue("// AI! Test comment"),
				languageId: "javascript",
				uri: vscode.Uri.file("test.js"),
			}

			const mockComment = {
				content: "Test AI comment",
				startPos: {},
				endPos: {},
				fileUri: vscode.Uri.file("test.js"),
				context: "// Context code",
			}

			const service = new WatchModeService(mockContext, mockOutputChannel)

			// Mock the API call to fail
			const originalCallAIModel = (service as any).callAIModel
			;(service as any).callAIModel = jest.fn().mockResolvedValue(null)

			// Reset mocks
			jest.clearAllMocks()

			// Process the AI comment
			await (service as any).processAIComment(mockDocument, mockComment)

			// Verify error was logged
			expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(
				expect.stringContaining("No response from AI model"),
			)

			// Verify no further processing happened
			const commentProcessorModule = require("../commentProcessor")
			expect(commentProcessorModule.processAIResponse).not.toHaveBeenCalled()
			// Restore the original method
			;(service as any).callAIModel = originalCallAIModel
		})
	})
})
