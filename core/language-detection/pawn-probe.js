const path = require('path');
const { isPawnIncludeDirectiveCandidateLine } = require('../syntax/includes');

const DOCUMENT_LANGUAGE_DETECTION_SCAN_LIMIT = 500;

const BLOCKED_LANGUAGE_IDS = new Set([
    'c',
    'cpp',
    'cuda-cpp',
    'objective-c',
    'objective-cpp',
    'markdown',
    'mdx',
    'html',
    'xml',
    'json',
    'jsonc',
    'yaml',
    'toml',
    'ini',
    'css',
    'scss',
    'less',
    'javascript',
    'javascriptreact',
    'typescript',
    'typescriptreact',
    'powershell',
    'shellscript',
    'bat',
    'log'
]);

const BLOCKED_FILE_EXTENSIONS = new Set([
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.md',
    '.markdown',
    '.mdown',
    '.mkd',
    '.mdx',
    '.rst',
    '.adoc',
    '.html',
    '.htm',
    '.xml',
    '.json',
    '.jsonc',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.css',
    '.scss',
    '.less',
    '.js',
    '.jsx',
    '.ts',
    '.tsx',
    '.ps1',
    '.sh',
    '.bat',
    '.cmd',
    '.log'
]);

function isPawnLanguageDetectionEligibleDocument(document) {
    if (!document?.fileName) return false;
    const languageId = String(document.languageId || '').toLowerCase();
    if (languageId === 'amxxpawn') return true;
    if (BLOCKED_LANGUAGE_IDS.has(languageId)) return false;
    const ext = path.extname(String(document.fileName || '')).toLowerCase();
    return !BLOCKED_FILE_EXTENSIONS.has(ext);
}

function createPawnLanguageProbeScanState() {
    return {
        fenceMarker: ''
    };
}

function updateFenceState(lineText = '', state = createPawnLanguageProbeScanState()) {
    const trimmed = String(lineText || '').trimStart();
    const marker = trimmed.startsWith('```') ? '```' : (trimmed.startsWith('~~~') ? '~~~' : '');
    if (!marker) return false;
    if (!state.fenceMarker) {
        state.fenceMarker = marker;
    } else if (state.fenceMarker === marker) {
        state.fenceMarker = '';
    }
    return true;
}

function stripTrailingLineComment(lineText = '') {
    const text = String(lineText || '');
    let inString = false;
    let quote = '';
    for (let index = 0; index < text.length - 1; index++) {
        const char = text[index];
        if (inString) {
            if (char === '\\') {
                index++;
                continue;
            }
            if (char === quote) inString = false;
            continue;
        }
        if (char === '"' || char === "'") {
            inString = true;
            quote = char;
            continue;
        }
        if (char === '/' && text[index + 1] === '/') {
            return text.slice(0, index);
        }
    }
    return text;
}

function hasPawnLanguageSyntaxSignal(lineText = '') {
    const line = stripTrailingLineComment(lineText).trim();
    if (!line) return false;
    if (/^#\s*(tryinclude|pragma|endinput|assert)\b/i.test(line)) return true;
    if (/^(public|native|forward|stock)\b/i.test(line)) return true;
    if (/^@[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) return true;
    const declarationMatch = line.match(/^(new|const|static)\s+(?:const\s+)?(?:(?<tag>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?[A-Za-z_][A-Za-z0-9_]*(?<suffix>[\s\S]*)$/i);
    if (declarationMatch) {
        const suffix = String(declarationMatch.groups?.suffix || '').trimStart();
        if (declarationMatch.groups?.tag || /^[\[=,;]/.test(suffix)) return true;
    }
    if (/\b(Float|bool|Handle|Array|Trie|Regex|Menu|JSON|EzJSON)\s*:\s*[A-Za-z_][A-Za-z0-9_]*/.test(line)) {
        return true;
    }
    if (/^enum\b[\s\S]*(?:_?\s*:|\{|\()/i.test(line)) return true;
    if (/^#\s*define\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*%[0-9]/i.test(line)) return true;
    return false;
}

function readPawnLanguageProbeLine(lineText = '', state = createPawnLanguageProbeScanState()) {
    const fenceBoundary = updateFenceState(lineText, state);
    if (fenceBoundary || state.fenceMarker) {
        return {
            includeCandidate: false,
            syntaxSignal: false,
            inFence: !!state.fenceMarker,
            fenceBoundary
        };
    }
    return {
        includeCandidate: isPawnIncludeDirectiveCandidateLine(lineText),
        syntaxSignal: hasPawnLanguageSyntaxSignal(lineText),
        inFence: false,
        fenceBoundary: false
    };
}

function scanPawnLanguageProbeDocument(document, options = {}) {
    if (!isPawnLanguageDetectionEligibleDocument(document)) {
        return {
            eligible: false,
            includeCandidate: false,
            syntaxSignal: false
        };
    }
    const lineCount = Number.isInteger(document.lineCount) ? document.lineCount : 0;
    if (lineCount <= 0 || typeof document.lineAt !== 'function') {
        return {
            eligible: true,
            includeCandidate: false,
            syntaxSignal: false
        };
    }
    const limit = Number.isInteger(options.maxLines)
        ? Math.max(0, Math.min(lineCount, options.maxLines))
        : Math.min(lineCount, DOCUMENT_LANGUAGE_DETECTION_SCAN_LIMIT);
    const state = createPawnLanguageProbeScanState();
    let includeCandidate = false;
    let syntaxSignal = false;
    for (let lineNumber = 0; lineNumber < limit; lineNumber++) {
        const lineText = String(document.lineAt(lineNumber)?.text || '');
        const probe = readPawnLanguageProbeLine(lineText, state);
        includeCandidate = includeCandidate || probe.includeCandidate;
        syntaxSignal = syntaxSignal || probe.syntaxSignal;
        if (includeCandidate && syntaxSignal) break;
    }
    return {
        eligible: true,
        includeCandidate,
        syntaxSignal
    };
}

function hasPawnLanguageProbeCandidates(document, options = {}) {
    const result = scanPawnLanguageProbeDocument(document, options);
    return !!(result.eligible && result.includeCandidate && result.syntaxSignal);
}

module.exports = {
    DOCUMENT_LANGUAGE_DETECTION_SCAN_LIMIT,
    createPawnLanguageProbeScanState,
    hasPawnLanguageProbeCandidates,
    hasPawnLanguageSyntaxSignal,
    isPawnLanguageDetectionEligibleDocument,
    readPawnLanguageProbeLine,
    scanPawnLanguageProbeDocument
};
