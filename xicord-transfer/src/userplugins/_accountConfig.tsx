/*
MIT License — Copyright (c) 2026 Xicord

Per-account settings config.

The Xicord watcher family keeps its config — who is targeted, watched, hidden,
ghosted, the traits, the watchlist rules, the notes — in Vencord's settings.json,
which has no concept of which Discord account is logged in. So switching from
ghostphantom1 to another account showed one account's targets and watchlists on
the other.

The trick that keeps the blast radius tiny: the live settings field ALWAYS holds
the CURRENT account's value, so every reader and every SettingsStore change
listener across the plugins keeps working untouched. This module is the only thing
that moves values in and out — it banks the outgoing account's fields into a
per-account side store and restores the incoming account's on a switch. Exactly the
same shape as the data stores, which swap their DataStore keys on the same event.

`owner` records which account the live fields currently belong to, persisted across
restarts. It is what lets the module do the right thing when the logged-in account
was changed while Discord was CLOSED: on startup the fields hold the account active
at last shutdown, which may not be the one now logged in, and the owner marker is
how we tell those apart without losing either account's config.

Filename starts with "_" so the plugin loader skips it — it is a helper, driven by
the Dossier's account lifecycle (the suite's account hub), not a plugin of its own.
*/
import * as DataStore from "@api/DataStore";
import { Settings } from "@api/Settings";

const CONFIG_KEY = "XicordAccountConfig";

/**
 * Every settings.json field that is per-account config: [plugin, key, default].
 *
 * `Xicord Traits.tasks` is the hub — the reserved "Target" trait lives in it and drives
 * every watcher (Orbit, Profile/Live/Post/Server/Game Watch, Dossier), so scoping this one
 * field makes the entire watched-people set per-account. The rest are their own small
 * config. Defaults match each plugin's declared `default`, so a never-seen account starts
 * exactly as a fresh install would rather than inheriting the previous account's config.
 */
const FIELDS: Array<[plugin: string, key: string, def: string]> = [
    ["Xicord Traits", "tasks", ""],
    ["Xicord Mutuals", "targets", "[]"],
    ["Xicord Mutuals", "hidden", "[]"],
    ["Xicord Orbit", "watched", "[]"],
    ["Xicord Ghost", "ghosted", "[]"],
    ["Xicord Watchlist", "rules", "[]"],
    ["Xicord Notes", "notes", "{}"],
    ["Xicord Keyword Alerts", "keywords", ""],
    ["Xicord Voice Log", "watched", ""],
    ["Xicord Dossier", "sweepScope", ""],
];

const fieldKey = (plugin: string, key: string) => `${plugin} ${key}`;

type Slice = Record<string, string>;              // "plugin key" -> value
interface Persisted { owner: string | null; accounts: Record<string, Slice>; }
let data: Persisted = { owner: null, accounts: {} };
let loaded = false;

// A field is only touched when its plugin is present in settings — a disabled plugin still
// has an entry, so this reaches its config; a plugin never installed is simply skipped.
function readField(plugin: string, key: string, def: string): string {
    const p = (Settings.plugins as any)[plugin];
    if (!p) return def;
    const v = p[key];
    return typeof v === "string" ? v : def;
}
function writeField(plugin: string, key: string, val: string) {
    const p = (Settings.plugins as any)[plugin];
    if (p) p[key] = val;
}

/** The live settings fields as they stand right now, as a plain map. */
export function snapshotFields(): Slice {
    const out: Slice = {};
    for (const [plugin, key, def] of FIELDS) out[fieldKey(plugin, key)] = readField(plugin, key, def);
    return out;
}

/** Push a stored (or default) slice back onto the live settings fields. */
function applyFields(slice: Slice) {
    for (const [plugin, key, def] of FIELDS) {
        const k = fieldKey(plugin, key);
        writeField(plugin, key, k in slice ? slice[k] : def);
    }
}

function defaultsSlice(): Slice {
    const out: Slice = {};
    for (const [plugin, key, def] of FIELDS) out[fieldKey(plugin, key)] = def;
    return out;
}

let persistTimer: any = null;
function persist() {
    if (!loaded || persistTimer != null) return;
    // Debounced: an account switch writes every field at once, and each write here would
    // otherwise re-serialise the whole side store.
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void DataStore.set(CONFIG_KEY, data).catch(e => console.error("Xicord account config: save failed", e));
    }, 1000);
}

/** Load the side store once. Safe to call repeatedly. */
export async function loadAccountConfig() {
    if (loaded) return;
    try {
        const d = await DataStore.get(CONFIG_KEY);
        if (d && typeof d === "object" && (d as any).accounts) data = d as Persisted;
    } catch (e) { console.error("Xicord account config: load failed", e); }
    loaded = true;
}

/**
 * Startup, for the account already logged in.
 *
 * If the fields still belong to a DIFFERENT account (the account switched while Discord was
 * closed), that account's config is banked to its own slice first — never lost — and this
 * account's own config (or defaults) is restored. Otherwise the live field is authoritative:
 * Discord reopened the same account, so the field already holds its config, and a first-ever
 * run's pre-existing account-agnostic config is thereby adopted as this account's.
 */
export function initAccountConfig(acct: string | null) {
    if (!acct) return;
    const owner = data.owner;
    if (owner && owner !== acct) {
        data.accounts[owner] = snapshotFields();   // preserve the shutdown account's config
        const slice = data.accounts[acct] ?? defaultsSlice();
        applyFields(slice);
        data.accounts[acct] = slice;
    } else {
        data.accounts[acct] = snapshotFields();    // same account (or first run): adopt the field
    }
    data.owner = acct;
    persist();
}

/**
 * An account switch while running: bank the outgoing account's fields, then restore the
 * incoming account's — or defaults if it has never been seen, so a different account starts
 * fresh instead of inheriting the previous one's targets and watchlists.
 */
export function swapAccountConfig(oldAcct: string | null, nextAcct: string | null) {
    if (oldAcct === nextAcct) return;
    if (oldAcct) data.accounts[oldAcct] = snapshotFields();
    if (nextAcct) {
        const slice = data.accounts[nextAcct] ?? defaultsSlice();
        data.accounts[nextAcct] = slice;
        applyFields(slice);
    }
    data.owner = nextAcct;
    persist();
}

/** Test seams. */
export function _reset() { data = { owner: null, accounts: {} }; loaded = false; if (persistTimer != null) { clearTimeout(persistTimer); persistTimer = null; } }
export function _data() { return data; }
export function _setLoaded() { loaded = true; }
