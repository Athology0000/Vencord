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

import { React, Menu, ChannelStore, UserStore, ContextMenuApi, Toasts } from "@webpack/common";
import { Flex } from "@components/Flex";
import { findStoreLazy, findComponentByCodeLazy } from "@webpack";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import definePlugin, { OptionType } from "@utils/types";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { openUserProfile } from "@utils/discord";

const channelStore = findStoreLazy("PrivateChannelSortStore");
const relationshipStore = findStoreLazy("RelationshipStore");
const Button = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

let originalChannels;
let originalRelations;
let toggleSwitch = true;

const globalIconUpdate: {
    update: (value: any) => void;
    value: boolean;
} = {
    update: (value) => { },
    value: toggleSwitch
};

const settings = definePluginSettings({
    users: {
        type: OptionType.STRING,
        description: "User list seperated by /",
        default: "",
    }
});

const GroupDMContext: NavContextMenuPatchCallback = (children, props) => {
    const hide = MenuItem(props.channel.id, "Group DM");
    children.splice(-1, 0, (<Menu.MenuGroup>{hide}</Menu.MenuGroup>));
};

const UserContext: NavContextMenuPatchCallback = (children, props) => {
    const channelId = props?.channel?.id ?? ChannelStore.getDMFromUserId(props.user.id);
    const hide = MenuItem(channelId, props.user.username);
    children.splice(-1, 0, <Menu.MenuGroup>{hide}</Menu.MenuGroup>);
};


function MenuItem(channelId: string, name: string) {
    const [isChecked, setIsChecked] = React.useState(settings.store.users.split('/').filter(item => item !== '').includes(channelId));


    const group = ChannelStore.getChannel(channelId)?.isGroupDM();
    return (
        <Menu.MenuCheckboxItem
            id="Hide"
            label={`Hide ${group ? "group" : "user"}`}
            disabled={channelId === undefined}
            checked={isChecked}
            action={async () => {
                const updatedList = [...settings.store.users.split('/').filter(item => item !== '')];
                const index = updatedList.indexOf(channelId);

                if (index === -1) updatedList.push(channelId);
                else updatedList.splice(index, 1);

                Toasts.show({
                    message: `${name} has been ${index === -1 ? "added to the" : "removed from the"} stealth list`,
                    id: "stealth-mode",
                    type: index === -1 ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE,
                    options: {
                        position: Toasts.Position.BOTTOM,
                    }
                });

                setIsChecked(!isChecked);
                settings.store.users = updatedList.join("/");
                dmUpdate(false);
            }}
        />
    );
}

const contextMenus = {
    "gdm-context": GroupDMContext,
    "user-context": UserContext
};

export default definePlugin({
    name: "Xicord Hide Dms",
    description: "Hide dms with a keybind",
    authors: [{ name: "Xicord", id: 1284113557201620995n, }],
    dependencies: ["Xicord Mod Menu"],
    contextMenus,
    settings,
    // Button is rendered by Xicord Mod Menu's single panel patch
    xicordButton: ErrorBoundary.wrap(hiddenIcon, { noop: true }),

    start: () => {
        originalChannels = channelStore.getPrivateChannelIds;
        originalRelations = relationshipStore.getRelationships;
        document.addEventListener('keydown', keybind);
    },
    stop: () => document.removeEventListener('keydown', keybind),

});

function dmUpdate(toggle = true) {
    const updatedList = [...settings.store.users.split('/').filter(item => item !== '')];

    channelStore.getPrivateChannelIds = () => {
        return toggleSwitch ? originalChannels().filter(channelId => !updatedList.includes(channelId)) : originalChannels();
    };

    relationshipStore.getRelationships = () => {
        return toggleSwitch ? Object.fromEntries(
            Object.entries(originalRelations()).filter(([key, _]) => !updatedList.map(channelId => ChannelStore.getChannel(channelId)?.getRecipientId()).includes(key))
        )
            : originalRelations();
    };

    if (toggle) {
        toggleSwitch = !toggleSwitch;
        globalIconUpdate.update(!toggleSwitch);
    }
    channelStore.emitChange();
    relationshipStore.emitChange();
}
function keybind(e) {
    if (e.altKey && e.key.toLowerCase() === 'h') dmUpdate();
}

function hiddenIcon() {
    const [enabled, setEnabled] = React.useState(toggleSwitch);
    globalIconUpdate.update = setEnabled;

    return (
        <>
            <Button
                onContextMenu={e => ContextMenuApi.openContextMenu(e, () => <ContextMenu />)}
                onClick={() => dmUpdate()}
                role="switch"
                tooltipText={"Xicord Stealth"}
                icon={() =>
                    <svg width="18" height="18" viewBox="0 0 24 24">

                        <g fill={"currentColor"}>
                            {enabled ?
                                <>
                                    <path d="m2.876,7.118l13.189,13.189c-.715.254-1.489.441-2.314.559L1.602,8.718c.361-.517.781-1.06,1.274-1.6ZM.179,11.181c-.237.521-.237,1.118,0,1.64.041.091.094.199.147.308l6.911,6.911c1.107.476,2.361.8,3.766.908L.529,10.473c-.143.272-.261.514-.35.708Zm19.51,7.065l4.292,4.292-1.414,1.414L.019,1.403,1.433-.011l4.58,4.58c1.809-1.042,3.819-1.57,5.988-1.57,7.498,0,10.944,6.261,11.821,8.18.238.521.238,1.119,0,1.639-.478,1.046-1.77,3.485-4.134,5.427ZM8.541,7.097l1.446,1.446c1.531-.891,3.531-.682,4.842.628s1.52,3.311.628,4.842l1.446,1.446c1.653-2.341,1.433-5.609-.66-7.702-2.093-2.094-5.362-2.314-7.702-.66Z" />
                                    <path d="m2.876,7.118l13.189,13.189c-.715.254-1.489.441-2.314.559L1.602,8.718c.361-.517.781-1.06,1.274-1.6ZM.179,11.181c-.237.521-.237,1.118,0,1.64.041.091.094.199.147.308l6.911,6.911c1.107.476,2.361.8,3.766.908L.529,10.473c-.143.272-.261.514-.35.708Zm19.51,7.065l4.292,4.292-1.414,1.414L.019,1.403,1.433-.011l4.58,4.58c1.809-1.042,3.819-1.57,5.988-1.57,7.498,0,10.944,6.261,11.821,8.18.238.521.238,1.119,0,1.639-.478,1.046-1.77,3.485-4.134,5.427ZM8.541,7.097l1.446,1.446c1.531-.891,3.531-.682,4.842.628s1.52,3.311.628,4.842l1.446,1.446c1.653-2.341,1.433-5.609-.66-7.702-2.093-2.094-5.362-2.314-7.702-.66Z" />
                                </> :
                                <path d="m2.876,7.118l13.189,13.189c-.715.254-1.489.441-2.314.559L1.602,8.718c.361-.517.781-1.06,1.274-1.6ZM.179,11.181c-.237.521-.237,1.118,0,1.64.041.091.094.199.147.308l6.911,6.911c1.107.476,2.361.8,3.766.908L.529,10.473c-.143.272-.261.514-.35.708Zm19.51,7.065l4.292,4.292-1.414,1.414L.019,1.403,1.433-.011l4.58,4.58c1.809-1.042,3.819-1.57,5.988-1.57,7.498,0,10.944,6.261,11.821,8.18.238.521.238,1.119,0,1.639-.478,1.046-1.77,3.485-4.134,5.427ZM8.541,7.097l1.446,1.446c1.531-.891,3.531-.682,4.842.628s1.52,3.311.628,4.842l1.446,1.446c1.653-2.341,1.433-5.609-.66-7.702-2.093-2.094-5.362-2.314-7.702-.66Z" />}
                        </g>
                    </svg>
                }
            />
        </>
    );
}


function ContextMenu() {
    const [isChecked, setIsChecked] = React.useState(settings.store.users.split('/').filter(item => item !== ''));
    const [, setReset] = React.useState(false);
    return (
        <Menu.Menu
            navId="Voice-state-modifier"
            onClose={() => { }}
            aria-label="Xicord-Stealth"
        >
            <Menu.MenuItem
                id="Xicord-Stealth"
                label="Xicord Stealth"
                action={() => openUserProfile("1284113557201620995")}
                icon={() => {
                    return (
                        <svg
                            className={"vc-icon"}
                            role="img"
                            width={"18"}
                            height={"18"}
                            viewBox={"0 0 24 24"}
                        >
                            <g fill={"#b5bac1"}>
                                <path d="m.002,11.975l8.566,8.574c-3.684-.967-6.117-3.383-7.599-5.491C.321,14.136,0,13.056.002,11.975Zm.967-3.059c-.17.242-.315.496-.44.757l11.308,11.308c.055,0,.107.006.163.006,1.244,0,2.439-.159,3.577-.474L2.326,7.263c-.477.514-.936,1.055-1.357,1.654Zm22.591,14.644c-.293.293-.677.439-1.061.439s-.768-.146-1.061-.439L.439,2.561C-.146,1.975-.146,1.025.439.439,1.025-.146,1.975-.146,2.561.439l3.804,3.804c1.726-.825,3.617-1.243,5.635-1.243,5.672,0,9.129,3.224,11.031,5.929,1.291,1.837,1.291,4.305,0,6.142-.827,1.177-1.766,2.194-2.802,3.037l3.332,3.332c.586.585.586,1.536,0,2.121ZM8.661,6.54l1.776,1.776c1.456-.617,3.203-.332,4.391.855s1.472,2.934.855,4.391l2.409,2.409c.918-.704,1.751-1.583,2.484-2.626.565-.805.565-1.887,0-2.692-1.492-2.123-4.192-4.654-8.576-4.654-1.178,0-2.295.181-3.339.54Z" />
                                <path d="m.002,11.975l8.566,8.574c-3.684-.967-6.117-3.383-7.599-5.491C.321,14.136,0,13.056.002,11.975Zm.967-3.059c-.17.242-.315.496-.44.757l11.308,11.308c.055,0,.107.006.163.006,1.244,0,2.439-.159,3.577-.474L2.326,7.263c-.477.514-.936,1.055-1.357,1.654Zm22.591,14.644c-.293.293-.677.439-1.061.439s-.768-.146-1.061-.439L.439,2.561C-.146,1.975-.146,1.025.439.439,1.025-.146,1.975-.146,2.561.439l3.804,3.804c1.726-.825,3.617-1.243,5.635-1.243,5.672,0,9.129,3.224,11.031,5.929,1.291,1.837,1.291,4.305,0,6.142-.827,1.177-1.766,2.194-2.802,3.037l3.332,3.332c.586.585.586,1.536,0,2.121ZM8.661,6.54l1.776,1.776c1.456-.617,3.203-.332,4.391.855s1.472,2.934.855,4.391l2.409,2.409c.918-.704,1.751-1.583,2.484-2.626.565-.805.565-1.887,0-2.692-1.492-2.123-4.192-4.654-8.576-4.654-1.178,0-2.295.181-3.339.54Z" />                            </g>
                        </svg>
                    );
                }}
            />
            <Menu.MenuSeparator />

            <Menu.MenuGroup label="STEALTH LIST">
                <Menu.MenuSeparator />
                <Menu.MenuItem
                    id="clear list "
                    label="Reset list"
                    disabled={isChecked.length == 0}
                    action={() => {
                        setReset(true);
                        settings.store.users = "";
                        dmUpdate(false);
                    }}
                    icon={() => {
                        return (
                            <svg
                                className={"reset-icon"}
                                role="img"
                                width={"18"}
                                height={"18"}
                                viewBox={"0 0 26 26"}
                            >
                                <g fill={"#b5bac1"}
                                >
                                    <path d="m.002,11.975l8.566,8.574c-3.684-.967-6.117-3.383-7.599-5.491C.321,14.136,0,13.056.002,11.975Zm.967-3.059c-.17.242-.315.496-.44.757l11.308,11.308c.055,0,.107.006.163.006,1.244,0,2.439-.159,3.577-.474L2.326,7.263c-.477.514-.936,1.055-1.357,1.654Zm22.591,14.644c-.293.293-.677.439-1.061.439s-.768-.146-1.061-.439L.439,2.561C-.146,1.975-.146,1.025.439.439,1.025-.146,1.975-.146,2.561.439l3.804,3.804c1.726-.825,3.617-1.243,5.635-1.243,5.672,0,9.129,3.224,11.031,5.929,1.291,1.837,1.291,4.305,0,6.142-.827,1.177-1.766,2.194-2.802,3.037l3.332,3.332c.586.585.586,1.536,0,2.121ZM8.661,6.54l1.776,1.776c1.456-.617,3.203-.332,4.391.855s1.472,2.934.855,4.391l2.409,2.409c.918-.704,1.751-1.583,2.484-2.626.565-.805.565-1.887,0-2.692-1.492-2.123-4.192-4.654-8.576-4.654-1.178,0-2.295.181-3.339.54Z" />
                                </g>

                            </svg>
                        );
                    }}
                />
                <Menu.MenuSeparator />
                {settings.store.users.split('/').filter(item => item !== '').length === 0 ?
                    <Menu.MenuItem
                        id="Empty List"
                        label="Empty"
                        disabled={true}
                    /> :
                    settings.store.users.split('/').filter(item => item !== '').map((channelId) => {

                        const channel = ChannelStore.getChannel(channelId);
                        const userId = channel?.getRecipientId();
                        const group = channel?.isGroupDM() ?? false;

                        return (
                            <>
                                <Menu.MenuItem
                                    id={String(userId)}
                                    label={group ? "Group Dm" : <Flex style={{ alignItems: "center", gap: "0.5em" }}>
                                        <img
                                            style={{
                                                borderRadius: "50%"
                                            }}
                                            aria-hidden="true"
                                            height={28}
                                            width={28}
                                            src={UserStore.getUser(String(userId))?.getAvatarURL() ??
                                                "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQSuV3pnrrgeSNYPADFteFSiKUUFgD-04hYBA&s"}
                                        />
                                        {UserStore.getUser(String(userId))?.username ?? userId}
                                    </Flex>}
                                    action={() => userId ? openUserProfile(String(userId)) : null}
                                    children={
                                        <Menu.MenuItem
                                            key={String(userId) + "p" + group}
                                            id={String(userId) + "p" + group}
                                            label="Remove"
                                            action={() => {
                                                const updatedList = [...settings.store.users.split('/').filter(item => item !== '')];
                                                const index = updatedList.indexOf(String(channelId));
                                                if (index === -1) {
                                                    updatedList.push(String(channelId));
                                                } else {
                                                    updatedList.splice(index, 1);
                                                }
                                                setIsChecked(updatedList);
                                                settings.store.users = updatedList.join("/");
                                                dmUpdate(false);

                                            }}
                                            icon={() => {
                                                return (
                                                    <svg
                                                        className={"vc-icon"}
                                                        role="img"
                                                        width={"18"}
                                                        height={"18"}
                                                        viewBox={"0 0 24 24"}
                                                    >
                                                        <g fill={"var(--red-430)"}>
                                                            <path
                                                                d="M14.25 1c.41 0 .75.34.75.75V3h5.25c.41 0 .75.34.75.75v.5c0 .41-.34.75-.75.75H3.75A.75.75 0 0 1 3 4.25v-.5c0-.41.34-.75.75-.75H9V1.75c0-.41.34-.75.75-.75h4.5Z"
                                                            />
                                                            <path
                                                                fillRule="evenodd"
                                                                d="M5.06 7a1 1 0 0 0-1 1.06l.76 12.13a3 3 0 0 0 3 2.81h8.36a3 3 0 0 0 3-2.81l.75-12.13a1 1 0 0 0-1-1.06H5.07ZM11 12a1 1 0 1 0-2 0v6a1 1 0 1 0 2 0v-6Zm3-1a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0v-6a1 1 0 0 1 1-1Z" />
                                                        </g>
                                                    </svg>
                                                );
                                            }}
                                        />
                                    }
                                />
                            </>
                        );
                    })}
            </Menu.MenuGroup>
        </Menu.Menu>
    );
}



