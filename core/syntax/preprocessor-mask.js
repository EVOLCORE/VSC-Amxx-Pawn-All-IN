function maskPreprocessorLine(line) {
    const source = String(line || '');
    if (!source) return source;

    let masked = '';
    let changed = false;
    for (let index = 0; index < source.length; index++) {
        const code = source.charCodeAt(index);
        if (code === 9 || code === 32) {
            masked += source[index];
        } else {
            masked += ' ';
            changed = true;
        }
    }
    return changed ? masked : source;
}

module.exports = { maskPreprocessorLine };
