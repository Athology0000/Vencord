/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Xicord
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { addMemberListDecorator, removeMemberListDecorator } from "@api/MemberListDecorators";
import { addMessageDecoration, removeMessageDecoration } from "@api/MessageDecorations";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import definePlugin, { OptionType } from "@utils/types";
import { RenderModalProps, User } from "@vencord/discord-types";
import { findComponentByCodeLazy } from "@webpack";
import { Menu, Modal, openModal, React, TextArea, Toasts, Tooltip, UserStore } from "@webpack/common";

const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

const settings = definePluginSettings({
    notes: {
        type: OptionType.STRING,
        description: "Serialised note data (edited through the UI, not by hand)",
        default: "{}"
    },
    showInMemberList: {
        type: OptionType.BOOLEAN,
        description: "Show the note icon in the member list",
        default: true,
        restartNeeded: true
    },
    showOnMessages: {
        type: OptionType.BOOLEAN,
        description: "Show the note icon next to messages",
        default: true,
        restartNeeded: true
    }
});

type NoteMap = Record<string, string>;

function readNotes(): NoteMap {
    try {
        const parsed = JSON.parse(settings.store.notes || "{}");
        // Guard against the setting being hand-edited into a non-object
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeNotes(notes: NoteMap) {
    settings.store.notes = JSON.stringify(notes);
}

function getNote(userId: string): string | undefined {
    return readNotes()[userId];
}

function setNote(userId: string, note: string) {
    const notes = readNotes();
    const trimmed = note.trim();

    if (trimmed) notes[userId] = trimmed;
    else delete notes[userId];

    writeNotes(notes);
}

const NoteIcon = ({ size = 16 }: { size?: number; }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
        <path
            fill="currentColor"
            d="M20 2H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h4l3.3 3.3a1 1 0 0 0 1.4 0L16 19h4a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2ZM7 7h10a1 1 0 1 1 0 2H7a1 1 0 0 1 0-2Zm0 4h7a1 1 0 1 1 0 2H7a1 1 0 0 1 0-2Z"
        />
    </svg>
);

function NoteIndicator({ user, small }: { user?: User; small?: boolean; }) {
    if (!user) return null;

    const note = getNote(user.id);
    if (!note) return null;

    return (
        <Tooltip text={note}>
            {tooltipProps => (
                <span
                    {...tooltipProps}
                    style={{ display: "inline-flex", alignItems: "center", marginLeft: 4, color: "var(--text-muted)" }}
                >
                    <NoteIcon size={small ? 14 : 16} />
                </span>
            )}
        </Tooltip>
    );
}

function EditNoteModal({ userId, modalProps }: { userId: string; modalProps: RenderModalProps; }) {
    const user = UserStore.getUser(userId);
    const [value, setValue] = React.useState(getNote(userId) ?? "");

    return (
        <Modal
            {...modalProps}
            title={`Note for ${user?.username ?? userId}`}
            subtitle="Only you can see this. Clearing the text removes the note."
            actions={[
                {
                    text: "Cancel",
                    variant: "secondary",
                    onClick: modalProps.onClose
                },
                {
                    text: "Save",
                    variant: "primary",
                    onClick: () => {
                        setNote(userId, value);
                        Toasts.show({
                            message: value.trim() ? "Note saved" : "Note removed",
                            id: Toasts.genId(),
                            type: Toasts.Type.SUCCESS
                        });
                        modalProps.onClose();
                    }
                }
            ]}
        >
            <TextArea
                value={value}
                onChange={setValue}
                placeholder="Anything you want to remember about this user..."
                autosize
            />
        </Modal>
    );
}

function AllNotesModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [notes, setNotes] = React.useState(readNotes());
    const entries = Object.entries(notes);

    const remove = (userId: string) => {
        setNote(userId, "");
        setNotes(readNotes());
    };

    return (
        <Modal
            {...modalProps}
            title="Xicord Notes"
            subtitle={entries.length ? `${entries.length} note${entries.length === 1 ? "" : "s"}` : undefined}
            actions={[{ text: "Close", variant: "secondary", onClick: modalProps.onClose }]}
        >
            {entries.length === 0
                ? <span>No notes yet. Right click a user and pick "Edit Note".</span>
                : (
                    <Flex flexDirection="column" gap={8}>
                        {entries.map(([userId, note]) => (
                            <Flex key={userId} style={{ alignItems: "center", gap: 8 }}>
                                <img
                                    src={UserStore.getUser(userId)?.getAvatarURL(undefined, 32)}
                                    width={24}
                                    height={24}
                                    style={{ borderRadius: "50%" }}
                                    aria-hidden
                                />
                                <span style={{ minWidth: 120, fontWeight: 600 }}>
                                    {UserStore.getUser(userId)?.username ?? userId}
                                </span>
                                <span style={{ flex: 1, color: "var(--text-muted)" }}>{note}</span>
                                <span
                                    role="button"
                                    style={{ cursor: "pointer", color: "var(--text-danger)" }}
                                    onClick={() => remove(userId)}
                                >
                                    Remove
                                </span>
                            </Flex>
                        ))}
                    </Flex>
                )}
        </Modal>
    );
}

const UserContext: NavContextMenuPatchCallback = (children, { user }: { user?: User; }) => {
    if (!user) return;

    children.push(
        <Menu.MenuGroup>
            <Menu.MenuItem
                id="xicord-edit-note"
                label={getNote(user.id) ? "Edit Note" : "Add Note"}
                action={() => openModal(modalProps => <EditNoteModal userId={user.id} modalProps={modalProps} />)}
            />
        </Menu.MenuGroup>
    );
};

const decorators = {
    showInMemberList: {
        enable: () => addMemberListDecorator("xicord-notes", props => (
            <ErrorBoundary noop>
                <NoteIndicator user={props.user} small />
            </ErrorBoundary>
        )),
        disable: () => removeMemberListDecorator("xicord-notes")
    },
    showOnMessages: {
        enable: () => addMessageDecoration("xicord-notes", props => (
            <ErrorBoundary noop>
                <NoteIndicator user={props.message?.author} />
            </ErrorBoundary>
        )),
        disable: () => removeMessageDecoration("xicord-notes")
    }
} as const;

export default definePlugin({
    name: "Xicord Notes",
    description: "Private per-user notes, with an icon on users you have noted",
    authors: [{ name: "Xicord", id: 1284113557201620995n }],
    dependencies: ["MemberListDecoratorsAPI", "MessageDecorationsAPI"],
    settings,
    contextMenus: { "user-context": UserContext },

    xicordButton: ErrorBoundary.wrap(() => (
        <PanelButton
            role="button"
            tooltipText="Xicord Notes"
            onClick={() => openModal(modalProps => <AllNotesModal modalProps={modalProps} />)}
            icon={() => <NoteIcon size={18} />}
        />
    ), { noop: true }),

    start() {
        for (const [key, decorator] of Object.entries(decorators)) {
            if (settings.store[key]) decorator.enable();
        }
    },

    stop() {
        for (const decorator of Object.values(decorators)) decorator.disable();
    }
});
