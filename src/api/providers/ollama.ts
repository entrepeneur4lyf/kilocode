import { Anthropic } from "@anthropic-ai/sdk"
import OpenAI from "openai"
import axios from "axios"

import { SingleCompletionHandler, CompletionStreamParams } from "../index" // AIDIFF: Import CompletionStreamParams
import { ApiHandlerOptions, ModelInfo, openAiModelInfoSaneDefaults } from "../../shared/api"
import { convertToOpenAiMessages } from "../transform/openai-format"
import { convertToR1Format } from "../transform/r1-format"
import { ApiStream } from "../transform/stream"
import { DEEP_SEEK_DEFAULT_TEMPERATURE } from "./constants"
import { XmlMatcher } from "../../utils/xml-matcher"
import { BaseProvider } from "./base-provider"

export class OllamaHandler extends BaseProvider implements SingleCompletionHandler {
	protected options: ApiHandlerOptions
	private client: OpenAI

	constructor(options: ApiHandlerOptions) {
		super()
		this.options = options
		this.client = new OpenAI({
			baseURL: (this.options.ollamaBaseUrl || "http://localhost:11434") + "/v1",
			apiKey: "ollama",
		})
	}

	override async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
		const modelId = this.getModel().id
		const useR1Format = modelId.toLowerCase().includes("deepseek-r1")
		const openAiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
			{ role: "system", content: systemPrompt },
			...(useR1Format ? convertToR1Format(messages) : convertToOpenAiMessages(messages)),
		]

		const stream = await this.client.chat.completions.create({
			model: this.getModel().id,
			messages: openAiMessages,
			temperature: this.options.modelTemperature ?? 0,
			stream: true,
		})
		const matcher = new XmlMatcher(
			"think",
			(chunk) =>
				({
					type: chunk.matched ? "reasoning" : "text",
					text: chunk.data,
				}) as const,
		)
		for await (const chunk of stream) {
			const delta = chunk.choices[0]?.delta

			if (delta?.content) {
				for (const chunk of matcher.update(delta.content)) {
					yield chunk
				}
			}
		}
		for (const chunk of matcher.final()) {
			yield chunk
		}
	}

	// AIDIFF: Implement getCompletionStream for AutocompleteProvider
	async *getCompletionStream(params: CompletionStreamParams, abortSignal: AbortSignal): ApiStream {
		// Ollama's OpenAI-compatible endpoint for completions might expect a messages array
		// even for "completions" like API. If it supports a raw prompt, this can be simplified.
		// For now, wrapping the prompt as a user message.
		// Alternatively, if Ollama /v1/completions is preferred, the client setup or call needs adjustment.
		// Assuming this.client.chat.completions.create is the intended path for now.
		// If a dedicated /v1/completions endpoint is better, this.client.completions.create should be used.
		// Let's try with `this.client.completions.create` which is more standard for raw prompts.

		const requestOptions: OpenAI.CompletionCreateParamsStreaming = {
			model: params.modelId, // Use modelId from params
			prompt: params.prompt,
			temperature: params.temperature ?? this.options.modelTemperature ?? 0.1, // Default to 0.1 if not set
			stream: true,
			stop: params.stop,
			// Ollama might not support systemPrompt directly in /v1/completions.
			// If params.systemPrompt is provided and needs to be used,
			// the prompt itself might need to be formatted to include it,
			// or switch to chat.completions if that's more appropriate for Ollama.
		}

		// Pass the abortSignal to the OpenAI client call
		const stream = await this.client.completions.create(requestOptions, { signal: abortSignal })

		for await (const chunk of stream) {
			if (abortSignal.aborted) {
				// AIDIFF: Corrected property name to 'aborted'
				break
			}
			const text = chunk.choices[0]?.text
			if (text) {
				yield { type: "text", text }
			}
		}
	}

	override getModel(): { id: string; info: ModelInfo } {
		return {
			id: this.options.ollamaModelId || "",
			info: openAiModelInfoSaneDefaults,
		}
	}

	async completePrompt(prompt: string): Promise<string> {
		try {
			const modelId = this.getModel().id
			const useR1Format = modelId.toLowerCase().includes("deepseek-r1")
			const response = await this.client.chat.completions.create({
				model: this.getModel().id,
				messages: useR1Format
					? convertToR1Format([{ role: "user", content: prompt }])
					: [{ role: "user", content: prompt }],
				temperature: this.options.modelTemperature ?? (useR1Format ? DEEP_SEEK_DEFAULT_TEMPERATURE : 0),
				stream: false,
			})
			return response.choices[0]?.message.content || ""
		} catch (error) {
			if (error instanceof Error) {
				throw new Error(`Ollama completion error: ${error.message}`)
			}
			throw error
		}
	}
}

export async function getOllamaModels(baseUrl = "http://localhost:11434") {
	try {
		if (!URL.canParse(baseUrl)) {
			return []
		}

		const response = await axios.get(`${baseUrl}/api/tags`)
		const modelsArray = response.data?.models?.map((model: any) => model.name) || []
		return [...new Set<string>(modelsArray)]
	} catch (error) {
		return []
	}
}
