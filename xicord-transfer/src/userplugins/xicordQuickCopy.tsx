/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Xicord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import definePlugin, { OptionType } from "@utils/types";
import { Channel, Guild, Message, User } from "@vencord/discord-types";
import { Menu, Toasts } from "@webpack/common";

const settings = definePluginSettings({
    showToast: {
        type: OptionType.BOOLEAN,
        description: "Show a toast confirming what was copied",
        default: true
    }
});

function copy(label: string, value: string | null | undefined) {
    if (!value) {
        Toasts.show({
            message: `No ${label} to copy`,
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    copyToClipboard(value);

    if (settings.store.showToast) {
        Toasts.show({
            message: `Copied ${label}`,
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS
        });
    }
}

/**
 * Returns a Menu.MenuItem element directly rather than being a component.
 * Discord's Menu API walks its children and rejects anything that is not an
 * Item or a group of Items, so wrapping this in a component makes the whole
 * context menu fail to render.
 */
function copyItem(id: string, label: string, value: string | null | undefined) {
    return (
        <Menu.MenuItem
            id={`xicord-copy-${id}`}
            label={label}
            action={() => copy(label.replace(/^Copy /, ""), value)}
        />
    );
}

/** Discord only exposes an animated avatar when the hash is a gif, so ask for the real one. */
function avatarUrl(user: User) {
    return user.getAvatarURL(undefined, 4096, true);
}

const UserContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="xicord-copy-user" label="Quick Copy">
                {copyItem("user-id", "Copy User ID", user.id)}
                {copyItem("user-name", "Copy Username", user.username)}
                {copyItem("user-avatar", "Copy Avatar URL", avatarUrl(user))}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

const ChannelContext: NavContextMenuPatchCallback = (children, { channel }: { channel?: Channel; }) => {
    if (!channel) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="xicord-copy-channel" label="Quick Copy">
                {copyItem("channel-id", "Copy Channel ID", channel.id)}
                {copyItem("channel-name", "Copy Channel Name", channel.name)}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

const GuildContext: NavContextMenuPatchCallback = (children, { guild }: { guild?: Guild; }) => {
    if (!guild) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="xicord-copy-guild" label="Quick Copy">
                {copyItem("guild-id", "Copy Server ID", guild.id)}
                {copyItem("guild-name", "Copy Server Name", guild.name)}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

const MessageContext: NavContextMenuPatchCallback = (children, { message }: { message?: Message; }) => {
    if (!message) return;

    // DMs have no guild, and their permalinks use the literal "@me" segment
    const guildSegment = (message as any).guild_id ?? "@me";
    const link = `https://discord.com/channels/${guildSegment}/${message.channel_id}/${message.id}`;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem id="xicord-copy-message" label="Quick Copy">
                {copyItem("message-id", "Copy Message ID", message.id)}
                {copyItem("message-link", "Copy Message Link", link)}
                {copyItem("message-text", "Copy Raw Text", message.content)}
            </Menu.MenuItem>
        </Menu.MenuGroup>
    );
};

export default definePlugin({
    name: "Xicord Quick Copy",
    description: "Adds context menu shortcuts for copying IDs, names, avatar URLs and message links",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    settings,
    contextMenus: {
        "user-context": UserContext,
        "channel-context": ChannelContext,
        "guild-context": GuildContext,
        "message": MessageContext
    }
});
