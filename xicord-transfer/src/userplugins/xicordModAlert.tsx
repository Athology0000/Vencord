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

import definePlugin, { makeRange, OptionType } from "@utils/types";
import { Toasts, Menu, React, FluxDispatcher, UserStore, GuildStore, GuildRoleStore, GuildMemberStore } from "@webpack/common";
import { Guild, GuildMember, } from "@vencord/discord-types";
import { findStoreLazy, } from "@webpack";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";

const VoiceStateStore = findStoreLazy("VoiceStateStore");

const settings = definePluginSettings({
    IncludedServers: {
        type: OptionType.STRING,
        description: "A list of servers seperated by /",
        default: "",
    },
    audioLink: {
        type: OptionType.STRING,
        description: "The audio clip that is triggered when a mod joins",
        default: "https://www.myinstants.com/media/sounds/video0_k03U0Iy.mp3",
    },
    audioVolume: {
        description: "Change the volume of the audio",
        type: OptionType.SLIDER,
        markers: makeRange(0, 100, 10),
        default: 100,
        stickToMarkers: false,
    },

});
export default definePlugin({
    name: "Xicord Mod Alert ",
    description: "mod alert ",
    settings,
    authors: [{ name: "Xicord", id: 1284113557201620995n, }],
    contextMenus: {
        "guild-context": guildContextPatch(),
        "guild-header-popout": guildContextPatch(),
    },
    start() { FluxDispatcher.subscribe("VOICE_STATE_UPDATES", cb); }

});

const avoidPermission: bigint[] = [
    (BigInt(1) << 3n),
    (BigInt(1) << 2n),
    (BigInt(1) << 1n),
    (BigInt(1) << 24n),
    (BigInt(1) << 22n),
    (BigInt(1) << 23n),
];
function guildContextPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        const group = findGroupChildrenByChildId("privacy", children);
        if (!group) return;
        if (!props) return;

        const idx = group.findIndex(c => c?.props?.id === "privacy");
        const [isChecked, setIsChecked] = React.useState(settings.store.IncludedServers.split('/').filter(item => item !== '').includes(props.guild.id));

        group.splice(idx, 0, <Menu.MenuItem
            id="mod-alert"
            label="MOD ALERT"
            children={
                <>
                    <Menu.MenuCheckboxItem
                        key="Include server"
                        id="Include server"
                        label="Include server"
                        action={() => {
                            const updatedList = [...settings.store.IncludedServers.split('/').filter(item => item !== '')];
                            const index = updatedList.indexOf(props.guild.id);
                            if (index === -1) updatedList.push(props.guild.id);
                            else updatedList.splice(index, 1);
                            setIsChecked(!isChecked);
                            settings.store.IncludedServers = updatedList.join("/");
                        }}
                        checked={isChecked}
                    />

                </>
            }
        />);
    };
}
const cb = async (e: any) => {
    // VOICE_STATE_UPDATES can arrive with an empty batch; indexing it blindly threw
    // a TypeError on every such dispatch.
    const state = e.voiceStates?.[0];
    if (!state?.channelId) return;
    if (state.userId == UserStore.getCurrentUser().id || !state.userId) return;
    if (state?.channelId == state?.oldChannelId) return;
    if (!settings.store.IncludedServers.split("/").includes(state.guildId)) return;


    const channelVoiceStates = VoiceStateStore.getVoiceStatesForChannel(state?.channelId) ?? {};
    if (!Object.keys(channelVoiceStates).includes(UserStore.getCurrentUser().id)) return;
    const member = GuildMemberStore.getMember(state.guildId, state.userId!);
    if (!member) return;

    const roles = getSortedRoles(GuildStore.getGuild(state.guildId), member)
        .map(role => ({
            type: 0,
            ...role
        }));
    for (let role of roles) {
        for (let permission of avoidPermission) {
            if ((role.permissions & permission) === permission) {
                Toasts.show({
                    message: `MOD ALERT`,
                    id: "Vc-permissions",
                    type: Toasts.Type.FAILURE,
                    options: {
                        position: Toasts.Position.BOTTOM,
                    }
                });
                audio();

                break;
            }
        }
    }

};

function getSortedRoles({ id }: Guild, member: GuildMember) {
    const roles = GuildRoleStore.getRolesSnapshot(id);

    return [...member.roles, id]
        .map(id => roles[id])
        .sort((a, b) => b.position - a.position);
}

function audio() {
    const audioElement = document.createElement("audio");
    audioElement.src = settings.store.audioLink;
    audioElement.volume = settings.store.audioVolume / 100;
    audioElement.play();
}


