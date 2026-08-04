/**
 * Random-order iterator that guarantees every item is seen once before any
 * item repeats, and never immediately repeats the previous pick across bag
 * refills. Used for "shuffle" rotation mode instead of naive Math.random()
 * indexing, which tends to repeat images and skip others over time.
 */
export class ShuffleBag {
    constructor(items = []) {
        this.setItems(items);
    }

    setItems(items) {
        this._items = [...items];
        this._bag = [];
        this._lastItem = null;
    }

    get size() {
        return this._items.length;
    }

    next() {
        if (this._items.length === 0)
            return null;
        if (this._items.length === 1)
            return this._items[0];

        if (this._bag.length === 0)
            this._refill();

        const item = this._bag.pop();
        this._lastItem = item;
        return item;
    }

    _refill() {
        this._bag = [...this._items];
        for (let i = this._bag.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this._bag[i], this._bag[j]] = [this._bag[j], this._bag[i]];
        }

        if (this._bag[this._bag.length - 1] === this._lastItem && this._bag.length > 1) {
            const swapIndex = Math.floor(Math.random() * (this._bag.length - 1));
            const lastIndex = this._bag.length - 1;
            [this._bag[lastIndex], this._bag[swapIndex]] = [this._bag[swapIndex], this._bag[lastIndex]];
        }
    }
}
