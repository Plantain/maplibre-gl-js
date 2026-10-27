import type {VectorTileLayerLike} from '@maplibre/vt-pbf';

type Owner = {vtLayers?: Record<string, VectorTileLayerLike>};
type Entry = {owner: WeakRef<Owner>; bytes: number};

/**
 * Bounds decoded query backing stores without keeping discarded tiles alive.
 * Pinned entries may temporarily exceed the budget while synchronous queries are active.
 * Returned features own their geometry independently of this cache.
 */
export class DecodedTileCache {
    private readonly entries = new Set<Entry>();
    private readonly owners = new WeakMap<Owner, Entry>();
    private readonly pins = new WeakMap<Owner, number>();
    private bytes = 0;
    private maxBytes: number;
    private readonly maxEntries: number;

    constructor(maxBytes: number, maxEntries = 256) {
        this.maxBytes = maxBytes;
        this.maxEntries = maxEntries;
    }

    get byteLength(): number { return this.bytes; }

    setMaxBytes(bytes: number): void {
        if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Invalid decoded tile cache budget');
        this.maxBytes = bytes;
        this.trim();
    }

    touch(owner: Owner): void {
        const entry = this.owners.get(owner);
        if (!entry) return;
        this.entries.delete(entry);
        this.entries.add(entry);
    }

    add(owner: Owner, bytes: number): void {
        const previous = this.owners.get(owner);
        if (previous) this.remove(previous, false);
        const entry = {owner: new WeakRef(owner), bytes};
        this.owners.set(owner, entry);
        this.entries.add(entry);
        this.bytes += bytes;
        this.trim();
    }

    delete(owner: Owner): void {
        const entry = this.owners.get(owner);
        if (entry) this.remove(entry);
    }

    /** Pinning covers nested queries and always ends, including when a query throws. */
    withPinned<T>(owner: Owner, query: () => T): T {
        this.pins.set(owner, (this.pins.get(owner) || 0) + 1);
        try {
            return query();
        } finally {
            const remaining = this.pins.get(owner) - 1;
            if (remaining) this.pins.set(owner, remaining);
            else this.pins.delete(owner);
            this.trim();
        }
    }

    clear(): void {
        for (const entry of this.entries) this.remove(entry);
    }

    private remove(entry: Entry, clearLayers = true): void {
        const owner = entry.owner.deref();
        if (owner) {
            this.owners.delete(owner);
            if (clearLayers) owner.vtLayers = undefined;
        }
        this.entries.delete(entry);
        this.bytes -= entry.bytes;
    }

    private trim(): void {
        for (const entry of this.entries) {
            const owner = entry.owner.deref();
            if (!owner) this.remove(entry);
            else if ((this.bytes > this.maxBytes || this.entries.size > this.maxEntries) && !this.pins.has(owner)) this.remove(entry);
        }
    }
}

/** Budget for additional decoded MLT query data in this realm; raw response bytes remain on each tile. */
export const decodedMLTCache: DecodedTileCache = new DecodedTileCache(4 * 1024 * 1024);
