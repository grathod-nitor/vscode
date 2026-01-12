/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RepositoryContext } from './repositoryAnalyzer';

/**
 * Generates a Markdown representation of the repository context
 */
export function generateContextDocument(context: RepositoryContext): string {
	const { techStack, projectStructure, codingStandards } = context;

	return `# Repository Context: ${context.projectName}
> Generated on: ${context.timestamp}
// allow-any-unicode-next-line
## 🛠 Tech Stack
- **Languages:** ${techStack.languages.join(', ') || 'Unknown'}
- **Frameworks:** ${techStack.frameworks.join(', ') || 'None detected'}
- **Build Tools:** ${techStack.buildTools.join(', ') || 'None'}

// allow-any-unicode-next-line
## 🏗 Project Structure
- **Architecture Patterns:** ${projectStructure.patterns.join(', ') || 'Standard'}
- **Layers:** ${projectStructure.layers.join(', ') || 'Single layer/Monolith'}
- **Entry Points:** ${projectStructure.entryPoints.join(', ')}

// allow-any-unicode-next-line
## 📏 Coding Standards
// allow-any-unicode-next-line
- **Linting:** ${codingStandards.hasLinting ? '✅ Enabled' : '❌ Not detected'}
// allow-any-unicode-next-line
- **Formatting:** ${codingStandards.hasFormatting ? '✅ Enabled' : '❌ Not detected'}
// allow-any-unicode-next-line
- **Testing:** ${codingStandards.hasTests ? '✅ Enabled' : '❌ Not detected'}
// allow-any-unicode-next-line
- Frameworks: ${codingStandards.testFrameworks.join(', ')}

// allow-any-unicode-next-line
## 📦 Key Dependencies
${Object.entries(techStack.dependencies)
			.filter(([_, v]) => !v.includes('types')) // simple filter
			.slice(0, 15)
			.map(([pkg, ver]) => `- ${pkg}: ${ver}`)
			.join('\n')}
`;
}

/**
 * A lightweight embedding system.
 * Instead of heavy vector DBs, we extract "semantic tokens" (imports, classes, functions)
 * to find related files for the LLM prompt.
 */
export class SimpleEmbedder {
	private fileSignatures: Map<string, Set<string>> = new Map();

	public analyzeFile(filePath: string, content: string) {
		// Extract basic tokens: imports, class names, function names
		const tokens = new Set<string>();

		// Match imports (e.g., import { X } from 'Y')
		const importMatches = content.matchAll(/import\s+.*?from\s+['"](.*?)['"]/g);
		for (const match of importMatches) {
			tokens.add(match[1]); // Add the module name
		}

		// Match Class/Function definitions
		const defMatches = content.matchAll(/(class|function|interface)\s+(\w+)/g);
		for (const match of defMatches) {
			tokens.add(match[2]); // Add the name
		}

		this.fileSignatures.set(filePath, tokens);
	}

	public findRelatedFiles(targetFile: string, limit: number = 3): string[] {
		const targetTokens = this.fileSignatures.get(targetFile);
		if (!targetTokens) { return []; }

		const scores: { file: string; score: number }[] = [];

		for (const [file, tokens] of this.fileSignatures) {
			if (file === targetFile) { continue; }

			// Jaccard Similarity (Intersection over Union)
			let intersection = 0;
			for (const t of targetTokens) {
				if (tokens.has(t)) { intersection++; }
			}

			const score = intersection / (targetTokens.size + tokens.size - intersection);
			if (score > 0) { scores.push({ file, score }); }
		}

		return scores
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(x => x.file);
	}
}
