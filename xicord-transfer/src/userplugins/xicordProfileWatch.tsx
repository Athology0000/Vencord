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
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, FluxDispatcher, Forms, React, Switch as SwitchRaw, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

import { WatchAPI } from "./xicordOrbit";
import { feedRing, useWatchFeed, WatchModalShell } from "./_watchShared";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const Switch = SwitchRaw as ComponentType<any>;

const settings = definePluginSettings({
    toasts: { description: "Show a toast on profile changes", type: OptionType.BOOLEAN, default: true },
});

const feed = feedRing();
let active = false;
const prev = new Map<string, { username?: string; display?: string; avatar?: string; custom?: string; }>();

function nameOf(id: string) { return UserStore.getUser(id)?.username ?? id; }

function alert(userId: string, text: string) {
    feed.push(text);
    WatchAPI.log({ userId, text });
    if (settings.store.toasts) Toasts.show({ message: text, id: `xicord-profwatch-${userId}-${Date.now()}`, type: Toasts.Type.MESSAGE, options: { position: Toasts.Position.BOTTOM } });
}

function seed(id: string) {
    const u = UserStore.getUser(id);
    prev.set(id, { username: u?.username, display: (u as any)?.globalName, avatar: (u as any)?.avatar, custom: prev.get(id)?.custom });
}

const onUserUpdate = (e: any) => {
    if (!active) return;
    const u = e?.user; if (!u?.id || !WatchAPI.has(u.id)) return;
    const p = prev.get(u.id);
    if (!p) { seed(u.id); return; }
    const name = nameOf(u.id);
    // USER_UPDATE carries a RAW user object (snake_case): global_name, not globalName
    const gn = u.global_name ?? u.globalName;
    if (u.username !== undefined && p.username !== undefined && u.username !== p.username)
        alert(u.id, `${p.username} changed username to ${u.username}`);
    if (gn !== undefined && p.display !== undefined && gn !== p.display)
        alert(u.id, `${name} changed display name to ${gn || "(none)"}`);
    if (u.avatar !== undefined && p.avatar !== undefined && u.avatar !== p.avatar)
        alert(u.id, `${name} changed their avatar`);
    prev.set(u.id, { username: u.username ?? p.username, display: gn ?? p.display, avatar: u.avatar ?? p.avatar, custom: p.custom });
};

const onPresenceUpdates = (e: any) => {
    if (!active) return;
    for (const upd of e?.updates ?? []) {
        const id = upd?.user?.id; if (!id || !WatchAPI.has(id)) continue;
        const custom = (upd.activities ?? []).find((a: any) => a?.type === 4);
        // emoji-only statuses have no `state`; represent them so they don't read as "cleared"
        const state = custom ? (custom.state ?? (custom.emoji?.name ? `:${custom.emoji.name}:` : "")) : "";
        const p = prev.get(id) ?? {};
        if (p.custom === undefined) { p.custom = state; prev.set(id, p); continue; }
        if (state !== p.custom) {
            const name = nameOf(id);
            alert(id, state ? `${name} set status: ${state}` : `${name} cleared their status`);
            p.custom = state; prev.set(id, p);
        }
    }
};

function Modal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const items = useWatchFeed(feed);
    return (
        <WatchModalShell {...props} title="Xicord Profile Watch" icon={<Icon big />} items={items}
            desc="Alerts when someone on your Orbit watch list changes their username, display name, avatar or custom status.">
            <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column" }}>
                <Switch value={settings.store.toasts} onChange={(v: boolean) => { settings.store.toasts = v; force(); }}>Show toasts</Switch>
            </Flex>
        </WatchModalShell>
    );
}
function Icon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24"><g fill={big ? "#b5bac1" : "currentColor"}>
        <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.4 0-8 2.7-8 6v2h16v-2c0-3.3-3.6-6-8-6Z" />
        <path d="M18 3.5 19 6l2.5 1-2.5 1-1 2.5-1-2.5L14.5 7 17 6l1-2.5Z" opacity=".7" />
    </g></svg>;
}
function button() {
    return <Button2 onClick={() => openModal(p => <Modal {...p} />)} onContextMenu={() => openModal(p => <Modal {...p} />)}
        role="switch" tooltipText="Xicord Profile Watch" icon={() => <Icon />} />;
}

export default definePlugin({
    name: "Xicord Profile Watch",
    description: "Watches your Orbit watch list for username, display-name, avatar and custom-status changes",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Orbit"],
    settings,
    xicordButton: ErrorBoundary.wrap(button, { noop: true }),
    start() {
        active = true;
        WatchAPI.list().forEach(seed);
        FluxDispatcher.subscribe("USER_UPDATE", onUserUpdate);
        FluxDispatcher.subscribe("PRESENCE_UPDATES", onPresenceUpdates);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("USER_UPDATE", onUserUpdate);
        FluxDispatcher.unsubscribe("PRESENCE_UPDATES", onPresenceUpdates);
        prev.clear();
    },
});
