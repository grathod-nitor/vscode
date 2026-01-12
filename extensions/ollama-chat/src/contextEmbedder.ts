/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
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
 * A Vector-based embedding system.
 * Uses Ollama's embedding API to generate vectors for file contents
 * and performs cosine similarity search for retrieval.
 */
export class SimpleEmbedder {
	private fileVectors: Map<string, number[]> = new Map();
	private embeddingModel: string = '';
	private baseUrl: string = 'http://localhost:11434';

	public setModel(model: string) {
		this.embeddingModel = model;
	}

	public setBaseUrl(url: string) {
		this.baseUrl = url;
	}

	public async analyzeFile(filePath: string, content: string) {
		if (!this.embeddingModel) {
			console.warn('Ollama: No embedding model selected, skipping vector analysis');
			return;
		}

		try {
			const vector = await this.getEmbedding(content);
			if (vector) {
				this.fileVectors.set(filePath, vector);
			}
		} catch (e) {
			console.error(`Ollama: Failed to get embedding for ${filePath}`, e);
		}
	}

	public save(indexPath: string) {
		try {
			// Ensure directory exists
			const dir = path.dirname(indexPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}

			const data = JSON.stringify(Object.fromEntries(this.fileVectors));
			fs.writeFileSync(indexPath, data);
			console.log(`Ollama: Saved ${this.fileVectors.size} file vectors to ${indexPath}`);
		} catch (e) {
			console.error('Ollama: Failed to save embeddings index', e);
		}
	}

	public load(indexPath: string) {
		try {
			if (fs.existsSync(indexPath)) {
				const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
				this.fileVectors = new Map(Object.entries(data));
				console.log(`Ollama: Loaded ${this.fileVectors.size} file vectors from index`);
			}
		} catch (e) {
			console.error('Ollama: Failed to load embeddings index', e);
		}
	}

	public removeFile(filePath: string) {
		this.fileVectors.delete(filePath);
	}

	private async getEmbedding(text: string): Promise<number[] | null> {
		try {
			const response = await fetch(`${this.baseUrl}/api/embeddings`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: this.embeddingModel,
					prompt: text.substring(0, 4000) // Truncate to avoid context window issues
				})
			});

			if (!response.ok) {
				throw new Error(`Ollama embeddings failed: ${response.statusText}`);
			}

			const data = await response.json() as { embedding: number[] };
			return data.embedding;
		} catch (e) {
			console.error('Ollama: Embedding API error', e);
			return null;
		}
	}

	public findRelatedFiles(targetFile: string, limit: number = 3): string[] {
		const targetVector = this.fileVectors.get(targetFile);
		if (!targetVector) {
			return [];
		}

		const scores: { file: string; score: number }[] = [];

		for (const [file, vector] of this.fileVectors) {
			if (file === targetFile) {
				continue;
			}

			const score = this.cosineSimilarity(targetVector, vector);
			if (score > 0.5) { // Similarity threshold
				scores.push({ file, score });
			}
		}

		return scores
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(x => x.file);
	}

	private cosineSimilarity(v1: number[], v2: number[]): number {
		if (v1.length !== v2.length) { return 0; }
		let dotProduct = 0;
		let norm1 = 0;
		let norm2 = 0;
		for (let i = 0; i < v1.length; i++) {
			dotProduct += v1[i] * v2[i];
			norm1 += v1[i] * v1[i];
			norm2 += v2[i] * v2[i];
		}
		if (norm1 === 0 || norm2 === 0) { return 0; }
		return dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
	}
}

