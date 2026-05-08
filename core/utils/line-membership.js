function createLineMembership(lineCount = 0) {
    const flags = new Uint8Array(Math.max(0, lineCount | 0));
    return {
        size: 0,
        add(lineNumber) {
            if (!Number.isInteger(lineNumber) || lineNumber < 0 || lineNumber >= flags.length) return;
            if (flags[lineNumber]) return;
            flags[lineNumber] = 1;
            this.size++;
        },
        has(lineNumber) {
            return !!flags[lineNumber];
        }
    };
}

module.exports = { createLineMembership };
