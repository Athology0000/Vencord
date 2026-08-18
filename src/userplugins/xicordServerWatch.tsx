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
import { FluxDispatcher, Forms, GuildStore, React, Switch as SwitchRaw, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { WatchAPI } from "./xicordOrbit";
import { feedRing, useWatchFeed, WatchModalShell } from "./_watchShared";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;

const settings = definePluginSettings({
    toasts: { description: "Toast on server join/leave and nickname changes", type: OptionType.BOOLEAN, default: true },
    nicknames: { description: "Also watch nickname changes in your servers", type: OptionType.BOOLEAN, default: true },
});

const feed = feedRing();
let active = false;
// "guildId:userId" -> last known nickname
const nicks = new Map<string, string>();

function nameOf(id: string) { return UserStore.getUser(id)?.username ?? id; }
function guildName(id?: string) { return (id && GuildStore.getGuild(id)?.name) || "a server"; }

function alert(userId: string, text: string, guildId?: string) {
    feed.push(text);
    WatchAPI.log({ userId, text, guildId });
    if (settings.store.toasts) Toasts.show({ message: text, id: `xicord-serverwatch-${userId}-${Date.now()}`, type: Toasts.Type.MESSAGE, options: { position: Toasts.Position.BOTTOM } });
}

// GUILD_MEMBER_* are gateway-shaped: guild id may arrive as guild_id (snake_case)
const gid = (e: any) => e?.guildId ?? e?.guild_id;

const onMemberAdd = (e: any) => {
    if (!active) return;
    const id = e?.user?.id; if (!id || !WatchAPI.has(id)) return;
    alert(id, `${nameOf(id)} joined ${guildName(gid(e))}`, gid(e));
};
const onMemberRemove = (e: any) => {
    if (!active) return;
    const id = e?.user?.id; if (!id || !WatchAPI.has(id)) return;
    alert(id, `${nameOf(id)} left ${guildName(gid(e))}`, gid(e));
    nicks.delete(gid(e) + ":" + id);
};
const onMemberUpdate = (e: any) => {
    if (!active || !settings.store.nicknames) return;
    const id = e?.user?.id ?? e?.member?.user?.id; if (!id || !WatchAPI.has(id)) return;
    const guildId = gid(e);
    const nick = e.nick ?? e.member?.nick ?? "";
    const key = guildId + ":" + id;
    const prev = nicks.get(key);
    nicks.set(key, nick);
    if (prev === undefined) return; // baseline
    if (nick !== prev) alert(id, nick ? `${nameOf(id)} is now "${nick}" in ${guildName(guildId)}` : `${nameOf(id)} cleared their nickname in ${guildName(guildId)}`, guildId);
};

function Modal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const items = useWatchFeed(feed);
    return (
        <WatchModalShell {...props} title="Xicord Server Watch" icon={<Icon big />} items={items}
            desc="Alerts when someone on your Orbit watch list joins or leaves one of your servers, or changes their nickname there.">
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column", gap: "2px" }}>
                <Switch value={settings.store.toasts} onChange={(v: boolean) => { settings.store.toasts = v; force(); }}>Show toasts</Switch>
                <Switch value={settings.store.nicknames} onChange={(v: boolean) => { settings.store.nicknames = v; force(); }}>Watch nickname changes</Switch>
            </Flex>
            <Forms.FormText style={{ marginTop: "8px", opacity: 0.55, fontSize: 12 }}>
                Only fires for servers you share with them - Discord only tells your client about those.
            </Forms.FormText>
        </WatchModalShell>
    );
}
function Icon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24"><g fill={big ? "#b5bac1" : "currentColor"}>
        <path d="M4 4h16v4H4V4Zm0 6h16v4H4v-4Zm0 6h16v4H4v-4Z" opacity=".5" />
        <circle cx="7" cy="6" r="1.3" /><circle cx="7" cy="12" r="1.3" /><circle cx="7" cy="18" r="1.3" />
    </g></svg>;
}
function button() {
    return <Button2 onClick={() => openModal(p => <Modal {...p} />)} onContextMenu={() => openModal(p => <Modal {...p} />)}
        role="switch" tooltipText="Xicord Server Watch" icon={() => <Icon />} />;
}

export default definePlugin({
    name: "Xicord Server Watch",
    description: "Watches your Orbit watch list for server joins/leaves and nickname changes in servers you share",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Orbit"],
    settings,
    xicordButton: ErrorBoundary.wrap(button, { noop: true }),
    start() {
        active = true;
        FluxDispatcher.subscribe("GUILD_MEMBER_ADD", onMemberAdd);
        FluxDispatcher.subscribe("GUILD_MEMBER_REMOVE", onMemberRemove);
        FluxDispatcher.subscribe("GUILD_MEMBER_UPDATE", onMemberUpdate);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("GUILD_MEMBER_ADD", onMemberAdd);
        FluxDispatcher.unsubscribe("GUILD_MEMBER_REMOVE", onMemberRemove);
        FluxDispatcher.unsubscribe("GUILD_MEMBER_UPDATE", onMemberUpdate);
        nicks.clear();
    },
});
