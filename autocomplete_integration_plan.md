# Autocomplete Integration Plan (Revised)

**Overall Goal:** To extract the core autocomplete functionality (generation and VS Code UI interaction) from the **`continue/`** repository, adapt it for your custom LLM providers, and integrate it into **our existing VS Code extension** by copying the relevant source files from `continue/`.

**High-Level Component Interaction (Conceptual):**

```mermaid
graph TD
    subgraph Our Existing VS Code Extension
        A[Your Custom LLM Providers (e.g., via `src/api/`)] --> B{"Adapted Core Autocomplete Logic (from `continue/core/`)"};
        B --> C{"VS Code Autocomplete Integration (from `continue/extensions/vscode/src/autocomplete/`)"};
        C --> D[VS Code Editor API];
        E{"Diff-based Suggestion UI (from `continue/extensions/vscode/src/suggestions.ts`)"} --> D;
        C --> E;
    end

    style A fill:#ccffcc,stroke:#333,stroke-width:2px
    style B fill:#cce5ff,stroke:#333,stroke-width:2px
    style C fill:#cce5ff,stroke:#333,stroke-width:2px
    style E fill:#cce5ff,stroke:#333,stroke-width:2px
```

- **Your Custom LLM Providers**: This refers to our existing LLM integration, likely managed via [`src/api/index.ts`](src/api/index.ts) and specific provider files (e.g., [`src/api/providers/ollama.ts`](src/api/providers/ollama.ts)).
- **Adapted Core Autocomplete Logic**: This will be based on [`continue/core/autocomplete/CompletionProvider.ts`](continue/core/autocomplete/CompletionProvider.ts), modified to use your LLM providers. This will be compared with and potentially augment/replace parts of our existing logic in [`src/services/autocomplete/PromptRenderer.ts`](src/services/autocomplete/PromptRenderer.ts) and [`src/services/autocomplete/ContextGatherer.ts`](src/services/autocomplete/ContextGatherer.ts).
- **VS Code Autocomplete Integration**: This will be based on [`continue/extensions/vscode/src/autocomplete/completionProvider.ts`](continue/extensions/vscode/src/autocomplete/completionProvider.ts), connecting the core logic to VS Code's `InlineCompletionItemProvider` API (or our decorator-based approach). This will be compared with our existing [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts), which already handles VS Code integration.
- **Suggestion UI Management**: [`continue/extensions/vscode/src/suggestions.ts`](continue/extensions/vscode/src/suggestions.ts) appears to manage a **diff-based suggestion UI** for larger code edits, rather than typical inline autocomplete previews. Its direct applicability to our inline preview goals needs careful evaluation. We will compare its concepts with our current decoration-based UI in [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts).

**Detailed Plan:**

**Phase 1: In-Depth Code Analysis and Dependency Mapping (within the `continue/` repo)**
This phase involves understanding the key files from `continue/` and their connections, and how they relate to our existing codebase.

1.  **Analyze Core Autocomplete Logic (from `continue/`):**
    - Read and understand [`continue/core/autocomplete/CompletionProvider.ts`](continue/core/autocomplete/CompletionProvider.ts). Focus on:
        - How it constructs prompts or prepares data for the LLM.
        - How it processes LLM responses to generate suggestions.
        - Its internal methods and data structures.
        - Its dependencies (other files in `continue/core/` or external npm packages).
        - Compare its approach with existing context gathering in [`src/services/autocomplete/ContextGatherer.ts`](src/services/autocomplete/ContextGatherer.ts) and prompt generation in [`src/services/autocomplete/PromptRenderer.ts`](src/services/autocomplete/PromptRenderer.ts).
2.  **Analyze VS Code Integration Layer (from `continue/`):**
    - Read and understand [`continue/extensions/vscode/src/autocomplete/completionProvider.ts`](continue/extensions/vscode/src/autocomplete/completionProvider.ts). Focus on:
        - How it instantiates and uses the core `CompletionProvider` from `continue/core/`.
        - How it implements the `vscode.InlineCompletionItemProvider` interface methods (e.g., `provideInlineCompletionItems`).
        - Its dependencies, including VS Code APIs and other local files within `continue/extensions/vscode/`.
        - Compare its VS Code API interactions with our [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts).
3.  **Analyze Suggestion UI Management (from `continue/`):**
    - Read and understand [`continue/extensions/vscode/src/suggestions.ts`](continue/extensions/vscode/src/suggestions.ts). Note: This file appears to implement a **diff-based suggestion UI**, distinct from typical inline autocomplete previews. Focus on:
        - How it renders diff-like suggestions in the editor using decorations.
        - How it handles commands for accepting, rejecting, or navigating these diff suggestions.
        - Its dependencies, particularly VS Code APIs.
        - Compare its UI management (diff-based) with our current inline decoration-based approach in [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts), and assess relevance for inline previews.
4.  **Identify Supporting Files & Initialization (from `continue/`):**
    - Investigate other files in `continue/extensions/vscode/src/autocomplete/` (e.g., `lsp.ts`, `recentlyEdited.ts`, `RecentlyVisitedRangesService.ts`, `statusBar.ts`) to determine their role and if they are essential for the autocomplete functionality you want to replicate.
    - Examine [`continue/extensions/vscode/src/extension.ts`](continue/extensions/vscode/src/extension.ts) to understand how the autocomplete services and commands are registered and initialized during extension activation.
    - Check if [`continue/extensions/vscode/src/VsCodeIde.ts`](continue/extensions/vscode/src/VsCodeIde.ts) is used by the autocomplete components for any essential IDE interactions.
5.  **Compile Lists:**
    - Create a definitive list of all TypeScript files to be copied from `continue/`.
    - List all external npm dependencies required by these files (check `package.json` files in `continue/`, `continue/core/`, and `continue/extensions/vscode/`). These will be merged into our existing extension's [`package.json`](package.json).

**Phase 2: Preparing Existing Extension for Integration**

1.  **Project Setup:**
    - Review `tsconfig.json` files within `continue/` (e.g., `continue/tsconfig.json`, `continue/core/tsconfig.json`, `continue/extensions/vscode/tsconfig.json`) and update our existing [`tsconfig.json`](tsconfig.json) if necessary to ensure compatibility with the copied code.
    - Update our existing [`package.json`](package.json) by adding necessary dependencies identified from `continue/`'s `package.json` files (see Phase 1.5).
    - Optionally, review linting (ESLint) and formatting (Prettier) configurations in the "Continue" project and align our existing setup if consistency is desired and beneficial.

**Phase 3: Code Integration and Adaptation**

1.  **Copy Files:**
    - Carefully copy the identified files from the `continue/` repository (Phase 1.5) into our existing extension's `src/` directory.
    - Consider placing copied 'core' logic into a subdirectory like `src/services/autocomplete/continue_core/` and 'vscode-integration' logic into `src/services/autocomplete/continue_vscode/`, or decide on how to merge/refactor it with existing files in [`src/services/autocomplete/`](src/services/autocomplete/).
2.  **Install Dependencies:**
    - After updating our existing [`package.json`](package.json), run `npm install` (or `yarn install`) to fetch the new dependencies.
3.  **Adapt and Modify:**
    - **Update Import Paths:** Systematically go through the copied files and update all `import` statements to reflect their new locations within our project and to correctly reference our existing modules.
    - **Integrate Custom LLM Providers:** This is a critical step. Modify the copied core autocomplete logic (likely originating from [`continue/core/autocomplete/CompletionProvider.ts`](continue/core/autocomplete/CompletionProvider.ts)) to call our custom LLM provider functions/classes instead of the original LLM interaction points. This will involve adapting its LLM interaction points to use our existing API handlers, likely through [`src/api/index.ts`](src/api/index.ts) and related provider implementations. Our current [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts) already initializes an `ApiHandler`.
    - **Register Components:** In our existing main activation file, [`src/extension.ts`](src/extension.ts), register the `InlineCompletionItemProvider` (or adapt our decorator-based provider). If the diff-based UI from `continue/extensions/vscode/src/suggestions.ts` is deemed relevant and adapted, or if parts of its command logic are reusable for inline previews, register related commands. This will involve adapting code found in the original [`continue/extensions/vscode/src/extension.ts`](continue/extensions/vscode/src/extension.ts) and needs to be reconciled with how [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts) is currently registered and initialized.
    - **Resolve Conflicts & Errors:** Address any TypeScript errors, runtime errors, or logical issues that arise from the copying and modification process. This will likely be an iterative process.

**Phase 4: Testing and Refinement**

1.  **Launch & Debug:** Run our extension in a VS Code Extension Development Host.
2.  **Test Autocomplete:** Thoroughly test the autocomplete functionality in various scenarios (different file types, different code contexts).
3.  **Verify LLM Integration:** Ensure our custom LLM providers are being called correctly and that their responses are processed as expected.
4.  **Iterate:** Debug any issues, refine the integration, and improve performance or behavior as needed.
