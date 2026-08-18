/*
MIT License

Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import * as DataStore from "@api/DataStore";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { openUserProfile } from "@utils/discord";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Button, ChannelStore, FluxDispatcher, Forms, GuildStore, React, TextInput, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { clickable } from "./_a11y";
import { WatchAPI } from "./xicordOrbit";

const isWatched = (id: string) => { try { return WatchAPI.has(id); } catch { return false; } };

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const VoiceStateStore = findStoreLazy("VoiceStateStore");

// 500 was about half a day of one busy server. The log is the raw material every
// other Xicord read is derived from — who was where, with whom, for how long — so a
// cap that small quietly discarded the history before anything could ask about it.
const DEFAULT_MAX_SESSIONS = 250000;
const MIN_MAX_SESSIONS = 500;
const MAX_MAX_SESSIONS = 2000000;
// Cutting back to exactly the cap on every insert would shift the whole array once per
// voice event. Let it run over by this much and drop that many in one go instead, which
// makes the trim amortised rather than per-session.
const TRIM_SLACK = 2000;
const FLUSH_DELAY = 60000;
// How far back a search in the modal reaches. Bounded because each row costs a store
// lookup; the log itself is not bounded by this.
const SEARCH_SCAN = 20000;

const settings = definePluginSettings({
    maxSessions: {
        description: `How many voice sessions to keep — oldest drop off past this (${MIN_MAX_SESSIONS}–${MAX_MAX_SESSIONS})`,
        type: OptionType.NUMBER,
        default: DEFAULT_MAX_SESSIONS,
    },
    sessions: {
        // Legacy home. Every closed session re-stringified the ENTIRE log into
        // settings.json, which Vencord rewrites in full for any unrelated setting
        // change — so the old cap could not be raised without making both the write
        // cost and the corruption blast radius grow with the history. The log now
        // lives in IndexedDB; this is kept only to migrate an existing install.
        description: "Legacy session store — migrated to IndexedDB on first load",
        type: OptionType.STRING,
        default: "[]",
    },
    trackSelf: {
        description: "Also record your own voice sessions",
        type: OptionType.BOOLEAN,
        default: false,
    },
    roomAlerts: {
        description: "Say when someone opens a voice channel (first in) or closes it (last out)",
        type: OptionType.BOOLEAN,
        default: true,
    },
    roomAlertsWatchedOnly: {
        description: "…only for people on your watchlist. Off means every channel in every server — a lot",
        type: OptionType.BOOLEAN,
        default: true,
    },
});

interface Session {
    userId: string;
    channelId: string;
    guildId?: string;
    join: number;
    leave: number;
    /** They walked into an empty room — nobody was there before them. */
    firstIn?: boolean;
    /** They left it empty — nobody was there after them. */
    lastOut?: boolean;
}

/**
 * Who is in each voice channel right now, so a session can be told whether it opened or
 * closed the room.
 *
 * A separate map from `open` because that one is keyed by user: it can answer "where is
 * this person" but not "who else is in there", and the whole question here is the second
 * one. Bots are never counted — a music bot idling in a channel would otherwise take
 * "first in" from the person who actually started the call, and would keep the room
 * occupied forever so nobody could ever be last out.
 */
const occupants = new Map<string, Set<string>>();

/** Add someone to a room. True if they turned the lights on. */
function enterRoom(rooms: Map<string, Set<string>>, channelId: string, userId: string): boolean {
    let who = rooms.get(channelId);
    if (!who) rooms.set(channelId, who = new Set());
    // Re-adding somebody already counted is not a new arrival. A voice-state update can
    // repeat, and treating a repeat as an arrival would report a room opening twice.
    if (who.has(userId)) return false;
    const wasEmpty = who.size === 0;
    who.add(userId);
    return wasEmpty;
}

/** Remove someone from a room. True if they turned the lights off. */
function leaveRoom(rooms: Map<string, Set<string>>, channelId: string, userId: string): boolean {
    const who = rooms.get(channelId);
    if (!who || !who.delete(userId)) return false;   // never counted, so nothing changed
    if (who.size) return false;
    rooms.delete(channelId);                          // don't keep empty rooms around
    return true;
}

const SESSIONS_KEY = "XicordHistorySessions";
// Account-scoped: the voice history this account's client witnessed stays with this
// account. A switch banks the outgoing log and loads the incoming account's own.
const sessionsKeyFor = (id: string | null) => (id ? `${SESSIONS_KEY}:${id}` : SESSIONS_KEY);
const currentAccount = () => { try { return UserStore.getCurrentUser()?.id ?? null; } catch { return null; } };
let accountId: string | null = null;
let loadSeq = 0;

// Most recently ENDED first, which is the order they are recorded in. Note that is not
// the same as newest by join time: a session someone held for seven hours lands at the
// front the moment it closes, carrying its old start time with it.
let sessions: Session[] = [];
let loaded = false;
let dirty = false;
let flushTimer: any = null;

/** The configured cap, clamped — a blank or silly value must not wipe the log. */
function sessionCap(): number {
    const n = Math.floor(Number(settings.store.maxSessions));
    // A blank box reads as 0, which is finite — clamping that to the floor would
    // silently restore the tiny old cap instead of meaning "unset".
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_SESSIONS;
    return Math.max(MIN_MAX_SESSIONS, Math.min(MAX_MAX_SESSIONS, n));
}

/** Drop the longest-ended sessions once the list has run `slack` past the cap. In place. */
function trimSessions(list: Session[], cap: number, slack = TRIM_SLACK): Session[] {
    if (list.length > cap + slack) list.length = cap;
    return list;
}

function parseLegacy(raw: any): Session[] {
    if (typeof raw !== "string") return [];
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}

/**
 * Read the log, migrating it out of settings.json the first time.
 *
 * Runs at import rather than in start(), so the dashboard snapshot still finds the
 * history when the plugin is switched off — that used to hold because the log lived in
 * settings, which is readable whether or not a plugin is running.
 */
async function load() {
    const seq = ++loadSeq;
    const acct = accountId = currentAccount();
    let data: any;
    try {
        data = await DataStore.get(sessionsKeyFor(acct));
        // Adopt the old global log into whoever is logged in now, once, then remove it.
        if (!Array.isArray(data) && acct) {
            const unscoped = await DataStore.get(SESSIONS_KEY);
            if (Array.isArray(unscoped) && unscoped.length) {
                await DataStore.set(sessionsKeyFor(acct), unscoped);
                await DataStore.del(SESSIONS_KEY);
                data = unscoped;
            }
        }
    } catch (e) { console.error("Xicord History: load failed", e); }
    if (seq !== loadSeq) return;   // a newer switch superseded this load

    if (Array.isArray(data)) {
        sessions = data;
    } else {
        sessions = [];
        const legacy = parseLegacy(settings.store.sessions);
        if (legacy.length) {
            sessions = legacy;
            try {
                await DataStore.set(sessionsKeyFor(acct), sessions);
                // only let go of the old copy once the new home actually has it
                settings.store.sessions = "[]";
            } catch (e) { console.error("Xicord History: migration failed", e); }
        }
    }
    trimSessions(sessions, sessionCap(), 0);
    loaded = true;
}

const ready = load();

function scheduleFlush() {
    dirty = true;
    if (flushTimer != null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY);
}

function flush() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    // Never write before the read has landed, or an empty log overwrites the real one
    if (!dirty || !loaded) return;
    dirty = false;
    // Snapshot: the structured clone happens when the transaction runs, and voice
    // events keep mutating `sessions` in the meantime. Capture the key too — an account
    // switch replaces both mid-write, and the outgoing log must not land under the
    // incoming account's key.
    const key = sessionsKeyFor(accountId);
    const writing = sessions.slice();
    // IndexedDB takes the array as-is — no JSON.stringify of the whole log on the main
    // thread for every session, and nothing else in Vencord is rewritten alongside it.
    void DataStore.set(key, writing).catch(e => {
        dirty = true; // let the next flush retry
        console.error("Xicord History: save failed", e);
    });
}

/** Seed open sessions + room census from whoever is already in a VC, so their session has
 *  a sensible start time instead of being missed entirely. Reused on start and on switch. */
function seedOpenSessions() {
    try {
        const me = UserStore.getCurrentUser()?.id;
        // getAllVoiceStates() is keyed by GUILD id; each inner VoiceState carries its own
        // channelId, which is what we actually want.
        const all = VoiceStateStore.getAllVoiceStates() ?? {};
        const now = Date.now();
        for (const guildStates of Object.values(all)) {
            for (const vs of Object.values(guildStates as Record<string, any>)) {
                const userId = vs?.userId;
                const channelId = vs?.channelId;
                if (!userId || !channelId) continue;
                if (userId === me) {
                    myLastChannelId = channelId;
                    if (!settings.store.trackSelf) continue;
                }
                // Seed the room census too, or the first person to leave after a restart
                // would look like they emptied a channel that was full. Deliberately NOT
                // marked firstIn: we did not see them arrive.
                if (!isBot(userId)) enterRoom(occupants, channelId, userId);
                if (!open.has(userId)) {
                    open.set(userId, { channelId, guildId: ChannelStore.getChannel(channelId)?.guild_id, join: now });
                }
            }
        }
    } catch { }
}

/**
 * Account switch: bank the outgoing account's sessions and load the incoming account's.
 * Fires on login too, where the account is unchanged and this is a no-op reseed.
 */
async function onConnectionOpen() {
    if (!active) return;
    const next = currentAccount();
    if (next === accountId) return; // reconnect, not a switch
    const now = Date.now();
    // Close open sessions against the OLD account, then flush them there.
    for (const userId of [...open.keys()]) closeSession(userId, now);
    flush();
    loaded = false;
    open.clear();
    occupants.clear();
    await load();       // reads the incoming account's own log, migrating if needed
    if (active) seedOpenSessions();
}

/** The recorded log, newest first. Read-only for consumers (the cache snapshot). */
export function getSessions(): Session[] { return sessions; }

function clearSessions() {
    sessions = [];
    dirty = true;
    // if the read has not landed yet, flush() would refuse to write — wait it out
    if (loaded) flush(); else scheduleFlush();
}

// Open sessions keyed by userId -> {channelId, join}
const open = new Map<string, { channelId: string; guildId?: string; join: number; firstIn?: boolean; }>();
let active = false;
// For the local user only, a channel MOVE arrives with channelId === oldChannelId,
// so we track our own last channel separately to detect moves (see vcNarrator)
let myLastChannelId: string | undefined;
const listeners = new Set<() => void>();

function notify() { listeners.forEach(l => { try { l(); } catch { } }); }

function closeSession(userId: string, at: number, lastOut = false) {
    const o = open.get(userId);
    if (!o) return;
    open.delete(userId);
    // Written as undefined rather than false when they do not apply: these are rare, and
    // a `false` on every one of tens of thousands of stored sessions is dead weight in a
    // file that is read back on every start.
    sessions.unshift({
        userId, channelId: o.channelId, guildId: o.guildId, join: o.join, leave: at,
        firstIn: o.firstIn || undefined,
        lastOut: lastOut || undefined
    });
    trimSessions(sessions, sessionCap());
    scheduleFlush();
    notify();
}

/**
 * What this session did to the room, in words, or "" if it was neither.
 *
 * Both at once is the interesting one and gets its own phrase: they were there for the
 * whole of it, which is a different claim from having merely arrived first.
 */
export function roomRole(s: { firstIn?: boolean; lastOut?: boolean; }): string {
    if (s.firstIn && s.lastOut) return "held the room";
    if (s.firstIn) return "first in";
    if (s.lastOut) return "last out";
    return "";
}

function isBot(userId: string) {
    try { return !!UserStore.getUser(userId)?.bot; } catch { return false; }
}

/**
 * Say that someone opened or closed a room.
 *
 * Off by default for everyone but your watchlist, and that default is the point: across
 * every server you are in, rooms open and close constantly, and an alert for each one is
 * noise that trains you to ignore the alerts that matter. Recording it on the session is
 * free and always happens; interrupting you is the part that has to be earned.
 */
function announce(userId: string, kind: "first-in" | "last-out", channelId: string) {
    if (!settings.store.roomAlerts) return;
    if (settings.store.roomAlertsWatchedOnly && !isWatched(userId)) return;
    const who = UserStore.getUser(userId)?.username ?? userId;
    const ch = ChannelStore.getChannel(channelId);
    const where = ch?.name ? `#${ch.name}` : "a voice channel";
    const text = kind === "first-in" ? `${who} was first into ${where}` : `${who} was last out of ${where}`;
    // The shared Orbit log, so it sits alongside every other watched-person event.
    try { WatchAPI.log({ userId, text, channelId, guildId: ch?.guild_id }); } catch { }
    try {
        Toasts.show({
            message: text,
            id: `xicord-room-${kind}-${userId}-${Date.now()}`,
            type: Toasts.Type.MESSAGE,
            options: { position: Toasts.Position.BOTTOM }
        });
    } catch { }
}

const onVoiceStateUpdates = (e: any) => {
    if (!active) return;
    const me = UserStore.getCurrentUser()?.id;
    const now = Date.now();

    for (const state of e?.voiceStates ?? []) {
        const { userId, channelId } = state;
        let { oldChannelId } = state;
        if (!userId) continue;
        if (userId === me) {
            if (!settings.store.trackSelf) continue;
            // Local moves report channelId === oldChannelId; use our tracked value
            oldChannelId = myLastChannelId;
            myLastChannelId = channelId ?? undefined;
        }
        if (channelId === oldChannelId) continue;

        // Bots are not counted as occupants — see the note on `occupants`.
        const human = !isBot(userId);

        // Leaving or moving out of the previous channel closes the open session
        if (oldChannelId) {
            const emptied = human && leaveRoom(occupants, oldChannelId, userId);
            closeSession(userId, now, emptied);
            if (emptied) announce(userId, "last-out", oldChannelId);
        }

        // Joining (or moving into) a channel opens a new one
        if (channelId) {
            const opened = human && enterRoom(occupants, channelId, userId);
            open.set(userId, {
                channelId,
                guildId: ChannelStore.getChannel(channelId)?.guild_id,
                join: now,
                firstIn: opened || undefined
            });
            if (opened) announce(userId, "first-in", channelId);
        }
    }
};

function fmtDuration(ms: number) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtDate(ts: number) {
    try { return new Date(ts).toLocaleString(); } catch { return String(ts); }
}

function channelLabel(session: Session) {
    const channel = ChannelStore.getChannel(session.channelId);
    const guild = session.guildId ? GuildStore.getGuild(session.guildId) : null;
    const cName = channel?.name ?? "voice channel";
    return guild ? `${cName} - ${guild.name}` : cName;
}

function HistoryModal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const [query, setQuery] = React.useState("");
    React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);

    const q = query.trim().toLowerCase();
    // Searching hits a user-store and a guild-store lookup per row, so scanning the
    // whole log on every keystroke would stall the modal now that the log is large.
    // Search the most recent window instead, and say so rather than reporting a
    // truncated count as if it were the total.
    const scanned = q === "" ? sessions : sessions.slice(0, SEARCH_SCAN);
    const filtered = q === "" ? sessions : scanned.filter(s => {
        const user = UserStore.getUser(s.userId);
        return (user?.username ?? s.userId).toLowerCase().includes(q)
            || channelLabel(s).toLowerCase().includes(q);
    });
    const capped = q !== "" && sessions.length > SEARCH_SCAN;

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <HistoryIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord History</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Flex style={{ marginTop: "10px", gap: "10px", alignItems: "center" }}>
                    <div style={{ flexGrow: 1 }}>
                        <TextInput value={query} placeholder="Search by user or channel..." onChange={(e: string) => setQuery(e)} />
                    </div>
                    <Button2 onClick={() => { clearSessions(); force(); }} role="switch" tooltipText="Clear history"
                        icon={() => <svg width="16" height="16" viewBox="0 0 24 24"><g fill="var(--red-430)"><path d="M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z" /><path fillRule="evenodd" d="M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07Z" /></g></svg>} />
                </Flex>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", flexDirection: "column" }}>
                    <Forms.FormText style={{ opacity: 0.6, marginBottom: "5px" }}>
                        {filtered.length} session{filtered.length === 1 ? "" : "s"}
                        {capped ? ` in the most recent ${SEARCH_SCAN.toLocaleString()} of ${sessions.length.toLocaleString()}` : ""}
                        {open.size > 0 ? ` (${open.size} in progress)` : ""}
                    </Forms.FormText>
                    {filtered.length !== 0 ? filtered.slice(0, 200).map((s, i) => {
                        const user = UserStore.getUser(s.userId);
                        return (
                            <Flex key={i} style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                                {/* was aria-hidden AND clickable: an interactive element removed from
                                    the accessibility tree, so opening the profile needed a mouse */}
                                <img height={24} width={24} src={user?.getAvatarURL()} alt=""
                                    {...clickable(() => openUserProfile(s.userId), {
                                        label: `Open ${user?.username ?? s.userId}'s Discord profile`,
                                        style: { borderRadius: "50%" }
                                    })} />
                                <Flex style={{ flexGrow: 1, flexDirection: "column", gap: 0 }}>
                                    <Forms.FormText>{user?.username ?? s.userId} in {channelLabel(s)}</Forms.FormText>
                                    <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>
                                        {fmtDate(s.join)}
                                        {roomRole(s) && <> · <span style={{ color: "var(--text-brand, #a0a8ff)" }}>{roomRole(s)}</span></>}
                                    </Forms.FormText>
                                </Flex>
                                <Forms.FormText style={{ opacity: 0.7 }}>{fmtDuration(s.leave - s.join)}</Forms.FormText>
                            </Flex>
                        );
                    }) : <Forms.FormText>No sessions recorded yet.</Forms.FormText>}
                </Flex>

                <Flex style={{ marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function HistoryIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <path d="M13 3a9 9 0 1 0 8.94 10H19.9A7 7 0 1 1 13 5V3Z" />
            <path d="M12 7a1 1 0 0 1 1 1v4.6l3.3 1.9-.9 1.7-4.4-2.5V8a1 1 0 0 1 1-1Z" />
            <path d="M13 3v4l4-2-4-2Z" opacity=".6" />
        </g></svg>
    );
}

function historyButton() {
    return (
        <Button2 onClick={() => openModal(props => <HistoryModal {...props} />)}
            onContextMenu={() => openModal(props => <HistoryModal {...props} />)}
            role="switch" tooltipText="Xicord History"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <path d="M13 3a9 9 0 1 0 8.94 10H19.9A7 7 0 1 1 13 5V3Z" />
                <path d="M12 7a1 1 0 0 1 1 1v4.6l3.3 1.9-.9 1.7-4.4-2.5V8a1 1 0 0 1 1-1Z" />
                <path d="M13 3v4l4-2-4-2Z" opacity=".6" />
            </g></svg>} />
    );
}

export default definePlugin({
    name: "Xicord History",
    description: "Records a searchable, persistent log of who was in which voice channel and for how long",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu"],
    settings,
    xicordButton: ErrorBoundary.wrap(historyButton, { noop: true }),
    async start() {
        // The log is read asynchronously now. Recording before it lands would append
        // to an empty array that the read then replaces, losing those sessions.
        await ready;
        active = true;
        seedOpenSessions();
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        // Close any in-progress sessions so they aren't lost on disable
        const now = Date.now();
        for (const userId of [...open.keys()]) closeSession(userId, now);
        // and write immediately rather than leaving up to a minute of them on a timer
        flush();
    },
});
