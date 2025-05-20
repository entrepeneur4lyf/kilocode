# Autocomplete Integration Plan (Revised for VS Code Focus and Core Functionality)

**Overall Goal:** To extract core autocomplete functionality (specifically suggestion generation, advanced context gathering, and essential VS Code UI interaction logic) from the **`continue/`** repository, adapt it for our custom LLM providers, and integrate it into **our existing VS Code extension**, primarily enhancing the components within [`src/services/autocomplete/`](src/services/autocomplete/). The focus is on improving the quality and relevance of inline autocomplete suggestions. Standalone predefined snippets and complex, non-inline UIs (like diff-based suggestions) are out of scope unless they provide essential, non-UI utility functions directly beneficial to inline autocompletion.

**High-Level Component Interaction (Conceptual):**

```mermaid
graph TD
    subgraph Our Existing VS Code Extension (Enhanced)
        A[Our Custom LLM Providers (e.g., via `src/api/`)] --> B_Updated{"Enhanced Core Autocomplete Logic (Our `ContextGatherer`, `PromptRenderer` in `src/services/autocomplete/` improved by `continue/core/` logic)"};
        B_Updated --> C_Updated{"Enhanced VS Code Autocomplete Integration (Our `AutocompleteProvider` in `src/services/autocomplete/` improved by `continue/extensions/vscode/src/autocomplete/` logic)"};
        C_Updated --> D[VS Code Editor API];
    end

    style A fill:#ccffcc,stroke:#333,stroke-width:2px
    style B_Updated fill:#cce5ff,stroke:#333,stroke-width:2px
    style C_Updated fill:#cce5ff,stroke:#333,stroke-width:2px
```

- **Our Custom LLM Providers**: This refers to our existing LLM integration, managed via [`src/api/index.ts`](src/api/index.ts:1) and specific provider files (e.g., [`src/api/providers/ollama.ts`](src/api/providers/ollama.ts)). This remains the source for LLM calls.
- **Enhanced Core Autocomplete Logic**: This involves integrating relevant parts of [`continue/core/autocomplete/CompletionProvider.ts`](continue/core/autocomplete/CompletionProvider.ts) and its supporting modules (e.g., `ContextRetrievalService`, `CompletionStreamer`, `postprocessing`, `templating`) into our existing [`src/services/autocomplete/ContextGatherer.ts`](src/services/autocomplete/ContextGatherer.ts:1) and [`src/services/autocomplete/PromptRenderer.ts`](src/services/autocomplete/PromptRenderer.ts:1). The aim is to leverage `continue/`'s more sophisticated context analysis, prompt strategies, and suggestion processing.
- **Enhanced VS Code Autocomplete Integration**: This involves integrating relevant VS Code-specific interaction logic from [`continue/extensions/vscode/src/autocomplete/completionProvider.ts`](continue/extensions/vscode/src/autocomplete/completionProvider.ts) and potentially [`continue/extensions/vscode/src/VsCodeIde.ts`](continue/extensions/vscode/src/VsCodeIde.ts) into our existing [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts:1). Our current provider already handles VS Code API interaction, preview rendering (decorator-based), command registration, and status bar items. The integration should focus on `continue/`'s logic for _triggering_, _processing_ completions, and handling specific VS Code contexts (e.g., untitled files, notebook cells) if it offers improvements, rather than overhauling the existing UI shell.
- **Suggestion UI Management (from `continue/` - Deprioritized):** [`continue/extensions/vscode/src/suggestions.ts`](continue/extensions/vscode/src/suggestions.ts) primarily manages a diff-based suggestion UI for larger code edits. This is **out of scope**. It will only be reviewed for minor, reusable, non-UI utility functions (e.g., text manipulation, range calculations) that could benefit our existing inline preview mechanism.

**Detailed Plan:**

**Phase 1: Focused Code Analysis and Dependency Mapping (Completed - Summary)**
This phase involved understanding the key files from `continue/` relevant to VS Code inline autocompletion.

1.  **Core Autocomplete Logic (`continue/core/autocomplete/CompletionProvider.ts` and related modules):**

    - **Context Gathering:** [`ContextRetrievalService.ts`](continue/core/autocomplete/context/ContextRetrievalService.ts) (uses `getAllSnippets` which depends on `getDefinitionsFromLsp` from [`lsp.ts`](continue/extensions/vscode/src/autocomplete/lsp.ts:1), `RecentlyEditedTracker` from [`recentlyEdited.ts`](continue/extensions/vscode/src/autocomplete/recentlyEdited.ts:1), and `RecentlyVisitedRangesService` from [`RecentlyVisitedRangesService.ts`](continue/extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts:1)).
    - **Prompt Templating:** [`renderPrompt`](continue/core/autocomplete/templating/index.ts:1) and related utilities.
    - **Suggestion Generation/Streaming:** [`CompletionStreamer.ts`](continue/core/autocomplete/generation/CompletionStreamer.ts).
    - **Post-processing:** [`postprocessCompletion`](continue/core/autocomplete/postprocessing/index.ts:1).
    - **Filtering/Debouncing:** [`AutocompleteDebouncer.ts`](continue/core/autocomplete/util/AutocompleteDebouncer.ts), [`shouldPrefilter`](continue/core/autocomplete/prefiltering/index.ts:1).
    - **Caching:** [`AutocompleteLruCache.ts`](continue/core/autocomplete/util/AutocompleteLruCache.ts).
    - **VS Code Specifics to Remove/Adapt:** Any multi-IDE abstractions or JetBrains-specific code.

2.  **VS Code Integration Layer (`continue/extensions/vscode/src/autocomplete/completionProvider.ts`):**

    - Wraps the core `CompletionProvider`.
    - Handles VS Code specific types and contexts (e.g., `vscode.TextDocument`, `vscode.Position`, notebook cells, untitled files).
    - Interacts with VS Code APIs for triggering, cancellation, and providing `InlineCompletionItem`s.
    - Uses `RecentlyEditedTracker` and `RecentlyVisitedRangesService`.

3.  **Supporting UI/Utility Code (`continue/extensions/vscode/src/suggestions.ts`):**

    - Primarily for diff-based UI, which is **out of scope**. Will only cherry-pick small, non-UI utility functions if any are found to be highly relevant and reusable for inline previews.

4.  **Essential Supporting Files & Initialization:**

    - **Context Enhancement:**
        - [`continue/extensions/vscode/src/autocomplete/lsp.ts`](continue/extensions/vscode/src/autocomplete/lsp.ts:1): Provides `getDefinitionsFromLsp` used by `ContextRetrievalService`. Its `executeGotoProvider` and AST traversal logic might offer improvements to our definition fetching.
        - [`continue/extensions/vscode/src/autocomplete/recentlyEdited.ts`](continue/extensions/vscode/src/autocomplete/recentlyEdited.ts:1): `RecentlyEditedTracker` class for context.
        - [`continue/extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts`](continue/extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts:1): `RecentlyVisitedRangesService` class for context.
    - **Status Bar:** [`continue/extensions/vscode/src/autocomplete/statusBar.ts`](continue/extensions/vscode/src/autocomplete/statusBar.ts:1). Our [`AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts:1) already manages a status bar. We will only integrate if `continue/` offers significant, non-duplicative improvements (e.g., more dynamic status updates based on battery or model errors).
    - **Extension Activation:** [`continue/extensions/vscode/src/extension/VsCodeExtension.ts`](continue/extensions/vscode/src/extension/VsCodeExtension.ts:1) (via `activate.ts`) shows how `ContinueCompletionProvider` is registered.
    - **IDE Abstraction:** [`continue/extensions/vscode/src/VsCodeIde.ts`](continue/extensions/vscode/src/VsCodeIde.ts:1) provides VS Code specific implementations for IDE interactions. We need to ensure our existing IDE interactions are sufficient or can be enhanced by specific methods from this class if used by the core autocomplete logic we integrate.

5.  **Compiled Lists (High-Level):**
    - **Files/Modules for Integration into [`src/services/autocomplete/`](src/services/autocomplete/):**
        - From `continue/core/autocomplete/`: Logic from `CompletionProvider.ts` (context gathering, prompt rendering, streaming, post-processing), `ContextRetrievalService.ts`, `CompletionStreamer.ts`, `postprocessing/index.ts`, `templating/index.ts`, `util/AutocompleteDebouncer.ts`, `util/AutocompleteLruCache.ts`.
        - From `continue/extensions/vscode/src/autocomplete/`: Logic from `completionProvider.ts` (VS Code specific adaptations), `lsp.ts` (for `getDefinitionsFromLsp`), `recentlyEdited.ts` (`RecentlyEditedTracker`), `RecentlyVisitedRangesService.ts`.
    - **Key NPM Dependencies to consider from `continue/core/package.json` and `continue/extensions/vscode/package.json` (selectively):**
        - `uri-js` (used in VS Code specific provider)
        - `uuid` (used for completion IDs)
        - `lru-cache` (if `AutocompleteLruCache` is adopted)
        - Potentially tree-sitter related packages if their AST utilities are superior and adopted: `web-tree-sitter`, `tree-sitter-wasms`.
        - (Review others like `axios`, `js-tiktoken`, `ignore` if their direct usage by integrated autocomplete logic becomes apparent and necessary).
        - _Avoid including the full list of dependencies; only add what's essential for the integrated autocomplete features._

**Phase 2: Preparing Existing Extension for Integration**

1.  **Project Setup:**
    - **`tsconfig.json` Review:**
        - Our [`tsconfig.json`](tsconfig.json:1) uses `"module": "commonjs"` and `"moduleResolution": "node"`.
        - [`continue/core/tsconfig.json`](continue/core/tsconfig.json:1) uses `"module": "ESNext"` and `"moduleResolution": "Bundler"`.
        - [`continue/extensions/vscode/tsconfig.json`](continue/extensions/vscode/tsconfig.json:1) uses `"module": "commonjs"`.
        - We will likely need to ensure our TypeScript setup can correctly resolve and transpile the ESNext modules from `continue/core/` if we integrate them directly. This might involve adjusting our `module` or `moduleResolution` settings or ensuring our build process handles this. Path aliases, if used by `continue/` and adopted, would also need configuration.
    - **`package.json` Update:**
        - Carefully add only the _necessary_ external npm dependencies identified in Phase 1.5 to our existing [`package.json`](package.json:1).
        - Run `npm install` (or equivalent).
    - **Linting/Formatting:** Align only if critical for compatibility or significantly beneficial. Our existing setup should be preferred.

**Phase 3: Code Integration and Adaptation into `src/services/autocomplete/`**

1.  **Strategic Integration into Existing Files:**

    - The primary approach is to **integrate selected logic directly into our existing files**:
        - Enhance [`src/services/autocomplete/ContextGatherer.ts`](src/services/autocomplete/ContextGatherer.ts:1) with:
            - `ContextRetrievalService` logic from [`continue/core/autocomplete/context/ContextRetrievalService.ts`](continue/core/autocomplete/context/ContextRetrievalService.ts).
            - Usage of `RecentlyEditedTracker` from [`continue/extensions/vscode/src/autocomplete/recentlyEdited.ts`](continue/extensions/vscode/src/autocomplete/recentlyEdited.ts:1).
            - Usage of `RecentlyVisitedRangesService` from [`continue/extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts`](continue/extensions/vscode/src/autocomplete/RecentlyVisitedRangesService.ts:1).
            - Potentially improved definition fetching using `getDefinitionsFromLsp` from [`continue/extensions/vscode/src/autocomplete/lsp.ts`](continue/extensions/vscode/src/autocomplete/lsp.ts:1).
        - Enhance [`src/services/autocomplete/PromptRenderer.ts`](src/services/autocomplete/PromptRenderer.ts:1) with:
            - Advanced prompt construction from [`continue/core/autocomplete/templating/index.ts`](continue/core/autocomplete/templating/index.ts:1) (e.g., `renderPrompt`).
        - Enhance [`src/services/autocomplete/AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts:1) with:
            - Improved completion triggering, streaming (from `CompletionStreamer.ts`), and processing logic (from `postprocessing/index.ts`) inspired by [`continue/core/autocomplete/CompletionProvider.ts`](continue/core/autocomplete/CompletionProvider.ts).
            - VS Code specific interaction patterns from [`continue/extensions/vscode/src/autocomplete/completionProvider.ts`](continue/extensions/vscode/src/autocomplete/completionProvider.ts) for robust handling of different document states/types and API interactions.
            - Debouncing from [`continue/core/autocomplete/util/AutocompleteDebouncer.ts`](continue/core/autocomplete/util/AutocompleteDebouncer.ts).
            - Caching via [`continue/core/autocomplete/util/AutocompleteLruCache.ts`](continue/core/autocomplete/util/AutocompleteLruCache.ts) if deemed beneficial over or complementary to our existing cache.
    - Temporary subdirectories (e.g., `src/services/autocomplete/temp_continue_integration/`) can be used for initial placement before refactoring and merging if it aids understanding.

2.  **Install Dependencies:** Run `npm install` after updating [`package.json`](package.json:1).

3.  **Adapt and Modify:**
    - **Update Import Paths:** Systematically update `import` statements.
    - **Integrate Custom LLM Providers:** Ensure the integrated logic uses our `ApiHandler` (from [`src/api/index.ts`](src/api/index.ts:1)) for LLM calls. The `_prepareLlm` method in `continue/core/autocomplete/CompletionProvider.ts` will need significant adaptation or replacement.
    - **Refactor and Merge Logic:** As detailed in Phase 3.1.
    - **Update Component Registration:** Our main activation file, [`src/extension.ts`](src/extension.ts:1), already registers [`AutocompleteProvider.ts`](src/services/autocomplete/AutocompleteProvider.ts:1). Ensure any new initialization steps for the enhanced provider are handled.
    - **Remove Redundancies:** Remove duplicated functionalities (e.g., basic status bar, debounce if ours is kept).
    - **Resolve Conflicts & Errors:** Iteratively address TypeScript errors, runtime issues, and logical conflicts.

**Phase 4: Testing and Refinement**

1.  **Launch & Debug:** Run our extension in a VS Code Extension Development Host.
2.  **Test Autocomplete:** Thoroughly test in various scenarios (different file types, code contexts, edge cases). Focus on suggestion quality, relevance, and timeliness.
3.  **Verify LLM Integration:** Ensure our custom LLM providers are correctly used.
4.  **Performance Testing:** Check for regressions, especially suggestion latency.
5.  **Iterate:** Debug, refine, and document changes within the code.

This revised plan focuses on targeted enhancements to our VS Code extension's autocomplete capabilities, leveraging specific, high-value components from `continue/` while respecting our existing architecture.
