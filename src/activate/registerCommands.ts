import * as vscode from "vscode"
import delay from "delay"

import { ClineProvider } from "../core/webview/ClineProvider"
import { t } from "../i18n" // kilocode_change
import { importSettings, exportSettings } from "../core/config/importExport" // kilocode_change
import { ContextProxy } from "../core/config/ContextProxy"
import { WatchModeService } from "../services/watchMode"

import { registerHumanRelayCallback, unregisterHumanRelayCallback, handleHumanRelayResponse } from "./humanRelay"
import { handleNewTask } from "./handleTask"

/**
 * Helper to get the visible ClineProvider instance or log if not found.
 */
export function getVisibleProviderOrLog(outputChannel: vscode.OutputChannel): ClineProvider | undefined {
	const visibleProvider = ClineProvider.getVisibleInstance()
	if (!visibleProvider) {
		outputChannel.appendLine("Cannot find any visible Kilo Code instances.")
		return undefined
	}
	return visibleProvider
}

// Store panel references in both modes
let sidebarPanel: vscode.WebviewView | undefined = undefined
let tabPanel: vscode.WebviewPanel | undefined = undefined

/**
 * Get the currently active panel
 * @returns WebviewPanel或WebviewView
 */
export function getPanel(): vscode.WebviewPanel | vscode.WebviewView | undefined {
	return tabPanel || sidebarPanel
}

/**
 * Set panel references
 */
export function setPanel(
	newPanel: vscode.WebviewPanel | vscode.WebviewView | undefined,
	type: "sidebar" | "tab",
): void {
	if (type === "sidebar") {
		sidebarPanel = newPanel as vscode.WebviewView
		tabPanel = undefined
	} else {
		tabPanel = newPanel as vscode.WebviewPanel
		sidebarPanel = undefined
	}
}

export type RegisterCommandOptions = {
	context: vscode.ExtensionContext
	outputChannel: vscode.OutputChannel
	provider: ClineProvider
	watchModeService?: WatchModeService
}

export const registerCommands = (options: RegisterCommandOptions) => {
	const { context } = options

	for (const [command, callback] of Object.entries(getCommandsMap(options))) {
		context.subscriptions.push(vscode.commands.registerCommand(command, callback))
	}
}

const getCommandsMap = ({ context, outputChannel, watchModeService }: RegisterCommandOptions) => {
	return {
		"kilo-code.activationCompleted": () => {},
		"kilo-code.plusButtonClicked": async () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				return
			}

			await visibleProvider.removeClineFromStack()
			await visibleProvider.postStateToWebview()
			await visibleProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		},
		"kilo-code.promptsButtonClicked": () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				return
			}

			visibleProvider.postMessageToWebview({ type: "action", action: "promptsButtonClicked" })
		},
		"kilo-code.popoutButtonClicked": () => openClineInNewTab({ context, outputChannel }),
		"kilo-code.openInNewTab": () => openClineInNewTab({ context, outputChannel }),
		"kilo-code.settingsButtonClicked": () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				return
			}

			visibleProvider.postMessageToWebview({ type: "action", action: "settingsButtonClicked" })
			// Also explicitly post the visibility message to trigger scroll reliably
			visibleProvider.postMessageToWebview({ type: "action", action: "didBecomeVisible" })
		},
		"kilo-code.historyButtonClicked": () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				return
			}

			visibleProvider.postMessageToWebview({ type: "action", action: "historyButtonClicked" })
		},
		// kilocode_change begin
		"kilo-code.profileButtonClicked": () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				return
			}

			visibleProvider.postMessageToWebview({ type: "action", action: "profileButtonClicked" })
		},
		// kilocode_change end
		"kilo-code.helpButtonClicked": () => {
			vscode.env.openExternal(vscode.Uri.parse("https://kilocode.ai"))
		},
		"kilo-code.showHumanRelayDialog": (params: { requestId: string; promptText: string }) => {
			const panel = getPanel()

			if (panel) {
				panel?.webview.postMessage({
					type: "showHumanRelayDialog",
					requestId: params.requestId,
					promptText: params.promptText,
				})
			}
		},
		"kilo-code.registerHumanRelayCallback": registerHumanRelayCallback,
		"kilo-code.unregisterHumanRelayCallback": unregisterHumanRelayCallback,
		"kilo-code.handleHumanRelayResponse": handleHumanRelayResponse,
		"kilo-code.newTask": handleNewTask,
		"kilo-code.setCustomStoragePath": async () => {
			const { promptForCustomStoragePath } = await import("../shared/storagePathManager")
			await promptForCustomStoragePath()
		},
		// kilocode_change begin
		"kilo-code.focusChatInput": async () => {
			try {
				await vscode.commands.executeCommand("kilo-code.SidebarProvider.focus")
				await delay(100)

				let visibleProvider = getVisibleProviderOrLog(outputChannel)

				if (!visibleProvider) {
					// If still no visible provider, try opening in a new tab
					const tabProvider = await openClineInNewTab({ context, outputChannel })
					await delay(100)
					visibleProvider = tabProvider
				}

				visibleProvider?.postMessageToWebview({
					type: "action",
					action: "focusChatInput",
				})
			} catch (error) {
				outputChannel.appendLine(`Error in focusChatInput: ${error}`)
			}
		},
		// kilocode_change end
		"kilo-code.acceptInput": () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)

			if (!visibleProvider) {
				return
			}

			visibleProvider.postMessageToWebview({ type: "acceptInput" })
		},
		// kilocode_change start
		"kilo-code.importSettings": async () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)
			if (!visibleProvider) return

			const { success } = await importSettings({
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
				customModesManager: visibleProvider.customModesManager,
			})

			if (success) {
				visibleProvider.settingsImportedAt = Date.now()
				await visibleProvider.postStateToWebview()
				await vscode.window.showInformationMessage(t("kilocode:info.settings_imported"))
			}
		},
		"kilo-code.exportSettings": async () => {
			const visibleProvider = getVisibleProviderOrLog(outputChannel)
			if (!visibleProvider) return

			await exportSettings({
				providerSettingsManager: visibleProvider.providerSettingsManager,
				contextProxy: visibleProvider.contextProxy,
			})
		},
		// kilocode_change end

		// Watch Mode commands
		"kilo-code.watchMode.enable": () => {
			if (!watchModeService) {
				outputChannel.appendLine("Watch Mode service not initialized")
				vscode.window.showErrorMessage("Watch Mode service not initialized")
				return
			}

			const success = watchModeService.enable()
			if (success) {
				vscode.window.showInformationMessage("Watch Mode enabled")
			} else {
				vscode.window.showInformationMessage("Watch Mode could not be enabled. Is the experiment enabled?")
			}
		},
		"kilo-code.watchMode.disable": () => {
			if (!watchModeService) {
				outputChannel.appendLine("Watch Mode service not initialized")
				return
			}

			watchModeService.disable()
			vscode.window.showInformationMessage("Watch Mode disabled")
		},
		"kilo-code.watchMode.toggle": () => {
			if (!watchModeService) {
				outputChannel.appendLine("Watch Mode service not initialized")
				vscode.window.showErrorMessage("Watch Mode service not initialized")
				return
			}

			const isActive = watchModeService.toggle()
			vscode.window.showInformationMessage(`Watch Mode ${isActive ? "enabled" : "disabled"}`)
		},
		"kilo-code.watchMode.enableExperiment": async () => {
			if (!watchModeService) {
				outputChannel.appendLine("Watch Mode service not initialized")
				vscode.window.showErrorMessage("Watch Mode service not initialized")
				return
			}

			// Enable the experiment flag
			const experimentsConfig = (context.globalState.get("experiments") || {}) as Record<string, boolean>
			experimentsConfig["watchMode"] = true
			await context.globalState.update("experiments", experimentsConfig)

			outputChannel.appendLine("Watch Mode experiment flag enabled")
			vscode.window.showInformationMessage("Watch Mode experiment flag enabled. Please restart the service.")

			// Restart the service
			watchModeService.stop()
			const success = watchModeService.start()
			if (success) {
				vscode.window.showInformationMessage("Watch Mode service restarted successfully")
			} else {
				vscode.window.showErrorMessage("Failed to restart Watch Mode service")
			}
		},
	}
}

export const openClineInNewTab = async ({ context, outputChannel }: Omit<RegisterCommandOptions, "provider">) => {
	// (This example uses webviewProvider activation event which is necessary to
	// deserialize cached webview, but since we use retainContextWhenHidden, we
	// don't need to use that event).
	// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
	const contextProxy = await ContextProxy.getInstance(context)
	const tabProvider = new ClineProvider(context, outputChannel, "editor", contextProxy)
	const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

	// Check if there are any visible text editors, otherwise open a new group
	// to the right.
	const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0

	if (!hasVisibleEditors) {
		await vscode.commands.executeCommand("workbench.action.newGroupRight")
	}

	const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

	const newPanel = vscode.window.createWebviewPanel(ClineProvider.tabPanelId, "Kilo Code", targetCol, {
		enableScripts: true,
		retainContextWhenHidden: true,
		localResourceRoots: [context.extensionUri],
	})

	// Save as tab type panel.
	setPanel(newPanel, "tab")

	// TODO: Use better svg icon with light and dark variants (see
	// https://stackoverflow.com/questions/58365687/vscode-extension-iconpath).
	newPanel.iconPath = {
		light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo.png"),
		dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "kilo.png"),
	}

	await tabProvider.resolveWebviewView(newPanel)

	// Add listener for visibility changes to notify webview
	newPanel.onDidChangeViewState(
		(e) => {
			const panel = e.webviewPanel
			if (panel.visible) {
				panel.webview.postMessage({ type: "action", action: "didBecomeVisible" }) // Use the same message type as in SettingsView.tsx
			}
		},
		null, // First null is for `thisArgs`
		context.subscriptions, // Register listener for disposal
	)

	// Handle panel closing events.
	newPanel.onDidDispose(
		() => {
			setPanel(undefined, "tab")
		},
		null,
		context.subscriptions, // Also register dispose listener
	)

	// Lock the editor group so clicking on files doesn't open them over the panel.
	await delay(100)
	await vscode.commands.executeCommand("workbench.action.lockEditorGroup")

	return tabProvider
}
