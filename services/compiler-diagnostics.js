function createCompilerDiagnosticService(deps) {
    const {
        fs,
        isIdentifierBoundaryChar,
        isPawnDocumentForCompilerDiagnosticInvalidation,
        LIVE_VALIDATION_DIAGNOSTIC_SOURCE,
        normalizeCompilerFsPath,
        path,
        shouldPublishCompilerErrorDiagnostics,
        vscode
    } = deps;

    function createIssueRange(lineNumber, endLineNumber = null) {
        const startLine = Math.max(0, Number(lineNumber || 1) - 1);
        const endLine = Math.max(startLine, Number(endLineNumber || lineNumber || 1) - 1);
        return new vscode.Range(startLine, 0, endLine, 1024);
    }

    function readSourceLine(filePath, lineNumber) {
        if (!filePath || !Number.isFinite(Number(lineNumber)) || !fs.existsSync(filePath)) {
            return null;
        }
        try {
            const text = fs.readFileSync(filePath, 'utf8');
            const lines = text.split(/\r?\n/);
            const index = Math.max(0, Number(lineNumber) - 1);
            return typeof lines[index] === 'string' ? lines[index] : null;
        } catch {
            return null;
        }
    }

    function findQuotedDiagnosticToken(message) {
        const match = String(message || '').match(/"([A-Za-z_@][A-Za-z0-9_@]*)"/);
        return match ? match[1] : '';
    }

    function findTokenSpan(lineText, token) {
        if (!token) return null;
        let index = -1;
        while ((index = lineText.indexOf(token, index + 1)) !== -1) {
            const before = index > 0 ? lineText[index - 1] : '';
            const after = index + token.length < lineText.length ? lineText[index + token.length] : '';
            if (isIdentifierBoundaryChar(before) && isIdentifierBoundaryChar(after)) {
                return { start: index, end: index + token.length };
            }
        }
        return null;
    }

    function findAssignmentOperatorIndex(lineText) {
        let quote = '';
        for (let index = 0; index < lineText.length; index++) {
            const ch = lineText[index];
            const next = lineText[index + 1] || '';
            if (quote) {
                if (ch === '^') {
                    index++;
                    continue;
                }
                if (ch === quote) quote = '';
                continue;
            }
            if (ch === '/' && next === '/') break;
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            const three = lineText.slice(index, index + 3);
            if (three === '<<=' || three === '>>=') return index;
            const two = lineText.slice(index, index + 2);
            if (two === '+=' || two === '-=' || two === '*=' || two === '/=' ||
                two === '%=' || two === '&=' || two === '|=' || two === '^=') {
                return index;
            }
            if (ch !== '=') continue;
            const prev = lineText[index - 1] || '';
            if (next === '=' || prev === '=' || prev === '<' || prev === '>' || prev === '!') continue;
            return index;
        }
        return -1;
    }

    function findAssignmentLhsSpan(lineText) {
        const assignmentIndex = findAssignmentOperatorIndex(lineText);
        if (assignmentIndex < 0) return null;

        let end = assignmentIndex;
        while (end > 0 && /\s/.test(lineText[end - 1])) end--;
        if (end <= 0) return null;

        let start = end - 1;
        let squareDepth = 0;
        let parenDepth = 0;
        let braceDepth = 0;
        for (; start >= 0; start--) {
            const ch = lineText[start];
            if (ch === ']') {
                squareDepth++;
                continue;
            }
            if (ch === '[') {
                if (squareDepth > 0) {
                    squareDepth--;
                    continue;
                }
                break;
            }
            if (ch === ')') {
                parenDepth++;
                continue;
            }
            if (ch === '(') {
                if (parenDepth > 0) {
                    parenDepth--;
                    continue;
                }
                break;
            }
            if (ch === '}') {
                braceDepth++;
                continue;
            }
            if (ch === '{') {
                if (braceDepth > 0) {
                    braceDepth--;
                    continue;
                }
                break;
            }
            if (squareDepth || parenDepth || braceDepth) continue;
            if (/[\s,;{}()]/.test(ch) || /[+\-*\/%&|^!<>=?:]/.test(ch)) break;
        }

        start++;
        while (start < end && /\s/.test(lineText[start])) start++;
        return start < end ? { start, end } : null;
    }

    function inferCompilerIssueSpan(lineText, rawCode, rawMessage) {
        const text = String(lineText || '');
        if (!text.trim()) return null;

        const message = String(rawMessage || '');
        const code = String(rawCode || '').trim();
        if (Number(code) === 22 || /must be lvalue/i.test(message)) {
            const lhsSpan = findAssignmentLhsSpan(text);
            if (lhsSpan) return lhsSpan;
        }

        const quotedToken = findQuotedDiagnosticToken(message);
        const tokenSpan = findTokenSpan(text, quotedToken);
        if (tokenSpan) return tokenSpan;

        return null;
    }

    function createCompilerIssueRange(filePath, lineNumber, endLineNumber, rawCode, rawMessage) {
        const fallbackRange = createIssueRange(lineNumber, endLineNumber);
        if (endLineNumber && Number(endLineNumber) !== Number(lineNumber)) {
            return fallbackRange;
        }

        const sourceLine = readSourceLine(filePath, lineNumber);
        const inferredSpan = sourceLine === null
            ? null
            : inferCompilerIssueSpan(sourceLine, rawCode, rawMessage);
        if (!inferredSpan) return fallbackRange;

        const startLine = Math.max(0, Number(lineNumber || 1) - 1);
        const start = Math.max(0, Math.min(inferredSpan.start, sourceLine.length));
        const end = Math.max(start + 1, Math.min(inferredSpan.end, sourceLine.length));
        return new vscode.Range(startLine, start, startLine, end);
    }

    function parseCompilerIssueLine(line, compileCwd) {
        const trimmed = String(line || '').trim();
        if (!trimmed) return null;

        const match = trimmed.match(/^(.*)\((\d+)(?:\s*--\s*(\d+))?\)\s*:\s*(fatal error|error|warning)\s+(\d+):\s*(.+)$/i);
        if (!match) return null;

        const [, rawFile, rawLine, rawEndLine, rawSeverity, rawCode, rawMessage] = match;
        const filePart = String(rawFile || '').trim();
        const resolvedFilePath = path.isAbsolute(filePart)
            ? path.resolve(filePart)
            : path.resolve(compileCwd, filePart);
        const severityText = String(rawSeverity || '').toLowerCase();
        const severity = severityText === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error;
        const diagnostic = new vscode.Diagnostic(
            createCompilerIssueRange(resolvedFilePath, rawLine, rawEndLine, rawCode, rawMessage),
            `[${rawCode}] ${String(rawMessage || '').trim()}`,
            severity
        );
        diagnostic.source = 'amxxpc';
        diagnostic.code = rawCode;

        return {
            filePath: resolvedFilePath,
            diagnostic
        };
    }

    function collectCompilerDiagnostics(outputText, compileCwd) {
        const diagnosticsByFile = new Map();

        for (const line of String(outputText || '').split(/\r?\n/)) {
            const issue = parseCompilerIssueLine(line, compileCwd);
            if (!issue) continue;

            const normalized = normalizeCompilerFsPath(issue.filePath);
            if (!diagnosticsByFile.has(normalized)) {
                diagnosticsByFile.set(normalized, {
                    filePath: issue.filePath,
                    diagnostics: []
                });
            }
            diagnosticsByFile.get(normalized).diagnostics.push(issue.diagnostic);
        }

        return diagnosticsByFile;
    }

    function filterPublishedCompilerDiagnostics(diagnosticsByFile) {
        const allowErrors = shouldPublishCompilerErrorDiagnostics();
        const filtered = new Map();

        for (const [normalizedPath, entry] of diagnosticsByFile.entries()) {
            const diagnostics = entry.diagnostics.filter(diagnostic =>
                diagnostic.severity === vscode.DiagnosticSeverity.Warning ||
                (allowErrors && diagnostic.severity === vscode.DiagnosticSeverity.Error)
            );
            if (!diagnostics.length) continue;
            filtered.set(normalizedPath, {
                filePath: entry.filePath,
                diagnostics
            });
        }

        return filtered;
    }

    function applyCompilerDiagnostics(diagnosticCollection, diagnosticsByFile) {
        diagnosticCollection.clear();
        for (const entry of diagnosticsByFile.values()) {
            diagnosticCollection.set(vscode.Uri.file(entry.filePath), entry.diagnostics);
        }
    }

    function countLineBreaks(text = '') {
        const matches = String(text || '').match(/\r\n|\r|\n/g);
        return matches ? matches.length : 0;
    }

    function cloneCompilerDiagnosticWithRange(diagnostic, range) {
        const cloned = new vscode.Diagnostic(
            range,
            diagnostic.message,
            diagnostic.severity
        );
        cloned.source = diagnostic.source;
        cloned.code = diagnostic.code;
        if (Array.isArray(diagnostic.tags)) cloned.tags = diagnostic.tags;
        if (Array.isArray(diagnostic.relatedInformation)) {
            cloned.relatedInformation = diagnostic.relatedInformation;
        }
        return cloned;
    }

    function shiftCompilerDiagnosticLines(diagnostic, lineDelta) {
        if (!lineDelta) return diagnostic;
        const range = diagnostic?.range;
        if (!range?.start || !range?.end) return diagnostic;
        const nextRange = new vscode.Range(
            new vscode.Position(
                Math.max(0, range.start.line + lineDelta),
                range.start.character
            ),
            new vscode.Position(
                Math.max(0, range.end.line + lineDelta),
                range.end.character
            )
        );
        return cloneCompilerDiagnosticWithRange(diagnostic, nextRange);
    }

    function shouldRemoveCompilerDiagnosticForChange(diagnostic, change) {
        const range = diagnostic?.range;
        const changedRange = change?.range;
        if (!range?.start || !range?.end || !changedRange?.start || !changedRange?.end) return false;

        const startLine = changedRange.start.line;
        const endLine = changedRange.end.line;
        if (range.end.line < startLine || range.start.line > endLine) return false;
        return true;
    }

    function remapCompilerDiagnosticsAfterChange(diagnostics, change) {
        const changedRange = change?.range;
        if (!changedRange?.start || !changedRange?.end) return diagnostics;

        const oldLineCount = Math.max(0, changedRange.end.line - changedRange.start.line);
        const newLineCount = countLineBreaks(change?.text || '');
        const lineDelta = newLineCount - oldLineCount;
        const shiftAfterLine = changedRange.end.line;
        const remapped = [];

        for (const diagnostic of diagnostics || []) {
            if (shouldRemoveCompilerDiagnosticForChange(diagnostic, change)) {
                continue;
            }
            if (
                lineDelta &&
                diagnostic?.range?.start?.line > shiftAfterLine
            ) {
                remapped.push(shiftCompilerDiagnosticLines(diagnostic, lineDelta));
                continue;
            }
            remapped.push(diagnostic);
        }

        return remapped;
    }

    function updateCompilerDiagnosticsForDocumentChange(diagnosticCollection, event) {
        const document = event?.document;
        if (!isPawnDocumentForCompilerDiagnosticInvalidation(document)) return;
        const changes = Array.isArray(event?.contentChanges)
            ? event.contentChanges.filter(change => change?.range)
            : [];
        if (!changes.length || typeof diagnosticCollection?.get !== 'function') return;

        let diagnostics = diagnosticCollection.get(document.uri) || [];
        if (!Array.isArray(diagnostics) || !diagnostics.length) return;

        const orderedChanges = [...changes].sort((left, right) =>
            (right.range?.start?.line ?? 0) - (left.range?.start?.line ?? 0) ||
            (right.range?.start?.character ?? 0) - (left.range?.start?.character ?? 0)
        );
        for (const change of orderedChanges) {
            diagnostics = remapCompilerDiagnosticsAfterChange(diagnostics, change);
            if (!diagnostics.length) break;
        }

        if (diagnostics.length) {
            diagnosticCollection.set(document.uri, diagnostics);
        } else {
            diagnosticCollection.delete(document.uri);
        }
    }

    function hasCompilerErrors(diagnosticsByFile) {
        return [...diagnosticsByFile.values()].some(entry =>
            entry.diagnostics.some(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error)
        );
    }

    function findFirstCompilerDiagnostic(diagnosticsByFile, severity) {
        for (const entry of diagnosticsByFile.values()) {
            const diagnostic = entry.diagnostics.find(item => item.severity === severity);
            if (!diagnostic) continue;
            return {
                filePath: entry.filePath,
                diagnostic
            };
        }
        return null;
    }

    function findFirstLiveValidationDiagnostic(document, severity) {
        if (!document?.uri || typeof vscode.languages.getDiagnostics !== 'function') return null;

        const matchingDiagnostics = vscode.languages.getDiagnostics(document.uri).filter(diagnostic =>
            diagnostic?.severity === severity &&
            diagnostic?.source === LIVE_VALIDATION_DIAGNOSTIC_SOURCE
        );
        if (!matchingDiagnostics.length) return null;

        let earliestDiagnostic = matchingDiagnostics[0];
        for (let index = 1; index < matchingDiagnostics.length; index++) {
            const candidate = matchingDiagnostics[index];
            const candidateStart = candidate?.range?.start;
            const currentStart = earliestDiagnostic?.range?.start;
            if (!candidateStart || !currentStart) continue;
            if (candidateStart.line < currentStart.line) {
                earliestDiagnostic = candidate;
                continue;
            }
            if (
                candidateStart.line === currentStart.line &&
                candidateStart.character < currentStart.character
            ) {
                earliestDiagnostic = candidate;
            }
        }

        return {
            filePath: document.fileName,
            diagnostic: earliestDiagnostic
        };
    }

    return {
        applyCompilerDiagnostics,
        collectCompilerDiagnostics,
        filterPublishedCompilerDiagnostics,
        findFirstCompilerDiagnostic,
        findFirstLiveValidationDiagnostic,
        hasCompilerErrors,
        parseCompilerIssueLine,
        updateCompilerDiagnosticsForDocumentChange
    };
}

module.exports = { createCompilerDiagnosticService };
