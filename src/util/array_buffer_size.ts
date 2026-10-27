/** Counts each backing store once, including buffers exposed through multiple views. */
export function arrayBufferSize(root: unknown, excluded?: ArrayBuffer): number {
    const seen = new Set<object>();
    const buffers = new Set<ArrayBufferLike>();
    const pending = [root];
    while (pending.length) {
        const value = pending.pop();
        if (!value || typeof value !== 'object' || seen.has(value)) continue;
        seen.add(value);
        if (value instanceof ArrayBuffer) buffers.add(value);
        else if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
        else pending.push(...Object.values(value));
    }
    buffers.delete(excluded);
    let bytes = 0;
    for (const buffer of buffers) bytes += buffer.byteLength;
    return bytes;
}
