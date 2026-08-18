/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Xicord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addProfileBadge, BadgePosition, BadgeUserArgs, ProfileBadge, removeProfileBadge } from "@api/Badges";
import * as DataStore from "@api/DataStore";
import definePlugin from "@utils/types";
import { findStoreLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, React, Tooltip, UserStore } from "@webpack/common";

const VoiceStateStore = findStoreLazy("VoiceStateStore");

const SEEN_KEY = "XicordLastSeenCall";
// Account-scoped: last-seen sightings this account's client made stay with this account.
const seenKeyFor = (id: string | null) => (id ? `${SEEN_KEY}:${id}` : SEEN_KEY);
const currentAccount = () => { try { return UserStore.getCurrentUser()?.id ?? null; } catch { return null; } };
// "Record everyone visible" must not grow without bound: past the cap plus some slack
// the oldest sightings are dropped, so the trim is amortised instead of once per event.
const MAX_USERS = 10000;
const TRIM_SLACK = 500;
const FLUSH_DELAY = 5000;
// How long to wait before retrying a read that threw. A failed read must NOT let the
// store come up "loaded" — an empty map flushed over a full one on disk is data loss —
// so the read is retried instead, and nothing persists until it succeeds.
const RELOAD_DELAY = 10000;

interface SeenRec {
    at: number;
    channelId: string | null;
}

let seen: Record<string, SeenRec> = {};
let loaded = false;
let dirty = false;
let flushTimer: any = null;
let reloadTimer: any = null;
let accountId: string | null = null;
let loadSeq = 0;
// True only between start() and stop(); the async load() continuation checks it so a
// quick enable/disable cannot sweep and schedule a write after the plugin is off.
let started = false;

const listeners = new Set<() => void>();
function notify() {
    listeners.forEach(l => { try { l(); } catch { } });
}

function markDirty() {
    dirty = true;
    scheduleFlush();
}

/** Drops the oldest sightings once the map is past cap + slack. Mutates in place. */
function trimSeen(map: Record<string, SeenRec>, cap: number, slack: number) {
    const keys = Object.keys(map);
    if (keys.length <= cap + slack) return map;
    const byAge = keys
        .map(k => [k, map[k]?.at ?? 0] as const)
        .sort((a, b) => b[1] - a[1]);
    for (let i = cap; i < byAge.length; i++) delete map[byAge[i][0]];
    return map;
}

/**
 * Every voice-state update we can see is evidence the person is in a call right now —
 * including mute/deafen updates where channelId === oldChannelId. A leave is a sighting
 * too, placed in the channel they left. Returns how many records changed.
 */
function applyVoiceStates(states: any[], selfId: string | null, now: number): number {
    let changed = 0;
    for (const st of states ?? []) {
        const userId = st?.userId;
        if (!userId || userId === selfId) continue;
        const channelId = st.channelId ?? null;
        const where = channelId ?? st.oldChannelId ?? null;
        if (!where) continue;
        seen[userId] = { at: now, channelId: where };
        changed++;
    }
    if (changed) {
        trimSeen(seen, MAX_USERS, TRIM_SLACK);
        markDirty();
    }
    return changed;
}

/**
 * Seeds everyone already sitting in a call when the plugin starts, from the store's
 * guildId -> userId -> state map. Only the channel they are in is recorded; the outer
 * key is a bucket id (a guild, or "@me" for private calls) and is not persisted.
 */
function sweepAllVoiceStates(all: any, selfId: string | null, now: number): number {
    let changed = 0;
    for (const states of Object.values(all ?? {})) {
        for (const [userId, st] of Object.entries((states ?? {}) as Record<string, any>)) {
            if (!userId || userId === selfId) continue;
            const channelId = st?.channelId ?? null;
            if (!channelId) continue;
            seen[userId] = { at: now, channelId };
            changed++;
        }
    }
    if (changed) {
        trimSeen(seen, MAX_USERS, TRIM_SLACK);
        markDirty();
    }
    return changed;
}

function scheduleReload() {
    if (reloadTimer != null) return;
    reloadTimer = setTimeout(() => {
        reloadTimer = null;
        void load();
    }, RELOAD_DELAY);
}

async function load() {
    const seq = ++loadSeq;
    const acct = accountId = currentAccount();
    let data: any;
    try {
        data = await DataStore.get(seenKeyFor(acct));
        // Adopt the old global store into whoever is logged in now, once, then remove it.
        if ((!data || typeof data !== "object") && acct) {
            const unscoped = await DataStore.get(SEEN_KEY);
            if (unscoped && typeof unscoped === "object" && !Array.isArray(unscoped) && Object.keys(unscoped).length) {
                await DataStore.set(seenKeyFor(acct), unscoped);
                await DataStore.del(SEEN_KEY);
                data = unscoped;
            }
        }
    } catch (e) {
        // Do NOT mark loaded: a store we could not read must never be overwritten by the
        // near-empty in-memory map. Retry instead; sightings pile up safely in memory.
        console.error("Xicord Last Seen Call: load failed, will retry", e);
        scheduleReload();
        return;
    }
    if (seq !== loadSeq) return;   // a newer switch superseded this load
    if (data && typeof data === "object" && !Array.isArray(data)) {
        const clean: Record<string, SeenRec> = {};
        for (const [id, rec] of Object.entries(data)) {
            const r = rec as any;
            if (r && typeof r === "object" && Number.isFinite(r.at))
                clean[id] = { at: r.at, channelId: r.channelId ?? null };
        }
        // Sightings recorded before the read landed are newer than the disk copy
        seen = { ...clean, ...seen };
        trimSeen(seen, MAX_USERS, TRIM_SLACK);
    }
    loaded = true;
    // A flush that fired before the read refused to run; give it its turn now
    if (dirty) scheduleFlush();
}

function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flush();
    }, FLUSH_DELAY);
}

async function flush() {
    // Never write an unread store over a real one on disk
    if (!loaded) return;
    dirty = false;
    // Capture the key with the value: an account switch replaces both mid-write.
    const key = seenKeyFor(accountId);
    const writing = { ...seen };
    try {
        await DataStore.set(key, writing);
    } catch (e) {
        console.error("Xicord Last Seen Call: flush failed, will retry", e);
        dirty = true;
        scheduleFlush();
    }
}

/**
 * Account switch: bank the outgoing account's sightings and load the incoming account's.
 */
async function onConnectionOpen() {
    if (!started) return;
    const next = currentAccount();
    if (next === accountId) return; // reconnect, not a switch
    if (dirty) await flush();       // still keyed to the OLD account
    loaded = false;
    seen = {};
    await load();
    if (!started) return;
    try {
        const n = sweepAllVoiceStates(VoiceStateStore.getAllVoiceStates() ?? {}, currentAccount(), Date.now());
        if (n) notify();
    } catch (err) { console.error("[Xicord Last Seen Call] switch sweep failed", err); }
}

function getSeen(userId: string): SeenRec | null {
    return seen[userId] ?? null;
}

function formatAgo(ms: number): string {
    const m = Math.floor(ms / 60000);
    if (!(m >= 1)) return "just now"; // also catches NaN and negative (clock skew)
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d`;
    return `${Math.floor(d / 30)}mo`;
}

function describePlace(rec: SeenRec): string {
    const channel = rec.channelId ? ChannelStore.getChannel(rec.channelId) : null;
    if (!channel) return "a voice channel";
    try {
        if (channel.isDM()) return "a DM call";
        if (channel.isGroupDM()) return "a group call";
    } catch { }
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    return guild ? `${channel.name} (${guild.name})` : channel.name || "a voice channel";
}

const ClockIcon = ({ size = 14 }: { size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
            fill="currentColor"
            d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm-1 3a1 1 0 0 1 2 0v4.59l2.7 2.7a1 1 0 0 1-1.4 1.42l-3-3A1 1 0 0 1 11 12V7Z"
        />
    </svg>
);

// Module-scope so the badge component keeps a stable identity across profile re-renders
// (the Badges API spreads `userId` into props and wraps this in an ErrorBoundary itself,
// so a fresh closure here would remount the pill and drop tooltip/hover state each time).
function LastSeenPill({ userId }: { userId: string; }) {
    const [, force] = React.useReducer(x => x + 1, 0);
    // Subscribe to sightings AND tick, so an open profile neither freezes on its opening
    // "just now" nor keeps showing a stale time after they rejoin a call.
    React.useEffect(() => {
        listeners.add(force);
        const t = setInterval(force, 30000);
        return () => { listeners.delete(force); clearInterval(t); };
    }, []);

    const rec = getSeen(userId);
    if (!rec) return null;
    const ago = formatAgo(Date.now() - rec.at);
    const tip = ago === "just now"
        ? `Seen in call just now — ${describePlace(rec)}`
        : `Last seen in call ${ago} ago — ${describePlace(rec)}`;
    return (
        <Tooltip text={tip}>
            {(tooltipProps: any) => (
                <span
                    {...tooltipProps}
                    style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "0 5px",
                        borderRadius: 8,
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--text-muted)",
                        background: "var(--background-modifier-accent)"
                    }}
                >
                    <ClockIcon />
                    {ago}
                </span>
            )}
        </Tooltip>
    );
}

function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    if (!userId || userId === UserStore.getCurrentUser()?.id) return [];
    if (!getSeen(userId)) return [];
    // Pass LastSeenPill unwrapped and by reference: the Badges API wraps it in its own
    // ErrorBoundary and merges `userId` into the props it renders it with.
    return [{
        id: "xicord-last-seen-call",
        key: "xicord-last-seen-call",
        description: "Last seen in call",
        component: LastSeenPill
    }];
}

const badge: ProfileBadge = {
    id: "xicord-last-seen-call",
    description: "Last seen in call",
    position: BadgePosition.END,
    getBadges
};

const onVoiceStates = (event: any) => {
    try {
        const n = applyVoiceStates(event?.voiceStates ?? [], UserStore.getCurrentUser()?.id ?? null, Date.now());
        if (n) notify();
    } catch (err) {
        console.error("[Xicord Last Seen Call] failed to handle voice state", err);
    }
};

export default definePlugin({
    name: "Xicord Last Seen Call",
    description: "Remembers when everyone you can see was last in a voice call and shows it in their profile",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],

    start() {
        started = true;
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStates);
        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
        addProfileBadge(badge);
        void load().then(() => {
            if (!started) return; // disabled while the read was in flight
            try {
                const n = sweepAllVoiceStates(
                    VoiceStateStore.getAllVoiceStates() ?? {},
                    UserStore.getCurrentUser()?.id ?? null,
                    Date.now()
                );
                if (n) notify();
            } catch (err) {
                console.error("[Xicord Last Seen Call] startup sweep failed", err);
            }
        });
    },

    stop() {
        started = false;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStates);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        removeProfileBadge(badge);
        listeners.clear();
        if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
        if (reloadTimer != null) { clearTimeout(reloadTimer); reloadTimer = null; }
        if (dirty) void flush();
    }
});
