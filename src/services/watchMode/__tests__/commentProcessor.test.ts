import * as vscode from "vscode"
import { AICommentData, CommentProcessorOptions } from "../types"
import { detectAIComments, buildAIPrompt, processAIResponse, applyAIResponseToDocument } from "../commentProcessor"

// Mock vscode namespace
// Mock vscode APIs
jest.mock("vscode", () => ({
	Position: jest.fn().mockImplementation((line: number, character: number) => ({ line, character })),
	Range: jest.fn().mockImplementation((start: any, end: any) => ({ start, end })),
	Uri: {
		file: jest.fn((path: string) => ({ fsPath: path, toString: () => `file://${path}` })),
		parse: jest.fn((uri: string) => ({ fsPath: uri.replace("file://", ""), toString: () => uri })),
	},
	WorkspaceEdit: jest.fn().mockImplementation(() => ({
		replace: jest.fn(),
	})),
	workspace: {
		applyEdit: jest.fn().mockResolvedValue(true),
	},
}))

describe("commentProcessor", () => {
	// Reset mocks before each test
	beforeEach(() => {
		jest.clearAllMocks()
	})

	describe("detectAIComments", () => {
		const mockFileUri = vscode.Uri.file("/path/to/testfile.js")

		it("should detect single-line AI comments", () => {
			const content = `
        // This is a regular comment
        const x = 5;
        // AI! Generate a function to calculate factorial
        const y = 10;
      `

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(1)
			expect(result.comments[0].content).toBe("Generate a function to calculate factorial")
			expect(result.errors).toBeUndefined()
		})

		it("should detect multi-line AI comments", () => {
			const content = `
        /* This is a regular comment */
        const x = 5;
        /* AI! Generate a 
           function to calculate 
           factorial */
        const y = 10;
      `

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(1)
			expect(result.comments[0].content).toBe(
				"Generate a \n           function to calculate \n           factorial",
			)
			expect(result.errors).toBeUndefined()
		})

		it("should detect JSDoc-style AI comments", () => {
			const content = `
        /** Regular JSDoc comment */
        function regularFunction() {}
        
        /** AI! Document this function thoroughly */
        function needsDocumentation(param1, param2) {
          return param1 + param2;
        }
      `

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(1)
			expect(result.comments[0].content).toBe("Document this function thoroughly")
			expect(result.errors).toBeUndefined()
		})

		it("should detect multiple AI comments in the same file", () => {
			const content = `
        // AI! Fix this logic
        if (x = 5) {
          console.log("Equal to 5");
        }
        
        /* AI! Convert to arrow function */
        function oldStyle() {
          return 42;
        }
        
        /** AI! Add type annotations */
        function untyped(param) {
          return param.value;
        }
      `

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(3)
			expect(result.comments[0].content).toBe("Fix this logic")
			expect(result.comments[1].content).toBe("Convert to arrow function")
			expect(result.comments[2].content).toBe("Add type annotations")
			expect(result.errors).toBeUndefined()
		})

		it("should handle empty files", () => {
			const content = ""

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(0)
			expect(result.errors).toBeUndefined()
		})

		it("should handle files with no AI comments", () => {
			const content = `
        // This is a regular comment
        const x = 5;
        /* Another regular comment */
        const y = 10;
        /** JSDoc comment */
        function noAI() {}
      `

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(0)
			expect(result.errors).toBeUndefined()
		})

		it("should include code context for each comment", () => {
			const content = `
        const a = 1;
        const b = 2;
        
        // AI! Refactor this function
        function needsRefactoring() {
          let result = 0;
          for (let i = 0; i < 10; i++) {
            result += i;
          }
          return result;
        }
        
        const c = 3;
      `

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(1)
			expect(result.comments[0].context).toContain("function needsRefactoring")
			// The context should include surrounding lines
			expect(result.comments[0].context).toContain("const b = 2")
			// expect(result.comments[0].context).toContain("const c = 3")
		})

		it("should handle errors gracefully", () => {
			// Mock implementation that throws an error
			const originalExec = RegExp.prototype.exec
			// @ts-ignore - we need to override this for the test
			RegExp.prototype.exec = jest.fn().mockImplementation(() => {
				throw new Error("Regex error")
			})

			const content = "// AI! This should trigger an error"

			const options: CommentProcessorOptions = {
				fileUri: mockFileUri,
				content,
				languageId: "javascript",
			}

			const result = detectAIComments(options)

			expect(result.comments.length).toBe(0)
			expect(result.errors?.length).toBe(1)
			expect(result.errors?.[0].message).toBe("Regex error")

			// Restore original exec
			RegExp.prototype.exec = originalExec
		})
	})

	describe("buildAIPrompt", () => {
		it("should build a prompt with comment content and context", () => {
			const commentData: AICommentData = {
				content: "Refactor this function to use map",
				startPos: new vscode.Position(3, 8),
				endPos: new vscode.Position(3, 45),
				context: `function oldWay(arr) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    result.push(arr[i] * 2);
  }
  return result;
}`,
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const prompt = buildAIPrompt(commentData)

			expect(prompt).toContain("# AI Comment Instruction")
			expect(prompt).toContain("Refactor this function to use map")
			expect(prompt).toContain("# Code Context")
			expect(prompt).toContain("function oldWay(arr)")
			expect(prompt).toContain("```")
		})

		it("should handle comments without context", () => {
			const commentData: AICommentData = {
				content: "Generate a utility function",
				startPos: new vscode.Position(1, 0),
				endPos: new vscode.Position(1, 30),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const prompt = buildAIPrompt(commentData)

			expect(prompt).toContain("# AI Comment Instruction")
			expect(prompt).toContain("Generate a utility function")
			expect(prompt).toContain("# Code Context")
			expect(prompt).toContain("No context available")
		})
	})

	describe("processAIResponse", () => {
		it("should extract code blocks from response", async () => {
			const commentData: AICommentData = {
				content: "Refactor this function",
				startPos: new vscode.Position(3, 0),
				endPos: new vscode.Position(3, 23),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const response = `
I've refactored the function to use map:

\`\`\`javascript
function newWay(arr) {
  return arr.map(item => item * 2);
}
\`\`\`

This is much cleaner and uses functional programming principles.
      `

			const result = await processAIResponse({ commentData, response })

			expect(result).toBe("function newWay(arr) {\n  return arr.map(item => item * 2);\n}")
		})

		it("should extract multiple code blocks", async () => {
			const commentData: AICommentData = {
				content: "Show examples",
				startPos: new vscode.Position(1, 0),
				endPos: new vscode.Position(1, 13),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const response = `
Here are two examples:

\`\`\`javascript
// Example 1
function example1() {
  return 'Hello';
}
\`\`\`

And another approach:

\`\`\`javascript
// Example 2
function example2() {
  return 'World';
}
\`\`\`
      `

			const result = await processAIResponse({ commentData, response })

			expect(result).toContain("// Example 1")
			expect(result).toContain("// Example 2")
			expect(result).toContain("function example1()")
			expect(result).toContain("function example2()")
		})

		it("should return the full response when no code blocks are found", async () => {
			const commentData: AICommentData = {
				content: "Explain this pattern",
				startPos: new vscode.Position(1, 0),
				endPos: new vscode.Position(1, 20),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const response =
				"This pattern is an implementation of the Singleton design pattern, which ensures that a class has only one instance throughout the application."

			const result = await processAIResponse({ commentData, response })

			expect(result).toBe(response)
		})

		it("should handle empty responses", async () => {
			const commentData: AICommentData = {
				content: "Fix this",
				startPos: new vscode.Position(1, 0),
				endPos: new vscode.Position(1, 9),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const response = ""

			const result = await processAIResponse({ commentData, response })

			expect(result).toBe("")
		})
	})

	describe("applyAIResponseToDocument", () => {
		it("should apply the processed response to the document", async () => {
			const mockDocument = {
				uri: vscode.Uri.file("/path/to/file.js"),
			}

			const commentData: AICommentData = {
				content: "Refactor this",
				startPos: new vscode.Position(3, 0),
				endPos: new vscode.Position(3, 14),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const processedResponse = "const newFunction = () => 42;"

			const result = await applyAIResponseToDocument(
				mockDocument as unknown as vscode.TextDocument,
				commentData,
				processedResponse,
			)

			expect(result).toBe(true)
			expect(vscode.WorkspaceEdit).toHaveBeenCalled()

			const edit = (vscode.WorkspaceEdit as jest.Mock<any>).mock.results[0].value
			expect(edit.replace).toHaveBeenCalledWith(
				mockDocument.uri,
				expect.objectContaining({
					start: commentData.startPos,
					end: commentData.endPos,
				}),
				processedResponse,
			)
			expect(vscode.workspace.applyEdit).toHaveBeenCalledWith(edit)
		})

		it("should handle errors during edit application", async () => {
			// Mock applyEdit to fail
			;(vscode.workspace.applyEdit as jest.Mock<any>).mockResolvedValueOnce(false)

			const mockDocument = {
				uri: vscode.Uri.file("/path/to/file.js"),
			}

			const commentData: AICommentData = {
				content: "Refactor this",
				startPos: new vscode.Position(3, 0),
				endPos: new vscode.Position(3, 14),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const processedResponse = "const newFunction = () => 42;"

			const result = await applyAIResponseToDocument(
				mockDocument as unknown as vscode.TextDocument,
				commentData,
				processedResponse,
			)

			expect(result).toBe(false)
		})

		it("should handle exceptions during edit creation", async () => {
			// Mock WorkspaceEdit to throw
			const originalConsoleError = console.error
			// @ts-ignore - we need to override this for the test
			console.error = jest.fn()
			;(vscode.WorkspaceEdit as jest.Mock<any>).mockImplementationOnce(() => {
				throw new Error("Edit creation failed")
			})

			const mockDocument = {
				uri: vscode.Uri.file("/path/to/file.js"),
			}

			const commentData: AICommentData = {
				content: "Refactor this",
				startPos: new vscode.Position(3, 0),
				endPos: new vscode.Position(3, 14),
				fileUri: vscode.Uri.file("/path/to/file.js"),
			}

			const processedResponse = "const newFunction = () => 42;"

			const result = await applyAIResponseToDocument(
				mockDocument as unknown as vscode.TextDocument,
				commentData,
				processedResponse,
			)

			expect(result).toBe(false)
			expect(console.error).toHaveBeenCalled()

			// Restore console.error
			console.error = originalConsoleError
		})
	})
})
