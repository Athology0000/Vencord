/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Xicord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import definePlugin, { OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { ChannelStore, FluxDispatcher, NavigationRouter, Toasts, UserStore } from "@webpack/common";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        description: "Whether alerts currently fire (also toggled by the panel button)",
        default: true
    },
    keywords: {
        type: OptionType.STRING,
        description: "Keywords to watch for, separated by / (e.g. giveaway/my name/raid)",
        default: ""
    },
    wholeWord: {
        type: OptionType.BOOLEAN,
        description: "Only match whole words, so \"cat\" does not match \"category\"",
        default: true
    },
    ignoreBots: {
        type: OptionType.BOOLEAN,
        description: "Ignore messages sent by bots",
        default: false
    },
    desktopNotification: {
        type: OptionType.BOOLEAN,
        description: "Show a desktop notification on match",
        default: true
    },
    toast: {
        type: OptionType.BOOLEAN,
        description: "Show an in-app toast on match",
        default: true
    }
});

const AlertIcon = ({ size = 18, muted = false }: { size?: number; muted?: boolean; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
            fill="currentColor"
            d="M12 2a7 7 0 0 0-7 7v4.6l-1.7 2.6A1 1 0 0 0 4.2 18h15.6a1 1 0 0 0 .9-1.8L19 13.6V9a7 7 0 0 0-7-7Zm0 20a3 3 0 0 0 3-3H9a3 3 0 0 0 3 3Z"
        />
        {muted && <path stroke="currentColor" strokeWidth={2} strokeLinecap="round" d="M3 3 L21 21" />}
    </svg>
);

function escapeRegex(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getKeywords(): string[] {
    return settings.store.keywords
        .split("/")
        .map(k => k.trim())
        .filter(Boolean);
}

/** Returns the first keyword present in `content`, or null. */
function findMatch(content: string): string | null {
    const keywords = getKeywords();
    if (!keywords.length) return null;

    for (const keyword of keywords) {
        const pattern = settings.store.wholeWord
            ? new RegExp(`\\b${escapeRegex(keyword)}\\b`, "i")
            : new RegExp(escapeRegex(keyword), "i");

        if (pattern.test(content)) return keyword;
    }

    return null;
}

function onMessage(event: any) {
    try {
        if (!settings.store.enabled) return;
        // Optimistic events are our own message echoed back before the server confirms it
        if (event.optimistic) return;

        const { message } = event;
        if (!message?.content) return;

        const currentUser = UserStore.getCurrentUser();
        if (!currentUser || message.author?.id === currentUser.id) return;
        if (settings.store.ignoreBots && message.author?.bot) return;

        const keyword = findMatch(message.content);
        if (!keyword) return;

        const channel = ChannelStore.getChannel(message.channel_id);
        const where = channel?.name ? `#${channel.name}` : "a DM";
        const author = message.author?.username ?? "Someone";

        if (settings.store.toast) {
            Toasts.show({
                message: `"${keyword}" mentioned by ${author} in ${where}`,
                id: Toasts.genId(),
                type: Toasts.Type.MESSAGE
            });
        }

        if (settings.store.desktopNotification) {
            showNotification({
                title: `${author} in ${where}`,
                body: message.content,
                icon: message.author?.id
                    ? UserStore.getUser(message.author.id)?.getAvatarURL(undefined, 128)
                    : undefined,
                onClick: () => {
                    const guildSegment = event.guildId ?? "@me";
                    NavigationRouter.transitionTo(`/channels/${guildSegment}/${message.channel_id}/${message.id}`);
                }
            });
        }
    } catch (err) {
        console.error("[Xicord Keyword Alerts] failed to handle message", err);
    }
}

export default definePlugin({
    name: "Xicord Keyword Alerts",
    description: "Notifies you when chosen keywords appear in any channel you can see",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    settings,

    xicordButton: ErrorBoundary.wrap(() => {
        const { enabled } = settings.use(["enabled"]);

        return (
            <PanelButton
                role="switch"
                aria-checked={enabled}
                tooltipText={enabled ? "Xicord Keyword Alerts (on)" : "Xicord Keyword Alerts (off)"}
                onClick={() => { settings.store.enabled = !settings.store.enabled; }}
                icon={() => <AlertIcon size={18} muted={!enabled} />}
            />
        );
    }, { noop: true }),

    start() {
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessage);
    },

    stop() {
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessage);
    }
});
