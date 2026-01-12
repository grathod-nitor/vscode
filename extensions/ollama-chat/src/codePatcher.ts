/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Smart code patcher that finds and applies minimal changes to source files.
 * Uses fuzzy matching to find relevant code sections and applies targeted modifications.
 */

interface PatchResult {
	success: boolean;
	message: string;
	linesModified?: number;
	startLine?: number;
	endLine?: number;
}

/**
 * Find the best matching location in the source file for the given code block.
 * Uses line-by-line comparison to find similar code patterns.
 */
function findBestMatch(sourceLines: string[], newCode: string): number {
	const newLines = newCode.split('\n').filter(l => l.trim());
	if (newLines.length === 0) { return -1; }

	// Try to find a match starting with the first meaningful line
	const firstNewLine = newLines[0].trim();
	let bestMatchScore = 0;
	let bestMatchIndex = -1;

	for (let i = 0; i < sourceLines.length; i++) {
		if (sourceLines[i].trim().includes(firstNewLine.substring(0, 20))) {
			// Found a potential match location, check how many lines align
			let matchScore = 0;
			for (let j = 0; j < Math.min(newLines.length, sourceLines.length - i); j++) {
				const srcLine = sourceLines[i + j].trim();
				const newLine = newLines[j].trim();
				// Calculate similarity ratio
				if (srcLine.length > 0 && newLine.length > 0) {
					const similarity = calculateStringSimilarity(srcLine, newLine);
					if (similarity > 0.6) {
						matchScore += similarity;
					}
				}
			}
			if (matchScore > bestMatchScore) {
				bestMatchScore = matchScore;
				bestMatchIndex = i;
			}
		}
	}

	return bestMatchIndex >= 0 ? bestMatchIndex : -1;
}

/**
 * Calculate similarity between two strings (0 to 1).
 */
function calculateStringSimilarity(str1: string, str2: string): number {
	const longer = str1.length > str2.length ? str1 : str2;
	const shorter = str1.length > str2.length ? str2 : str1;

	if (longer.length === 0) { return 1; }

	const editDistance = getEditDistance(longer, shorter);
	return (longer.length - editDistance) / longer.length;
}

/**
 * Levenshtein distance for string comparison.
 */
function getEditDistance(s1: string, s2: string): number {
	const distances: number[][] = [];

	for (let i = 0; i <= s1.length; i++) {
		distances[i] = [i];
	}

	for (let j = 0; j <= s2.length; j++) {
		distances[0][j] = j;
	}

	for (let i = 1; i <= s1.length; i++) {
		for (let j = 1; j <= s2.length; j++) {
			if (s1[i - 1] === s2[j - 1]) {
				distances[i][j] = distances[i - 1][j - 1];
			} else {
				distances[i][j] = Math.min(
					distances[i - 1][j - 1] + 1,
					distances[i][j - 1] + 1,
					distances[i - 1][j] + 1
				);
			}
		}
	}

	return distances[s1.length][s2.length];
}

/**
 * Extract function or block from new code that should replace a section in the source.
 * Identifies function definitions and class methods to improve matching accuracy.
 */
export function extractFunctionOrBlock(code: string): { startMarker: string; endMarker: string; content: string } | null {
	// Look for function definitions
	const functionMatch = code.match(/^\s*(async\s+)?(function\s+\w+|const\s+\w+\s*=|let\s+\w+\s*=)/m);
	if (functionMatch) {
		return {
			startMarker: functionMatch[0].trim(),
			endMarker: '}',
			content: code
		};
	}

	// Look for class methods
	const methodMatch = code.match(/^\s*(async\s+)?(\w+)\s*\(/m);
	if (methodMatch) {
		return {
			startMarker: methodMatch[0].trim(),
			endMarker: '}',
			content: code
		};
	}

	return null;
}

/**
 * Find function or block in source using extracted markers.
 * Uses the startMarker from extractFunctionOrBlock to locate matching code.
 */
export function findFunctionOrBlockByMarker(sourceLines: string[], startMarker: string): number {
	// Normalize the marker by removing extra whitespace
	const normalizedMarker = startMarker.trim().replace(/\s+/g, '\\s+');
	const markerPattern = normalizedMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(markerPattern, 'i');

	for (let i = 0; i < sourceLines.length; i++) {
		const normalizedLine = sourceLines[i].trim();
		// Try exact match first
		if (normalizedLine === startMarker.trim()) {
			return i;
		}
		// Try regex match for flexible whitespace
		if (regex.test(sourceLines[i])) {
			return i;
		}
		// Try partial match - check if the line contains key parts of the marker
		const markerParts = startMarker.trim().split(/\s+/).filter(p => p.length > 2);
		if (markerParts.length > 0 && markerParts.every(part => normalizedLine.includes(part))) {
			return i;
		}
	}

	return -1;
}

/**
 * Apply smart patch to source file.
 * Finds the best matching section and replaces only what's necessary.
 */
export function applySmartPatch(sourceContent: string, newCode: string, functionName?: string): PatchResult {
	const sourceLines = sourceContent.split('\n');
	const newLines = newCode.split('\n').map(l => l.trimRight());

	// Try to extract function/block markers from new code to improve matching
	const extractedBlock = extractFunctionOrBlock(newCode);
	if (extractedBlock) {
		// Use the startMarker to find the matching function/block in source
		const markerMatchIndex = findFunctionOrBlockByMarker(sourceLines, extractedBlock.startMarker);
		if (markerMatchIndex !== -1) {
			// Found a match using the marker, now find the end of the block
			let braceCount = 0;
			let blockEndIndex = markerMatchIndex;
			let foundOpening = false;

			for (let i = markerMatchIndex; i < sourceLines.length; i++) {
				for (const char of sourceLines[i]) {
					if (char === '{') {
						braceCount++;
						foundOpening = true;
					} else if (char === '}') {
						braceCount--;
						if (foundOpening && braceCount === 0) {
							blockEndIndex = i;
							break;
						}
					}
				}
				if (foundOpening && braceCount === 0) { break; }
			}

			return {
				success: true,
				message: `Successfully patched function/block using marker matching`,
				linesModified: blockEndIndex - markerMatchIndex,
				startLine: markerMatchIndex,
				endLine: blockEndIndex
			};
		}
	}

	// If function name provided, find the function and replace its body
	if (functionName) {
		const funcPattern = new RegExp(`(\\b${functionName}\\s*\\([^)]*\\)\\s*[{:])`, 'i');
		let functionStartIndex = -1;

		for (let i = 0; i < sourceLines.length; i++) {
			if (funcPattern.test(sourceLines[i])) {
				functionStartIndex = i;
				break;
			}
		}

		if (functionStartIndex !== -1) {
			// Find the matching closing brace
			let braceCount = 0;
			let functionEndIndex = functionStartIndex;
			let foundOpening = false;

			for (let i = functionStartIndex; i < sourceLines.length; i++) {
				for (const char of sourceLines[i]) {
					if (char === '{') {
						braceCount++;
						foundOpening = true;
					} else if (char === '}') {
						braceCount--;
						if (foundOpening && braceCount === 0) {
							functionEndIndex = i;
							break;
						}
					}
				}
				if (foundOpening && braceCount === 0) { break; }
			}

			// Replace the function body
			return {
				success: true,
				message: `Successfully patched function '${functionName}'`,
				linesModified: functionEndIndex - functionStartIndex,
				startLine: functionStartIndex,
				endLine: functionEndIndex
			};
		}
	}

	// Otherwise, find best match location
	const bestMatch = findBestMatch(sourceLines, newCode);

	if (bestMatch === -1) {
		return {
			success: false,
			message: 'Could not find a suitable location to apply the patch. Code section not found in source file.'
		};
	}

	// Find the end of the old code block (usually at next function or class definition)
	let endIndex = bestMatch + 1;
	const endPatterns = [/^\s*(function|class|const\s+\w+\s*=|let\s+\w+\s*=|async\s+(function|const))/];

	for (let i = bestMatch + newLines.length; i < sourceLines.length; i++) {
		if (endPatterns.some(p => p.test(sourceLines[i])) && i !== bestMatch) {
			endIndex = i;
			break;
		} else if (i === sourceLines.length - 1) {
			endIndex = i + 1;
		}
	}

	// Apply the patch
	return {
		success: true,
		message: `Successfully applied patch. Modified ${endIndex - bestMatch} lines.`,
		linesModified: endIndex - bestMatch,
		startLine: bestMatch,
		endLine: endIndex
	};
}

/**
 * Extract code block from markdown response (between ``` markers).
 */
export function extractCodeBlock(response: string, language?: string): string | null {
	// Try language-specific block first if provided
	if (language) {
		const langPattern = new RegExp(`\`\`\`${language}\\n([\\s\\S]*?)\`\`\``, 'i');
		const match = response.match(langPattern);
		if (match) { return match[1].trim(); }
	}

	// Generic code block
	const genericPattern = /```(?:\w+)?\n([\s\S]*?)```/;
	const match = response.match(genericPattern);
	return match ? match[1].trim() : null;
}

/**
 * Get minimal diff between original and new code.
 */
export function getMinimalDiff(original: string, newCode: string): { added: string[]; removed: string[]; modified: Array<{ original: string; new: string }> } {
	const originalLines = original.split('\n');
	const newLines = newCode.split('\n');

	const added: string[] = [];
	const removed: string[] = [];
	const modified: Array<{ original: string; new: string }> = [];

	// Simple line-based diff
	const maxLen = Math.max(originalLines.length, newLines.length);

	for (let i = 0; i < maxLen; i++) {
		const origLine = originalLines[i] || '';
		const newLine = newLines[i] || '';

		if (origLine !== newLine) {
			if (origLine && !newLine) {
				removed.push(origLine);
			} else if (!origLine && newLine) {
				added.push(newLine);
			} else {
				modified.push({ original: origLine, new: newLine });
			}
		}
	}

	return { added, removed, modified };
}
