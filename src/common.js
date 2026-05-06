// Returns first (from the start of the string) matching token. Specify longer tokens first, e.g. [ '**', '*', ... ]
export function matchToken(string, oneOfToken) {
    const result = { token: null, pos: -1 };
    for (const token of oneOfToken) {
        const pos = string.indexOf(token);
        if (pos > -1 && (result.pos === -1 || result.pos > pos)) {
            result.pos = pos;
            result.token = token;
        }
    }
    return result;
}

// Wraps matchToken to return true on any match, otherwise false.
export function hasToken(string, oneOfToken) {
    const { token, pos } = matchToken(string, oneOfToken);
    return pos > -1;
}
