/*
MIT License — Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software, subject to the MIT terms. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND.
*/
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { FluxDispatcher, React, Switch as SwitchRaw, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { WatchAPI } from "./xicordOrbit";
import { feedRing, useWatchFeed, WatchModalShell } from "./_watchShared";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;
const PresenceStore = findStoreLazy("PresenceStore");

const settings = definePluginSettings({
    toasts: { description: "Toast when a watched user starts a game or activity", type: OptionType.BOOLEAN, default: true },
    listening: { description: "Also alert on music (Spotify) activity", type: OptionType.BOOLEAN, default: false },
});

const feed = feedRing();
let active = false;
// userId -> set of current activity keys (name), excluding custom status
const prev = new Map<string, Set<string>>();

function nameOf(id: string) { return UserStore.getUser(id)?.username ?? id; }

// Activity types: 0 playing, 1 streaming, 2 listening, 3 watching, 4 custom, 5 competing
function relevant(a: any): boolean {
    if (!a || a.type === 4) return false;            // skip custom status (Profile Watch owns it)
    if (a.type === 2 && !settings.store.listening) return false;
    return !!a.name;
}
function verbFor(a: any) {
    switch (a.type) {
        case 2: return "is listening to";
        case 3: return "is watching";
        case 1: return "is streaming";
        case 5: return "is competing in";
        default: return "started playing";
    }
}

function evaluate(id: string, activities: any[]) {
    const cur = new Set<string>();
    const byName: Record<string, any> = {};
    (activities ?? []).forEach(a => { if (relevant(a)) { cur.add(a.name); byName[a.name] = a; } });
    const before = prev.get(id);
    prev.set(id, cur);
    if (!before) return; // baseline only
    for (const name of cur) {
        if (!before.has(name)) {
            const a = byName[name];
            Toast(id, `${nameOf(id)} ${verbFor(a)} ${name}`);
        }
    }
}

function Toast(userId: string, text: string) {
    feed.push(text);
    WatchAPI.log({ userId, text });
    if (settings.store.toasts) Toasts.show({ message: text, id: `xicord-gamewatch-${userId}-${Date.now()}`, type: Toasts.Type.MESSAGE, options: { position: Toasts.Position.BOTTOM } });
}

const onPresenceUpdates = (e: any) => {
    if (!active) return;
    for (const upd of e?.updates ?? []) {
        const id = upd?.user?.id; if (!id || !WatchAPI.has(id)) continue;
        evaluate(id, upd.activities ?? []);
    }
};

function seed() {
    for (const id of WatchAPI.list()) {
        try {
            // Only baseline users whose presence is actually cached (online), so an
            // already-running game for an uncached user isn't reported as "started"
            // on their first presence tick. Uncached users baseline on that tick.
            const status = PresenceStore.getStatus?.(id);
            if (!status || status === "offline") continue;
            const acts = PresenceStore.getActivities?.(id) ?? [];
            const set = new Set<string>();
            acts.forEach((a: any) => { if (relevant(a)) set.add(a.name); });
            prev.set(id, set);
        } catch { }
    }
}

function Modal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const items = useWatchFeed(feed);
    return (
        <WatchModalShell {...props} title="Xicord Game Watch" icon={<Icon big />} items={items}
            desc="Alerts when someone on your Orbit watch list starts playing a game (or other rich-presence activity).">
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column", gap: "2px" }}>
                <Switch value={settings.store.toasts} onChange={(v: boolean) => { settings.store.toasts = v; force(); }}>Show toasts</Switch>
                <Switch value={settings.store.listening} onChange={(v: boolean) => { settings.store.listening = v; force(); }}>Include music (Spotify)</Switch>
            </Flex>
        </WatchModalShell>
    );
}
function Icon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24"><g fill={big ? "#b5bac1" : "currentColor"}>
        <path d="M7 6h10a5 5 0 0 1 5 5v2a4 4 0 0 1-7.2 2.4l-.4-.6H9.6l-.4.6A4 4 0 0 1 2 13v-2a5 5 0 0 1 5-5Zm-1 4v1.5H4.5v1H6V14h1v-1.5h1.5v-1H7V10H6Zm10.5 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm-2 2a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z" />
    </g></svg>;
}
function button() {
    return <Button2 onClick={() => openModal(p => <Modal {...p} />)} onContextMenu={() => openModal(p => <Modal {...p} />)}
        role="switch" tooltipText="Xicord Game Watch" icon={() => <Icon />} />;
}

export default definePlugin({
    name: "Xicord Game Watch",
    description: "Watches your Orbit watch list for when someone starts playing a game or another rich-presence activity",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Orbit"],
    settings,
    xicordButton: ErrorBoundary.wrap(button, { noop: true }),
    start() {
        active = true;
        seed();
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdates);
        prev.clear();
    },
});
