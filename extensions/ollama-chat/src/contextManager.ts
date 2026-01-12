/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { analyzeRepository } from './repositoryAnalyzer';
import { generateContextDocument, SimpleEmbedder } from './contextEmbedder';

export class ContextManager {
	private contextDocPath: string;
	private workspaceRoot: string;
	public embedder: SimpleEmbedder;

	constructor(private context: vscode.ExtensionContext) {
		this.workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath || '';
		this.contextDocPath = path.join(this.workspaceRoot, '.vscode', 'project-context.md');
		this.embedder = new SimpleEmbedder();
	}

	public async initialize() {
		if (!this.workspaceRoot) { return; }

		// Ensure .vscode directory exists
		const vscodeDir = path.join(this.workspaceRoot, '.vscode');
		if (!fs.existsSync(vscodeDir)) {
			fs.mkdirSync(vscodeDir);
		}

		// 1. Run Analysis
		await this.refreshContext();

		// 2. Watch for changes in structure (e.g., package.json)
		const watcher = vscode.workspace.createFileSystemWatcher('**/package.json');
		watcher.onDidChange(() => this.refreshContext());
		this.context.subscriptions.push(watcher);
	}

	public async refreshContext() {
		try {
			const repoContext = await analyzeRepository(this.workspaceRoot);

			// Generate the Markdown Document
			const mdContent = generateContextDocument(repoContext);
			fs.writeFileSync(this.contextDocPath, mdContent);

			console.log('Ollama: Context refreshed and saved to .vscode/project-context.md');

			// Index files for "embedding" (Related file search)
			await this.indexSourceFiles();
		} catch (error) {
			console.error('Ollama: Failed to refresh context', error);
		}
	}

	private async indexSourceFiles() {
		// Index top 50 source files for basic "embedding"
		const files = await vscode.workspace.findFiles('src/**/*.{ts,js,py,go,rs,java}', '**/node_modules/**', 50);
		for (const file of files) {
			try {
				const content = fs.readFileSync(file.fsPath, 'utf8');
				this.embedder.analyzeFile(file.fsPath, content);
			} catch (e) { /* ignore read errors */ }
		}
	}

	public getContextString(): string {
		try {
			if (fs.existsSync(this.contextDocPath)) {
				return fs.readFileSync(this.contextDocPath, 'utf8');
			}
		} catch (e) { }
		return '';
	}

	public getRelatedCode(currentFilePath: string): string {
		const relatedFiles = this.embedder.findRelatedFiles(currentFilePath);
		if (relatedFiles.length === 0) { return ''; }

		let contextMsg = '\n\nReference - Related Files:\n';
		for (const file of relatedFiles) {
			contextMsg += `- ${path.basename(file)}\n`;
		}
		return contextMsg;
	}
}
