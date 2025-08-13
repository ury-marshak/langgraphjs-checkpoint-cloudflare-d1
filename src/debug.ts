/* eslint-disable no-instanceof/no-instanceof */



// Standalone debug utility separated to keep main source lint-clean.
export function printTypeOfArray(v: unknown): void {
    console.log('checkpoint debug:', {
        typeof: typeof v,
        toStringTag: Object.prototype.toString.call(v),
        constructorName: v?.constructor?.name,
        // The following use instanceof intentionally for rich debugging:
        isUint8Array: v instanceof Uint8Array,
        isArrayBuffer: v instanceof ArrayBuffer,
        isArray: Array.isArray(v),
        isDataView: v instanceof DataView,
        isTypedArrayView: ArrayBuffer.isView(v),
        // @ts-expect-error may not exist
        byteLength: v?.byteLength,
        // @ts-expect-error may not exist
        length: v?.length,
        // @ts-expect-error may not exist
        bufferConstructor: v?.buffer?.constructor?.name,
        firstBytes: ArrayBuffer.isView(v)
            ? Array.from(new Uint8Array(v.buffer, v.byteOffset, Math.min(16, v.byteLength)))
            : undefined,
        protoChain: (() => {
            const chain: string[] = [];
            let p = Object.getPrototypeOf(v);
            while (p) { chain.push(p.constructor?.name || '(anon)'); p = Object.getPrototypeOf(p); }
            return chain;
        })(),
    });
    if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
        console.log('raw keys', Object.keys(v as Record<string, unknown>));
    } else {
        console.log('raw keys', []);
    }
    console.log('has buffer', v && (typeof v === 'object' && 'buffer' in v));
}
