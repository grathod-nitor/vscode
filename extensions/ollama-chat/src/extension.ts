/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { applySmartPatch, extractFunctionOrBlock, findFunctionOrBlockByMarker } from './codePatcher';
import { ContextManager } from './contextManager';


const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';
const STORAGE_KEY_MODEL = 'ollama.selectedModel';
const STORAGE_KEY_BASE_URL = 'ollama.baseUrl';
const STORAGE_KEY_TEMPERATURE = 'ollama.temperature';
const STORAGE_KEY_TOP_P = 'ollama.topP';
const STORAGE_KEY_MAX_TOKENS = 'ollama.maxTokens';

export function activate(context: vscode.ExtensionContext) {
	const provider = new OllamaChatViewProvider(context);

	// NEW: Initialize Context Manager
	const contextManager = new ContextManager(context);
	// Start analysis in background (don't await to avoid blocking activation)
	contextManager.initialize().catch(err => {
		console.error('Failed to initialize repository context:', err);
	});

	// Pass manager to provider
	provider.setContextManager(contextManager);


	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			OllamaChatViewProvider.viewType,
			provider
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ollama.openChat', async () => {
			await vscode.commands.executeCommand('workbench.view.extension.ollamaChat');
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ollama.suggestChanges', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				vscode.window.showErrorMessage('No active editor');
				return;
			}

			const selectedText = editor.document.getText(editor.selection);
			if (!selectedText) {
				vscode.window.showErrorMessage('No text selected. Please select code to analyze.');
				return;
			}

			const prompt = await vscode.window.showInputBox({
				placeHolder: 'Enter your request for code changes...',
				prompt: 'What changes would you like to make?'
			});

			if (!prompt) { return; }

			await vscode.commands.executeCommand('workbench.view.extension.ollamaChat');
			provider.suggestChanges(selectedText, prompt, editor);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('ollama.applyCode', async (data: { filePath: string; code: string }) => {
			try {
				const uri = vscode.Uri.file(data.filePath);
				const currentContent = (await vscode.workspace.fs.readFile(uri)).toString();

				// Apply smart patch
				const result = applySmartPatch(currentContent, data.code);

				if (!result.success) {
					vscode.window.showErrorMessage(`Failed to apply changes: ${result.message}`);
					return;
				}

				// Write the patched code to file
				const newContent = result.success ? applySmartPatchInternal(currentContent, data.code) : currentContent;
				const enc = new TextEncoder();
				await vscode.workspace.fs.writeFile(uri, enc.encode(newContent));

				vscode.window.showInformationMessage(`✓ Code changes applied to ${path.basename(data.filePath)}`);
			} catch (err) {
				vscode.window.showErrorMessage(`Error applying code: ${err}`);
			}
		})
	);

	// Listen for active editor changes
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(() => {
			provider.updateOpenFiles();
		})
	);
}

export function deactivate() { }

class OllamaChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'ollamaChat.view';

	private view?: vscode.WebviewView;
	private ollamaBase: string = DEFAULT_OLLAMA_BASE;
	private selectedModel: string = '';
	private availableModels: string[] = [];
	private modelInfoCache: Map<string, any> = new Map();
	private serverVersion?: string;
	private selectedFile: string = '';
	private sessionTokens: { input: number; output: number } = { input: 0, output: 0 };
	private temperature: number = 0.7;
	private topP: number = 0.9;
	private maxTokens: number = 2048;

	// NEW: Context Manager reference
	private contextManager?: ContextManager;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.loadSettings();
		this.loadSelectedModel();
	}

	// NEW: Setter for Context Manager
	public setContextManager(manager: ContextManager) {
		this.contextManager = manager;
	}

	private loadSettings() {
		this.ollamaBase = this.context.globalState.get<string>(STORAGE_KEY_BASE_URL) ??
			vscode.workspace.getConfiguration('ollama').get('baseUrl') ??
			DEFAULT_OLLAMA_BASE;
		this.temperature = this.context.globalState.get<number>(STORAGE_KEY_TEMPERATURE) ?? 0.7;
		this.topP = this.context.globalState.get<number>(STORAGE_KEY_TOP_P) ?? 0.9;
		this.maxTokens = this.context.globalState.get<number>(STORAGE_KEY_MAX_TOKENS) ?? 2048;
	}

	private async saveSettings() {
		await this.context.globalState.update(STORAGE_KEY_BASE_URL, this.ollamaBase);
		await this.context.globalState.update(STORAGE_KEY_TEMPERATURE, this.temperature);
		await this.context.globalState.update(STORAGE_KEY_TOP_P, this.topP);
		await this.context.globalState.update(STORAGE_KEY_MAX_TOKENS, this.maxTokens);
	}

	private async loadSelectedModel() {
		const saved = await this.context.globalState.get<string>(STORAGE_KEY_MODEL);
		if (saved) {
			this.selectedModel = saved;
		}
	}

	async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
		this.view = view;

		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.context.extensionUri]
		};

		view.webview.html = this.getHtml();

		// Load models and select first one by default
		await this.loadModels();
		if (!this.selectedModel && this.availableModels.length > 0) {
			await this.selectModel(this.availableModels[0]);
		}
		this.postModels();
		this.updateOpenFiles();
		// Send initial token usage
		this.postTokenUsage();

		view.webview.onDidReceiveMessage(async msg => {
			if (msg.command === 'send') {
				await this.handleSend(msg.payload.id, msg.payload.prompt, msg.payload.filePath);
			} else if (msg.command === 'selectModel') {
				await this.selectModel(msg.payload.model);
			} else if (msg.command === 'refreshModels') {
				await this.loadModels();
				if (!this.selectedModel && this.availableModels.length > 0) {
					await this.selectModel(this.availableModels[0]);
				}
				this.postModels();
			} else if (msg.command === 'selectFile') {
				await this.selectFile(msg.payload.filePath);
			} else if (msg.command === 'writeToFile') {
				await this.writeToFile(msg.payload.filePath, msg.payload.code, msg.payload.original, msg.payload.diff, msg.payload.operations);
			} else if (msg.command === 'getSettings') {
				this.postSettings();
			} else if (msg.command === 'updateSettings') {
				await this.updateSettings(msg.payload);
			}
		});
	}

	updateOpenFiles() {
		const openFiles = vscode.window.visibleTextEditors.map(editor => ({
			name: path.basename(editor.document.fileName),
			path: editor.document.fileName,
			language: editor.document.languageId
		}));

		this.post({
			type: 'updateFiles',
			files: openFiles,
			selectedFile: this.selectedFile
		});
	}

	private async selectFile(filePath: string) {
		try {
			const content = fs.readFileSync(filePath, 'utf8');
			this.selectedFile = filePath;
			console.log(`Selected file: ${filePath}, size: ${content.length} bytes`);

			this.post({
				type: 'fileSelected',
				filePath,
				name: path.basename(filePath)
			});
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			console.error(`Failed to select file: ${errorMsg}`);
			this.post({
				type: 'fileError',
				error: `Failed to load file: ${errorMsg}`
			});
		}
	}

	private async writeToFile(filePath: string, newCode: string, originalContent?: string, diff?: string, operations?: any[]) {
		try {
			// Use VS Code filesystem API so this works with remote/workspace providers
			const uri = vscode.Uri.file(filePath);

			// Determine what content to write
			let contentToWrite = newCode;

			// If we don't have direct code, try to apply operations or diff
			if (!newCode || newCode.trim() === '') {
				if (operations && operations.length > 0) {
					// Apply operations to original content
					contentToWrite = this.applyOperations(originalContent || '', operations);
				} else if (diff && originalContent) {
					// Apply diff to original content
					contentToWrite = this.applyDiff(originalContent, diff);
				} else if (originalContent) {
					// Fallback to original if nothing else works
					contentToWrite = originalContent;
				}
			}

			// Make sure we have actual content to write
			if (!contentToWrite || contentToWrite.trim() === '') {
				throw new Error('No valid content to write to file');
			}

			const enc = new TextEncoder();
			await vscode.workspace.fs.writeFile(uri, enc.encode(contentToWrite));

			// Update open editors
			const editor = vscode.window.visibleTextEditors.find(e => e.document.fileName === filePath);
			if (editor) {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(
					editor.document.uri,
					new vscode.Range(0, 0, editor.document.lineCount, 0),
					contentToWrite
				);
				await vscode.workspace.applyEdit(edit);
			}

			this.post({
				type: 'fileWriteSuccess',
				filePath
			});
		} catch (err) {
			this.post({
				type: 'fileError',
				error: `Failed to write file: ${err}`
			});
		}
	}

	private applyOperations(content: string, operations: any[]): string {
		// Apply a series of operations to the content
		// Operations format: { type: 'replace'|'insert'|'delete', start, end, text }
		let result = content;

		// Sort operations by position (descending) to avoid offset issues
		const sortedOps = [...operations].sort((a, b) => (b.start || 0) - (a.start || 0));

		for (const op of sortedOps) {
			if (op.type === 'replace' && op.start !== undefined && op.end !== undefined) {
				result = result.substring(0, op.start) + (op.text || '') + result.substring(op.end);
			} else if (op.type === 'insert' && op.start !== undefined) {
				result = result.substring(0, op.start) + (op.text || '') + result.substring(op.start);
			} else if (op.type === 'delete' && op.start !== undefined && op.end !== undefined) {
				result = result.substring(0, op.start) + result.substring(op.end);
			}
		}

		return result;
	}

	private applyDiff(originalContent: string, diff: string): string {
		// Simple unified diff parser and applier
		const diffLines = diff.split('\n');
		const outputLines: string[] = [];
		let currentOriginalIdx = 0;
		let inHunk = false;
		let hunkOriginalLine = 0;

		for (const line of diffLines) {
			// Parse hunk header
			if (line.startsWith('@@')) {
				const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
				if (match) {
					hunkOriginalLine = parseInt(match[1], 10) - 1; // 0-indexed
					currentOriginalIdx = hunkOriginalLine;
					inHunk = true;
				}
				continue;
			}

			// Skip headers
			if (line.startsWith('---') || line.startsWith('+++')) {
				continue;
			}

			if (inHunk) {
				if (line.startsWith('+')) {
					// Added line
					outputLines.push(line.substring(1));
				} else if (line.startsWith('-')) {
					// Removed line - skip it
					currentOriginalIdx++;
				} else if (line.startsWith(' ') || line === '') {
					// Context line
					outputLines.push(line.startsWith(' ') ? line.substring(1) : line);
					currentOriginalIdx++;
				}
			}
		}

		// If no hunks were processed, fall back to original
		return outputLines.length > 0 ? outputLines.join('\n') : originalContent;
	}

	private async loadModels() {
		try {
			console.log('Loading models from:', this.ollamaBase);
			const response = await fetch(`${this.ollamaBase}/api/tags`);
			if (!response.ok) { throw new Error('Failed to fetch models'); }
			const data = await response.json() as { models: Array<{ name: string }> };
			this.availableModels = data.models?.map(m => m.name) ?? [];
			console.log('Models loaded:', this.availableModels);

			// Fetch server version and model info in background
			this.fetchServerVersion().catch(err => console.warn('Version fetch failed', err));
			await Promise.allSettled(this.availableModels.map(m => this.fetchModelInfo(m)));
		} catch (err) {
			console.error('Failed to load models:', err);
			this.availableModels = [];
		}
	}

	private postModels() {
		const payload = {
			type: 'models',
			models: this.availableModels,
			selectedModel: this.selectedModel,
			modelInfos: Object.fromEntries(this.modelInfoCache.entries()),
			serverVersion: this.serverVersion
		};
		console.log('Posting models to webview:', payload);
		this.post(payload);
	}

	private async selectModel(model: string) {
		this.selectedModel = model;
		await this.context.globalState.update(STORAGE_KEY_MODEL, model);
		// Ensure model info available and post selection
		await this.fetchModelInfo(model).catch(() => { /* ignore */ });
		this.post({
			type: 'modelSelected',
			model: model,
			modelInfo: this.modelInfoCache.get(model) ?? null,
			serverVersion: this.serverVersion
		});
	}

	private async fetchServerVersion() {
		try {
			const resp = await fetch(`${this.ollamaBase}/api/version`, { method: 'GET', signal: AbortSignal.timeout(5000) });
			if (!resp.ok) { throw new Error('Version endpoint failed'); }
			// eslint-disable-next-line local/code-no-any-casts
			const json = await resp.json() as any;
			this.serverVersion = (json && (json.version ?? json?.Version ?? json?.version_number)) ?? JSON.stringify(json);
		} catch (err) {
			console.warn('fetchServerVersion error', err);
		}
	}

	private async fetchModelInfo(model: string) {
		if (!model) { return null; }
		if (this.modelInfoCache.has(model)) { return this.modelInfoCache.get(model); }
		try {
			const resp = await fetch(`${this.ollamaBase}/api/show`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ model }),
				signal: AbortSignal.timeout(5000)
			});
			if (!resp.ok) {
				this.modelInfoCache.set(model, null);
				return null;
			}
			const info = await resp.json();
			this.modelInfoCache.set(model, info);
			return info;
		} catch (err) {
			console.warn('fetchModelInfo error for', model, err);
			this.modelInfoCache.set(model, null);
			return null;
		}
	}

	private post(message: any) {
		this.view?.webview.postMessage(message);
	}

	private postTokenUsage() {
		this.post({
			type: 'tokenUsage',
			tokens: {
				input: this.sessionTokens.input,
				output: this.sessionTokens.output,
				total: this.sessionTokens.input + this.sessionTokens.output
			}
		});
	}

	private postSettings() {
		this.post({
			type: 'settings',
			baseUrl: this.ollamaBase,
			temperature: this.temperature,
			topP: this.topP,
			maxTokens: this.maxTokens
		});
	}

	private async updateSettings(payload: { baseUrl?: string; temperature?: number; topP?: number; maxTokens?: number }) {
		if (payload.baseUrl !== undefined) {
			this.ollamaBase = payload.baseUrl;
		}
		if (payload.temperature !== undefined) {
			this.temperature = payload.temperature;
		}
		if (payload.topP !== undefined) {
			this.topP = payload.topP;
		}
		if (payload.maxTokens !== undefined) {
			this.maxTokens = payload.maxTokens;
		}
		await this.saveSettings();
		// Reload models if base URL changed
		if (payload.baseUrl !== undefined) {
			await this.loadModels();
			this.postModels();
		}
	}

	suggestChanges(code: string, prompt: string, editor: vscode.TextEditor) {

		// NEW: Add context to suggestions
		let contextBlock = '';
		if (this.contextManager) {
			contextBlock = this.contextManager.getContextString();
		}

		const fullPrompt = `Repository Context:\n${contextBlock}\n\nAnalyze the following code and ${prompt}\n\nCode:\n\`\`\`\n${code}\n\`\`\`\n\nProvide the updated complete code only, without explanations.`;
		const id = Date.now().toString(36);


		this.post({
			type: 'addMessage',
			role: 'user',
			id,
			text: `Suggesting changes for ${path.basename(editor.document.fileName)}:\n${prompt}`
		});

		this.post({
			type: 'addMessage',
			role: 'assistant',
			id,
			text: ''
		});

		this.handleSendWithPrompt(id, fullPrompt, editor.document.fileName);
	}

	private async handleSend(id: string, prompt: string, filePath?: string) {
		// Validate model selection
		if (!this.selectedModel || this.selectedModel.trim() === '') {
			this.post({
				type: 'addMessage',
				role: 'user',
				id,
				text: prompt
			});
			this.post({
				type: 'streamError',
				id,
				error: 'No model selected. Please select a model from the dropdown above.'
			});
			return;
		}

		// If file is selected, include file context in the prompt
		let enhancedPrompt = prompt;
		// 1. Get Project Context
		if (this.contextManager) {
			const projectContext = this.contextManager.getContextString();

			// 2. Get Related Files (if we have a target file)
			let relatedFiles = '';
			if (filePath) {
				relatedFiles = this.contextManager.getRelatedCode(filePath);
			}

			// 3. Get Specific File Content (if selected)
			let fileContext = '';
			if (filePath) {
				try {
					const fileContent = fs.readFileSync(filePath, 'utf8');
					const fileName = path.basename(filePath);
					fileContext = `Active File: ${fileName}\nContent:\n\`\`\`\n${fileContent}\n\`\`\`\n`;
				} catch (err) {
					console.warn('Failed to read file for context:', err);
				}
			}

			enhancedPrompt = `REPOSITORY CONTEXT:\n${projectContext}\n\n${relatedFiles}\n\n${fileContext}\n\nUSER REQUEST:\n${prompt}\n\nPlease provide code or answer based on the context above.`;
		} else if (filePath) {
			try {
				const fileContent = fs.readFileSync(filePath, 'utf8');
				const fileName = path.basename(filePath);
				enhancedPrompt = `You are reviewing the file: ${fileName}\n\nCurrent file content:\n\`\`\`\n${fileContent}\n\`\`\`\n\nUser request: ${prompt}\n\nPlease provide the updated code if code changes are requested, or answer the question about the code.`;
			} catch (err) {
				console.warn('Failed to read file for context:', err);
			}
		}

		this.post({
			type: 'addMessage',
			role: 'user',
			id,
			text: prompt
		});
		this.post({
			type: 'addMessage',
			role: 'assistant',
			id,
			text: ''
		});
		await this.handleSendWithPrompt(id, enhancedPrompt, filePath);
	}

	private async handleSendWithPrompt(id: string, prompt: string, targetFile?: string) {
		try {
			const model = this.selectedModel;

			// Check if Ollama server is reachable
			try {
				const healthCheck = await fetch(`${this.ollamaBase}/api/tags`, {
					method: 'GET',
					signal: AbortSignal.timeout(5000)
				});
				if (!healthCheck.ok) {
					throw new Error('Ollama server not responding');
				}
			} catch (err) {
				throw new Error(`Cannot reach Ollama server at ${this.ollamaBase}. Make sure Ollama is running.`);
			}

			const response = await fetch(`${this.ollamaBase}/api/chat`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: model,
					messages: [{ role: 'user', content: prompt }],
					stream: true,
					options: {
						temperature: this.temperature,
						top_p: this.topP,
						num_predict: this.maxTokens
					}
				}),
				signal: AbortSignal.timeout(120000)
			});

			if (response.status === 404) {
				throw new Error(`Model "${model}" not found on Ollama server. Please install it first or select another model.`);
			}

			if (!response.ok) {
				throw new Error(`HTTP error! status: ${response.status} - ${response.statusText}`);
			}

			if (!response.body) {
				throw new Error('No response body from server');
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let fullResponse = '';
			let promptTokens = 0;
			let completionTokens = 0;

			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) { break; }

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (!line.trim()) { continue; }
						try {
							const json = JSON.parse(line);
							if (json.message?.content) {
								fullResponse += json.message.content;
								this.post({ type: 'streamDelta', id, text: json.message.content });
							}
							// Track token usage from the final response chunk
							if (json.prompt_eval_count !== undefined) {
								promptTokens = json.prompt_eval_count;
							}
							if (json.eval_count !== undefined) {
								completionTokens = json.eval_count;
							}
						} catch {
							// Ignore parse errors
						}
					}
				}

				// Process remaining buffer
				if (buffer.trim()) {
					try {
						const json = JSON.parse(buffer);
						if (json.message?.content) {
							fullResponse += json.message.content;
							this.post({ type: 'streamDelta', id, text: json.message.content });
						}
						// Track token usage from final chunk
						if (json.prompt_eval_count !== undefined) {
							promptTokens = json.prompt_eval_count;
						}
						if (json.eval_count !== undefined) {
							completionTokens = json.eval_count;
						}
					} catch {
						// Ignore parse errors
					}
				}
			} finally {
				reader.releaseLock();
			}

			// Update session token counts
			if (promptTokens > 0 || completionTokens > 0) {
				this.sessionTokens.input += promptTokens;
				this.sessionTokens.output += completionTokens;
				this.postTokenUsage();
			}

			// If this was a code suggestion, extract and offer to apply
			if (targetFile && fullResponse.includes('```')) {
				const codeMatch = fullResponse.match(/```(?:\w+)?\n([\s\S]*?)```/);
				if (codeMatch) {
					const original = (() => { try { return targetFile ? fs.readFileSync(targetFile, 'utf8') : null; } catch (e) { console.warn('Failed to read original file for diff', e); return null; } })();
					this.post({
						type: 'codeAvailable',
						id,
						filePath: targetFile,
						code: codeMatch[1].trim(),
						original: original
					});
				}
			}
		} catch (err: any) {
			console.error('Error:', err);
			const errorMsg = err.message || String(err);
			this.post({ type: 'streamError', id, error: errorMsg });
		}
	}

	private getHtml(): string {
		const nonce = getNonce();
		const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview.html');

		let html = fs.readFileSync(htmlPath.fsPath, 'utf8');

		// Replace nonce placeholder
		html = html.replace(/\$\{nonce\}/g, nonce);

		// Replace script src with proper webview URI
		if (this.view?.webview) {
			const scriptPath = this.view.webview.asWebviewUri(
				vscode.Uri.joinPath(this.context.extensionUri, 'src', 'webview-script.js')
			);
			html = html.replace('src="./webview-script.js"', `src="${scriptPath.toString()}"`);
		}

		return html;
	}

}

/**
 * Internal helper function to apply smart patch.
 * Integrates with the codePatcher module logic.
 */
function applySmartPatchInternal(sourceContent: string, newCode: string): string {
	const sourceLines = sourceContent.split('\n');
	const newLines = newCode.split('\n').map(l => l.trimRight());

	// Try marker-based matching first (for functions/blocks)
	const extractedBlock = extractFunctionOrBlock(newCode);
	let bestMatchIndex = -1;
	let endIndex = -1;

	if (extractedBlock) {
		const markerMatchIndex = findFunctionOrBlockByMarker(sourceLines, extractedBlock.startMarker);
		if (markerMatchIndex !== -1) {
			// Find the matching closing brace for the block first
			let braceCount = 0;
			let foundOpening = false;
			let closingBraceIndex = markerMatchIndex;

			for (let i = markerMatchIndex; i < sourceLines.length; i++) {
				for (const char of sourceLines[i]) {
					if (char === '{') {
						braceCount++;
						foundOpening = true;
					} else if (char === '}') {
						braceCount--;
						if (foundOpening && braceCount === 0) {
							closingBraceIndex = i;
							break;
						}
					}
				}
				if (foundOpening && braceCount === 0) { break; }
			}

			// Check if new code includes the function signature
			const newCodeFirstLine = newLines[0].trim();
			const sourceSignatureLine = sourceLines[markerMatchIndex].trim();
			const newCodeIncludesSignature = newCodeFirstLine === sourceSignatureLine ||
				newCodeFirstLine.includes(sourceSignatureLine.substring(0, Math.min(20, sourceSignatureLine.length))) ||
				sourceSignatureLine.includes(newCodeFirstLine.substring(0, Math.min(20, newCodeFirstLine.length)));

			// Check if new code includes closing brace
			const newCodeLastLine = newLines[newLines.length - 1].trim();
			const sourceClosingBraceLine = sourceLines[closingBraceIndex].trim();
			const newCodeIncludesClosingBrace = newCodeLastLine === sourceClosingBraceLine ||
				newCodeLastLine.includes('}') || sourceClosingBraceLine.includes('}');

			if (newCodeIncludesSignature) {
				// New code includes signature, replace from signature line
				bestMatchIndex = markerMatchIndex;
				if (newCodeIncludesClosingBrace) {
					// New code includes closing brace, replace up to and including closing brace
					endIndex = closingBraceIndex + 1;
				} else {
					// New code doesn't include closing brace, replace up to but not including closing brace
					endIndex = closingBraceIndex;
				}
			} else {
				// New code is just the body, replace from after signature
				bestMatchIndex = markerMatchIndex + 1;
				if (newCodeIncludesClosingBrace) {
					// New code includes closing brace, replace up to and including closing brace
					endIndex = closingBraceIndex + 1;
				} else {
					// New code doesn't include closing brace, replace up to but not including closing brace
					endIndex = closingBraceIndex;
				}
			}
		}
	}

	// Fall back to fuzzy matching if marker-based matching didn't work
	if (bestMatchIndex === -1) {
		bestMatchIndex = findBestMatchInternal(sourceLines, newCode);

		if (bestMatchIndex === -1) {
			// If no good match found, append to end
			return sourceContent + '\n\n' + newCode;
		}

		// Calculate how many lines of old code match the new code
		// This prevents duplication by replacing the correct range
		endIndex = calculateReplacementEndIndex(sourceLines, newLines, bestMatchIndex);
	}

	// Apply the patch
	// Validate indices before applying
	if (bestMatchIndex < 0) {
		// No match found, append to end
		return sourceContent + '\n\n' + newCode;
	}

	// Ensure endIndex is valid
	if (endIndex <= bestMatchIndex) {
		// Invalid range, calculate a safe endIndex
		endIndex = bestMatchIndex + newLines.length;
	}

	// Ensure endIndex doesn't exceed source length
	if (endIndex > sourceLines.length) {
		endIndex = sourceLines.length;
	}

	// Apply the replacement: replace lines from bestMatchIndex to endIndex-1 with newLines
	const before = sourceLines.slice(0, bestMatchIndex);
	const after = sourceLines.slice(endIndex);
	const patched = [...before, ...newLines, ...after];

	return patched.join('\n');
}

/**
 * Calculate how many lines of old code should be replaced.
 * This prevents duplication by determining the exact range to replace.
 */
function calculateReplacementEndIndex(sourceLines: string[], newLines: string[], startIndex: number): number {
	// Strategy 1: Try to match consecutive lines
	let matchedLines = 0;
	for (let i = 0; i < Math.min(newLines.length, sourceLines.length - startIndex); i++) {
		const newLine = newLines[i].trim();
		const srcLine = sourceLines[startIndex + i].trim();
		if (newLine === srcLine || srcLine.includes(newLine) || newLine.includes(srcLine)) {
			matchedLines++;
		} else {
			// If we've matched at least one line, stop here
			if (matchedLines > 0) { break; }
		}
	}

	// If we found matching lines, replace that many
	if (matchedLines > 0) {
		const endIndex = startIndex + matchedLines;

		// Look for natural boundaries (function/class definitions) after the matched section
		for (let i = endIndex; i < sourceLines.length; i++) {
			if (/^\s*(function|class|const\s+\w+\s*=|let\s+\w+\s*=|async\s+(function|const))/.test(sourceLines[i]) && i !== startIndex) {
				// Found a new function/class, stop here
				return i;
			}
		}

		// If no boundary found, replace the matched lines
		// But also check if we should include more lines based on structure
		// Look for closing braces or other structural markers
		let braceCount = 0;
		for (let i = startIndex; i < Math.min(endIndex + 10, sourceLines.length); i++) {
			for (const char of sourceLines[i]) {
				if (char === '{') { braceCount++; }
				if (char === '}') { braceCount--; }
			}
			// If we've closed all braces and we're past our match, this might be the end
			if (braceCount === 0 && i >= endIndex - 1 && i > startIndex) {
				return i + 1;
			}
		}

		return endIndex;
	}

	// Strategy 2: If no consecutive match, use newLines.length as fallback
	// But look for boundaries to avoid replacing too much
	let endIndex = startIndex + newLines.length;

	// Look for natural boundaries
	for (let i = startIndex + newLines.length; i < sourceLines.length; i++) {
		if (/^\s*(function|class|const\s+\w+\s*=|let\s+\w+\s*=|async\s+(function|const))/.test(sourceLines[i]) && i !== startIndex) {
			endIndex = i;
			break;
		}
		if (i === sourceLines.length - 1) {
			endIndex = i + 1;
		}
	}

	return endIndex;
}

/**
 * Find the best matching location for code insertion.
 * Uses improved matching logic that compares new lines with source lines.
 */
function findBestMatchInternal(sourceLines: string[], newCode: string): number {
	const newLines = newCode.split('\n').filter(l => l.trim());
	if (newLines.length === 0) { return -1; }

	const firstNewLine = newLines[0].trim();
	let bestScore = 0;
	let bestIndex = -1;

	// Try to find a match - be more flexible with the first line matching
	const minMatchLength = Math.min(5, firstNewLine.length); // Reduced to 5 chars minimum

	// Strategy 1: Try exact or near-exact match of first line
	for (let i = 0; i < sourceLines.length; i++) {
		const srcLine = sourceLines[i].trim();

		// Check if this line matches or contains the first new line
		if (firstNewLine.length >= minMatchLength) {
			const matchSubstring = firstNewLine.substring(0, minMatchLength);
			if (srcLine.includes(matchSubstring) || firstNewLine.includes(srcLine.substring(0, Math.min(minMatchLength, srcLine.length)))) {
				let score = 0;
				// Score based on matching lines - compare newLines with sourceLines
				for (let j = 0; j < Math.min(newLines.length, sourceLines.length - i); j++) {
					const newLineTrimmed = newLines[j].trim();
					const srcLineTrimmed = sourceLines[i + j].trim();
					// Use similarity check - exact match or contains the line
					if (newLineTrimmed === srcLineTrimmed) {
						score += 1;
					} else if (srcLineTrimmed.includes(newLineTrimmed) || newLineTrimmed.includes(srcLineTrimmed)) {
						score += 0.5; // Partial match
					}
				}
				if (score > bestScore) {
					bestScore = score;
					bestIndex = i;
				}
			}
		}
	}

	// If we found a match with at least some similarity, return it
	if (bestScore > 0.5) {
		return bestIndex;
	}

	// Strategy 2: Try to find any line that matches the first line exactly
	for (let i = 0; i < sourceLines.length; i++) {
		if (sourceLines[i].trim() === firstNewLine) {
			return i;
		}
	}

	// Strategy 3: Try to find lines that contain key words from the first line
	const firstLineWords = firstNewLine.split(/\s+/).filter(w => w.length > 3);
	if (firstLineWords.length > 0) {
		for (let i = 0; i < sourceLines.length; i++) {
			const srcLine = sourceLines[i].trim();
			const matchingWords = firstLineWords.filter(word => srcLine.includes(word)).length;
			if (matchingWords >= Math.min(2, firstLineWords.length)) {
				// Found a line with multiple matching words, use it
				return i;
			}
		}
	}

	return -1;
}

function getNonce() {
	return Math.random().toString(36).slice(2);
}

