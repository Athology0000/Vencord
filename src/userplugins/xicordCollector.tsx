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
import { definePluginSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, ChannelStore, FluxDispatcher, Forms, React, RelationshipStore, Switch as SwitchRaw, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const WINDOW_DAYS = 60;         // prune per-day message buckets older than this
const MAX_PRESENCE = 1000;      // cap stored presence sessions
const FLUSH_DELAY = 5000;       // debounce persistence to settings
const TRACKED_TTL = 30 * 1000;  // recompute the "people I care about" set at most this often

const settings = definePluginSettings({
    countMessages: {
        description: "Count messages (no content stored - just how many, from whom, where, and when) for people you follow",
        type: OptionType.BOOLEAN,
        default: true,
    },
    trackPresence: {
        description: "Record when your friends are online (online/offline sessions)",
        type: OptionType.BOOLEAN,
        default: true,
    },
    // Persisted datasets (JSON). Kept compact + bounded.
    messageData: {
        description: "Collected message-activity aggregates (JSON)",
        type: OptionType.STRING,
        default: "",
    },
    presenceData: {
        description: "Collected presence sessions (JSON)",
        type: OptionType.STRING,
        default: "",
    },
});

interface MessageData {
    since: number;
    daily: Record<string, number>;    // "YYYY-MM-DD" -> count
    byUser: Record<string, number>;   // userId -> count
    byChannel: Record<string, number>;// channelId -> count
}
interface PresenceSession { userId: string; start: number; end: number; }

let active = false;
let dirty = false;
let flushTimer: any = null;

let msg: MessageData = { since: 0, daily: {}, byUser: {}, byChannel: {} };
let presence: PresenceSession[] = [];
const onlineSince = new Map<string, number>(); // friend -> when they went online

// -------- tracked set (friends + traits + targets + watched) --------
let trackedCache = new Set<string>();
let trackedAt = 0;
function parseArr(raw: any): string[] {
    if (typeof raw !== "string") return [];
    try { const d = JSON.parse(raw); return Array.isArray(d) ? d.filter(x => typeof x === "string") : []; } catch { return []; }
}
function tracked(): Set<string> {
    const now = Date.now();
    if (now - trackedAt < TRACKED_TTL) return trackedCache;
    const s = new Set<string>();
    try { ((RelationshipStore as any).getFriendIDs?.() ?? []).forEach((id: string) => s.add(id)); } catch { }
    try {
        const tasks = Settings.plugins["Xicord Traits"]?.tasks;
        if (typeof tasks === "string") JSON.parse(tasks || "[]").forEach((t: any) => String(t.users ?? "").split("/").filter(Boolean).forEach((id: string) => s.add(id)));
    } catch { }
    // Both of these now migrate into the "Target" trait above and are normally
    // empty. Kept as a fallback: migration only runs when the owning plugin
    // starts, so a disabled Orbit/Mutuals would otherwise lose its old list here.
    parseArr(Settings.plugins["Xicord Mutuals"]?.targets).forEach(id => s.add(id));
    parseArr(Settings.plugins["Xicord Orbit"]?.watched).forEach(id => s.add(id));
    trackedCache = s;
    trackedAt = now;
    return s;
}

// -------- persistence --------
function load() {
    try { const d = JSON.parse(settings.store.messageData || "{}"); if (d && d.daily) msg = { since: d.since || Date.now(), daily: d.daily || {}, byUser: d.byUser || {}, byChannel: d.byChannel || {} }; }
    catch { }
    if (!msg.since) msg.since = Date.now();
    try { const p = JSON.parse(settings.store.presenceData || "[]"); if (Array.isArray(p)) presence = p; } catch { }
}
function prune() {
    const cut = Date.now() - WINDOW_DAYS * 86400000;
    const cutKey = dayKey(cut);
    for (const k of Object.keys(msg.daily)) if (k < cutKey) delete msg.daily[k];
    if (presence.length > MAX_PRESENCE) presence = presence.slice(presence.length - MAX_PRESENCE);
}
function scheduleFlush() {
    dirty = true;
    if (flushTimer != null) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY);
}
function flush() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    if (!dirty) return;
    prune();
    try {
        settings.store.messageData = JSON.stringify(msg);
        settings.store.presenceData = JSON.stringify(presence);
        dirty = false;
    } catch (e) { console.error("Xicord Collector: flush failed", e); }
}

function dayKey(ts: number) {
    const d = new Date(ts);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// -------- event handlers --------
const onMessageCreate = (e: any) => {
    if (!active || !settings.store.countMessages) return;
    const m = e?.message;
    const authorId = m?.author?.id;
    if (!authorId || m?.author?.bot) return;
    if (!tracked().has(authorId)) return;

    const channelId = m.channel_id ?? e.channelId;
    const ts = Date.now();
    msg.daily[dayKey(ts)] = (msg.daily[dayKey(ts)] || 0) + 1;
    msg.byUser[authorId] = (msg.byUser[authorId] || 0) + 1;
    if (channelId) msg.byChannel[channelId] = (msg.byChannel[channelId] || 0) + 1;
    scheduleFlush();
};

const onPresenceUpdates = (e: any) => {
    if (!active || !settings.store.trackPresence) return;
    for (const u of e?.updates ?? []) {
        const id = u?.user?.id;
        if (!id) continue;
        try { if (!(RelationshipStore as any).isFriend?.(id)) continue; } catch { continue; }
        const status = u.status ?? "offline";
        const isOnline = status !== "offline" && status !== "invisible";
        const openAt = onlineSince.get(id);
        if (isOnline && openAt == null) {
            onlineSince.set(id, Date.now());
        } else if (!isOnline && openAt != null) {
            onlineSince.delete(id);
            presence.push({ userId: id, start: openAt, end: Date.now() });
            scheduleFlush();
        }
    }
};

/** Snapshot for Xicord Cache */
export const CollectorAPI = {
    dump() {
        // close currently-open presence sessions into a copy so the export is complete
        const now = Date.now();
        const openSessions = [...onlineSince.entries()].map(([userId, start]) => ({ userId, start, end: now, open: true }));
        return {
            messages: { since: msg.since, daily: { ...msg.daily }, byUser: { ...msg.byUser }, byChannel: { ...msg.byChannel } },
            presence: [...presence, ...openSessions],
        };
    }
};

// -------- UI --------
function CollectorModal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const totalMsgs = Object.values(msg.byUser).reduce((a, b) => a + b, 0);
    const stats: Array<[string, number]> = [
        ["Messages counted", totalMsgs],
        ["People tracked", Object.keys(msg.byUser).length],
        ["Channels seen", Object.keys(msg.byChannel).length],
        ["Presence sessions", presence.length],
    ];
    return (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <CollectorIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Collector</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                    Quietly builds up activity data - message counts and presence - for the people you
                    follow (friends, traits, targets, watched), so the Xicord Dashboard has more than
                    voice to graph. Only counts and timestamps are stored, never message content.
                </Forms.FormText>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column", gap: "4px" }}>
                    <Switch value={settings.store.countMessages} onChange={(v: boolean) => { settings.store.countMessages = v; force(); }}>
                        Count messages from followed people
                    </Switch>
                    <Switch value={settings.store.trackPresence} onChange={(v: boolean) => { settings.store.trackPresence = v; force(); }}>
                        Record friends' online/offline sessions
                    </Switch>
                </Flex>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Collected so far</Forms.FormTitle>
                    {stats.map(([label, n]) => (
                        <Flex key={label} style={{ flexDirection: "row", alignItems: "center" }}>
                            <Forms.FormText style={{ flexGrow: 1 }}>{label}</Forms.FormText>
                            <Forms.FormText style={{ opacity: 0.7 }}>{n}</Forms.FormText>
                        </Flex>
                    ))}
                </Flex>

                <Flex style={{ marginTop: "15px", marginBottom: "10px", gap: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.RED} onClick={() => {
                        msg = { since: Date.now(), daily: {}, byUser: {}, byChannel: {} };
                        presence = []; onlineSince.clear(); dirty = true; flush(); force();
                    }}>Clear data</Button>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function CollectorIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <path d="M3 3h2v18H3V3Zm16 8h2v10h-2V11Zm-4-6h2v16h-2V5ZM7 9h2v12H7V9Zm4 4h2v8h-2v-8Z" />
        </g></svg>
    );
}

function collectorButton() {
    return (
        <Button2 onClick={() => openModal(props => <CollectorModal {...props} />)}
            onContextMenu={() => openModal(props => <CollectorModal {...props} />)}
            role="switch" tooltipText="Xicord Collector"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <path d="M3 3h2v18H3V3Zm16 8h2v10h-2V11Zm-4-6h2v16h-2V5ZM7 9h2v12H7V9Zm4 4h2v8h-2v-8Z" />
            </g></svg>} />
    );
}

export default definePlugin({
    name: "Xicord Collector",
    description: "Builds up activity telemetry (message counts + presence, no content) for people you follow, feeding richer graphs to the Xicord Dashboard",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu"],
    settings,
    xicordButton: ErrorBoundary.wrap(collectorButton, { noop: true }),
    start() {
        active = true;
        load();
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdates);
        // Close any open presence sessions and persist immediately
        const now = Date.now();
        for (const [userId, start] of onlineSince) presence.push({ userId, start, end: now });
        onlineSince.clear();
        dirty = true;
        flush();
    },
});
