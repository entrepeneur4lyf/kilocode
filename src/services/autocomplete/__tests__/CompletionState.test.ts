import { CompletionState } from "../CompletionState"

describe("CompletionState", () => {
	let state: CompletionState

	beforeEach(() => {
		state = new CompletionState()
	})

	describe("initial state", () => {
		it("should have correct initial values", () => {
			expect(state.currentPreview).toBe("")
			expect(state.firstLinePreview).toBe("")
			expect(state.remainingLinesPreview).toBe("")
			expect(state.hasAcceptedFirstLine).toBe(false)
			expect(state.isShowingPreview).toBe(false)
			expect(state.isLoading).toBe(false)
			expect(state.activeCompletionId).toBeNull()
		})
	})

	describe("startCompletion", () => {
		it("should set completion ID and loading state", () => {
			const completionId = "test-id-123"
			state.startCompletion(completionId)

			expect(state.activeCompletionId).toBe(completionId)
			expect(state.isLoading).toBe(true)
			expect(state.hasAcceptedFirstLine).toBe(false)
		})
	})

	describe("setCompletionText", () => {
		it("should handle single line completion", () => {
			const text = "console.log('hello')"
			state.setCompletionText(text)

			expect(state.currentPreview).toBe(text)
			expect(state.firstLinePreview).toBe(text)
			expect(state.remainingLinesPreview).toBe("")
		})

		it("should split multi-line completion", () => {
			const text = "function test() {\n  console.log('hello')\n  return true\n}"
			state.setCompletionText(text)

			expect(state.currentPreview).toBe(text)
			expect(state.firstLinePreview).toBe("function test() {")
			expect(state.remainingLinesPreview).toBe("  console.log('hello')\n  return true\n}")
		})
	})

	describe("updatePreview", () => {
		it("should update preview lines", () => {
			state.updatePreview("first line", "remaining lines")

			expect(state.firstLinePreview).toBe("first line")
			expect(state.remainingLinesPreview).toBe("remaining lines")
		})
	})

	describe("acceptFirstLine", () => {
		it("should mark first line as accepted", () => {
			expect(state.hasAcceptedFirstLine).toBe(false)
			state.acceptFirstLine()
			expect(state.hasAcceptedFirstLine).toBe(true)
		})
	})

	describe("showPreview and hidePreview", () => {
		it("should toggle preview visibility", () => {
			state.showPreview()
			expect(state.isShowingPreview).toBe(true)
			expect(state.isLoading).toBe(false)

			state.hidePreview()
			expect(state.isShowingPreview).toBe(false)
		})
	})

	describe("isCompletionActive", () => {
		it("should check if completion is active", () => {
			const completionId = "test-id"
			state.startCompletion(completionId)

			expect(state.isCompletionActive(completionId)).toBe(true)
			expect(state.isCompletionActive("different-id")).toBe(false)
		})
	})

	describe("cancelCompletion", () => {
		it("should cancel completion and reset state", () => {
			state.startCompletion("test-id")
			state.setCompletionText("some text")
			state.showPreview()

			state.cancelCompletion()

			expect(state.activeCompletionId).toBeNull()
			expect(state.currentPreview).toBe("")
			expect(state.isShowingPreview).toBe(false)
			expect(state.isLoading).toBe(false)
		})
	})

	describe("reset", () => {
		it("should reset all state", () => {
			// Set up some state
			state.startCompletion("test-id")
			state.setCompletionText("multi\nline\ntext")
			state.acceptFirstLine()
			state.showPreview()

			// Reset
			state.reset()

			// Check all state is reset
			expect(state.currentPreview).toBe("")
			expect(state.firstLinePreview).toBe("")
			expect(state.remainingLinesPreview).toBe("")
			expect(state.hasAcceptedFirstLine).toBe(false)
			expect(state.isShowingPreview).toBe(false)
			expect(state.isLoading).toBe(false)
			// Note: activeCompletionId is NOT reset by reset()
		})
	})

	describe("clear", () => {
		it("should clear state but keep completion ID", () => {
			const completionId = "test-id"
			state.startCompletion(completionId)
			state.setCompletionText("some text")
			state.showPreview()

			state.clear()

			expect(state.activeCompletionId).toBe(completionId)
			expect(state.currentPreview).toBe("")
			expect(state.isShowingPreview).toBe(false)
		})
	})
})
