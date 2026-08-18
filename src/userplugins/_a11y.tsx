/*
MIT License — Copyright (c) 2026 Xicord
Keyboard and screen-reader plumbing shared by the Xicord panels. Filename starts with "_"
so the plugin loader skips it (it is not a plugin, just a helper module).

The problem this exists for: most of the clickable things in these panels are plain
`<div>`s, `<span>`s and `<img>`s with an `onClick`. A mouse works; nothing else does. A
control that is not focusable never receives Tab, and one that only listens for `click`
never hears Enter or Space, so every one of those affordances is unusable without a
pointer — and several of them (re-centre the graph, undo a re-centre, reorder the header
icons) are the ONLY way to perform their action.

`clickable()` returns the props that make such an element behave the way a button does.
Spread it in place of a bare `onClick` and the element becomes focusable, announced with a
name, and operable with Enter or Space.
*/
import type { CSSProperties, KeyboardEvent } from "react";

export interface ClickableOpts {
    /** What a screen reader should call it. Omit only when the element has visible text. */
    label?: string;
    /** Set for a control that toggles something, so its state is announced. */
    pressed?: boolean;
    /** Merged after the focus affordance, so a caller can still override the cursor etc. */
    style?: CSSProperties;
    /** Skip the `role`/`tabIndex` when the element already is a real <button>. */
    bare?: boolean;
}

/**
 * Props that turn a non-interactive element into a real, operable control.
 *
 * Enter and Space are handled because that is what a button does natively: Enter fires on
 * keydown, Space on keyup, and Space must have its default prevented or the page scrolls.
 * Both are collapsed onto keydown here — the difference is not observable for these
 * controls, and one handler is easier to keep correct across the ~15 places that need it.
 */
export function clickable(onActivate: () => void, opts: ClickableOpts = {}) {
    const { label, pressed, style, bare } = opts;
    return {
        ...(bare ? {} : { role: "button" as const, tabIndex: 0 }),
        ...(label ? { "aria-label": label } : {}),
        ...(pressed === undefined ? {} : { "aria-pressed": pressed }),
        onClick: onActivate,
        onKeyDown: (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
            // Space scrolls the modal otherwise, and Enter can submit an enclosing form.
            e.preventDefault();
            e.stopPropagation();
            onActivate();
        },
        style: { cursor: "pointer", ...style },
    };
}

/**
 * Marks an element as decoration.
 *
 * Use on an avatar or glyph that sits NEXT TO its own label, never on one that is itself
 * the control — hiding an interactive element removes it from the accessibility tree
 * entirely, which is strictly worse than leaving it unnamed.
 */
export const decorative = { "aria-hidden": true as const };
