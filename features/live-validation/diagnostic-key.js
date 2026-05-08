function makeLiveValidationDiagnosticKey(diagnostic) {
    const range = diagnostic?.range || {};
    const start = range.start || {};
    const end = range.end || start;
    return [
        start.line ?? 0,
        start.character ?? 0,
        end.line ?? start.line ?? 0,
        end.character ?? start.character ?? 1,
        String(diagnostic?.message || '')
    ].join('|');
}

module.exports = { makeLiveValidationDiagnosticKey };
