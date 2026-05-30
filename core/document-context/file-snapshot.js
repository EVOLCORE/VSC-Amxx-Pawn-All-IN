const {
    createLineIndexCore,
    isBodyDeclarationContextChangeLine
} = require('../syntax/line-index');
const {
    buildLineStartOffsets,
    splitPawnLines
} = require('../syntax/lines');

const defaultLineIndexCore = createLineIndexCore();

function createFileSnapshotCore(deps) {
    const {
        normalizeFsPath,
        fileSnapshotCache,
        getCtrlCharStateForContent,
        computeLineDepths,
        buildLineIndex = defaultLineIndexCore.buildLineIndex
    } = deps;

    const MAX_SNAPSHOTS_PER_FILE = 4;
    const {
        LINE_FLAG_HAS_COMMENT_SIG,
        LINE_FLAG_HAS_LINE_COMMENT_SIG,
        LINE_FLAG_HAS_BLOCK_COMMENT_SIG,
        LINE_FLAG_HAS_DIRECTIVE_SIG,
        LINE_FLAG_HAS_BRACE_SIG,
        LINE_FLAG_HAS_PAREN_SIG,
        LINE_FLAG_HAS_BRACKET_SIG,
        LINE_FLAG_POTENTIAL_TOP_LEVEL_CONTEXT_CHANGE,
        LINE_FLAG_POTENTIAL_BODY_CONTEXT_CHANGE
    } = defaultLineIndexCore;

    function createSnapshot(filePath, content, initialCtrlCharState = null, initialRawLines = null) {
        const sourceText = String(content || '');
        const rawLines = Array.isArray(initialRawLines)
            ? initialRawLines
            : splitPawnLines(sourceText);
        let ctrlCharState = initialCtrlCharState || null;
        let lineIndex = null;
        let lineStartOffsets = null;
        let bodyDeclarationContextChangeFlags = null;

        const snapshot = {
            filePath,
            content: sourceText,
            rawLines,
            hydrateCtrlCharState(state) {
                if (state && !ctrlCharState) {
                    ctrlCharState = state;
                }
            }
        };

        Object.defineProperties(snapshot, {
            ctrlCharState: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!ctrlCharState) {
                        const hasCommentSyntax = sourceText.includes('//') || sourceText.includes('/*');
                        const hasDirectiveSyntax = sourceText.includes('#');
                        if ((hasCommentSyntax || hasDirectiveSyntax) && !lineIndex) {
                            lineIndex = buildLineIndex(rawLines);
                        }
                        ctrlCharState = getCtrlCharStateForContent(
                            sourceText,
                            filePath,
                            null,
                            rawLines,
                            [],
                            lineIndex
                        );
                    }
                    return ctrlCharState;
                }
            },
            strippedLines: {
                enumerable: true,
                configurable: true,
                get() {
                    return snapshot.ctrlCharState.strippedLines || rawLines;
                }
            },
            lineCtrlChars: {
                enumerable: true,
                configurable: true,
                get() {
                    return snapshot.ctrlCharState.lineCtrlChars || [];
                }
            },
            finalCtrlChar: {
                enumerable: true,
                configurable: true,
                get() {
                    return snapshot.ctrlCharState.finalCtrlChar;
                }
            },
            lineDepths: {
                enumerable: true,
                configurable: true,
                get() {
                    const state = snapshot.ctrlCharState;
                    if (!state.lineDepths) {
                        state.lineDepths = computeLineDepths(
                            snapshot.strippedLines,
                            snapshot.lineCtrlChars,
                            lineIndex
                        );
                    }
                    return state.lineDepths;
                }
            },
            lineIndex: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!lineIndex) {
                        lineIndex = buildLineIndex(rawLines);
                    }
                    return lineIndex;
                }
            },
            lineStartOffsets: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!lineStartOffsets) {
                        lineStartOffsets = buildLineStartOffsets(sourceText);
                    }
                    return lineStartOffsets;
                }
            },
            bodyDeclarationContextChangeFlags: {
                enumerable: true,
                configurable: true,
                get() {
                    if (!bodyDeclarationContextChangeFlags) {
                        const flags = new Uint8Array(rawLines.length);
                        const strippedLines = snapshot.strippedLines || rawLines;
                        const candidates = snapshot.lineIndex.bodyDeclarationCandidateLines || [];
                        for (const line of candidates) {
                            if (line < 0 || line >= rawLines.length) continue;
                            if (isBodyDeclarationContextChangeLine(strippedLines[line] || rawLines[line] || '')) {
                                flags[line] = 1;
                            }
                        }
                        bodyDeclarationContextChangeFlags = flags;
                    }
                    return bodyDeclarationContextChangeFlags;
                }
            }
        });

        return snapshot;
    }

    function getFileSnapshot(filePath, content, options = {}) {
        const sourceText = String(content || '');
        const normalizedPath = normalizeFsPath(filePath);
        const initialCtrlCharState = options.ctrlCharState || null;
        const initialRawLines = Array.isArray(options.rawLines) ? options.rawLines : null;

        if (!normalizedPath) {
            return createSnapshot(filePath, sourceText, initialCtrlCharState, initialRawLines);
        }

        const entries = fileSnapshotCache.get(normalizedPath) || [];
        for (const entry of entries) {
            if (entry.content !== sourceText) continue;
            entry.snapshot.hydrateCtrlCharState(initialCtrlCharState);
            return entry.snapshot;
        }

        const snapshot = createSnapshot(filePath, sourceText, initialCtrlCharState, initialRawLines);
        const nextEntries = entries.filter(entry => entry.content !== sourceText);
        nextEntries.unshift({ content: sourceText, snapshot });
        fileSnapshotCache.set(normalizedPath, nextEntries.slice(0, MAX_SNAPSHOTS_PER_FILE));
        return snapshot;
    }

    function clearFileSnapshotCacheForFile(filePath = '') {
        const normalizedPath = normalizeFsPath(filePath);
        if (!normalizedPath) return;
        fileSnapshotCache.delete(normalizedPath);
    }

    return {
        getFileSnapshot,
        clearFileSnapshotCacheForFile,
        LINE_FLAG_HAS_COMMENT_SIG,
        LINE_FLAG_HAS_LINE_COMMENT_SIG,
        LINE_FLAG_HAS_BLOCK_COMMENT_SIG,
        LINE_FLAG_HAS_DIRECTIVE_SIG,
        LINE_FLAG_HAS_BRACE_SIG,
        LINE_FLAG_HAS_PAREN_SIG,
        LINE_FLAG_HAS_BRACKET_SIG,
        LINE_FLAG_POTENTIAL_TOP_LEVEL_CONTEXT_CHANGE,
        LINE_FLAG_POTENTIAL_BODY_CONTEXT_CHANGE
    };
}

module.exports = { createFileSnapshotCore };
