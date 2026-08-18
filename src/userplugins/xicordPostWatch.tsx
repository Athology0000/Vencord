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
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, GuildStore, React, Switch as SwitchRaw, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { WatchAPI } from "./xicordOrbit";
import { feedRing, useWatchFeed, WatchModalShell } from "./_watchShared";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;

const settings = definePluginSettings({
    toasts: { description: "Toast when a watched user posts a message", type: OptionType.BOOLEAN, default: true },
    includeDMs: { description: "Also alert on messages in DMs and group chats", type: OptionType.BOOLEAN, default: true },
});

const feed = feedRing();
let active = false;
const cooldown = new Map<string, number>();
const COOLDOWN = 45 * 1000;

function nameOf(id: string) { return UserStore.getUser(id)?.username ?? id; }
function channelLabel(channelId: string) {
    const c = ChannelStore.getChannel(channelId);
    if (!c) return "a channel";
    if (c.isDM?.()) return "a DM";
    if (c.isGroupDM?.()) return "a group chat";
    const g = c.guild_id ? GuildStore.getGuild(c.guild_id) : null;
    return g ? `#${c.name} - ${g.name}` : `#${c.name ?? "channel"}`;
}

const onMessageCreate = (e: any) => {
    if (!active) return;
    const m = e?.message;
    const id = m?.author?.id;
    if (!id || m?.author?.bot || !WatchAPI.has(id)) return;
    if (id === UserStore.getCurrentUser()?.id) return;

    const channelId = m.channel_id ?? e.channelId;
    if (!channelId) return;
    const channel = ChannelStore.getChannel(channelId);
    const isDM = channel?.isDM?.() || channel?.isGroupDM?.();
    if (isDM && !settings.store.includeDMs) return;

    const key = id + ":" + channelId;
    const now = Date.now();
    if (now - (cooldown.get(key) ?? 0) < COOLDOWN) return;
    cooldown.set(key, now);

    const text = `${nameOf(id)} posted in ${channelLabel(channelId)}`;
    feed.push(text);
    WatchAPI.log({ userId: id, text, channelId, guildId: channel?.guild_id });
    if (settings.store.toasts) Toasts.show({ message: text, id: `xicord-postwatch-${key}-${now}`, type: Toasts.Type.MESSAGE, options: { position: Toasts.Position.BOTTOM } });
};

function Modal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const items = useWatchFeed(feed);
    return (
        <WatchModalShell {...props} title="Xicord Post Watch" icon={<Icon big />} items={items}
            desc="Alerts when someone on your Orbit watch list sends a message anywhere you can see (one alert per person per channel every 45s).">
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column", gap: "2px" }}>
                <Switch value={settings.store.toasts} onChange={(v: boolean) => { settings.store.toasts = v; force(); }}>Show toasts</Switch>
                <Switch value={settings.store.includeDMs} onChange={(v: boolean) => { settings.store.includeDMs = v; force(); }}>Include DMs &amp; group chats</Switch>
            </Flex>
        </WatchModalShell>
    );
}
function Icon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24"><g fill={big ? "#b5bac1" : "currentColor"}>
        <path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 1-1.8V3Z" />
    </g></svg>;
}
function button() {
    return <Button2 onClick={() => openModal(p => <Modal {...p} />)} onContextMenu={() => openModal(p => <Modal {...p} />)}
        role="switch" tooltipText="Xicord Post Watch" icon={() => <Icon />} />;
}

export default definePlugin({
    name: "Xicord Post Watch",
    description: "Watches your Orbit watch list and alerts when they post a message (throttled), with a jump to the channel in the feed",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Orbit"],
    settings,
    start() {
        active = true;
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        cooldown.clear();
    },
    xicordButton: ErrorBoundary.wrap(button, { noop: true }),
});
