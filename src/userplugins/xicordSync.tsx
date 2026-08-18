/*
MIT License — Copyright (c) 2026 Xicord

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software, subject to the MIT terms. THE SOFTWARE IS PROVIDED "AS IS",
WITHOUT WARRANTY OF ANY KIND.
*/

/**
 * Xicord Sync — the control surface for sharing a dossier between your own machines.
 *
 * The engine lives in Xicord Dossier, which is where the data it sends already is; this
 * plugin is deliberately not a second copy of it. What it adds is the thing a settings
 * field cannot: a place to see whether the sync is actually working, run one on demand,
 * and — the part that matters — decide what is allowed to leave this PC.
 *
 * SCOPE. Only two things are shared:
 *
 *   Calls          who shared a voice channel with whom, where and for how long, plus
 *                  the usernames needed to read that back. Objective: true whoever
 *                  observed it, so it pools across every machine you run.
 *   Friendships    the proven mutual-friend graph. Stored per account, because a retraction
 *                  has to be able to remove a name from the slice that claimed it — but
 *                  READ as the union of every contributor's slice, since each account can
 *                  only ever see the part of someone's friends that overlaps its own.
 *
 * Everything else stays on this machine: your watchlist, your notes, your traits, your
 * message and presence counts, your sweep roster. Those are records of what YOU are
 * doing rather than of what happened, and none of them get better for being shared.
 */

import { definePluginSettings, Settings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, Forms, React, Toasts } from "@webpack/common";
import type { ComponentType } from "react";

import { syncNow, syncStatus } from "./xicordDossier";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const DOSSIER = "Xicord Dossier";

export const settings = definePluginSettings({
    shareWatchlist: {
        description: "Also send your watchlist. Off by default — who you are watching is a record of what YOU are doing, not of anything that happened, and it is the one field here that would tell another machine's owner something about you rather than about them",
        type: OptionType.BOOLEAN,
        default: false,
    },
    autoSync: {
        description: "Sync automatically in the background (the Dossier runs this on a timer). Turn off to sync only when you press the button",
        type: OptionType.BOOLEAN,
        default: true,
    },
});

/**
 * Whether the watchlist may be included. Read by the Dossier's push, through Vencord's
 * settings rather than an import, so the two plugins stay independent — the Dossier does
 * not stop working when this one is disabled, it just goes back to sharing nothing extra.
 */
export function mayShareWatchlist(): boolean {
    try { return Settings.plugins["Xicord Sync"]?.enabled === true && Settings.plugins["Xicord Sync"]?.shareWatchlist === true; }
    catch { return false; }
}

/** Whether the background timer should run. Same reasoning as above. */
export function autoSyncOn(): boolean {
    try {
        const p = Settings.plugins["Xicord Sync"];
        // absent or disabled plugin => leave the Dossier's own behaviour alone
        if (!p || p.enabled !== true) return true;
        return p.autoSync !== false;
    } catch { return true; }
}

/** The connection settings still live on the Dossier, which is what actually uses them. */
function connection() {
    const p = Settings.plugins[DOSSIER] ?? {};
    return {
        url: String(p.syncUrl ?? "").trim(),
        token: String(p.syncToken ?? "").trim(),
        on: p.syncEnabled === true,
        mine: String(p.syncMyIds ?? "").trim(),
    };
}

function SyncModal(props: RenderModalProps) {
    const [, force] = React.useReducer((x: number) => x + 1, 0);
    const [health, setHealth] = React.useState<string>("checking…");
    const conn = connection();

    React.useEffect(() => {
        const iv = setInterval(force, 1500);
        return () => clearInterval(iv);
    }, []);

    // A liveness check that does not need the token, so "is the server up" and "is my
    // token any good" are two separate answers rather than one ambiguous failure.
    React.useEffect(() => {
        let gone = false;
        (async () => {
            if (!conn.url) { setHealth("no server address set"); return; }
            try {
                const native = (globalThis as any).VencordNative?.pluginHelpers?.["Xicord Cache"];
                if (!native?.syncRequest) { setHealth("needs the Xicord Cache plugin (desktop only)"); return; }
                const res = await native.syncRequest(conn.url.replace(/\/+$/, "") + "/v1/health", "");
                if (gone) return;
                setHealth(res?.status === 200
                    ? `up · ${res.body?.devices ?? "?"} device(s) in the pool`
                    : `reachable but unhappy (HTTP ${res?.status})`);
            } catch (e: any) { if (!gone) setHealth(`unreachable — ${e?.message ?? e}`); }
        })();
        return () => { gone = true; };
    }, [conn.url]);

    const st = (() => { try { return syncStatus(); } catch { return { last: "", watermark: 0, busy: false }; } })();
    const ready = conn.on && !!conn.url && !!conn.token;

    const row = (k: string, v: string) => (
        <Flex key={k} style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
            <Forms.FormText style={{ opacity: 0.6, minWidth: 130 }}>{k}</Forms.FormText>
            <Forms.FormText style={{ flexGrow: 1 }}>{v}</Forms.FormText>
        </Flex>
    );

    return (
        <ModalRoot {...props} size={ModalSize.MEDIUM}>
            <ModalHeader>
                <SyncIcon big />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Sync</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                    Shares one dossier between your own machines. Each PC pushes what it saw into
                    its own slice, and a pull merges every slice into one picture.
                </Forms.FormText>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column", gap: "2px" }}>
                    {row("Server", conn.url || "not set")}
                    {row("Status", health)}
                    {row("Token", conn.token ? "set" : "not set")}
                    {row("Syncing", conn.on ? (ready ? "on" : "on, but not configured") : "off")}
                    {row("This account", conn.mine || "not set")}
                    {row("Last run", st.busy ? "running…" : (st.last || "not yet this session"))}
                </Flex>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "12px", flexDirection: "column", gap: "4px" }}>
                    <Forms.FormTitle tag="h5" style={{ margin: 0 }}>What leaves this PC</Forms.FormTitle>
                    <Forms.FormText style={{ fontSize: 13 }}>
                        ✔ <b>Calls</b> — who shared a voice channel with whom, where, and for how long,
                        plus the usernames needed to read that back.
                    </Forms.FormText>
                    <Forms.FormText style={{ fontSize: 13 }}>
                        ✔ <b>Proven friendships</b> — the mutual-friend graph, <b>pooled and readable by
                            everyone signed into this service</b>. You can only ever see the slice of someone's
                        friends that overlaps your own, so the union is the only complete picture — but it
                        does mean your findings about other people are visible to every other contributor.
                    </Forms.FormText>
                    <Forms.FormText style={{ fontSize: 13, opacity: 0.75 }}>
                        ✘ Notes, traits, message and presence counts, and the sweep roster never leave.
                        {settings.store.shareWatchlist
                            ? " Your watchlist IS being sent — turn that off in settings if you did not mean it."
                            : " Your watchlist never leaves either."}
                    </Forms.FormText>
                    <Forms.FormText style={{ fontSize: 12, opacity: 0.55, marginTop: "4px" }}>
                        Everything sent is about other people. The snapshot on this disk is encrypted;
                        that protection ends at the network, and what happens in the pool is up to the
                        server, not this machine.
                    </Forms.FormText>
                </Flex>

                <Flex style={{ marginTop: "12px", marginBottom: "10px", gap: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.BRAND} disabled={!ready || st.busy}
                        onClick={() => {
                            try {
                                syncNow();
                                Toasts.show({ message: "Sync started — pulls first, then pushes", id: Toasts.genId(), type: Toasts.Type.MESSAGE });
                            } catch (e: any) {
                                Toasts.show({ message: `Sync failed to start: ${e?.message ?? e}`, id: Toasts.genId(), type: Toasts.Type.FAILURE });
                            }
                            force();
                        }}>
                        {st.busy ? "Syncing…" : "Sync now"}
                    </Button>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function SyncIcon({ big }: { big?: boolean; }) {
    const s = big ? 20 : 18;
    return <svg width={s} height={s} viewBox="0 0 24 24" fill="none"
        stroke={big ? "#b5bac1" : "currentColor"} strokeWidth="2" strokeLinecap="round">
        <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" />
        <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" />
        <path d="M3 17v4h4M21 7V3h-4" />
    </svg>;
}

function syncButton() {
    const open = () => openModal(p => <SyncModal {...p} />);
    return <Button2 onClick={open} onContextMenu={open}
        role="switch" tooltipText="Xicord Sync" icon={() => <SyncIcon />} />;
}

export default definePlugin({
    name: "Xicord Sync",
    description: "Shares your dossier between your own machines — voice calls and proven friendships only. Nothing else leaves the PC",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    // The engine and the connection settings live in the Dossier; Cache owns the native
    // module that the request is routed through, because the renderer cannot get past
    // Discord's CSP to an arbitrary host.
    dependencies: ["Xicord Mod Menu", "Xicord Dossier", "Xicord Cache"],
    settings,
    xicordButton: ErrorBoundary.wrap(syncButton, { noop: true }),
    start() { },
    stop() { },
});
