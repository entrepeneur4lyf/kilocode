import * as vscode from "vscode"
import { findDiffs, UnifiedDiffHandler, hunkToBeforeAfter, applyHunk } from "../commentProcessor"

// Mock VSCode
jest.mock("vscode", () => ({
	Position: jest.fn().mockImplementation((line, character) => ({ line, character })),
	Range: jest.fn().mockImplementation((start, end) => ({ start, end })),
	Uri: {
		file: jest.fn((path) => ({ fsPath: path, toString: () => path })),
	},
	workspace: {
		asRelativePath: jest.fn((uri) => (typeof uri === "string" ? uri : uri.fsPath || uri.toString())),
	},
}))

describe("commentProcessor diff handling", () => {
	describe("findDiffs", () => {
		it("extracts diffs from code blocks", () => {
			const response = `
Here's how I would refactor this function:

\`\`\`diff
--- src/utils.js
+++ src/utils.js
@@ -10,7 +10,7 @@
 function calculateTotal(items) {
-  let total = 0;
-  for (const item of items) {
-    total += item;
-  }
-  return total;
+  // Use reduce for cleaner code
+  return items.reduce((total, item) => {
+    return total + item;
+  }, 0);
 }
\`\`\`

This refactoring uses Array.reduce() for a more functional approach.
`

			const edits = findDiffs(response)

			expect(edits.length).toBe(1)
			expect(edits[0].path).toBe("src/utils.js")
			expect(edits[0].hunk.length).toBeGreaterThan(0)
			expect(edits[0].hunk.some((line) => line.startsWith("+"))).toBe(true)
			expect(edits[0].hunk.some((line) => line.startsWith("-"))).toBe(true)
		})

		it("extracts diffs without code blocks", () => {
			const response = `
Here's the change:

--- src/utils.js
+++ src/utils.js
@@ -10,7 +10,7 @@
 function calculateTotal(items) {
-  let total = 0;
-  for (const item of items) {
-    total += item;
-  }
-  return total;
+  // Use reduce for cleaner code
+  return items.reduce((total, item) => {
+    return total + item;
+  }, 0);
 }

This makes the code more concise.
`

			const edits = findDiffs(response)

			expect(edits.length).toBe(1)
			expect(edits[0].path).toBe("src/utils.js")
			expect(edits[0].hunk.length).toBeGreaterThan(0)
		})

		it("handles multiple hunks in a single diff", () => {
			const response = `
\`\`\`diff
--- src/utils.js
+++ src/utils.js
@@ -10,7 +10,7 @@
 function calculateTotal(items) {
-  let total = 0;
+  let sum = 0;
 
@@ -15,5 +15,5 @@
   for (const item of items) {
-    total += item;
+    sum += item;
   }
-  return total;
+  return sum;
 }
\`\`\`
`

			const edits = findDiffs(response)

			// Our implementation treats each hunk as a separate edit (which is good for flexibility)
			expect(edits.length).toBe(2)
			expect(edits[0].path).toBe("src/utils.js")
			expect(edits[1].path).toBe("src/utils.js")

			// Check that we've detected all the lines properly
			const allHunkLines = edits.flatMap((edit) => edit.hunk)
			const minusCount = allHunkLines.filter((line) => line.startsWith("-")).length
			const plusCount = allHunkLines.filter((line) => line.startsWith("+")).length
			expect(minusCount).toBe(3)
			expect(plusCount).toBe(3)
		})
	})

	describe("hunkToBeforeAfter", () => {
		it("converts hunks to before and after text", () => {
			const hunk = [
				" function sum(a, b) {\n",
				"-  return a + b;\n",
				"+  // Add two numbers\n",
				"+  return a + b;\n",
				" }\n",
			]

			const [before, after] = hunkToBeforeAfter(hunk)

			expect(before).toBe("function sum(a, b) {\n  return a + b;\n}\n")
			expect(after).toBe("function sum(a, b) {\n  // Add two numbers\n  return a + b;\n}\n")
		})

		it("converts hunks to before and after lines when asLines is true", () => {
			const hunk = [
				" function sum(a, b) {\n",
				"-  return a + b;\n",
				"+  // Add two numbers\n",
				"+  return a + b;\n",
				" }\n",
			]

			const [before, after] = hunkToBeforeAfter(hunk, true) as [string[], string[]]

			expect(before).toEqual(["function sum(a, b) {\n", "  return a + b;\n", "}\n"])

			expect(after).toEqual(["function sum(a, b) {\n", "  // Add two numbers\n", "  return a + b;\n", "}\n"])
		})
	})

	describe("applyHunk", () => {
		it("applies a simple hunk to content", () => {
			const content = "function sum(a, b) {\n  return a + b;\n}\n"

			const hunk = [
				" function sum(a, b) {\n",
				"-  return a + b;\n",
				"+  // Add two numbers\n",
				"+  return a + b;\n",
				" }\n",
			]

			const result = applyHunk(content, hunk)

			expect(result).toBe("function sum(a, b) {\n  // Add two numbers\n  return a + b;\n}\n")
		})

		it("applies a hunk with partial context", () => {
			const content =
				"function sum(a, b) {\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n"

			const hunk = [
				" function sum(a, b) {\n",
				"-  return a + b;\n",
				"+  // Add two numbers\n",
				"+  return a + b;\n",
				" }\n",
			]

			const result = applyHunk(content, hunk)

			expect(result).toBe(
				"function sum(a, b) {\n  // Add two numbers\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n",
			)
		})
	})

	describe("UnifiedDiffHandler", () => {
		it("extracts and applies edits from responses", () => {
			const response = `
\`\`\`diff
--- src/utils.js
+++ src/utils.js
@@ -10,7 +10,7 @@
 function calculateTotal(items) {
-  let total = 0;
-  for (const item of items) {
-    total += item;
-  }
-  return total;
+  // Use reduce for cleaner code
+  return items.reduce((total, item) => {
+    return total + item;
+  }, 0);
 }
\`\`\`
`
			const originalContent = `function calculateTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item;
  }
  return total;
}
`
			const expectedContent = `function calculateTotal(items) {
  // Use reduce for cleaner code
  return items.reduce((total, item) => {
    return total + item;
  }, 0);
}
`

			const handler = new UnifiedDiffHandler()
			const edits = handler.getEdits(response)

			expect(edits.length).toBe(1)

			const [newContent, errors] = handler.applyEdits(edits, originalContent, vscode.Uri.file("src/utils.js"))

			expect(errors.length).toBe(0)
			expect(newContent).toBe(expectedContent)
		})
	})
})