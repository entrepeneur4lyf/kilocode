/**
 * Utility class for debouncing function calls
 */
export class Debouncer<T extends (...args: any[]) => any> {
	private timeout: NodeJS.Timeout | null = null
	private readonly delay: number
	private readonly callback: T

	constructor(callback: T, delay: number) {
		this.callback = callback
		this.delay = delay
	}

	/**
	 * Debounce the callback function
	 */
	debounce(...args: Parameters<T>): void {
		this.cancel()
		this.timeout = setTimeout(() => {
			this.callback(...args)
			this.timeout = null
		}, this.delay)
	}

	/**
	 * Cancel any pending debounced calls
	 */
	cancel(): void {
		if (this.timeout) {
			clearTimeout(this.timeout)
			this.timeout = null
		}
	}

	/**
	 * Update the delay time
	 */
	setDelay(delay: number): void {
		;(this as any).delay = delay
	}

	/**
	 * Check if there's a pending debounced call
	 */
	isPending(): boolean {
		return this.timeout !== null
	}

	/**
	 * Clean up resources
	 */
	dispose(): void {
		this.cancel()
	}
}
