function unrefTimer(timer) {
    if (timer && typeof timer.unref === 'function') {
        timer.unref();
    }
    return timer;
}

module.exports = {
    unrefTimer
};
