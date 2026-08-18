/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Xicord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Modal, NavigationRouter, openModal, React } from "@webpack/common";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

/** How often due reminders are checked. Polling avoids setTimeout's ~24 day ceiling. */
const TICK_MS = 20_000;

const settings = definePluginSettings({
    reminders: {
        type: OptionType.STRING,
        description: "Pending reminders (managed by /remind, not by hand)",
        default: "[]"
    }
});

interface Reminder {
    id: string;
    note: string;
    due: number;
    channelId: string | null;
    guildId: string | null;
}

const listeners = new Set<() => void>();
let tick: ReturnType<typeof setInterval> | undefined;

function readReminders(): Reminder[] {
    try {
        const parsed = JSON.parse(settings.store.reminders || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeReminders(reminders: Reminder[]) {
    settings.store.reminders = JSON.stringify(reminders);
    listeners.forEach(l => l());
}

const UNITS: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000
};

/**
 * Parses durations like "10m", "2h30m", "1d 6h" into milliseconds.
 * Returns null when nothing parseable was found.
 */
export function parseDuration(input: string): number | null {
    const matches = [...input.matchAll(/(\d+)\s*([smhd])/gi)];
    if (!matches.length) return null;

    let total = 0;
    for (const [, amount, unit] of matches) {
        total += Number(amount) * UNITS[unit.toLowerCase()];
    }

    return total > 0 ? total : null;
}

function formatRemaining(ms: number) {
    if (ms <= 0) return "now";

    const days = Math.floor(ms / UNITS.d);
    const hours = Math.floor((ms % UNITS.d) / UNITS.h);
    const minutes = Math.floor((ms % UNITS.h) / UNITS.m);

    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${minutes}m`;
    if (minutes) return `${minutes}m`;
    return "under a minute";
}

function fire(reminder: Reminder) {
    showNotification({
        title: "Xicord Reminder",
        body: reminder.note,
        onClick: reminder.channelId
            ? () => NavigationRouter.transitionTo(`/channels/${reminder.guildId ?? "@me"}/${reminder.channelId}`)
            : undefined
    });
}

function checkDue() {
    const reminders = readReminders();
    if (!reminders.length) return;

    const now = Date.now();
    const due = reminders.filter(r => r.due <= now);
    if (!due.length) return;

    due.forEach(fire);
    writeReminders(reminders.filter(r => r.due > now));
}

const ClockIcon = ({ size = 18 }: { size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
            fill="currentColor"
            d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1 10a1 1 0 0 1-.4.8l-3 2.2a1 1 0 1 1-1.2-1.6L11 11.5V6a1 1 0 1 1 2 0v6Z"
        />
    </svg>
);

function RemindersModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [, forceUpdate] = React.useReducer(x => x + 1, 0);

    React.useEffect(() => {
        listeners.add(forceUpdate);
        return () => void listeners.delete(forceUpdate);
    }, []);

    const reminders = readReminders().sort((a, b) => a.due - b.due);
    const now = Date.now();

    return (
        <Modal
            {...modalProps}
            title="Xicord Reminders"
            subtitle={reminders.length ? `${reminders.length} pending` : undefined}
            actions={[
                {
                    text: "Clear All",
                    variant: "secondary",
                    onClick: () => writeReminders([]),
                    disabled: reminders.length === 0
                },
                { text: "Close", variant: "primary", onClick: modalProps.onClose }
            ]}
        >
            {reminders.length === 0
                ? <span>No reminders. Set one with <code>/remind in:10m note:stretch</code>.</span>
                : (
                    <Flex flexDirection="column" gap={8}>
                        {reminders.map(reminder => (
                            <Flex key={reminder.id} style={{ alignItems: "center", gap: 8 }}>
                                <span style={{ color: "var(--text-muted)", minWidth: 90 }}>
                                    in {formatRemaining(reminder.due - now)}
                                </span>
                                <span style={{ flex: 1 }}>{reminder.note}</span>
                                <span
                                    role="button"
                                    style={{ cursor: "pointer", color: "var(--text-danger)" }}
                                    onClick={() => writeReminders(readReminders().filter(r => r.id !== reminder.id))}
                                >
                                    Cancel
                                </span>
                            </Flex>
                        ))}
                    </Flex>
                )}
        </Modal>
    );
}

export default definePlugin({
    name: "Xicord Reminders",
    description: "Set reminders with /remind and get a notification when they are due",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    settings,

    commands: [
        {
            name: "remind",
            description: "Remind yourself about something later",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "in",
                    description: "When to remind you, e.g. 10m, 2h30m, 1d",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "note",
                    description: "What to remind you about",
                    type: ApplicationCommandOptionType.STRING,
                    required: false
                }
            ],
            execute: (args, ctx) => {
                const raw = findOption(args, "in", "");
                const note = findOption(args, "note", "Reminder");
                const delay = parseDuration(raw);

                if (delay == null) {
                    return sendBotMessage(ctx.channel.id, {
                        content: `Could not read a duration from \`${raw}\`. Try something like \`10m\`, \`2h30m\` or \`1d\`.`
                    });
                }

                const reminder: Reminder = {
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    note,
                    due: Date.now() + delay,
                    channelId: ctx.channel.id,
                    guildId: (ctx.channel as any).guild_id ?? null
                };

                writeReminders([...readReminders(), reminder]);

                sendBotMessage(ctx.channel.id, {
                    content: `Okay, reminding you in ${formatRemaining(delay)}: **${note}**`
                });
            }
        }
    ],

    xicordButton: ErrorBoundary.wrap(() => (
        <PanelButton
            role="button"
            tooltipText="Xicord Reminders"
            onClick={() => openModal(modalProps => <RemindersModal modalProps={modalProps} />)}
            icon={() => <ClockIcon size={18} />}
        />
    ), { noop: true }),

    start() {
        // Fire anything that came due while Discord was closed, then poll
        checkDue();
        tick = setInterval(checkDue, TICK_MS);
    },

    stop() {
        if (tick) clearInterval(tick);
        tick = undefined;
        listeners.clear();
    }
});
