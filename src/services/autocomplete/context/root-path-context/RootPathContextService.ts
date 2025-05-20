import { createHash } from "crypto"

import { LRUCache } from "lru-cache"
import Parser from "web-tree-sitter"

import { AutocompleteSnippetDeprecated } from "../../types"
import { ImportDefinitionsService } from "../ImportDefinitionsService"
import { IDE } from "../../utils/ide"
import { getFullLanguageName, getQueryForFile, LanguageName } from "../../utils/treeSitter"

// function getSyntaxTreeString(
//   node: Parser.SyntaxNode,
//   indent: string = "",
// ): string {
//   let result = "";
//   const nodeInfo = `${node.type} [${node.startPosition.row}:${node.startPosition.column} - ${node.endPosition.row}:${node.endPosition.column}]`;
//   result += `${indent}${nodeInfo}\n`;

//   for (const child of node.children) {
//     result += getSyntaxTreeString(child, indent + "  ");
//   }

//   return result;
// }

export class RootPathContextService {
	private cache = new LRUCache<string, AutocompleteSnippetDeprecated[]>({
		max: 100,
	})

	constructor(
		private readonly importDefinitionsService: ImportDefinitionsService,
		private readonly ide: IDE,
	) {}

	private static getNodeId(node: Parser.SyntaxNode): string {
		return `${node.startIndex}`
	}

	private static TYPES_TO_USE = new Set([
		"arrow_function",
		"generator_function_declaration",
		"program",
		"function_declaration",
		"function_definition",
		"method_definition",
		"method_declaration",
		"class_declaration",
		"class_definition",
	])

	/**
	 * Key comes from hash of parent key and node type and node id.
	 */
	private static keyFromNode(parentKey: string, astNode: Parser.SyntaxNode): string {
		return createHash("sha256")
			.update(parentKey)
			.update(astNode.type)
			.update(RootPathContextService.getNodeId(astNode))
			.digest("hex")
	}

	private async getSnippetsForNode(
		filepath: string,
		node: Parser.SyntaxNode,
	): Promise<AutocompleteSnippetDeprecated[]> {
		const snippets: AutocompleteSnippetDeprecated[] = []
		const language = getFullLanguageName(filepath)

		let query: Parser.Query | undefined
		switch (node.type) {
			case "program":
				this.importDefinitionsService.get(filepath)
				break
			default:
				// const type = node.type;
				// console.log(getSyntaxTreeString(node));

				query = await getQueryForFile(filepath, `root-path-context-queries/${language}/${node.type}.scm`)
				break
		}

		if (!query) {
			return snippets
		}

		const queries = query.matches(node).map(async (match) => {
			for (const item of match.captures) {
				try {
					const endPosition = item.node.endPosition
					const newSnippets = await this.getSnippets(filepath, endPosition, language)
					snippets.push(...newSnippets)
				} catch (e) {
					throw e
				}
			}
		})

		await Promise.all(queries)

		return snippets
	}

	private async getSnippets(
		_filepath: string,
		_endPosition: Parser.Point,
		_language: LanguageName,
	): Promise<AutocompleteSnippetDeprecated[]> {
		return []
	}
}
