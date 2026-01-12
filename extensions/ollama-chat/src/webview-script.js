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
let currentCodeData = null;
let selectedFilePath = '';
let selectedFileName = '';

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

	vscode.postMessage({
		command: 'updateSettings',
		payload: { baseUrl, temperature, topP, maxTokens }
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

	if (msg.type === 'models') {
		modelSelector.innerHTML = '<option value="">Select a model...</option>';
		msg.models.forEach(m => {
			const opt = document.createElement('option');
			opt.value = m;
			opt.textContent = m;
			if (m === msg.selectedModel) { opt.selected = true; }
			modelSelector.appendChild(opt);
		});
		modelInfos = msg.modelInfos || {};
		serverVersion = msg.serverVersion;
		renderModelDetails(msg.selectedModel);
	}

	if (msg.type === 'updateFiles') {
		fileSelector.innerHTML = '<option value="">No file selected</option>';
		msg.files.forEach(f => {
			const opt = document.createElement('option');
			opt.value = f.path;
			opt.textContent = `${f.name} (${f.language})`;
			if (f.path === msg.selectedFile) {
				opt.selected = true;
				selectedFilePath = f.path;
				selectedFileName = f.name;
			}
			fileSelector.appendChild(opt);
		});
	}

	if (msg.type === 'fileSelected') {
		selectedFilePath = msg.filePath;
		selectedFileName = msg.name;
	}

	if (msg.type === 'addMessage') {
		// Skip duplicate user message (already shown in sendPrompt)
		if (msg.role === 'user') {
			return;  // User message already displayed in UI
		} else if (msg.role === 'assistant') {
			currentAssistantId = msg.id;
			currentAssistantEl = createMessageGroup('assistant', msg.id);
			currentAssistantEl.textContent = msg.text || '';
		}
	}

	if (msg.type === 'streamDelta') {
		if (currentAssistantEl && currentAssistantId === msg.id) {
			currentAssistantEl.textContent += msg.text;
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	if (msg.type === 'thinkingStart') {
		// allow-any-unicode-next-line
		showStatus(msg.message || '🤔 Model is thinking...', 'info');
	}

	if (msg.type === 'thinkingUpdate') {
		// Update status with thinking progress
		// allow-any-unicode-next-line
		const thinkingStatus = msg.text ? `🤔 Thinking: ${msg.text.substring(0, 50)}...` : '🤔 Model is thinking...';
		showStatus(thinkingStatus, 'info');
	}

	if (msg.type === 'thinkingEnd') {
		// Clear thinking status after a delay
		setTimeout(() => {
			if (statusEl && (statusEl.textContent.includes('Thinking') || statusEl.textContent.includes('analyzing'))) {
				statusEl.style.display = 'none';
			}
		}, 1000);
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
		currentCodeData = {
			filePath: msg.filePath,
			code: msg.code,
			original: msg.original,
			diff: msg.diff,
			operations: msg.operations || []
		};

		if (currentAssistantEl) {
			const parent = currentAssistantEl.parentElement;

			// Clear the assistant message content - we'll show only the diff
			currentAssistantEl.textContent = '';

			// Create diff view with modern styling
			const diff = document.createElement('div');
			diff.className = 'code-diff';

			// If we have a diff, show it; otherwise compute from code
			let diffLines = [];
			if (msg.diff) {
				// Parse unified diff format
				diffLines = parseUnifiedDiff(msg.diff);
			} else if (msg.original && msg.code) {
				// Compute diff from original and new code
				diffLines = computeLineDiff(msg.original, msg.code);
			}

			// Render diff lines with proper styling
			diffLines.forEach((line, idx) => {
				const span = document.createElement('span');
				span.className = 'diff-line';

				// Use actual line number from diff, or fallback to index
				const displayLineNum = line.lineNumber || (idx + 1);
				span.setAttribute('data-line-num', displayLineNum);

				// Ensure content is a string
				let content = typeof line === 'string' ? line : (line.text || String(line));

				if (line.type === 'added') {
					span.classList.add('diff-added');
				} else if (line.type === 'removed') {
					span.classList.add('diff-removed');
				}

				// Handle diff prefix characters
				if (typeof content === 'string') {
					if (content.startsWith('+') && !content.startsWith('+++')) {
						content = content.substring(1);
					} else if (content.startsWith('-') && !content.startsWith('---')) {
						content = content.substring(1);
					} else if (content.startsWith(' ')) {
						content = content.substring(1);
					}
				}

				span.textContent = content;
				diff.appendChild(span);
			});

			// Create wrapper for buttons with better styling
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
			applyBtn.style.flex = '1';

			const discardBtn = document.createElement('button');
			// allow-any-unicode-next-line
			discardBtn.textContent = '✗ Discard';
			discardBtn.dataset.action = 'discard';

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
		currentCodeData = null;
	}

	if (msg.type === 'applyCodeSuccess') {
		showStatus(msg.message, 'success');
		currentCodeData = null;
	}

	if (msg.type === 'applyCodeError') {
		showError(msg.error);
		currentCodeData = null;
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
	}
});

// Event delegation for code action buttons
messagesContainer.addEventListener('click', (e) => {
	if (e.target.dataset.action === 'apply') {
		if (!currentCodeData || !currentCodeData.filePath) { return; }

		// Validate that we have something to apply (operations, diff, or code)
		if (!Array.isArray(currentCodeData.operations)) {
			currentCodeData.operations = [];
		}

		const hasOperations = currentCodeData.operations.length > 0;
		const hasDiff = currentCodeData.diff && currentCodeData.diff.length > 0;
		const hasCode = currentCodeData.code && currentCodeData.code.length > 0;

		if (!hasOperations && !hasDiff && !hasCode) {
			console.error('Apply failed: no changes available');
			showError('No changes available to apply');
			return;
		}

		// Send apply message with both operations and diff for fallback
		const applyMessage = {
			command: 'writeToFile',
			payload: {
				filePath: currentCodeData.filePath,
				operations: currentCodeData.operations,
				diff: currentCodeData.diff,
				original: currentCodeData.original,
				code: currentCodeData.code
			}
		};
		// allow-any-unicode-next-line
		console.log('📤 Sending apply message with', currentCodeData.operations.length, 'operations and fallback diff/code');
		vscode.postMessage(applyMessage);

		// Show processing status
		showStatus('Applying changes...', 'info');
		e.target.disabled = true;
	} else if (e.target.dataset.action === 'discard') {
		if (currentCodeData && currentAssistantEl) {
			const parent = currentAssistantEl.closest('.message-group');
			if (parent) {
				const diff = parent.querySelector('.code-diff');
				const actions = parent.querySelector('.code-action-buttons');
				if (diff) { diff.remove(); }
				if (actions) { actions.remove(); }
			}
			currentCodeData = null;
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

// allow-any-unicode-next-line
