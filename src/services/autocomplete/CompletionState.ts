/**
 * Manages the state of autocomplete completions
 */
export class CompletionState {
	// Current completion data
	private _currentPreview: string = ""
	private _firstLinePreview: string = ""
	private _remainingLinesPreview: string = ""
	private _hasAcceptedFirstLine: boolean = false
	private _isShowingPreview: boolean = false
	private _isLoading: boolean = false
	private _activeCompletionId: string | null = null

	// Getters
	get currentPreview(): string {
		return this._currentPreview
	}

	get firstLinePreview(): string {
		return this._firstLinePreview
	}

	get remainingLinesPreview(): string {
		return this._remainingLinesPreview
	}

	get hasAcceptedFirstLine(): boolean {
		return this._hasAcceptedFirstLine
	}

	get isShowingPreview(): boolean {
		return this._isShowingPreview
	}

	get isLoading(): boolean {
		return this._isLoading
	}

	get activeCompletionId(): string | null {
		return this._activeCompletionId
	}

	/**
	 * Start a new completion
	 */
	startCompletion(completionId: string): void {
		this.reset()
		this._activeCompletionId = completionId
		this._isLoading = true
	}

	/**
	 * Set the completion text and split it into first line and remaining lines
	 */
	setCompletionText(text: string): void {
		this._currentPreview = text
		const lines = text.split("\n")

		if (lines.length > 1) {
			this._firstLinePreview = lines[0]
			this._remainingLinesPreview = lines.slice(1).join("\n")
		} else {
			this._firstLinePreview = text
			this._remainingLinesPreview = ""
		}
	}

	/**
	 * Update the preview state
	 */
	updatePreview(firstLine: string, remainingLines: string): void {
		this._firstLinePreview = firstLine
		this._remainingLinesPreview = remainingLines
	}

	/**
	 * Mark the first line as accepted
	 */
	acceptFirstLine(): void {
		this._hasAcceptedFirstLine = true
	}

	/**
	 * Show the preview
	 */
	showPreview(): void {
		this._isShowingPreview = true
		this._isLoading = false
	}

	/**
	 * Hide the preview
	 */
	hidePreview(): void {
		this._isShowingPreview = false
	}

	/**
	 * Stop loading
	 */
	stopLoading(): void {
		this._isLoading = false
	}

	/**
	 * Check if this completion is still active
	 */
	isCompletionActive(completionId: string): boolean {
		return this._activeCompletionId === completionId
	}

	/**
	 * Cancel the current completion
	 */
	cancelCompletion(): void {
		this._activeCompletionId = null
		this.reset()
	}

	/**
	 * Reset all state
	 */
	reset(): void {
		this._currentPreview = ""
		this._firstLinePreview = ""
		this._remainingLinesPreview = ""
		this._hasAcceptedFirstLine = false
		this._isShowingPreview = false
		this._isLoading = false
	}

	/**
	 * Clear the state but keep the completion ID
	 */
	clear(): void {
		const completionId = this._activeCompletionId
		this.reset()
		this._activeCompletionId = completionId
	}
}
