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
import { ChannelStore, FluxDispatcher, GuildStore, React, Switch as SwitchRaw, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { WatchAPI } from "./xicordOrbit";
import { feedRing, useWatchFeed, WatchModalShell } from "./_watchShared";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;
const VoiceStateStore = findStoreLazy("VoiceStateStore");

const settings = definePluginSettings({
    toasts: { description: "Toast when a watched user goes live or turns on camera", type: OptionType.BOOLEAN, default: true },
});

const feed = feedRing();
let active = false;
// userId -> { stream, video } previous flags
const prev = new Map<string, { stream: boolean; video: boolean; }>();

function nameOf(id: string) { return UserStore.getUser(id)?.username ?? id; }
function channelLabel(channelId?: string) {
    if (!channelId) return "a voice channel";
    const c = ChannelStore.getChannel(channelId);
    if (!c) return "a voice channel";
    const g = c.guild_id ? GuildStore.getGuild(c.guild_id) : null;
    return g ? `${c.name} - ${g.name}` : (c.name ?? "a voice channel");
}
function alert(userId: string, text: string, channelId?: string) {
    feed.push(text);
    WatchAPI.log({ userId, text, channelId, guildId: channelId ? ChannelStore.getChannel(channelId)?.guild_id : undefined });
    if (settings.store.toasts) Toasts.show({ message: text, id: `xicord-livewatch-${userId}-${Date.now()}`, type: Toasts.Type.MESSAGE, options: { position: Toasts.Position.BOTTOM } });
}

function seedFromStore() {
    try {
        const all = VoiceStateStore.getAllVoiceStates() ?? {};
        for (const guildStates of Object.values(all)) {
            for (const vs of Object.values(guildStates as Record<string, any>)) {
                if (vs?.userId && WatchAPI.has(vs.userId)) prev.set(vs.userId, { stream: !!vs.selfStream, video: !!vs.selfVideo });
            }
        }
    } catch { }
}

const onVoiceStateUpdates = (e: any) => {
    if (!active) return;
    for (const st of e?.voiceStates ?? []) {
        const id = st?.userId; if (!id || !WatchAPI.has(id)) continue;
        const stream = !!st.selfStream, video = !!st.selfVideo;
        const p = prev.get(id);
        prev.set(id, { stream, video });
        if (!p) continue; // baseline only
        if (stream && !p.stream) alert(id, `${nameOf(id)} started streaming in ${channelLabel(st.channelId)}`, st.channelId);
        if (video && !p.video) alert(id, `${nameOf(id)} turned on their camera in ${channelLabel(st.channelId)}`, st.channelId);
    }
};

function Modal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const items = useWatchFeed(feed);
    return (
        <WatchModalShell {...props} title="Xicord Live Watch" icon={<Icon big />} items={items}
            desc="Alerts when someone on your Orbit watch list starts streaming (Go Live) or turns on their camera in a voice channel.">
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column" }}>
                <Switch value={settings.store.toasts} onChange={(v: boolean) => { settings.store.toasts = v; force(); }}>Show toasts</Switch>
            </Flex>
        </WatchModalShell>
    );
}
function Icon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24"><g fill={big ? "#b5bac1" : "currentColor"}>
        <path d="M17 10.5V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3.5l4 3.5V7l-4 3.5Z" />
    </g></svg>;
}
function button() {
    return <Button2 onClick={() => openModal(p => <Modal {...p} />)} onContextMenu={() => openModal(p => <Modal {...p} />)}
        role="switch" tooltipText="Xicord Live Watch" icon={() => <Icon />} />;
}

export default definePlugin({
    name: "Xicord Live Watch",
    description: "Watches your Orbit watch list for when someone starts streaming or turns on their camera in voice",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Orbit"],
    settings,
    xicordButton: ErrorBoundary.wrap(button, { noop: true }),
    start() {
        active = true;
        seedFromStore();
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        prev.clear();
    },
});
