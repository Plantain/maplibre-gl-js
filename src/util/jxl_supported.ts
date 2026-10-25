/**
 * A 1x1, half-transparent red pixel, encoded losslessly with cjxl 0.12.0:
 * `cjxl pixel.png pixel.jxl --distance=0 --effort=7`.
 */
const jxlPixel = '/woAELASCAAQACwASxiLFcJJQU5/AgA=';

let bitmapSupport: boolean | Promise<boolean>;
let imageSupport: boolean | Promise<boolean>;

/**
 * Test the decoder used for downloaded images, once per execution context and backend.
 * A settled result is returned synchronously so subsequent requests need not wait.
 */
export function isJXLSupported(useImageBitmap: boolean = typeof createImageBitmap === 'function'): boolean | Promise<boolean> {
    if (useImageBitmap) {
        bitmapSupport ??= probeJXL(true).then(supported => (bitmapSupport = supported));
        return bitmapSupport;
    }
    imageSupport ??= probeJXL(false).then(supported => (imageSupport = supported));
    return imageSupport;
}

/**
 * Decode the sample with the JPEG XL Content-Type preserved by this fork's image loaders.
 * The caller selects the same decoding backend as the actual request. Failure or a one-second
 * timeout resolves to false. Temporary resources are released, including bitmaps returned late.
 */
function probeJXL(useImageBitmap: boolean): Promise<boolean> {
    return new Promise(resolve => {
        let image: HTMLImageElement;
        let url: string;
        let settled = false;
        const finish = (supported: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (image) {
                image.onload = image.onerror = null;
                image.removeAttribute('src');
            }
            if (url) URL.revokeObjectURL(url);
            resolve(supported);
        };
        const timeout = setTimeout(() => finish(false), 1000);

        try {
            const bytes = Uint8Array.from(atob(jxlPixel), c => c.charCodeAt(0));
            const blob = new Blob([bytes], {type: 'image/jxl'});
            if (useImageBitmap) {
                createImageBitmap(blob).then(bitmap => {
                    const supported = bitmap.width === 1 && bitmap.height === 1;
                    bitmap.close();
                    finish(supported);
                }).catch(() => finish(false));
            } else if (typeof Image === 'function') {
                image = new Image();
                image.onload = () => finish(image.naturalWidth === 1 && image.naturalHeight === 1);
                image.onerror = () => finish(false);
                url = URL.createObjectURL(blob);
                image.src = url;
            } else {
                finish(false);
            }
        } catch {
            finish(false);
        }
    });
}
