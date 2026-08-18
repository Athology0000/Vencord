

/*
MIT License

Copyright (c) 2024 Xicord

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


import { findByPropsLazy, findByCodeLazy, findByProps } from "@webpack";
import definePlugin, { OptionType } from "@utils/types";
import { Tooltip, React, PermissionStore, UserStore, Toasts, Menu, ContextMenuApi, NavigationRouter, ChannelStore, GuildStore } from "@webpack/common";
import { Flex } from "@components/Flex";
import { findStoreLazy } from "@webpack";
import { copyToClipboard } from "@utils/clipboard";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import ErrorBoundary from "@components/ErrorBoundary";
import { User } from "@vencord/discord-types";
import { addProfileBadge, BadgePosition, BadgeUserArgs, ProfileBadge, removeProfileBadge } from "@api/Badges";
import { definePluginSettings } from "@api/Settings";
import { openUserProfile } from "@utils/discord";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";

const sessionStore = findByPropsLazy("getSessionId");
const scroll = findByPropsLazy("channelListScrollTo");

const Button = findByCodeLazy("actionButtonMobile]");
const VoiceStateStore = findStoreLazy("VoiceStateStore");
const ChannelActions = findByPropsLazy("selectChannel", "selectVoiceChannel");
const CONNECT = 1n << 20n;
const badge: ProfileBadge = {
    id: "xicord-vc-indicator",
    description: "In a voice channel",
    position: BadgePosition.START,
    getBadges

};
const settings = definePluginSettings({
    autoNavigate: {
        description: "Navigates to a channel",
        type: OptionType.BOOLEAN,
        default: false,
    },
    colouredToolTip: {
        description: "Adds a colour to tooltip based on the vc status",
        type: OptionType.BOOLEAN,
        default: false,
    }
});
function getBadges({ userId }: BadgeUserArgs): ProfileBadge[] {
    const user = UserStore.getUser(userId);
    if (!user || user.bot) return [];
    const states = VoiceStateStore.getVoiceStateForUser(user.id) ?? null;
    if (!states) return [];

    return [{
        id: "xicord-vc-indicator",
        key: "xicord-vc-indicator",
        description: "In a voice channel",
        component: () => (
            <span className="Xicord-vc-indicator">
                <Vc channelId={states.channelId} small={false} />
            </span>
        )
    }];
}
const indicatorLocations = {
    list: {
        onEnable: () => addMemberListDecorator("join-vc-icon", props =>
            <ErrorBoundary noop>
                <VcIcon user={props.user} small={true} />
            </ErrorBoundary>
        ),
        onDisable: () => removeMemberListDecorator("join-vc-icon")
    },
    badges: {
        description: "In user profiles, as badges",
        onEnable: () => addProfileBadge(badge),
        onDisable: () => removeProfileBadge(badge)
    },
    messages: {
        onEnable: () => addMessageDecoration("join-vc-icon", props =>
            <ErrorBoundary noop>
                <VcIcon user={props.message?.author} wantTopMargin={true} />
            </ErrorBoundary>
        ),
        onDisable: () => removeMessageDecoration("join-vc-icon")
    }
};
const currentvc = () => {
    const voiceOptions = VoiceStateStore.getVoiceStateForSession(UserStore.getCurrentUser().id, sessionStore.getSessionId());
    return voiceOptions?.channelId ? `<#${voiceOptions?.channelId}>` : "";
};
export default definePlugin({
    name: "Xicord Vc Indicator",
    dependencies: ["Xicord Mod Menu"],
    description: "Adds an Icon to users to join their voice channels",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    vcIcon2: ErrorBoundary.wrap(vcIcon2, { noop: true }),
    contextMenus: {
        "rtc-channel": ChannelMakeContextMenuPatch(),
    },
    settings,
    // NOTE: the original DM-list button patch ("handleOpenPrivateChannel,children")
    // corrupts the 2026 DM row renderer and crash-loops the client — removed.
    patches: [],
    commands: [
        {
            name: "vc",
            description: "Sends your current vc",
            options: [],
            execute: () => ({
                content: currentvc()
            }),
        }
    ],
    start() {
        Object.entries(indicatorLocations).forEach(([key, value]) => {
            value.onEnable();
        });
        document.head.appendChild(document.createElement('style')).textContent = `
        .Xicord-vc-indicator {
              display: inline-flex;
              justify-content: center;
              align-items: center;
              vertical-align: top;
              position: relative;
        }
      `;
    },
    stop() {
        Object.entries(indicatorLocations).forEach(([_, value]) => {
            value.onDisable();
        });
    },
});
function vcIcon2(props) {

    const states = VoiceStateStore.getVoiceStateForUser(props.user.id) ?? null;

    if (!states) return null;

    const channel = ChannelStore.getChannel(states.channelId);
    const guild = GuildStore.getGuild(channel.guild_id);

    const channelVoiceStates = VoiceStateStore.getVoiceStatesForChannel(states.channelId) ?? {};
    const users = Object.keys(channelVoiceStates).length;

    let tip;

    let limit: any = channel.userLimit;
    if (limit === 0) limit = "Infinity ";

    if (channel.isDM()) tip = "DM call";
    else if (channel.isGroupDM()) tip = "Group call";
    else tip = `${channel?.name} - ${guild?.name} - ${users} / ${limit}`;

    return (
        <>
            <Button
                onClick={async (e) => {
                    ContextMenuApi.openContextMenu(e, () => <ContextMenu />);
                    JoinVc(states.channelId);
                }}
                tooltip={tip}
                shouldHighlight={false}
                icon={() => <svg width="18" height="18" viewBox="0 0 24 24">
                    <g fill={"#b5bac1"}>
                        <path d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
                        <path d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z" />
                    </g>
                </svg>
                }
            />
        </>
    );
}
//dummy context menu stops discord from opening dms when deleting
function ContextMenu() {
    return (null);
}
function VcIcon({ user, wantMargin = true, wantTopMargin = false, small = false }: { user: User; wantMargin?: boolean; wantTopMargin?: boolean; small?: boolean; }) {

    if (!user) return null;
    const states = VoiceStateStore.getVoiceStateForUser(user.id) ?? null;
    return (
        <span
            className="vc-platform-indicator"
            style={{
                marginLeft: wantMargin ? 4 : 0,
                top: wantTopMargin ? 2 : 0,
                gap: 2
            }}
        >
            {states ? (<Vc channelId={states.channelId} small={small} />) : (null)}
        </span>
    );
}
function JoinVc(channelID) {
    const channel = ChannelStore.getChannel(channelID);

    if (!PermissionStore.can(CONNECT, channel) && !channel.isDM()) {
        Toasts.show({
            message: `Insufficient permissions to join ${channel.name}`,
            id: "Vc-permissions",
            type: Toasts.Type.FAILURE,
            options: {
                position: Toasts.Position.BOTTOM,
            }
        });
        return;
    }
    ChannelActions.selectVoiceChannel(channelID);
    if (settings.store.autoNavigate) autoNavigate(channel.guild_id, channel.id);
}
function autoNavigate(guild: string, channel: string) {
    const checkExist = setInterval(() => {
        const navigate = document.querySelector(`a[href="/channels/${guild}/${channel}"]`) as HTMLButtonElement;
        if (navigate) {
            navigate.click();
            clearInterval(checkExist);
        }
    }, 50);
}
function Vc({ channelId, small }) {
    const channel = ChannelStore.getChannel(channelId);
    const guild = GuildStore.getGuild(channel.guild_id);

    const channelVoiceStates = VoiceStateStore.getVoiceStatesForChannel(channelId) ?? {};
    const users = Object.keys(channelVoiceStates).length;
    const ids: string[] = [];

    Object.keys(channelVoiceStates).forEach(t => ids.push(t));

    const connect = PermissionStore.can(CONNECT, channel) || channel.isDM();
    const fullVc = (channel?.userLimit === users);

    let colour;

    if (!connect) colour = "red";
    else if (fullVc) colour = "yellow";
    else colour = "green";

    if (settings.store.colouredToolTip) colour = "primary";

    let limit: any = channel.userLimit;
    if (limit === 0) limit = "Infinity ";

    let tip;
    if (channel.isDM()) tip = "DM call";
    else if (channel.isGroupDM()) tip = "Group call";
    else tip = `${channel?.name} - ${guild?.name} - ${users} / ${limit}`;
    return <Tooltip text={tip} color={colour}>
        {(tooltipProps: any) => (
            <div
                onClick={(e) => JoinVc(channelId)}
                onContextMenu={e => ContextMenuApi.openContextMenu(e, () => <>
                    <Menu.Menu
                        navId="Voice-state-modifier"
                        onClose={() => { }}
                        aria-label="Voice state modifier"
                    >
                        {CopyGuildId(guild?.id)}
                        {CopyChannelId(channelId)}
                        {ScrollToChannel(guild?.id, channelId)}
                        <Menu.MenuGroup label={`Other Members - ${users}`}>

                            {ids.map((id) => (
                                <Menu.MenuItem
                                    key={UserStore.getUser(id).username}
                                    id={UserStore.getUser(id).username}
                                    label={
                                        <Flex style={{ alignItems: "center", gap: "0.5em" }}>
                                            <img
                                                style={{
                                                    borderRadius: "50%"
                                                }}
                                                aria-hidden="true"
                                                height={28}
                                                width={28}
                                                src={UserStore.getUser(String(id))?.getAvatarURL() ??
                                                    "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQSuV3pnrrgeSNYPADFteFSiKUUFgD-04hYBA&s"}
                                            />
                                            {UserStore.getUser(String(id))?.username ?? id}
                                        </Flex>
                                    }
                                    action={() => openUserProfile(id)}

                                />
                            )
                            )}
                        </Menu.MenuGroup>
                    </Menu.Menu>
                </>)}
            >
                <svg
                    {...tooltipProps}
                    height={19 - (small ? 3 : 0)}
                    width={19 - (small ? 3 : 0)}
                    viewBox={"0 0 24 24"}
                    fill={"#b5bac1"}
                >
                    <path d="M12 3a1 1 0 0 0-1-1h-.06a1 1 0 0 0-.74.32L5.92 7H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2.92l4.28 4.68a1 1 0 0 0 .74.32H11a1 1 0 0 0 1-1V3ZM15.1 20.75c-.58.14-1.1-.33-1.1-.92v-.03c0-.5.37-.92.85-1.05a7 7 0 0 0 0-13.5A1.11 1.11 0 0 1 14 4.2v-.03c0-.6.52-1.06 1.1-.92a9 9 0 0 1 0 17.5Z" />
                    <path d="M15.16 16.51c-.57.28-1.16-.2-1.16-.83v-.14c0-.43.28-.8.63-1.02a3 3 0 0 0 0-5.04c-.35-.23-.63-.6-.63-1.02v-.14c0-.63.59-1.1 1.16-.83a5 5 0 0 1 0 9.02Z" />
                </svg>

            </div>
        )}
    </Tooltip>;
}

function ChannelMakeContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        if (!props) return;

        const group = findGroupChildrenByChildId(["show-voice-states"], children);


        const item1 = CopyGuildId(props?.channel?.guild_id);
        const item2 = CopyChannelId(props?.channel?.id);


        if (!group) return;
        if (item1) group.push(item1);
        if (item2) group.push(item2);

    };
}
function ScrollToChannel(GuildId: string, ChannelId: string) {
    if (!GuildId) return;
    return (
        <Menu.MenuItem
            id="scrollToChannel"
            label="Show Channel"
            action={() => {
                NavigationRouter.transitionTo(`/channels/${GuildId}/${ChannelId}`);
                scroll.channelListScrollTo(GuildId, ChannelId);
            }}
            icon={CopyIcon}

        />
    );
}
function CopyGuildId(GuildId: string) {
    if (!GuildId) return;
    return (
        <Menu.MenuItem
            id="guild-Id"
            label="Copy Guild ID"
            action={() => {
                copyToClipboard(GuildId);
            }}
            icon={CopyIcon}

        />
    );
}
function CopyChannelId(ChannelId: string) {
    return (
        <Menu.MenuItem
            id="channel-Id"
            label="Copy Channel ID"
            action={() => {
                copyToClipboard(ChannelId);
            }}
            icon={CopyIcon}
        />
    );
}
const CopyIcon = () => {
    return <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="18" height="18">
        <path d="M12.9297 3.25007C12.7343 3.05261 12.4154 3.05226 12.2196 3.24928L11.5746 3.89824C11.3811 4.09297 11.3808 4.40733 11.5739 4.60245L16.5685 9.64824C16.7614 9.84309 16.7614 10.1569 16.5685 10.3517L11.5739 15.3975C11.3808 15.5927 11.3811 15.907 11.5746 16.1017L12.2196 16.7507C12.4154 16.9477 12.7343 16.9474 12.9297 16.7499L19.2604 10.3517C19.4532 10.1568 19.4532 9.84314 19.2604 9.64832L12.9297 3.25007Z" />
        <path d="M8.42616 4.60245C8.6193 4.40733 8.61898 4.09297 8.42545 3.89824L7.78047 3.24928C7.58466 3.05226 7.26578 3.05261 7.07041 3.25007L0.739669 9.64832C0.5469 9.84314 0.546901 10.1568 0.739669 10.3517L7.07041 16.7499C7.26578 16.9474 7.58465 16.9477 7.78047 16.7507L8.42545 16.1017C8.61898 15.907 8.6193 15.5927 8.42616 15.3975L3.43155 10.3517C3.23869 10.1569 3.23869 9.84309 3.43155 9.64824L8.42616 4.60245Z" />
    </svg>;
};
