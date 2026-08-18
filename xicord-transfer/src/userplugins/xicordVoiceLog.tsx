/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Xicord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps, User } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, Menu, Modal, openModal, React, Toasts, UserStore } from "@webpack/common";

import { fromVoice, toVoice } from "./_sync";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const VoiceStateStore = findStoreLazy("VoiceStateStore");

// The log was session-only and 200 entries deep, so every reload threw away everything it
// had watched. It is now the plugin's actual product — it feeds the pool — and a record
// that cannot survive a reload is not a record. IndexedDB, not settings.json, for the
// same reason the Dossier's stores live there: settings.json is rewritten in full for
// every unrelated setting change anywhere in Vencord.
const MAX_ENTRIES = 2000;
const LOG_KEY = "XicordVoiceLog";
const FLUSH_DELAY = 15000;

const settings = definePluginSettings({
    watched: {
        type: OptionType.STRING,
        description: "Watched user IDs, separated by / (managed from the user context menu)",
        default: ""
    },
    watchEveryone: {
        type: OptionType.BOOLEAN,
        // On by default: the log is only as good as what it saw, and a filter applied at
        // CAPTURE time cannot be undone afterwards — a person you start watching tomorrow
        // has no history, forever. Watching everyone and filtering at read time is the
        // only ordering that keeps the past available.
        description: "Log everyone, not only watched users. Watched users still get the toasts",
        default: true
    },
    toastOnEvent: {
        type: OptionType.BOOLEAN,
        description: "Show a toast when a watched user joins or leaves a voice channel",
        default: true
    },
    sync: {
        type: OptionType.BOOLEAN,
        description: "Share the voice timeline through Xicord Sync — send what this client observes, and take in what other contributors observed. Requires the Xicord Dossier sync to be configured",
        default: true
    }
});

type VoiceAction = "joined" | "left" | "moved";

interface LogEntry {
    id: number;
    userId: string;
    action: VoiceAction;
    channelId: string | null;
    oldChannelId: string | null;
    at: number;
    /** Came from another contributor's client rather than this one's own eyes. */
    pooled?: boolean;
    /** The name at the time of capture — see rememberName(). */
    name?: string;
}

let log: LogEntry[] = [];
let nextId = 0;
let loaded = false;
let dirty = false;
let flushTimer: any = null;
// Account-scoped: the log this account's client observed stays with this account, and a
// switch swaps in the other account's own log rather than pouring one into the other.
let accountId: string | null = null;
let loadSeq = 0;
const listeners = new Set<() => void>();

const logKeyFor = (id: string | null) => (id ? `${LOG_KEY}:${id}` : LOG_KEY);
const currentAccount = () => { try { return UserStore.getCurrentUser()?.id ?? null; } catch { return null; } };

function notify() { listeners.forEach(l => { try { l(); } catch { } }); }

function scheduleFlush() {
    dirty = true;
    if (flushTimer != null) return;
    flushTimer = setTimeout(flushLog, FLUSH_DELAY);
}

function flushLog() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty || !loaded) return;
    dirty = false;
    // The push watermark rides with the log it describes. Kept apart and it would reset
    // on every reload, so each launch would re-send the entire history — harmless, since
    // the merge is a set union, but it is a megabyte of pointless upload per restart.
    // Capture the key AND the value up front: an account switch replaces both mid-write,
    // and the outgoing account's log must not land under the incoming account's key.
    const key = logKeyFor(accountId);
    const writing = { entries: log.slice(0, MAX_ENTRIES), pushedThrough };
    void DataStore.set(key, writing).catch(e => {
        dirty = true;
        console.error("[Xicord Voice Log] save failed", e);
    });
}

async function loadLog() {
    const seq = ++loadSeq;
    const acct = accountId = currentAccount();
    let data: any = null;
    try {
        data = await DataStore.get(logKeyFor(acct));
        // Adopt the old global log into whoever is logged in now, once, then remove it —
        // the same one-time move the Dossier's stores do.
        if (!data && acct) {
            const unscoped = await DataStore.get(LOG_KEY);
            if (unscoped && (Array.isArray(unscoped) ? unscoped.length : Array.isArray(unscoped?.entries) && unscoped.entries.length)) {
                await DataStore.set(logKeyFor(acct), unscoped);
                await DataStore.del(LOG_KEY);
                data = unscoped;
            }
        }
    } catch (e) { console.error("[Xicord Voice Log] load failed", e); }
    if (seq !== loadSeq) return;    // a newer switch superseded this load
    // A bare array is what the first version wrote; read it rather than discarding
    // somebody's history for being a shape older than the code.
    const entries = Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
    pushedThrough = !Array.isArray(data) && typeof data?.pushedThrough === "number" ? data.pushedThrough : 0;
    log = [];
    for (const e of entries) {
        if (!e?.userId || typeof e.at !== "number") continue;
        log.push({ ...e, id: nextId++ });
    }
    log.sort((a, b) => b.at - a.at);
    loaded = true;
    notify();
}

/**
 * A person's name as it was when the event happened.
 *
 * Discord's user cache is a cache: someone you saw join three days ago, in a server you
 * have since left, is very often simply not in it any more — and the row then reads as a
 * bare snowflake with no way to find out who it was. The name at capture time is the only
 * moment it is reliably knowable, so that is when it is recorded.
 */
function rememberName(userId: string): string | undefined {
    try { return UserStore.getUser(userId)?.username || undefined; } catch { return undefined; }
}

function pushEntry(entry: Omit<LogEntry, "id">): boolean {
    // Same identity rule the pool merges on, so a reconcile that re-notices a transition
    // the dispatch already logged does not double it.
    const bucket = Math.floor(entry.at / 5000);
    for (const e of log) {
        // sorted newest first, so nothing beyond here can be within the window
        if (e.at < entry.at - 10000) break;
        if (e.userId === entry.userId && e.action === entry.action
            && e.channelId === entry.channelId && e.oldChannelId === entry.oldChannelId
            && Math.floor(e.at / 5000) === bucket) return false;
    }
    log.unshift({ ...entry, id: nextId++ });
    if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES;
    scheduleFlush();
    notify();
    return true;
}

function getWatched(): string[] {
    return settings.store.watched.split("/").map(s => s.trim()).filter(Boolean);
}

function isWatched(userId: string) {
    return getWatched().includes(userId);
}

/** Whether an event is worth RECORDING, which is a wider question than whose it is. */
function shouldLog(userId: string) {
    return settings.store.watchEveryone || isWatched(userId);
}

function toggleWatched(userId: string) {
    const watched = getWatched();
    const index = watched.indexOf(userId);

    if (index === -1) watched.push(userId);
    else watched.splice(index, 1);

    settings.store.watched = watched.join("/");
    return index === -1;
}

function channelName(channelId: string | null) {
    if (!channelId) return "nowhere";
    return ChannelStore.getChannel(channelId)?.name ?? "unknown channel";
}

function describe(entry: LogEntry) {
    switch (entry.action) {
        case "joined": return `joined ${channelName(entry.channelId)}`;
        case "left": return `left ${channelName(entry.oldChannelId)}`;
        case "moved": return `moved from ${channelName(entry.oldChannelId)} to ${channelName(entry.channelId)}`;
    }
}

const VoiceIcon = ({ size = 18 }: { size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
            fill="currentColor"
            d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Zm-7 9a1 1 0 0 1 2 0 5 5 0 0 0 10 0 1 1 0 1 1 2 0 7 7 0 0 1-6 6.93V21a1 1 0 1 1-2 0v-2.07A7 7 0 0 1 5 12Z"
        />
    </svg>
);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------
// Three sources, because one was never enough:
//
//   1. VOICE_STATE_UPDATES — the live dispatch. Only ever fires for a transition that
//      happens while you are running AND subscribed to that guild.
//   2. the seed — everyone already sitting in a call when the plugin starts, or when a
//      guild's voice states first arrive. Under (1) alone, a person who joined before you
//      launched is invisible until they move, which on a quiet server can be days.
//   3. the reconcile tick — a diff of what the store says against what we last saw. This
//      is what catches the transitions Discord simply never dispatched to this client:
//      a guild subscribed late, an event dropped while the socket was resuming, or the
//      window being asleep.
//
// All three converge on pushEntry(), which dedupes on the same bucketed identity the pool
// merges on — so overlapping sources cost nothing but cannot leave a hole either.

/** userId -> channel we last believe them to be in. The reconcile tick diffs against it. */
const lastKnown = new Map<string, string | null>();
const RECONCILE_TICK = 30000;
let reconcileTimer: any = null;

function record(userId: string, channelId: string | null, oldChannelId: string | null, quiet = false) {
    if (channelId === oldChannelId) return;
    if (!shouldLog(userId)) return;
    const action: VoiceAction = !oldChannelId ? "joined" : !channelId ? "left" : "moved";
    const entry: Omit<LogEntry, "id"> = {
        userId, action, channelId, oldChannelId, at: Date.now(), name: rememberName(userId)
    };
    if (!pushEntry(entry)) return;

    if (!quiet && settings.store.toastOnEvent && isWatched(userId)) {
        Toasts.show({
            message: `${entry.name ?? userId} ${describe({ ...entry, id: -1 })}`,
            id: Toasts.genId(),
            type: action === "left" ? Toasts.Type.FAILURE : Toasts.Type.SUCCESS
        });
    }
}

/** Everyone the client currently believes is in a voice channel: userId -> channelId. */
function currentVoice(): Map<string, string> {
    const out = new Map<string, string>();
    try {
        const all = (VoiceStateStore as any)?.getAllVoiceStates?.() ?? {};
        for (const channels of Object.values<any>(all)) {
            for (const state of Object.values<any>(channels ?? {})) {
                const id = state?.userId, ch = state?.channelId;
                if (id && ch) out.set(id, ch);
            }
        }
    } catch (e) { console.error("[Xicord Voice Log] could not read voice states", e); }
    return out;
}

/**
 * Diff the store against what we last saw, and log whatever moved.
 *
 * `seed` suppresses the toasts and treats a first sighting as a join: on start there is
 * no "before", and firing forty toasts because the client just woke up is noise, not
 * information.
 */
function reconcile(seed = false) {
    if (!active) return;
    const me = (() => { try { return UserStore.getCurrentUser()?.id ?? null; } catch { return null; } })();
    const now = currentVoice();

    for (const [id, ch] of now) {
        if (id === me) continue;
        const was = lastKnown.get(id) ?? null;
        if (was === ch) continue;
        record(id, ch, was, seed);
        lastKnown.set(id, ch);
    }
    // Gone from the store entirely: they left, and we were never told.
    for (const [id, was] of [...lastKnown]) {
        if (now.has(id) || !was) continue;
        if (id === me) { lastKnown.delete(id); continue; }
        record(id, null, was, seed);
        lastKnown.delete(id);
    }
}

const onVoiceStates = (event: any) => {
    try {
        const currentUser = UserStore.getCurrentUser();

        // Discord batches states; the old plugins only read [0] and silently dropped the rest
        for (const state of event.voiceStates ?? []) {
            const { userId, channelId = null, oldChannelId = null } = state;

            if (!userId || userId === currentUser?.id) continue;
            if (channelId === oldChannelId) continue;

            // Tracked for EVERYONE regardless of the filter, so the reconcile tick has a
            // truthful "before" even for people the log is not currently recording.
            lastKnown.set(userId, channelId);
            if (!channelId) lastKnown.delete(userId);

            record(userId, channelId, oldChannelId);
        }
    } catch (err) {
        console.error("[Xicord Voice Log] failed to handle voice state", err);
    }
};

// A guild's voice states arrive in bulk when you first subscribe to it, and on resume
// after the socket drops — both are moments when the store knows things the dispatch
// stream never told us about one at a time.
const onBulkArrival = () => { try { reconcile(true); } catch { } };

// CONNECTION_OPEN fires on login and on every account switch. On a real switch, bank the
// outgoing account's log and swap in the incoming account's own before recording anything
// new — otherwise one account's sightings pour into the other's store.
const onConnectionOpen = () => {
    if (!active) return;
    const next = currentAccount();
    if (next === accountId) { onBulkArrival(); return; } // reconnect, not a switch
    flushLog();          // still keyed to the OLD account (loaded still true)
    loaded = false;
    log = [];
    lastKnown.clear();
    pushedThrough = 0;
    void loadLog().then(() => { if (active) reconcile(true); });
};

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
// The Dossier owns the connection — the URL, the token, the pull-before-push ordering —
// so this exposes the two halves it needs rather than opening a second one. Same shape as
// WatchAPI: a plugin that is disabled answers empty and nothing downstream has to care.
let active = false;
/** Highest `at` already pushed, so a routine sync sends only what is new. */
let pushedThrough = 0;

export const VoiceLogAPI = {
    isActive: () => active && !!settings.store.sync,
    /** Our own observations, for POST /v1/pool. `since` of 0 re-sends everything. */
    exportVoice(mine: string[] = [], since = 0) {
        if (!active || !settings.store.sync) return {};
        // Never re-push what arrived FROM the pool: it is already there, and bouncing it
        // back makes every contributor a source for every other contributor's findings.
        const own = log.filter(e => !e.pooled);
        return toVoice(own, mine, since);
    },
    /** What this client has to say, as of now, for the watermark. */
    highWater() {
        let hi = 0;
        for (const e of log) if (!e.pooled && e.at > hi) hi = e.at;
        return hi;
    },
    /** Fold a pulled timeline in. Returns how many entries were genuinely new. */
    mergeVoice(voice: any) {
        if (!active || !settings.store.sync) return 0;
        const added = fromVoice(voice, log as any, MAX_ENTRIES);
        if (added) {
            // fromVoice appends and re-sorts, so the ids it left are stale
            for (const e of log) if (e.id == null) e.id = nextId++;
            scheduleFlush();
            notify();
        }
        return added;
    },
    /** Advanced by the Dossier only once a push has actually landed. */
    markPushed(at: number) { if (at > pushedThrough) pushedThrough = at; },
    pushedThrough: () => pushedThrough,
    stats: () => ({ total: log.length, pooled: log.filter(e => e.pooled).length }),
};

function LogModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);
    const [onlyWatched, setOnlyWatched] = React.useState(false);

    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    const watched = getWatched();
    const shown = onlyWatched ? log.filter(e => watched.includes(e.userId)) : log;
    const pooled = log.reduce((n, e) => n + (e.pooled ? 1 : 0), 0);

    return (
        <Modal
            {...modalProps}
            title="Xicord Voice Log"
            subtitle={`${log.length} events${pooled ? ` · ${pooled} from the pool` : ""}${watched.length ? ` · watching ${watched.length}` : ""}`}
            actions={[
                {
                    text: onlyWatched ? "Show all" : "Only watched",
                    variant: "secondary",
                    onClick: () => setOnlyWatched(v => !v),
                    disabled: watched.length === 0
                },
                {
                    text: "Clear",
                    variant: "secondary",
                    onClick: () => { log.length = 0; scheduleFlush(); forceUpdate(); },
                    disabled: log.length === 0
                },
                { text: "Close", variant: "primary", onClick: modalProps.onClose }
            ]}
        >
            {shown.length === 0
                ? <span>Nothing logged yet. It records everyone by default — right click a user and pick "Watch Voice Activity" to get toasts for them.</span>
                : (
                    <Flex flexDirection="column" gap={6}>
                        {shown.slice(0, 300).map(entry => (
                            <Flex key={entry.id} style={{ alignItems: "center", gap: 8 }}>
                                <span style={{ color: "var(--text-muted)", minWidth: 128 }}>
                                    {new Date(entry.at).toLocaleString()}
                                </span>
                                <span style={{ fontWeight: 600, minWidth: 120 }}>
                                    {UserStore.getUser(entry.userId)?.username ?? entry.name ?? entry.userId}
                                </span>
                                <span style={{ color: "var(--text-muted)" }}>{describe(entry)}</span>
                                {entry.pooled && (
                                    <span
                                        style={{ fontSize: 10, opacity: 0.55 }}
                                        title="Observed by another contributor, not by this client"
                                    >↗</span>
                                )}
                            </Flex>
                        ))}
                    </Flex>
                )}
        </Modal>
    );
}

const UserContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuCheckboxItem
                id="xicord-watch-voice"
                label="Watch Voice Activity"
                checked={getWatched().includes(user.id)}
                action={() => {
                    const added = toggleWatched(user.id);
                    Toasts.show({
                        message: `${added ? "Now watching" : "Stopped watching"} ${user.username}`,
                        id: Toasts.genId(),
                        type: added ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE
                    });
                }}
            />
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "Xicord Voice Log",
    description: "Records who joins, leaves and moves between voice channels — from the live dispatch, from everyone already in a call, and from a reconcile tick that catches what Discord never told you. Shares the timeline through Xicord Sync",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    settings,
    contextMenus: { "user-context": UserContext },

    xicordButton: ErrorBoundary.wrap(() => (
        <PanelButton
            role="button"
            tooltipText="Xicord Voice Log"
            onClick={() => openModal(modalProps => <LogModal modalProps={modalProps} />)}
            icon={() => <VoiceIcon size={18} />}
        />
    ), { noop: true }),

    flux: {
        // On connect this also detects an account switch and swaps the per-account log;
        // when it is the same account it just seeds from the bulk voice states.
        CONNECTION_OPEN: onConnectionOpen,
        // A guild whose channels have just been subscribed: seed from its voice states.
        VOICE_CHANNEL_SELECT: onBulkArrival,
    },

    start() {
        active = true;
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStates);
        void loadLog().then(() => {
            if (!active) return;
            // Seeded, not logged as arrivals: on start there is no "before", so everyone
            // already in a call is recorded once, quietly, as having joined.
            reconcile(true);
            reconcileTimer = setInterval(() => { try { reconcile(); } catch { } }, RECONCILE_TICK);
        });
    },

    stop() {
        active = false;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStates);
        if (reconcileTimer != null) { clearInterval(reconcileTimer); reconcileTimer = null; }
        // Hours of watching went into this and it is what feeds the pool; never drop it.
        flushLog();
        lastKnown.clear();
        listeners.clear();
    }
});
