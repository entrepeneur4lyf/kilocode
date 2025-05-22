import { Debouncer } from "../Debouncer"

describe("Debouncer", () => {
	jest.useFakeTimers()

	afterEach(() => {
		jest.clearAllTimers()
	})

	it("should debounce function calls", () => {
		const mockFn = jest.fn()
		const debouncer = new Debouncer(mockFn, 100)

		// Call multiple times rapidly
		debouncer.debounce("call1")
		debouncer.debounce("call2")
		debouncer.debounce("call3")

		// Function should not be called yet
		expect(mockFn).not.toHaveBeenCalled()

		// Fast forward time
		jest.advanceTimersByTime(100)

		// Function should be called once with the last arguments
		expect(mockFn).toHaveBeenCalledTimes(1)
		expect(mockFn).toHaveBeenCalledWith("call3")
	})

	it("should cancel pending calls", () => {
		const mockFn = jest.fn()
		const debouncer = new Debouncer(mockFn, 100)

		debouncer.debounce("test")
		expect(debouncer.isPending()).toBe(true)

		debouncer.cancel()
		expect(debouncer.isPending()).toBe(false)

		jest.advanceTimersByTime(100)
		expect(mockFn).not.toHaveBeenCalled()
	})

	it("should update delay time", () => {
		const mockFn = jest.fn()
		const debouncer = new Debouncer(mockFn, 100)

		// Update delay
		debouncer.setDelay(200)

		debouncer.debounce("test")

		// Advance by original delay
		jest.advanceTimersByTime(100)
		expect(mockFn).not.toHaveBeenCalled()

		// Advance to new delay
		jest.advanceTimersByTime(100)
		expect(mockFn).toHaveBeenCalledTimes(1)
	})

	it("should handle multiple arguments", () => {
		const mockFn = jest.fn()
		const debouncer = new Debouncer(mockFn, 100)

		debouncer.debounce("arg1", "arg2", { key: "value" })

		jest.advanceTimersByTime(100)

		expect(mockFn).toHaveBeenCalledWith("arg1", "arg2", { key: "value" })
	})

	it("should dispose properly", () => {
		const mockFn = jest.fn()
		const debouncer = new Debouncer(mockFn, 100)

		debouncer.debounce("test")
		debouncer.dispose()

		jest.advanceTimersByTime(100)
		expect(mockFn).not.toHaveBeenCalled()
		expect(debouncer.isPending()).toBe(false)
	})
})
