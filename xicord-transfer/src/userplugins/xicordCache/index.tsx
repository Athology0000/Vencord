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
import { ApplicationCommandInputType } from "@api/Commands";
import { definePluginSettings, Settings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, ChannelStore, Forms, GuildStore, React, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { getActivityLog } from "../xicordOrbit";
import { MutualsAPI } from "../xicordMutuals";
import { CollectorAPI } from "../xicordCollector";
import { getDossiers, getFriendMap, getIdentityHistory, getResolvedUsers, rosterStats, syncStatus } from "../xicordDossier";
import { getSessions } from "../xicordHistory";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const CACHE_VERSION = 1;
const SNAPSHOT_INTERVAL = 120 * 1000;

const settings = definePluginSettings({
    autoSnapshot: {
        description: "Keep a live snapshot on disk so start.bat's dashboard auto-loads and refreshes your data",
        type: OptionType.BOOLEAN,
        default: true,
    },
    snapshot: {
        // Legacy home. It grew to 1.6MB inside settings.json, which Vencord rewrites in
        // full for every unrelated setting change; the snapshot now gets its own file.
        description: "Legacy snapshot store — moved to xicord-cache.json beside settings.json",
        type: OptionType.STRING,
        default: "",
    },
});

// Desktop-only: on web there is no main process to write files with, so the snapshot
// stays in settings.json there rather than being silently lost.
const Native = VencordNative.pluginHelpers["Xicord Cache"] as PluginNative<typeof import("./native")> | undefined;

let snapshotTimer: any = null;
let snapshotFile: string | null = null;

async function writeSnapshot() {
    try {
        if (!settings.store.autoSnapshot) return;
        const json = JSON.stringify(buildCache());

        if (!Native?.writeSnapshot) {
            settings.store.snapshot = json; // web build: nowhere else to put it
            return;
        }

        snapshotFile = await Native.writeSnapshot(json);
        // Only drop the old copy once the new file exists, so an install that never
        // manages to write the file keeps working off settings.json.
        if (settings.store.snapshot) settings.store.snapshot = "";
    } catch (e) { console.error("Xicord Cache: snapshot failed", e); }
}

function pluginSetting<T = any>(name: string, key: string): T | undefined {
    return Settings.plugins[name]?.[key] as T | undefined;
}

function parseJson<T>(raw: any, fallback: T): T {
    if (typeof raw !== "string") return fallback;
    try {
        const data = JSON.parse(raw);
        return data ?? fallback;
    } catch { return fallback; }
}

interface Session { userId: string; channelId: string; guildId?: string; join: number; leave: number; }
interface CacheTrait { name: string; url: string; users: string[]; }

function buildCache() {
    // The log moved out of settings.json into IndexedDB, so read it from History
    // itself. An install that has not migrated yet still has it in the old place, and
    // the snapshot must not come back empty for those.
    const history = ((): Session[] => {
        const live = (() => { try { return getSessions(); } catch { return []; } })();
        if (live.length) return live;
        return parseJson<Session[]>(pluginSetting("Xicord History", "sessions"), []);
    })().filter(s => s && s.userId && s.channelId);

    const traits: CacheTrait[] = parseJson<any[]>(pluginSetting("Xicord Traits", "tasks"), [])
        .filter(t => t && t.name)
        // Spread first so extra fields survive the round-trip. Dropping Mutuals'
        // `managed` flag here would permanently break its reset-on-resync path,
        // leaving the auto-managed trait growing forever after any restore.
        .map(t => ({ ...t, name: t.name, url: t.url ?? "", users: String(t.users ?? "").split("/").filter(Boolean) }));

    const targets = parseJson<string[]>(pluginSetting("Xicord Mutuals", "targets"), []);
    const hidden = parseJson<string[]>(pluginSetting("Xicord Mutuals", "hidden"), []);
    const watched = parseJson<string[]>(pluginSetting("Xicord Orbit", "watched"), []);
    const ghosted = parseJson<string[]>(pluginSetting("Xicord Ghost", "ghosted"), []);
    const watchlistRules = parseJson<any[]>(pluginSetting("Xicord Watchlist", "rules"), []);
    const orbitLog = getActivityLog();
    const mutuals = MutualsAPI.dump();
    const collector = CollectorAPI.dump();
    const dossiers = getDossiers();
    const friendMap = getFriendMap();
    // Renames and avatar changes observed over time. Export-only: it is a record of
    // what was witnessed, and restoring it into another install would be a fabrication.
    const identityHistory = (() => { try { return getIdentityHistory(); } catch { return {}; } })();
    // How much of the roster Mutuals has answered for, and where those people were found.
    // Without this the only readout is inside the modal, so "how many did the big server
    // actually give me" has no answer from the dashboard.
    const roster = (() => { try { return rosterStats(); } catch { return null; } })();
    // Whether uploads are actually landing. A sync that quietly fails looks exactly like
    // one that has nothing to send, so the last result has to be visible somewhere.
    const sync = (() => { try { return syncStatus(); } catch { return null; } })();

    // Collect every user / channel / guild ID referenced anywhere so the
    // dashboard can render names + avatars fully offline
    const userIds = new Set<string>();
    const channelIds = new Set<string>();
    const guildIds = new Set<string>();

    const addUser = (id?: string) => { if (id) userIds.add(id); };
    const addChannel = (id?: string) => { if (id) channelIds.add(id); };

    for (const s of history) { addUser(s.userId); addChannel(s.channelId); if (s.guildId) guildIds.add(s.guildId); }
    for (const t of traits) t.users.forEach(addUser);
    [...targets, ...hidden, ...watched, ...ghosted].forEach(addUser);
    for (const e of orbitLog) { addUser(e.userId); addChannel(e.channelId); if (e.guildId) guildIds.add(e.guildId); }
    for (const m of mutuals) { addUser(m.userId); m.mutuals.forEach(addUser); }
    Object.keys(collector.messages.byUser).forEach(addUser);
    Object.keys(collector.messages.byChannel).forEach(addChannel);
    for (const p of collector.presence) addUser(p.userId);
    for (const [tid, d] of Object.entries(dossiers)) {
        addUser(tid);
        Object.keys((d as any).companions).forEach(addUser);
        Object.keys((d as any).guilds).forEach(id => guildIds.add(id));
    }
    // The sweep meets people no other feature has ever recorded, so without this the
    // dashboard would list most of them as "user 1a2b3c" in the very view whose whole
    // point is naming who added whom.
    for (const id of Object.keys(identityHistory)) addUser(id);
    for (const [id, f] of Object.entries(friendMap)) {
        addUser(id);
        f.friends.forEach(addUser);
        f.guilds.forEach(g => guildIds.add(g));
    }

    // UserStore is memory-only and starts empty every launch, so on its own it named
    // barely a third of the people in the dossier and the dashboard showed the rest as
    // "user 1a2b3c". The Dossier keeps every name it has ever resolved on disk; use the
    // live store when it has someone (freshest) and fall back to that cache otherwise.
    const remembered = (() => { try { return getResolvedUsers(); } catch { return {}; } })();
    const users: Record<string, { username: string; avatar: string; }> = {};
    for (const id of userIds) {
        const u = UserStore.getUser(id);
        // The raw avatar HASH, not the full CDN URL. The dashboard rebuilds the URL from
        // id+hash on render, so storing the ~90-char boilerplate prefix on tens of
        // thousands of users was pure waste. null (no custom avatar) becomes "". The
        // remembered[] fallback already carries hashes — getResolvedUsers hashes them too.
        if (u) users[id] = { username: u.username, avatar: u.avatar ?? "" };
        else if (remembered[id]) users[id] = remembered[id];
    }

    const channels: Record<string, { name: string; guildId?: string; }> = {};
    for (const id of channelIds) {
        const c = ChannelStore.getChannel(id);
        if (c) {
            channels[id] = { name: c.name ?? "", guildId: c.guild_id };
            if (c.guild_id) guildIds.add(c.guild_id);
        }
    }

    const guilds: Record<string, { name: string; }> = {};
    for (const id of guildIds) {
        const g = GuildStore.getGuild(id);
        if (g) guilds[id] = { name: g.name };
    }

    const me = UserStore.getCurrentUser();

    return {
        xicordCache: CACHE_VERSION,
        exportedAt: Date.now(),
        self: me ? { id: me.id, username: me.username } : null,
        users,
        channels,
        guilds,
        history,
        traits,
        targets,
        hidden,
        watched,
        ghosted,
        watchlistRules,
        orbitLog,
        mutuals,
        messages: collector.messages,
        presence: collector.presence,
        dossiers,
        friendMap,
        identityHistory,
        roster,
        sync,
    };
}

// -------- import / restore --------
// Writes cache values back into the plugins' settings. Their onChange handlers
// (Mutuals, Orbit, Ghost) pick the changes up; Traits/Watchlist read live.
function restoreFromCache(data: any): string[] {
    const done: string[] = [];
    const setJson = (plugin: string, key: string, value: any, label: string) => {
        if (value === undefined || !Settings.plugins[plugin]) return;
        Settings.plugins[plugin][key] = JSON.stringify(value);
        done.push(label);
    };
    if (Array.isArray(data.hidden)) setJson("Xicord Mutuals", "hidden", data.hidden, "hidden users");
    if (Array.isArray(data.ghosted)) setJson("Xicord Ghost", "ghosted", data.ghosted, "ghosted users");
    if (Array.isArray(data.watchlistRules)) setJson("Xicord Watchlist", "rules", data.watchlistRules, "watchlist rules");
    if (Array.isArray(data.traits)) {
        // Cache stores trait users as arrays; Traits expects a "/"-joined string.
        // Extra fields are preserved so Mutuals' auto-managed trait survives.
        const tasks = data.traits.map((t: any) => ({
            ...t,
            name: t.name, url: t.url ?? "",
            users: Array.isArray(t.users) ? t.users.map((id: string) => `/${id}`).join("") : (t.users ?? "")
        }));
        setJson("Xicord Traits", "tasks", tasks, "traits");
    }
    // MUST come after traits: both of these are legacy lists that migrate into the
    // shared Target trait on write, so restoring them first would be overwritten
    // by the tasks restore above
    if (Array.isArray(data.watched)) setJson("Xicord Orbit", "watched", data.watched, "watched users");
    if (Array.isArray(data.targets)) setJson("Xicord Mutuals", "targets", data.targets, "targets");
    return done;
}

function download(json: string) {
    try {
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `xicord-cache-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
        console.error("Xicord Cache: download failed", e);
        Toasts.show({ message: "Download failed - use Copy instead", id: "xicord-cache-dl", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
    }
}

function CacheModal(props: RenderModalProps) {
    const cache = React.useMemo(() => buildCache(), []);
    const json = React.useMemo(() => JSON.stringify(cache, null, 2), [cache]);
    const importRef = React.useRef<HTMLInputElement>(null);

    const messageTotal = Object.values(cache.messages.byUser).reduce((a: number, b: any) => a + b, 0);
    const stats: Array<[string, number]> = [
        ["Voice sessions", cache.history.length],
        ["Messages counted", messageTotal],
        ["Presence sessions", cache.presence.length],
        ["Known users", Object.keys(cache.users).length],
        ["Channels", Object.keys(cache.channels).length],
        ["Traits", cache.traits.length],
    ];

    const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(String(reader.result));
                if (!data || typeof data !== "object" || !("xicordCache" in data)) throw new Error("not a Xicord cache");
                const restored = restoreFromCache(data);
                Toasts.show({
                    message: restored.length ? `Restored: ${restored.join(", ")}` : "Nothing to restore in that cache",
                    id: "xicord-cache-import",
                    type: restored.length ? Toasts.Type.SUCCESS : Toasts.Type.MESSAGE,
                    options: { position: Toasts.Position.BOTTOM }
                });
            } catch {
                Toasts.show({ message: "That isn't a valid Xicord cache", id: "xicord-cache-import-err", type: Toasts.Type.FAILURE, options: { position: Toasts.Position.BOTTOM } });
            }
        };
        reader.readAsText(file);
        if (importRef.current) importRef.current.value = "";
    };

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <CacheIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Cache</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                    Bundles the data from all your Xicord plugins - with usernames, avatars and
                    channel names baked in - into one portable JSON file. Load it into the Xicord
                    Dashboard to build graphs. Nothing leaves your machine.
                </Forms.FormText>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>In this snapshot</Forms.FormTitle>
                    {stats.map(([label, n]) => (
                        <Flex key={label} style={{ flexDirection: "row", alignItems: "center" }}>
                            <Forms.FormText style={{ flexGrow: 1 }}>{label}</Forms.FormText>
                            <Forms.FormText style={{ opacity: 0.7 }}>{n}</Forms.FormText>
                        </Flex>
                    ))}
                </Flex>

                <Forms.FormText style={{ marginTop: "14px", opacity: 0.7 }}>
                    Restoring writes a cache's targets, hidden/ghosted/watched lists, traits and
                    watchlist rules back into the plugins - use it as a backup or to move your setup
                    to another machine. It overwrites those lists with the cache's.
                </Forms.FormText>

                <Flex style={{ marginTop: "12px", marginBottom: "10px", gap: "10px", justifyContent: "flex-end", flexWrap: "wrap" }}>
                    <Button color={Button.Colors.PRIMARY} onClick={() => importRef.current?.click()}>Import / Restore…</Button>
                    <Button color={Button.Colors.PRIMARY} onClick={() => {
                        copyToClipboard(json);
                        Toasts.show({ message: "Cache copied to clipboard", id: "xicord-cache-copy", type: Toasts.Type.SUCCESS, options: { position: Toasts.Position.BOTTOM } });
                    }}>Copy JSON</Button>
                    <Button color={Button.Colors.GREEN} onClick={() => download(json)}>Download .json</Button>
                </Flex>
                <input ref={importRef} type="file" accept="application/json,.json" style={{ display: "none" }} onChange={onImportFile} />
            </ModalContent>
        </ModalRoot>
    );
}

function CacheIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <path d="M12 2C6.48 2 3 3.79 3 6v12c0 2.21 3.48 4 9 4s9-1.79 9-4V6c0-2.21-3.48-4-9-4Zm7 16c0 .82-2.72 2-7 2s-7-1.18-7-2v-2.3c1.7.94 4.3 1.3 7 1.3s5.3-.36 7-1.3V18Zm0-5c0 .82-2.72 2-7 2s-7-1.18-7-2v-2.3C6.7 11.64 9.3 12 12 12s5.3-.36 7-1.3V13Zm-7-3c-4.28 0-7-1.18-7-2s2.72-2 7-2 7 1.18 7 2-2.72 2-7 2Z" />
        </g></svg>
    );
}

function cacheButton() {
    return (
        <Button2 onClick={() => openModal(props => <CacheModal {...props} />)}
            onContextMenu={() => openModal(props => <CacheModal {...props} />)}
            role="switch" tooltipText="Xicord Cache"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <path d="M12 2C6.48 2 3 3.79 3 6v12c0 2.21 3.48 4 9 4s9-1.79 9-4V6c0-2.21-3.48-4-9-4Zm7 16c0 .82-2.72 2-7 2s-7-1.18-7-2v-2.3c1.7.94 4.3 1.3 7 1.3s5.3-.36 7-1.3V18Zm0-5c0 .82-2.72 2-7 2s-7-1.18-7-2v-2.3C6.7 11.64 9.3 12 12 12s5.3-.36 7-1.3V13Zm-7-3c-4.28 0-7-1.18-7-2s2.72-2 7-2 7 1.18 7 2-2.72 2-7 2Z" />
            </g></svg>} />
    );
}

export default definePlugin({
    name: "Xicord Cache",
    description: "Exports a portable JSON snapshot of all your Xicord plugin data (voice history, traits, mutuals, activity) for the Xicord Dashboard",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu"],
    settings,
    xicordButton: ErrorBoundary.wrap(cacheButton, { noop: true }),
    commands: [
        {
            name: "xicord-cache",
            description: "Copy a Xicord data cache to your clipboard",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute: () => {
                const json = JSON.stringify(buildCache(), null, 2);
                copyToClipboard(json);
                return { content: "" };
            },
        },
    ],
    start() {
        // First snapshot shortly after load (deps ready), then on an interval
        setTimeout(writeSnapshot, 8000);
        snapshotTimer = setInterval(writeSnapshot, SNAPSHOT_INTERVAL);
    },
    stop() {
        if (snapshotTimer != null) { clearInterval(snapshotTimer); snapshotTimer = null; }
    },
});
