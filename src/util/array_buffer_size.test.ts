import {expect, test} from 'vitest';
import {arrayBufferSize} from './array_buffer_size.ts';

test('counts shared backing stores once and excludes the retained response body', () => {
    const raw = new ArrayBuffer(64);
    const decoded = new ArrayBuffer(100);
    const root = {raw, first: new Uint8Array(decoded, 10, 20), second: new Uint16Array(decoded), self: null};
    root.self = root;
    expect(arrayBufferSize(root, raw)).toBe(100);
});
