// PLANREF: continue/core/autocomplete/util/AutocompleteDebouncer.ts
import { v4 as uuidv4 } from "uuid"

export class AutocompleteDebouncer {
	private debounceTimeout: NodeJS.Timeout | undefined = undefined
	private currentRequestId: string | undefined = undefined

	/**
	 * Delays execution and determines if the current request should be debounced.
	 * @param debounceDelay The delay in milliseconds.
	 * @returns A promise that resolves to true if the request should be debounced, false otherwise.
	 */
	async delayAndShouldDebounce(debounceDelay: number): Promise<boolean> {
		// AIDIFF: Adapted from continue/core/autocomplete/util/AutocompleteDebouncer.ts
		// Generate a unique ID for this request
		const requestId = uuidv4()
		this.currentRequestId = requestId

		// Clear any existing timeout
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout)
		}

		// Create a new promise that resolves after the debounce delay
		return new Promise<boolean>((resolve) => {
			this.debounceTimeout = setTimeout(() => {
				// When the timeout completes, check if this is still the most recent request
				const shouldDebounce = this.currentRequestId !== requestId

				// If this is the most recent request, it shouldn't be debounced
				if (!shouldDebounce) {
					this.currentRequestId = undefined
				}

				resolve(shouldDebounce)
			}, debounceDelay)
		})
	}

	/**
	 * Clears any pending debounce timeout.
	 */
	clear(): void {
		if (this.debounceTimeout) {
			clearTimeout(this.debounceTimeout)
			this.debounceTimeout = undefined
		}
		this.currentRequestId = undefined
	}
}
