/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface RepositoryContext {
	projectName: string;
	rootPath: string;
	techStack: TechStackInfo;
	projectStructure: ProjectStructure;
	codingStandards: CodingStandards;
	timestamp: string;
}

export interface TechStackInfo {
	languages: string[];
	frameworks: string[];
	buildTools: string[];
	dependencies: Record<string, string>;
}

export interface ProjectStructure {
	patterns: string[]; // e.g., 'MVC', 'Monolith'
	layers: string[];   // e.g., 'frontend', 'backend', 'shared'
	entryPoints: string[];
}

export interface CodingStandards {
	hasLinting: boolean;
	hasFormatting: boolean;
	hasTests: boolean;
	testFrameworks: string[];
}

export async function analyzeRepository(rootPath: string, llmConfig?: { baseUrl: string; model: string }): Promise<RepositoryContext> {
	let techStack = await detectTechStack(rootPath);
	let projectStructure = await detectProjectStructure(rootPath);
	const codingStandards = await detectCodingStandards(rootPath, techStack.dependencies);

	// If LLM is available, use it to refine the analysis
	if (llmConfig && llmConfig.model) {
		try {
			const refined = await refineAnalysisWithLLM(rootPath, techStack, projectStructure, llmConfig);
			techStack = refined.techStack;
			projectStructure = refined.projectStructure;
		} catch (e) {
			console.error('Ollama: LLM Refinement failed', e);
		}
	}

	return {
		projectName: path.basename(rootPath),
		rootPath,
		techStack,
		projectStructure,
		codingStandards,
		timestamp: new Date().toISOString()
	};
}

async function refineAnalysisWithLLM(rootPath: string, currentStack: TechStackInfo, currentStruct: ProjectStructure, config: { baseUrl: string; model: string }) {
	// Gather more context for the LLM
	const files = await vscode.workspace.findFiles('**/*.{py,ts,js,go,rs,java,toml,yaml,json}', '**/node_modules/**', 20);
	let fileContext = 'Top level files and their content snippets:\n';

	for (const file of files.slice(0, 10)) {
		try {
			const content = fs.readFileSync(file.fsPath, 'utf8').substring(0, 2000);
			fileContext += `\nFile: ${path.relative(rootPath, file.fsPath)}\nContent:\n${content}\n---\n`;
		} catch (e) { }
	}

	const prompt = `Observe the following project files and structure. Provide a JSON summary of the project.
	Current Detection:
	Languages: ${currentStack.languages.join(', ')}
	Frameworks: ${currentStack.frameworks.join(', ')}

	Files Context:
	${fileContext}

	Respond ONLY with a JSON object in this format:
	{
	"techStack": { "languages": [], "frameworks": [], "buildTools": [] },
	"projectStructure": { "patterns": [], "layers": [] }
	}`;

	const response = await fetch(`${config.baseUrl}/api/generate`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model: config.model,
			prompt: prompt,
			stream: false,
			format: 'json'
		})
	});

	if (!response.ok) { throw new Error('LLM analysis failed'); }
	const data = await response.json() as { response: string };
	const result = JSON.parse(data.response);

	return {
		techStack: {
			...currentStack,
			languages: Array.from(new Set([...currentStack.languages, ...(result.techStack?.languages || [])])),
			frameworks: Array.from(new Set([...currentStack.frameworks, ...(result.techStack?.frameworks || [])])),
			buildTools: Array.from(new Set([...currentStack.buildTools, ...(result.techStack?.buildTools || [])]))
		},
		projectStructure: {
			...currentStruct,
			patterns: Array.from(new Set([...currentStruct.patterns, ...(result.projectStructure?.patterns || [])])),
			layers: Array.from(new Set([...currentStruct.layers, ...(result.projectStructure?.layers || [])]))
		}
	};
}

async function detectTechStack(rootPath: string): Promise<TechStackInfo> {
	const info: TechStackInfo = {
		languages: [],
		frameworks: [],
		buildTools: [],
		dependencies: {}
	};

	// 1. Analyze package.json (Node.js)
	const pkgJsonPath = path.join(rootPath, 'package.json');
	if (fs.existsSync(pkgJsonPath)) {
		info.languages.push('TypeScript/JavaScript');
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
			const deps = { ...pkg.dependencies, ...pkg.devDependencies };
			info.dependencies = deps;

			// Detect Frameworks
			if (deps['react']) { info.frameworks.push('React'); }
			if (deps['vue']) { info.frameworks.push('Vue'); }
			if (deps['@angular/core']) { info.frameworks.push('Angular'); }
			if (deps['next']) { info.frameworks.push('Next.js'); }
			if (deps['express']) { info.frameworks.push('Express'); }
			if (deps['@nestjs/core']) { info.frameworks.push('NestJS'); }

			// Detect Build Tools
			if (deps['webpack']) { info.buildTools.push('Webpack'); }
			if (deps['vite']) { info.buildTools.push('Vite'); }
			if (deps['typescript']) { info.buildTools.push('TypeScript'); }
		} catch (e) { console.error('Error parsing package.json', e); }
	}

	// 2. Analyze requirements.txt (Python)
	const reqPath = path.join(rootPath, 'requirements.txt');
	if (fs.existsSync(reqPath)) {
		info.languages.push('Python');
		const content = fs.readFileSync(reqPath, 'utf8');
		if (content.includes('django')) { info.frameworks.push('Django'); }
		if (content.includes('flask')) { info.frameworks.push('Flask'); }
		if (content.includes('fastapi')) { info.frameworks.push('FastAPI'); }
	}

	// 3. Detect Go, Rust, etc. via file extensions
	const files = await vscode.workspace.findFiles('**/*.{go,rs,java,cs,php}', '**/node_modules/**', 10);
	for (const file of files) {
		const ext = path.extname(file.fsPath);
		if (ext === '.go' && !info.languages.includes('Go')) { info.languages.push('Go'); }
		if (ext === '.rs' && !info.languages.includes('Rust')) { info.languages.push('Rust'); }
		if (ext === '.java' && !info.languages.includes('Java')) { info.languages.push('Java'); }
	}

	return info;
}

async function detectProjectStructure(rootPath: string): Promise<ProjectStructure> {
	const struct: ProjectStructure = { patterns: [], layers: [], entryPoints: [] };

	// Check directories for Architecture Patterns
	let dirs: string[] = [];
	try {
		const items = await fs.promises.readdir(rootPath);
		dirs = items.filter(f => {
			try {
				return fs.statSync(path.join(rootPath, f)).isDirectory();
			} catch {
				return false;
			}
		});
	} catch (e) {
		console.error('Error reading repository root for structure:', e);
		return struct;
	}

	if (dirs.includes('src') && dirs.includes('dist')) { struct.patterns.push('Standard Source/Dist'); }
	if (dirs.includes('controllers') && dirs.includes('models') && dirs.includes('views')) { struct.patterns.push('MVC'); }
	if (dirs.includes('packages') || fs.existsSync(path.join(rootPath, 'lerna.json'))) { struct.patterns.push('Monorepo'); }

	// Detect Layers
	if (dirs.includes('client') || dirs.includes('frontend') || dirs.includes('ui')) { struct.layers.push('Frontend'); }
	if (dirs.includes('server') || dirs.includes('backend') || dirs.includes('api')) { struct.layers.push('Backend'); }
	if (dirs.includes('shared') || dirs.includes('common') || dirs.includes('lib')) { struct.layers.push('Shared Library'); }

	// Detect Entry Points
	const commonEntries = ['index.ts', 'index.js', 'main.go', 'main.rs', 'App.tsx', 'server.ts'];
	for (const entry of commonEntries) {
		if (fs.existsSync(path.join(rootPath, 'src', entry))) { struct.entryPoints.push(`src/${entry}`); }
		else if (fs.existsSync(path.join(rootPath, entry))) { struct.entryPoints.push(entry); }
	}

	return struct;
}

async function detectCodingStandards(rootPath: string, deps: Record<string, string>): Promise<CodingStandards> {
	return {
		hasLinting: !!(deps['eslint'] || fs.existsSync(path.join(rootPath, '.eslintrc')) || fs.existsSync(path.join(rootPath, '.eslintrc.json'))),
		hasFormatting: !!(deps['prettier'] || fs.existsSync(path.join(rootPath, '.prettierrc'))),
		hasTests: !!(deps['jest'] || deps['mocha'] || fs.existsSync(path.join(rootPath, 'tests'))),
		testFrameworks: Object.keys(deps).filter(d => ['jest', 'mocha', 'chai', 'jasmine', 'vitest', 'cypress'].includes(d))
	};
}
