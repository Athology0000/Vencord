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
import definePlugin, { makeRange, OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { Button, ChannelStore, FluxDispatcher, Forms, GuildStore, NavigationRouter, React, Select, TextInput, Toasts, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const VoiceStateStore = findStoreLazy("VoiceStateStore");

// "gather" - alert when >= threshold trait-holders share one VC
// "join"   - alert whenever any trait-holder joins any visible VC
type RuleKind = "gather" | "join";

interface Rule {
    trait: string;
    kind: RuleKind;
    threshold: number;
}

const settings = definePluginSettings({
    rules: {
        description: "Watchlist rules (JSON array)",
        type: OptionType.STRING,
        default: "[]",
    },
    volume: {
        description: "Alert sound volume",
        type: OptionType.SLIDER,
        markers: makeRange(0, 100, 10),
        default: 100,
        stickToMarkers: false,
    },
});

interface trait {
    name: string;
    url: string;
    users: string;
}

function getRules(): Rule[] {
    try {
        const data = JSON.parse(settings.store.rules);
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}

function setRules(rules: Rule[]) { settings.store.rules = JSON.stringify(rules); }

function getTraits(): trait[] {
    const traitsPlugin = Settings.plugins["Xicord Traits"];
    if (!traitsPlugin?.enabled) return [];
    try {
        const data = JSON.parse(traitsPlugin.tasks as string || "[]");
        return Array.isArray(data) ? data : [];
    } catch { return []; }
}

function traitUserIds(name: string): string[] {
    const t = getTraits().find(t => t.name === name);
    if (!t) return [];
    return t.users.split("/").filter(Boolean);
}

let active = false;
// Debounce repeat alerts per rule+channel so a busy VC doesn't spam
const lastFired = new Map<string, number>();
const FIRE_COOLDOWN = 60 * 1000;

function channelName(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    if (!channel) return "a voice channel";
    const guild = channel.guild_id ? GuildStore.getGuild(channel.guild_id) : null;
    return guild ? `${channel.name} - ${guild.name}` : (channel.name ?? "a voice channel");
}

function playAlert(url: string) {
    if (!url) return;
    try {
        const el = document.createElement("audio");
        el.src = url;
        el.volume = settings.store.volume / 100;
        el.play().catch(() => { });
    } catch { }
}

function fireAlert(rule: Rule, channelId: string, message: string, extraKey = "") {
    const key = `${rule.trait}:${rule.kind}:${channelId}:${extraKey}`;
    const now = Date.now();
    if (now - (lastFired.get(key) ?? 0) < FIRE_COOLDOWN) return;
    lastFired.set(key, now);

    const t = getTraits().find(t => t.name === rule.trait);
    playAlert(t?.url ?? "");
    Toasts.show({
        message,
        id: `xicord-watchlist-${key}-${now}`,
        type: Toasts.Type.MESSAGE,
        options: { position: Toasts.Position.BOTTOM }
    });
}

function evaluateChannel(channelId: string) {
    const rules = getRules();
    if (rules.length === 0) return;
    const channelStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    const present = new Set(Object.keys(channelStates));

    for (const rule of rules) {
        const holders = traitUserIds(rule.trait).filter(id => present.has(id));
        if (rule.kind === "gather") {
            if (holders.length >= rule.threshold) {
                fireAlert(rule, channelId, `${holders.length} "${rule.trait}" users are in ${channelName(channelId)}`);
            }
        }
    }
}

const onVoiceStateUpdates = (e: any) => {
    if (!active) return;
    const rules = getRules();
    if (rules.length === 0) return;

    for (const state of e?.voiceStates ?? []) {
        const { userId, channelId, oldChannelId } = state;
        if (!channelId || channelId === oldChannelId) continue;

        // "join" rules: this specific user entering a channel
        for (const rule of rules) {
            if (rule.kind !== "join") continue;
            if (traitUserIds(rule.trait).includes(userId)) {
                const name = UserStore.getUser(userId)?.username ?? userId;
                // Key on the user too so a second holder joining isn't swallowed
                fireAlert(rule, channelId, `"${rule.trait}" user ${name} joined ${channelName(channelId)}`, userId);
            }
        }
        // "gather" rules: re-count the channel that changed
        evaluateChannel(channelId);
    }
};

function WatchlistModal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    const rules = getRules();
    const traits = getTraits();
    const [trait, setTrait] = React.useState(traits[0]?.name ?? "");
    const [kind, setKind] = React.useState<RuleKind>("gather");
    const [threshold, setThreshold] = React.useState("2");

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <WatchlistIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Watchlist</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                {traits.length === 0 ? (
                    <Forms.FormText style={{ marginTop: "10px" }}>
                        No traits found. Enable Xicord Traits and create at least one trait first.
                    </Forms.FormText>
                ) : (
                    <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", flexDirection: "column", gap: "10px" }}>
                        <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>New Rule</Forms.FormTitle>
                        <Flex style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                            <div style={{ width: "40%" }}>
                                <Select
                                    options={traits.map(t => ({ label: t.name, value: t.name }))}
                                    serialize={String}
                                    select={(v: string) => setTrait(v)}
                                    isSelected={(v: string) => v === trait}
                                    closeOnSelect={true}
                                />
                            </div>
                            <div style={{ width: "35%" }}>
                                <Select
                                    options={[
                                        { label: "gather (N in one VC)", value: "gather" },
                                        { label: "join (any joins a VC)", value: "join" },
                                    ]}
                                    serialize={String}
                                    select={(v: RuleKind) => setKind(v)}
                                    isSelected={(v: string) => v === kind}
                                    closeOnSelect={true}
                                />
                            </div>
                            {kind === "gather" ? (
                                <div style={{ width: "15%" }}>
                                    <TextInput value={threshold} placeholder="N" onChange={(e: string) => setThreshold(e.replace(/\D/g, ""))} />
                                </div>
                            ) : null}
                            <Button2
                                onClick={() => {
                                    if (!trait) return;
                                    const n = Math.max(1, parseInt(threshold || "2", 10) || 2);
                                    setRules([...rules, { trait, kind, threshold: n }]);
                                    force();
                                }}
                                role="switch" tooltipText="Add Rule"
                                icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="#b5bac1"><path d="M17,12c0,.553-.448,1-1,1h-3v3c0,.553-.448,1-1,1s-1-.447-1-1v-3h-3c-.552,0-1-.447-1-1s.448-1,1-1h3v-3c0-.553,.448-1,1-1s1,.447,1,1v3h3c.552,0,1,.447,1,1Zm7-7v14c0,2.757-2.243,5-5,5H5c-2.757,0-5-2.243-5-5V5C0,2.243,2.243,0,5,0h14c2.757,0,5,2.243,5,5Zm-2,0c0-1.654-1.346-3-3-3H5c-1.654,0-3,1.346-3,3v14c0,1.654,1.346,3,3,3h14c1.654,0,3-1.346,3-3V5Z" /></g></svg>} />
                        </Flex>
                    </Flex>
                )}

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Rules</Forms.FormTitle>
                    {rules.length !== 0 ? rules.map((rule, i) => (
                        <Flex key={i} style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                            <Forms.FormText style={{ flexGrow: 1 }}>
                                {rule.kind === "gather"
                                    ? `Alert when ${rule.threshold}+ "${rule.trait}" users share a VC`
                                    : `Alert when any "${rule.trait}" user joins a VC`}
                            </Forms.FormText>
                            <Button2 onClick={() => { setRules(rules.filter((_, j) => j !== i)); force(); }}
                                role="switch" tooltipText="Remove"
                                icon={() => <svg width="16" height="16" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" stroke="var(--red-430)" strokeWidth="2" fill="none" /></svg>} />
                        </Flex>
                    )) : <Forms.FormText>No rules yet.</Forms.FormText>}
                </Flex>

                <Flex style={{ marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function WatchlistIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <path d="M12 4C5 4 1 12 1 12s4 8 11 8 11-8 11-8-4-8-11-8Zm0 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
        </g></svg>
    );
}

function watchlistButton() {
    return (
        <Button2 onClick={() => openModal(props => <WatchlistModal {...props} />)}
            onContextMenu={() => openModal(props => <WatchlistModal {...props} />)}
            role="switch" tooltipText="Xicord Watchlist"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <path d="M12 4C5 4 1 12 1 12s4 8 11 8 11-8 11-8-4-8-11-8Zm0 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10Zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
            </g></svg>} />
    );
}

export default definePlugin({
    name: "Xicord Watchlist",
    description: "Fires a sound + toast alert on rules built from Xicord Traits, e.g. when several trait-holders gather in one voice channel or any of them joins a VC",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu", "Xicord Traits"],
    settings,
    xicordButton: ErrorBoundary.wrap(watchlistButton, { noop: true }),
    start() {
        active = true;
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
    },
    stop() {
        active = false;
        FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
        lastFired.clear();
    },
});
