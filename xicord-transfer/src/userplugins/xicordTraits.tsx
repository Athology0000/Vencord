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
import { definePluginSettings, Settings } from "@api/Settings";
import definePlugin, { makeRange, OptionType } from "@utils/types";
import { findComponentByCodeLazy } from "@webpack";
import { Button, React, TextInput, Forms, Toasts, Menu, FluxDispatcher, UserStore, GuildStore, GuildMemberStore } from "@webpack/common";
import { Flex } from "@components/Flex";
import { ModalContent as ModalContentRaw, ModalFooter as ModalFooterRaw, ModalHeader as ModalHeaderRaw, ModalSize, ModalRoot as ModalRootRaw, openModal } from "@utils/modal";
import type { RenderModalProps } from "@vencord/discord-types";
import type { ComponentType } from "react";
import ErrorBoundary from "@components/ErrorBoundary";
import { classes } from "@utils/misc";
import { findStoreLazy, } from "@webpack";
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { MutualsSection } from "./xicordMutuals";
import { ensureTargetTrait, hasTarget, isTargetTrait, subscribeTargets, TARGET_TRAIT, toggleTarget, unsubscribeTargets } from "./_targetTrait";

const Button2 = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");

// Vencord exports the legacy modal primitives as `never` to push new code towards the
// current Modal API. They still render, so re-type them rather than rewrite this modal.
const ModalRoot = ModalRootRaw as ComponentType<any>;
const ModalHeader = ModalHeaderRaw as ComponentType<any>;
const ModalContent = ModalContentRaw as ComponentType<any>;
const ModalFooter = ModalFooterRaw as ComponentType<any>;

const VoiceStateStore = findStoreLazy("VoiceStateStore");


const settings = definePluginSettings({
    tasks: {
        description: "Task data",
        type: OptionType.STRING,
        default: "",
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
    name: "Xicord Traits",
    description: "Add different traits to users",
    authors: [{ name: "Xicord", id: 1284113557201620995n, }],
    settings,
    // Convention: Xicord Mod Menu renders `xicordButton` from every enabled Xicord plugin
    xicordButton: ErrorBoundary.wrap(traitIcon, { noop: true }),
    contextMenus: { "user-context": makeContextMenuPatch(), },
    start() {
        // The reserved trait always exists so there is a row to drop targets into
        ensureTargetTrait();
        FluxDispatcher.subscribe("VOICE_STATE_UPDATES", cb);
    },
    dependencies: ["Xicord Mod Menu"],
    // Button is rendered by Xicord Mod Menu's single panel patch
});

interface trait {
    name: string;
    url: string;
    users: string;
}

function traitIcon() {
    return (
        <>
            <Button2
                onContextMenu={() => openModal(props => <EncModals {...props} />)}
                onClick={() => openModal(props => <EncModals {...props} />)}
                role="switch"
                tooltipText={"Xicord Traits"}

                icon={() =>
                    <svg width="18" height="18" viewBox="0 0 24 24">
                        <g fill={"currentColor"}>
                            <path
                                d="m8,22.5c0,.829-.672,1.5-1.5,1.5h-1c-3.032,0-5.5-2.467-5.5-5.5v-1c0-.829.672-1.5,1.5-1.5s1.5.671,1.5,1.5v1c0,1.378,1.121,2.5,2.5,2.5h1c.828,0,1.5.671,1.5,1.5Zm14.5-6.5c-.828,0-1.5.671-1.5,1.5v1c0,1.378-1.121,2.5-2.5,2.5h-1c-.828,0-1.5.671-1.5,1.5s.672,1.5,1.5,1.5h1c3.032,0,5.5-2.467,5.5-5.5v-1c0-.829-.672-1.5-1.5-1.5ZM18.5,0h-1c-.828,0-1.5.671-1.5,1.5s.672,1.5,1.5,1.5h1c1.379,0,2.5,1.122,2.5,2.5v1c0,.829.672,1.5,1.5,1.5s1.5-.671,1.5-1.5v-1c0-3.033-2.468-5.5-5.5-5.5ZM1.5,8c.828,0,1.5-.671,1.5-1.5v-1c0-1.378,1.121-2.5,2.5-2.5h1c.828,0,1.5-.671,1.5-1.5s-.672-1.5-1.5-1.5h-1C2.468,0,0,2.467,0,5.5v1c0,.829.672,1.5,1.5,1.5Zm10.5,11c-3.866,0-7-3.134-7-7s3.134-7,7-7,7,3.134,7,7-3.134,7-7,7Zm-2.5-7c.828,0,1.5-.672,1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5,1.5.672,1.5,1.5,1.5Zm5.448,1.921c-.274-.412-.804-.556-1.255-.351-.469.213-1.094.43-1.693.43-.578,0-1.211-.213-1.703-.435-.449-.202-.974-.054-1.246.356h0c-.342.515-.145,1.212.417,1.467.665.302,1.58.612,2.533.612s1.867-.31,2.532-.612c.562-.255.758-.953.416-1.467Zm1.052-3.421c0-.828-.672-1.5-1.5-1.5s-1.5.672-1.5,1.5.672,1.5,1.5,1.5,1.5-.672,1.5-1.5Z" />
                        </g>
                    </svg>
                }
            />
        </>
    );
}

function EncModals(props: RenderModalProps) {
    const [traits, setTraits] = React.useState(isValidJson(settings.store.tasks) as trait[]);
    const [newTrait, setNewTrait] = React.useState("");
    const [newAudio, setNewAudio] = React.useState("");

    // Xicord Mutuals rewrites this same JSON from its background scanner, and
    // Orbit/Cache write it too. Without this, editing anything here would
    // serialise a mount-time snapshot over their changes and silently drop
    // people from the Target trait (i.e. stop watching them).
    React.useEffect(() => {
        const onChange = () => setTraits(isValidJson(settings.store.tasks) as trait[]);
        subscribeTargets(onChange);
        return () => unsubscribeTargets(onChange);
    }, []);

    /** Read-modify-write against live settings, never against the render snapshot. */
    const mutate = (fn: (list: trait[]) => trait[] | void) => {
        const live = isValidJson(settings.store.tasks) as trait[];
        settings.store.tasks = JSON.stringify(fn(live) ?? live);
        setTraits(isValidJson(settings.store.tasks) as trait[]);
    };

    const nameTaken = (name: string) =>
        traits.some(t => typeof t?.name === "string"
            && t.name.trim().toLowerCase() === name.trim().toLowerCase());

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <svg width="20" height="20" viewBox="0 0 24 24" style={{ marginRight: "10px" }}>
                    <g fill={"#b5bac1"}>
                        <path d="m8,22.5c0,.829-.672,1.5-1.5,1.5h-1c-3.032,0-5.5-2.467-5.5-5.5v-1c0-.829.672-1.5,1.5-1.5s1.5.671,1.5,1.5v1c0,1.378,1.121,2.5,2.5,2.5h1c.828,0,1.5.671,1.5,1.5Zm14.5-6.5c-.828,0-1.5.671-1.5,1.5v1c0,1.378-1.121,2.5-2.5,2.5h-1c-.828,0-1.5.671-1.5,1.5s.672,1.5,1.5,1.5h1c3.032,0,5.5-2.467,5.5-5.5v-1c0-.829-.672-1.5-1.5-1.5ZM18.5,0h-1c-.828,0-1.5.671-1.5,1.5s.672,1.5,1.5,1.5h1c1.379,0,2.5,1.122,2.5,2.5v1c0,.829.672,1.5,1.5,1.5s1.5-.671,1.5-1.5v-1c0-3.033-2.468-5.5-5.5-5.5ZM1.5,8c.828,0,1.5-.671,1.5-1.5v-1c0-1.378,1.121-2.5,2.5-2.5h1c.828,0,1.5-.671,1.5-1.5s-.672-1.5-1.5-1.5h-1C2.468,0,0,2.467,0,5.5v1c0,.829.672,1.5,1.5,1.5Zm10.5,11c-3.866,0-7-3.134-7-7s3.134-7,7-7,7,3.134,7,7-3.134,7-7,7Zm-2.5-7c.828,0,1.5-.672,1.5-1.5s-.672-1.5-1.5-1.5-1.5.672-1.5,1.5.672,1.5,1.5,1.5Zm5.448,1.921c-.274-.412-.804-.556-1.255-.351-.469.213-1.094.43-1.693.43-.578,0-1.211-.213-1.703-.435-.449-.202-.974-.054-1.246.356h0c-.342.515-.145,1.212.417,1.467.665.302,1.58.612,2.533.612s1.867-.31,2.532-.612c.562-.255.758-.953.416-1.467Zm1.052-3.421c0-.828-.672-1.5-1.5-1.5s-1.5.672-1.5,1.5.672,1.5,1.5,1.5,1.5-.672,1.5-1.5Z" />
                    </g>
                </svg>
                <Forms.FormTitle tag="h4">Xicord Traits</Forms.FormTitle>
            </ModalHeader>

            <ModalContent>


                <Flex style={{ gap: "20px", marginTop: "10px", flexDirection: "row", flex: "none", alignItems: "center" }}>

                    <Flex flexDirection="row" style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "space-around", }}>
                        <Flex style={{ justifyContent: "space-around", flexDirection: "column", width: "30%" }}>
                            <Flex style={{ justifyContent: "flex-start", flexDirection: "column", gap: "5px", marginLeft: "0px" }}>
                                <TextInput
                                    value={newTrait}
                                    placeholder="Add a new Trait"
                                    draggable={true}
                                    maxLength={40}
                                    onChange={(e: string) => setNewTrait(e)}
                                />
                            </Flex>
                        </Flex>
                        <Flex style={{ justifyContent: "space-around", flexDirection: "column", width: "70%" }}>
                            <Flex style={{ justifyContent: "flex-start", flexDirection: "column", gap: "5px", marginLeft: "0px" }}>
                                <TextInput

                                    value={newAudio}
                                    placeholder="Audio Clip URL"
                                    draggable={true}
                                    onChange={(e: string) => setNewAudio(e)
                                    }
                                />
                            </Flex>
                        </Flex>

                    </Flex>


                    <Button2
                        onClick={() => {
                            const name = newTrait.trim();
                            if (name === "") return;
                            // A second trait matching "Target" would diverge from the one the
                            // watchers read, and duplicate names break rename/delete (both
                            // match by name). Reject rather than create an unfixable row.
                            if (nameTaken(name)) {
                                Toasts.show({
                                    message: `A trait named "${name}" already exists`,
                                    id: "xicord-trait-duplicate",
                                    type: Toasts.Type.FAILURE,
                                    options: { position: Toasts.Position.BOTTOM }
                                });
                                return;
                            }
                            mutate(list => { list.push({ name, url: newAudio, users: "" }); });
                            setNewTrait("");
                            setNewAudio("");
                        }}
                        role="switch"
                        tooltipText={"Add Trait"}
                        icon={() =>
                            <svg width="18" height="18" viewBox="0 0 24 24">
                                <g fill={"#b5bac1"}>
                                    <path
                                        d="M17,12c0,.553-.448,1-1,1h-3v3c0,.553-.448,1-1,1s-1-.447-1-1v-3h-3c-.552,0-1-.447-1-1s.448-1,1-1h3v-3c0-.553,.448-1,1-1s1,.447,1,1v3h3c.552,0,1,.447,1,1Zm7-7v14c0,2.757-2.243,5-5,5H5c-2.757,0-5-2.243-5-5V5C0,2.243,2.243,0,5,0h14c2.757,0,5,2.243,5,5Zm-2,0c0-1.654-1.346-3-3-3H5c-1.654,0-3,1.346-3,3v14c0,1.654,1.346,3,3,3h14c1.654,0,3-1.346,3-3V5Z" />
                                </g>
                            </svg>
                        }
                    />
                </Flex>

                <Flex className={classes("qualitySettingsContainer__8f353")} style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "space-around", flexDirection: "column" }}>
                    <Forms.FormTitle tag="h5" style={{ marginTop: "5px" }}>Current Traits</Forms.FormTitle>
                    <Forms.FormText style={{ opacity: 0.6, fontSize: 12, marginBottom: "4px" }}>
                        Anyone given the "{TARGET_TRAIT}" trait is watched by every Xicord watcher
                        (Orbit, Profile, Live, Post, Server, Game) and recorded by Dossier. That row is
                        locked so watching can't be broken by renaming or deleting it.
                    </Forms.FormText>
                    {/* Keyed and edited by position, not by name: a name-based key remounts
                        the row on every keystroke (losing focus), and a name-based lookup
                        misses once two edits land before a re-render, silently dropping
                        characters. Position also makes deleting one of two same-named
                        traits remove exactly one. */}
                    {traits.length !== 0 ? (traits.map((task, i) => (
                        <Flex key={i} style={{ gap: "20px", flexDirection: "row", flex: "none", alignItems: "center", marginLeft: "0px", marginRight: "0px", }}>
                            <Flex flexDirection="row" style={{ marginTop: "10px", marginBottom: "10px", justifyContent: "space-around", }}>
                                <Flex style={{ justifyContent: "space-around", flexDirection: "column", width: "30%" }}>
                                    <Flex style={{ justifyContent: "flex-start", flexDirection: "column", gap: "5px", marginLeft: "0px" }}>
                                        <TextInput
                                            value={task.name ?? ""}
                                            placeholder="Trait Name"
                                            maxLength={40}
                                            disabled={isTargetTrait(task.name)}
                                            onChange={(e: string) => {
                                                if (isTargetTrait(task.name)) return;
                                                // Renaming onto "Target" would hijack watching
                                                if (isTargetTrait(e)) return;
                                                mutate(list => { if (list[i]) list[i].name = e; });
                                            }}
                                        />
                                    </Flex>
                                </Flex>
                                <Flex style={{ justifyContent: "space-around", flexDirection: "column", width: "70%" }}>
                                    <Flex style={{ justifyContent: "flex-start", flexDirection: "column", gap: "5px", marginLeft: "0px" }}>
                                        <TextInput
                                            value={task.url ?? ""}
                                            placeholder="Trait Audio URL"
                                            onChange={(e: string) => mutate(list => { if (list[i]) list[i].url = e; })}
                                        />
                                    </Flex>
                                </Flex>
                            </Flex>

                            {isTargetTrait(task.name) ? (
                                <div
                                    title="Watched by all Xicord watchers — this trait can't be renamed or removed"
                                    style={{ display: "flex", alignItems: "center", padding: "0 5px" }}
                                >
                                    <svg width="18" height="18" viewBox="0 0 24 24">
                                        <g fill="var(--text-muted)">
                                            <path d="M12 5C7 5 3 9.5 3 12s4 7 9 7 9-4.5 9-7-4-7-9-7Zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8Zm0-6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z" />
                                        </g>
                                    </svg>
                                </div>
                            ) : (
                                <Button2
                                    onClick={() => mutate(list => list.filter((_, idx) => idx !== i))}
                                    role="switch"
                                    tooltipText={"Remove Trait"}
                                    icon={() =>
                                        <svg
                                            role="img"
                                            width={"18"}
                                            height={"18"}
                                            viewBox={"0 0 24 24"}
                                            style={{ scale: "1" }}
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
                                    }
                                />
                            )}

                        </Flex>
                    ))) : (null)}
                </Flex>

                {Settings.plugins["Xicord Mutuals"]?.enabled ? (
                    <ErrorBoundary noop>
                        <MutualsSection />
                    </ErrorBoundary>
                ) : (null)}

            </ModalContent>

            <ModalFooter>
                <Button
                    color={Button.Colors.GREEN}
                    disabled={false}
                    onClick={() => {
                        props.onClose();

                    }}
                >
                    Close
                </Button>
                <Button
                    color={Button.Colors.TRANSPARENT}
                    look={Button.Looks.LINK}
                    style={{ left: 15, position: "absolute" }}
                    onClick={() => props.onClose()}
                >
                    Cancel
                </Button>
            </ModalFooter>
        </ModalRoot >

    );
}

function isValidJson(data: string): boolean | [] {
    try { return JSON.parse(data); }
    catch (e) { return []; }
}

const cb = async (e: any) => {
    // VOICE_STATE_UPDATES can arrive with an empty batch; indexing it blindly threw
    // a TypeError on every such dispatch.
    const state = e.voiceStates?.[0];
    if (!state?.channelId) return;
    if (state.userId == UserStore.getCurrentUser().id || !state.userId) return;
    if (state?.channelId == state?.oldChannelId) return;

    const channelVoiceStates = VoiceStateStore.getVoiceStatesForChannel(state?.channelId) ?? {};
    if (!Object.keys(channelVoiceStates).includes(UserStore.getCurrentUser().id)) return;
    const data = (isValidJson(settings.store.tasks) as trait[]).find(trait =>
        typeof trait?.users === "string" && trait.users.split("/").includes(state.userId));

    if (!data) return;
    audio(data.url);
    Toasts.show({
        message: `${data.name} ALERT`,
        id: "Vc-ALERT",
        type: Toasts.Type.FAILURE,
        options: {
            position: Toasts.Position.BOTTOM,
        }
    });

};

function MenuItem(id: string) {
    // Checked state is derived live rather than snapshotted, so Orbit's "Watch
    // User" item in this same menu and this "Target" checkbox can't disagree.
    const [, force] = React.useReducer(x => x + 1, 0);
    const data = (isValidJson(settings.store.tasks) as trait[]);

    const checkedFor = (t: trait) =>
        isTargetTrait(t.name) ? hasTarget(id)
            : typeof t.users === "string" && t.users.split("/").includes(id);

    return (
        <Menu.MenuItem id="Traits" label="Traits">
            {data.length !== 0 ? data.map((trait, i) => (
                <Menu.MenuCheckboxItem
                    key={i}
                    id={`xicord-trait-${i}`}
                    label={trait.name}
                    checked={checkedFor(trait)}
                    action={() => {
                        // Route the reserved trait through the shared helper so this
                        // always writes the same entry the watchers read
                        if (isTargetTrait(trait.name)) { toggleTarget(id); force(); return; }

                        const live = (isValidJson(settings.store.tasks) as trait[]);
                        const entry = live[i];
                        if (!entry || typeof entry.users !== "string") return;

                        // Split-based: snowflakes can be prefixes of one another, so a
                        // substring replace could corrupt neighbours
                        const ids = entry.users.split("/").filter(Boolean);
                        entry.users = (ids.includes(id) ? ids.filter(u => u !== id) : [...ids, id])
                            .map(u => `/${u}`).join("");

                        settings.store.tasks = JSON.stringify(live);
                        force();
                    }}
                />
            )) : <Menu.MenuItem
                id="Empty List"
                label="Empty"
                disabled={true}
            />}
        </Menu.MenuItem>
    );
}
function makeContextMenuPatch(): NavContextMenuPatchCallback {
    return (children, props) => {
        if (!props?.user?.id) return;
        // Checked before MenuItem is called, so its hooks aren't conditional
        if (props.user.id === UserStore.getCurrentUser()?.id) return;
        const traits = MenuItem(props.user.id);
        if (!traits) return;
        children.splice(-1, 0, <Menu.MenuGroup>{traits}</Menu.MenuGroup>);
    };
}
function audio(url) {
    // Traits may have no clip (the auto-created "Target" trait starts empty);
    // an empty src makes play() reject
    if (!url) return;
    const audioElement = document.createElement("audio");
    audioElement.src = url;
    audioElement.volume = settings.store.audioVolume / 100;
    audioElement.play().catch(() => { });
}
