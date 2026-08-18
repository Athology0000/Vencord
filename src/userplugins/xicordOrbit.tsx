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
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Button, ChannelStore, FluxDispatcher, Forms, GuildStore, Menu, NavigationRouter, React, Toasts, Tooltip, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { addTargets, ensureTargetTrait, hasTarget, subscribeTargets, TARGET_TRAIT, targetIds, toggleTarget, unsubscribeTargets } from "./_targetTrait";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const PresenceStore = findStoreLazy("PresenceStore");

const MAX_LOG = 100;

const settings = definePluginSettings({
    watched: {
        description: "Legacy watched user IDs — migrated into the Target trait on start",
        type: OptionType.STRING,
        default: "[]",
        // Also migrate when written at runtime, so restoring a pre-Target backup
        // through Xicord Cache doesn't park the list here until the next restart
        onChange() { migrateLegacyWatched(); }
    },
    toasts: {
        description: "Show a toast when a watched user joins/leaves a voice channel or comes online",
        type: OptionType.BOOLEAN,
        default: true,
    },
    watchPresence: {
        description: "Also notify when a watched user comes online (not just voice)",
        type: OptionType.BOOLEAN,
        default: true,
    },
});

function parseIds(raw: string): string[] {
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.filter(id => typeof id === "string") : [];
    } catch { return []; }
}

// Who Orbit watches is the membership of the reserved "Target" trait, so giving
// someone that trait subjects them to every Xicord watcher at once. The parse is
// cached inside _targetTrait for the hot PRESENCE_UPDATES path.
const getWatched = () => targetIds();
const isWatched = (id: string) => hasTarget(id);

/** One-time move of the pre-trait watch list into the Target trait. */
function migrateLegacyWatched() {
    const legacy = parseIds(settings.store.watched);
    if (!legacy.length) return;
    addTargets(legacy);
    settings.store.watched = "[]";
}

interface LogEntry {
    userId: string;
    text: string;
    channelId?: string;
    guildId?: string;
    at: number;
}

// In-memory only: an activity feed, not something worth persisting
const log: LogEntry[] = [];
const listeners = new Set<() => void>();
const lastPresence = new Map<string, string>();
let active = false;

function notify() { listeners.forEach(l => { try { l(); } catch { } }); }

/** Snapshot of the in-memory activity log (for Xicord Cache) */
export function getActivityLog(): LogEntry[] { return [...log]; }

function appendLog(entry: LogEntry) {
    log.unshift(entry);
    if (log.length > MAX_LOG) log.length = MAX_LOG;
    notify();
}

function pushLog(entry: LogEntry) {
    appendLog(entry);
    if (settings.store.toasts) {
        Toasts.show({
            message: entry.text,
            id: `xicord-orbit-${entry.userId}-${entry.at}`,
            type: Toasts.Type.MESSAGE,
            options: { position: Toasts.Position.BOTTOM }
        });
    }
}

/**
 * Shared watch API for the sibling "watcher" plugins (Profile/Live/Post/Server/
 * Game Watch). They all read Orbit's single watched list and append to its
 * activity feed - so there's one list of people and one log, many signals.
 */
export const WatchAPI = {
    list(): string[] { return getWatched(); },
    has(id: string): boolean { return isWatched(id); },
    toggle(id: string) { toggleWatched(id); },
    subscribe(fn: () => void) { listeners.add(fn); },
    unsubscribe(fn: () => void) { listeners.delete(fn); },
    /** Append an event to the shared feed (no toast - the caller owns its own alert) */
    log(entry: { userId: string; text: string; channelId?: string; guildId?: string; }) {
        appendLog({ userId: entry.userId, text: entry.text, channelId: entry.channelId, guildId: entry.guildId, at: Date.now() });
    }
};

function channelLabel(channelId?: string) {
    if (!channelId) return "a voice channel";
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return "a voice channel";
    if (channel.isDM?.()) return "a DM call";
    if (channel.isGroupDM?.()) return "a group call";
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    return guild ? `${channel.name} - ${guild.name}` : channel.name;
}

const onVoiceStateUpdates = (e: any) => {
    if (!active) return;
    for (const state of e?.voiceStates ?? []) {
        const { userId, channelId, oldChannelId } = state;
        if (!userId || !isWatched(userId)) continue;
        if (channelId === oldChannelId) continue;
        const name = UserStore.getUser(userId)?.username ?? userId;

        if (channelId) {
            pushLog({
                userId, channelId,
                guildId: ChannelStore.getChannel(channelId)?.guild_id,
                text: `${name} joined ${channelLabel(channelId)}`,
                at: Date.now()
            });
        } else if (oldChannelId) {
            pushLog({
                userId,
                text: `${name} left ${channelLabel(oldChannelId)}`,
                at: Date.now()
            });
        }
    }
};

const onPresenceUpdates = (e: any) => {
    if (!active || !settings.store.watchPresence) return;
    for (const update of e?.updates ?? []) {
        const userId = update?.user?.id;
        if (!userId || !isWatched(userId)) continue;
        const status = update.status ?? "offline";
        const prev = lastPresence.get(userId) ?? "offline";
        lastPresence.set(userId, status);
        if (prev === "offline" && status !== "offline") {
            const name = UserStore.getUser(userId)?.username ?? userId;
            pushLog({ userId, text: `${name} is now ${status}`, at: Date.now() });
        }
    }
};

function toggleWatched(id: string) {
    // Presence seeding and notify() both happen in onTargetsChanged, so this works
    // identically no matter who does the targeting (here, the Traits modal, the
    // Traits context menu, or a Xicord Cache restore)
    toggleTarget(id);
}

let knownTargets = new Set<string>();
let lastTargetKey: string | null = null;

/** Seed presence for newly added targets so they don't fire a spurious "came online" toast. */
function onTargetsChanged() {
    const current = getWatched();
    // Xicord Mutuals rewrites its auto-managed trait in the same settings blob
    // every few seconds while scanning; without this the whole UI would re-render
    // on each of those writes even though the target list never moved.
    const key = current.join(",");
    if (key === lastTargetKey) return;
    lastTargetKey = key;
    for (const id of current) {
        if (!knownTargets.has(id)) lastPresence.set(id, PresenceStore.getStatus(id) ?? "offline");
    }
    knownTargets = new Set(current);
    notify();
}

function timeAgo(at: number) {
    const s = Math.floor((Date.now() - at) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

function OrbitModal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);

    const watched = getWatched();
    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <OrbitIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Orbit</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Watched Users — "{TARGET_TRAIT}" trait</Forms.FormTitle>
                    <Forms.FormText style={{ opacity: 0.6, fontSize: 12, marginBottom: "6px" }}>
                        Everyone holding the "{TARGET_TRAIT}" trait is watched by every Xicord watcher
                        (Profile, Live, Post, Server, Game) and recorded by Dossier. Edit the list here
                        or from Xicord Traits.
                    </Forms.FormText>
                    {watched.length !== 0 ? watched.map(id => {
                        const user = UserStore.getUser(id);
                        const status = PresenceStore.getStatus(id) ?? "offline";
                        return (
                            <Flex key={id} style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                                <img style={{ borderRadius: "50%" }} height={24} width={24} src={user?.getAvatarURL()} aria-hidden="true" />
                                <Forms.FormText style={{ flexGrow: 1 }}>{user?.username ?? id}</Forms.FormText>
                                <Forms.FormText style={{ opacity: 0.6 }}>{status}</Forms.FormText>
                                <Button2 onClick={() => toggleWatched(id)} role="switch" tooltipText="Unwatch"
                                    icon={() => <svg width="16" height="16" viewBox="0 0 24 24"><g fill="var(--red-430)"><path d="M18 6 6 18M6 6l12 12" stroke="var(--red-430)" strokeWidth="2" /></g></svg>} />
                            </Flex>
                        );
                    }) : <Forms.FormText>Right-click a user and choose "Watch User" (or tick "{TARGET_TRAIT}" under Traits) to add them.</Forms.FormText>}
                </Flex>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Activity</Forms.FormTitle>
                    {log.length !== 0 ? log.map((entry, i) => (
                        <Flex key={i} style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                            <Forms.FormText style={{ flexGrow: 1 }}>{entry.text}</Forms.FormText>
                            <Forms.FormText style={{ opacity: 0.5, fontSize: 12 }}>{timeAgo(entry.at)}</Forms.FormText>
                            {entry.channelId ? (
                                <Button2 onClick={() => {
                                    NavigationRouter.transitionTo(entry.guildId
                                        ? `/channels/${entry.guildId}/${entry.channelId}`
                                        : `/channels/@me/${entry.channelId}`);
                                    props.onClose();
                                }} role="switch" tooltipText="Jump to channel"
                                    icon={() => <svg width="16" height="16" viewBox="0 0 24 24"><g fill="#b5bac1"><path d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3Z" /></g></svg>} />
                            ) : null}
                        </Flex>
                    )) : <Forms.FormText>No activity yet.</Forms.FormText>}
                </Flex>

                <Flex style={{ marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function OrbitIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22Zm0 2a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z" opacity=".5" />
            <circle cx="21" cy="8" r="2" />
        </g></svg>
    );
}

function orbitButton() {
    return (
        <Button2 onClick={() => openModal(props => <OrbitModal {...props} />)}
            onContextMenu={() => openModal(props => <OrbitModal {...props} />)}
            role="switch" tooltipText="Xicord Orbit"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 1a11 11 0 1 0 0 22 11 11 0 0 0 0-22Zm0 2a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z" opacity=".5" />
                <circle cx="21" cy="8" r="2" />
            </g></svg>} />
    );
}

function MenuItem(id: string) {
    const [, force] = React.useReducer(x => x + 1, 0);
    return (
        <Menu.MenuCheckboxItem
            id="xicord-orbit-watch"
            label="Watch User"
            checked={isWatched(id)}
            action={() => { toggleWatched(id); force(); }}
        />
    );
}

function makeContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        if (!props?.user?.id) return;
        if (props.user.id === UserStore.getCurrentUser()?.id) return;
        children.splice(-1, 0, <Menu.MenuGroup>{MenuItem(props.user.id)}</Menu.MenuGroup>);
    };
}

export default definePlugin({
    name: "Xicord Orbit",
    description: "Watch users carrying the \"Target\" trait and get notified (plus an activity log) when they join or leave voice channels or come online",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Traits"],
    settings,
    xicordButton: ErrorBoundary.wrap(orbitButton, { noop: true }),
    contextMenus: { "user-context": makeContextMenuPatch() },
    start() {
        active = true;
        ensureTargetTrait();
        migrateLegacyWatched();
        // Seed presence so the first update doesn't spuriously fire "came online"
        knownTargets = new Set(getWatched());
        lastTargetKey = [...knownTargets].join(",");
        for (const id of knownTargets) lastPresence.set(id, PresenceStore.getStatus(id) ?? "offline");
        // Re-seed and re-render whenever the Target trait changes from anywhere
        subscribeTargets(onTargetsChanged);
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
    },
    stop() {
        active = false;
        unsubscribeTargets(onTargetsChanged);
        lastTargetKey = null;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdates);
    },
});
