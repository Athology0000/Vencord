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
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { classes } from "@utils/misc";
import { ModalContent as ModalContentRaw, ModalHeader as ModalHeaderRaw, ModalRoot as ModalRootRaw, ModalSize, openModal } from "@utils/modal";
import definePlugin, { OptionType } from "@utils/types";
import type { RenderModalProps } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, FluxDispatcher, Forms, Menu, React, UserStore } from "@webpack/common";
import type { ComponentType } from "react";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;

const settings = definePluginSettings({
    ghosted: {
        description: "Ghosted user IDs (JSON array)",
        type: OptionType.STRING,
        default: "[]",
        onChange() { refresh(); }
    },
    hideMessages: {
        description: "Hide new messages from ghosted users",
        type: OptionType.BOOLEAN,
        default: true,
    },
    hideTyping: {
        description: "Hide typing indicators from ghosted users",
        type: OptionType.BOOLEAN,
        default: true,
    },
    hideReactions: {
        description: "Hide reactions added by ghosted users",
        type: OptionType.BOOLEAN,
        default: true,
    },
});

function parseIds(raw: string): string[] {
    try {
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data.filter(id => typeof id === "string") : [];
    } catch { return []; }
}

const getGhosted = () => parseIds(settings.store.ghosted);
let ghostSet = new Set<string>();
let active = false;
const listeners = new Set<() => void>();

function refresh() {
    ghostSet = new Set(getGhosted());
    listeners.forEach(l => { try { l(); } catch { } });
}

// A single interceptor for the plugin's lifetime. Discord's Flux has no public
// remove, so it is guarded by `active` and the per-event settings instead.
function interceptor(action: any): boolean {
    if (!active || ghostSet.size === 0) return false;
    try {
        switch (action?.type) {
            case "MESSAGE_CREATE":
                return !!settings.store.hideMessages && ghostSet.has(action.message?.author?.id);
            case "TYPING_START":
                return !!settings.store.hideTyping && ghostSet.has(action.userId);
            case "MESSAGE_REACTION_ADD":
                return !!settings.store.hideReactions && ghostSet.has(action.userId);
        }
    } catch { }
    return false;
}

function toggleGhost(id: string) {
    const ghosted = getGhosted();
    if (ghosted.includes(id)) settings.store.ghosted = JSON.stringify(ghosted.filter(g => g !== id));
    else settings.store.ghosted = JSON.stringify([...ghosted, id]);
    // refresh() runs via the setting's onChange handler
}

function GhostModal(props: RenderModalProps) {
    const [, force] = React.useReducer(x => x + 1, 0);
    React.useEffect(() => {
        listeners.add(force);
        return () => void listeners.delete(force);
    }, []);

    const ghosted = getGhosted();
    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <GhostIcon />
                <Forms.FormTitle tag="h4" style={{ marginLeft: "10px" }}>Xicord Ghost</Forms.FormTitle>
            </ModalHeader>
            <ModalContent>
                <Forms.FormText style={{ marginTop: "10px", opacity: 0.7 }}>
                    Ghosted users' messages, typing and reactions are dropped locally as they arrive.
                    This only affects live events: their older messages still load when you open or
                    scroll a channel, and because the client never sees a dropped message it can leave
                    stale unread badges. Nothing is sent to Discord, so it's undetectable.
                </Forms.FormText>
                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Ghosted Users</Forms.FormTitle>
                    {ghosted.length !== 0 ? ghosted.map(id => {
                        const user = UserStore.getUser(id);
                        return (
                            <Flex key={id} style={{ gap: "10px", flexDirection: "row", alignItems: "center" }}>
                                <img style={{ borderRadius: "50%" }} height={24} width={24} src={user?.getAvatarURL()} aria-hidden="true" />
                                <Forms.FormText style={{ flexGrow: 1 }}>{user?.username ?? id}</Forms.FormText>
                                <Button2 onClick={() => toggleGhost(id)} role="switch" tooltipText="Unghost"
                                    icon={() => <svg width="16" height="16" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" stroke="var(--red-430)" strokeWidth="2" fill="none" /></svg>} />
                            </Flex>
                        );
                    }) : <Forms.FormText>Right-click a user and choose "Ghost User" to add them.</Forms.FormText>}
                </Flex>
                <Flex style={{ marginBottom: "10px", justifyContent: "flex-end" }}>
                    <Button color={Button.Colors.GREEN} onClick={() => props.onClose()}>Close</Button>
                </Flex>
            </ModalContent>
        </ModalRoot>
    );
}

function GhostIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="#b5bac1">
            <path d="M12 2a8 8 0 0 0-8 8v11l3-2 3 2 2-2 2 2 3-2 3 2V10a8 8 0 0 0-8-8Zm-3 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
        </g></svg>
    );
}

function ghostButton() {
    return (
        <Button2 onClick={() => openModal(props => <GhostModal {...props} />)}
            onContextMenu={() => openModal(props => <GhostModal {...props} />)}
            role="switch" tooltipText="Xicord Ghost"
            icon={() => <svg width="18" height="18" viewBox="0 0 24 24"><g fill="currentColor">
                <path d="M12 2a8 8 0 0 0-8 8v11l3-2 3 2 2-2 2 2 3-2 3 2V10a8 8 0 0 0-8-8Zm-3 8a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" />
            </g></svg>} />
    );
}

function MenuItem(id: string) {
    const [, force] = React.useReducer(x => x + 1, 0);
    return (
        <Menu.MenuCheckboxItem
            id="xicord-ghost-user"
            label="Ghost User"
            checked={getGhosted().includes(id)}
            action={() => { toggleGhost(id); force(); }}
        />
    );
}

function makeContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        if (!props?.user?.id) return;
        if (props.user.id === UserStore.getCurrentUser()?.id) return;
        children.splice(-1, 0, <Menu.MenuGroup>{MenuItem(props.user.id)}</Menu.MenuGroup>);
    };
}

let interceptorAdded = false;

export default definePlugin({
    name: "Xicord Ghost",
    description: "Locally suppresses messages, typing indicators and reactions from selected users as they arrive - a stronger, undetectable local mute",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["Xicord Mod Menu"],
    settings,
    xicordButton: ErrorBoundary.wrap(ghostButton, { noop: true }),
    contextMenus: { "user-context": makeContextMenuPatch() },
    start() {
        active = true;
        refresh();
        // Flux keeps one interceptor list for the session; add ours once and let
        // the `active` guard turn it into a no-op when the plugin is disabled
        if (!interceptorAdded) {
            FluxDispatcher.addInterceptor(interceptor);
            interceptorAdded = true;
        }
    },
    stop() {
        active = false;
    },
});
