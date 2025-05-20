export interface Location {
	filepath: string
	position: Position
}

export interface FileWithContents {
	filepath: string
	contents: string
}

export interface Range {
	start: Position
	end: Position
}

export interface Position {
	line: number
	character: number
}

export interface FileEdit {
	filepath: string
	range: Range
	replacement: string
}

export interface RangeInFile {
	filepath: string
	range: Range
}

export interface RangeInFile {
	filepath: string
	range: Range
}

export interface FileWithContents {
	filepath: string
	contents: string
}

export interface RangeInFileWithContents {
	filepath: string
	range: {
		start: { line: number; character: number }
		end: { line: number; character: number }
	}
	contents: string
}
export interface SymbolWithRange extends RangeInFile {
	name: string
	type: Parser.SyntaxNode["type"]
	content: string
}

export type FileSymbolMap = Record<string, SymbolWithRange[]>
