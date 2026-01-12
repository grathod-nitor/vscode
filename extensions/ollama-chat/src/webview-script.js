/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Discriminated union types for webview messages
 * Ensures type safety and prevents message routing errors
 */

// Messages sent TO extension
const MessageTypes = {
	SEND: 'send',
	SELECT_MODEL: 'selectModel',
	SELECT_FILE: 'selectFile',
	APPLY_CHANGES: 'applyChanges',
	SETTINGS: 'settings',
	REFRESH_MODELS: 'refreshModels'
};

// Messages FROM extension
const ResponseTypes = {
	CODE_AVAILABLE: 'codeAvailable',
	STREAMING_RESPONSE: 'streamingResponse',
	ERROR: 'error',
	MODEL_LIST: 'modelList',
	FILE_WRITTEN: 'fileWritten',
	HEALING_ATTEMPT: 'healingAttempt',
	OPERATION_METRICS: 'operationMetrics',
	PROCESS_UPDATE: 'processUpdate'
};

// Process steps for UI indication
const ProcessSteps = {
	IDLE: 'idle',
	CONNECTING: 'connecting',
	READING_FILE: 'reading_file',
	THINKING: 'thinking',
	PROCESSING: 'processing',
	GENERATING_DIFF: 'generating_diff',
	APPLYING_CHANGES: 'applying_changes',
	SUCCESS: 'success',
	ERROR: 'error'
};

const vscode = acquireVsCodeApi();
const messagesContainer = document.getElementById('messages');
const promptInput = document.getElementById('prompt');
const send = document.getElementById('send');
const modelSelector = document.getElementById('modelSelector');
const modelDetails = document.getElementById('modelDetails');
const fileSelector = document.getElementById('fileSelector');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');
const tokenUsageEl = document.getElementById('tokenUsage');
const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const settingsSave = document.getElementById('settingsSave');
const settingsCancel = document.getElementById('settingsCancel');

let currentAssistantId = null;
let currentAssistantEl = null;
let currentThinkingEl = null;
let thinkingStartTimestamp = 0;
let thinkingInterval = null;
const pendingThinkingBlocks = new Map(); // Store thinking blocks before assistant ID is known
const currentCodeData = null;
let selectedFilePath = '';
let selectedFileName = '';
let lastEmbeddingModel = '';
const codeDataMap = new Map(); // Store code data per message ID
const originalContents = new Map(); // Store original content for undo

// allow-any-unicode-next-line
console.log('Webview: Initialization started');

// Load initial state if available to prevent flickering
const previousState = vscode.getState();
if (previousState) {
	if (previousState.models) {
		updateModelsUi(previousState.models, previousState.selectedModel, previousState.embeddingModel);
	}
	if (previousState.files) {
		updateFilesUi(previousState.files, previousState.selectedFile);
	}
}

// Signal ready to extension to get fresh/persisted data
vscode.postMessage({ command: 'ready' });

// ============================================================================
// Status and Error Handling
// ============================================================================

function showStatus(msg, type = 'info') {
	if (statusEl) {
		statusEl.textContent = msg;
		statusEl.style.display = 'block';
		statusEl.style.background = type === 'error' ? 'rgba(255,100,100,0.2)' : type === 'success' ? 'rgba(100,255,100,0.2)' : 'rgba(255,255,0,0.1)';
		if (type !== 'error') { setTimeout(() => statusEl.style.display = 'none', 3000); }
	}
}

function showError(msg) {
	// allow-any-unicode-next-line
	console.error('❌ Error:', msg);
	// allow-any-unicode-next-line
	showStatus('❌ ' + msg, 'error');
}

function showSuccess(msg) {
	// allow-any-unicode-next-line
	console.log('✅ Success:', msg);
	// allow-any-unicode-next-line
	showStatus('✅ ' + msg, 'success');
}

function createThinkingBlock(parent) {
	const block = document.createElement('div');
	block.className = 'thinking-block';

	const header = document.createElement('div');
	header.className = 'thinking-header';
	// allow-any-unicode-next-line
	header.innerHTML = `<span>Thinking</span><span class="timer">00:00</span><span class="arrow">▼</span>`;
	header.onclick = () => block.classList.toggle('collapsed');

	const content = document.createElement('div');
	content.className = 'thinking-content';

	// Smart scroll state: detect if user manually scrolled up
	content.isUserScrolling = false;
	content.onscroll = () => {
		const threshold = 30; // pixels from bottom
		const isNearBottom = content.scrollHeight - content.scrollTop - content.clientHeight < threshold;
		content.isUserScrolling = !isNearBottom;
	};

	block.appendChild(header);
	block.appendChild(content);
	parent.prepend(block);

	return content;
}

// Process indicator for backend operations
function showProcessUpdate(step, details = '') {
	const stepEmojis = {
		// allow-any-unicode-next-line
		'connecting': '🔌 Connecting to Ollama...',
		// allow-any-unicode-next-line
		'reading_file': '📖 Reading file...',
		// allow-any-unicode-next-line
		'thinking': '🤔 Model thinking...',
		// allow-any-unicode-next-line
		'processing': '⚙️  Processing request...',
		// allow-any-unicode-next-line
		'generating_diff': '🔄 Generating diff...',
		// allow-any-unicode-next-line
		'applying_changes': '📝 Applying changes...',
		// allow-any-unicode-next-line
		'success': '✅ Done!',
		// allow-any-unicode-next-line
		'error': '❌ Error occurred'
	};

	let statusMsg = stepEmojis[step] || step;
	if (details) {
		statusMsg += ` - ${details}`;
	}

	const type = step === 'error' ? 'error' : step === 'success' ? 'success' : 'info';
	showStatus(statusMsg, type);
	// allow-any-unicode-next-line
	console.log(`📊 Process Step: ${statusMsg}`);
}

function createMessageGroup(role, id, filePath = null) {
	const group = document.createElement('div');
	group.className = `message-group ${role}`;
	group.dataset.id = id;
	group.dataset.role = role;

	const avatar = document.createElement('div');
	avatar.className = 'message-avatar';
	group.appendChild(avatar);

	const content = document.createElement('div');
	content.className = 'message-content';

	// Add file badge if file is selected
	if (filePath && role === 'user') {
		const fileBadge = document.createElement('div');
		fileBadge.className = 'file-badge';
		fileBadge.textContent = filePath.split(/[/\\]/).pop();
		content.appendChild(fileBadge);
	}

	const messageEl = document.createElement('div');
	messageEl.className = 'message';
	messageEl.dataset.content = '';
	content.appendChild(messageEl);

	group.appendChild(content);
	messagesContainer.appendChild(group);
	messagesContainer.scrollTop = messagesContainer.scrollHeight;

	return messageEl;
}

function sendPrompt() {
	const text = promptInput.value.trim();
	if (!text) { return; }

	const selectedModel = modelSelector.value;
	if (!selectedModel) {
		showError('Please select a model first');
		return;
	}

	const id = Date.now().toString(36);
	const filePath = fileSelector.value || null;

	// Show user message immediately
	createMessageGroup('user', id + '_user', filePath).textContent = text;

	vscode.postMessage({
		command: 'send',
		payload: { id, prompt: text, filePath: filePath }
	});

	promptInput.value = '';
	promptInput.focus();
}

send.onclick = sendPrompt;
promptInput.addEventListener('keydown', e => {
	if (e.key === 'Enter' && !e.shiftKey) {
		e.preventDefault();
		sendPrompt();
	}
});

modelSelector.addEventListener('change', (e) => {
	vscode.postMessage({
		command: 'selectModel',
		payload: { model: e.target.value }
	});
	renderModelDetails(e.target.value);
});

fileSelector.addEventListener('change', (e) => {
	selectedFilePath = e.target.value;
	selectedFileName = e.target.value ? e.target.value.split(/[/\\]/).pop() : '';
	vscode.postMessage({
		command: 'selectFile',
		payload: { filePath: e.target.value }
	});
});

refreshBtn.addEventListener('click', () => {
	vscode.postMessage({ command: 'refreshModels' });
});

// Settings Modal
settingsBtn.addEventListener('click', () => {
	settingsModal.classList.add('active');
	// Load current settings
	vscode.postMessage({ command: 'getSettings' });
});

settingsCancel.addEventListener('click', () => {
	settingsModal.classList.remove('active');
});

settingsSave.addEventListener('click', () => {
	const baseUrl = document.getElementById('settingBaseUrl').value;
	const temperature = parseFloat(document.getElementById('settingTemperature').value);
	const topP = parseFloat(document.getElementById('settingTopP').value);
	const maxTokens = parseInt(document.getElementById('settingMaxTokens').value);
	const embeddingModel = document.getElementById('settingEmbeddingModel').value;

	vscode.postMessage({
		command: 'updateSettings',
		payload: { baseUrl, temperature, topP, maxTokens, embeddingModel }
	});

	settingsModal.classList.remove('active');
	showStatus('Settings saved successfully', 'success');
});

// Close modal on outside click
settingsModal.addEventListener('click', (e) => {
	if (e.target === settingsModal) {
		settingsModal.classList.remove('active');
	}
});

let modelInfos = {};
let serverVersion = null;

function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderModelDetails(model) {
	if (!modelDetails) { return; }
	if (!model) {
		modelDetails.innerHTML = '';
		return;
	}

	const info = modelInfos[model];
	if (!info) {
		modelDetails.innerHTML = '';
		return;
	}

	let html = '';
	if (info.parameter_size) {
		html += `<span style="opacity:0.8">${info.parameter_size}</span>`;
	}
	if (info.quantization_level) {
		html += html ? ' • ' : '';
		html += `<span style="opacity:0.8">${info.quantization_level}</span>`;
	}
	modelDetails.innerHTML = html || '';
}

// Message handling
window.addEventListener('message', (event) => {
	const msg = event.data;
	// allow-any-unicode-next-line
	console.log('Webview: Received message', msg.type);

	if (msg.type === 'models') {
		updateModelsUi(msg.models, msg.selectedModel, msg.embeddingModel);
		modelInfos = msg.modelInfos || {};
		serverVersion = msg.serverVersion;
		renderModelDetails(msg.selectedModel);

		// Cache in webview state
		const currentState = vscode.getState() || {};
		vscode.setState({
			...currentState,
			models: msg.models,
			selectedModel: msg.selectedModel,
			embeddingModel: msg.embeddingModel
		});
	}

	if (msg.type === 'updateFiles') {
		updateFilesUi(msg.files, msg.selectedFile);

		// Cache in webview state
		const currentState = vscode.getState() || {};
		vscode.setState({
			...currentState,
			files: msg.files,
			selectedFile: msg.selectedFile
		});
	}

	if (msg.type === 'fileSelected') {
		selectedFilePath = msg.filePath;
		selectedFileName = msg.name;
	}

	if (msg.type === 'restoreChat') {
		messagesContainer.innerHTML = '';
		msg.history.forEach(m => {
			const el = createMessageGroup(m.role, m.id);
			el.textContent = m.text;
		});
		messagesContainer.scrollTop = messagesContainer.scrollHeight;
	}

	if (msg.type === 'addMessage') {
		// Skip duplicate user message
		if (msg.role === 'user') {
			return;
		} else if (msg.role === 'assistant') {
			currentAssistantId = msg.id;
			currentAssistantEl = createMessageGroup('assistant', msg.id);
			currentAssistantEl.textContent = msg.text || '';

			// HIDE assistant box if it's currently empty
			if (!currentAssistantEl.textContent) {
				currentAssistantEl.style.display = 'none';
			}

			currentThinkingEl = null;

			// Check if we already have a thinking block for this message ID (race condition)
			if (pendingThinkingBlocks.has(msg.id)) {
				// allow-any-unicode-next-line
				console.log('🔗 Linking pending thinking block to message', msg.id);
				currentThinkingEl = pendingThinkingBlocks.get(msg.id);
				currentAssistantEl.parentElement.prepend(currentThinkingEl.parentElement);
				pendingThinkingBlocks.delete(msg.id);
			}
		}
	}

	if (msg.type === 'streamDelta') {
		if (currentAssistantEl && currentAssistantId === msg.id) {
			// Ensure box is visible when actual content starts arriving
			if (currentAssistantEl.style.display === 'none') {
				currentAssistantEl.style.display = 'block';
			}
			currentAssistantEl.textContent += msg.text;
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	if (msg.type === 'thinkingStart') {
		// allow-any-unicode-next-line
		console.log('🧠 Thinking Start for', msg.id);
		if (currentAssistantEl && currentAssistantId === msg.id) {
			const parent = currentAssistantEl.parentElement;
			currentThinkingEl = createThinkingBlock(parent);
		} else {
			const tempParent = document.createElement('div');
			const blockContent = createThinkingBlock(tempParent);
			pendingThinkingBlocks.set(msg.id, blockContent);
		}

		// START TIMER
		thinkingStartTimestamp = Date.now();
		if (thinkingInterval) { clearInterval(thinkingInterval); }
		thinkingInterval = setInterval(() => {
			const elapsed = Date.now() - thinkingStartTimestamp;
			const mins = Math.floor(elapsed / 60000).toString().padStart(2, '0');
			const secs = Math.floor((elapsed % 60000) / 1000).toString().padStart(2, '0');
			// Update current block (might be pending or active)
			const timerEl = (currentThinkingEl ? currentThinkingEl.parentElement : pendingThinkingBlocks.get(msg.id)).querySelector('.timer');
			if (timerEl) { timerEl.textContent = `${mins}:${secs}`; }
		}, 1000);

		messagesContainer.scrollTop = messagesContainer.scrollHeight;
	}

	if (msg.type === 'thinkingUpdate') {
		if (!currentThinkingEl && currentAssistantEl) {
			currentThinkingEl = createThinkingBlock(currentAssistantEl.parentElement);
		}

		if (currentThinkingEl) {
			currentThinkingEl.textContent += msg.text;

			// AUTO SCROLL if user hasn't scrolled up
			if (!currentThinkingEl.isUserScrolling) {
				currentThinkingEl.scrollTop = currentThinkingEl.scrollHeight;
			}

			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		} else {
			// Second Fallback to status
			// allow-any-unicode-next-line
			const thinkingStatus = msg.text ? `🤔 Thinking: ${msg.text.substring(0, 50)}...` : '🤔 Model is thinking...';
			showStatus(thinkingStatus, 'info');
		}
	}

	if (msg.type === 'thinkingEnd') {
		if (thinkingInterval) {
			clearInterval(thinkingInterval);
			thinkingInterval = null;
		}

		if (currentThinkingEl) {
			const block = currentThinkingEl.parentElement;
			block.classList.add('collapsed');
			currentThinkingEl = null; // Clear active thinking reference
		}

		// SHOW the assistant box now that thinking is over
		if (currentAssistantEl) {
			currentAssistantEl.style.display = 'block';
		}

		// Clear thinking status after a delay
		setTimeout(() => {
			if (statusEl && (statusEl.textContent.includes('Thinking') || statusEl.textContent.includes('analyzing'))) {
				statusEl.style.display = 'none';
			}
		}, 1000);
	}

	if (msg.type === 'createRequest') {
		if (currentAssistantEl) {
			const parent = currentAssistantEl.parentElement;

			// Clean up the text by removing the raw JSON block and any variety of tags
			let text = currentAssistantEl.textContent || '';
			const cleanRegex = /(?:\[CREATE_FILES\]|###\s*CREATE_FILES|CREATE_FILES:|\[\/CREATE_FILES\]|<\/CREATE_FILES>)/gi;
			text = text.split(/\[CREATE_FILES\]|###\s*CREATE_FILES|CREATE_FILES:/i)[0].trim();
			currentAssistantEl.textContent = text;

			const container = document.createElement('div');
			container.className = 'create-files-request';
			container.style.marginTop = '12px';
			container.style.padding = '12px';
			container.style.border = '1px dashed var(--vscode-button-background)';
			container.style.borderRadius = '6px';
			container.style.backgroundColor = 'rgba(0,0,0,0.1)';

			const title = document.createElement('div');
			title.style.fontWeight = 'bold';
			// allow-any-unicode-next-line
			title.textContent = '📂 New File Creation Request';
			container.appendChild(title);

			const list = document.createElement('div');
			list.style.margin = '8px 0';
			list.style.fontSize = '0.9em';

			let hasNewFiles = false;
			msg.files.forEach(f => {
				const item = document.createElement('div');
				item.style.display = 'flex';
				item.style.justifyContent = 'space-between';
				item.style.alignItems = 'center';
				item.style.margin = '4px 0';

				const pathSpan = document.createElement('span');
				pathSpan.textContent = `• ${f.path}`;
				if (f.exists) {
					pathSpan.style.color = 'var(--vscode-charts-orange)';
					pathSpan.textContent += ' (Exists)';
				} else {
					hasNewFiles = true;
				}
				item.appendChild(pathSpan);

				if (f.exists) {
					const mergeBtn = document.createElement('button');
					mergeBtn.textContent = 'Merge';
					mergeBtn.style.padding = '2px 8px';
					mergeBtn.style.fontSize = '10px';
					mergeBtn.onclick = () => {
						vscode.postMessage({
							command: 'mergeFile',
							payload: { id: msg.id, path: f.path, content: f.content }
						});
						item.style.opacity = '0.5';
						mergeBtn.disabled = true;
					};
					item.appendChild(mergeBtn);
				}
				list.appendChild(item);
			});
			container.appendChild(list);

			const btnContainer = document.createElement('div');
			btnContainer.style.display = 'flex';
			btnContainer.style.gap = '8px';

			const createBtn = document.createElement('button');
			createBtn.textContent = 'Create Files';
			if (!hasNewFiles) {
				createBtn.disabled = true;
				createBtn.style.opacity = '0.5';
				createBtn.title = 'All suggested files already exist. Use Merge for each file instead.';
			}
			createBtn.onclick = () => {
				vscode.postMessage({
					command: 'createFiles',
					payload: { files: msg.files }
				});
				container.remove();
			};

			const cancelBtn = document.createElement('button');
			cancelBtn.textContent = 'Cancel';
			cancelBtn.className = 'secondary';
			cancelBtn.onclick = () => container.remove();

			btnContainer.appendChild(createBtn);
			btnContainer.appendChild(cancelBtn);
			container.appendChild(btnContainer);

			parent.appendChild(container);
		}
	}

	if (msg.type === 'status') {
		showStatus(msg.message, msg.statusType || 'info');
	}

	if (msg.type === 'processUpdate') {
		// allow-any-unicode-next-line
		console.log('📡 Process Update:', msg.step, msg.details || '');
		showProcessUpdate(msg.step, msg.details);
	}

	if (msg.type === 'codeAvailable') {
		const codeData = {
			filePath: msg.filePath,
			code: msg.code,
			original: msg.original,
			diff: msg.diff,
			operations: msg.operations || []
		};
		codeDataMap.set(msg.id, codeData);

		if (currentAssistantEl) {
			const parent = currentAssistantEl.parentElement;

			// Keep the explanation text but remove the code block from it
			let text = currentAssistantEl.textContent || '';
			if (text.includes('```')) {
				const parts = text.split(/```[\s\S]*?```/);
				text = parts.filter(p => p.trim().length > 0).join('\n\n').trim();
				currentAssistantEl.textContent = text;
			}

			if (!text || text.trim().length === 0) {
				currentAssistantEl.style.display = 'none';
			} else {
				currentAssistantEl.style.display = 'block';
			}

			// Create diff view
			const diff = document.createElement('div');
			diff.className = 'code-diff';

			let diffLines = [];
			if (msg.diff) {
				diffLines = parseUnifiedDiff(msg.diff);
			} else if (msg.original && msg.code) {
				diffLines = computeLineDiff(msg.original, msg.code);
			}

			diffLines.forEach((line, idx) => {
				const span = document.createElement('span');
				span.className = 'diff-line';
				const displayLineNum = line.lineNumber || (idx + 1);
				span.setAttribute('data-line-num', displayLineNum);

				let content = typeof line === 'string' ? line : (line.text || String(line));
				if (line.type === 'added') { span.classList.add('diff-added'); }
				else if (line.type === 'removed') { span.classList.add('diff-removed'); }

				if (typeof content === 'string') {
					if (content.startsWith('+') && !content.startsWith('+++')) { content = content.substring(1); }
					else if (content.startsWith('-') && !content.startsWith('---')) { content = content.substring(1); }
					else if (content.startsWith(' ')) { content = content.substring(1); }
				}

				span.textContent = content;
				diff.appendChild(span);
			});

			const actionsWrapper = document.createElement('div');
			actionsWrapper.style.padding = '12px 16px';
			actionsWrapper.style.borderTop = '1px solid var(--border)';
			actionsWrapper.style.display = 'flex';
			actionsWrapper.style.gap = '8px';

			const actions = document.createElement('div');
			actions.className = 'code-action-buttons';

			const applyBtn = document.createElement('button');
			// allow-any-unicode-next-line
			applyBtn.textContent = '✓ Apply Changes';
			applyBtn.dataset.action = 'apply';
			applyBtn.className = 'apply-btn';
			applyBtn.style.flex = '1';

			const discardBtn = document.createElement('button');
			// allow-any-unicode-next-line
			discardBtn.textContent = '✗ Discard';
			discardBtn.dataset.action = 'discard';
			discardBtn.className = 'discard-btn';

			actions.appendChild(applyBtn);
			actions.appendChild(discardBtn);
			actionsWrapper.appendChild(actions);

			parent.appendChild(diff);
			parent.appendChild(actionsWrapper);
		}
		return;
	}

	if (msg.type === 'streamError') {
		showError(msg.error);
		if (currentAssistantEl) {
			// allow-any-unicode-next-line
			currentAssistantEl.textContent = '❌ Error: ' + msg.error;
			currentAssistantEl.style.color = 'var(--vscode-errorForeground)';
		}
		currentAssistantId = null;
		currentAssistantEl = null;
		return;
	}

	if (msg.type === 'fileWriteSuccess') {
		showStatus('✓ Code applied successfully!', 'success');
	}

	if (msg.type === 'applyCodeSuccess') {
		showStatus(msg.message, 'success');
	}

	if (msg.type === 'applyCodeError') {
		showError(msg.error);
	}

	if (msg.type === 'tokenUsage') {
		if (tokenUsageEl && msg.tokens) {
			const { input, output, total } = msg.tokens;
			tokenUsageEl.textContent = `Tokens: ${total.toLocaleString()} (In: ${input.toLocaleString()}, Out: ${output.toLocaleString()})`;
		}
	}

	if (msg.type === 'settings') {
		document.getElementById('settingBaseUrl').value = msg.baseUrl || '';
		document.getElementById('settingTemperature').value = msg.temperature || 0.7;
		document.getElementById('settingTopP').value = msg.topP || 0.9;
		document.getElementById('settingMaxTokens').value = msg.maxTokens || 2048;
		lastEmbeddingModel = msg.embeddingModel || '';
		const embeddingSelector = document.getElementById('settingEmbeddingModel');
		if (embeddingSelector) {
			embeddingSelector.value = lastEmbeddingModel;
		}
	}
});

// Event delegation for code action buttons
messagesContainer.addEventListener('click', (e) => {
	if (e.target.dataset.action === 'apply') {
		const parent = e.target.closest('.message-group');
		if (!parent) { return; }

		const msgId = parent.dataset.id;
		const codeData = codeDataMap.get(msgId);
		if (!codeData || !codeData.filePath) {
			console.error('No code data for message', msgId);
			return;
		}

		// Validate that we have something to apply (operations, diff, or code)
		if (!Array.isArray(codeData.operations)) {
			codeData.operations = [];
		}

		const hasOperations = codeData.operations.length > 0;
		const hasDiff = codeData.diff && codeData.diff.length > 0;
		const hasCode = codeData.code && codeData.code.length > 0;

		if (!hasOperations && !hasDiff && !hasCode) {
			console.error('Apply failed: no changes available');
			showError('No changes available to apply');
			return;
		}

		// Send apply message with both operations and diff for fallback
		const applyMessage = {
			command: 'writeToFile',
			payload: {
				filePath: codeData.filePath,
				operations: codeData.operations,
				diff: codeData.diff,
				original: codeData.original,
				code: codeData.code
			}
		};
		// allow-any-unicode-next-line
		console.log('📤 Sending apply message with', codeData.operations.length, 'operations and fallback diff/code');
		vscode.postMessage(applyMessage);

		// HIDE APPLY BUTTON AND CHANGE DISCARD TO UNDO
		const applyBtn = parent.querySelector('.apply-btn');
		const discardBtn = parent.querySelector('.discard-btn');
		if (applyBtn) { applyBtn.style.display = 'none'; }
		if (discardBtn) {
			// allow-any-unicode-next-line
			discardBtn.textContent = '↶ Undo';
			discardBtn.dataset.action = 'undo';
			// Store original content for this specific message
			originalContents.set(msgId, {
				filePath: codeData.filePath,
				original: codeData.original
			});
		}

		// Show processing status
		showStatus('Applying changes...', 'info');
	} else if (e.target.dataset.action === 'undo') {
		const parent = e.target.closest('.message-group');
		if (parent && originalContents.has(parent.dataset.id)) {
			const { filePath, original } = originalContents.get(parent.dataset.id);

			// Send undo message (just write original back)
			vscode.postMessage({
				command: 'writeToFile',
				payload: {
					filePath: filePath,
					code: original // Write back the original content
				}
			});

			// RESTORE BUTTONS
			const applyBtn = parent.querySelector('.apply-btn');
			const discardBtn = parent.querySelector('.discard-btn');
			if (applyBtn) { applyBtn.style.display = 'inline-block'; }
			if (discardBtn) {
				// allow-any-unicode-next-line
				discardBtn.textContent = '✗ Discard';
				discardBtn.dataset.action = 'discard';
			}
			originalContents.delete(parent.dataset.id);
			showStatus('Changes reverted', 'info');
		}
	} else if (e.target.dataset.action === 'discard') {
		const parent = e.target.closest('.message-group');
		if (parent) {
			const diff = parent.querySelector('.code-diff');
			const actions = parent.querySelector('.code-action-buttons');
			const actionsWrapper = actions ? actions.parentElement : null;
			if (diff) { diff.remove(); }
			if (actionsWrapper) { actionsWrapper.remove(); }

			const msgId = parent.dataset.id;
			codeDataMap.delete(msgId);
			originalContents.delete(msgId);
		}
	}
});

function computeLineDiff(oldStr, newStr) {
	const oldLines = oldStr.split('\n');
	const newLines = newStr.split('\n');
	const result = [];
	let oldIdx = 0;
	let newIdx = 0;

	while (oldIdx < oldLines.length || newIdx < newLines.length) {
		if (oldIdx >= oldLines.length) {
			result.push({ type: 'added', text: '+' + newLines[newIdx] });
			newIdx++;
		} else if (newIdx >= newLines.length) {
			result.push({ type: 'removed', text: '-' + oldLines[oldIdx] });
			oldIdx++;
		} else if (oldLines[oldIdx] === newLines[newIdx]) {
			result.push({ type: 'unchanged', text: ' ' + oldLines[oldIdx] });
			oldIdx++;
			newIdx++;
		} else {
			// Try to find matching line ahead
			let found = false;
			for (let i = oldIdx + 1; i < Math.min(oldIdx + 10, oldLines.length); i++) {
				if (oldLines[i] === newLines[newIdx]) {
					for (let j = oldIdx; j < i; j++) {
						result.push({ type: 'removed', text: '-' + oldLines[j] });
					}
					oldIdx = i;
					found = true;
					break;
				}
			}
			if (!found) {
				result.push({ type: 'added', text: '+' + newLines[newIdx] });
				newIdx++;
			}
		}
	}

	return result;
}
/**
 * Parse unified diff format and extract lines with type information.
 * Handles diff hunks with line numbers and context.
 */
function parseUnifiedDiff(diffContent) {
	const lines = diffContent.split('\n');
	const result = [];
	let currentOriginalLine = 0; // Track current line number from original file
	let currentNewLine = 0; // Track current line number for new file

	for (const line of lines) {
		// Skip file headers
		if (line.startsWith('---') || line.startsWith('+++')) {
			continue;
		}

		// Parse hunk headers to extract line numbers
		if (line.startsWith('@@')) {
			const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
			if (match) {
				currentOriginalLine = parseInt(match[1], 10);
				currentNewLine = parseInt(match[3], 10);
			}
			continue;
		}

		if (line.startsWith('+')) {
			result.push({
				type: 'added',
				text: line.substring(1),
				lineNumber: currentNewLine
			});
			currentNewLine++;
		} else if (line.startsWith('-')) {
			result.push({
				type: 'removed',
				text: line.substring(1),
				lineNumber: currentOriginalLine
			});
			currentOriginalLine++;
		} else if (line.startsWith(' ') || line === '') {
			result.push({
				type: 'unchanged',
				text: line.startsWith(' ') ? line.substring(1) : '',
				lineNumber: currentOriginalLine
			});
			currentOriginalLine++;
			currentNewLine++;
		}
	}

	return result;
}

function updateModelsUi(models, selectedModel, embeddingModel) {
	if (!modelSelector) { return; }
	modelSelector.innerHTML = '<option value="">Select a model...</option>';
	if (models) {
		models.forEach(m => {
			const opt = document.createElement('option');
			opt.value = m;
			opt.textContent = m;
			if (m === selectedModel) { opt.selected = true; }
			modelSelector.appendChild(opt);
		});
	}
	const embeddingSelector = document.getElementById('settingEmbeddingModel');
	if (embeddingSelector) {
		embeddingSelector.innerHTML = '<option value="">Select an embedding model...</option>';
		if (models) {
			models.forEach(m => {
				const opt = document.createElement('option');
				opt.value = m;
				opt.textContent = m;
				if (m === embeddingModel || m === lastEmbeddingModel) { opt.selected = true; }
				embeddingSelector.appendChild(opt);
			});
		}
		// Second pass to ensure value is set if it was added
		if (embeddingModel) { embeddingSelector.value = embeddingModel; }
		else if (lastEmbeddingModel) { embeddingSelector.value = lastEmbeddingModel; }
	}
}

function updateFilesUi(files, selectedFile) {
	if (!fileSelector) { return; }
	fileSelector.innerHTML = '<option value="">No file selected</option>';
	if (files) {
		files.forEach(f => {
			const opt = document.createElement('option');
			opt.value = f.path;
			opt.textContent = `${f.name} (${f.language})`;
			if (f.path === selectedFile) {
				opt.selected = true;
				selectedFilePath = f.path;
				selectedFileName = f.name;
			}
			fileSelector.appendChild(opt);
		});
	}
}


// allow-any-unicode-next-line
