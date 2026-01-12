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
	private vectorIndexPath: string;
	private orbitDir: string;
	private workspaceRoot: string;
	public embedder: SimpleEmbedder;
	private ollamaBase: string = 'http://localhost:11434';
	private chatModel: string = '';

	// eslint-disable-next-line local/code-no-unexternalized-strings
	private logChannel = vscode.window.createOutputChannel("Ollama Orbit");

	constructor(private context: vscode.ExtensionContext) {
		const folders = vscode.workspace.workspaceFolders;
		this.workspaceRoot = folders?.[0]?.uri.fsPath || '';

		console.log(`[Ollama] constructor: folders count=${folders?.length || 0}, root=${this.workspaceRoot}`);

		this.orbitDir = path.join(this.workspaceRoot, '.orbitai');
		this.contextDocPath = path.join(this.orbitDir, 'project-context.md');
		this.vectorIndexPath = path.join(this.orbitDir, 'embeddings.json');
		this.embedder = new SimpleEmbedder();
		this.log(`ContextManager: Initialized paths (Root: ${this.workspaceRoot})`);
	}

	private log(msg: string) {
		const time = new Date().toLocaleTimeString();
		this.logChannel.appendLine(`[${time}] ${msg}`);
		console.log(`[Ollama] ${msg}`);
	}

	public setEmbeddingModel(model: string) {
		this.log(`Setting embedding model to: ${model}`);
		this.embedder.setModel(model);
	}

	public setChatModel(model: string, baseUrl: string) {
		this.chatModel = model;
		this.ollamaBase = baseUrl;
		this.log(`Setting chat model for analysis: ${model}`);
	}

	public async initialize() {
		this.log('Initializing ContextManager...');
		this.log(`Workspace Root: ${this.workspaceRoot}`);

		if (!this.workspaceRoot) {
			this.log('WARNING: No workspace root found. Context intelligence will be disabled.');
			return;
		}

		// Ensure .orbitai directory exists
		try {
			if (!fs.existsSync(this.orbitDir)) {
				this.log(`Creating directory: ${this.orbitDir}`);
				fs.mkdirSync(this.orbitDir, { recursive: true });
			} else {
				this.log(`Found existing directory: ${this.orbitDir}`);
			}
		} catch (e) {
			this.log(`ERROR creating directory: ${e}`);
		}

		// Load existing
		this.log('Loading existing embeddings...');
		this.embedder.load(this.vectorIndexPath);

		if (!fs.existsSync(this.contextDocPath)) {
			this.log('Context document missing, triggering refresh...');
			await this.refreshContext();
		} else {
			this.log('Context document found.');
		}

		// Broader watchers
		const structureWatcher = vscode.workspace.createFileSystemWatcher('**/{package.json,requirements.txt,go.mod,Cargo.toml,setup.py}');
		structureWatcher.onDidChange(() => {
			this.log('Project structure changed, refreshing context...');
			this.refreshContext();
		});
		this.context.subscriptions.push(structureWatcher);

		const sourceWatcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,js,py,go,rs,java,c,cpp,h}');
		sourceWatcher.onDidChange(async (uri) => {
			this.log(`File changed: ${path.basename(uri.fsPath)}`);
			const content = fs.readFileSync(uri.fsPath, 'utf8');
			await this.embedder.analyzeFile(uri.fsPath, content);
			this.embedder.save(this.vectorIndexPath);
		});
		this.context.subscriptions.push(sourceWatcher);

		this.log('Initialization complete.');
	}

	public async refreshContext() {
		this.log('Refreshing project context...');
		try {
			if (!this.workspaceRoot) {
				const freshRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
				if (freshRoot) {
					this.workspaceRoot = freshRoot;
					this.orbitDir = path.join(this.workspaceRoot, '.orbitai');
					this.contextDocPath = path.join(this.orbitDir, 'project-context.md');
					this.vectorIndexPath = path.join(this.orbitDir, 'embeddings.json');
				} else {
					this.log('ERROR: No workspace folder found to refresh.');
					return;
				}
			}

			if (!fs.existsSync(this.orbitDir)) {
				fs.mkdirSync(this.orbitDir, { recursive: true });
			}

			const repoContext = await analyzeRepository(this.workspaceRoot, {
				baseUrl: this.ollamaBase,
				model: this.chatModel
			});
			const mdContent = generateContextDocument(repoContext);
			fs.writeFileSync(this.contextDocPath, mdContent);
			this.log(`Context doc saved: ${this.contextDocPath}`);

			await this.indexSourceFiles();
			this.embedder.save(this.vectorIndexPath);
		} catch (error) {
			this.log(`ERROR during refresh: ${error}`);
		}
	}

	private async indexSourceFiles() {
		this.log('Indexing source files...');
		// Index files from root and src to be more inclusive
		const files = await vscode.workspace.findFiles('**/*.{ts,js,py,go,rs,java}', '**/node_modules/**', 100);
		this.log(`Found ${files.length} files to index.`);

		for (const file of files) {
			try {
				const content = fs.readFileSync(file.fsPath, 'utf8');
				await this.embedder.analyzeFile(file.fsPath, content);
			} catch (e) {
				this.log(`Error indexing ${file.fsPath}: ${e}`);
			}
		}
		this.log('Indexing complete.');
	}

	public getContextString(): string {
		try {
			if (fs.existsSync(this.contextDocPath)) {
				return fs.readFileSync(this.contextDocPath, 'utf8');
			}
		} catch (e) {
			this.log(`Error reading context string: ${e}`);
		}
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
